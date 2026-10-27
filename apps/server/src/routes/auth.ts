import { z } from 'zod';
import { route, type RequestContext } from '../lib/http.js';
import { AppError, unauthorized } from '../lib/errors.js';
import {
  assertDemoLoginAllowed,
  createSession,
  demoLoginAvailability,
  ensureAdmin,
  findStoreByCode,
  hashPassword,
  refreshSession,
  requireRecentAuth,
  revokeAllSessions,
  revokeByRefreshToken,
  revokeSession,
  updateAdminPassword,
  verifyPassword,
  type SessionTokens,
} from '../lib/auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { code2Session } from '../lib/wechat.js';
import { issueManagerClaim, consumeManagerClaim } from '../lib/managerClaim.js';
import { isStrongPassword } from '../config.js';
import { accountMe, emailLogin, forgotPassword, registerAccount, resetPassword, verifyEmail } from '../domain/accounts.js';
import { acceptInvitation, createOrgStore, inviteMember, orgOverview, removeMember, revokeInvitation, switchAccountStore, transferOwnership, updateMember } from '../domain/org.js';
import { deliverEmail, invitationEmail, queueEmail, resetEmail, verificationEmail } from '../domain/email.js';
import { all, get, run } from '../lib/db.js';
import { id, sha256 } from '../lib/ids.js';
import { createStore, getStore, serializeStore } from '../domain/stores.js';
import { serializeStaff, createStaff } from '../domain/staff.js';
import { managerContext, staffContext } from './helpers.js';
import type { StaffProfileRow } from '../domain/types.js';
import type { AppConfig } from '../config.js';

const miniLoginSchema = z.object({
  role: z.enum(['manager', 'staff']),
  storeCode: z.string().trim().min(3).max(12),
  name: z.string().trim().max(30).optional(),
  phone: z.string().trim().min(5).max(20).optional(),
});

const adminLoginSchema = z.object({ password: z.string().min(1).max(100) });

const wxLoginSchema = z.object({
  code: z.string().trim().min(3).max(200),
  role: z.enum(['manager', 'staff']),
  storeCode: z.string().trim().min(3).max(12),
  claimCode: z.string().trim().max(30).optional(),
  phone: z.string().trim().min(5).max(20).optional(),
  name: z.string().trim().max(30).optional(),
});

