import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, staffLogin, api, type TestApp } from './helpers.js';

const strong = 'SaaS-Strong-2026!';

async function owner(app: TestApp, email = 'org-owner@example.com') {
  const reg = await api<{ verificationToken: string }>(app.base, 'POST', '/api/auth/register-account', { email, password: strong, name: '组织负责人', organizationName: '组织测试' });
  await api(app.base, 'POST', '/api/auth/verify-email', { token: reg.data.verificationToken });
  const login = await api<{ token: string; organizationId: string }>(app.base, 'POST', '/api/auth/email-login', { email, password: strong });
  return login.data;
}

test('R8 org: owner invites a new staff member, accepts, and the member can log in', async () => {
  const app = await freshApp();
  try {
    const admin = await owner(app);
    const invite = await api<{ inviteToken: string; invitation: { id: string; email: string } }>(app.base, 'POST', '/api/org/invitations', { email: 'new-staff@example.com', role: 'staff' }, admin.token);
    assert.equal(invite.status, 200);
    assert.ok(invite.data.inviteToken);
    const accepted = await api<{ accepted: boolean; userId: string; role: string }>(app.base, 'POST', '/api/auth/accept-invitation', { token: invite.data.inviteToken, name: '新兼职', password: strong });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.role, 'staff');
    const login = await api<{ token: string; organizationId: string }>(app.base, 'POST', '/api/auth/email-login', { email: 'new-staff@example.com', password: strong });
    assert.equal(login.status, 200);
    assert.equal(login.data.organizationId, admin.organizationId);
    const me = await api<{ memberships: Array<{ role: string }> }>(app.base, 'GET', '/api/account/me', undefined, login.data.token);
    assert.equal(me.data.memberships[0].role, 'staff');
  } finally { await app.close(); }
});

test('R8 org: only owner/admin can list members and create stores', async () => {
  const app = await freshApp();
  try {
    const admin = await owner(app, 'org-owner-2@example.com');
    const staffToken = await staffLogin(app, '13800000001');
    const forbidden = await api(app.base, 'GET', '/api/org', undefined, staffToken);
    assert.equal(forbidden.status, 403);
    const store = await api<{ store: { id: string; name: string; managerCode: string } }>(app.base, 'POST', '/api/org/stores', { name: '组织首店', managerCode: 'K100', address: '组织路 1 号' }, admin.token);
    assert.equal(store.status, 200);
    assert.equal(store.data.store.managerCode, 'K100');
    const org = await api<{ stores: Array<{ id: string }>; members: Array<{ role: string }> }>(app.base, 'GET', '/api/org', undefined, admin.token);
    assert.ok(org.data.stores.some((s) => s.id === store.data.store.id));
    assert.equal(org.data.members[0].role, 'owner');
    assert.equal(org.data.members[0].storeId, store.data.store.id);
  } finally { await app.close(); }
});

test('R8 org: owner can change member role and revoke a pending invitation', async () => {
  const app = await freshApp();
  try {
    const admin = await owner(app, 'org-owner-3@example.com');
    const invite = await api<{ inviteToken: string; invitation: { id: string } }>(app.base, 'POST', '/api/org/invitations', { email: 'role-change@example.com', role: 'staff' }, admin.token);
    await api(app.base, 'POST', '/api/auth/accept-invitation', { token: invite.data.inviteToken, name: '成员', password: strong });
    const org = await api<{ members: Array<{ id: string; userId: string; role: string }> }>(app.base, 'GET', '/api/org', undefined, admin.token);
    const member = org.data.members.find((m) => m.role === 'staff')!;
    const changed = await api<{ member: { role: string } }>(app.base, 'PATCH', `/api/org/members/${member.id}`, { role: 'manager' }, admin.token);
    assert.equal(changed.data.member.role, 'manager');
    const pending = await api<{ invitation: { id: string } }>(app.base, 'POST', '/api/org/invitations', { email: 'revoke@example.com', role: 'staff' }, admin.token);
    const revoked = await api(app.base, 'DELETE', `/api/org/invitations/${pending.data.invitation.id}`, undefined, admin.token);
    assert.equal(revoked.status, 200);
  } finally { await app.close(); }
});

test('R8 org: owner suspends a member, transfers ownership, and switches into a store session', async () => {
  const app = await freshApp();
  try {
    const admin = await owner(app, 'org-owner-4@example.com');
    const invite = await api<{ inviteToken: string }>(app.base, 'POST', '/api/org/invitations', { email: 'second@example.com', role: 'admin' }, admin.token);
    await api(app.base, 'POST', '/api/auth/accept-invitation', { token: invite.data.inviteToken, name: '第二管理员', password: strong });
    const org = await api<{ members: Array<{ id: string; userId: string; role: string; email: string | null }> }>(app.base, 'GET', '/api/org', undefined, admin.token);
    const second = org.data.members.find((m) => m.email === 'second@example.com')!;
    const transferred = await api(app.base, 'POST', '/api/org/transfer-owner', { memberId: second.id }, admin.token);
    assert.equal(transferred.status, 200);
    const after = await api<{ members: Array<{ email: string | null; role: string }> }>(app.base, 'GET', '/api/org', undefined, admin.token);
    assert.equal(after.data.members.find((m) => m.email === 'second@example.com')!.role, 'owner');
    assert.equal(after.data.members.find((m) => m.email === 'org-owner-4@example.com')!.role, 'admin');

    const invite2 = await api<{ inviteToken: string }>(app.base, 'POST', '/api/org/invitations', { email: 'remove-me@example.com', role: 'staff' }, admin.token);
    await api(app.base, 'POST', '/api/auth/accept-invitation', { token: invite2.data.inviteToken, name: '待移除', password: strong });
    const org2 = await api<{ members: Array<{ id: string; email: string | null }> }>(app.base, 'GET', '/api/org', undefined, admin.token);
    const target = org2.data.members.find((m) => m.email === 'remove-me@example.com')!;
    const removed = await api(app.base, 'DELETE', `/api/org/members/${target.id}`, undefined, admin.token);
    assert.equal(removed.status, 200);
    const blocked = await api(app.base, 'POST', '/api/auth/email-login', { email: 'remove-me@example.com', password: strong });
    assert.equal(blocked.status, 403);

    const store = await api<{ store: { id: string } }>(app.base, 'POST', '/api/org/stores', { name: '切换门店', managerCode: 'K101', address: '切换路 1 号' }, admin.token);
    const switched = await api<{ token: string; storeId: string }>(app.base, 'POST', '/api/account/switch-store', { storeId: store.data.store.id }, admin.token);
    assert.equal(switched.status, 200);
    assert.equal(switched.data.storeId, store.data.store.id);
    const manager = await api(app.base, 'GET', '/api/manager/today', undefined, switched.data.token);
    assert.equal(manager.status, 200);
  } finally { await app.close(); }
});
