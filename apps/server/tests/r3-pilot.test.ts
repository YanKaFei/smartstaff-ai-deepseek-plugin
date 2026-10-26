import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, api, type TestApp } from './helpers.js';
import { getStore, parseConfig, updateStoreConfig } from '../src/domain/stores.js';
import { setClock, storeNow } from '../src/domain/clock.js';
import { get } from '../src/lib/db.js';

async function plansFor(app: TestApp) {
  const token = await managerLogin(app);
  const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
  setClock(app.db, app.storeId, { at: now });
  await api(app.base, 'POST', '/api/manager/today/confirm', {}, token);
  await api(app.base, 'POST', '/api/manager/forecast', { useAi: false }, token);
  const res = await api<{ plans: Array<{ id: string; headcount: number }> }>(app.base, 'POST', '/api/manager/plans', {}, token);
  return { token, plan: res.data.plans[0] };
}

function setShadow(app: TestApp, shadowMode: boolean) {
  const store = getStore(app.db, app.storeId);
  const cfg = parseConfig(store);
  updateStoreConfig(app.db, app.storeId, { ...cfg, pilot: { shadowMode } });
}

test('R3 pilot: shadow mode records recommendations but creates zero offers, shifts, demands or staff notifications', async () => {
  const app = await freshApp();
  try {
    const { token, plan } = await plansFor(app);
    setShadow(app, true);
    const beforeOffers = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM job_offers')!.n;
    const confirmed = await api<{ shadow: boolean; offersCreated: number; shifts: unknown[]; shadowRunId: string }>(
      app.base,
      'POST',
      `/api/manager/plans/${plan.id}/confirm`,
      {},
      token,
    );
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.shadow, true);
    assert.equal(confirmed.data.offersCreated, 0);
    assert.deepEqual(confirmed.data.shifts, []);
    assert.ok(confirmed.data.shadowRunId);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM job_offers')!.n, beforeOffers);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM shifts')!.n, 0);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM staffing_demands')!.n, 0);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM shadow_runs')!.n, 1);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM notifications')!.n, 0);
    const planRow = get<{ status: string; shadow: number }>(app.db, 'SELECT status, shadow FROM assignment_plans WHERE id = ?', [plan.id])!;
    assert.equal(planRow.status, 'confirmed');
    assert.equal(planRow.shadow, 1);

    const feedback = await api<{ error: number }>(app.base, 'POST', '/api/manager/pilot/feedback', {
      shadowRunId: confirmed.data.shadowRunId,
      recommended: 5,
      managerActual: 6,
      onDuty: 3,
      overloaded: true,
      decision: 'too_few',
      reasons: ['高峰排队更严重', '店长现场判断'],
      correction: '建议增至 6 人',
      notes: '实际比建议多一人',
    }, token);
    assert.equal(feedback.status, 200);
    assert.equal(feedback.data.error, -1);
    const metric = await api(app.base, 'POST', '/api/manager/pilot/ux-metric', {
      flow: 'pilot_home_to_dispatch',
      actionCount: 4,
      elapsedMs: 38000,
      planId: plan.id,
      shadow: true,
    }, token);
    assert.equal(metric.status, 200);
    assert.ok(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM pilot_ux_metrics')!.n >= 1);
    const summary = await api<{ control: { paused: boolean }; shadowRuns: unknown[]; feedback: { count: number; mae: number; bias: number } }>(
      app.base,
      'GET',
      '/api/manager/pilot/summary',
      undefined,
      token,
    );
    assert.equal(summary.data.control.paused, false);
    assert.equal(summary.data.shadowRuns.length, 1);
    assert.equal(summary.data.feedback.count, 1);
    assert.equal(summary.data.feedback.mae, 1);
    assert.equal(summary.data.feedback.bias, -1);
    assert.equal(summary.data.feedback.decisions.too_few, 1);
  } finally {
    await app.close();
  }
});

test('R3 pilot: emergency pause cancels pending invitations, blocks confirmation, and resume restores dispatch', async () => {
  const app = await freshApp();
  try {
    const { token, plan } = await plansFor(app);
    const paused = await api<{ control: { dispatch_paused: number }; cancelledOffers: number }>(
      app.base,
      'POST',
      '/api/manager/pilot/pause',
      { reason: '现场设备故障', cancelPending: true },
      token,
    );
    assert.equal(paused.status, 200);
    assert.equal(paused.data.control.dispatch_paused, 1);
    const blocked = await api(app.base, 'POST', `/api/manager/plans/${plan.id}/confirm`, {}, token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error?.code, 'PILOT_DISPATCH_PAUSED');
    const activeOffers = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM job_offers WHERE status IN ('pending','accepted')")!.n;
    assert.equal(activeOffers, 0);

    const resumed = await api(app.base, 'POST', '/api/manager/pilot/resume', {}, token);
    assert.equal(resumed.status, 200);
    const confirmed = await api<{ offersCreated: number; shadow: boolean }>(app.base, 'POST', `/api/manager/plans/${plan.id}/confirm`, {}, token);
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.data.offersCreated > 0);
    assert.ok(!confirmed.data.shadow);
  } finally {
    await app.close();
  }
});
