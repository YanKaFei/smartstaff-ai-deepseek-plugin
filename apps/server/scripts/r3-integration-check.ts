import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeConfig, serverRoot } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { seedDemo } from '../src/seed.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig } from '../src/domain/stores.js';
import { setClock } from '../src/domain/clock.js';
import { analyzeForecast } from '../src/ai/deepseek.js';
import { estimateCostUsd } from '../src/domain/aiUsage.js';
import { code2Session } from '../src/lib/wechat.js';
import { listPosAdapters } from '../src/domain/adapters/pos.js';

const cfg = makeConfig({ nodeEnv: process.env.NODE_ENV ?? 'test' });
const result: Record<string, unknown> = { checkedAt: new Date().toISOString(), secretsPrinted: false, modules: {} };
const modules = result.modules as Record<string, unknown>;

// DeepSeek: real request only when a non-placeholder key is present.
if (!cfg.deepseek.apiKey) {
  modules.deepseek = { status: 'BLOCKED', reason: 'DEEPSEEK_API_KEY not configured', realSuccessVerified: false };
} else {
  const handle = openDatabase(':memory:');
  try {
    const seeded = seedDemo(handle.db, cfg);
    setClock(handle.db, seeded.storeId, { at: seeded.simNow });
    const store = getStore(handle.db, seeded.storeId);
    const config = parseConfig(store);
    const forecast = await generateForecast(handle.db, seeded.storeId, cfg, { useAi: false, now: seeded.simNow });
    const started = performance.now();
    const ai = await analyzeForecast(forecast, config, cfg);
    const latencyMs = Math.round(performance.now() - started);
    const schemaOk = Boolean(ai.analysis?.summary && ai.analysis?.slotNotes && ai.analysis?.cautions);
    const cost = estimateCostUsd(cfg, ai.usage?.promptTokens ?? 0, ai.usage?.completionTokens ?? 0);
    modules.deepseek = {
      status: ai.status === 'ok' && schemaOk && (ai.usage?.totalTokens ?? 0) > 0 ? 'REAL_VERIFIED' : 'FAILED',
      httpStatus: ai.status === 'ok' ? 200 : null,
      errorCode: ai.error ?? null,
      latencyMs: ai.latencyMs ?? latencyMs,
      usage: ai.usage ?? null,
      estimatedCostUsd: cost.cost,
      costBasis: cost.basis,
      schemaOk,
      note: 'Cost is calculated from configured price estimates and the returned token usage.',
    };
  } finally {
    handle.close();
  }
}

// WeChat: config presence + real endpoint reachability without a valid login code.
if (!cfg.wechat.appId || !cfg.wechat.appSecret) {
  modules.wechat = { status: 'BLOCKED', reason: 'WECHAT_APPID/WECHAT_SECRET not configured', realLoginVerified: false };
} else {
  const started = performance.now();
  try {
    await code2Session('r3-probe-invalid-code', cfg);
    modules.wechat = { status: 'BLOCKED', reason: 'unexpected success for invalid probe code', realLoginVerified: false };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'WECHAT_UNKNOWN';
    modules.wechat = {
      status: 'BLOCKED',
      reason: `endpoint reachable/auth path returned ${code}; a valid wx.login code and AppID review are still required`,
      errorCode: code,
      latencyMs: Math.round(performance.now() - started),
      realLoginVerified: false,
    };
  }
}

modules.sms = cfg.sms.provider && cfg.sms.apiKey
  ? { status: 'BLOCKED', reason: 'SMS provider present but no provider adapter is implemented/verified', realSendVerified: false }
  : { status: 'BLOCKED', reason: 'SMS_PROVIDER/SMS_API_KEY not configured', realSendVerified: false };

modules.pos = {
  status: 'BLOCKED',
  reason: 'No vendor API documentation/credentials; generic HMAC adapter contract and contract tests only',
  adapters: listPosAdapters(),
  realVendorVerified: false,
};
modules.storeIngress = {
  status: 'MOCK_VERIFIED',
  reason: 'Generic signed webhook/manual/simulator paths covered by automated tests; no real POS delivery',
  realVendorVerified: false,
};

const outDir = path.join(serverRoot, '..', '..', 'docs', 'r3-evidence');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'integration-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
