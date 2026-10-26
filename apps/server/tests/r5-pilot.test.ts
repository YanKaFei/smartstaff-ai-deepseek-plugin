import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, api, type TestApp } from './helpers.js';
import { get } from '../src/lib/db.js';

function iso(date: string, time: string) { return `${date}T${time}:00+08:00`; }

function eventsCsv(): string {
  const lines = ['pilot_id,store_code,business_date,event_id,event_type,occurred_at,table_label,table_type,party_size,staff_role,staff_anonymous_id,call_no,service_mode,on_duty_staff,manager_sufficiency'];
  for (let d = 0; d < 14; d += 1) {
    const date = `2026-10-${String(1 + d).padStart(2, '0')}`;
    for (const [idx, table, type, party, leave, sufficiency] of [
      [1, 'S1', 'small', 2, '22:20', 'short'],
      [2, 'M1', 'medium', 4, '22:20', 'adequate'],
    ] as Array<[number, string, string, number, string, string]>) {
      const prefix = `${date}-${idx}`;
      lines.push(`R5-PILOT-001,K001,${date},${prefix}-q,queue_join,${iso(date, '18:00')},${table},${type},${party},server,S01,1,partial,3,${sufficiency}`);
      lines.push(`R5-PILOT-001,K001,${date},${prefix}-seat,seat,${iso(date, idx === 1 ? '18:10' : '18:20')},${table},${type},${party},server,S01,,partial,3,${sufficiency}`);
      lines.push(`R5-PILOT-001,K001,${date},${prefix}-checkout,checkout,${iso(date, '21:50')},${table},${type},${party},server,S01,,partial,3,${sufficiency}`);
      lines.push(`R5-PILOT-001,K001,${date},${prefix}-leave,leave,${iso(date, leave)},${table},${type},${party},server,S01,,partial,3,${sufficiency}`);
      lines.push(`R5-PILOT-001,K001,${date},${prefix}-clean,clean,${iso(date, '22:30')},${table},${type},${party},server,S01,,partial,3,${sufficiency}`);
    }
  }
  // duplicate event: should be counted but not inserted twice
  lines.push(`R5-PILOT-001,K001,2026-10-01,2026-10-01-1-seat,seat,${iso('2026-10-01', '18:10')},S1,small,2,server,S01,,partial,3,short`);
  return lines.join('\n');
}

const WORKLOAD = `pilot_id,store_code,observation_id,staff_role,service_mode,table_type,action,start_at,end_at,minutes,business_date
R5-PILOT-001,K001,w1,server,partial,small,greet,2026-10-01T18:10:00+08:00,2026-10-01T18:15:00+08:00,5,2026-10-01
R5-PILOT-001,K001,w2,server,partial,small,grill,2026-10-01T18:15:00+08:00,2026-10-01T18:35:00+08:00,20,2026-10-01
R5-PILOT-001,K001,w3,server,partial,medium,serve,2026-10-01T18:30:00+08:00,2026-10-01T18:40:00+08:00,10,2026-10-01
R5-PILOT-001,K001,w1,server,partial,small,greet,2026-10-01T18:10:00+08:00,2026-10-01T18:15:00+08:00,5,2026-10-01
R5-PILOT-001,K001,w4,server,partial,large,call 13800000000,2026-10-01T18:40:00+08:00,2026-10-01T18:45:00+08:00,5,2026-10-01
`;

