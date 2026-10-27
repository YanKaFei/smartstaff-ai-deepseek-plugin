import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { isStrongPassword } from '../config.js';
import { all, get, run } from '../lib/db.js';
import { AppError, conflict, unauthorized } from '../lib/errors.js';
import { createSession, hashPassword, revokeAllSessions, verifyPassword, type SessionTokens } from '../lib/auth.js';
import { id, sha256 } from '../lib/ids.js';
import { audit } from './notify.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL = 30 * 60_000;

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
  role: 'manager' | 'staff' | 'admin';
  emailVerified: boolean;
  status: string;
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!EMAIL_RE.test(value) || value.length > 200) throw new AppError(400, 'EMAIL_INVALID', '邮箱格式不正确');
  return value;
}

function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
  return base;
}

function uniqueSlug(db: Db, name: string): string {
  const base = slugFor(name);
  let slug = base;
  let i = 2;
  while (get(db, 'SELECT id FROM organizations WHERE slug = ?', [slug])) slug = `${base}-${i++}`;
  return slug;
}

function issueToken(db: Db, userId: string, type: 'email_verify' | 'password_reset', now: number): string {
  const raw = id('tok');
  run(db, 'INSERT INTO account_tokens(id, user_id, type, token_hash, expires_at, created_at) VALUES(?,?,?,?,?,?)', [
    id('atk'), userId, type, sha256(raw), now + TOKEN_TTL, now,
  ]);
  return raw;
}

function publicUser(user: { id: string; name: string; email: string | null; role: string; email_verified: number; status: string }): AccountUser {
  return {
    id: user.id, name: user.name, email: user.email, role: user.role as AccountUser['role'],
    emailVerified: Boolean(user.email_verified), status: user.status,
  };
}

