import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, staffLogin, api, type TestApp } from './helpers.js';
import { storeNow } from '../src/domain/clock.js';
import { setClock } from '../src/domain/clock.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig, updateStoreConfig } from '../src/domain/stores.js';
import { all, get } from '../src/lib/db.js';

interface AssignmentView {
  items: Array<{ id: string; staffId: string; staffName: string; status: string; offerStatus: string | null; offer: { attempt: number; status: string } | null }>;
  groups: Record<string, number>;
}

async function preparePlan(app: TestApp) {
  const token = await managerLogin(app);
  await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
  const now = storeNow(app.db, app.storeId);
  setClock(app.db, app.storeId, { at: now });
  const forecast = await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
  assert.equal(forecast.status, 200);
  const plans = await api<{ plans: Array<{ id: string; items: Array<{ staffId: string; nickname: string }> }>; needsStaff: boolean }>(
    app.base,
    'POST',
    '/api/manager/plans',
    {},
    token,
  );
  assert.equal(plans.status, 200);
  const plan = plans.data.plans[0];
  assert.ok(plan);
  const confirmed = await api<{ offersCreated: number }>(app.base, 'POST', `/api/manager/plans/${plan.id}/confirm`, {}, token);
  assert.equal(confirmed.status, 200);
  return { token, now, plan, offersCreated: confirmed.data.offersCreated };
}

async function offersFor(app: TestApp, phone: string) {
  const token = await staffLogin(app, phone);
  const offers = await api<{ items: Array<{ id: string; status: string; shift: { id: string; staffName: string } }> }>(
    app.base,
    'GET',
    '/api/staff/offers',
    undefined,
    token,
  );
  return { token, offers: offers.data.items };
}

test('R1 algorithm: seeded scene explains the 5-person gap slot by slot', async () => {
  const app = await freshApp();
  try {
    const store = getStore(app.db, app.storeId);
    const config = parseConfig(store);
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const f = await generateForecast(app.db, app.storeId, app.cfg, { useAi: false, now });
    assert.equal(f.peakRequiredStaff, 8);
    assert.equal(f.peakGap, 5);
    assert.equal(f.bottleneck, 'staff');
    assert.equal(f.reliability, 'high');
    assert.equal(f.gapRanges.length, 1);
    assert.equal(f.gapRanges[0].headcount, 5);
    assert.equal(f.slots.length, 6);
    assert.deepEqual(f.slots.map((s) => s.requiredStaff), [8, 8, 7, 8, 8, 7]);
    assert.deepEqual(f.slots.map((s) => s.gap), [5, 5, 4, 5, 5, 4]);

    const slot = f.slots[0];
    const tableLoad =
      slot.projectedOccupied.small * config.tables.small.weight +
      slot.projectedOccupied.medium * config.tables.medium.weight +
      slot.projectedOccupied.large * config.tables.large.weight;
    const queueLoad = Math.round(slot.projectedQueueGroups * 0.2 * 100) / 100;
    assert.equal(Math.round(tableLoad * 10) / 10, 36.8);
    assert.equal(queueLoad, 2.4);
    assert.equal(Math.round((tableLoad + queueLoad) * 10) / 10, slot.weightedLoad);
    assert.equal(Math.ceil(slot.weightedLoad / config.staffing.tablesPerStaff), slot.requiredStaff);
    assert.equal(slot.requiredStaff - slot.onDutyStaff, slot.gap);
    assert.equal(f.reliabilityReason.includes('3 次叫号'), true);
  } finally {
    await app.close();
  }
});

test('R1 algorithm: service modes swing the requirement by ±2 staff and the current semantics are ambiguous', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const store = getStore(app.db, app.storeId);
    const baseConfig = parseConfig(store);
    const modes = [
      { label: 'full', tablesPerStaff: 4, expectedRequired: 10, expectedGap: 7 },
      { label: 'partial', tablesPerStaff: 5, expectedRequired: 8, expectedGap: 5 },
      { label: 'self', tablesPerStaff: 7, expectedRequired: 6, expectedGap: 3 },
    ];
    const results: Array<{ label: string; required: number; gap: number; rawRequired: number }> = [];
    for (const mode of modes) {
      updateStoreConfig(app.db, app.storeId, {
        ...baseConfig,
        staffing: { ...baseConfig.staffing, tablesPerStaff: mode.tablesPerStaff },
      });
      const f = await generateForecast(app.db, app.storeId, app.cfg, { useAi: false, now });
      assert.equal(f.peakRequiredStaff, mode.expectedRequired);
      assert.equal(f.peakGap, mode.expectedGap);
      results.push({
        label: mode.label,
        required: f.peakRequiredStaff,
        gap: f.peakGap,
        rawRequired: Math.ceil(f.slots[0].projectedActiveTables / mode.tablesPerStaff),
      });
    }
    assert.ok(results[0].required > results[1].required && results[1].required > results[2].required);
    // The same parameter can be read as "physical tables per staff"; that reading yields 5, not 8.
    assert.equal(results[1].rawRequired, 5);
    assert.notEqual(results[1].rawRequired, results[1].required);
  } finally {
    await app.close();
  }
});

