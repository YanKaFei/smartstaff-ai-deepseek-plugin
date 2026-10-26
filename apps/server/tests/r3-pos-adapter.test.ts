import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshApp, adminLogin, api, type TestApp } from './helpers.js';
import { storeNow } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';
import { getPosAdapter, listPosAdapters, POS_CAPABILITIES } from '../src/domain/adapters/pos.js';
import { advanceSimulationAndSummarize } from '../src/domain/simulator.js';

async function secretFor(app: TestApp): Promise<string> {
  const admin = await adminLogin(app);
  const res = await api<{ secret: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/webhook-secret`, {}, admin);
  return res.data.secret;
}

async function webhook(app: TestApp, secret: string, body: unknown, adapter = 'generic') {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(`${app.base}/api/ingest/webhook/K001`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-pos-adapter': adapter },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

test('R3 POS: adapter contract exposes standard capabilities and unknown adapters are rejected', async () => {
  const adapters = listPosAdapters();
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].id, 'generic');
  for (const type of ['queue_call', 'seat', 'checkout', 'leave', 'clean', 'table_status']) {
    assert.ok(adapters[0].capabilities.includes(type as never), type);
  }
  assert.throws(() => getPosAdapter('unknown-vendor'), /未知的 POS 适配器/);
  const parsed = getPosAdapter('generic').parse({
    externalId: 'contract-1',
    type: 'table_status',
    occurredAt: Date.now(),
    tableLabel: 'S1',
    tableStatus: 'checkout',
  }, { now: Date.now() });
  assert.equal(parsed[0].type, 'table_status');
  assert.equal(parsed[0].tableStatus, 'checkout');
});

test('R3 POS: signed table_status updates a table and simulator event vocabulary fits the contract', async () => {
  const app = await freshApp();
  try {
    const secret = await secretFor(app);
    const now = storeNow(app.db, app.storeId);
    const before = get<{ status: string }>(app.db, 'SELECT status FROM store_tables WHERE store_id = ? AND label = ?', [app.storeId, 'S1'])!;
    assert.equal(before.status, 'dining');
    const res = await webhook(app, secret, {
      externalId: 'pos-table-1',
      type: 'table_status',
      occurredAt: now,
      tableLabel: 'S1',
      tableStatus: 'checkout',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.results[0].status, 'applied');
    const after = get<{ status: string }>(app.db, 'SELECT status FROM store_tables WHERE store_id = ? AND label = ?', [app.storeId, 'S1'])!;
    assert.equal(after.status, 'checkout');

    const unknown = await webhook(app, secret, { externalId: 'pos-unknown', type: 'checkout', tableLabel: 'S1', occurredAt: now }, 'vendor-x');
    assert.equal(unknown.status, 422);
    assert.equal(unknown.json.error.code, 'POS_ADAPTER_UNKNOWN');

    await advanceSimulationAndSummarize(app.db, app.storeId, 5, app.cfg);
    const types = app.db.prepare("SELECT DISTINCT event_type FROM event_ingest WHERE store_id = ? AND source = 'simulator'").all(app.storeId) as Array<{ event_type: string }>;
    assert.ok(types.length > 0);
    for (const row of types) {
      assert.ok(POS_CAPABILITIES.includes(row.event_type as never), `simulator event ${row.event_type} must fit the adapter capability contract`);
    }
  } finally {
    await app.close();
  }
});
