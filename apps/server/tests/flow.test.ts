import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, staffLogin, adminLogin, api, type TestApp } from './helpers.js';
import { createOfferForShift } from '../src/domain/dispatch.js';
interface ApiShift {
  id: string;
  status: string;
  actualMinutes: number | null;
  payAmount: number | null;
  managerConfirmed: boolean;
  checkedInAt: number | null;
  staffName: string;
}

interface PlanBundle {
  needsStaff: boolean;
  message: string;
  plans: Array<{
    id: string;
    planType: string;
    items: Array<{ staffId: string; nickname: string; startAt: number; endAt: number; hourlyRate: number; alternatives: Array<{ staffId: string }> }>;
    totalCost: number;
    shortage: unknown[];
  }>;
}

interface AssignmentView {
  items: Array<{ id: string; staffId: string; staffName: string; status: string; offerStatus: string | null; offer: { attempt: number; status: string; id: string } | null }>;
  groups: Record<string, number>;
}

async function driveToOffers(app: TestApp) {
  const token = await managerLogin(app);
  const today = await api(app.base, 'GET', '/api/manager/today', undefined, token);
  assert.equal(today.status, 200);
  await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
  const forecast = await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
  assert.equal(forecast.status, 200);
  const bundle = await api<PlanBundle>(app.base, 'POST', '/api/manager/plans', {}, token);
  assert.equal(bundle.status, 200);
  const plan = bundle.data.plans[0];
  assert.ok(plan);
  const confirmed = await api<{ offersCreated: number; shifts: Array<{ shiftId: string }> }>(
    app.base,
    'POST',
    `/api/manager/plans/${plan.id}/confirm`,
    {},
    token,
  );
  assert.equal(confirmed.status, 200);
  return { token, plan, confirmed: confirmed.data };
}

test('e2e: confirm day -> forecast -> plans -> offer -> accept -> check-in -> checkout -> completion', async () => {
  const app = await freshApp();
  try {
    const { token, confirmed } = await driveToOffers(app);
    assert.ok(confirmed.offersCreated >= 4, `expected offers, got ${confirmed.offersCreated}`);

    const staffToken = await staffLogin(app, '13800000001');
    const offers = await api<{ items: Array<{ id: string; status: string; shift: { id: string; staffName: string } }> }>(
      app.base,
      'GET',
      '/api/staff/offers',
      undefined,
      staffToken,
    );
    const pending = offers.data.items.find((o) => o.status === 'pending');
    assert.ok(pending, '林小雨 should receive an offer');
    assert.equal(pending.shift.staffName, '林小雨');

    const accepted = await api<{ shift: ApiShift }>(app.base, 'POST', `/api/staff/offers/${pending.id}/accept`, {}, staffToken);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.shift.status, 'confirmed');

    const shiftId = accepted.data.shift.id;
    const checkedIn = await api<ApiShift>(app.base, 'POST', `/api/staff/shifts/${shiftId}/checkin`, { storeCode: 'K001' }, staffToken);
    assert.equal(checkedIn.status, 200);
    assert.equal(checkedIn.data.status, 'checked_in');

    const advanced = await api<{ summary: { arrivals: number; seated: number; checkout: number; cleaned: number }; status: { nowLabel: string } }>(
      app.base,
      'POST',
      '/api/manager/sim/advance',
      { minutes: 60 },
      token,
    );
    assert.equal(advanced.status, 200);
    assert.ok(advanced.data.summary.arrivals > 0);
    assert.ok(advanced.data.summary.seated > 0);

    const checkout = await api<ApiShift>(app.base, 'POST', `/api/staff/shifts/${shiftId}/checkout`, {}, staffToken);
    assert.equal(checkout.status, 200);
    assert.equal(checkout.data.status, 'completed');
    assert.ok((checkout.data.actualMinutes ?? 0) >= 55);
    assert.ok((checkout.data.payAmount ?? 0) > 20);

    const completion = await api<ApiShift>(
      app.base,
      'POST',
      `/api/manager/assignments/${shiftId}/confirm-completion`,
      {},
      token,
    );
    assert.equal(completion.status, 200);
    assert.equal(completion.data.managerConfirmed, true);

    const assignments = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.ok(assignments.data.groups.completed >= 1);

    const audit = app.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('shift.check_in','shift.check_out','plan.confirm')").get() as { n: number };
    assert.ok(audit.n >= 3);

    const forecastRows = app.db.prepare('SELECT COUNT(*) AS n FROM forecasts').get() as { n: number };
    assert.ok(forecastRows.n >= 2, 'simulation should have refreshed the forecast');
  } finally {
    await app.close();
  }
});

