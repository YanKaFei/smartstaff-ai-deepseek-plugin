import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { startOfLocalDay } from '../lib/time.js';
import type { AiAnalysis } from '../ai/deepseek.js';

export interface AiUsageInput {
  storeId: string;
  forecastId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: string;
  errorCode?: string | null;
  cacheHit?: boolean;
}

export function estimateCostUsd(cfg: AppConfig, promptTokens: number, completionTokens: number): { cost: number; basis: string } {
  const input = cfg.deepseek.inputPricePerMTok;
  const output = cfg.deepseek.outputPricePerMTok;
  if (!input && !output) return { cost: 0, basis: 'unconfigured' };
  const cost = (promptTokens / 1_000_000) * input + (completionTokens / 1_000_000) * output;
  return { cost: Math.round(cost * 1_000_000) / 1_000_000, basis: 'configured_estimate' };
}

export function recordAiUsage(db: Db, cfg: AppConfig, input: AiUsageInput): void {
  const { cost, basis } = estimateCostUsd(cfg, input.promptTokens, input.completionTokens);
  run(
    db,
    `INSERT INTO ai_usage(id, store_id, forecast_id, model, prompt_tokens, completion_tokens, total_tokens,
       latency_ms, cost_usd, cost_basis, status, error_code, cache_hit, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('aiu'),
      input.storeId,
      input.forecastId,
      input.model,
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
      input.latencyMs,
      cost,
      basis,
      input.status,
      input.errorCode ?? null,
      input.cacheHit ? 1 : 0,
      Date.now(),
    ],
  );
}

export interface AiBudgetStatus {
  allowed: boolean;
  dailyUsedUsd: number;
  monthlyUsedUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  reason?: string;
}

export function aiBudgetStatus(db: Db, storeId: string, cfg: AppConfig): AiBudgetStatus {
  const dayStart = startOfLocalDay(Date.now());
  const monthStart = Date.now() - 30 * 86_400_000;
  const daily = get<{ total: number }>(db, 'SELECT COALESCE(SUM(cost_usd),0) AS total FROM ai_usage WHERE store_id = ? AND created_at >= ?', [storeId, dayStart])!;
  const monthly = get<{ total: number }>(db, 'SELECT COALESCE(SUM(cost_usd),0) AS total FROM ai_usage WHERE created_at >= ?', [monthStart])!;
  const dailyBudget = cfg.deepseek.dailyBudgetUsd;
  const monthlyBudget = cfg.deepseek.monthlyBudgetUsd;
  let reason: string | undefined;
  if (dailyBudget > 0 && daily.total >= dailyBudget) reason = '单店 AI 日预算已用尽';
  else if (monthlyBudget > 0 && monthly.total >= monthlyBudget) reason = '平台 AI 月预算已用尽';
  return {
    allowed: !reason,
    dailyUsedUsd: Math.round(daily.total * 10000) / 10000,
    monthlyUsedUsd: Math.round(monthly.total * 10000) / 10000,
    dailyBudgetUsd: dailyBudget,
    monthlyBudgetUsd: monthlyBudget,
    reason,
  };
}

export function getCachedAnalysis(db: Db, cacheKey: string): AiAnalysis | null {
  const row = get<{ analysis_json: string; expires_at: number }>(db, 'SELECT analysis_json, expires_at FROM ai_cache WHERE cache_key = ?', [cacheKey]);
  if (!row || row.expires_at < Date.now()) return null;
  try {
    return JSON.parse(row.analysis_json) as AiAnalysis;
  } catch {
    return null;
  }
}

export function putCachedAnalysis(db: Db, cacheKey: string, model: string, analysis: AiAnalysis, cfg: AppConfig): void {
  const now = Date.now();
  run(
    db,
    `INSERT INTO ai_cache(cache_key, model, analysis_json, created_at, expires_at) VALUES(?,?,?,?,?)
     ON CONFLICT(cache_key) DO UPDATE SET analysis_json = excluded.analysis_json, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [cacheKey, model, JSON.stringify(analysis), now, now + cfg.deepseek.cacheTtlMinutes * 60_000],
  );
}

export function listAiUsage(db: Db, storeId: string, limit = 50) {
  return (
    db
      .prepare(
        'SELECT id, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, cost_usd, cost_basis, status, error_code, cache_hit, created_at FROM ai_usage WHERE store_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(storeId, limit) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    model: r.model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    latencyMs: r.latency_ms,
    costUsd: r.cost_usd,
    costBasis: r.cost_basis,
    status: r.status,
    errorCode: r.error_code,
    cacheHit: Boolean(r.cache_hit),
    createdAt: r.created_at,
  }));
}
