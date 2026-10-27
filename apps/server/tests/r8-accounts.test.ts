import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, api, staffLogin, type TestApp } from './helpers.js';
import { createStore, finishOnboarding } from '../src/domain/stores.js';
import { createDemand } from '../src/domain/dispatch.js';
import { setClock, storeNow } from '../src/domain/clock.js';
import { get, run } from '../src/lib/db.js';
import { id } from '../src/lib/ids.js';

const strong = 'SaaS-Strong-2026!';

async function register(app: TestApp, email: string, organizationName = '测试组织') {
  return api<{ verificationToken?: string; user: { id: string; email: string; emailVerified: boolean }; organization: { id: string } }>(
    app.base, 'POST', '/api/auth/register-account',
    { email, password: strong, name: '测试负责人', organizationName },
  );
}

test('R8 accounts: register creates tenant + owner membership, email must be verified before login', async () => {
  const app = await freshApp();
  try {
    const reg = await register(app, 'owner@example.com', '星河餐饮');
    assert.equal(reg.status, 200);
    assert.equal(reg.data.user.emailVerified, false);
    assert.ok(reg.data.verificationToken);
    assert.ok(reg.data.organization.id);
    const blocked = await api(app.base, 'POST', '/api/auth/email-login', { email: 'owner@example.com', password: strong });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error?.code, 'EMAIL_NOT_VERIFIED');
    const verified = await api(app.base, 'POST', '/api/auth/verify-email', { token: reg.data.verificationToken });
    assert.equal(verified.status, 200);
    const login = await api<{ token: string; organizationId: string; membershipRole: string }>(app.base, 'POST', '/api/auth/email-login', { email: 'owner@example.com', password: strong });
    assert.equal(login.status, 200);
    assert.equal(login.data.membershipRole, 'owner');
    const me = await api<{ memberships: Array<{ organizationName: string; role: string }> }>(app.base, 'GET', '/api/account/me', undefined, login.data.token);
    assert.equal(me.status, 200);
    assert.equal(me.data.memberships[0].organizationName, '星河餐饮');
    assert.equal(me.data.memberships[0].role, 'owner');
  } finally { await app.close(); }
});

test('R8 accounts: duplicate email and weak password are rejected', async () => {
  const app = await freshApp();
  try {
    await register(app, 'dup@example.com');
    const dup = await register(app, 'DUP@example.com');
    assert.equal(dup.status, 409);
    const weak = await api(app.base, 'POST', '/api/auth/register-account', { email: 'weak@example.com', password: 'short', name: 'X', organizationName: 'Y' });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error?.code, 'PASSWORD_WEAK');
  } finally { await app.close(); }
});

test('R8 accounts: password reset invalidates old sessions and accepts the new password', async () => {
  const app = await freshApp();
  try {
    const reg = await register(app, 'reset@example.com');
    await api(app.base, 'POST', '/api/auth/verify-email', { token: reg.data.verificationToken });
    const login = await api<{ token: string }>(app.base, 'POST', '/api/auth/email-login', { email: 'reset@example.com', password: strong });
    const forgot = await api<{ resetToken?: string }>(app.base, 'POST', '/api/auth/forgot-password', { email: 'reset@example.com' });
    assert.ok(forgot.data.resetToken);
    const reset = await api(app.base, 'POST', '/api/auth/reset-password', { token: forgot.data.resetToken, password: 'New-SaaS-2026!' });
    assert.equal(reset.status, 200);
    const oldSession = await api(app.base, 'GET', '/api/account/me', undefined, login.data.token);
    assert.equal(oldSession.status, 401);
    const newLogin = await api(app.base, 'POST', '/api/auth/email-login', { email: 'reset@example.com', password: 'New-SaaS-2026!' });
    assert.equal(newLogin.status, 200);
  } finally { await app.close(); }
});

test('R8 accounts: forgot password does not reveal whether an email exists', async () => {
  const app = await freshApp();
  try {
    const missing = await api<{ accepted: boolean; resetToken?: string }>(app.base, 'POST', '/api/auth/forgot-password', { email: 'missing@example.com' });
    assert.equal(missing.status, 200);
    assert.equal(missing.data.accepted, true);
    assert.equal(missing.data.resetToken, undefined);
  } finally { await app.close(); }
});

