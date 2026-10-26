import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { getStore, parseConfig } from './stores.js';
import { computeCapacityForecast } from './capacity.js';
import { getImport, listObservations } from './dataImport.js';
import { MINUTE_MS, formatDateTime } from '../lib/time.js';
import type { StoreConfig, TableType } from './types.js';

export interface ReplayVariant {
  key: string;
  label: string;
  patch: Partial<StoreConfig['staffing']>;
}

export const REPLAY_VARIANTS: ReplayVariant[] = [
  { key: 'legacy_standard', label: 'A 原标准桌当量', patch: { capacityModel: 'legacy', capacityBasis: 'standard_equivalent', serviceMode: 'partial', calibrationStatus: 'unverified' } },
  { key: 'minutes_partial', label: 'B 服务分钟·部分代烤', patch: { capacityModel: 'service_minutes', capacityBasis: 'standard_equivalent', serviceMode: 'partial', calibrationStatus: 'unverified' } },
  { key: 'minutes_full', label: 'C1 服务分钟·全程代烤', patch: { capacityModel: 'service_minutes', capacityBasis: 'standard_equivalent', serviceMode: 'full', calibrationStatus: 'unverified' } },
  { key: 'minutes_self', label: 'C2 服务分钟·自主烤制', patch: { capacityModel: 'service_minutes', capacityBasis: 'standard_equivalent', serviceMode: 'self', calibrationStatus: 'unverified' } },
];

interface Observation {
  id: string;
  tableType: TableType;
  partySize: number;
  queueAt: number | null;
  seatAt: number;
  checkoutAt: number | null;
  leaveAt: number;
  cleanAt: number | null;
  onDutyStaff: number;
  actualWorkMinutes: number | null;
  managerSufficiency: 'short' | 'adequate' | 'over' | 'unknown' | null;
}

function metricsFor(rows: Array<{ recommended: number; actual: number | null; tableType: TableType | 'mixed'; leadMinutes: number; evaluated: boolean; phase?: string }>, hourlyRate: number) {
  const evaluated = rows.filter((r) => r.evaluated && r.actual !== null);
  const mae = evaluated.length ? evaluated.reduce((s, r) => s + Math.abs(r.recommended - (r.actual ?? 0)), 0) / evaluated.length : null;
  const bias = evaluated.length ? evaluated.reduce((s, r) => s + (r.recommended - (r.actual ?? 0)), 0) / evaluated.length : null;
  const overHours = evaluated.reduce((s, r) => s + Math.max(0, r.recommended - (r.actual ?? 0)) * 0.5, 0);
  const underHours = evaluated.reduce((s, r) => s + Math.max(0, (r.actual ?? 0) - r.recommended) * 0.5, 0);
  const peakMiss = evaluated.filter((r) => (r.actual ?? 0) > r.recommended).length;
  const shortageCount = evaluated.filter((r) => (r.actual ?? 0) > r.recommended).length;
  const peakShortageDetectionRate = shortageCount ? Math.round((1 - peakMiss / shortageCount) * 1000) / 1000 : null;
  const byType: Record<string, { count: number; mae: number | null; bias: number | null }> = {};
  for (const type of ['small', 'medium', 'large', 'mixed']) {
    const subset = evaluated.filter((r) => r.tableType === type);
    byType[type] = {
      count: subset.length,
      mae: subset.length ? Math.round((subset.reduce((s, r) => s + Math.abs(r.recommended - (r.actual ?? 0)), 0) / subset.length) * 100) / 100 : null,
      bias: subset.length ? Math.round((subset.reduce((s, r) => s + (r.recommended - (r.actual ?? 0)), 0) / subset.length) * 100) / 100 : null,
    };
  }
  return {
    predictionCount: rows.length,
    evaluatedCount: evaluated.length,
    mae: mae === null ? null : Math.round(mae * 100) / 100,
    bias: bias === null ? null : Math.round(bias * 100) / 100,
    overstaffedPersonHours: Math.round(overHours * 100) / 100,
    understaffedPersonHours: Math.round(underHours * 100) / 100,
    peakMissCount: peakMiss,
    peakShortageDetectionRate,
    estimatedExtraLaborCost: Math.round(overHours * hourlyRate * 100) / 100,
    averageLeadMinutes: evaluated.length ? Math.round((evaluated.reduce((s, r) => s + r.leadMinutes, 0) / evaluated.length) * 10) / 10 : null,
    byTableType: byType,
    labelNote: 'actualRequired uses manager sufficiency + on-duty; work minutes when available. It is a human-reviewed label, not only actual on-duty.',
  };
}

function observationsFor(db: Db, importId: string): Observation[] {
  return listObservations(db, importId).map((o) => ({
    id: String(o.id),
    tableType: o.tableType as TableType,
    partySize: Number(o.partySize),
    queueAt: o.queueAt === null ? null : Number(o.queueAt),
    seatAt: Number(o.seatAt),
    checkoutAt: o.checkoutAt === null ? null : Number(o.checkoutAt),
    leaveAt: Number(o.leaveAt),
    cleanAt: o.cleanAt === null ? null : Number(o.cleanAt),
    onDutyStaff: Number(o.onDutyStaff),
    actualWorkMinutes: o.actualWorkMinutes === null ? null : Number(o.actualWorkMinutes),
    managerSufficiency: (o.managerSufficiency as Observation['managerSufficiency']) ?? null,
  }));
}

