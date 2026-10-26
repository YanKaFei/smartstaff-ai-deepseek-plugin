import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, adminLogin, api } from './helpers.js';
import { assertProductionSafety, makeConfig } from '../src/config.js';
import { issueManagerClaim, consumeManagerClaim } from '../src/lib/managerClaim.js';
import { get, run } from '../src/lib/db.js';

test('R2 auth: demo login is disabled by default and can only be enabled explicitly', async () => {
  const app = await freshApp({ auth: { demoLoginEnabled: false } });
  try {
    const configRes = await api(app.base, 'GET', '/api/auth/config');
    assert.equal(configRes.status, 200);
    assert.equal(configRes.data.demoLoginEnabled, false);
    const login = await api(app.base, 'POST', '/api/auth/mini-login', { role: 'manager', storeCode: 'K001' });
    assert.equal(login.status, 403);
    assert.equal(login.json.error?.code, 'FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('R2 auth: production refuses default/weak admin passwords, wildcard CORS and demo login', () => {
  const unsafe = makeConfig({
    isProduction: true,
    nodeEnv: 'production',
    adminPassword: 'admin123',
    auth: { demoLoginEnabled: true },
    corsOrigins: ['*'],
    requireHttps: false,
  });
  assert.throws(() => assertProductionSafety(unsafe), /Unsafe production configuration/);
  const safe = makeConfig({
    isProduction: true,
    nodeEnv: 'production',
    adminPassword: 'Str0ng!Admin#2026',
    auth: { demoLoginEnabled: false },
    corsOrigins: ['https://staff.example.com'],
    requireHttps: true,
    secretEncryptionKey: 'a'.repeat(64),
  });
  assert.doesNotThrow(() => assertProductionSafety(safe));
});

test('R2 auth: admin login is rate limited and response does not leak the password', async () => {
  const app = await freshApp();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'wrong-password' });
      codes.push(res.status);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    const blocked = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'test-admin' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error?.code, 'RATE_LIMITED');
    assert.ok(!JSON.stringify(blocked.json).includes('test-admin'));
  } finally {
    await app.close();
  }
});

test('R2 auth: access token expires, refresh rotates both tokens and logout revokes them', async () => {
  const app = await freshApp({ auth: { demoLoginEnabled: true, accessTtlMinutes: 0.001 } });
  try {
    const login = await api<{ token: string; refreshToken: string }>(app.base, 'POST', '/api/auth/mini-login', {
      role: 'manager',
      storeCode: 'K001',
    });
    assert.equal(login.status, 200);
    const { token, refreshToken } = login.data;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const expired = await api(app.base, 'GET', '/api/me', undefined, token);
    assert.equal(expired.status, 401);

    const refreshed = await api<{ token: string; refreshToken: string }>(app.base, 'POST', '/api/auth/refresh', { refreshToken });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.data.token, token);
    assert.notEqual(refreshed.data.refreshToken, refreshToken);
    const me = await api(app.base, 'GET', '/api/me', undefined, refreshed.data.token);
    assert.equal(me.status, 200);

    const reuse = await api(app.base, 'POST', '/api/auth/refresh', { refreshToken });
    assert.equal(reuse.status, 401);

    const logout = await api(app.base, 'POST', '/api/auth/logout', { refreshToken: refreshed.data.refreshToken }, refreshed.data.token);
    assert.equal(logout.status, 200);
    const afterLogout = await api(app.base, 'GET', '/api/me', undefined, refreshed.data.token);
    assert.equal(afterLogout.status, 401);
    const refreshAfterLogout = await api(app.base, 'POST', '/api/auth/refresh', { refreshToken: refreshed.data.refreshToken });
    assert.equal(refreshAfterLogout.status, 401);
  } finally {
    await app.close();
  }
});

