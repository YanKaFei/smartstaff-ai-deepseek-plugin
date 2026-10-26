import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshApp, adminLogin, api, type TestApp } from './helpers.js';
import { get } from '../src/lib/db.js';

const CSV = `store_code,business_date,event_time,table_type,party_size,queue_at,seat_at,checkout_at,leave_at,clean_at,on_duty_staff,manager_required,service_mode,actual_work_minutes,manager_sufficiency
K001,2026-10-26,18:00,small,2,18:00,18:10,19:10,19:20,19:30,3,4,partial,45,short
K001,2026-10-26,18:00,medium,4,18:05,18:20,19:30,19:40,19:50,3,4,partial,55,adequate
K001,2026-10-26,18:00,large,8,,18:30,20:00,20:10,20:20,3,4,partial,70,short
K001,2026-10-26,18:30,small,3,18:30,19:00,20:10,20:20,20:30,3,4,partial,50,adequate
K001,2026-10-26,19:00,medium,5,19:00,19:30,21:10,21:20,21:30,3,4,partial,60,adequate
K001,2026-10-26,19:30,large,7,19:30,20:00,22:10,22:20,22:30,3,4,partial,80,short
K001,2026-10-26,18:00,small,2,18:00,18:10,19:10,19:20,19:30,3,4,partial,45,short
K001,2026-10-26,20:00,small,2,20:20,20:00,20:10,19:50,20:30,3,4,partial,40,short
`;

async function importCsv(app: TestApp, token: string, csv = CSV, filename = 'simulated-import.csv') {
  const res = await api<{ importId: string; quality: Record<string, any> }>(
    app.base,
    'POST',
    `/api/admin/stores/${app.storeId}/data/import`,
    { filename, format: 'csv', content: csv, dataOrigin: 'SIMULATED' },
    token,
  );
  assert.equal(res.status, 200);
  return res.data;
}

test('R4 import: CSV quality separates valid, duplicate, invalid and missing fields', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const imported = await importCsv(app, admin);
    assert.equal(imported.quality.dataOrigin, 'SIMULATED');
    assert.equal(imported.quality.rowCount, 8);
    assert.equal(imported.quality.validCount, 6);
    assert.equal(imported.quality.duplicateCount, 1);
    assert.equal(imported.quality.invalidCount, 1);
    assert.ok(imported.quality.timeOrderIssues >= 1);
    assert.ok(imported.quality.missing.queueAt >= 1);
    assert.equal(imported.quality.note.includes('SIMULATED'), true);
    const list = await api<{ imports: Array<{ id: string; dataOrigin: string; validCount: number }> }>(
      app.base,
      'GET',
      `/api/admin/stores/${app.storeId}/data/imports`,
      undefined,
      admin,
    );
    assert.ok(list.data.imports.some((i) => i.id === imported.importId && i.dataOrigin === 'SIMULATED' && i.validCount === 6));
  } finally {
    await app.close();
  }
});

test('R4 replay: four model variants evaluate with no future leakage in input snapshots', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const imported = await importCsv(app, admin);
    const replay = await api<{ dataOrigin: string; runs: Array<{ runId: string; model: string; serviceMode: string; metrics: any }> }>(
      app.base,
      'POST',
      `/api/admin/stores/${app.storeId}/data/replay`,
      { importId: imported.importId },
      admin,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.dataOrigin, 'SIMULATED');
    assert.equal(replay.data.runs.length, 4);
    const keys = replay.data.runs.map((r) => `${r.model}:${r.serviceMode}`);
    assert.ok(keys.includes('legacy:partial'));
    assert.ok(keys.includes('service_minutes:partial'));
    assert.ok(keys.includes('service_minutes:full'));
    assert.ok(keys.includes('service_minutes:self'));
    for (const run of replay.data.runs) {
      assert.ok(run.metrics.evaluatedCount > 0);
      assert.ok(run.metrics.mae !== null);
      const tableCounts = ['small', 'medium', 'large', 'mixed'].reduce((sum, k) => sum + (run.metrics.byTableType[k]?.count ?? 0), 0);
      assert.ok(tableCounts >= 1);
    }
    const prediction = get<{ prediction_time: number; input_snapshot_json: string }>(
      app.db,
      'SELECT prediction_time, input_snapshot_json FROM replay_predictions WHERE run_id = ? ORDER BY prediction_time LIMIT 1',
      [replay.data.runs[0].runId],
    )!;
    const snapshot = JSON.parse(prediction.input_snapshot_json) as {
      tables: Array<{ seatedAt: number }>;
      queue: Array<{ joinedAt: number | null }>;
    };
    for (const table of snapshot.tables) assert.ok(table.seatedAt <= prediction.prediction_time);
    for (const q of snapshot.queue) assert.ok(q.joinedAt === null || q.joinedAt <= prediction.prediction_time);
    assert.ok(!prediction.input_snapshot_json.includes('futureObservationIds'));
  } finally {
    await app.close();
  }
});

test('R4 import: minimal XLSX is accepted through the same importer', async () => {
  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const base64 = readFileSync(new URL('./fixtures/sample-import.xlsx', import.meta.url)).toString('base64');
    const res = await api<{ quality: { dataOrigin: string; validCount: number; rowCount: number } }>(
      app.base,
      'POST',
      `/api/admin/stores/${app.storeId}/data/import`,
      { filename: 'simulated-import.xlsx', format: 'xlsx', contentBase64: base64, dataOrigin: 'SIMULATED' },
      admin,
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.quality.rowCount, 2);
    assert.equal(res.data.quality.validCount, 2);
    assert.equal(res.data.quality.dataOrigin, 'SIMULATED');
  } finally {
    await app.close();
  }
});