async function createPilot(app: TestApp, admin: string) {
  const res = await api<{ id: string; authorizationStatus: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/pilots`, {
    anonymousCode: 'R5-PILOT-001',
    serviceMode: 'partial',
    hoursStart: '16:00',
    hoursEnd: '02:00',
    tableConfig: { small: 8, medium: 12, large: 4 },
    staffing: { onDuty: 3 },
    roles: ['server', 'grill'],
    dataSources: ['paper_event_sheet'],
    coverageStart: '2026-10-01',
    coverageEnd: '2026-10-14',
    owner: 'pilot-owner',
    startDate: '2026-10-01',
    endDate: '2026-10-14',
  }, admin);
  assert.equal(res.status, 200);
  assert.equal(res.data.authorizationStatus, 'pending');
  return res.data.id;
}

test('R5 pilot: authorized archive gates event/workload import, quality and workload analysis', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const pilotId = await createPilot(app, admin);
    const before = await api(app.base, 'POST', `/api/admin/pilots/${pilotId}/events/import`, {
      filename: 'events.csv', format: 'csv', content: eventsCsv(), dataOrigin: 'SIMULATED',
    }, admin);
    assert.equal(before.status, 403);
    assert.equal(before.json.error?.code, 'PILOT_NOT_AUTHORIZED');

    const authorized = await api(app.base, 'POST', `/api/admin/pilots/${pilotId}/authorize`, {
      owner: 'pilot-owner', coverageStart: '2026-10-01', coverageEnd: '2026-10-14',
    }, admin);
    assert.equal(authorized.status, 200);
    const events = await api<{ sessionCount: number; quality: any }>(app.base, 'POST', `/api/admin/pilots/${pilotId}/events/import`, {
      filename: 'events.csv', format: 'csv', content: eventsCsv(), dataOrigin: 'SIMULATED',
    }, admin);
    assert.equal(events.status, 200);
    assert.equal(events.data.sessionCount, 28);
    assert.equal(events.data.quality.duplicateCount, 1);
    assert.equal(events.data.quality.dataOrigin, 'SIMULATED');

    const workload = await api<{ quality: any }>(app.base, 'POST', `/api/admin/pilots/${pilotId}/workload/import`, {
      filename: 'workload.csv', format: 'csv', content: WORKLOAD, dataOrigin: 'SIMULATED',
    }, admin);
    assert.equal(workload.status, 200);
    assert.equal(workload.data.quality.duplicateCount, 1);
    assert.equal(workload.data.quality.piiRows, 1);
    const analysis = await api<{ sampleCount: number; totalMinutes: number; status: string }>(app.base, 'GET', `/api/admin/pilots/${pilotId}/workload-analysis`, undefined, admin);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.data.sampleCount, 3);
    assert.equal(analysis.data.totalMinutes, 35);
    assert.equal(analysis.data.status, 'ENGINEERING_VERIFIED');
    const quality = await api<{ totals: { validEvents: number; validWorkloadRows: number } }>(app.base, 'GET', `/api/admin/pilots/${pilotId}/data-quality`, undefined, admin);
    assert.equal(quality.status, 200);
    assert.equal(quality.data.totals.validWorkloadRows, 3);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM job_offers')!.n, 0);
    assert.equal(get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM shifts')!.n, 0);
  } finally {
    await app.close();
  }
});

test('R5 pilot: 14-day replay marks calibration vs validation, keeps snapshots future-free, and reports insufficient sample when short', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const pilotId = await createPilot(app, admin);
    await api(app.base, 'POST', `/api/admin/pilots/${pilotId}/authorize`, { owner: 'pilot-owner' }, admin);
    const events = await api<{ sessionImportId: string }>(app.base, 'POST', `/api/admin/pilots/${pilotId}/events/import`, {
      filename: 'events.csv', format: 'csv', content: eventsCsv(), dataOrigin: 'SIMULATED',
    }, admin);
    assert.equal(events.status, 200);
    const replay = await api<{ runs: Array<{ runId: string; metrics: any }> }>(app.base, 'POST', `/api/admin/pilots/${pilotId}/replay`, {}, admin);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.runs.length, 4);
    const metrics = replay.data.runs[0].metrics;
    assert.equal(metrics.splitDate, '2026-10-07');
    assert.equal(metrics.distinctDays, 14);
    assert.equal(metrics.insufficientData, false);
    assert.ok(metrics.phases.calibration.evaluatedCount > 0);
    assert.ok(metrics.phases.validation.evaluatedCount > 0);
    assert.ok(metrics.estimatedExtraLaborCost >= 0);
    const prediction = get<{ prediction_time: number; phase: string; input_snapshot_json: string }>(
      app.db,
      'SELECT prediction_time, phase, input_snapshot_json FROM replay_predictions WHERE run_id = ? ORDER BY prediction_time LIMIT 1',
      [replay.data.runs[0].runId],
    )!;
    assert.ok(['calibration', 'validation'].includes(prediction.phase));
    const snapshot = JSON.parse(prediction.input_snapshot_json) as { tables: Array<{ seatedAt: number }>; queue: Array<{ joinedAt: number | null }> };
    for (const table of snapshot.tables) assert.ok(table.seatedAt <= prediction.prediction_time);
    for (const q of snapshot.queue) assert.ok(q.joinedAt === null || q.joinedAt <= prediction.prediction_time);
    assert.ok(!prediction.input_snapshot_json.includes('futureObservationIds'));

    const report = await api<{ status: string; dataOrigin: string; actualOnDuty: number }>(app.base, 'GET', `/api/admin/pilots/${pilotId}/daily-report?date=2026-10-01`, undefined, admin);
    assert.equal(report.status, 200);
    assert.equal(report.data.status, 'SIMULATED_ONLY');
    assert.equal(report.data.dataOrigin, 'SIMULATED');
    assert.equal(report.data.actualOnDuty, 3);
  } finally {
    await app.close();
  }
});