test('R2 auth: sensitive admin actions require a recent interactive login', async () => {
  const app = await freshApp();
  try {
    const token = await adminLogin(app);
    const admin = get<{ id: string }>(app.db, "SELECT id FROM users WHERE role='admin' LIMIT 1")!;
    run(app.db, 'UPDATE sessions SET last_auth_at = ? WHERE user_id = ?', [Date.now() - 20 * 60_000, admin.id]);
    const stale = await api(app.base, 'POST', '/api/admin/sim/control', { running: false }, token);
    assert.equal(stale.status, 403);
    assert.equal(stale.json.error?.code, 'FORBIDDEN');
    const freshToken = await adminLogin(app);
    const allowed = await api(app.base, 'POST', '/api/admin/sim/control', { running: false }, freshToken);
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});

test('R2 auth: CORS only echoes allow-listed origins and rejects other preflights', async () => {
  const app = await freshApp();
  try {
    const evil = await fetch(app.base + '/api/auth/config', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const allowed = await fetch(app.base + '/api/auth/config', { headers: { Origin: 'http://127.0.0.1:5173' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    const preflight = await fetch(app.base + '/api/admin/staff', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(preflight.status, 403);
  } finally {
    await app.close();
  }
});

test('R2 auth: HTTPS is enforced in production mode', async () => {
  const app = await freshApp({
    isProduction: true,
    nodeEnv: 'production',
    requireHttps: true,
    adminPassword: 'Str0ng!Admin#2026',
    corsOrigins: ['https://staff.example.com'],
    auth: { demoLoginEnabled: false },
    wechat: { appId: 'wx-test', appSecret: 'secret-test' },
  });
  try {
    const health = await fetch(app.base + '/health');
    assert.equal(health.status, 200);
    const apiRes = await fetch(app.base + '/api/auth/config');
    assert.equal(apiRes.status, 426);
    const body = await apiRes.json();
    assert.equal(body.error.code, 'HTTPS_REQUIRED');
  } finally {
    await app.close();
  }
});

test('R2 auth: WeChat login is blocked without credentials, never faked', async () => {
  const app = await freshApp({ wechat: { appId: '', appSecret: '' } });
  try {
    const res = await api(app.base, 'POST', '/api/auth/wx-login', {
      code: 'fake-code',
      role: 'manager',
      storeCode: 'K001',
      claimCode: 'ABCDEF',
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error?.code, 'WECHAT_NOT_CONFIGURED');
  } finally {
    await app.close();
  }
});

test('R2 auth: manager claim codes bind a verified identity once and cannot be replayed', async () => {
  const app = await freshApp();
  try {
    const claim = issueManagerClaim(app.db, app.storeId, 1);
    assert.equal(claim.code.length, 10);
    assert.throws(() => consumeManagerClaim(app.db, app.storeId, 'WRONGCODE1'));
    consumeManagerClaim(app.db, app.storeId, claim.code);
    assert.throws(() => consumeManagerClaim(app.db, app.storeId, claim.code));
    const store = get<{ manager_claim_hash: string | null }>(app.db, 'SELECT manager_claim_hash FROM stores WHERE id = ?', [app.storeId])!;
    assert.equal(store.manager_claim_hash, null);
  } finally {
    await app.close();
  }
});

test('R2 auth: admin can mark a phone verified, but never receives the user password', async () => {
  const app = await freshApp();
  try {
    const token = await adminLogin(app);
    const staff = await api<{ items: Array<{ id: string; phone: string; phoneVerified?: boolean }> }>(
      app.base,
      'GET',
      '/api/admin/staff',
      undefined,
      token,
    );
    const target = staff.data.items[0];
    run(app.db, 'UPDATE users SET phone_verified = 0 WHERE phone = ?', [target.phone]);
    const verify = await api(app.base, 'POST', `/api/admin/staff/${target.id}/verify-phone`, {}, token);
    assert.equal(verify.status, 200);
    const user = get<{ phone_verified: number; password_hash: string | null }>(
      app.db,
      'SELECT phone_verified, password_hash FROM users WHERE phone = ?',
      [target.phone],
    )!;
    assert.equal(user.phone_verified, 1);
    assert.ok(!JSON.stringify(verify.data).includes(user.password_hash ?? 'never-matches'));
  } finally {
    await app.close();
  }
});

test('R2 auth: two roles cannot be merged and JWT/session hashes never appear in /me', async () => {
  const app = await freshApp();
  try {
    const token = await managerLogin(app);
    const me = await api(app.base, 'GET', '/api/me', undefined, token);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.sessionId, undefined);
    assert.ok(!JSON.stringify(me.data).includes('token_hash'));
    const staffToken = (await api(app.base, 'POST', '/api/auth/mini-login', {
      role: 'staff',
      storeCode: 'K001',
      phone: '13800000001',
    })).data.token;
    const forbidden = await api(app.base, 'GET', '/api/admin/staff', undefined, staffToken);
    assert.equal(forbidden.status, 403);
  } finally {
    await app.close();
  }
});

test('R2 auth: admin password rotation requires current password, enforces strength and revokes sessions', async () => {
  const app = await freshApp();
  try {
    const token = await adminLogin(app);
    const weak = await api(app.base, 'POST', '/api/auth/admin/change-password', {
      currentPassword: 'test-admin',
      newPassword: 'short',
    }, token);
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error?.code, 'WEAK_PASSWORD');

    const changed = await api(app.base, 'POST', '/api/auth/admin/change-password', {
      currentPassword: 'test-admin',
      newPassword: 'R2!StrongPass2026',
    }, token);
    assert.equal(changed.status, 200);
    const oldSession = await api(app.base, 'GET', '/api/me', undefined, token);
    assert.equal(oldSession.status, 401);

    const oldPassword = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'test-admin' });
    assert.equal(oldPassword.status, 401);
    const newPassword = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'R2!StrongPass2026' });
    assert.equal(newPassword.status, 200);
    assert.ok(newPassword.data.refreshToken);
  } finally {
    await app.close();
  }
});

test('R2 auth: staff self-registration creates a pending, unverified profile and grants no session', async () => {
  const app = await freshApp();
  try {
    const registered = await api<{ status: string; staff: { id: string } }>(app.base, 'POST', '/api/auth/staff/register', {
      storeCode: 'K001',
      name: '新登记兼职',
      phone: '13911112222',
      area: '科技园',
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.status, 'pending_verification');
    assert.equal(registered.data.token, undefined);
    const user = get<{ phone_verified: number; openid: string | null }>(
      app.db,
      'SELECT phone_verified, openid FROM users WHERE phone = ?',
      ['13911112222'],
    )!;
    assert.equal(user.phone_verified, 0);
    assert.equal(user.openid, null);
    const profile = get<{ status: string }>(app.db, 'SELECT status FROM staff_profiles WHERE phone = ?', ['13911112222'])!;
    assert.equal(profile.status, 'pending');
  } finally {
    await app.close();
  }
});
