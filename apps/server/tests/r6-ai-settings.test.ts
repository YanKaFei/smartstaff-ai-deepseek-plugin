import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, managerLogin, staffLogin, api, type TestApp } from './helpers.js';
import { makeConfig } from '../src/config.js';
import { probeDeepSeek } from '../src/ai/deepseek.js';
import { generateForecast } from '../src/domain/forecast.js';
import { setClock, storeNow } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';

const validContent = JSON.stringify({
  summary: '连接测试通过，未来三小时人力可覆盖。',
  riskLevel: 'low',
  bottleneckExplanation: '连接测试无瓶颈。',
  slotNotes: [],
  cautions: ['仅用于连接测试。'],
});

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('AI settings: no key is NOT_CONFIGURED and the real test is blocked', async () => {
  const app = await freshApp({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 20000 } });
  try {
    const admin = await adminLogin(app);
    const settings = await api<{ credentialConfigured: boolean; credentialSource: string }>(app.base, 'GET', '/api/admin/ai/settings', undefined, admin);
    assert.equal(settings.status, 200);
    assert.equal(settings.data.credentialConfigured, false);
    assert.equal(settings.data.credentialSource, 'none');
    const status = await api<{ status: string; realApiBlocked: boolean }>(app.base, 'GET', '/api/admin/ai/status', undefined, admin);
    assert.equal(status.data.status, 'NOT_CONFIGURED');
    assert.equal(status.data.realApiBlocked, true);
    const tested = await api(app.base, 'POST', '/api/admin/ai/test', {}, admin);
    assert.equal(tested.status, 400);
    assert.equal(tested.json.error?.code, 'AI_NOT_CONFIGURED');
  } finally {
    await app.close();
  }
});

test('AI settings: key is write-only, encrypted at rest, replaceable and revocable', async () => {
  const app = await freshApp({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 20000 } });
  try {
    const admin = await adminLogin(app);
    const key1 = 'sk-test-one-1234567890';
    const saved = await api<{ credentialConfigured: boolean; apiKey?: string }>(app.base, 'PUT', '/api/admin/ai/credential', { apiKey: key1 }, admin);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.credentialConfigured, true);
    assert.equal(saved.data.apiKey, undefined);
    const rawRow = get<{ api_key_enc: string | null }>(app.db, "SELECT api_key_enc FROM ai_settings WHERE id = 'global'")!;
    assert.ok(rawRow.api_key_enc);
    assert.ok(!rawRow.api_key_enc!.includes(key1));
    const read = await api<Record<string, unknown>>(app.base, 'GET', '/api/admin/ai/settings', undefined, admin);
    assert.ok(!JSON.stringify(read.data).includes(key1));
    assert.equal(read.data.credentialHint, '已配置（服务端加密保存，不可读取）');

    const key2 = 'sk-test-two-1234567890';
    const replaced = await api(app.base, 'PUT', '/api/admin/ai/credential', { apiKey: key2 }, admin);
    assert.equal(replaced.status, 200);
    const replacedRow = get<{ api_key_enc: string | null }>(app.db, "SELECT api_key_enc FROM ai_settings WHERE id = 'global'")!;
    assert.notEqual(replacedRow.api_key_enc, rawRow.api_key_enc);

    const revoked = await api<{ credentialConfigured: boolean; previousDatabaseKeyRemoved: boolean }>(app.base, 'DELETE', '/api/admin/ai/credential', {}, admin);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.credentialConfigured, false);
    assert.equal(revoked.data.previousDatabaseKeyRemoved, true);
    assert.equal(get<{ api_key_enc: string | null }>(app.db, "SELECT api_key_enc FROM ai_settings WHERE id = 'global'")!.api_key_enc, null);

    const actions = app.db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'ai.%' ORDER BY created_at").all() as Array<{ action: string }>;
    assert.ok(actions.some((a) => a.action === 'ai.credential.update'));
    assert.ok(actions.some((a) => a.action === 'ai.credential.revoke'));
  } finally {
    await app.close();
  }
});

test('AI settings: non-admin roles cannot read or mutate configuration', async () => {
  const app = await freshApp();
  try {
    const manager = await managerLogin(app);
    const staff = await staffLogin(app, '13800000001');
    for (const token of [manager, staff]) {
      const read = await api(app.base, 'GET', '/api/admin/ai/settings', undefined, token);
      assert.equal(read.status, 403);
      const write = await api(app.base, 'PUT', '/api/admin/ai/settings', { model: 'deepseek-flash' }, token);
      assert.equal(write.status, 403);
    }
  } finally {
    await app.close();
  }
});

test('AI settings: safe config update is audited and only official base URL is accepted', async () => {
  const app = await freshApp({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 20000 } });
  try {
    const admin = await adminLogin(app);
    const updated = await api<{ model: string; timeoutMs: number; enabled: boolean; dailyBudgetUsd: number }>(app.base, 'PUT', '/api/admin/ai/settings', {
      model: 'deepseek-v4-pro', timeoutMs: 15000, enabled: false, dailyBudgetUsd: 2.5, monthlyBudgetUsd: 20,
    }, admin);
    assert.equal(updated.status, 200);
    assert.equal(updated.data.model, 'deepseek-v4-pro');
    assert.equal(updated.data.timeoutMs, 15000);
    assert.equal(updated.data.enabled, false);
    const bad = await api(app.base, 'PUT', '/api/admin/ai/settings', { baseUrl: 'https://evil.example.com' }, admin);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error?.code, 'AI_BASE_URL_NOT_ALLOWED');
    const auditRow = get<{ action: string }>(app.db, "SELECT action FROM audit_logs WHERE action = 'ai.settings.update' ORDER BY created_at DESC LIMIT 1");
    assert.ok(auditRow);
  } finally {
    await app.close();
  }
});

