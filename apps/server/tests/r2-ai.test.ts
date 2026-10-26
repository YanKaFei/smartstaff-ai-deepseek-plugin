import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp } from './helpers.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig } from '../src/domain/stores.js';
import { storeNow, setClock } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';

const analysis = {
  summary: '当前人力偏紧，建议按方案补员。',
  riskLevel: 'high',
  bottleneckExplanation: '高峰时段服务工作量超过在岗产能。',
  slotNotes: [{ slotIndex: 0, note: '优先补充高峰时段。' }],
  cautions: ['客流突变时重新预测。'],
};
const usage = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 };

test('R2 AI: real-path usage, latency, cost, cache and budget are recorded (mock upstream; not real acceptance)', async () => {
  const app = await freshApp({
    deepseek: {
      apiKey: 'test-key',
      baseUrl: 'http://mock.local',
      model: 'deepseek-flash',
      timeoutMs: 1000,
      dailyBudgetUsd: 5,
      monthlyBudgetUsd: 80,
      inputPricePerMTok: 1000,
      outputPricePerMTok: 1000,
      cacheTtlMinutes: 30,
    },
  });
  try {
    const store = getStore(app.db, app.storeId);
    const config = parseConfig(store);
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const first = await generateForecast(app.db, app.storeId, app.cfg, { useAi: true, now, fetchImpl });
    assert.equal(first.aiStatus, 'ok');
    assert.equal(first.aiCached, false);
    assert.equal(calls, 1);
    const row = get<{
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_usd: number;
      cost_basis: string;
      status: string;
      latency_ms: number;
      cache_hit: number;
    }>(app.db, 'SELECT * FROM ai_usage WHERE forecast_id = ?', [first.id])!;
    assert.equal(row.prompt_tokens, 1200);
    assert.equal(row.completion_tokens, 300);
    assert.equal(row.total_tokens, 1500);
    assert.equal(row.status, 'ok');
    assert.equal(row.cost_basis, 'configured_estimate');
    assert.ok(row.cost_usd > 0);
    assert.ok(row.latency_ms >= 0);
    assert.equal(row.cache_hit, 0);

    const second = await generateForecast(app.db, app.storeId, app.cfg, { useAi: true, now, fetchImpl });
    assert.equal(second.aiStatus, 'ok');
    assert.equal(second.aiCached, true);
    assert.equal(calls, 1, 'cache hit must not call the provider');
    const cacheRow = get<{ status: string; cache_hit: number; total_tokens: number }>(
      app.db,
      'SELECT status, cache_hit, total_tokens FROM ai_usage WHERE forecast_id = ?',
      [second.id],
    )!;
    assert.equal(cacheRow.status, 'cache_hit');
    assert.equal(cacheRow.cache_hit, 1);
    assert.equal(cacheRow.total_tokens, 0);

    app.cfg.deepseek.dailyBudgetUsd = 0.0001;
    const now2 = now + 31 * 60_000;
    setClock(app.db, app.storeId, { at: now2 });
    const third = await generateForecast(app.db, app.storeId, app.cfg, { useAi: true, now: now2, fetchImpl });
    assert.equal(third.aiStatus, 'fallback');
    assert.equal(third.aiError, 'AI_BUDGET_EXCEEDED');
    assert.equal(calls, 1, 'budget block must not call the provider');
    const blocked = get<{ status: string; error_code: string }>(
      app.db,
      'SELECT status, error_code FROM ai_usage WHERE forecast_id = ?',
      [third.id],
    )!;
    assert.equal(blocked.status, 'budget_blocked');
    assert.equal(blocked.error_code, 'AI_BUDGET_EXCEEDED');
    assert.ok(config.staffing.capacityModel);
  } finally {
    await app.close();
  }
});

test('R2 AI: provider errors are logged as codes and deterministic fallback is still usable', async () => {
  const app = await freshApp({
    deepseek: {
      apiKey: 'test-key',
      baseUrl: 'http://mock.local',
      model: 'deepseek-flash',
      timeoutMs: 1000,
      dailyBudgetUsd: 5,
      monthlyBudgetUsd: 80,
      inputPricePerMTok: 0,
      outputPricePerMTok: 0,
      cacheTtlMinutes: 30,
    },
  });
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const leakyFetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'api key sk-secret-tail invalid request_id req-123' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const forecast = await generateForecast(app.db, app.storeId, app.cfg, { useAi: true, now, fetchImpl: leakyFetch });
    assert.equal(forecast.aiStatus, 'fallback');
    assert.equal(forecast.aiError, 'AI_AUTH_FAILED');
    assert.ok(!JSON.stringify(forecast).includes('sk-secret-tail'));
    assert.ok(!JSON.stringify(forecast).includes('req-123'));
    const usageRow = get<{ status: string; error_code: string }>(app.db, 'SELECT status, error_code FROM ai_usage WHERE forecast_id = ?', [forecast.id])!;
    assert.equal(usageRow.status, 'fallback');
    assert.equal(usageRow.error_code, 'AI_AUTH_FAILED');
  } finally {
    await app.close();
  }
});
