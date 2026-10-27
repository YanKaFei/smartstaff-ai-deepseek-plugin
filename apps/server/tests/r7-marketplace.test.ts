import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, staffLogin, api, type TestApp } from './helpers.js';
import { createStore, finishOnboarding } from '../src/domain/stores.js';
import { createDemand } from '../src/domain/dispatch.js';
import { setClock, storeNow } from '../src/domain/clock.js';
import { createSession } from '../src/lib/auth.js';
import { id } from '../src/lib/ids.js';
import { run, get } from '../src/lib/db.js';

function secondStore(app: TestApp, now: number) {
  const org = get<{ organization_id: string }>(app.db, 'SELECT organization_id FROM stores WHERE id = ?', [app.storeId])!;
  const store = createStore(app.db, { name: '跨店烤肉 · 南山店', managerCode: 'K002', address: '南山测试路 2 号' });
  finishOnboarding(app.db, store.id);
  run(app.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [org.organization_id, store.id]);
  setClock(app.db, store.id, { at: now });
  const userId = id('usr');
  run(app.db, "INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)", [userId, 'manager', '跨店店长', null, null, store.id, null, 1, Date.now()]);
  const token = createSession(app.db, { id: userId, role: 'manager' }, store.id, app.cfg).accessToken;
  return { store, token };
}

function openDemand(app: TestApp, storeId: string, now: number, headcount = 1) {
  return createDemand(app.db, { storeId, planId: null, role: '烤肉辅助', startAt: now + 2 * 3_600_000, endAt: now + 3 * 3_600_000, headcount, hourlyRate: 32 });
}

test('R7 marketplace: staff sees cross-store openings, applies, manager approves and gets a confirmed shift', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const { store, token: managerToken } = secondStore(app, now);
    const demand = openDemand(app, store.id, now);
    const staffToken = await staffLogin(app, '13800000001');

    const market = await api<{ items: Array<{ id: string; store: { id: string; isHomeStore: boolean }; canApply: boolean; unfilled: number }> }>(app.base, 'GET', '/api/staff/opportunities', undefined, staffToken);
    assert.equal(market.status, 200);
    const opportunity = market.data.items.find((o) => o.id === demand.id);
    assert.ok(opportunity);
    assert.equal(opportunity!.store.isHomeStore, false);
    assert.equal(opportunity!.canApply, true);
    assert.equal(opportunity!.unfilled, 1);

    const applied = await api<{ application: { id: string; status: string } }>(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, { note: '可准时到店' }, staffToken);
    assert.equal(applied.status, 200);
    assert.equal(applied.data.application.status, 'pending');
    const duplicate = await api(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, {}, staffToken);
    assert.equal(duplicate.status, 409);

    const managerList = await api<{ items: Array<{ id: string; staff: { nickname: string }; demand: { unfilled: number } }> }>(app.base, 'GET', '/api/manager/applications', undefined, managerToken);
    assert.equal(managerList.status, 200);
    assert.equal(managerList.data.items[0].staff.nickname, '林小雨');
    const approved = await api<{ application: { status: string }; shift: { id: string; status: string } }>(app.base, 'POST', `/api/manager/applications/${applied.data.application.id}/approve`, { note: '欢迎' }, managerToken);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.application.status, 'approved');
    assert.equal(approved.data.shift.status, 'confirmed');
    const shift = get<{ status: string; store_id: string; staff_id: string }>(app.db, 'SELECT status, store_id, staff_id FROM shifts WHERE id = ?', [approved.data.shift.id])!;
    assert.equal(shift.status, 'confirmed');
    assert.equal(shift.store_id, store.id);
    const demandAfter = get<{ status: string }>(app.db, 'SELECT status FROM staffing_demands WHERE id = ?', [demand.id])!;
    assert.equal(demandAfter.status, 'filled');
    const myApps = await api<{ items: Array<{ status: string }> }>(app.base, 'GET', '/api/staff/applications', undefined, staffToken);
    assert.equal(myApps.data.items[0].status, 'approved');
  } finally {
    await app.close();
  }
});

test('R7 marketplace: manager can reject an application without creating a shift', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const { store, token: managerToken } = secondStore(app, now);
    const demand = openDemand(app, store.id, now);
    const staffToken = await staffLogin(app, '13800000001');
    const applied = await api<{ application: { id: string } }>(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, {}, staffToken);
    const rejected = await api<{ application: { status: string }; shift: unknown }>(app.base, 'POST', `/api/manager/applications/${applied.data.application.id}/reject`, { note: '排班不匹配' }, managerToken);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.application.status, 'rejected');
    assert.equal(rejected.data.shift, null);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM shifts WHERE demand_id = ?', [demand.id])!.n, 0);
  } finally {
    await app.close();
  }
});

test('R7 marketplace: pending staff cannot apply and duplicate applications are blocked', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const { store } = secondStore(app, now);
    const demand = openDemand(app, store.id, now);
    const pendingToken = await staffLogin(app, '13800000012');
    const blocked = await api(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, {}, pendingToken);
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error?.message ?? '', /审核/);
  } finally {
    await app.close();
  }
});

test('R7 marketplace: staff can withdraw a pending application and re-apply', async () => {
  const app = await freshApp();
  try {
    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const { store } = secondStore(app, now);
    const demand = openDemand(app, store.id, now);
    const staffToken = await staffLogin(app, '13800000001');
    const first = await api<{ application: { id: string } }>(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, {}, staffToken);
    const withdrawn = await api<{ application: { status: string } }>(app.base, 'POST', `/api/staff/applications/${first.data.application.id}/withdraw`, {}, staffToken);
    assert.equal(withdrawn.data.application.status, 'withdrawn');
    const again = await api<{ application: { status: string } }>(app.base, 'POST', `/api/staff/opportunities/${demand.id}/apply`, { note: '再次申请' }, staffToken);
    assert.equal(again.status, 200);
    assert.equal(again.data.application.status, 'pending');
  } finally {
    await app.close();
  }
});
