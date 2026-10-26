import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import type { ForecastResult, StoreConfig } from '../domain/types.js';
import { formatDateTime, formatTime } from '../lib/time.js';
import { sha256 } from '../lib/ids.js';

export const aiAnalysisSchema = z.object({
  summary: z.string().min(5).max(400),
  riskLevel: z.enum(['low', 'medium', 'high']),
  bottleneckExplanation: z.string().min(5).max(400),
  slotNotes: z
    .array(
      z.object({
        slotIndex: z.number().int().min(0).max(5),
        note: z.string().min(2).max(300),
      }),
    )
    .max(6),
  cautions: z.array(z.string().min(2).max(200)).max(5),
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema> & {
  recommendations: Array<{
    slotIndex: number;
    startAt: number;
    endAt: number;
    headcount: number;
    reason: string;
  }>;
};

export interface AiResult {
  status: 'ok' | 'fallback';
  analysis: AiAnalysis;
  error?: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs?: number;
}

/** Stable cache key: same operating facts + model + service mode => same analysis. */
export function forecastCacheKey(forecast: ForecastResult, config: StoreConfig, model: string): string {
  return sha256(
    JSON.stringify({
      model,
      job: config.basic.jobType,
      tables: config.tables,
      staffing: {
        capacityModel: config.staffing.capacityModel,
        capacityBasis: config.staffing.capacityBasis,
        serviceMode: config.staffing.serviceMode,
        serviceMinutes: config.staffing.serviceMinutes,
        effective: config.staffing.effectiveServiceMinutesPerSlot,
      },
      forecast: {
        peakRequiredStaff: forecast.peakRequiredStaff,
        peakGap: forecast.peakGap,
        bottleneck: forecast.bottleneck,
        reliability: forecast.reliability,
        slots: forecast.slots.map((s) => ({
          label: s.label,
          occupied: s.projectedOccupied,
          queue: s.projectedQueueGroups,
          load: s.weightedLoad,
          required: s.requiredStaff,
          gap: s.gap,
        })),
      },
    }),
  );
}

export function deterministicAnalysis(forecast: ForecastResult, config: StoreConfig): AiAnalysis {
  const peakSlot = forecast.slots.reduce((best, s) => (s.gap > best.gap ? s : best), forecast.slots[0]);
  const need = forecast.peakGap;
  const summary =
    need > 0
      ? `${config.basic.name} 未来 3 小时预计高峰需要 ${forecast.peakRequiredStaff} 人，当前在岗 ${forecast.slots[0]?.onDutyStaff ?? 0} 人，缺口 ${need} 人。`
      : `未来 3 小时服务人力可以覆盖预测客流，当前无需增派。`;
  const riskLevel: AiAnalysis['riskLevel'] =
    need >= 3 ? 'high' : need >= 1 ? 'medium' : 'low';
  const recommendations = forecast.gapRanges.map((range) => ({
    slotIndex: forecast.slots.findIndex((s) => s.startAt === range.startAt),
    startAt: range.startAt,
    endAt: range.endAt,
    headcount: range.headcount,
    reason: `该时段预计需要 ${range.headcount} 名额外${config.basic.jobType}，工作量为桌位服务与翻台共同造成。`,
  }));
  return {
    summary,
    riskLevel,
    bottleneckExplanation: forecast.bottleneckReason,
    slotNotes: peakSlot
      ? [
          {
            slotIndex: peakSlot.index,
            note: `高峰时段 ${peakSlot.label}：预计 ${peakSlot.projectedActiveTables} 桌在用、${peakSlot.projectedQueueGroups} 组等待，服务负荷 ${peakSlot.weightedLoad}。`,
          },
        ]
      : [],
    cautions: [
      forecast.reliability === 'low' ? '当前实时与历史数据不足，建议先按经济方案小规模补员。' : '预测依赖当前排队与入座速度，客流突变时请重新生成。',
    ],
    recommendations,
  };
}

export interface AiDeps {
  fetchImpl?: typeof fetch;
  now?: number;
}

/**
 * LLM explains the deterministic result. It can only add text keyed to slot
 * indices; headcount and times are always taken from the capacity engine.
 */
export async function analyzeForecast(
  forecast: ForecastResult,
  config: StoreConfig,
  cfg: AppConfig,
  deps: AiDeps = {},
): Promise<AiResult> {
  const fallback = deterministicAnalysis(forecast, config);
  if (!cfg.deepseek.apiKey) {
    return { status: 'fallback', analysis: fallback, error: 'AI_NOT_CONFIGURED' };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const facts = {
    store: {
      name: config.basic.name,
      jobType: config.basic.jobType,
      onDutyStaff: forecast.slots[0]?.onDutyStaff ?? 0,
      tablesPerStaff: config.staffing.tablesPerStaff,
      counts: {
        small: config.tables.small.count,
        medium: config.tables.medium.count,
        large: config.tables.large.count,
      },
    },
    forecast: {
      reliability: forecast.reliability,
      bottleneck: forecast.bottleneck,
      bottleneckReason: forecast.bottleneckReason,
      peakRequiredStaff: forecast.peakRequiredStaff,
      peakGap: forecast.peakGap,
      slots: forecast.slots.map((s) => ({
        slotIndex: s.index,
        time: `${formatTime(s.startAt)}-${formatTime(s.endAt)}`,
        occupied: s.projectedOccupied,
        activeTables: s.projectedActiveTables,
        queueGroups: s.projectedQueueGroups,
        waitMin: s.projectedWaitMin,
        weightedLoad: s.weightedLoad,
        requiredStaff: s.requiredStaff,
        onDutyStaff: s.onDutyStaff,
        gap: s.gap,
        bottleneck: s.bottleneck,
      })),
    },
  };

  const body = {
    model: cfg.deepseek.model,
    messages: [
      {
        role: 'system',
        content:
          '你是烤肉店人力调度分析助手。只解释给定的计算结果，绝不修改人数、时段或任何数字。' +
          '只输出 JSON 对象，字段：summary(字符串), riskLevel("low"|"medium"|"high"), bottleneckExplanation(字符串), ' +
          'slotNotes(数组, 每项 {slotIndex:0-5, note:字符串}), cautions(字符串数组, 最多5条)。' +
          '若 peakGap 为 0，必须说明无需增派。若 bottleneck 为 table，说明应优化翻台而不是加人。' +
          'slotNotes 只能引用给定 slotIndex，不得新增时段。用简体中文，口语化、简洁。',
      },
      {
        role: 'user',
        content: JSON.stringify(facts),
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 800,
  };

  const startedAt = performance.now();
  try {
    const response = await fetchImpl(`${cfg.deepseek.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.deepseek.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.deepseek.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek 返回内容为空');
    const parsedJson = JSON.parse(content);
    const parsed = aiAnalysisSchema.parse(parsedJson);

    // Merge AI text with engine-owned numbers. AI headcount is never trusted.
    const slotNotes = new Map(parsed.slotNotes.map((n) => [n.slotIndex, n.note]));
    const recommendations = forecast.gapRanges.map((range) => {
      const slot = forecast.slots.find((s) => s.startAt === range.startAt);
      return {
        slotIndex: slot?.index ?? 0,
        startAt: range.startAt,
        endAt: range.endAt,
        headcount: range.headcount,
        reason:
          slotNotes.get(slot?.index ?? 0) ??
          `该时段预计缺少 ${range.headcount} 人，需覆盖桌位服务与翻台。`,
      };
    });
    const usage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
    return {
      status: 'ok',
      model: cfg.deepseek.model,
      usage,
      latencyMs: Math.round(performance.now() - startedAt),
      analysis: {
        ...parsed,
        slotNotes: parsed.slotNotes.sort((a, b) => a.slotIndex - b.slotIndex),
        recommendations,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Full upstream diagnostics stay in server logs. The client only receives a
    // stable code so provider bodies (masked key suffix, request ids) never leak.
    logger.warn('deepseek_failed', { error: message.slice(0, 500), model: cfg.deepseek.model });
    const code = /ZodError|invalid_type|JSON/i.test(message)
      ? 'AI_RESPONSE_INVALID'
      : /timeout|abort|TimeoutError/i.test(message)
        ? 'AI_TIMEOUT'
        : /HTTP 401|HTTP 403/i.test(message)
          ? 'AI_AUTH_FAILED'
          : 'AI_UPSTREAM_ERROR';
    return { status: 'fallback', analysis: fallback, error: code, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

export function aiPromptDebug(forecast: ForecastResult, config: StoreConfig): string {
  return `门店 ${config.basic.name}｜${formatDateTime(forecast.horizonStart)}｜需求 ${forecast.peakRequiredStaff} 人｜缺口 ${forecast.peakGap}｜${forecast.bottleneckReason}`;
}
