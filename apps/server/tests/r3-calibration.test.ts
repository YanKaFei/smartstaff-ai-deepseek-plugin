import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, adminLogin, api } from './helpers.js';
import { analyzeCalibrationSamples, type CalibrationSample } from '../src/domain/calibrationAnalysis.js';
import { getStore, parseConfig } from '../src/domain/stores.js';

function sample(index: number, type: 'small' | 'medium' | 'large'): CalibrationSample {
  const day = index % 7;
  return {
    date: `2026-10-${String(20 + day).padStart(2, '0')}`,
    tableType: type,
    partySize: type === 'large' ? 8 : type === 'medium' ? 4 : 2,
    seatedAt: 1793000000000 + index * 3_600_000,
    leftAt: 1793000000000 + index * 3_600_000 + 80 * 60_000,
    serverInterventions: 3,
    grillMinutes: type === 'large' ? 30 : 20,
    serveMinutes: 10,
    plateChangeMinutes: 5,
    checkoutMinutes: 4,
    cleaningMinutes: 6,
    onDutyStaff: 3,
    predictedRequired: 5,
    actualRequired: index % 5 === 0 ? 6 : 5,
    overloaded: index % 5 === 0,
  };
}

test('R3 calibration: descriptive analysis reports MAE/bias but never auto-calibrates', async () => {
  const samples: CalibrationSample[] = [];
  const types = ['small', 'medium', 'large'] as const;
  for (let i = 0; i < 35; i += 1) samples.push(sample(i, types[i % 3]));
  const analysis = analyzeCalibrationSamples(samples);
  assert.equal(analysis.status, 'UNCALIBRATED');
  assert.equal(analysis.autoCalibrate, false);
  assert.equal(analysis.sampleCount, 35);
  assert.ok(analysis.distinctDays >= 7);
  assert.ok(analysis.byTableType.small >= 5);
  assert.ok(analysis.mae > 0);
  assert.ok(analysis.bias < 0);
  assert.equal(analysis.eligibility.eligibleForManualReview, true);

  const app = await freshApp();
  try {
    const admin = await adminLogin(app);
    const preview = await api<{ analysis: typeof analysis }>(
      app.base,
      'POST',
      `/api/admin/stores/${app.storeId}/service-calibration/analyze`,
      { samples },
      admin,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.analysis.status, 'UNCALIBRATED');
    const store = getStore(app.db, app.storeId);
    assert.equal(parseConfig(store).staffing.calibrationStatus, 'unverified');
  } finally {
    await app.close();
  }
});

test('R3 calibration: fewer than 30 samples is explicitly ineligible, not calibrated', async () => {
  const samples = [sample(1, 'small'), sample(2, 'medium')];
  const analysis = analyzeCalibrationSamples(samples);
  assert.equal(analysis.status, 'UNCALIBRATED');
  assert.equal(analysis.eligibility.minimumSampleMet, false);
  assert.equal(analysis.eligibility.eligibleForManualReview, false);
});