test('AI settings: disabled switch blocks AI and deterministic forecast still works', async () => {
  const app = await freshApp({ deepseek: { apiKey: 'sk-test-disabled', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 } });
  try {
    const admin = await adminLogin(app);
    await api(app.base, 'PUT', '/api/admin/ai/settings', { enabled: false }, admin);
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    let called = false;
    const f = await generateForecast(app.db, app.storeId, app.cfg, {
      useAi: true,
      now,
      fetchImpl: (async () => { called = true; return mockResponse({}); }) as typeof fetch,
    });
    assert.equal(called, false);
    assert.equal(f.aiStatus, 'fallback');
    assert.equal(f.aiError, 'AI_DISABLED');
    assert.ok(f.peakRequiredStaff > 0);
  } finally {
    await app.close();
  }
});

test('AI probe: real HTTPS success result is accepted only with valid JSON, finish_reason, usage and model', async () => {
  const cfg = makeConfig({ deepseek: { apiKey: 'sk-probe', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 } });
  const result = await probeDeepSeek(cfg, (async () => mockResponse({
    model: 'deepseek-flash-v1', choices: [{ finish_reason: 'stop', message: { content: validContent } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  })) as typeof fetch);
  assert.equal(result.status, 'ok');
  assert.equal(result.model, 'deepseek-flash-v1');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage?.totalTokens, 30);
  assert.ok(result.latencyMs >= 0);
});

test('AI probe: 401, timeout, invalid JSON and schema failures map to stable errors', async () => {
  const cfg = makeConfig({ deepseek: { apiKey: 'sk-probe', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 50 } });
  const auth = await probeDeepSeek(cfg, (async () => mockResponse({ error: { message: 'bad key sk-secret' } }, 401)) as typeof fetch);
  assert.equal(auth.errorCode, 'AI_AUTH_FAILED');
  assert.equal(auth.message, 'API Key 无效或认证失败');
  const timeout = await probeDeepSeek(cfg, (async () => { throw new DOMException('timeout', 'AbortError'); }) as typeof fetch);
  assert.equal(timeout.errorCode, 'AI_TIMEOUT');
  const invalid = await probeDeepSeek(cfg, (async () => mockResponse({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }] })) as typeof fetch);
  assert.equal(invalid.errorCode, 'AI_RESPONSE_INVALID');
  const schema = await probeDeepSeek(cfg, (async () => mockResponse({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'x' }) } }] })) as typeof fetch);
  assert.equal(schema.errorCode, 'AI_RESPONSE_INVALID');
});

test('AI settings: credential can be used by the unified business AI path without exposing it', async () => {
  const app = await freshApp({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 } });
  try {
    const admin = await adminLogin(app);
    const key = 'sk-business-probe-123';
    await api(app.base, 'PUT', '/api/admin/ai/credential', { apiKey: key }, admin);
    await api(app.base, 'PUT', '/api/admin/ai/settings', { model: 'deepseek-flash' }, admin);
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const f = await generateForecast(app.db, app.storeId, app.cfg, {
      useAi: true,
      now,
      fetchImpl: (async () => mockResponse({
        model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { content: validContent } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })) as typeof fetch,
    });
    assert.equal(f.aiStatus, 'ok');
    const usage = get<{ model: string; total_tokens: number; status: string }>(app.db, "SELECT model, total_tokens, status FROM ai_usage WHERE forecast_id = ?", [f.id])!;
    assert.equal(usage.model, 'deepseek-flash');
    assert.equal(usage.total_tokens, 30);
    assert.equal(usage.status, 'ok');
    assert.ok(!JSON.stringify(f).includes(key));
    const settings = await api<Record<string, unknown>>(app.base, 'GET', '/api/admin/ai/settings', undefined, admin);
    assert.ok(!JSON.stringify(settings.data).includes(key));
  } finally {
    await app.close();
  }
});

test('AI usage: aggregate stats and price-update label are exposed without key material', async () => {
  const app = await freshApp({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 20000, inputPricePerMTok: 1, outputPricePerMTok: 2, priceUpdatedAt: '2026-01-15' } });
  try {
    const admin = await adminLogin(app);
    const usage = await api<{ total: number; costBasis: string; pricingUpdatedAt: string | null; budget: { dailyBudgetUsd: number } }>(app.base, 'GET', `/api/admin/ai/usage?storeId=${app.storeId}`, undefined, admin);
    assert.equal(usage.status, 200);
    assert.equal(usage.data.total, 0);
    assert.equal(usage.data.costBasis, 'configured_estimate');
    assert.equal(usage.data.pricingUpdatedAt, '2026-01-15');
    assert.ok(usage.data.budget.dailyBudgetUsd >= 0);
    assert.ok(!JSON.stringify(usage.data).toLowerCase().includes('sk-'));
  } finally {
    await app.close();
  }
});

test('AI settings: revoke also blocks an environment-provided key through a persisted revocation flag', async () => {
  const app = await freshApp({ deepseek: { apiKey: 'sk-env-only-12345', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 1000 } });
  try {
    const admin = await adminLogin(app);
    const before = await api<{ credentialConfigured: boolean; credentialSource: string }>(app.base, 'GET', '/api/admin/ai/settings', undefined, admin);
    assert.equal(before.data.credentialConfigured, true);
    assert.equal(before.data.credentialSource, 'environment');
    const revoked = await api<{ credentialConfigured: boolean; credentialSource: string }>(app.base, 'DELETE', '/api/admin/ai/credential', {}, admin);
    assert.equal(revoked.data.credentialConfigured, false);
    assert.equal(revoked.data.credentialSource, 'none');
  } finally {
    await app.close();
  }
});
