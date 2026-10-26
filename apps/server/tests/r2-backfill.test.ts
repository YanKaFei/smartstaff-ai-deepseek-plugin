import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, staffLogin, api, type TestApp } from './helpers.js';
import { storeNow, setClock } from '../src/domain/clock.js';
import { processStaleShifts } from '../src/domain/dispatch.js';
import { get, run } from '../src/lib/db.js';
import { id } from '../src/lib/ids.js';
import { createStaff, setAvailability } from '../src/domain/staff.js';
import { localParts } from '../src/lib/time.js';

interface DemandView {
  id: string;
  headcount: number;
  status: string;
  confirmed: number;
  pending: number;
  committed: number;
  unfilled: number;
  uncovered: number;
  backfillTasks: Array<{ id: string; status: string; shiftId: string | null; startAt: number; endAt: number }>;
}
interface AssignmentView {
  items: Array<{ id: string; staffId: string; staffName: string; status: string; demandId: string | null; isBackfill: boolean; offerStatus: string | null; cancelKind: string | null }>;
  demands: DemandView[];
  groups: Record<string, number>;
}

async function confirmPlan(app: TestApp) {
  const token = await managerLogin(app);
  const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
  setClock(app.db, app.storeId, { at: now });
  await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
  await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
  const plans = await api<{ plans: Array<{ id: string; items: Array<{ staffId: string; nickname: string }> }> }>(
    app.base,
    'POST',
    '/api/manager/plans',
    {},
    token,
  );
  const plan = plans.data.plans[0];
  assert.ok(plan);
  const confirmed = await api(app.base, 'POST', `/api/manager/plans/${plan.id}/confirm`, {}, token);
  assert.equal(confirmed.status, 200);
  return { token, plan };
}

async function assignmentView(app: TestApp, token: string): Promise<AssignmentView> {
  const res = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
  assert.equal(res.status, 200);
  return res.data;
}

async function addCheapBackup(app: TestApp, startAt: number, rate = 30): Promise<string> {
  const userId = id('usr');
  const phone = '13900000099';
  run(app.db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
    userId, 'staff', '备用小李', phone, null, app.storeId, null, 1, Date.now(),
  ]);
  const profile = createStaff(app.db, {
    userId,
    storeId: app.storeId,
    nickname: '备用小李',
    phone,
    area: '科技园',
    distanceKm: 0.8,
    expectedRate: rate,
    experienceYears: 1,
    skills: ['烤肉辅助'],
    status: 'approved',
  });
  run(app.db, "UPDATE staff_profiles SET qualified = 1, training_status = 'qualified' WHERE id = ?", [profile.id]);
  const weekday = localParts(startAt).weekday;
  setAvailability(app.db, profile.id, [{ weekday, startMin: 16 * 60, endMin: 24 * 60 }]);
  return profile.id;
}

async function acceptShift(app: TestApp, phone: string, shiftId: string) {
  const token = await staffLogin(app, phone);
  const offers = await api<{ items: Array<{ id: string; status: string; shift: { id: string } }> }>(
    app.base,
    'GET',
    '/api/staff/offers',
    undefined,
    token,
  );
  const offer = offers.data.items.find((o) => o.status === 'pending' && o.shift.id === shiftId);
  if (!offer) return { token, offer: null };
  const accepted = await api(app.base, 'POST', `/api/staff/offers/${offer.id}/accept`, {}, token);
  assert.equal(accepted.status, 200);
  return { token, offer: accepted.data };
}

test('R2 backfill: plan confirmation creates a demand and truthful coverage counts', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    assert.equal(view.demands.length, 1);
    const demand = view.demands[0];
    assert.equal(demand.headcount, 5);
    assert.equal(demand.status, 'open');
    assert.equal(demand.pending, 5);
    assert.equal(demand.committed, 0);
    assert.equal(demand.unfilled, 5);
    assert.equal(demand.uncovered, 0);

    const lin = await acceptShift(app, '13800000001', view.items.find((s) => s.staffName === '林小雨')!.id);
    assert.ok(lin.offer);
    const after = (await assignmentView(app, token)).demands[0];
    assert.equal(after.committed, 1);
    assert.equal(after.pending, 4);
    assert.equal(after.unfilled, 4);
  } finally {
    await app.close();
  }
});

