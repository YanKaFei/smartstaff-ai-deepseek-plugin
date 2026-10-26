/**
 * R2 real DeepSeek check. Does NOT use a mock.
 * Without a valid key the only honest result is: request attempted, auth
 * rejected, model JSON/token/cost unverified.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig } from '../src/domain/stores.js';
import { setClock } from '../src/domain/clock.js';
import { analyzeForecast } from '../src/ai/deepseek.js';

const cfg = makeConfig({
  nodeEnv: 'test',
  deepseek: {
    apiKey: 'r2-invalid-placeholder-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    timeoutMs: 12000,
  },
});
const handle = openDatabase(':memory:');
const seeded = seedDemo(handle.db, cfg);
setClock(handle.db, seeded.storeId, { at: seeded.simNow });
const store = getStore(handle.db, seeded.storeId);
const config = parseConfig(store);
const forecast = await generateForecast(handle.db, seeded.storeId, cfg, { useAi: false, now: seeded.simNow });

const started = performance.now();
const result = await analyzeForecast(forecast, config, cfg);
const latencyMs = Math.round(performance.now() - started);
const noKeyCfg = makeConfig({
  nodeEnv: 'test',
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 12000 },
});
const noKeyResult = await analyzeForecast(forecast, config, noKeyCfg);

const evidence = {
  checkedAt: new Date().toISOString(),
  hasValidKey: false,
  note:
    'No DEEPSEEK_API_KEY is configured in this environment. A real HTTPS request was sent to the official endpoint ' +
    'with an invalid placeholder key. Authentication was rejected, so model JSON, token usage, latency under real ' +
    'load and cost are NOT verified. Mock-based tests are not counted as real API acceptance.',
  endpoint: 'https://api.deepseek.com/chat/completions',
  requestedModel: 'deepseek-flash',
  responseFormat: 'json_object',
  timeoutMs: 12000,
  realRequest: {
    status: result.status,
    latencyMs,
    errorCode: result.error ?? null,
    returnedAnalysisIsDeterministic: result.status === 'fallback',
    usageReturned: Boolean(result.usage),
  },
  withoutKey: {
    status: noKeyResult.status,
    errorCode: noKeyResult.error ?? null,
  },
  verified: {
    requestAttempted: true,
    authRejected: result.error === 'AI_AUTH_FAILED',
    modelJsonOutput: false,
    tokenUsage: false,
    latencyUnderLoad: false,
    cost: false,
  },
};
const outDir = path.join(serverRoot, '..', '..', 'docs', 'r2-evidence');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'deepseek-real-request.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
