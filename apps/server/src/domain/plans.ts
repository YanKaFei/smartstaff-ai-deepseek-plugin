import type { Db } from '../db/index.js';
import { all, get, parseJson, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError, conflict } from '../lib/errors.js';
import { storeNow } from './clock.js';
import { createException, notifyStoreManagers, audit } from './notify.js';
import { getForecastRow, serializeForecast } from './forecast.js';
import { candidateEligibility, runMatching, travelMinutes, type MatchRange } from './matching.js';
import { createOfferForShift, createDemand, reconcileDemand, newCandidateId, staffAvailableForShift } from './dispatch.js';
import { assertDispatchAllowed, recordShadowRun } from './pilot.js';
import { getStaff, staffWindows } from './staff.js';
import { getStore, parseConfig } from './stores.js';
import { parseJson as parseJsonValue } from '../lib/db.js';
import { formatDateTime, MINUTE_MS, round2 } from '../lib/time.js';
import type {
  ForecastResult,
  MatchCandidate,
  PlanAlternative,
  PlanDraft,
  PlanItem,
  PlanType,
  StaffProfileRow,
} from './types.js';

export interface PlanRow {
  id: string;
  store_id: string;
  forecast_id: string;
  plan_type: PlanType;
  status: 'proposed' | 'confirmed' | 'superseded';
  items_json: string;
  total_cost: number;
  headcount: number;
  shortage_json: string;
  shadow: number;
  created_at: number;
  confirmed_at: number | null;
}

export function loadMatchCandidates(db: Db, storeId: string, now: number): MatchCandidate[] {
  const profiles = all<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE store_id = ?', [storeId]);
  if (!profiles.length) return [];
  const placeholders = profiles.map(() => '?').join(',');
  const windows = all<{ staff_id: string; weekday: number; start_min: number; end_min: number }>(
    db,
    `SELECT staff_id, weekday, start_min, end_min FROM staff_availability WHERE staff_id IN (${placeholders})`,
    profiles.map((p) => p.id),
  );
  const windowsByStaff = new Map<string, Array<{ weekday: number; startMin: number; endMin: number }>>();
  for (const w of windows) {
    const list = windowsByStaff.get(w.staff_id) ?? [];
    list.push({ weekday: w.weekday, startMin: w.start_min, endMin: w.end_min });
    windowsByStaff.set(w.staff_id, list);
  }
  const shifts = all<{ staff_id: string; start_at: number; end_at: number; status: string; role: string }>(
    db,
    `SELECT staff_id, start_at, end_at, status, role FROM shifts
      WHERE staff_id IN (${placeholders}) AND status IN ('invited','confirmed','checked_in')`,
    profiles.map((p) => p.id),
  );
  const commitmentsByStaff = new Map<string, Array<{ startAt: number; endAt: number; label: string }>>();
  for (const s of shifts) {
    const list = commitmentsByStaff.get(s.staff_id) ?? [];
    list.push({ startAt: s.start_at, endAt: s.end_at, label: `${s.role}/${s.status}` });
    commitmentsByStaff.set(s.staff_id, list);
  }
  return profiles.map((p) => ({
    staffId: p.id,
    nickname: p.nickname,
    distanceKm: p.distance_km,
    expectedRate: p.expected_rate,
    experienceYears: p.experience_years,
    onTimeRate: p.on_time_rate,
    skills: parseJson<string[]>(p.skills_json, []),
    qualified: Boolean(p.qualified),
    status: p.status,
    windows: windowsByStaff.get(p.id) ?? [],
    commitments: commitmentsByStaff.get(p.id) ?? [],
    shiftsCompleted: p.shifts_completed,
    noShowCount: p.no_show_count,
  }));
}

