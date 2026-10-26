import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, api, type TestApp } from './helpers.js';
import { get } from '../src/lib/db.js';

function iso(date: string, time: string) { return `${date}T${time}:00+08:00`; }

function eventCsv(types: Array<'small' | 'medium' | 'large'>): string {
  const lines = ['pilot_id,store_code,business_date,event_id,event_type,occurred_at,table_label,table_type,party_size,staff_role,staff_anonymous_id,call_no,service_mode,on_duty_staff,manager_sufficiency'];
  const date = '2026-10-01';
  types.forEach((type, idx) => {
    const table = `${type.toUpperCase()}-${idx}`;
    const party = type === 'large' ? 8 : type === 'medium' ? 4 : 2;
    const prefix = `${date}-${idx}`;
    lines.push(`R5-TYPES,K001,${date},${prefix}-q,queue_join,${iso(date, '18:00')},${table},${type},${party},server,S01,1,partial,3,adequate`);
    lines.push(`R5-TYPES,K001,${date},${prefix}-seat,seat,${iso(date, '18:10')},${table},${type},${party},server,S01,,partial,3,adequate`);
    lines.push(`R5-TYPES,K001,${date},${prefix}-out,checkout,${iso(date, '21:50')},${table},${type},${party},server,S01,,partial,3,adequate`);
    lines.push(`R5-TYPES,K001,${date},${prefix}-leave,leave,${iso(date, '22:20')},${table},${type},${party},server,S01,,partial,3,adequate`);
    lines.push(`R5-TYPES,K001,${date},${prefix}-clean,clean,${iso(date, '22:30')},${table},${type},${party},server,S01,,partial,3,adequate`);
  });
  return lines.join('\n');
}

async function replayFor(app: TestApp, types: Array<'small' | 'medium' | 'large'>) {
  const admin = await adminLogin(app);
  const pilot = await api<{ id: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/pilots`, {
    anonymousCode: `R5-TYPES-${types.join('-')}`, serviceMode: 'partial', hoursStart: '16:00', hoursEnd: '02:00',
    tableConfig: { small: 8, medium: 12, large: 4 }, staffing: { onDuty: 3 }, roles: ['server'],
    dataSources: ['simulated'], owner: 'pilot-owner', startDate: '2026-10-01', endDate: '2026-10-01',
  }, admin);
  await api(app.base, 'POST', `/api/admin/pilots/${pilot.data.id}/authorize`, { owner: 'pilot-owner' }, admin);
  const imported = await api<{ sessionImportId: string }>(app.base, 'POST', `/api/admin/pilots/${pilot.data.id}/events/import`, {
    filename: 'types.csv', format: 'csv', content: eventCsv(types), dataOrigin: 'SIMULATED',
  }, admin);
  assert.equal(imported.status, 200);
  const replay = await api<{ runs: Array<{ runId: string; metrics: any }> }>(app.base, 'POST', `/api/admin/pilots/${pilot.data.id}/replay`, {}, admin);
  assert.equal(replay.status, 200);
  const run = replay.data.runs[0];
  const prediction = get<{ input_snapshot_json: string }>(app.db, 'SELECT input_snapshot_json FROM replay_predictions WHERE run_id = ? ORDER BY prediction_time LIMIT 1', [run.runId])!;
  return { metrics: run.metrics, snapshot: JSON.parse(prediction.input_snapshot_json) as { activeTableCounts: Record<string, number> } };
}

for (const type of ['small', 'medium', 'large'] as const) {
  test(`R5.1 table detail: pure ${type} replay keeps exact counts and per-type metrics`, async () => {
    const app = await freshApp();
    try {
      const { metrics, snapshot } = await replayFor(app, [type]);
      assert.equal(snapshot.activeTableCounts[type], 1);
      for (const other of ['small', 'medium', 'large'].filter((t) => t !== type)) assert.equal(snapshot.activeTableCounts[other], 0);
      assert.ok(metrics.byTableType[type].count >= 1);
      assert.equal(metrics.byTableType.mixed.count, 0);
      assert.equal(metrics.tableCounts[type], 1 * metrics.evaluatedCount);
    } finally {
      await app.close();
    }
  });
}

test('R5.1 table detail: mixed replay keeps small/medium/large counts and labels mixed without losing detail', async () => {
  const app = await freshApp();
  try {
    const { metrics, snapshot } = await replayFor(app, ['small', 'medium', 'large']);
    assert.equal(snapshot.activeTableCounts.small, 1);
    assert.equal(snapshot.activeTableCounts.medium, 1);
    assert.equal(snapshot.activeTableCounts.large, 1);
    assert.equal(metrics.byTableType.mixed.count, metrics.evaluatedCount);
    assert.equal(metrics.tableCounts.small, metrics.evaluatedCount);
    assert.equal(metrics.tableCounts.medium, metrics.evaluatedCount);
    assert.equal(metrics.tableCounts.large, metrics.evaluatedCount);
  } finally {
    await app.close();
  }
});