test('R1 dispatch: sent invitations, accepted, checked-in and completed are counted separately', async () => {
  const app = await freshApp();
  try {
    const { token } = await preparePlan(app);
    const before = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(before.data.groups.pending, 5);
    assert.equal(before.data.groups.confirmed, 0);
    assert.equal(before.data.groups.checkedIn, 0);
    const dbBefore = {
      invited: (get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM shifts WHERE status='invited'")!).n,
      confirmed: (get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM shifts WHERE status='confirmed'")!).n,
      acceptedOffers: (get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status='accepted'")!).n,
    };
    assert.equal(dbBefore.invited, 5);
    assert.equal(dbBefore.confirmed, 0);
    assert.equal(dbBefore.acceptedOffers, 0);

    // The invitation must be visible to the part-timer as an offer and an in-app message.
    const { token: staffToken, offers } = await offersFor(app, '13800000001');
    const pending = offers.find((o) => o.status === 'pending');
    assert.ok(pending);
    const notifications = await api<Array<{ type: string; title: string }>>(
      app.base,
      'GET',
      '/api/staff/notifications',
      undefined,
      staffToken,
    );
    assert.ok(notifications.data.some((n) => n.type === 'offer'));

    const accepted = await api(app.base, 'POST', `/api/staff/offers/${pending.id}/accept`, {}, staffToken);
    assert.equal(accepted.status, 200);
    const afterAccept = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(afterAccept.data.groups.pending, 4);
    assert.equal(afterAccept.data.groups.confirmed, 1);
    assert.equal(afterAccept.data.groups.checkedIn, 0);

    const checkedIn = await api(
      app.base,
      'POST',
      `/api/staff/shifts/${pending.shift.id}/checkin`,
      { storeCode: 'K001' },
      staffToken,
    );
    assert.equal(checkedIn.status, 200);
    const afterCheckin = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(afterCheckin.data.groups.checkedIn, 1);
    assert.equal(afterCheckin.data.groups.confirmed, 0);
  } finally {
    await app.close();
  }
});

test('R1 dispatch: rejection and timeout keep the shift open and count only a successful accept', async () => {
  const app = await freshApp();
  try {
    const { token } = await preparePlan(app);
    const { token: staffToken, offers } = await offersFor(app, '13800000006'); // 吴思远
    const pending = offers.find((o) => o.status === 'pending');
    assert.ok(pending);
    const reject = await api(app.base, 'POST', `/api/staff/offers/${pending.id}/reject`, { reason: '临时有事' }, staffToken);
    assert.equal(reject.status, 200);

    const afterReject = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(afterReject.data.groups.pending, 5); // the shift remains open with a successor
    assert.equal(afterReject.data.groups.confirmed, 0);
    const sameShift = afterReject.data.items.find((s) => s.staffName !== '吴思远' && s.offer?.attempt === 2);
    assert.ok(sameShift);

    await api(app.base, 'POST', '/api/manager/sim/advance', { minutes: 11 }, token);
    const afterTimeout = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(afterTimeout.data.groups.confirmed, 0);
    assert.ok(afterTimeout.data.items.some((s) => (s.offer?.attempt ?? 0) >= 2));
    const expired = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status='expired'")!;
    assert.ok(expired.n >= 1);
  } finally {
    await app.close();
  }
});

test('R1 dispatch: concurrent accepts produce one winner; a second staff can take another shift', async () => {
  const app = await freshApp();
  try {
    const { token } = await preparePlan(app);
    const { token: linToken, offers: linOffers } = await offersFor(app, '13800000001');
    const linPending = linOffers.find((o) => o.status === 'pending');
    assert.ok(linPending);
    const [a, b] = await Promise.all([
      api(app.base, 'POST', `/api/staff/offers/${linPending.id}/accept`, {}, linToken),
      api(app.base, 'POST', `/api/staff/offers/${linPending.id}/accept`, {}, linToken),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const acceptedOffers = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status='accepted'")!;
    assert.equal(acceptedOffers.n, 1);

    const { token: chenToken, offers: chenOffers } = await offersFor(app, '13800000002');
    const chenPending = chenOffers.find((o) => o.status === 'pending');
    assert.ok(chenPending);
    const chenAccept = await api(app.base, 'POST', `/api/staff/offers/${chenPending.id}/accept`, {}, chenToken);
    assert.equal(chenAccept.status, 200);
    const after = await api<AssignmentView>(app.base, 'GET', '/api/manager/assignments', undefined, token);
    assert.equal(after.data.groups.confirmed, 2);
    assert.equal(after.data.groups.pending, 3);
  } finally {
    await app.close();
  }
});

test('R1 dispatch: manager cancellation/no-show update state; staff cancellation route now exists', async () => {
  const app = await freshApp();
  try {
    const { token } = await preparePlan(app);
    const { token: linToken, offers: linOffers } = await offersFor(app, '13800000001');
    const linPending = linOffers.find((o) => o.status === 'pending');
    assert.ok(linPending);
    await api(app.base, 'POST', `/api/staff/offers/${linPending.id}/accept`, {}, linToken);

    const cancel = await api(app.base, 'POST', `/api/manager/assignments/${linPending.shift.id}/cancel`, { reason: '临时取消' }, token);
    assert.equal(cancel.status, 200);
    const shiftAfterCancel = get<{ status: string }>(app.db, 'SELECT status FROM shifts WHERE id = ?', [linPending.shift.id])!;
    assert.equal(shiftAfterCancel.status, 'cancelled');
    // No automatic replacement is created after an accepted shift is cancelled.
    const offersForShift = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM job_offers WHERE shift_id = ?', [linPending.shift.id])!;
    assert.equal(offersForShift.n, 1);
    // R2 adds self-service cancellation; this shift is already cancelled, so it must conflict.
    const selfCancel = await api(app.base, 'POST', `/api/staff/shifts/${linPending.shift.id}/cancel`, { reason: '临时有事' }, linToken);
    assert.equal(selfCancel.status, 409);

    const { token: chenToken, offers: chenOffers } = await offersFor(app, '13800000002');
    const chenPending = chenOffers.find((o) => o.status === 'pending');
    assert.ok(chenPending);
    await api(app.base, 'POST', `/api/staff/offers/${chenPending.id}/accept`, {}, chenToken);
    const noShow = await api(app.base, 'POST', `/api/manager/assignments/${chenPending.shift.id}/no-show`, { note: '未到店' }, token);
    assert.equal(noShow.status, 200);
    const shiftAfterNoShow = get<{ status: string }>(app.db, 'SELECT status FROM shifts WHERE id = ?', [chenPending.shift.id])!;
    assert.equal(shiftAfterNoShow.status, 'no_show');
    const offersForNoShow = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM job_offers WHERE shift_id = ?', [chenPending.shift.id])!;
    assert.equal(offersForNoShow.n, 1); // no automatic backfill
    const exceptions = await api<Array<{ type: string; status: string }>>(app.base, 'GET', '/api/manager/exceptions', undefined, token);
    assert.ok(exceptions.data.some((e) => e.type === 'no_show' && e.status === 'open'));
    // R2 fix: cancelled/no-show shifts must not leave an accepted offer terminal state.
    const acceptedRows = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status='accepted'")!;
    assert.equal(acceptedRows.n, 0);
  } finally {
    await app.close();
  }
});

test('R1 operations: second login restores the store and confirmation is idempotent', async () => {
  const app = await freshApp();
  try {
    const token = await managerLogin(app);
    const first = await api<{ businessDay: { status: string; onDutyStaff: number }; store: { onboarded: boolean } }>(
      app.base,
      'POST',
      '/api/manager/today/confirm',
      {},
      token,
    );
    assert.equal(first.status, 200);
    assert.equal(first.data.businessDay.status, 'confirmed');
    assert.equal(first.data.store.onboarded, true);
    const second = await api<{ businessDay: { status: string; onDutyStaff: number } }>(
      app.base,
      'POST',
      '/api/manager/today/confirm',
      {},
      token,
    );
    assert.equal(second.data.businessDay.status, 'confirmed');
    assert.equal(second.data.businessDay.onDutyStaff, 3);
    const days = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM business_days')!;
    assert.equal(days.n, 8); // 7 historical closed days + today, not duplicated
    const freshSession = await managerLogin(app);
    const today = await api<{ businessDay: { status: string; onDutyStaff: number } }>(app.base, 'GET', '/api/manager/today', undefined, freshSession);
    assert.equal(today.data.businessDay.status, 'confirmed');
    assert.equal(today.data.businessDay.onDutyStaff, 3);
  } finally {
    await app.close();
  }
});

test('R1 security: demo credentials work by possession only and default admin password is active', async () => {
  const app = await freshApp();
  try {
    const adminDefault = await api(app.base, 'POST', '/api/auth/admin-login', { password: 'test-admin' });
    assert.equal(adminDefault.status, 200);
    // Any caller who knows the store code becomes a manager; any caller who knows a phone becomes that staff member.
    const manager = await api(app.base, 'POST', '/api/auth/mini-login', { role: 'manager', storeCode: 'K001', name: '任意人' });
    assert.equal(manager.status, 200);
    const staff = await api<{ staff: { nickname: string } }>(app.base, 'POST', '/api/auth/mini-login', {
      role: 'staff',
      storeCode: 'K001',
      phone: '13800000001',
      name: '冒名者',
    });
    assert.equal(staff.status, 200);
    assert.equal(staff.data.staff.nickname, '林小雨');
    const staffToken = staff.data.token as string;
    const managerEndpoint = await api(app.base, 'GET', '/api/manager/today', undefined, staffToken);
    assert.equal(managerEndpoint.status, 403);
  } finally {
    await app.close();
  }
});
