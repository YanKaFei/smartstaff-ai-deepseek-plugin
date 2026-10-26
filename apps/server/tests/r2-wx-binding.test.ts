import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, api } from './helpers.js';
import { issueManagerClaim } from '../src/lib/managerClaim.js';
import { get } from '../src/lib/db.js';

const wxConfig = {
  appId: 'wx-test-app',
  appSecret: 'test-secret',
  code2SessionUrl: 'https://api.weixin.qq.com/sns/jscode2session',
  timeoutMs: 1000,
  offerTemplateId: '',
};

function installWxFetch(map: Record<string, string>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('jscode2session')) {
      const code = new URL(url).searchParams.get('js_code') ?? '';
      return new Response(JSON.stringify({ openid: map[code] ?? `openid-${code}`, session_key: 'session' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('R2 wx binding: mocked code2Session binds staff OpenID once and rejects a second WeChat ID', async () => {
  const app = await freshApp({ wechat: wxConfig });
  const restore = installWxFetch({ 'staff-code-1': 'openid-staff-1', 'staff-code-2': 'openid-staff-2' });
  try {
    const registered = await api<{ staff: { id: string } }>(app.base, 'POST', '/api/auth/staff/register', {
      storeCode: 'K001',
      name: '绑定测试',
      phone: '13922223333',
    });
    assert.equal(registered.status, 200);
    const admin = await adminLogin(app);
    const verified = await api(app.base, 'POST', `/api/admin/staff/${registered.data.staff.id}/verify-phone`, {}, admin);
    assert.equal(verified.status, 200);

    const first = await api<{ token: string }>(app.base, 'POST', '/api/auth/wx-login', {
      role: 'staff',
      code: 'staff-code-1',
      storeCode: 'K001',
      phone: '13922223333',
    });
    assert.equal(first.status, 200);
    assert.ok(first.data.token);
    const row = get<{ openid: string; phone_verified: number }>(app.db, 'SELECT openid, phone_verified FROM users WHERE phone = ?', ['13922223333'])!;
    assert.equal(row.openid, 'openid-staff-1');
    assert.equal(row.phone_verified, 1);

    // Another WeChat ID cannot take over the same verified phone.
    const second = await api(app.base, 'POST', '/api/auth/wx-login', {
      role: 'staff',
      code: 'staff-code-2',
      storeCode: 'K001',
      phone: '13922223333',
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.error?.code, 'OPENID_ALREADY_BOUND');

    // The bound OpenID cannot silently switch to another phone.
    const switchPhone = await api(app.base, 'POST', '/api/auth/wx-login', {
      role: 'staff',
      code: 'staff-code-1',
      storeCode: 'K001',
      phone: '13922224444',
    });
    assert.equal(switchPhone.status, 409);
    assert.equal(switchPhone.json.error?.code, 'OPENID_PHONE_CONFLICT');
  } finally {
    restore();
    await app.close();
  }
});

test('R2 wx binding: manager claim code is one-time and binds the store owner', async () => {
  const app = await freshApp({ wechat: wxConfig });
  const restore = installWxFetch({ 'manager-code-1': 'openid-manager-1', 'manager-code-2': 'openid-manager-2' });
  try {
    const claim = issueManagerClaim(app.db, app.storeId, 24);
    const first = await api(app.base, 'POST', '/api/auth/wx-login', {
      role: 'manager',
      code: 'manager-code-1',
      storeCode: 'K001',
      claimCode: claim.code,
      name: '微信店长',
    });
    assert.equal(first.status, 200);
    const store = get<{ owner_user_id: string | null; manager_claim_hash: string | null }>(
      app.db,
      'SELECT owner_user_id, manager_claim_hash FROM stores WHERE id = ?',
      [app.storeId],
    )!;
    assert.ok(store.owner_user_id);
    assert.equal(store.manager_claim_hash, null);

    const replay = await api(app.base, 'POST', '/api/auth/wx-login', {
      role: 'manager',
      code: 'manager-code-2',
      storeCode: 'K001',
      claimCode: claim.code,
      name: '另一个店长',
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error?.code, 'CLAIM_NOT_ISSUED');
  } finally {
    restore();
    await app.close();
  }
});
