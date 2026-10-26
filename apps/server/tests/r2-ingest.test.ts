import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshApp, managerLogin, adminLogin, api, type TestApp } from './helpers.js';
import { storeNow } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';

async function rotateSecret(app: TestApp, token: string): Promise<string> {
  const res = await api<{ secret: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/webhook-secret`, {}, token);
  assert.equal(res.status, 200);
  return res.data.secret;
}

async function webhook(app: TestApp, secret: string, body: unknown, code = 'K001') {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(`${app.base}/api/ingest/webhook/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body: raw,
  });
  const json = await res.json();
  return { status: res.status, json };
}

function tableStatus(app: TestApp, label: string): string {
  return (get<{ status: string }>(app.db, 'SELECT status FROM store_tables WHERE store_id = ? AND label = ?', [app.storeId, label])!).status;
}

test('R2 ingest: signed webhook is idempotent and updates state exactly once', async () => {
  const app = await freshApp();
  try {
    const adminToken = await adminLogin(app);
    const secret = await rotateSecret(app, adminToken);
    const now = storeNow(app.db, app.storeId);
    assert.equal(tableStatus(app, 'S1'), 'dining');

    const event = { externalId: 'pos-evt-1', type: 'checkout', tableLabel: 'S1', occurredAt: now };
    const first = await webhook(app, secret, event);
    assert.equal(first.status, 200);
    assert.equal(first.json.data.results[0].status, 'applied');
    assert.equal(tableStatus(app, 'S1'), 'checkout');

    const duplicate = await webhook(app, secret, event);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.data.results[0].status, 'duplicate');
    assert.equal(tableStatus(app, 'S1'), 'checkout');
    const count = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM event_ingest WHERE external_id='pos-evt-1'")!;
    assert.equal(count.n, 1);
  } finally {
    await app.close();
  }
});

test('R2 ingest: bad signature, missing secret and wrong store are rejected', async () => {
  const app = await freshApp();
  try {
    const adminToken = await adminLogin(app);
    const now = storeNow(app.db, app.storeId);
    const noSecret = await webhook(app, 'anything', { externalId: 'x1', type: 'checkout', tableLabel: 'S1', occurredAt: now });
    assert.equal(noSecret.status, 503);
    assert.equal(noSecret.json.error.code, 'WEBHOOK_NOT_CONFIGURED');

    const secret = await rotateSecret(app, adminToken);
    const raw = JSON.stringify({ externalId: 'x2', type: 'checkout', tableLabel: 'S1', occurredAt: now });
    const bad = await fetch(`${app.base}/api/ingest/webhook/K001`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' },
      body: raw,
    });
    assert.equal(bad.status, 401);
    assert.equal(tableStatus(app, 'S1'), 'dining');

    const wrongStore = await webhook(app, secret, { externalId: 'x3', type: 'checkout', tableLabel: 'S1', occurredAt: now }, 'K999');
    assert.equal(wrongStore.status, 404);
  } finally {
    await app.close();
  }
});

test('R2 ingest: stale events are recorded but not applied; manual events enter the same ledger', async () => {
  const app = await freshApp();
  try {
    const managerToken = await managerLogin(app);
    const adminToken = await adminLogin(app);
    const secret = await rotateSecret(app, adminToken);
    const now = storeNow(app.db, app.storeId);
    const queueBefore = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM queue_entries WHERE status IN ('queued','called')")!.n;

    await webhook(app, secret, { externalId: 't1', type: 'queue_join', partySize: 3, occurredAt: now });
    const stale = await webhook(app, secret, { externalId: 't0', type: 'queue_join', partySize: 3, occurredAt: now - 10 * 60_000 });
    assert.equal(stale.status, 200);
    assert.equal(stale.json.data.results[0].status, 'stale');
    const queueAfter = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM queue_entries WHERE status IN ('queued','called')")!.n;
    assert.equal(queueAfter, queueBefore + 1); // only t1 applied

    const manual = await api(app.base, 'POST', '/api/manager/ops', { type: 'join_queue', partySize: 2 }, managerToken);
    assert.equal(manual.status, 200);
    const events = await api<Array<{ source: string; eventType: string; status: string }>>(
      app.base,
      'GET',
      '/api/manager/ingest/events',
      undefined,
      managerToken,
    );
    assert.ok(events.data.some((e) => e.source === 'manual' && e.eventType === 'queue_join' && e.status === 'applied'));
    const status = await api<{ stale: boolean; counts: Record<string, number>; lastSource: string | null }>(
      app.base,
      'GET',
      '/api/manager/ingest/status',
      undefined,
      managerToken,
    );
    assert.equal(status.status, 200);
    assert.equal(status.data.stale, false);
    assert.ok(status.data.counts.applied >= 2);
  } finally {
    await app.close();
  }
});

test('R2 ingest: corrections append a traceable event and can be replayed by admin', async () => {
  const app = await freshApp();
  try {
    const managerToken = await managerLogin(app);
    const adminToken = await adminLogin(app);
    const secret = await rotateSecret(app, adminToken);
    const now = storeNow(app.db, app.storeId);
    await webhook(app, secret, { externalId: 'c1', type: 'queue_join', partySize: 2, occurredAt: now });
    const list = await api<Array<{ id: string; externalId: string; status: string }>>(
      app.base,
      'GET',
      '/api/manager/ingest/events',
      undefined,
      managerToken,
    );
    const original = list.data.find((e) => e.externalId === 'c1')!;
    const correct = await api<{ status: string; ingestId: string }>(
      app.base,
      'POST',
      `/api/manager/ingest/${original.id}/correct`,
      { externalId: 'c1-correct', type: 'queue_join', partySize: 5, occurredAt: now + 60_000 },
      managerToken,
    );
    assert.equal(correct.status, 200);
    assert.equal(correct.data.status, 'applied');
    const corrected = get<{ status: string }>(app.db, 'SELECT status FROM event_ingest WHERE id = ?', [original.id])!;
    assert.equal(corrected.status, 'corrected');

    const replay = await api<{ status: string; ingestId: string }>(
      app.base,
      'POST',
      `/api/admin/ingest/${correct.data.ingestId}/replay`,
      {},
      adminToken,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.status, 'applied');
    const replayRow = get<{ correction_of: string | null }>(app.db, 'SELECT correction_of FROM event_ingest WHERE id = ?', [replay.data.ingestId])!;
    assert.equal(replayRow.correction_of, correct.data.ingestId);
  } finally {
    await app.close();
  }
});

test('R2 ingest: rotating the webhook secret invalidates the old signature', async () => {
  const app = await freshApp();
  try {
    const adminToken = await adminLogin(app);
    const first = await rotateSecret(app, adminToken);
    const now = storeNow(app.db, app.storeId);
    const body = { externalId: 'rot-1', type: 'queue_join', partySize: 2, occurredAt: now };
    const ok = await webhook(app, first, body);
    assert.equal(ok.status, 200);
    const second = await rotateSecret(app, adminToken);
    const old = await webhook(app, first, { ...body, externalId: 'rot-2' });
    assert.equal(old.status, 401);
    const fresh = await webhook(app, second, { ...body, externalId: 'rot-3' });
    assert.equal(fresh.status, 200);
  } finally {
    await app.close();
  }
});
