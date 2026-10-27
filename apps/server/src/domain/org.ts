import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { isStrongPassword } from '../config.js';
import { all, get, run, transaction } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { createSession, hashPassword } from '../lib/auth.js';
import { id, sha256 } from '../lib/ids.js';
import { audit } from './notify.js';
import { createStore, finishOnboarding, getStore } from './stores.js';

type OrgRole = 'owner' | 'admin' | 'manager' | 'staff';

export interface OrgMembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgRole;
  store_id: string | null;
  status: string;
}
export interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: 'admin' | 'manager' | 'staff';
  store_id: string | null;
  token_hash: string;
  status: string;
  invited_by: string;
  accepted_by: string | null;
  expires_at: number;
  created_at: number;
  accepted_at: number | null;
}

export function resolveOrg(db: Db, userId: string, requestedOrgId?: string) {
  const rows = all<OrgMembershipRow & { org_name: string; org_slug: string; plan: string }>(
    db,
    `SELECT m.*, o.name AS org_name, o.slug AS org_slug, o.plan
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.status = 'active' AND m.role IN ('owner','admin')
      ORDER BY m.created_at`,
    [userId],
  );
  const membership = requestedOrgId ? rows.find((r) => r.organization_id === requestedOrgId) : rows[0];
  if (!membership) throw new AppError(403, 'ORG_ADMIN_REQUIRED', '需要组织 owner/admin 权限');
  return membership;
}

export function orgOverview(db: Db, userId: string, requestedOrgId?: string) {
  const org = resolveOrg(db, userId, requestedOrgId);
  const members = all<OrgMembershipRow & { name: string; email: string | null; email_verified: number }>(
    db,
    `SELECT m.*, u.name, u.email, u.email_verified FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? ORDER BY m.created_at`,
    [org.organization_id],
  ).map((m) => ({ id: m.id, userId: m.user_id, name: m.name, email: m.email, emailVerified: Boolean(m.email_verified), role: m.role, storeId: m.store_id, status: m.status }));
  const stores = all<{ id: string; name: string; manager_code: string }>(db, 'SELECT id, name, manager_code FROM stores WHERE organization_id = ? ORDER BY created_at', [org.organization_id]);
  const invitations = all<InvitationRow>(db, "SELECT * FROM org_invitations WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC", [org.organization_id]).map((i) => ({ id: i.id, email: i.email, role: i.role, storeId: i.store_id, expiresAt: i.expires_at, createdAt: i.created_at }));
  return {
    organization: { id: org.organization_id, name: org.org_name, slug: org.org_slug, plan: org.plan, myRole: org.role },
    members,
    stores,
    invitations,
  };
}

export function inviteMember(db: Db, cfg: AppConfig, userId: string, input: { email: string; role: 'admin' | 'manager' | 'staff'; storeId?: string; orgId?: string }, now = Date.now()) {
  const org = resolveOrg(db, userId, input.orgId);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'EMAIL_INVALID', '邮箱格式不正确');
  if (input.storeId) {
    const store = get<{ organization_id: string | null }>(db, 'SELECT organization_id FROM stores WHERE id = ?', [input.storeId]);
    if (!store || store.organization_id !== org.organization_id) throw new AppError(400, 'STORE_NOT_IN_ORG', '门店不属于该组织');
  }
  const existing = get<{ id: string }>(db, 'SELECT id FROM org_invitations WHERE organization_id = ? AND email = ? AND status = ?', [org.organization_id, email, 'pending']);
  if (existing) throw conflict('该邮箱已有待处理邀请');
  const token = id('inv');
  const invitationId = id('invite');
  run(db, 'INSERT INTO org_invitations(id, organization_id, email, role, store_id, token_hash, status, invited_by, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    invitationId, org.organization_id, email, input.role, input.storeId ?? null, sha256(token), 'pending', userId, now + 7 * 24 * 3600_000, now,
  ]);
  audit(db, { storeId: input.storeId ?? null, actorId: userId, actorRole: 'manager', action: 'org.invite', entity: 'organization', entityId: org.organization_id, detail: { email, role: input.role }, at: now });
  return { invitation: { id: invitationId, email, role: input.role, storeId: input.storeId ?? null, expiresAt: now + 7 * 24 * 3600_000 }, organizationName: org.org_name, inviteToken: cfg.nodeEnv === 'production' ? undefined : token, emailDelivery: 'NOT_CONFIGURED' };
}

