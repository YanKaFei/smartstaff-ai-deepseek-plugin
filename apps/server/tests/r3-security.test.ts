import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, staffLogin, api } from './helpers.js';
import { get, run } from '../src/lib/db.js';
import { getWebhookSecret } from '../src/domain/ingest.js';
import { rateLimitDb, resetRateLimits } from '../src/lib/rateLimit.js';

test('R3 security: webhook secret is encrypted at rest, decryptable server-side, and legacy plaintext migrates', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const rotated = await api<{ secret: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/webhook-secret`, {}, admin);
    assert.equal(rotated.status, 200);
    const secret = rotated.data.secret;
    const row = get<{ legacy: string | null; enc: string | null }>(
      app.db,
      'SELECT webhook_secret AS legacy, webhook_secret_enc AS enc FROM stores WHERE id = ?',
      [app.storeId],
    )!;
    assert.equal(row.legacy, null);
    assert.match(row.enc ?? '', /^v1:/);
    assert.ok(!JSON.stringify(row).includes(secret));
    assert.equal(getWebhookSecret(app.db, app.storeId, app.cfg), secret);

    run(app.db, 'UPDATE stores SET webhook_secret = ?, webhook_secret_enc = NULL WHERE id = ?', ['legacy-plain-secret', app.storeId]);
    assert.equal(getWebhookSecret(app.db, app.storeId, app.cfg), 'legacy-plain-secret');
    const migrated = get<{ legacy: string | null; enc: string | null }>(
      app.db,
      'SELECT webhook_secret AS legacy, webhook_secret_enc AS enc FROM stores WHERE id = ?',
      [app.storeId],
    )!;
    assert.equal(migrated.legacy, null);
    assert.match(migrated.enc ?? '', /^v1:/);
    assert.equal(getWebhookSecret(app.db, app.storeId, app.cfg), 'legacy-plain-secret');
  } finally {
    await app.close();
  }
});

test('R3 security: DB-backed rate limiter is shared state, not a per-process map', async () => {
  const app = await freshApp();
  try {
    resetRateLimits(app.db);
    const key = 'r3:shared:test';
    for (let i = 0; i < 3; i += 1) {
      assert.equal(rateLimitDb(app.db, key, 3, 60_000).allowed, true);
    }
    const blocked = rateLimitDb(app.db, key, 3, 60_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec > 0);
    const row = get<{ hits: number; blocked_until: number }>(app.db, 'SELECT hits, blocked_until FROM rate_limit_buckets WHERE key = ?', [key]);
    assert.ok(row);
    assert.ok((row?.blocked_until ?? 0) > 0);
    // A second logical caller reads the same persisted bucket.
    assert.equal(rateLimitDb(app.db, key, 3, 60_000).allowed, false);
  } finally {
    await app.close();
  }
});


test('R3 security: admin can revoke a user session and the old token stops working', async () => {
  const app = await freshApp();
  try {
    const staffToken = await staffLogin(app, '13800000001');
    const admin = await adminLogin(app);
    const user = get<{ id: string }>(app.db, 'SELECT id FROM users WHERE phone = ?', ['13800000001'])!;
    const revoked = await api<{ revoked: number }>(app.base, 'POST', `/api/admin/users/${user.id}/revoke-sessions`, {}, admin);
    assert.equal(revoked.status, 200);
    assert.ok(revoked.data.revoked >= 1);
    const after = await api(app.base, 'GET', '/api/me', undefined, staffToken);
    assert.equal(after.status, 401);
  } finally {
    await app.close();
  }
});
