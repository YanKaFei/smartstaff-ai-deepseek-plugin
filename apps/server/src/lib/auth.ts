import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { get, run } from './db.js';
import { id, sha256, token } from './ids.js';
import { config, type AppConfig } from '../config.js';
import { forbidden, unauthorized } from './errors.js';

export interface AuthContext {
  userId: string;
  role: 'manager' | 'staff' | 'admin';
  storeId: string | null;
  name: string;
  sessionId: string;
  lastAuthAt: number;
  accessExpiresAt: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  /** Backward-compatible alias for the access token. */
  token: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function createTokens(cfg: AppConfig): { access: string; refresh: string; accessExp: number; refreshExp: number } {
  const now = Date.now();
  return {
    access: token(),
    refresh: token(),
    accessExp: now + cfg.auth.accessTtlMinutes * 60_000,
    refreshExp: now + cfg.auth.refreshTtlDays * 86_400_000,
  };
}

export function createSession(
  db: Db,
  user: { id: string; role: 'manager' | 'staff' | 'admin' },
  storeId: string | null,
  cfg: AppConfig = config,
  options: { lastAuthAt?: number } = {},
): SessionTokens {
  const t = createTokens(cfg);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions(token_hash, user_id, role, store_id, expires_at, refresh_token_hash, access_expires_at, refresh_expires_at, last_auth_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    sha256(t.access),
    user.id,
    user.role,
    storeId,
    t.accessExp,
    sha256(t.refresh),
    t.accessExp,
    t.refreshExp,
    options.lastAuthAt ?? now,
    now,
  );
  return {
    accessToken: t.access,
    refreshToken: t.refresh,
    accessExpiresAt: t.accessExp,
    refreshExpiresAt: t.refreshExp,
    token: t.access,
  };
}

export function resolveSession(
  db: Db,
  rawToken: string | undefined,
  cfg: AppConfig = config,
): AuthContext {
  if (!rawToken) throw unauthorized();
  const row = get<{
    token_hash: string;
    user_id: string;
    role: 'manager' | 'staff' | 'admin';
    store_id: string | null;
    expires_at: number;
    access_expires_at: number | null;
    last_auth_at: number | null;
    created_at: number;
    name: string;
  }>(
    db,
    `SELECT s.token_hash, s.user_id, s.role, COALESCE(s.store_id, u.store_id) AS store_id,
            s.expires_at, s.access_expires_at, s.last_auth_at, s.created_at, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [sha256(rawToken)],
  );
  const expiresAt = row?.access_expires_at ?? row?.expires_at ?? 0;
  // Do NOT delete the row here: the refresh token must remain usable after the
  // short-lived access token expires. Cleanup is handled by refresh/logout.
  if (!row || expiresAt < Date.now()) {
    throw unauthorized('登录已过期，请重新登录');
  }
  return {
    userId: row.user_id,
    role: row.role,
    storeId: row.store_id,
    name: row.name,
    sessionId: row.token_hash,
    lastAuthAt: row.last_auth_at ?? row.created_at,
    accessExpiresAt: expiresAt,
  };
}

export function refreshSession(
  db: Db,
  rawRefreshToken: string | undefined,
  cfg: AppConfig = config,
): { tokens: SessionTokens; user: { id: string; role: 'manager' | 'staff' | 'admin'; name: string; storeId: string | null } } {
  if (!rawRefreshToken) throw unauthorized('缺少刷新凭证');
  const row = get<{
    token_hash: string;
    user_id: string;
    role: 'manager' | 'staff' | 'admin';
    store_id: string | null;
    refresh_expires_at: number | null;
    name: string;
  }>(
    db,
    `SELECT s.token_hash, s.user_id, s.role, COALESCE(s.store_id, u.store_id) AS store_id,
            s.refresh_expires_at, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?`,
    [sha256(rawRefreshToken)],
  );
  if (!row || !row.refresh_expires_at || row.refresh_expires_at < Date.now()) {
    throw unauthorized('刷新凭证已过期，请重新登录');
  }
  const t = createTokens(cfg);
  const updated = db
    .prepare(
      `UPDATE sessions SET token_hash = ?, expires_at = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?
        WHERE token_hash = ?`,
    )
    .run(
      sha256(t.access),
      t.accessExp,
      sha256(t.refresh),
      t.accessExp,
      t.refreshExp,
      row.token_hash,
    );
  if (Number(updated.changes) !== 1) throw unauthorized('刷新凭证已被使用');
  return {
    tokens: {
      accessToken: t.access,
      refreshToken: t.refresh,
      accessExpiresAt: t.accessExp,
      refreshExpiresAt: t.refreshExp,
      token: t.access,
    },
    user: { id: row.user_id, role: row.role, name: row.name, storeId: row.store_id },
  };
}

export function revokeSession(db: Db, rawToken: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(rawToken));
}

export function revokeByRefreshToken(db: Db, rawRefreshToken: string): void {
  db.prepare('DELETE FROM sessions WHERE refresh_token_hash = ?').run(sha256(rawRefreshToken));
}

export function revokeAllSessions(db: Db, userId: string): number {
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
}

/** Sensitive operations require a recent interactive login, not just a refresh token. */
export function requireRecentAuth(auth: AuthContext, cfg: AppConfig = config): void {
  const age = Date.now() - auth.lastAuthAt;
  if (age > cfg.auth.sensitiveReauthMinutes * 60_000) {
    throw forbidden('敏感操作需要重新登录验证');
  }
}

export function ensureAdmin(db: Db, password: string): void {
  const existing = get<{ id: string }>(db, "SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return;
  db.prepare(
    'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(id('usr'), 'admin', '平台管理员', null, hashPassword(password), null, null, 1, Date.now());
}

/** Refuse to boot production with a known/demo admin password left in the database. */
export function assertAdminPasswordSafety(db: Db, cfg: AppConfig): void {
  if (!cfg.isProduction) return;
  const admin = get<{ password_hash: string | null }>(db, "SELECT password_hash FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) return;
  // Reconstruct weak variants instead of embedding a literal credential in the bundle.
  const bases = ['admin', 'password', '123456'];
  const suffixes = ['', '123', '!'];
  for (const base of bases) {
    for (const suffix of suffixes) {
      if (verifyPassword(base + suffix, admin.password_hash)) {
        throw new Error('Known demo administrator password detected. Change the admin password before production.');
      }
    }
  }
}

export function updateAdminPassword(db: Db, password: string): void {
  const admin = get<{ id: string }>(db, "SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    ensureAdmin(db, password);
    return;
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), admin.id);
  revokeAllSessions(db, admin.id);
}

/** Validate manager code and return store id. Kept for demo + claim lookup. */
export function findStoreByCode(db: Db, code: string): { id: string; name: string } | undefined {
  return get<{ id: string; name: string }>(db, 'SELECT id, name FROM stores WHERE manager_code = ?', [
    code.trim().toUpperCase(),
  ]);
}

function requestHostname(req: { headers: { host?: string } }): string {
  const raw = req.headers.host ?? '';
  return raw.split(':')[0].toLowerCase();
}

function remoteAddress(req: { socket?: { remoteAddress?: string | null } }): string {
  return (req.socket?.remoteAddress ?? '').replace('::ffff:', '');
}

/**
 * Demo login is a development-only convenience. It is disabled by default,
 * rejected in production, and limited to loopback hosts.
 */
export function demoLoginAvailability(
  req: { headers: { host?: string }; socket?: { remoteAddress?: string | null } },
  cfg: AppConfig,
): { allowed: boolean; reason?: string } {
  if (cfg.isProduction) return { allowed: false, reason: '生产环境禁用模拟登录' };
  if (!cfg.auth.demoLoginEnabled) return { allowed: false, reason: '模拟登录未启用（ALLOW_DEMO_LOGIN）' };
  const host = requestHostname(req);
  if (!cfg.auth.demoHosts.includes(host)) return { allowed: false, reason: '非本机演示域名' };
  const remote = remoteAddress(req);
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === 'localhost' || remote === '';
  if (!loopback) return { allowed: false, reason: '非本机请求' };
  return { allowed: true };
}

export function assertDemoLoginAllowed(
  req: { headers: { host?: string }; socket?: { remoteAddress?: string | null } },
  cfg: AppConfig,
): void {
  const availability = demoLoginAvailability(req, cfg);
  if (!availability.allowed) {
    throw forbidden(`演示登录不可用：${availability.reason ?? '已禁用'}`);
  }
}