test('dispatch: rejecting an offer automatically falls back to the next candidate', async () => {
  const app = await freshApp();
  try {
    const { token } = await driveToOffers(app);
    const assignments = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const first = assignments.data.items.find((s) => s.status === 'invited');
    assert.ok(first);

    const staffToken = await staffLogin(app, '13800000006'); // 吴思远
    const offers = await api<{ items: Array<{ id: string; status: string }> }>(app.base, 'GET', '/api/staff/offers', undefined, staffToken);
    const pending = offers.data.items.find((o) => o.status === 'pending');
    assert.ok(pending);
    const rejected = await api(app.base, 'POST', `/api/staff/offers/${pending.id}/reject`, { reason: '临时有事' }, staffToken);
    assert.equal(rejected.status, 200);

    const after = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const sameShift = after.data.items.find((s) => s.id === first.id);
    assert.ok(sameShift);
    assert.equal(sameShift.status, 'invited');
    assert.notEqual(sameShift.staffId, first.staffId);
    assert.ok((sameShift.offer?.attempt ?? 0) >= 2);

    const exceptions = await api<Array<{ type: string }>>(app.base, 'GET', '/api/manager/exceptions', undefined, token);
    assert.equal(exceptions.data.filter((e) => e.type === 'no_candidate').length, 0);
  } finally {
    await app.close();
  }
});

test('dispatch: unanswered offers expire on simulated time and fall back', async () => {
  const app = await freshApp();
  try {
    const { token } = await driveToOffers(app);
    await api(app.base, 'POST', '/api/manager/sim/advance', { minutes: 11 }, token);
    const assignments = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const invited = assignments.data.items.filter((s) => s.status === 'invited');
    assert.ok(invited.length > 0);
    assert.ok(invited.some((s) => (s.offer?.attempt ?? 0) >= 2));
    assert.ok(invited.every((s) => s.offer?.status === 'pending'));
  } finally {
    await app.close();
  }
});

test('dispatch: no remaining candidate cancels the shift and raises a manager exception', async () => {
  const app = await freshApp();
  try {
    const { token } = await driveToOffers(app);
    const assignments = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const first = assignments.data.items.find((s) => s.status === 'invited');
    assert.ok(first);
    // Remove every other candidate from the pool; the rejected shift has nowhere to go.
    app.db.prepare("UPDATE staff_profiles SET status = 'suspended' WHERE id != ?").run(first.staffId);
    const staffToken = await staffLogin(app, '13800000006');
    const offers = await api<{ items: Array<{ id: string; status: string }> }>(app.base, 'GET', '/api/staff/offers', undefined, staffToken);
    const pending = offers.data.items.find((o) => o.status === 'pending');
    assert.ok(pending);
    await api(app.base, 'POST', `/api/staff/offers/${pending.id}/reject`, { reason: '临时有事' }, staffToken);

    const after = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const shift = after.data.items.find((s) => s.id === first.id);
    assert.equal(shift?.status, 'cancelled');
    const exceptions = await api<Array<{ type: string; status: string; message: string }>>(
      app.base,
      'GET',
      '/api/manager/exceptions',
      undefined,
      token,
    );
    assert.ok(exceptions.data.some((e) => e.type === 'no_candidate' && e.status === 'open'));
  } finally {
    await app.close();
  }
});