test('R8 accounts: staff marketplace is tenant-scoped and hides another organization\'s stores', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const orgB = id('org');
    run(app.db, 'INSERT INTO organizations(id, name, slug, plan, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [orgB, '另一组织', `other-${orgB.slice(-8)}`, 'starter', 'active', Date.now(), Date.now()]);
    const storeB = createStore(app.db, { name: '另一组织门店', managerCode: 'K009', address: '外部路 9 号' });
    finishOnboarding(app.db, storeB.id);
    run(app.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [orgB, storeB.id]);
    setClock(app.db, storeB.id, { at: now });
    const demandB = createDemand(app.db, { storeId: storeB.id, planId: null, role: '烤肉辅助', startAt: now + 2 * 3_600_000, endAt: now + 3 * 3_600_000, headcount: 1, hourlyRate: 30 });
    const token = await staffLogin(app, '13800000001');
    const market = await api<{ items: Array<{ id: string; store: { id: string } }> }>(app.base, 'GET', '/api/staff/opportunities', undefined, token);
    assert.equal(market.status, 200);
    assert.equal(market.data.items.some((o) => o.id === demandB.id), false);
    assert.equal(market.data.items.every((o) => o.store.id !== storeB.id), true);
  } finally { await app.close(); }
});

test('R8 accounts: session list can revoke another device and keeps the current session', async () => {
  const app = await freshApp();
  try {
    const reg = await register(app, 'sessions@example.com');
    await api(app.base, 'POST', '/api/auth/verify-email', { token: reg.data.verificationToken });
    const first = await api<{ token: string }>(app.base, 'POST', '/api/auth/email-login', { email: 'sessions@example.com', password: strong });
    const second = await api<{ token: string }>(app.base, 'POST', '/api/auth/email-login', { email: 'sessions@example.com', password: strong });
    const list = await api<{ items: Array<{ id: string; current: boolean }>; currentSessionId: string }>(app.base, 'GET', '/api/account/sessions', undefined, first.data.token);
    assert.equal(list.data.items.length, 2);
    const other = list.data.items.find((s) => !s.current)!;
    const revoked = await api<{ revoked: boolean }>(app.base, 'DELETE', `/api/account/sessions/${other.id}`, undefined, first.data.token);
    assert.equal(revoked.data.revoked, true);
    const old = await api(app.base, 'GET', '/api/account/me', undefined, second.data.token);
    assert.equal(old.status, 401);
    const current = await api(app.base, 'GET', '/api/account/me', undefined, first.data.token);
    assert.equal(current.status, 200);
  } finally { await app.close(); }
});

test('R8 accounts: manager without an active store membership is denied tenant access', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const orgId = id('org');
    run(app.db, 'INSERT INTO organizations(id, name, slug, plan, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [orgId, '无成员组织', `no-${orgId.slice(-8)}`, 'starter', 'active', Date.now(), Date.now()]);
    const store = createStore(app.db, { name: '越权门店', managerCode: 'K008', address: '越权路 8 号' });
    finishOnboarding(app.db, store.id);
    run(app.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [orgId, store.id]);
    const userId = id('usr');
    run(app.db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)', [userId, 'manager', '越权经理', null, null, store.id, null, 1, Date.now()]);
    const { createSession } = await import('../src/lib/auth.js');
    const token = createSession(app.db, { id: userId, role: 'manager' }, store.id, app.cfg).accessToken;
    const denied = await api(app.base, 'GET', '/api/manager/today', undefined, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error?.code, 'TENANT_FORBIDDEN');
  } finally { await app.close(); }
});

test('R8 accounts: resend verification issues a fresh token and queues mail', async () => {
  const app = await freshApp();
  try {
    const reg = await register(app, 'resend@example.com');
    const again = await api<{ verificationToken?: string; emailDelivery: string }>(app.base, 'POST', '/api/auth/resend-verification', { email: 'resend@example.com' });
    assert.equal(again.status, 200);
    assert.ok(again.data.verificationToken);
    assert.equal(again.data.emailDelivery, 'not_configured');
    const verified = await api(app.base, 'POST', '/api/auth/verify-email', { token: again.data.verificationToken });
    assert.equal(verified.status, 200);
  } finally { await app.close(); }
});

test('R8 accounts: suspended staff membership cannot access staff routes', async () => {
  const app = await freshApp();
  try {
    const token = await staffLogin(app, '13800000001');
    run(app.db, "UPDATE memberships SET status='suspended' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE phone = '13800000001')");
    const denied = await api(app.base, 'GET', '/api/staff/me', undefined, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error?.code, 'TENANT_FORBIDDEN');
  } finally { await app.close(); }
});