export function serializePlan(db: Db, row: PlanRow) {
  const items = parseJson<PlanItem[]>(row.items_json, []);
  const shortage = parseJson<PlanDraft['shortage']>(row.shortage_json, []);
  const store = getStore(db, row.store_id);
  return {
    id: row.id,
    storeId: row.store_id,
    forecastId: row.forecast_id,
    planType: row.plan_type,
    status: row.status,
    shadow: Boolean(row.shadow),
    items: items.map((item) => ({
      ...item,
      startLabel: new Date(item.startAt + 8 * 3_600_000).toISOString().slice(11, 16),
      endLabel: new Date(item.endAt + 8 * 3_600_000).toISOString().slice(11, 16),
      arriveLabel: new Date(item.arriveAt + 8 * 3_600_000).toISOString().slice(11, 16),
    })),
    totalCost: row.total_cost,
    headcount: row.headcount,
    shortage,
    storeName: store.name,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function summaryOf(row: ReturnType<typeof getForecastRow>): ForecastResult {
  return parseJson<ForecastResult>(row.summary_json, {
    horizonStart: row.horizon_start,
    slots: [],
    peakRequiredStaff: row.required_staff,
    peakGap: row.gap,
    gapRanges: [],
    reliability: 'low',
    reliabilityReason: '',
    bottleneck: 'none',
    bottleneckReason: '',
    dataPoints: 0,
    arrivalAssumption: 0,
    generatedAt: row.generated_at,
  });
}

function gapRangesFor(summary: ForecastResult): MatchRange[] {
  return summary.gapRanges
    .filter((r) => r.headcount > 0)
    .map((r) => ({ startAt: r.startAt, endAt: r.endAt, headcount: r.headcount }));
}

export function generatePlans(
  db: Db,
  storeId: string,
  forecastId: string | undefined,
  now?: number,
) {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const effectiveNow = now ?? storeNow(db, storeId);
  const forecastRow = getForecastRow(db, storeId, forecastId);
  const summary = summaryOf(forecastRow);
  const ranges = gapRangesFor(summary);

  if (!ranges.length) {
    return {
      forecast: serializeForecast(forecastRow),
      needsStaff: false,
      ranges: [],
      plans: [],
      message:
        summary.peakGap === 0
          ? '当前人力可覆盖预测客流，无需增派。'
          : '缺口主要来自桌位与翻台限制，建议先加快清台，不机械加人。',
    };
  }

  const candidates = loadMatchCandidates(db, storeId, effectiveNow);
  const drafts: PlanDraft[] = [];
  for (const planType of ['economic', 'guarantee'] as PlanType[]) {
    const result = runMatching({ now: effectiveNow, config, ranges, candidates, planType });
    drafts.push(result.draft);
  }

  // Make the two plans genuinely different when the pool allows it.
  dedupeGuarantee(drafts, candidates, ranges, config, effectiveNow);

  const created: PlanRow[] = [];
  transaction(db, () => {
    run(db, "UPDATE assignment_plans SET status = 'superseded' WHERE store_id = ? AND status = 'proposed'", [storeId]);
    for (const draft of drafts) {
      const planId = id('plan');
      run(
        db,
        `INSERT INTO assignment_plans(id, store_id, forecast_id, plan_type, status, items_json, total_cost, headcount, shortage_json, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          planId,
          storeId,
          forecastRow.id,
          draft.planType,
          'proposed',
          JSON.stringify(draft.items),
          draft.totalCost,
          draft.headcount,
          JSON.stringify(draft.shortage),
          effectiveNow,
        ],
      );
      audit(db, {
        storeId,
        action: 'plan.generate',
        entity: 'plan',
        entityId: planId,
        detail: { planType: draft.planType, headcount: draft.headcount, cost: draft.totalCost },
        at: effectiveNow,
      });
      created.push(get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ?', [planId])!);
    }
  });

  return {
    forecast: serializeForecast(forecastRow),
    needsStaff: true,
    ranges: ranges.map((r) => ({ ...r, label: `${formatDateTime(r.startAt)}-${formatDateTime(r.endAt)}` })),
    plans: created.map((row) => serializePlan(db, row)),
    message:
      drafts.every((d) => d.items.length === 0)
        ? '当前没有符合硬性条件的兼职人员，请管理员补充人员库或人工处理。'
        : drafts.some((d) => d.shortage.length > 0)
          ? '部分时段候选不足，方案已显示缺口，未虚构可接单人员。'
          : '已生成经济方案与保障方案。',
  };
}

function dedupeGuarantee(
  drafts: PlanDraft[],
  candidates: MatchCandidate[],
  ranges: MatchRange[],
  config: ReturnType<typeof parseConfig>,
  now: number,
): void {
  const economic = drafts[0];
  const guarantee = drafts[1];
  if (!economic || !guarantee) return;
  const key = (d: PlanDraft) => d.items.map((i) => `${i.staffId}:${i.startAt}`).sort().join('|');
  if (key(economic) !== key(guarantee)) return;
  // Identical picks: swap one guarantee item for its next eligible alternative.
  for (let idx = 0; idx < guarantee.items.length; idx += 1) {
    const item = guarantee.items[idx];
    const used = new Set(guarantee.items.map((i) => i.staffId));
    for (const alt of item.alternatives ?? []) {
      if (used.has(alt.staffId)) continue;
      const candidate = candidates.find((c) => c.staffId === alt.staffId);
      if (!candidate) continue;
      const check = candidateEligibility(candidate, { startAt: item.startAt, endAt: item.endAt, headcount: 1 }, config, now);
      if (!check.ok) continue;
      const t = travelMinutes(candidate.distanceKm, config);
      const hours = Math.max(0.5, (item.endAt - item.startAt) / 3_600_000);
      guarantee.items[idx] = {
        ...item,
        staffId: candidate.staffId,
        nickname: candidate.nickname,
        hourlyRate: candidate.expectedRate,
        estimatedCost: round2(hours * candidate.expectedRate),
        distanceKm: candidate.distanceKm,
        arriveAt: item.startAt - t * MINUTE_MS,
        reason: `${alt.reason}；保障方案优先使用该候选以提升高峰服务能力`,
      };
      guarantee.totalCost = round2(guarantee.items.reduce((sum, i) => sum + i.estimatedCost, 0));
      guarantee.headcount = new Set(guarantee.items.map((i) => i.staffId)).size;
      return;
    }
  }
}

export function confirmPlan(
  db: Db,
  storeId: string,
  planId: string,
  actorId: string,
  now?: number,
) {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const effectiveNow = now ?? storeNow(db, storeId);
  const plan = get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ? AND store_id = ?', [planId, storeId]);
  if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', '调配方案不存在');
  if (plan.status !== 'proposed') throw conflict('该方案已确认或已过期，请重新生成');
  assertDispatchAllowed(db, storeId);
  const items = parseJson<PlanItem[]>(plan.items_json, []);
  if (!items.length) throw conflict('方案没有可执行的候选人员，请先补充人员库或人工处理');

  if (config.pilot.shadowMode) {
    const recommendations = items.map((item) => ({
      staffId: item.staffId,
      nickname: item.nickname,
      startAt: item.startAt,
      endAt: item.endAt,
      hourlyRate: item.hourlyRate,
      estimatedCost: item.estimatedCost,
    }));
    let shadowRunId = '';
    transaction(db, () => {
      run(db, "UPDATE assignment_plans SET status = 'confirmed', shadow = 1, confirmed_at = ? WHERE id = ?", [effectiveNow, plan.id]);
      run(
        db,
        "UPDATE assignment_plans SET status = 'superseded' WHERE store_id = ? AND id != ? AND status = 'proposed'",
        [storeId, plan.id],
      );
      shadowRunId = recordShadowRun(db, {
        storeId,
        planId: plan.id,
        forecastId: plan.forecast_id,
        recommendations,
        totalCost: plan.total_cost,
        note: 'Shadow mode: prediction and matching only; no offers, shifts or fees.',
        actorId,
      });
      audit(db, {
        storeId,
        actorId,
        actorRole: 'manager',
        action: 'plan.shadow_confirm',
        entity: 'plan',
        entityId: plan.id,
        detail: { shadowRunId, recommendations: recommendations.length, totalCost: plan.total_cost },
        at: effectiveNow,
      });
    });
    const refreshedShadow = get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ?', [plan.id])!;
    return {
      plan: serializePlan(db, refreshedShadow),
      offersCreated: 0,
      shifts: [],
      failed: [],
      shadow: true,
      shadowRunId,
      simulatedRecommendations: recommendations,
      message: '影子模式：已记录推荐方案，未发送任何邀约或产生费用。',
      storeCode: getStore(db, storeId).manager_code,
    };
  }

  const created: Array<{ shiftId: string; offerId: string; staffId: string }> = [];
  const failed: Array<{ staffId: string; reason: string }> = [];
  const demandGroups = new Map<string, { startAt: number; endAt: number; hourlyRate: number; items: PlanItem[] }>();
  for (const item of items) {
    const key = `${item.startAt}:${item.endAt}:${store.job_type}`;
    const group = demandGroups.get(key) ?? { startAt: item.startAt, endAt: item.endAt, hourlyRate: item.hourlyRate, items: [] };
    group.items.push(item);
    group.hourlyRate = Math.max(group.hourlyRate, item.hourlyRate);
    demandGroups.set(key, group);
  }

  transaction(db, () => {
    const demandIds = new Map<string, string>();
    for (const [key, group] of demandGroups) {
      const demand = createDemand(db, {
        storeId,
        planId: plan.id,
        role: store.job_type,
        startAt: group.startAt,
        endAt: group.endAt,
        headcount: group.items.length,
        hourlyRate: group.hourlyRate,
      });
      demandIds.set(key, demand.id);
    }
    run(db, "UPDATE assignment_plans SET status = 'confirmed', confirmed_at = ? WHERE id = ?", [effectiveNow, plan.id]);
    run(
      db,
      "UPDATE assignment_plans SET status = 'superseded' WHERE store_id = ? AND id != ? AND status = 'proposed'",
      [storeId, plan.id],
    );
    for (const item of items) {
      const attempted = new Set<string>();
      const candidates = [item.staffId, ...(item.alternatives ?? []).map((a: PlanAlternative) => a.staffId)];
      let offered = false;
      for (const staffId of candidates) {
        if (attempted.has(staffId)) continue;
        attempted.add(staffId);
        const staff = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE id = ?', [staffId]);
        if (!staff || staff.store_id !== storeId) continue;
        const check = staffAvailableForShift(db, staff, item.startAt, item.endAt, effectiveNow, config);
        if (!check.ok) continue;
        try {
          const result = createOfferForShift(db, {
            storeId,
            staffId,
            startAt: item.startAt,
            endAt: item.endAt,
            hourlyRate: item.hourlyRate,
            role: store.job_type,
            planId: plan.id,
            demandId: demandIds.get(`${item.startAt}:${item.endAt}:${store.job_type}`) ?? null,
            candidateIds: candidates,
            now: effectiveNow,
          });
          created.push({ ...result, staffId });
          offered = true;
          break;
        } catch {
          // try the next candidate
        }
      }
      if (!offered) {
        failed.push({ staffId: item.staffId, reason: '推荐人员时段冲突或状态变化' });
      }
    }

    for (const demandId of demandIds.values()) reconcileDemand(db, demandId);
    if (failed.length) {
      const late = items.length - created.length;
      createException(db, {
        storeId,
        type: 'partial_dispatch',
        severity: 'warning',
        message: `${late} 个推荐班次在确认时已不可执行，系统已保留其余邀约，请人工补位`,
        payload: { failed },
        at: effectiveNow,
      });
      notifyStoreManagers(db, storeId, {
        type: 'exception',
        title: '部分调配未能发出邀约',
        body: `${late} 个推荐班次因人员状态变化未能发出，请查看异常列表。`,
        related: { planId: plan.id },
        at: effectiveNow,
      });
    }
    audit(db, {
      storeId,
      actorId,
      actorRole: 'manager',
      action: 'plan.confirm',
      entity: 'plan',
      entityId: plan.id,
      detail: { planType: plan.plan_type, offers: created.length, failed: failed.length, shadow: false },
      at: effectiveNow,
    });
  });

  const refreshed = get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ?', [plan.id])!;
  const storeRow = getStore(db, storeId);
  return {
    plan: serializePlan(db, refreshed),
    offersCreated: created.length,
    shifts: created,
    failed,
    message:
      created.length > 0
        ? `已向 ${created.length} 位兼职发出工作邀约，等待确认。`
        : '没有成功发出邀约，请检查人员可用时间或人工处理。',
    storeCode: storeRow.manager_code,
  };
}

export function replacePlanItem(
  db: Db,
  storeId: string,
  planId: string,
  input: { staffId: string; startAt: number; replacementStaffId: string },
) {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const now = storeNow(db, storeId);
  const plan = get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ? AND store_id = ?', [planId, storeId]);
  if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', '调配方案不存在');
  if (plan.status !== 'proposed') throw conflict('只有待确认方案可以替换候选');
  const items = parseJson<PlanItem[]>(plan.items_json, []);
  const index = items.findIndex((i) => i.staffId === input.staffId && i.startAt === input.startAt);
  if (index < 0) throw new AppError(404, 'ITEM_NOT_FOUND', '未找到该推荐班次');
  const item = items[index];
  const replacement = loadMatchCandidates(db, storeId, now).find((c) => c.staffId === input.replacementStaffId);
  if (!replacement) throw new AppError(404, 'STAFF_NOT_FOUND', '替换人员不存在');
  const check = candidateEligibility(
    replacement,
    { startAt: item.startAt, endAt: item.endAt, headcount: 1 },
    config,
    now,
  );
  if (!check.ok) throw conflict(`该人员不可替换：${check.reason}`);
  if (items.some((i, idx) => idx !== index && i.staffId === replacement.staffId && i.startAt < item.endAt && i.endAt > item.startAt)) {
    throw conflict('替换人员已在该时段的其他推荐班次中');
  }
  const hours = Math.max(0.5, (item.endAt - item.startAt) / 3_600_000);
  const alternatives: PlanAlternative[] = (item.alternatives ?? []).filter((a) => a.staffId !== replacement.staffId);
  const oldStaff = getStaff(db, item.staffId);
  alternatives.push({
    staffId: oldStaff.id,
    nickname: oldStaff.nickname,
    hourlyRate: oldStaff.expected_rate,
    distanceKm: oldStaff.distance_km,
    onTimeRate: oldStaff.on_time_rate,
    experienceYears: oldStaff.experience_years,
    score: 0,
    reason: '原推荐人员',
  });
  items[index] = {
    ...item,
    staffId: replacement.staffId,
    nickname: replacement.nickname,
    hourlyRate: replacement.expectedRate,
    estimatedCost: round2(hours * replacement.expectedRate),
    distanceKm: replacement.distanceKm,
    arriveAt: item.startAt - travelMinutes(replacement.distanceKm, config) * MINUTE_MS,
    score: 100,
    reason: `店长手动替换：${replacement.nickname} 可用时间覆盖且无班次冲突`,
    alternatives,
  };
  const totalCost = round2(items.reduce((sum, i) => sum + i.estimatedCost, 0));
  run(db, 'UPDATE assignment_plans SET items_json = ?, total_cost = ?, headcount = ? WHERE id = ?', [
    JSON.stringify(items),
    totalCost,
    new Set(items.map((i) => i.staffId)).size,
    plan.id,
  ]);
  audit(db, {
    storeId,
    action: 'plan.replace_candidate',
    entity: 'plan',
    entityId: plan.id,
    detail: { from: item.staffId, to: replacement.staffId },
    at: now,
  });
  return serializePlan(db, get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ?', [plan.id])!);
}

export function listPlans(db: Db, storeId: string, limit = 20) {
  const rows = all<PlanRow>(
    db,
    'SELECT * FROM assignment_plans WHERE store_id = ? ORDER BY created_at DESC LIMIT ?',
    [storeId, limit],
  );
  return rows.map((row) => serializePlan(db, row));
}

export function getPlan(db: Db, storeId: string, planId: string) {
  const row = get<PlanRow>(db, 'SELECT * FROM assignment_plans WHERE id = ? AND store_id = ?', [planId, storeId]);
  if (!row) throw new AppError(404, 'PLAN_NOT_FOUND', '调配方案不存在');
  return serializePlan(db, row);
}

void parseJsonValue;
void staffWindows;
void newCandidateId;
