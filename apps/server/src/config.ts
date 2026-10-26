import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');

/** Minimal .env loader so the project runs without dotenv. Existing env vars win. */
function loadDotEnv(): void {
  const file = path.join(serverRoot, '.env');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const env = process.env;
const nodeEnv = env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  nodeEnv,
  isProduction,
  databasePath: env.DATABASE_PATH
    ? path.resolve(env.DATABASE_PATH)
    : path.join(serverRoot, 'data', 'smartstaff.db'),
  adminPassword: env.ADMIN_PASSWORD || '',
  secretEncryptionKey: env.SECRET_ENCRYPTION_KEY ?? '',
  corsOrigins: list(env.CORS_ORIGINS, [
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]),
  requireHttps: env.REQUIRE_HTTPS ? env.REQUIRE_HTTPS === 'true' : isProduction,
  trustProxy: env.TRUST_PROXY === 'true',
  auth: {
    accessTtlMinutes: Number(env.ACCESS_TOKEN_TTL_MINUTES ?? 120),
    refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    sensitiveReauthMinutes: Number(env.SENSITIVE_REAUTH_MINUTES ?? 15),
    /** Dev-only. Must remain false in production; validated at startup. */
    demoLoginEnabled: env.ALLOW_DEMO_LOGIN === 'true',
    demoHosts: list(env.DEMO_LOGIN_HOSTS, ['127.0.0.1', 'localhost', '::1']),
  },
  wechat: {
    appId: env.WECHAT_APPID ?? '',
    appSecret: env.WECHAT_SECRET ?? '',
    code2SessionUrl: env.WECHAT_CODE2SESSION_URL || 'https://api.weixin.qq.com/sns/jscode2session',
    timeoutMs: Number(env.WECHAT_TIMEOUT_MS ?? 5000),
    offerTemplateId: env.WECHAT_OFFER_TEMPLATE_ID ?? '',
  },
  sms: {
    provider: env.SMS_PROVIDER ?? '',
    apiKey: env.SMS_API_KEY ?? '',
  },
  deepseek: {
    apiKey: env.DEEPSEEK_API_KEY ?? '',
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS ?? 12000),
    dailyBudgetUsd: Number(env.DEEPSEEK_DAILY_BUDGET_USD ?? 5),
    monthlyBudgetUsd: Number(env.DEEPSEEK_MONTHLY_BUDGET_USD ?? 80),
    inputPricePerMTok: Number(env.DEEPSEEK_INPUT_PRICE_PER_MTOK ?? 0.27),
    outputPricePerMTok: Number(env.DEEPSEEK_OUTPUT_PRICE_PER_MTOK ?? 1.1),
    cacheTtlMinutes: Number(env.DEEPSEEK_CACHE_TTL_MINUTES ?? 30),
    priceUpdatedAt: env.DEEPSEEK_PRICE_UPDATED_AT ?? '',
  },
  ingestStaleMinutes: Number(env.INGEST_STALE_MINUTES ?? 15),
  rateLimitBackend: (env.RATE_LIMIT_BACKEND === 'memory' ? 'memory' : 'db') as 'memory' | 'db',
  miniappDist: path.resolve(serverRoot, '..', 'miniapp', 'dist', 'build'),
  timezoneOffsetMinutes: 480,
  maxBodyBytes: 1024 * 1024,
};

export type AppConfig = typeof config;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Test/runtime config overrides without mutating frozen values. */
export function makeConfig(overrides: DeepPartial<AppConfig> = {}): AppConfig {
  return {
    ...config,
    ...(overrides as Partial<AppConfig>),
    auth: { ...config.auth, ...(overrides.auth ?? {}) },
    wechat: { ...config.wechat, ...(overrides.wechat ?? {}) },
    sms: { ...config.sms, ...(overrides.sms ?? {}) },
    deepseek: { ...config.deepseek, ...(overrides.deepseek ?? {}) },
  } as AppConfig;
}

export function isStrongPassword(password: string): boolean {
  if (password.length < 12) return false;
  return (
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

/**
 * Fail fast on unsafe production configuration. Called by the server entrypoint;
 * test factories may run with NODE_ENV=test and are not blocked.
 */
export function assertProductionSafety(cfg: AppConfig): void {
  if (!cfg.isProduction) return;
  const problems: string[] = [];
  if (!cfg.adminPassword) problems.push('ADMIN_PASSWORD is required in production');
  else if (!isStrongPassword(cfg.adminPassword)) {
    problems.push('ADMIN_PASSWORD must be at least 12 chars with upper/lower/digit/symbol');
  }
  if (cfg.auth.demoLoginEnabled) problems.push('ALLOW_DEMO_LOGIN must be false in production');
  if (!cfg.requireHttps) problems.push('REQUIRE_HTTPS must be true in production');
  if (!cfg.corsOrigins.length || cfg.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must be an explicit allow-list in production');
  }
  if (!cfg.secretEncryptionKey) problems.push('SECRET_ENCRYPTION_KEY is required in production for webhook secret encryption');
  if (cfg.rateLimitBackend !== 'db') problems.push('RATE_LIMIT_BACKEND must be db in production (shared state)');
  if (!cfg.wechat.appId || !cfg.wechat.appSecret) {
    // Not fatal: the wx endpoint returns 503 and the report marks it blocked.
    // A production store that relies on WeChat login should treat this as a blocker.
  }
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n- ${problems.join('\n- ')}`);
  }
}
