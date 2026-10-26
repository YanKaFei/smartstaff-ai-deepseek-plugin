import type { Db } from '../db/index.js';
import { all, get, parseJson, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { startOfLocalDay } from '../lib/time.js';
import type { AppConfig } from '../config.js';
import { computeCapacityForecast, type CapacityQueueInput, type CapacityTableInput } from './capacity.js';
import { storeNow } from './clock.js';
import { ensureBusinessDay, latestCallNo } from './ops.js';
import { getStore, parseConfig, type StoreRow } from './stores.js';
import type { BusinessDayRow, QueueRow, TableRow } from './ops.js';
import type { ForecastResult, TableType } from './types.js';
import { analyzeForecast, deterministicAnalysis, forecastCacheKey, type AiAnalysis } from '../ai/deepseek.js';
import { aiBudgetStatus, getCachedAnalysis, putCachedAnalysis, recordAiUsage } from './aiUsage.js';
import { recordAiBusinessSuccess, resolveAiRuntime } from './aiSettings.js';
import { audit } from './notify.js';

export interface ForecastRow {
  id: string;
  store_id: string;
  generated_at: number;
  horizon_start: number;
  slots_json: string;
  summary_json: string;
  ai_json: string | null;
  ai_status: string;
  reliability: string;
  bottleneck: string;
  required_staff: number;
  on_duty_staff: number;
  gap: number;
  source: string;
}

export interface SerializedForecast extends ForecastResult {
  id: string;
  storeId: string;
  aiStatus: 'ok' | 'fallback';
  ai: AiAnalysis;
  aiError?: string;
  aiCached?: boolean;
  source: string;
  onDutyStaff: number;
}

export function serializeForecast(row: ForecastRow): SerializedForecast {
  const summary = parseJson<ForecastResult>(row.summary_json, {
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
  const ai = parseJson<AiAnalysis | null>(row.ai_json, null);
  return {
    ...summary,
    slots: parseJson(row.slots_json, summary.slots),
    id: row.id,
    storeId: row.store_id,
    aiStatus: row.ai_status === 'ok' ? 'ok' : 'fallback',
    ai: ai ?? deterministicAnalysis(summary, {
      basic: {
        name: '',
        hoursStart: '00:00',
        hoursEnd: '00:00',
        address: '',
        lat: 0,
        lng: 0,
        jobType: '烤肉辅助',
        hourlyRate: 0,
      },
      tables: {
        small: { count: 0, seats: 4, avgDiningMin: 70, weight: 1 },
        medium: { count: 0, seats: 6, avgDiningMin: 85, weight: 1.6 },
        large: { count: 0, seats: 10, avgDiningMin: 100, weight: 2.4 },
        checkoutToLeaveMin: 8,
        leaveToCleanMin: 6,
        partyMapping: [],
      },
      staffing: {
        onDutyCount: 0,
        shiftStart: '00:00',
        shiftEnd: '00:00',
        tablesPerStaff: 5,
        serviceBufferPct: 0,
        requireQualified: true,
        capacityModel: 'legacy',
        capacityBasis: 'standard_equivalent',
        serviceMode: 'partial',
        serviceMinutes: { small: 14, medium: 26, large: 44 },
        effectiveServiceMinutesPerSlot: 24,
        calibrationStatus: 'unverified',
      },
      matching: { maxDistanceKm: 5, minNoticeMin: 20, offerTtlMinutes: 10, travelSpeedKmh: 18 },
      policy: { staffCancelMinNoticeMin: 60, noShowGraceMin: 45, autoBackfill: true },
      pilot: { shadowMode: false },
      dataSource: 'manual',
    }),
    source: row.source,
    onDutyStaff: row.on_duty_staff,
  };
}

function capacityInputs(db: Db, store: StoreRow, now: number, day: BusinessDayRow) {
  const tables = all<TableRow>(db, 'SELECT * FROM store_tables WHERE store_id = ?', [store.id]);
  const sessions = all<{
    id: string;
    table_id: string;
    seated_at: number;
    checkout_at: number | null;
  }>(
    db,
    'SELECT id, table_id, seated_at, checkout_at FROM dining_sessions WHERE store_id = ? AND seated_at >= ?',
    [store.id, now - 6 * 3_600_000],
  );
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const capacityTables: CapacityTableInput[] = tables.map((t) => {
    const session = t.current_session_id ? sessionById.get(t.current_session_id) : undefined;
    return {
      type: t.table_type,
      status: t.status,
      seatedAt: session?.seated_at ?? null,
      checkoutAt: session?.checkout_at ?? null,
      statusUpdatedAt: t.status_updated_at,
    };
  });
  const queue = all<QueueRow>(
    db,
    "SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called')",
    [store.id, day.business_date],
  );
  const capacityQueue: CapacityQueueInput[] = queue.map((q) => ({
    partySize: q.party_size,
    desiredType: q.desired_type,
    status: q.status as 'queued' | 'called',
  }));

  const recentCalls = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM queue_entries WHERE store_id = ? AND called_at >= ? AND called_at <= ?',
    [store.id, now - 60 * 60_000, now],
  )?.n ?? 0;
  const recentSeated = all<{ seated_at: number }>(
    db,
    'SELECT seated_at FROM dining_sessions WHERE store_id = ? AND seated_at >= ? AND seated_at <= ?',
    [store.id, now - 120 * 60_000, now],
  ).map((s) => s.seated_at);

  const dayStart = startOfLocalDay(now);
  const history = all<{ seated_at: number; business_date: string }>(
    db,
    'SELECT seated_at, business_date FROM dining_sessions WHERE store_id = ? AND seated_at >= ? AND seated_at < ?',
    [store.id, dayStart - 7 * 86_400_000, dayStart],
  );
  const historyDays = new Set(history.map((h) => h.business_date)).size;
  return {
    tables: capacityTables,
    queue: capacityQueue,
    recentSeatedAt: recentSeated,
    historySeatedAt: history.map((h) => h.seated_at),
    recentCalls,
    historyDays,
  };
}

export async function generateForecast(
  db: Db,
  storeId: string,
  cfg: AppConfig,
  opts: { useAi?: boolean; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<SerializedForecast> {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const now = opts.now ?? storeNow(db, storeId);
  const day = ensureBusinessDay(db, store, now);
  const inputs = capacityInputs(db, store, now, day);
  const result = computeCapacityForecast({
    now,
    config,
    onDutyStaff: day.on_duty_staff,
    tables: inputs.tables,
    queue: inputs.queue,
    recentSeatedAt: inputs.recentSeatedAt,
    historySeatedAt: inputs.historySeatedAt,
    recentCalls: inputs.recentCalls,
    historyDays: inputs.historyDays,
    source: config.dataSource,
  });

  const useAi = opts.useAi ?? true;
  const runtime = resolveAiRuntime(db, cfg);
  const aiCfg = runtime.cfg;
  const aiModel = aiCfg.deepseek.model;
  const forecastId = id('fc');
  const cacheKey = forecastCacheKey(result, config, aiModel);
  let aiCached = false;
  let aiResult: Awaited<ReturnType<typeof analyzeForecast>> = {
    status: 'fallback',
    analysis: deterministicAnalysis(result, config),
    error: '本次仅使用确定性引擎',
  };
  if (useAi && !runtime.enabled) {
    aiResult = {
      status: 'fallback',
      analysis: deterministicAnalysis(result, config),
      error: 'AI_DISABLED',
      latencyMs: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    recordAiUsage(db, aiCfg, {
      storeId,
      forecastId,
      model: aiModel,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      status: 'disabled',
      errorCode: 'AI_DISABLED',
    });
  } else if (useAi) {
    const cached = getCachedAnalysis(db, cacheKey);
    if (cached) {
      aiCached = true;
      aiResult = { status: 'ok', analysis: cached, model: aiModel, latencyMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      recordAiUsage(db, aiCfg, {
        storeId,
        forecastId,
        model: aiModel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        status: 'cache_hit',
        cacheHit: true,
      });
    } else {
      const budget = aiBudgetStatus(db, storeId, aiCfg);
      if (!budget.allowed) {
        aiResult = {
          status: 'fallback',
          analysis: deterministicAnalysis(result, config),
          error: 'AI_BUDGET_EXCEEDED',
          latencyMs: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
        recordAiUsage(db, aiCfg, {
          storeId,
          forecastId,
          model: aiModel,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: 0,
          status: 'budget_blocked',
          errorCode: 'AI_BUDGET_EXCEEDED',
        });
        audit(db, {
          storeId,
          action: 'ai.budget_blocked',
          entity: 'forecast',
          entityId: forecastId,
          detail: { reason: budget.reason },
          at: now,
        });
      } else {
        aiResult = await analyzeForecast(result, config, aiCfg, { fetchImpl: opts.fetchImpl });
        if (aiResult.status === 'ok') {
          putCachedAnalysis(db, cacheKey, aiModel, aiResult.analysis, aiCfg);
          recordAiBusinessSuccess(db, aiModel, aiResult.latencyMs ?? 0);
        }
        recordAiUsage(db, aiCfg, {
          storeId,
          forecastId,
          model: aiModel,
          promptTokens: aiResult.usage?.promptTokens ?? 0,
          completionTokens: aiResult.usage?.completionTokens ?? 0,
          totalTokens: aiResult.usage?.totalTokens ?? 0,
          latencyMs: aiResult.latencyMs ?? 0,
          status: aiResult.status,
          errorCode: aiResult.error,
        });
      }
    }
  }
  run(
    db,
    `INSERT INTO forecasts(id, store_id, generated_at, horizon_start, slots_json, summary_json, ai_json, ai_status, reliability, bottleneck, required_staff, on_duty_staff, gap, source)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      forecastId,
      storeId,
      now,
      result.horizonStart,
      JSON.stringify(result.slots),
      JSON.stringify(result),
      JSON.stringify(aiResult.analysis),
      aiResult.status,
      result.reliability,
      result.bottleneck,
      result.peakRequiredStaff,
      day.on_duty_staff,
      result.peakGap,
      config.dataSource,
    ],
  );
  audit(db, {
    storeId,
    action: 'forecast.generate',
    entity: 'forecast',
    entityId: forecastId,
    detail: { gap: result.peakGap, aiStatus: aiResult.status, reliability: result.reliability },
    at: now,
  });

  return {
    ...result,
    id: forecastId,
    storeId,
    aiStatus: aiResult.status,
    ai: aiResult.analysis,
    aiError: aiResult.error,
    aiCached,
    source: config.dataSource,
    onDutyStaff: day.on_duty_staff,
  };
}

export function getForecastRow(db: Db, storeId: string, forecastId?: string): ForecastRow {
  const row = forecastId
    ? get<ForecastRow>(db, 'SELECT * FROM forecasts WHERE id = ? AND store_id = ?', [forecastId, storeId])
    : get<ForecastRow>(db, 'SELECT * FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1', [storeId]);
  if (!row) throw new AppError(404, 'FORECAST_NOT_FOUND', '尚无预测结果，请先生成预测');
  return row;
}

export function listForecasts(db: Db, storeId: string, limit = 20): SerializedForecast[] {
  const rows = all<ForecastRow>(
    db,
    'SELECT * FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT ?',
    [storeId, limit],
  );
  return rows.map(serializeForecast);
}

export function forecastSummaryForToday(db: Db, storeId: string): ForecastRow | undefined {
  return get<ForecastRow>(db, 'SELECT * FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1', [
    storeId,
  ]);
}

export type { TableType };