test('concurrency: only one accept wins and overlapping shifts are blocked', async () => {
  const app = await freshApp();
  try {
    const { token, confirmed } = await driveToOffers(app);
    assert.ok(confirmed.offersCreated >= 2);
    const assignments = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    const first = assignments.data.items.find((s) => s.status === 'invited' && s.staffName === '林小雨');
    assert.ok(first);
    const staffToken = await staffLogin(app, '13800000001');
    const offers = await api<{ items: Array<{ id: string; status: string }> }>(app.base, 'GET', '/api/staff/offers', undefined, staffToken);
    const pending = offers.data.items.find((o) => o.status === 'pending');
    assert.ok(pending);

    const [a, b] = await Promise.all([
      api(app.base, 'POST', `/api/staff/offers/${pending.id}/accept`, {}, staffToken),
      api(app.base, 'POST', `/api/staff/offers/${pending.id}/accept`, {}, staffToken),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const shift = app.db.prepare('SELECT * FROM shifts WHERE id = ?').get(first.id) as {
      staff_id: string;
      start_at: number;
      end_at: number;
      status: string;
    };
    assert.throws(() =>
      createOfferForShift(app.db, {
        storeId: app.storeId,
        staffId: shift.staff_id,
        startAt: shift.start_at + 30 * 60_000,
        endAt: shift.end_at,
        hourlyRate: 30,
        role: '烤肉辅助',
        now: shift.start_at - 60 * 60_000,
      }),
    );
  } finally {
    await app.close();
  }
});

test('security: role isolation, cross-user access and input validation', async () => {
  const app = await freshApp();
  try {
    const managerToken = await managerLogin(app);
    const staffToken = await staffLogin(app, '13800000001');
    const adminToken = await adminLogin(app);

    const staffToManager = await api(app.base, 'GET', '/api/manager/today', undefined, staffToken);
    assert.equal(staffToManager.status, 403);
    const managerToAdmin = await api(app.base, 'GET', '/api/admin/staff', undefined, managerToken);
    assert.equal(managerToAdmin.status, 403);
    const noToken = await api(app.base, 'GET', '/api/manager/today');
    assert.equal(noToken.status, 401);
    const wrongPassword = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'nope' });
    assert.equal(wrongPassword.status, 401);
    const adminOverview = await api(app.base, 'GET', '/api/admin/overview', undefined, adminToken);
    assert.equal(adminOverview.status, 200);

    // A staff member must not act on another person's offer.
    const { token } = await driveToOffers(app);
    const otherStaff = await staffLogin(app, '13800000003');
    const otherOffers = await api<{ items: Array<{ id: string; status: string; shift: { staffName: string } }> }>(
      app.base,
      'GET',
      '/api/staff/offers',
      undefined,
      otherStaff,
    );
    const foreign = otherOffers.data.items.find((o) => o.status === 'pending');
    if (foreign) {
      const steal = await api(app.base, 'POST', `/api/staff/offers/${foreign.id}/accept`, {}, staffToken);
      assert.equal(steal.status, 403);
    }
    assert.ok(token);

    const badConfig = await api(app.base, 'PATCH', '/api/manager/store/config', { config: { basic: {} } }, managerToken);
    assert.equal(badConfig.status, 400);
    const badOps = await api(app.base, 'POST', '/api/manager/ops', { type: 'checkout', tableId: 'nope' }, managerToken);
    assert.equal(badOps.status, 404);
  } finally {
    await app.close();
  }
});

test('admin: staff registration requires training and approval before matching', async () => {
  const app = await freshApp();
  try {
    const adminToken = await adminLogin(app);
    const staff = await api<{ token: string; staff: { id: string; status: string; qualified: boolean } }>(
      app.base,
      'POST',
      '/api/auth/mini-login',
      { role: 'staff', storeCode: 'K001', phone: '13900000099', name: '新兼职' },
    );
    assert.equal(staff.status, 200);
    assert.equal(staff.data.staff.status, 'pending');
    assert.equal(staff.data.staff.qualified, false);

    const approveWithoutTraining = await api(
      app.base,
      'POST',
      `/api/admin/staff/${staff.data.staff.id}/review`,
      { status: 'approved' },
      adminToken,
    );
    assert.equal(approveWithoutTraining.status, 409);

    const train = await api(
      app.base,
      'POST',
      `/api/admin/staff/${staff.data.staff.id}/review`,
      { qualified: true },
      adminToken,
    );
    assert.equal(train.status, 200);
    const approve = await api(
      app.base,
      'POST',
      `/api/admin/staff/${staff.data.staff.id}/review`,
      { status: 'approved', qualified: true },
      adminToken,
    );
    assert.equal(approve.status, 200);
    assert.equal((approve.data as { staff: { status: string } }).staff.status, 'approved');
  } finally {
    await app.close();
  }
});