test('R2 backfill: staff self-cancel creates a replacement invitation and clears accepted state', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    const linShift = view.items.find((s) => s.staffName === '林小雨')!;
    await addCheapBackup(app, linShift.startAt, 30);
    const linToken = await staffLogin(app, '13800000001');
    await acceptShift(app, '13800000001', linShift.id);
    const cancel = await api(app.base, 'POST', `/api/staff/shifts/${linShift.id}/cancel`, { reason: '临时有事' }, linToken);
    assert.equal(cancel.status, 200);
    assert.equal((cancel.data as { status: string }).status, 'cancelled');
    assert.equal((cancel.data as { cancelKind: string }).cancelKind, 'staff_cancelled');

    const afterCancel = await assignmentView(app, token);
    const original = afterCancel.items.find((s) => s.id === linShift.id)!;
    assert.equal(original.status, 'cancelled');
    assert.equal(original.offerStatus, 'cancelled');
    const demand = afterCancel.demands[0];
    assert.equal(demand.committed, 0);
    const task = demand.backfillTasks.find((t) => t.status === 'offered');
    assert.ok(task, 'a backfill task should be offered');
    const replacement = afterCancel.items.find((s) => s.demandId === demand.id && s.isBackfill && s.status === 'invited');
    assert.ok(replacement, 'a replacement invitation should exist');
    assert.notEqual(replacement!.staffId, linShift.staffId);

    // The replacement must actively accept; a sent invitation is still not success.
    const phone = get<{ phone: string }>(app.db, 'SELECT phone FROM staff_profiles WHERE id = ?', [replacement!.staffId])!.phone;
    await acceptShift(app, phone, replacement!.id);
    const final = (await assignmentView(app, token)).demands[0];
    assert.equal(final.committed, 1);
    assert.ok(final.backfillTasks.some((t) => t.status === 'filled'));
    const acceptedOffers = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status='accepted'")!;
    assert.equal(acceptedOffers.n, 1);
  } finally {
    await app.close();
  }
});

test('R2 backfill: manager can cancel one person (auto backfill) or the whole demand (no backfill)', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    const first = view.items.find((s) => s.status === 'invited')!;
    await addCheapBackup(app, first.startAt, 30);
    const firstPhone = get<{ phone: string }>(app.db, 'SELECT phone FROM staff_profiles WHERE id = ?', [first.staffId])!.phone;
    await acceptShift(app, firstPhone, first.id);
    const personCancel = await api(app.base, 'POST', `/api/manager/assignments/${first.id}/cancel`, {
      reason: '该员工临时请假',
      scope: 'person',
    }, token);
    assert.equal(personCancel.status, 200);
    const afterPerson = await assignmentView(app, token);
    assert.ok(afterPerson.demands[0].backfillTasks.some((t) => t.status === 'offered'));

    // Cancel the entire demand: no replacement may be generated.
    const demandId = afterPerson.demands[0].id;
    const another = afterPerson.items.find((s) => s.status === 'invited' || s.status === 'confirmed')!;
    const demandCancel = await api(app.base, 'POST', `/api/manager/assignments/${another.id}/cancel`, {
      reason: '整场活动取消',
      scope: 'demand',
    }, token);
    assert.equal(demandCancel.status, 200);
    const afterDemand = await assignmentView(app, token);
    const demand = afterDemand.demands[0];
    assert.equal(demand.status, 'cancelled');
    assert.ok(demand.backfillTasks.every((t) => t.status === 'cancelled'));
    const active = afterDemand.items.filter((s) => s.demandId === demandId && ['invited', 'confirmed', 'checked_in'].includes(s.status));
    assert.equal(active.length, 0);
  } finally {
    await app.close();
  }
});