export function registerAccount(
  db: Db,
  cfg: AppConfig,
  input: { email: string; password: string; name: string; organizationName: string },
  now = Date.now(),
) {
  const email = normalizeEmail(input.email);
  if (!isStrongPassword(input.password)) throw new AppError(400, 'PASSWORD_WEAK', '密码至少 12 位，且包含大小写、数字和符号');
  if (get(db, 'SELECT id FROM users WHERE email = ?', [email])) throw conflict('该邮箱已注册');
  const orgName = input.organizationName.trim().slice(0, 60);
  if (!orgName) throw new AppError(400, 'ORG_NAME_REQUIRED', '请填写组织名称');
  const userId = id('usr');
  const orgId = id('org');
  const orgSlug = uniqueSlug(db, orgName);
  run(db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, email, email_verified, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [
    userId, 'manager', input.name.trim().slice(0, 30) || '负责人', null, hashPassword(input.password), null, null, 0, email, 0, 'active', now,
  ]);
  run(db, 'INSERT INTO organizations(id, name, slug, plan, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [orgId, orgName, orgSlug, 'starter', 'active', now, now]);
  run(db, 'INSERT INTO memberships(id, organization_id, user_id, role, store_id, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', [id('mem'), orgId, userId, 'owner', null, 'active', now, now]);
  const token = issueToken(db, userId, 'email_verify', now);
  audit(db, { storeId: null, actorId: userId, actorRole: 'manager', action: 'account.register', entity: 'organization', entityId: orgId, detail: { email }, at: now });
  return {
    user: publicUser(get<{ id: string; name: string; email: string; role: string; email_verified: number; status: string }>(db, 'SELECT id, name, email, role, email_verified, status FROM users WHERE id = ?', [userId])!),
    organization: { id: orgId, name: orgName, slug: orgSlug },
    emailVerified: false,
    emailDelivery: 'NOT_CONFIGURED',
    verificationToken: cfg.nodeEnv === 'production' ? undefined : token,
    message: '账户已创建。验证邮箱后才能登录；当前未配置邮件服务，开发环境返回验证 token。',
  };
}

export function verifyEmail(db: Db, token: string, now = Date.now()) {
  const row = get<{ id: string; user_id: string; expires_at: number; used_at: number | null }>(db, "SELECT * FROM account_tokens WHERE token_hash = ? AND type = 'email_verify'", [sha256(token)]);
  if (!row || row.used_at || row.expires_at < now) throw new AppError(400, 'TOKEN_INVALID', '验证链接无效或已过期');
  run(db, 'UPDATE account_tokens SET used_at = ? WHERE id = ?', [now, row.id]);
  run(db, 'UPDATE users SET email_verified = 1 WHERE id = ?', [row.user_id]);
  audit(db, { storeId: null, actorId: row.user_id, actorRole: 'manager', action: 'account.email_verify', entity: 'user', entityId: row.user_id, detail: {}, at: now });
  return { verified: true };
}

export function emailLogin(db: Db, cfg: AppConfig, emailInput: string, password: string, now = Date.now()) {
  const email = normalizeEmail(emailInput);
  const user = get<{ id: string; name: string; email: string | null; role: 'manager' | 'staff' | 'admin'; password_hash: string | null; email_verified: number; status: string }>(db, 'SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) throw unauthorized('邮箱或密码错误');
  if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_SUSPENDED', '账户已停用');
  if (!user.email_verified) throw new AppError(403, 'EMAIL_NOT_VERIFIED', '请先验证邮箱');
  const memberships = all<{ organization_id: string; role: string; store_id: string | null; status: string }>(db, 'SELECT organization_id, role, store_id, status FROM memberships WHERE user_id = ? AND status = ?', [user.id, 'active']);
  if (!memberships.length) throw new AppError(403, 'NO_ACTIVE_MEMBERSHIP', '该账户没有可用的组织成员身份');
  const membership = memberships[0];
  const tokens = createSession(db, { id: user.id, role: user.role }, membership.store_id, cfg);
  audit(db, { storeId: membership.store_id, actorId: user.id, actorRole: user.role, action: 'account.login', entity: 'user', entityId: user.id, detail: { organizationId: membership.organization_id }, at: now });
  return {
    ...tokens,
    token: tokens.accessToken,
    user: publicUser(user),
    organizationId: membership.organization_id,
    membershipRole: membership.role,
    storeId: membership.store_id,
  };
}

export function forgotPassword(db: Db, cfg: AppConfig, emailInput: string, now = Date.now()) {
  const email = normalizeEmail(emailInput);
  const user = get<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', [email]);
  let token: string | undefined;
  if (user) token = issueToken(db, user.id, 'password_reset', now);
  return {
    accepted: true,
    message: '如果该邮箱存在，重置链接已发送。',
    emailDelivery: 'NOT_CONFIGURED',
    resetToken: cfg.nodeEnv === 'production' || !token ? undefined : token,
  };
}

export function resetPassword(db: Db, token: string, password: string, now = Date.now()) {
  if (!isStrongPassword(password)) throw new AppError(400, 'PASSWORD_WEAK', '密码至少 12 位，且包含大小写、数字和符号');
  const row = get<{ id: string; user_id: string; expires_at: number; used_at: number | null }>(db, "SELECT * FROM account_tokens WHERE token_hash = ? AND type = 'password_reset'", [sha256(token)]);
  if (!row || row.used_at || row.expires_at < now) throw new AppError(400, 'TOKEN_INVALID', '重置链接无效或已过期');
  run(db, 'UPDATE account_tokens SET used_at = ? WHERE id = ?', [now, row.id]);
  run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), row.user_id]);
  revokeAllSessions(db, row.user_id);
  audit(db, { storeId: null, actorId: row.user_id, actorRole: 'manager', action: 'account.password_reset', entity: 'user', entityId: row.user_id, detail: {}, at: now });
  return { reset: true };
}

export function accountMe(db: Db, userId: string) {
  const user = get<{ id: string; name: string; email: string | null; role: string; email_verified: number; status: string }>(db, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
  const memberships = all<{ id: string; organization_id: string; role: string; store_id: string | null; status: string; org_name: string; org_slug: string }>(
    db,
    `SELECT m.id, m.organization_id, m.role, m.store_id, m.status, o.name AS org_name, o.slug AS org_slug
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? ORDER BY m.created_at`,
    [userId],
  );
  return {
    user: publicUser(user),
    memberships: memberships.map((m) => ({
      id: m.id, organizationId: m.organization_id, organizationName: m.org_name, organizationSlug: m.org_slug,
      role: m.role, storeId: m.store_id, status: m.status,
    })),
  };
}

export function resendVerification(db: Db, cfg: AppConfig, emailInput: string, now = Date.now()) {
  const email = normalizeEmail(emailInput);
  const user = get<{ id: string; email_verified: number }>(db, 'SELECT id, email_verified FROM users WHERE email = ?', [email]);
  if (!user || user.email_verified) return { accepted: true, verificationToken: undefined, emailDelivery: 'NOT_CONFIGURED' };
  return { accepted: true, verificationToken: cfg.nodeEnv === 'production' ? undefined : issueToken(db, user.id, 'email_verify', now), emailDelivery: 'NOT_CONFIGURED' };
}