export function runReplay(db: Db, storeId: string, importId: string, actorId: string, variants = REPLAY_VARIANTS) {
  const imported = getImport(db, storeId, importId);
  const rows = observationsFor(db, importId);
  if (!rows.length) throw new AppError(409, 'NO_VALID_OBSERVATIONS', '导入批次没有可回放的有效样本');
  const store = getStore(db, storeId);
  const base = parseConfig(store);
  // Replay each business day independently; never bridge overnight gaps.
  const byDay = new Map<string, Observation[]>();
  for (const row of rows) {
    const key = new Date(row.seatAt + 8 * 3_600_000).toISOString().slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(row);
    byDay.set(key, list);
  }
  const points: number[] = [];
  for (const dayRows of byDay.values()) {
    const minSeat = Math.min(...dayRows.map((r) => r.seatAt));
    const maxLeave = Math.max(...dayRows.map((r) => r.leaveAt));
    const start = Math.ceil((minSeat + 1) / (30 * MINUTE_MS)) * 30 * MINUTE_MS;
    for (let t = start; t + 3 * 60 * MINUTE_MS <= maxLeave; t += 30 * MINUTE_MS) points.push(t);
  }
  points.sort((a, b) => a - b);
  if (!points.length) throw new AppError(409, 'REPLAY_TOO_SHORT', '导入数据不足 3 小时，无法回放');
  const dates = [...new Set(rows.map((r) => new Date(r.seatAt + 8 * 3_600_000).toISOString().slice(0, 10)))].sort();
  const splitDate = dates.length >= 14 ? dates[6] : null;
  const phaseOf = (t: number) => {
    const d = new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
    if (!splitDate) return 'calibration';
    return d <= splitDate ? 'calibration' : 'validation';
  };
  const runs = [];
  for (const variant of variants) {
    const cfg: StoreConfig = { ...base, staffing: { ...base.staffing, ...variant.patch } };
    const runId = id('rpl');
    const now = Date.now();
    run(
      db,
      `INSERT INTO replay_runs(id, import_id, store_id, model, service_mode, status, created_by, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [runId, importId, storeId, cfg.staffing.capacityModel, cfg.staffing.serviceMode, 'running', actorId, now],
    );
    const metricsRows: Array<{ recommended: number; actual: number | null; tableType: TableType | 'mixed'; leadMinutes: number; evaluated: boolean; phase: string }> = [];
    for (const t of points) {
      const active = rows.filter((r) => r.seatAt <= t && r.leaveAt > t);
      const queued = rows.filter((r) => r.queueAt !== null && r.queueAt <= t && r.seatAt > t);
      const recent = rows.filter((r) => r.seatAt > t - 2 * 60 * MINUTE_MS && r.seatAt <= t).map((r) => r.seatAt);
      const history = rows.filter((r) => r.seatAt < t - 24 * 60 * MINUTE_MS).map((r) => r.seatAt);
      const onDuty = Math.max(1, ...active.map((r) => r.onDutyStaff), ...rows.filter((r) => r.seatAt <= t).map((r) => r.onDutyStaff));
      const forecast = computeCapacityForecast({
        now: t,
        config: cfg,
        onDutyStaff: onDuty,
        tables: active.map((r) => ({
          type: r.tableType,
          status: r.checkoutAt && t >= r.checkoutAt ? 'checkout' : 'dining',
          seatedAt: r.seatAt,
          checkoutAt: r.checkoutAt,
          statusUpdatedAt: t,
        })),
        queue: queued.map((r) => ({ partySize: r.partySize, desiredType: r.tableType, status: 'queued' as const })),
        recentSeatedAt: recent,
        historySeatedAt: history,
        recentCalls: 0,
        historyDays: new Set(history.map((h) => Math.floor(h / 86_400_000))).size,
        source: 'external',
        slotCount: 6,
      });
      const horizonEnd = forecast.horizonStart + 3 * 60 * MINUTE_MS;
      const future = rows.filter((r) => r.seatAt < horizonEnd && r.leaveAt > t);
      const futureOnDuty = Math.max(1, ...future.map((r) => r.onDutyStaff));
      const sufficiency = future.map((r) => r.managerSufficiency).filter((s) => s && s !== 'unknown') as string[];
      const hasReview = sufficiency.length > 0;
      const workMinutes = future.map((r) => r.actualWorkMinutes).filter((v): v is number => v !== null && Number.isFinite(v));
      const labelMethod = hasReview ? 'manager_sufficiency_on_duty' : workMinutes.length ? 'actual_work_minutes' : 'unlabeled';
      let actual: number | null = null;
      if (hasReview) {
        const adjustment = sufficiency.includes('short') ? 1 : sufficiency.every((s) => s === 'over') ? -1 : 0;
        actual = futureOnDuty + adjustment;
      } else if (workMinutes.length) {
        actual = Math.max(1, Math.ceil(workMinutes.reduce((s, v) => s + v, 0) / (cfg.staffing.effectiveServiceMinutesPerSlot * 6)));
      }
      const evaluated = actual !== null;
      const snapshot = {
        at: t,
        atLabel: formatDateTime(t),
        onDutyStaff: onDuty,
        activeObservationIds: active.map((r) => r.id),
        queuedObservationIds: queued.map((r) => r.id),
        tables: active.map((r) => ({ id: r.id, type: r.tableType, seatedAt: r.seatAt, status: r.checkoutAt && t >= r.checkoutAt ? 'checkout' : 'dining' })),
        queue: queued.map((r) => ({ id: r.id, partySize: r.partySize, joinedAt: r.queueAt })),
        serviceMode: cfg.staffing.serviceMode,
        model: cfg.staffing.capacityModel,
        dataQuality: { observationCount: active.length + queued.length, historyPoints: history.length },
      };
      const actualJson = {
        method: labelMethod,
        onDuty: futureOnDuty,
        managerSufficiency: sufficiency,
        required: actual,
        futureObservationIds: future.map((r) => r.id),
        futureObservationCount: future.length,
      };
      const phase = phaseOf(t);
      run(
        db,
        `INSERT INTO replay_predictions(id, run_id, prediction_time, horizon_start, horizon_end, input_snapshot_json, model, service_mode, recommended, reason, quality_json, actual_json, phase, evaluated, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id('rpp'), runId, t, forecast.horizonStart, horizonEnd, JSON.stringify(snapshot), cfg.staffing.capacityModel, cfg.staffing.serviceMode, forecast.peakRequiredStaff, `${forecast.bottleneckReason}；${forecast.reliabilityReason}`, JSON.stringify({ reliability: forecast.reliability, calibrationStatus: cfg.staffing.calibrationStatus }), JSON.stringify(actualJson), phase, evaluated ? 1 : 0, Date.now()],
      );
      const dominant = active.reduce<Record<string, number>>((acc, r) => { acc[r.tableType] = (acc[r.tableType] ?? 0) + 1; return acc; }, {});
      const types = Object.entries(dominant).filter(([, n]) => n > 0);
      const max = Math.max(0, ...types.map(([, n]) => n));
      const top = types.filter(([, n]) => n === max);
      const tableType = (top.length !== 1 || types.length > 1 ? 'mixed' : (top[0]?.[0] ?? 'small')) as TableType | 'mixed';
      metricsRows.push({ recommended: forecast.peakRequiredStaff, actual, tableType, leadMinutes: Math.round((forecast.horizonStart - t) / MINUTE_MS), evaluated, phase });
    }
    const baseMetrics = metricsFor(metricsRows, base.basic.hourlyRate);
    const metrics = {
      ...baseMetrics,
      phases: {
        calibration: metricsFor(metricsRows.filter((r) => r.phase === 'calibration'), base.basic.hourlyRate),
        validation: metricsFor(metricsRows.filter((r) => r.phase === 'validation'), base.basic.hourlyRate),
      },
      splitDate,
      distinctDays: dates.length,
      insufficientData: dates.length < 14 || metricsRows.filter((r) => r.phase === 'validation' && r.evaluated).length === 0,
      dataQuality: imported.quality,
      missingRate: (() => {
        const missing = imported.quality?.missing ?? {};
        const total = Object.values(missing as Record<string, number>).reduce((a, b) => a + Number(b), 0);
        const fields = Object.keys(missing).length || 1;
        return imported.quality?.validCount ? Math.round((total / (imported.quality.validCount * fields)) * 10000) / 10000 : null;
      })(),
      timestampIssues: imported.quality?.timeOrderIssues ?? imported.quality?.timestampInvalid ?? null,
    };
    run(
      db,
      "UPDATE replay_runs SET status = 'completed', prediction_count = ?, metrics_json = ?, data_quality_json = ?, completed_at = ? WHERE id = ?",
      [points.length, JSON.stringify(metrics), JSON.stringify(imported.quality), Date.now(), runId],
    );
    runs.push({ runId, model: cfg.staffing.capacityModel, serviceMode: cfg.staffing.serviceMode, metrics });
  }
  return { importId, dataOrigin: imported.data_origin, points: points.length, runs };
}

export function listReplayRuns(db: Db, storeId: string, importId?: string) {
  return all<Record<string, unknown>>(
    db,
    importId
      ? 'SELECT * FROM replay_runs WHERE store_id = ? AND import_id = ? ORDER BY created_at'
      : 'SELECT * FROM replay_runs WHERE store_id = ? ORDER BY created_at DESC LIMIT 50',
    importId ? [storeId, importId] : [storeId],
  ).map((r) => ({
    id: r.id,
    importId: r.import_id,
    model: r.model,
    serviceMode: r.service_mode,
    status: r.status,
    predictionCount: r.prediction_count,
    metrics: JSON.parse(String(r.metrics_json)),
    createdAt: r.created_at,
  }));
}