export function revokeInvitation(db: Db, userId: string, invitationId: string, orgId?: string, now = Date.now()) {
  const org = resolveOrg(db, userId, orgId);
  const invite = get<InvitationRow>(db, 'SELECT * FROM org_invitations WHERE id = ? AND organization_id = ?', [invitationId, org.organization_id]);
  if (!invite || invite.status !== 'pending') throw new AppError(404, 'INVITATION_NOT_FOUND', '邀请不存在或已处理');
  run(db, "UPDATE org_invitations SET status='revoked' WHERE id = ?", [invite.id]);
  audit(db, { storeId: null, actorId: userId, actorRole: 'manager', action: 'org.invite.revoke', entity: 'organization', entityId: org.organization_id, detail: { invitationId }, at: now });
  return { revoked: true };
}

export function acceptInvitation(db: Db, cfg: AppConfig, token: string, input: { name?: string; password?: string }, now = Date.now()) {
  const invite = get<InvitationRow>(db, "SELECT * FROM org_invitations WHERE token_hash = ? AND status = 'pending'", [sha256(token)]);
  if (!invite || invite.expires_at < now) throw new AppError(400, 'INVITATION_INVALID', '邀请无效或已过期');
  let user = get<{ id: string; role: string; email_verified: number }>(db, 'SELECT id, role, email_verified FROM users WHERE email = ?', [invite.email]);
  if (!user) {
    if (!input.password || !isStrongPassword(input.password)) throw new AppError(400, 'PASSWORD_WEAK', '新用户需设置至少 12 位含大小写、数字和符号的密码');
    const userId = id('usr');
    const role = invite.role === 'staff' ? 'staff' : 'manager';
    run(db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, email, email_verified, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [
      userId, role, input.name?.trim().slice(0, 30) || invite.email.split('@')[0], null, hashPassword(input.password), invite.store_id, null, 0, invite.email, 1, 'active', now,
    ]);
    user = { id: userId, role, email_verified: 1 };
  } else if (!user.email_verified) {
    run(db, 'UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);
  }
  const existing = get<{ id: string }>(db, 'SELECT id FROM memberships WHERE organization_id = ? AND user_id = ?', [invite.organization_id, user.id]);
  run(db, `INSERT INTO memberships(id, organization_id, user_id, role, store_id, status, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role, store_id=excluded.store_id, status='active', updated_at=excluded.updated_at`, [
    id('mem'), invite.organization_id, user.id, invite.role, invite.store_id, 'active', now, now,
  ]);
  run(db, "UPDATE org_invitations SET status='accepted', accepted_by=?, accepted_at=? WHERE id=?", [user.id, now, invite.id]);
  audit(db, { storeId: invite.store_id, actorId: user.id, actorRole: 'manager', action: 'org.invite.accept', entity: 'organization', entityId: invite.organization_id, detail: { role: invite.role }, at: now });
  return { accepted: true, userId: user.id, organizationId: invite.organization_id, role: invite.role, existingMembership: Boolean(existing) };
}

export function updateMember(db: Db, userId: string, memberId: string, input: { role?: OrgRole; status?: 'active' | 'suspended'; storeId?: string | null }, orgId?: string, now = Date.now()) {
  const org = resolveOrg(db, userId, orgId);
  const member = get<OrgMembershipRow>(db, 'SELECT * FROM memberships WHERE id = ? AND organization_id = ?', [memberId, org.organization_id]);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', '成员不存在');
  if (member.user_id === userId && input.status === 'suspended') throw conflict('不能停用自己');
  if (member.role === 'owner' && input.role && input.role !== 'owner') throw conflict('不能降级组织 owner');
  if (input.storeId) {
    const store = get<{ organization_id: string | null }>(db, 'SELECT organization_id FROM stores WHERE id = ?', [input.storeId]);
    if (!store || store.organization_id !== org.organization_id) throw new AppError(400, 'STORE_NOT_IN_ORG', '门店不属于该组织');
  }
  run(db, 'UPDATE memberships SET role = COALESCE(?, role), status = COALESCE(?, status), store_id = ?, updated_at = ? WHERE id = ?', [input.role ?? null, input.status ?? null, input.storeId === undefined ? member.store_id : input.storeId, now, member.id]);
  audit(db, { storeId: member.store_id, actorId: userId, actorRole: 'manager', action: 'org.member.update', entity: 'membership', entityId: member.id, detail: input, at: now });
  return { member: { id: member.id, role: input.role ?? member.role, status: input.status ?? member.status, storeId: input.storeId === undefined ? member.store_id : input.storeId } };
}

export function createOrgStore(db: Db, userId: string, input: { name: string; managerCode: string; address?: string }, orgId?: string, now = Date.now()) {
  const org = resolveOrg(db, userId, orgId);
  const store = createStore(db, { name: input.name, managerCode: input.managerCode, address: input.address });
  finishOnboarding(db, store.id);
  run(db, 'UPDATE stores SET organization_id = ?, owner_user_id = ? WHERE id = ?', [org.organization_id, userId, store.id]);
  run(db, "UPDATE memberships SET store_id = ?, updated_at = ? WHERE organization_id = ? AND user_id = ? AND store_id IS NULL", [store.id, now, org.organization_id, userId]);
  audit(db, { storeId: store.id, actorId: userId, actorRole: 'manager', action: 'org.store.create', entity: 'store', entityId: store.id, detail: {}, at: now });
  return { store: { id: store.id, name: store.name, managerCode: store.manager_code } };
}

export function removeMember(db: Db, userId: string, memberId: string, orgId?: string, now = Date.now()) {
  const org = resolveOrg(db, userId, orgId);
  const member = get<OrgMembershipRow>(db, 'SELECT * FROM memberships WHERE id = ? AND organization_id = ?', [memberId, org.organization_id]);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', '成员不存在');
  if (member.user_id === userId) throw conflict('不能移除自己');
  if (member.role === 'owner') throw conflict('不能移除组织 owner，请先转移所有权');
  run(db, "UPDATE memberships SET status='suspended', updated_at=? WHERE id=?", [now, member.id]);
  audit(db, { storeId: member.store_id, actorId: userId, actorRole: 'manager', action: 'org.member.remove', entity: 'membership', entityId: member.id, detail: { targetUserId: member.user_id }, at: now });
  return { removed: true };
}

export function transferOwnership(db: Db, userId: string, memberId: string, orgId?: string, now = Date.now()) {
  const org = resolveOrg(db, userId, orgId);
  if (org.role !== 'owner') throw new AppError(403, 'ORG_OWNER_REQUIRED', '只有 owner 可以转移所有权');
  const target = get<OrgMembershipRow>(db, 'SELECT * FROM memberships WHERE id = ? AND organization_id = ?', [memberId, org.organization_id]);
  if (!target) throw new AppError(404, 'MEMBER_NOT_FOUND', '成员不存在');
  if (target.user_id === userId || target.status !== 'active') throw conflict('目标成员不可成为 owner');
  transaction(db, () => {
    run(db, "UPDATE memberships SET role='admin', updated_at=? WHERE id=?", [now, org.id]);
    run(db, "UPDATE memberships SET role='owner', updated_at=? WHERE id=?", [now, target.id]);
  });
  audit(db, { storeId: null, actorId: userId, actorRole: 'manager', action: 'org.owner.transfer', entity: 'organization', entityId: org.organization_id, detail: { from: org.id, to: target.id }, at: now });
  return { transferred: true, newOwnerMembershipId: target.id };
}

export function switchAccountStore(db: Db, cfg: AppConfig, userId: string, storeId: string, meta: { userAgent?: string | null; ip?: string | null } = {}) {
  const store = get<{ organization_id: string | null; owner_user_id: string | null }>(db, 'SELECT organization_id, owner_user_id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店不存在');
  const member = store.organization_id
    ? get<OrgMembershipRow>(db, "SELECT * FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'", [userId, store.organization_id])
    : undefined;
  if (!member && store.owner_user_id !== userId) throw new AppError(403, 'TENANT_FORBIDDEN', '当前账户不属于该门店组织');
  const user = get<{ id: string; role: 'manager' | 'staff' | 'admin' }>(db, 'SELECT id, role FROM users WHERE id = ?', [userId])!;
  const tokens = createSession(db, { id: user.id, role: user.role }, storeId, cfg, { userAgent: meta.userAgent, ip: meta.ip });
  return { ...tokens, token: tokens.accessToken, storeId };
}