test('plans: candidate replacement is validated and reflected before confirmation', async () => {
  const app = await freshApp();
  try {
    const token = await managerLogin(app);
    await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
    await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
    const bundle = await api<PlanBundle>(app.base, 'POST', '/api/manager/plans', {}, token);
    const plan = bundle.data.plans.find((p) => p.planType === 'economic')!;
    const item = plan.items[0];
    const alt = item.alternatives[0];
    assert.ok(alt);
    const replaced = await api<{ items: Array<{ staffId: string; hourlyRate: number }>; totalCost: number }>(
      app.base,
      'POST',
      `/api/manager/plans/${plan.id}/replace`,
      { staffId: item.staffId, startAt: item.startAt, replacementStaffId: alt.staffId },
      token,
    );
    assert.equal(replaced.status, 200);
    const updated = replaced.data.items.find((i) => i.staffId === alt.staffId);
    assert.ok(updated);

    const invalid = await api(
      app.base,
      'POST',
      `/api/manager/plans/${plan.id}/replace`,
      { staffId: alt.staffId, startAt: item.startAt, replacementStaffId: 'staff_missing' },
      token,
    );
    assert.equal(invalid.status, 404);

    const confirmed = await api<{ offersCreated: number }>(app.base, 'POST', `/api/manager/plans/${plan.id}/confirm`, {}, token);
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.data.offersCreated > 0);
  } finally {
    await app.close();
  }
});

test('plans: insufficient candidates are shown as a shortage and cannot be confirmed', async () => {
  const app = await freshApp();
  try {
    const token = await managerLogin(app);
    await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
    app.db.prepare("UPDATE staff_profiles SET status = 'suspended'").run();
    await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
    const bundle = await api<PlanBundle>(app.base, 'POST', '/api/manager/plans', {}, token);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.data.needsStaff, true);
    assert.ok(bundle.data.plans.length >= 1);
    for (const plan of bundle.data.plans) {
      assert.equal(plan.items.length, 0);
      assert.ok(plan.shortage.length >= 1);
    }
    const confirm = await api(app.base, 'POST', `/api/manager/plans/${bundle.data.plans[0].id}/confirm`, {}, token);
    assert.equal(confirm.status, 409);
    assert.ok(String(confirm.json.error?.message).includes('没有可执行'));
  } finally {
    await app.close();
  }
});

test('ai failure: DeepSeek outage falls back while forecast and dispatch still work', async () => {
  const app = await freshApp({
    deepseek: { apiKey: 'broken-key', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-flash', timeoutMs: 500 },
  });
  try {
    const token = await managerLogin(app);
    await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
    const result = await api<{ forecast: { aiStatus: string; aiError?: string; peakGap: number; ai: { summary: string } } }>(
      app.base,
      'POST',
      '/api/manager/forecast',
      { useAi: true },
      token,
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.forecast.aiStatus, 'fallback');
    assert.ok(result.data.forecast.aiError);
    assert.ok(result.data.forecast.peakGap > 0);
    assert.ok(result.data.forecast.ai.summary.includes('缺口'));
  } finally {
    await app.close();
  }
});

test('onboarding: a new store can be created and configured, isolating its data', async () => {
  const app = await freshApp();
  try {
    const created = await api<{ token: string; store: { id: string; onboardedAt: number | null; managerCode: string } }>(
      app.base,
      'POST',
      '/api/auth/register-store',
      { storeName: '测试烤肉新店', managerCode: 'K900', managerName: '李店长' },
    );
    assert.equal(created.status, 200);
    assert.equal(created.data.store.onboardedAt, null);
    const token = created.data.token;

    const store = await api<{ config: Record<string, unknown> }>(app.base, 'GET', '/api/manager/store', undefined, token);
    const cfg = store.data.config as {
      basic: { name: string; address: string; hourlyRate: number };
      tables: { small: { count: number } };
      staffing: { onDutyCount: number };
      matching: Record<string, number>;
      dataSource: string;
      [key: string]: unknown;
    };
    cfg.basic.name = '测试烤肉新店';
    cfg.basic.address = '测试地址 1 号';
    const patched = await api(app.base, 'PATCH', '/api/manager/store/config', { config: cfg, step: 4 }, token);
    assert.equal(patched.status, 200);
    const finished = await api(app.base, 'POST', '/api/manager/onboarding/finish', {}, token);
    assert.equal(finished.status, 200);
    assert.ok((finished.data as { store: { onboardedAt: number } }).store.onboardedAt);

    const today = await api<{ store: { id: string }; queue: { groups: number }; businessDay: { status: string } }>(
      app.base,
      'GET',
      '/api/manager/today',
      undefined,
      token,
    );
    assert.equal(today.status, 200);
    assert.equal(today.data.store.id, created.data.store.id);
    assert.notEqual(today.data.store.id, app.storeId);
    assert.equal(today.data.businessDay.status, 'draft');
    assert.equal(today.data.queue.groups, 0);
  } finally {
    await app.close();
  }
});
