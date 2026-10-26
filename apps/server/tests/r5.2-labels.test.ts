import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, api, type TestApp } from './helpers.js';
import { get } from '../src/lib/db.js';

function iso(time: string) { return `2026-10-01T${time}:00+08:00`; }

function sessionCsv(opts: { managerRequired?: boolean; rows?: number; onDuty?: number; values?: number[] } = {}): string {
  const withRequired = Boolean(opts.managerRequired);
  const header = `store_code,business_date,event_time,table_type,party_size,queue_at,seat_at,checkout_at,leave_at,clean_at,on_duty_staff,${withRequired ? 'manager_required,manager_required_reason,' : ''}service_mode,actual_work_minutes,manager_sufficiency`;
  const rows: string[] = [header];
  const count = opts.rows ?? 6;
  for (let i = 0; i < count; i += 1) {
    const type = i % 3 === 0 ? 'small' : i % 3 === 1 ? 'medium' : 'large';
    const party = type === 'large' ? 8 : type === 'medium' ? 4 : 2;
    const req = opts.values?.[i % (opts.values.length)] ?? 5;
    rows.push(`K001,2026-10-01,18:00,${type},${party},${iso('18:00')},${iso('18:10')},${iso('21:50')},${iso('22:20')},${iso('22:30')},${opts.onDuty ?? 3},${withRequired ? `${req},晚市高峰需要,` : ''}partial,45,short`);
  }
  return rows.join('\n');
}

async function importAndReplay(app: TestApp, content: string) {
  const admin = await adminLogin(app);
  const imported = await api<{ importId: string }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/data/import`, {
    filename: 'labels.csv', format: 'csv', content, dataOrigin: 'SIMULATED',
  }, admin);
  assert.equal(imported.status, 200);
  const replay = await api<{ runs: Array<{ runId: string; metrics: any }> }>(app.base, 'POST', `/api/admin/stores/${app.storeId}/data/replay`, { importId: imported.data.importId }, admin);
  assert.equal(replay.status, 200);
  const prediction = get<{ actual_json: string }>(app.db, 'SELECT actual_json FROM replay_predictions WHERE run_id = ? ORDER BY prediction_time LIMIT 1', [replay.data.runs[0].runId])!;
  return { metrics: replay.data.runs[0].metrics, actual: JSON.parse(prediction.actual_json) };
}

test('R5.2 labels: short without explicit manager_required is NOT_EVALUABLE, never on-duty+1', async () => {
  const app = await freshApp();
  try {
    const { metrics, actual } = await importAndReplay(app, sessionCsv({ managerRequired: false }));
    assert.equal(actual.labelStatus, 'NOT_EVALUABLE');
    assert.equal(actual.required, null);
    assert.equal(actual.actualOnDuty, 3);
    assert.equal(actual.qualitativeShortage, true);
    assert.equal(metrics.evaluatedCount, 0);
    assert.equal(metrics.notEvaluableCount > 0, true);
    assert.equal(metrics.mae, null);
    assert.equal(metrics.bias, null);
    assert.equal(metrics.understaffedPersonHours, null);
    assert.ok(metrics.actualShortageCount > 0);
    // 缺员风险仍可评价；本场景预测缺口为 0，因此识别率为 0。
    assert.equal(metrics.shortageRiskDetectionRate, 0);
  } finally {
    await app.close();
  }
});

test('R5.2 labels: explicit manager_required is the only MAE ground truth', async () => {
  const app = await freshApp();
  try {
    const { metrics, actual } = await importAndReplay(app, sessionCsv({ managerRequired: true, values: [5] }));
    assert.equal(actual.labelStatus, 'MANAGER_EXPLICIT');
    assert.equal(actual.required, 5);
    assert.equal(actual.managerRequiredValues[0], 5);
    assert.deepEqual(actual.managerRequiredReasons, ['晚市高峰需要']);
    assert.ok(metrics.evaluatedCount > 0);
    assert.ok(metrics.mae !== null);
    assert.ok(metrics.understaffedPersonHours !== null);
    assert.equal(metrics.notEvaluableCount, 0);
  } finally {
    await app.close();
  }
});

test('R5.2 labels: conflicting manager_required is NOT_EVALUABLE instead of inventing a number', async () => {
  const app = await freshApp();
  try {
    const { metrics, actual } = await importAndReplay(app, sessionCsv({ managerRequired: true, values: [4, 6] }));
    assert.equal(actual.labelStatus, 'CONFLICTING_MANAGER_REQUIRED');
    assert.equal(actual.required, null);
    assert.equal(metrics.evaluatedCount, 0);
    assert.equal(metrics.mae, null);
  } finally {
    await app.close();
  }
});

test('R5.2 labels: qualitative shortage risk can be detected even when numeric MAE is NOT_EVALUABLE', async () => {
  const app = await freshApp();
  try {
    const { metrics, actual } = await importAndReplay(app, sessionCsv({ managerRequired: false, rows: 10, onDuty: 1 }));
    assert.equal(actual.labelStatus, 'NOT_EVALUABLE');
    assert.equal(actual.required, null);
    assert.equal(actual.qualitativeShortage, true);
    assert.equal(metrics.evaluatedCount, 0);
    assert.equal(metrics.mae, null);
    assert.ok(metrics.actualShortageCount > 0);
    assert.equal(metrics.shortageRiskDetectionRate, 1);
  } finally {
    await app.close();
  }
});