test('R2 backfill: no-show after grace period creates a remaining-time replacement offer', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    const linShift = view.items.find((s) => s.staffName === '林小雨')!;
    await addCheapBackup(app, linShift.startAt, 30);
    await acceptShift(app, '13800000001', linShift.id);
    const now = storeNow(app.db, app.storeId);
    const afterGrace = linShift.startAt + 46 * 60_000;
    setClock(app.db, app.storeId, { at: Math.max(now, afterGrace) });
    const result = processStaleShifts(app.db, app.storeId, afterGrace);
    assert.ok(result.noShow >= 1);

    const after = await assignmentView(app, token);
    const original = after.items.find((s) => s.id === linShift.id)!;
    assert.equal(original.status, 'no_show');
    assert.equal(original.offerStatus, 'cancelled');
    const demand = after.demands[0];
    assert.ok(demand.backfillTasks.some((t) => t.status === 'offered'));
    const replacement = after.items.find((s) => s.isBackfill && s.status === 'invited');
    assert.ok(replacement);
    assert.ok(replacement!.startAt >= afterGrace + 15 * 60_000);
    assert.equal(replacement!.endAt, linShift.endAt);
  } finally {
    await app.close();
  }
});

test('R2 backfill: no candidate leaves an explicit gap and exception, and duplicate cancels are idempotent', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    const first = view.items.find((s) => s.staffName === '林小雨')!;
    const linToken = await staffLogin(app, '13800000001');
    await acceptShift(app, '13800000001', first.id);

    // Remove every other candidate so backfill cannot find anyone.
    app.db.prepare("UPDATE staff_profiles SET status = 'suspended' WHERE id != ?").run(first.staffId);
    const cancel = await api(app.base, 'POST', `/api/staff/shifts/${first.id}/cancel`, { reason: '临时有事' }, linToken);
    assert.equal(cancel.status, 200);
    const second = await api(app.base, 'POST', `/api/staff/shifts/${first.id}/cancel`, { reason: '重复' }, linToken);
    assert.equal(second.status, 409);

    const after = await assignmentView(app, token);
    const demand = after.demands[0];
    assert.ok(demand.unfilled >= 1);
    assert.ok(demand.backfillTasks.some((t) => t.status === 'no_candidate'));
    const exceptions = await api<Array<{ type: string; status: string }>>(app.base, 'GET', '/api/manager/exceptions', undefined, token);
    assert.ok(exceptions.data.some((e) => e.type === 'no_candidate' && e.status === 'open'));
  } finally {
    await app.close();
  }
});

test('R2 backfill: candidates above the approved budget require manager approval, not silent dispatch', async () => {
  const app = await freshApp();
  try {
    const { token } = await confirmPlan(app);
    const view = await assignmentView(app, token);
    const linShift = view.items.find((s) => s.staffName === '林小雨')!;
    const linToken = await staffLogin(app, '13800000001');
    await acceptShift(app, '13800000001', linShift.id);
    // Seed alternatives all expect more than the plan's max approved rate (32).
    const cancel = await api(app.base, 'POST', `/api/staff/shifts/${linShift.id}/cancel`, { reason: '临时有事' }, linToken);
    assert.equal(cancel.status, 200);
    const after = await assignmentView(app, token);
    const demand = after.demands[0];
    assert.ok(!demand.backfillTasks.some((t) => t.status === 'offered'));
    assert.ok(demand.backfillTasks.some((t) => t.status === 'needs_approval'));
    assert.ok(!after.items.some((s) => s.isBackfill && s.status === 'invited'));
    const exceptions = await api<Array<{ type: string; status: string }>>(app.base, 'GET', '/api/manager/exceptions', undefined, token);
    assert.ok(exceptions.data.some((e) => e.type === 'backfill_budget_exceeded' && e.status === 'open'));

    // Manager approval converts the over-budget candidate into a real invitation;
    // the part-timer still has to accept before it counts as confirmed.
    const task = demand.backfillTasks.find((t) => t.status === 'needs_approval')!;
    const approved = await api<{ status: string; shift_id: string }>(app.base, 'POST', `/api/manager/backfill/${task.id}/approve`, {}, token);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'offered');
    const approvedShift = get<{ hourly_rate: number; status: string; is_backfill: number }>(
      app.db,
      'SELECT hourly_rate, status, is_backfill FROM shifts WHERE id = ?',
      [approved.data.shift_id],
    )!;
    assert.ok(approvedShift.hourly_rate > 32);
    assert.equal(approvedShift.status, 'invited');
    assert.equal(approvedShift.is_backfill, 1);
    const committedStill = (await assignmentView(app, token)).demands[0].committed;
    assert.equal(committedStill, 0);
  } finally {
    await app.close();
  }
});