function guard(ctx: RequestContext, bucket: string, limit: number, windowMs: number): void {
  const r = rateLimit(ctx.db, ctx.config.rateLimitBackend, `${bucket}:${ctx.clientIp}`, limit, windowMs);
  if (!r.allowed) {
    throw new AppError(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试', { retryAfterSec: r.retryAfterSec });
  }
}

function auditAuth(ctx: RequestContext, action: string, userId: string | null, role: string, detail: Record<string, unknown> = {}) {
  run(
    ctx.db,
    `INSERT INTO audit_logs(id, store_id, actor_id, actor_role, action, entity, entity_id, detail_json, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [id('log'), null, userId, role, action, 'auth', userId, JSON.stringify(detail), Date.now()],
  );
}

function ensureStoreOrganization(ctx: RequestContext, storeId: string, name: string): string {
  const row = get<{ organization_id: string | null }>(ctx.db, 'SELECT organization_id FROM stores WHERE id = ?', [storeId]);
  if (row?.organization_id) return row.organization_id;
  const orgId = id('org');
  run(ctx.db, 'INSERT INTO organizations(id, name, slug, plan, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [orgId, name, `store-${orgId.slice(-8)}`, 'starter', 'active', Date.now(), Date.now()]);
  run(ctx.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [orgId, storeId]);
  return orgId;
}

function ensureMembership(ctx: RequestContext, userId: string, organizationId: string, role: 'owner' | 'staff', storeId: string) {
  const existing = get(ctx.db, 'SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?', [organizationId, userId]);
  if (!existing) run(ctx.db, 'INSERT INTO memberships(id, organization_id, user_id, role, store_id, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', [id('mem'), organizationId, userId, role, storeId, 'active', Date.now(), Date.now()]);
}

function tokenResponse(tokens: SessionTokens) {
  return {
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

function loginManager(ctx: RequestContext, storeCode: string, name?: string) {
  assertDemoLoginAllowed(ctx.req, ctx.config);
  const store = findStoreByCode(ctx.db, storeCode);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
  const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
  let user = get<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM users WHERE role = 'manager' AND store_id = ? ORDER BY created_at LIMIT 1",
    [store.id],
  );
  if (!user) {
    const userId = id('usr');
    run(
      ctx.db,
      "INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [userId, 'manager', name?.trim() || '门店店长', null, null, store.id, null, 0, Date.now()],
    );
    user = { id: userId, name: name?.trim() || '门店店长' };
    run(ctx.db, 'UPDATE stores SET owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?', [userId, store.id]);
  }
  ensureMembership(ctx, user.id, organizationId, 'owner', store.id);
  const tokens = createSession(ctx.db, { id: user.id, role: 'manager' }, store.id, ctx.config);
  auditAuth(ctx, 'auth.demo_login', user.id, 'manager', { storeId: store.id });
  return {
    ...tokenResponse(tokens),
    user: { id: user.id, role: 'manager', name: user.name },
    store: serializeStore(getStore(ctx.db, store.id)),
    staff: null,
  };
}

function loginStaff(ctx: RequestContext, storeCode: string, phone: string | undefined, name: string | undefined) {
  assertDemoLoginAllowed(ctx.req, ctx.config);
  if (!phone) throw new AppError(400, 'PHONE_REQUIRED', '请输入手机号');
  const store = findStoreByCode(ctx.db, storeCode);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
  const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
  let user = get<{ id: string; name: string; role: string; store_id: string | null }>(
    ctx.db,
    'SELECT id, name, role, store_id FROM users WHERE phone = ?',
    [phone],
  );
  let profile: StaffProfileRow | undefined;
  if (user) {
    if (user.role !== 'staff') throw new AppError(409, 'ROLE_CONFLICT', '该手机号已用于其他角色');
    if (!user.store_id) run(ctx.db, 'UPDATE users SET store_id = ? WHERE id = ?', [store.id, user.id]);
    profile = get<StaffProfileRow>(ctx.db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
  }
  if (!user) {
    const userId = id('usr');
    run(
      ctx.db,
      'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [userId, 'staff', name?.trim() || `兼职${phone.slice(-4)}`, phone, hashPassword('staff123'), store.id, null, 0, Date.now()],
    );
    user = { id: userId, name: name?.trim() || `兼职${phone.slice(-4)}`, role: 'staff', store_id: store.id };
  }
  if (!profile) {
    profile = createStaff(ctx.db, {
      userId: user.id,
      storeId: store.id,
      nickname: user.name,
      phone,
      area: '',
      distanceKm: 2,
      expectedRate: 32,
      experienceYears: 0,
      skills: ['烤肉辅助'],
      status: 'pending',
    });
  }
  ensureMembership(ctx, user.id, organizationId, 'staff', profile.store_id);
  const tokens = createSession(ctx.db, { id: user.id, role: 'staff' }, profile.store_id, ctx.config);
  auditAuth(ctx, 'auth.demo_login', user.id, 'staff', { storeId: store.id });
  return {
    ...tokenResponse(tokens),
    user: { id: user.id, role: 'staff', name: user.name },
    store: null,
    staff: serializeStaff(ctx.db, profile),
  };
}

async function loginWx(ctx: RequestContext, input: z.infer<typeof wxLoginSchema>) {
  guard(ctx, 'wx-login', 20, 5 * 60_000);
  const session = await code2Session(input.code, ctx.config);
  const store = findStoreByCode(ctx.db, input.storeCode);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
  const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
  let user = get<{
    id: string;
    role: string;
    name: string;
    phone: string | null;
    store_id: string | null;
    openid: string | null;
    phone_verified: number;
  }>(ctx.db, 'SELECT id, role, name, phone, store_id, openid, phone_verified FROM users WHERE openid = ?', [
    session.openid,
  ]);

  if (user && user.role !== input.role) throw new AppError(409, 'ROLE_CONFLICT', '该微信已绑定其他角色');

  if (input.role === 'manager') {
    if (user) {
      if (user.store_id !== store.id) throw new AppError(403, 'STORE_MISMATCH', '该微信已绑定其他门店');
    } else {
      if (!input.claimCode) {
        throw new AppError(403, 'MANAGER_CLAIM_REQUIRED', '店长绑定需要门店授权码');
      }
      consumeManagerClaim(ctx.db, store.id, input.claimCode);
      const userId = id('usr');
      run(
        ctx.db,
        'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [userId, 'manager', input.name?.trim() || '门店店长', null, null, store.id, session.openid, 0, Date.now()],
      );
      run(ctx.db, 'UPDATE stores SET owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?', [userId, store.id]);
      user = {
        id: userId,
        role: 'manager',
        name: input.name?.trim() || '门店店长',
        phone: null,
        store_id: store.id,
        openid: session.openid,
        phone_verified: 0,
      };
    }
    const tokens = createSession(ctx.db, { id: user.id, role: 'manager' }, store.id, ctx.config);
    auditAuth(ctx, 'auth.wx_login', user.id, 'manager', { storeId: store.id });
    return {
      ...tokenResponse(tokens),
      user: { id: user.id, role: 'manager', name: user.name },
      store: serializeStore(getStore(ctx.db, store.id)),
      staff: null,
    };
  }

  // Staff: bind only to an existing, verified phone. New registrations require verification.
  if (!input.phone) throw new AppError(400, 'PHONE_REQUIRED', '请输入手机号');
  if (user && user.phone !== input.phone) {
    throw new AppError(409, 'OPENID_PHONE_CONFLICT', '该微信已绑定其他手机号');
  }
  if (!user) {
    user = get<{
      id: string;
      role: string;
      name: string;
      phone: string | null;
      store_id: string | null;
      openid: string | null;
      phone_verified: number;
    }>(ctx.db, 'SELECT id, role, name, phone, store_id, openid, phone_verified FROM users WHERE phone = ?', [input.phone]);
  }
  if (!user) {
    throw new AppError(403, 'STAFF_NOT_REGISTERED', '该手机号尚未登记，请联系门店完成兼职登记与审核');
  }
  if (user.role !== 'staff') throw new AppError(409, 'ROLE_CONFLICT', '该手机号已用于其他角色');
  if (user.store_id && user.store_id !== store.id) throw new AppError(403, 'STORE_MISMATCH', '该兼职不属于该门店');
  if (user.openid && user.openid !== session.openid) {
    throw new AppError(409, 'OPENID_ALREADY_BOUND', '该手机号已绑定其他微信，请联系门店处理');
  }
  if (!user.phone_verified) {
    throw new AppError(403, 'PHONE_NOT_VERIFIED', '手机号尚未通过门店验证，请联系管理员');
  }
  if (!user.openid) run(ctx.db, 'UPDATE users SET openid = ? WHERE id = ?', [session.openid, user.id]);
  const profile = get<StaffProfileRow>(ctx.db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [user.id]);
  if (!profile) throw new AppError(403, 'STAFF_PROFILE_MISSING', '兼职资料缺失，请联系门店');
  ensureMembership(ctx, user.id, organizationId, 'staff', profile.store_id);
  const tokens = createSession(ctx.db, { id: user.id, role: 'staff' }, profile.store_id, ctx.config);
  auditAuth(ctx, 'auth.wx_login', user.id, 'staff', { storeId: store.id });
  return {
    ...tokenResponse(tokens),
    user: { id: user.id, role: 'staff', name: user.name },
    store: null,
    staff: serializeStaff(ctx.db, profile),
  };
}

export function registerAuthRoutes(): void {
  route('GET', '/api/auth/config', {}, (ctx) => {
    const demo = demoLoginAvailability(ctx.req, ctx.config);
    return {
      demoLoginEnabled: demo.allowed,
      demoLoginReason: demo.allowed ? null : demo.reason,
      wechatLoginEnabled: Boolean(ctx.config.wechat.appId && ctx.config.wechat.appSecret),
      smsConfigured: Boolean(ctx.config.sms.provider && ctx.config.sms.apiKey),
      environment: ctx.config.nodeEnv,
    };
  });


  route('POST', '/api/auth/register-account', {}, async (ctx) => {
    guard(ctx, 'register-account', 5, 60 * 60_000);
    const body = z.object({
      email: z.string().trim().email().max(200),
      password: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(30),
      organizationName: z.string().trim().min(1).max(60),
    }).parse(ctx.body ?? {});
    const result = registerAccount(ctx.db, ctx.config, body);
    if (result.verificationToken) {
      const email = verificationEmail(ctx.config, result.verificationToken);
      const emailId = queueEmail(ctx.db, { to: body.email, ...email, kind: 'email_verify' });
      result.emailDelivery = (await deliverEmail(ctx.db, ctx.config, emailId)).status;
    }
    return result;
  });

  route('POST', '/api/auth/verify-email', {}, (ctx) => {
    const body = z.object({ token: z.string().trim().min(8).max(300) }).parse(ctx.body ?? {});
    return verifyEmail(ctx.db, body.token);
  });

  route('POST', '/api/auth/email-login', {}, (ctx) => {
    guard(ctx, 'email-login', 10, 15 * 60_000);
    const body = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) }).parse(ctx.body ?? {});
    return emailLogin(ctx.db, ctx.config, body.email, body.password);
  });

  route('POST', '/api/auth/forgot-password', {}, async (ctx) => {
    guard(ctx, 'forgot-password', 5, 60 * 60_000);
    const body = z.object({ email: z.string().trim().email().max(200) }).parse(ctx.body ?? {});
    const result = forgotPassword(ctx.db, ctx.config, body.email);
    if (result.resetToken) {
      const emailId = queueEmail(ctx.db, { to: body.email, ...resetEmail(ctx.config, result.resetToken), kind: 'password_reset' });
      result.emailDelivery = (await deliverEmail(ctx.db, ctx.config, emailId)).status;
    }
    return result;
  });

  route('POST', '/api/auth/reset-password', {}, (ctx) => {
    guard(ctx, 'reset-password', 5, 60 * 60_000);
    const body = z.object({ token: z.string().trim().min(8).max(300), password: z.string().min(12).max(200) }).parse(ctx.body ?? {});
    return resetPassword(ctx.db, body.token, body.password);
  });


  route('POST', '/api/auth/accept-invitation', {}, (ctx) => {
    guard(ctx, 'accept-invitation', 10, 60 * 60_000);
    const body = z.object({ token: z.string().trim().min(8).max(300), name: z.string().trim().max(30).optional(), password: z.string().max(200).optional() }).parse(ctx.body ?? {});
    return acceptInvitation(ctx.db, ctx.config, body.token, { name: body.name, password: body.password });
  });

  route('GET', '/api/org', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const orgId = typeof ctx.query.get('orgId') === 'string' ? ctx.query.get('orgId')! : undefined;
    return orgOverview(ctx.db, ctx.auth!.userId, orgId);
  });

  route('POST', '/api/org/invitations', { roles: ['manager', 'staff', 'admin'] }, async (ctx) => {
    const body = z.object({ email: z.string().trim().email().max(200), role: z.enum(['admin', 'manager', 'staff']), storeId: z.string().trim().max(100).optional(), orgId: z.string().trim().max(100).optional() }).parse(ctx.body ?? {});
    const result = inviteMember(ctx.db, ctx.config, ctx.auth!.userId, body);
    if (result.inviteToken) {
      const emailId = queueEmail(ctx.db, { to: body.email, ...invitationEmail(ctx.config, result.inviteToken, result.organizationName), kind: 'org_invite' });
      result.emailDelivery = (await deliverEmail(ctx.db, ctx.config, emailId)).status;
    }
    return result;
  });

  route('DELETE', '/api/org/invitations/:id', { roles: ['manager', 'staff', 'admin'] }, (ctx) => revokeInvitation(ctx.db, ctx.auth!.userId, ctx.params.id, typeof ctx.query.get('orgId') === 'string' ? ctx.query.get('orgId')! : undefined));

  route('PATCH', '/api/org/members/:id', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const body = z.object({ role: z.enum(['owner', 'admin', 'manager', 'staff']).optional(), status: z.enum(['active', 'suspended']).optional(), storeId: z.string().trim().max(100).nullable().optional(), orgId: z.string().trim().max(100).optional() }).parse(ctx.body ?? {});
    return updateMember(ctx.db, ctx.auth!.userId, ctx.params.id, body, body.orgId);
  });

  route('POST', '/api/org/stores', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), managerCode: z.string().trim().regex(/^[A-Za-z0-9]{3,10}$/).transform((s) => s.toUpperCase()), address: z.string().trim().max(120).optional(), orgId: z.string().trim().max(100).optional() }).parse(ctx.body ?? {});
    return createOrgStore(ctx.db, ctx.auth!.userId, body, body.orgId);
  });



  route('DELETE', '/api/org/members/:id', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const orgId = typeof ctx.query.get('orgId') === 'string' ? ctx.query.get('orgId')! : undefined;
    return removeMember(ctx.db, ctx.auth!.userId, ctx.params.id, orgId);
  });

  route('POST', '/api/org/transfer-owner', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const body = z.object({ memberId: z.string().trim().min(1).max(100), orgId: z.string().trim().max(100).optional() }).parse(ctx.body ?? {});
    return transferOwnership(ctx.db, ctx.auth!.userId, body.memberId, body.orgId);
  });

  route('POST', '/api/account/switch-store', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const body = z.object({ storeId: z.string().trim().min(1).max(100) }).parse(ctx.body ?? {});
    return switchAccountStore(ctx.db, ctx.config, ctx.auth!.userId, body.storeId);
  });

  route('GET', '/api/account/sessions', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const rows = all<{ token_hash: string; role: string; store_id: string | null; created_at: number; last_auth_at: number | null; access_expires_at: number | null; expires_at: number; refresh_expires_at: number | null }>(
      ctx.db,
      'SELECT token_hash, role, store_id, created_at, last_auth_at, access_expires_at, expires_at, refresh_expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [ctx.auth!.userId],
    );
    return {
      currentSessionId: ctx.auth!.sessionId,
      items: rows.map((r) => ({
        id: r.token_hash, role: r.role, storeId: r.store_id, createdAt: r.created_at,
        lastAuthAt: r.last_auth_at ?? r.created_at,
        accessExpiresAt: r.access_expires_at ?? r.expires_at,
        refreshExpiresAt: r.refresh_expires_at,
        current: r.token_hash === ctx.auth!.sessionId,
      })),
    };
  });

  route('DELETE', '/api/account/sessions/:id', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const row = get<{ token_hash: string }>(ctx.db, 'SELECT token_hash FROM sessions WHERE token_hash = ? AND user_id = ?', [ctx.params.id, ctx.auth!.userId]);
    if (!row) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在');
    run(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?', [row.token_hash]);
    auditAuth(ctx, 'account.session.revoke', ctx.auth!.userId, ctx.auth!.role, { sessionId: row.token_hash.slice(0, 12), current: row.token_hash === ctx.auth!.sessionId });
    return { revoked: true, current: row.token_hash === ctx.auth!.sessionId };
  });

  route('DELETE', '/api/account/sessions', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    run(ctx.db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [ctx.auth!.userId, ctx.auth!.sessionId]);
    auditAuth(ctx, 'account.session.revoke_others', ctx.auth!.userId, ctx.auth!.role, {});
    return { revokedOthers: true };
  });

  route('GET', '/api/account/me', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    return accountMe(ctx.db, ctx.auth!.userId);
  });

  route('POST', '/api/auth/mini-login', {}, (ctx) => {
    guard(ctx, 'mini-login', 20, 5 * 60_000);
    const body = miniLoginSchema.parse(ctx.body ?? {});
    if (body.role === 'manager') return loginManager(ctx, body.storeCode, body.name);
    return loginStaff(ctx, body.storeCode, body.phone, body.name);
  });

  route('POST', '/api/auth/register-store', {}, (ctx) => {
    guard(ctx, 'register-store', 5, 60 * 60_000);
    assertDemoLoginAllowed(ctx.req, ctx.config);
    const body = z
      .object({
        storeName: z.string().trim().min(1).max(60),
        managerCode: z.string().trim().regex(/^[A-Za-z0-9]{3,10}$/),
        managerName: z.string().trim().max(30).optional(),
      })
      .parse(ctx.body ?? {});
    const store = createStore(ctx.db, { name: body.storeName, managerCode: body.managerCode.toUpperCase() });
    const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
    const userId = id('usr');
    run(
      ctx.db,
      'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [userId, 'manager', body.managerName || '门店店长', null, null, store.id, null, 0, Date.now()],
    );
    run(ctx.db, 'UPDATE stores SET owner_user_id = ? WHERE id = ?', [userId, store.id]);
    ensureMembership(ctx, userId, organizationId, 'owner', store.id);
    const claim = issueManagerClaim(ctx.db, store.id);
    const tokens = createSession(ctx.db, { id: userId, role: 'manager' }, store.id, ctx.config);
    auditAuth(ctx, 'auth.demo_register_store', userId, 'manager', { storeId: store.id });
    return {
      ...tokenResponse(tokens),
      user: { id: userId, role: 'manager', name: body.managerName || '门店店长' },
      store: serializeStore(getStore(ctx.db, store.id)),
      staff: null,
      managerClaim: claim,
    };
  });

  route('POST', '/api/auth/staff/register', {}, (ctx) => {
    guard(ctx, 'staff-register', 5, 60 * 60_000);
    const body = z
      .object({
        storeCode: z.string().trim().min(3).max(12),
        name: z.string().trim().min(1).max(30),
        phone: z.string().trim().min(5).max(20),
        area: z.string().trim().max(40).optional(),
      })
      .parse(ctx.body ?? {});
    const store = findStoreByCode(ctx.db, body.storeCode);
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
    const existing = get<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE phone = ?', [body.phone]);
    if (existing) throw new AppError(409, 'PHONE_TAKEN', '该手机号已注册，请联系门店');
    const userId = id('usr');
    run(
      ctx.db,
      'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [userId, 'staff', body.name, body.phone, null, store.id, null, 0, Date.now()],
    );
    const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
    ensureMembership(ctx, userId, organizationId, 'staff', store.id);
    const profile = createStaff(ctx.db, {
      userId,
      storeId: store.id,
      nickname: body.name,
      phone: body.phone,
      area: body.area ?? '',
      status: 'pending',
    });
    auditAuth(ctx, 'auth.staff_register', userId, 'staff', { storeId: store.id });
    return {
      status: 'pending_verification',
      message: '注册已提交。门店管理员核验手机号并完成培训审核后，方可使用微信登录接单。',
      staff: serializeStaff(ctx.db, profile),
    };
  });

  route('POST', '/api/auth/wx-login', {}, (ctx) => loginWx(ctx, wxLoginSchema.parse(ctx.body ?? {})));

  route('POST', '/api/auth/wx-register-store', {}, async (ctx) => {
    guard(ctx, 'wx-register-store', 5, 60 * 60_000);
    const body = z
      .object({
        code: z.string().trim().min(3).max(200),
        storeName: z.string().trim().min(1).max(60),
        managerCode: z.string().trim().regex(/^[A-Za-z0-9]{3,10}$/),
        managerName: z.string().trim().max(30).optional(),
      })
      .parse(ctx.body ?? {});
    const wx = await code2Session(body.code, ctx.config);
    const existing = get<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE openid = ?', [wx.openid]);
    if (existing) throw new AppError(409, 'OPENID_ALREADY_BOUND', '该微信已注册门店或账号');
    const store = createStore(ctx.db, { name: body.storeName, managerCode: body.managerCode.toUpperCase() });
    const organizationId = ensureStoreOrganization(ctx, store.id, store.name);
    const userId = id('usr');
    run(
      ctx.db,
      'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [userId, 'manager', body.managerName || '门店店长', null, null, store.id, wx.openid, 0, Date.now()],
    );
    run(ctx.db, 'UPDATE stores SET owner_user_id = ? WHERE id = ?', [userId, store.id]);
    ensureMembership(ctx, userId, organizationId, 'owner', store.id);
    const tokens = createSession(ctx.db, { id: userId, role: 'manager' }, store.id, ctx.config);
    auditAuth(ctx, 'auth.wx_register_store', userId, 'manager', { storeId: store.id });
    return {
      ...tokenResponse(tokens),
      user: { id: userId, role: 'manager', name: body.managerName || '门店店长' },
      store: serializeStore(getStore(ctx.db, store.id)),
      staff: null,
    };
  });

  route('POST', '/api/auth/admin-login', {}, (ctx) => {
    guard(ctx, 'admin-login', 5, 15 * 60_000);
    const body = adminLoginSchema.parse(ctx.body ?? {});
    if (!ctx.config.adminPassword) {
      throw new AppError(503, 'ADMIN_LOGIN_NOT_CONFIGURED', '管理员登录未配置');
    }
    ensureAdmin(ctx.db, ctx.config.adminPassword);
    const admin = get<{ id: string; name: string; password_hash: string | null }>(
      ctx.db,
      "SELECT id, name, password_hash FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (!admin || !verifyPassword(body.password, admin.password_hash)) {
      auditAuth(ctx, 'auth.admin_login_failed', null, 'admin', { ip: ctx.clientIp });
      throw unauthorized('管理员密码错误');
    }
    const tokens = createSession(ctx.db, { id: admin.id, role: 'admin' }, null, ctx.config);
    auditAuth(ctx, 'auth.admin_login', admin.id, 'admin', { ip: ctx.clientIp });
    return { ...tokenResponse(tokens), user: { id: admin.id, role: 'admin', name: admin.name } };
  });

  route('POST', '/api/auth/admin/change-password', { roles: ['admin'] }, (ctx) => {
    const body = z
      .object({ currentPassword: z.string().min(1).max(100), newPassword: z.string().min(1).max(100) })
      .parse(ctx.body ?? {});
    const auth = ctx.auth!;
    requireRecentAuth(auth, ctx.config);
    const admin = get<{ password_hash: string | null }>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', [auth.userId]);
    if (!admin || !verifyPassword(body.currentPassword, admin.password_hash)) throw unauthorized('当前密码错误');
    if (!isStrongPassword(body.newPassword)) {
      throw new AppError(400, 'WEAK_PASSWORD', '新密码至少 12 位，且包含大小写字母、数字和符号');
    }
    updateAdminPassword(ctx.db, body.newPassword);
    auditAuth(ctx, 'auth.admin_change_password', auth.userId, 'admin');
    return { ok: true, message: '密码已更新，所有旧会话已失效' };
  });

  route('POST', '/api/auth/refresh', {}, (ctx) => {
    guard(ctx, 'refresh', 60, 60_000);
    const body = z.object({ refreshToken: z.string().min(20).max(200) }).parse(ctx.body ?? {});
    const result = refreshSession(ctx.db, body.refreshToken, ctx.config);
    return { ...tokenResponse(result.tokens), user: result.user };
  });

  route('POST', '/api/auth/logout', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const body = z.object({ refreshToken: z.string().min(20).max(200).optional() }).parse(ctx.body ?? {});
    if (ctx.rawToken) revokeSession(ctx.db, ctx.rawToken);
    if (body.refreshToken) revokeByRefreshToken(ctx.db, body.refreshToken);
    return { ok: true };
  });

  route('POST', '/api/auth/logout-all', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    revokeAllSessions(ctx.db, ctx.auth!.userId);
    return { ok: true };
  });

  route('POST', '/api/auth/phone/request-code', {}, (ctx) => {
    guard(ctx, 'phone-code', 5, 10 * 60_000);
    const body = z.object({ phone: z.string().trim().min(5).max(20), storeCode: z.string().trim().min(3).max(12) }).parse(ctx.body ?? {});
    if (!ctx.config.sms.provider || !ctx.config.sms.apiKey) {
      throw new AppError(503, 'SMS_NOT_CONFIGURED', '短信服务未配置，无法发送验证码；请联系门店管理员人工核验');
    }
    const store = findStoreByCode(ctx.db, body.storeCode);
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    run(
      ctx.db,
      'INSERT INTO phone_verifications(id, phone, code_hash, store_id, expires_at, created_at) VALUES(?,?,?,?,?,?)',
      [id('pv'), body.phone, sha256(code), store.id, Date.now() + 5 * 60_000, Date.now()],
    );
    // Real SMS provider integration belongs to deployment configuration and is deliberately not faked.
    throw new AppError(503, 'SMS_PROVIDER_NOT_IMPLEMENTED', '短信供应商适配器尚未接入，验证码未发送');
  });

  route('POST', '/api/auth/phone/verify-code', {}, (ctx) => {
    guard(ctx, 'phone-verify', 10, 10 * 60_000);
    const body = z
      .object({ phone: z.string().trim().min(5).max(20), code: z.string().trim().length(6) })
      .parse(ctx.body ?? {});
    const row = get<{ id: string; code_hash: string; expires_at: number; attempts: number; used_at: number | null }>(
      ctx.db,
      'SELECT id, code_hash, expires_at, attempts, used_at FROM phone_verifications WHERE phone = ? ORDER BY created_at DESC LIMIT 1',
      [body.phone],
    );
    if (!row || row.used_at || row.expires_at < Date.now() || row.attempts >= 5) {
      throw new AppError(403, 'PHONE_CODE_INVALID', '验证码无效或已过期');
    }
    if (row.code_hash !== sha256(body.code)) {
      run(ctx.db, 'UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      throw new AppError(403, 'PHONE_CODE_INVALID', '验证码无效或已过期');
    }
    run(ctx.db, 'UPDATE phone_verifications SET used_at = ? WHERE id = ?', [Date.now(), row.id]);
    run(ctx.db, 'UPDATE users SET phone_verified = 1 WHERE phone = ?', [body.phone]);
    return { ok: true, phoneVerified: true };
  });

  route('GET', '/api/me', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const auth = ctx.auth!;
    const publicUser = {
      userId: auth.userId,
      role: auth.role,
      storeId: auth.storeId,
      name: auth.name,
      lastAuthAt: auth.lastAuthAt,
      accessExpiresAt: auth.accessExpiresAt,
    };
    if (auth.role === 'manager') {
      const { store } = managerContext(ctx);
      return { user: publicUser, store: serializeStore(store), staff: null };
    }
    if (auth.role === 'staff') {
      const { staff } = staffContext(ctx);
      return { user: publicUser, store: serializeStore(getStore(ctx.db, staff.store_id)), staff: serializeStaff(ctx.db, staff) };
    }
    return { user: publicUser, store: null, staff: null, storeCount: all(ctx.db, 'SELECT id FROM stores').length };
  });

  route('GET', '/api/auth/session', { roles: ['manager', 'staff', 'admin'] }, (ctx) => {
    const auth = ctx.auth!;
    return {
      userId: auth.userId,
      role: auth.role,
      storeId: auth.storeId,
      name: auth.name,
      lastAuthAt: auth.lastAuthAt,
      accessExpiresAt: auth.accessExpiresAt,
    };
  });

  route('POST', '/api/manager/claim-code', { roles: ['manager'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const { storeId } = managerContext(ctx);
    const claim = issueManagerClaim(ctx.db, storeId, 24);
    auditAuth(ctx, 'manager.issue_claim', ctx.auth!.userId, 'manager', { storeId });
    return claim;
  });
}

