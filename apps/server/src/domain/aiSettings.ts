import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { get, run, transaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { decryptSecretWithPurpose, encryptSecretWithPurpose } from '../lib/secrets.js';
import { audit } from './notify.js';
import { listAiUsage, aiBudgetStatus, estimateCostUsd } from './aiUsage.js';

const OFFICIAL_BASE_URL = 'https://api.deepseek.com';
export const AI_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

export interface AiSettingsRow {
  id: string;
  provider: string;
  base_url: string;
  api_key_enc: string | null;
  credential_revoked: number;
  model: string;
  timeout_ms: number;
  enabled: number;
  daily_budget_usd: number;
  monthly_budget_usd: number;
  last_success_at: number | null;
  last_test_at: number | null;
  last_test_status: string | null;
  last_test_error: string | null;
  last_test_latency_ms: number | null;
  last_test_model: string | null;
  updated_by: string | null;
  updated_at: number;
}

export interface AiRuntime {
  cfg: AppConfig;
  enabled: boolean;
  credentialSource: 'database' | 'environment' | 'none';
  row: AiSettingsRow | null;
}

function getRow(db: Db): AiSettingsRow | null {
  return (
    get<AiSettingsRow>(db, "SELECT * FROM ai_settings WHERE id = 'global'") ?? null
  );
}

function defaultRow(cfg: AppConfig): AiSettingsRow {
  return {
    id: 'global',
    provider: 'deepseek',
    base_url: cfg.deepseek.baseUrl,
    api_key_enc: null,
    credential_revoked: 0,
    model: cfg.deepseek.model,
    timeout_ms: cfg.deepseek.timeoutMs,
    enabled: 1,
    daily_budget_usd: cfg.deepseek.dailyBudgetUsd,
    monthly_budget_usd: cfg.deepseek.monthlyBudgetUsd,
    last_success_at: null,
    last_test_at: null,
    last_test_status: null,
    last_test_error: null,
    last_test_latency_ms: null,
    last_test_model: null,
    updated_by: null,
    updated_at: 0,
  };
}

/**
 * Resolve once per request. In-flight requests keep this snapshot even if an
 * admin changes settings; the next request sees the new values.
 */
export function resolveAiRuntime(db: Db, cfg: AppConfig): AiRuntime {
  const row = getRow(db);
  if (!row) {
    return {
      cfg,
      enabled: true,
      credentialSource: cfg.deepseek.apiKey ? 'environment' : 'none',
      row: null,
    };
  }
  let databaseKey = '';
  if (row.api_key_enc) {
    try {
      databaseKey = decryptSecretWithPurpose(row.api_key_enc, cfg, 'ai-api-key');
    } catch {
      // A key that cannot be decrypted is treated as unconfigured; admin can replace it.
      databaseKey = '';
    }
  }
  const envAllowed = row.credential_revoked !== 1;
  const apiKey = databaseKey || (envAllowed ? cfg.deepseek.apiKey : '');
  return {
    cfg: {
      ...cfg,
      deepseek: {
        ...cfg.deepseek,
        apiKey,
        baseUrl: row.base_url,
        model: row.model,
        timeoutMs: row.timeout_ms,
        dailyBudgetUsd: row.daily_budget_usd,
        monthlyBudgetUsd: row.monthly_budget_usd,
      },
    },
    enabled: Boolean(row.enabled),
    credentialSource: databaseKey ? 'database' : envAllowed && cfg.deepseek.apiKey ? 'environment' : 'none',
    row,
  };
}

export function publicAiSettings(db: Db, cfg: AppConfig) {
  const row = getRow(db);
  const runtime = resolveAiRuntime(db, cfg);
  const base = row ?? defaultRow(cfg);
  const configured = runtime.credentialSource !== 'none';
  return {
    provider: 'deepseek',
    baseUrl: base.base_url,
    model: base.model,
    timeoutMs: base.timeout_ms,
    enabled: Boolean(base.enabled),
    dailyBudgetUsd: base.daily_budget_usd,
    monthlyBudgetUsd: base.monthly_budget_usd,
    credentialConfigured: configured,
    credentialSource: runtime.credentialSource,
    credentialHint: configured ? '已配置（服务端加密保存，不可读取）' : '未配置',
    models: AI_MODELS,
    officialBaseUrl: OFFICIAL_BASE_URL,
    pricing: {
      inputPerMTokUsd: cfg.deepseek.inputPricePerMTok,
      outputPerMTokUsd: cfg.deepseek.outputPricePerMTok,
      currency: 'USD',
      basis: 'configured_estimate',
      updatedAt: cfg.deepseek.priceUpdatedAt || null,
      note: '费用为按配置单价估算，不是供应商账单；修改价格需重新配置并标注更新时间。',
    },
    lastSuccessAt: base.last_success_at,
    lastTestAt: base.last_test_at,
    lastTestStatus: base.last_test_status,
    lastTestError: base.last_test_error,
    lastTestLatencyMs: base.last_test_latency_ms,
    lastTestModel: base.last_test_model,
    updatedAt: base.updated_at,
  };
}

function validateBaseUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, '');
  if (normalized !== OFFICIAL_BASE_URL) {
    throw new AppError(400, 'AI_BASE_URL_NOT_ALLOWED', '第一版仅支持官方 https://api.deepseek.com；自定义网关需白名单与安全评审');
  }
  return normalized;
}

