import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshApp, managerLogin, staffLogin, adminLogin, api, type TestApp } from './helpers.js';
import { setClock, storeNow } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';

async function prepared(app: TestApp) {
  const token = await managerLogin(app);
  const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
  setClock(app.db, app.storeId, { at: now });
  await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
  await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
  const plans = await api<{ plans: Array<{ id: string }> }>(app.base, 'POST', '/api/manager/plans', {}, token);
  await api(app.base, 'POST', `/api/manager/plans/${plans.data.plans[0].id}/confirm`, {}, token);
  const assignments = await api<{ items: Array<{ id: string; staffName: string; status: string }> }>(app.base, 'GET', '/api/manager/assignments', undefined, token);
  const lin = assignments.data.items.find((s) => s.staffName === '林小雨')!;
  const staffToken = await staffLogin(app, '13800000001');
  const offers = await api<{ items: Array<{ id: string; status: string; shift: { id: string } }> }>(app.base, 'GET', '/api/staff/offers', undefined, staffToken);
  const offer = offers.data.items.find((o) => o.shift.id === lin.id)!;
  const accepted = await api(app.base, 'POST', `/api/staff/offers/${offer.id}/accept`, {}, staffToken);
  assert.equal(accepted.status, 200);
  return { token, staffToken, shiftId: lin.id };
}

test('R3 concurrency: two simultaneous staff cancels produce one winner and one backfill task', async () => {
  const app = await freshApp();
  try {
    const { staffToken, shiftId } = await prepared(app);
    const [a, b] = await Promise.all([
      api(app.base, 'POST', `/api/staff/shifts/${shiftId}/cancel`, { reason: '临时有事 A' }, staffToken),
      api(app.base, 'POST', `/api/staff/shifts/${shiftId}/cancel`, { reason: '临时有事 B' }, staffToken),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const tasks = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM backfill_tasks WHERE source_shift_id = ?', [shiftId])!.n;
    assert.equal(tasks, 1);
    const cancelled = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE shift_id = ? AND status = 'cancelled'", [shiftId])!.n;
    assert.equal(cancelled, 1);
  } finally {
    await app.close();
  }
});

test('R3 concurrency: simultaneous over-budget approvals produce one offer, not two', async () => {
  const app = await freshApp();
  try {
    const { token, staffToken, shiftId } = await prepared(app);
    const cancel = await api(app.base, 'POST', `/api/staff/shifts/${shiftId}/cancel`, { reason: '临时有事' }, staffToken);
    assert.equal(cancel.status, 200);
    const demand = (await api<{ demands: Array<{ backfillTasks: Array<{ id: string; status: string }> }> }>(app.base, 'GET', '/api/manager/assignments', undefined, token)).data;
    const task = demand.demands[0].backfillTasks.find((t) => t.status === 'needs_approval')!;
    assert.ok(task);
    const [a, b] = await Promise.all([
      api(app.base, 'POST', `/api/manager/backfill/${task.id}/approve`, {}, token),
      api(app.base, 'POST', `/api/manager/backfill/${task.id}/approve`, {}, token),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const offers = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE shift_id IN (SELECT shift_id FROM backfill_tasks WHERE id = ?) AND status IN ('pending','accepted')", [task.id])!.n;
    assert.equal(offers, 1);
  } finally {
    await app.close();
  }
});

test('R3 concurrency: identical webhook deliveries apply once', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const secret = (await api<{ secret: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/webhook-secret`, {}, admin)).data.secret;
    const now = storeNow(app.db, app.storeId);
    const body = JSON.stringify({ externalId: 'r3-concurrent-1', type: 'checkout', tableLabel: 'S1', occurredAt: now });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const send = () => fetch(`${app.base}/api/ingest/webhook/K001`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sig },
      body,
    }).then((r) => r.json());
    const [a, b] = await Promise.all([send(), send()]);
    const statuses = [a.data.results[0].status, b.data.results[0].status].sort();
    assert.deepEqual(statuses, ['applied', 'duplicate']);
    assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM event_ingest WHERE external_id = 'r3-concurrent-1'")!.n, 1);
    assert.equal(get<{ status: string }>(app.db, "SELECT status FROM store_tables WHERE store_id = ? AND label = 'S1'", [app.storeId])!.status, 'checkout');
  } finally {
    await app.close();
  }
});
