process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForecast, deterministicAnalysis, aiAnalysisSchema } from '../src/ai/deepseek.js';
import { computeCapacityForecast } from '../src/domain/capacity.js';
import { DEFAULT_STORE_CONFIG } from '../src/domain/types.js';
import { makeConfig } from '../src/config.js';
import { epochFromLocal, localParts } from '../src/lib/time.js';

const dateKey = localParts(Date.now()).dateKey;
const now = epochFromLocal(dateKey, 18 * 60);
const config = {
  ...DEFAULT_STORE_CONFIG,
  basic: { ...DEFAULT_STORE_CONFIG.basic, name: '测试烤肉店' },
  tables: {
    ...DEFAULT_STORE_CONFIG.tables,
    small: { ...DEFAULT_STORE_CONFIG.tables.small, count: 8 },
    medium: { ...DEFAULT_STORE_CONFIG.tables.medium, count: 12 },
    large: { ...DEFAULT_STORE_CONFIG.tables.large, count: 4 },
  },
  staffing: { ...DEFAULT_STORE_CONFIG.staffing, onDutyCount: 3, tablesPerStaff: 5 },
};
const tables = [
  ...Array.from({ length: 8 }, () => ({ type: 'small' as const, status: 'dining' as const, seatedAt: now - 10 * 60_000, statusUpdatedAt: now - 10 * 60_000 })),
  ...Array.from({ length: 12 }, () => ({ type: 'medium' as const, status: 'dining' as const, seatedAt: now - 10 * 60_000, statusUpdatedAt: now - 10 * 60_000 })),
  ...Array.from({ length: 4 }, () => ({ type: 'large' as const, status: 'dining' as const, seatedAt: now - 10 * 60_000, statusUpdatedAt: now - 10 * 60_000 })),
];
const forecast = computeCapacityForecast({
  now,
  config,
  onDutyStaff: 3,
  tables,
  queue: Array.from({ length: 14 }, () => ({ partySize: 4, desiredType: 'small' as const, status: 'queued' as const })),
  recentSeatedAt: [],
  historySeatedAt: [],
  historyDays: 0,
  source: 'simulator',
});
const aiCfg = makeConfig({
  deepseek: { apiKey: 'test-key', baseUrl: 'http://mock.local', model: 'deepseek-flash', timeoutMs: 1000 },
});

function mockResponse(payload: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function validAiPayload() {
  return {
    summary: '测试店未来三小时人力偏紧，建议补员。',
    riskLevel: 'high',
    bottleneckExplanation: '服务工作量超过在岗人数产能。',
    slotNotes: [{ slotIndex: 0, note: '高峰时段需要优先补员。' }],
    cautions: ['客流突变时请重新预测。'],
  };
}

test('ai: deterministic analysis always works without an API key', async () => {
  const result = await analyzeForecast(forecast, config, makeConfig({ deepseek: { apiKey: '', baseUrl: '', model: 'deepseek-flash', timeoutMs: 100 } }));
  assert.equal(result.status, 'fallback');
  assert.ok(result.analysis.summary.includes('缺口'));
  assert.ok(result.analysis.recommendations.length > 0);
  assert.equal(result.analysis.recommendations[0].headcount, forecast.gapRanges[0].headcount);
  const direct = deterministicAnalysis(forecast, config);
  assert.equal(direct.riskLevel, 'high');
});

test('ai: valid DeepSeek JSON is accepted but headcount and times stay engine-owned', async () => {
  const malicious = {
    ...validAiPayload(),
    recommendations: [{ slotIndex: 0, startAt: 0, endAt: 0, headcount: 99, reason: 'AI 自行加人' }],
  };
  const result = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: ((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.response_format.type, 'json_object');
      assert.ok(String(body.messages[0].content).includes('slotIndex'));
      return mockResponse({ choices: [{ message: { content: JSON.stringify(malicious) } }] });
    }) as typeof fetch,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.analysis.summary, validAiPayload().summary);
  assert.equal(result.analysis.recommendations[0].headcount, forecast.gapRanges[0].headcount);
  assert.equal(result.analysis.recommendations[0].startAt, forecast.gapRanges[0].startAt);
  assert.notEqual(result.analysis.recommendations[0].headcount, 99);
});

test('ai: malformed JSON, missing fields and HTTP errors degrade deterministically', async () => {
  const malformed = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: (() => mockResponse({ choices: [{ message: { content: '{"summary":"too short"}' } }] })) as typeof fetch,
  });
  assert.equal(malformed.status, 'fallback');
  assert.ok(malformed.error);

  const invalidJson = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: (() => mockResponse({ choices: [{ message: { content: 'not json' } }] })) as typeof fetch,
  });
  assert.equal(invalidJson.status, 'fallback');

  const serverError = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: (() => mockResponse({ error: 'boom' }, 500)) as typeof fetch,
  });
  assert.equal(serverError.status, 'fallback');

  // Upstream errors must be redacted: no key suffix or provider request id may reach the client.
  const leaky = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: (() =>
      mockResponse({ error: { message: 'Authentication Fails, Your api key: sk-secret-tail is invalid', request_id: 'req-leak' } }, 401)) as typeof fetch,
  });
  assert.equal(leaky.status, 'fallback');
  assert.equal(leaky.error, 'AI_AUTH_FAILED');
  assert.ok(!String(leaky.error).includes('sk-'));
  assert.ok(!String(leaky.error).includes('req-leak'));

  const networkError = await analyzeForecast(forecast, config, aiCfg, {
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
  });
  assert.equal(networkError.status, 'fallback');
  assert.ok(networkError.analysis.recommendations.length >= 1);
});

test('ai: schema rejects invented numeric ranges', () => {
  assert.throws(() => aiAnalysisSchema.parse({ ...validAiPayload(), slotNotes: [{ slotIndex: 9, note: 'x' }] }));
  assert.throws(() => aiAnalysisSchema.parse({ ...validAiPayload(), riskLevel: 'critical' }));
});