export function updateAiSettings(
  db: Db,
  cfg: AppConfig,
  input: { baseUrl?: string; model?: string; timeoutMs?: number; enabled?: boolean; dailyBudgetUsd?: number; monthlyBudgetUsd?: number },
  actorId: string,
) {
  const current = getRow(db) ?? defaultRow(cfg);
  const next = {
    ...current,
    base_url: input.baseUrl !== undefined ? validateBaseUrl(input.baseUrl) : current.base_url,
    model: input.model !== undefined ? input.model : current.model,
    timeout_ms: input.timeoutMs !== undefined ? Math.max(5000, Math.min(60000, input.timeoutMs)) : current.timeout_ms,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
    daily_budget_usd: input.dailyBudgetUsd !== undefined ? Math.max(0, input.dailyBudgetUsd) : current.daily_budget_usd,
    monthly_budget_usd: input.monthlyBudgetUsd !== undefined ? Math.max(0, input.monthlyBudgetUsd) : current.monthly_budget_usd,
    updated_by: actorId,
    updated_at: Date.now(),
  };
  if (!AI_MODELS.includes(next.model as (typeof AI_MODELS)[number])) {
    throw new AppError(400, 'AI_MODEL_NOT_ALLOWED', '模型不在允许列表');
  }
  transaction(db, () => {
    run(
      db,
      `INSERT INTO ai_settings(id, provider, base_url, api_key_enc, credential_revoked, model, timeout_ms, enabled, daily_budget_usd, monthly_budget_usd,
        last_success_at, last_test_at, last_test_status, last_test_error, last_test_latency_ms, last_test_model, updated_by, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, timeout_ms=excluded.timeout_ms,
         enabled=excluded.enabled, daily_budget_usd=excluded.daily_budget_usd, monthly_budget_usd=excluded.monthly_budget_usd,
         updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [next.id, 'deepseek', next.base_url, next.api_key_enc, next.credential_revoked, next.model, next.timeout_ms, next.enabled, next.daily_budget_usd, next.monthly_budget_usd,
        next.last_success_at, next.last_test_at, next.last_test_status, next.last_test_error, next.last_test_latency_ms, next.last_test_model, next.updated_by, next.updated_at],
    );
  });
  audit(db, {
    storeId: null,
    actorId,
    actorRole: 'admin',
    action: 'ai.settings.update',
    entity: 'ai_settings',
    entityId: 'global',
    detail: { model: next.model, timeoutMs: next.timeout_ms, enabled: Boolean(next.enabled), dailyBudgetUsd: next.daily_budget_usd, monthlyBudgetUsd: next.monthly_budget_usd, baseUrl: next.base_url },
    at: Date.now(),
  });
  return publicAiSettings(db, cfg);
}

export function saveAiCredential(db: Db, cfg: AppConfig, apiKey: string, actorId: string) {
  const key = apiKey.trim();
  if (key.length < 8 || key.length > 300) throw new AppError(400, 'AI_KEY_INVALID', 'API Key 长度不合法');
  const enc = encryptSecretWithPurpose(key, cfg, 'ai-api-key');
  const current = getRow(db) ?? defaultRow(cfg);
  transaction(db, () => {
    run(
      db,
      `INSERT INTO ai_settings(id, provider, base_url, api_key_enc, credential_revoked, model, timeout_ms, enabled, daily_budget_usd, monthly_budget_usd,
        last_success_at, last_test_at, last_test_status, last_test_error, last_test_latency_ms, last_test_model, updated_by, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET api_key_enc=excluded.api_key_enc, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [current.id, 'deepseek', current.base_url, enc, 0, current.model, current.timeout_ms, current.enabled, current.daily_budget_usd, current.monthly_budget_usd,
        current.last_success_at, current.last_test_at, current.last_test_status, current.last_test_error, current.last_test_latency_ms, current.last_test_model, actorId, Date.now()],
    );
  });
  audit(db, { storeId: null, actorId, actorRole: 'admin', action: 'ai.credential.update', entity: 'ai_settings', entityId: 'global', detail: { configured: true }, at: Date.now() });
  return publicAiSettings(db, cfg);
}

export function revokeAiCredential(db: Db, cfg: AppConfig, actorId: string) {
  const current = getRow(db) ?? defaultRow(cfg);
  run(
    db,
    `INSERT INTO ai_settings(id, provider, base_url, api_key_enc, credential_revoked, model, timeout_ms, enabled, daily_budget_usd, monthly_budget_usd,
      last_success_at, last_test_at, last_test_status, last_test_error, last_test_latency_ms, last_test_model, updated_by, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET api_key_enc=NULL, credential_revoked=1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [current.id, 'deepseek', current.base_url, current.api_key_enc, 1, current.model, current.timeout_ms, current.enabled, current.daily_budget_usd, current.monthly_budget_usd,
      current.last_success_at, current.last_test_at, current.last_test_status, current.last_test_error, current.last_test_latency_ms, current.last_test_model, actorId, Date.now()],
  );
  audit(db, { storeId: null, actorId, actorRole: 'admin', action: 'ai.credential.revoke', entity: 'ai_settings', entityId: 'global', detail: { configured: false }, at: Date.now() });
  return { ...publicAiSettings(db, cfg), previousDatabaseKeyRemoved: Boolean(current.api_key_enc) };
}

export function recordAiTestResult(db: Db, cfg: AppConfig, result: { status: string; error?: string; latencyMs?: number; model?: string; successAt?: number }) {
  const current = getRow(db) ?? defaultRow(cfg);
  run(
    db,
    `INSERT INTO ai_settings(id, provider, base_url, api_key_enc, credential_revoked, model, timeout_ms, enabled, daily_budget_usd, monthly_budget_usd,
      last_success_at, last_test_at, last_test_status, last_test_error, last_test_latency_ms, last_test_model, updated_by, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_test_at=excluded.last_test_at, last_test_status=excluded.last_test_status,
       last_test_error=excluded.last_test_error, last_test_latency_ms=excluded.last_test_latency_ms, last_test_model=excluded.last_test_model,
       last_success_at=COALESCE(excluded.last_success_at, ai_settings.last_success_at), updated_at=excluded.updated_at`,
    [current.id, 'deepseek', current.base_url, current.api_key_enc, 1, current.model, current.timeout_ms, current.enabled, current.daily_budget_usd, current.monthly_budget_usd,
      result.successAt ?? null, Date.now(), result.status, result.error ?? null, result.latencyMs ?? null, result.model ?? null, null, Date.now()],
  );
}

export function recordAiBusinessSuccess(db: Db, model: string, latencyMs: number): void {
  run(db, "UPDATE ai_settings SET last_success_at = ?, last_test_model = ?, updated_at = ? WHERE id = 'global'", [Date.now(), model, Date.now()]);
}

export function aiUsageSummary(db: Db, storeId: string, cfg: AppConfig) {
  const rows = listAiUsage(db, storeId, 500) as Array<{
    status: string; latencyMs: number; promptTokens: number; completionTokens: number; costUsd: number;
  }>;
  const total = rows.length;
  const successes = rows.filter((r) => r.status === 'ok').length;
  const failures = rows.filter((r) => r.status !== 'ok' && r.status !== 'cache_hit').length;
  const avgLatency = rows.filter((r) => r.latencyMs > 0).length
    ? Math.round(rows.filter((r) => r.latencyMs > 0).reduce((s, r) => s + r.latencyMs, 0) / rows.filter((r) => r.latencyMs > 0).length)
    : null;
  const tokens = rows.reduce((sum, r) => ({ input: sum.input + r.promptTokens, output: sum.output + r.completionTokens }), { input: 0, output: 0 });
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  const pricing = estimateCostUsd(cfg, 0, 0);
  return {
    total,
    successes,
    failures,
    successRate: total ? Math.round((successes / total) * 1000) / 1000 : null,
    averageLatencyMs: avgLatency,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    estimatedCostUsd: Math.round(cost * 1_000_000) / 1_000_000,
    costBasis: pricing.basis,
    pricingUpdatedAt: cfg.deepseek.priceUpdatedAt || null,
    lastFailure: rows.find((r) => r.status !== 'ok' && r.status !== 'cache_hit') ?? null,
    budget: aiBudgetStatus(db, storeId, cfg),
    recent: rows.slice(0, 20),
  };
}
