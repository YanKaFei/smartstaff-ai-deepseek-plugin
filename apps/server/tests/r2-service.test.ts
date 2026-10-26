import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, adminLogin, api } from './helpers.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig, updateStoreConfig } from '../src/domain/stores.js';
import { storeNow, setClock } from '../src/domain/clock.js';

async function forecastWith(app: Awaited<ReturnType<typeof freshApp>>, patch: (c: ReturnType<typeof parseConfig>) => ReturnType<typeof parseConfig>) {
  const store = getStore(app.db, app.storeId);
  const base = parseConfig(store);
  updateStoreConfig(app.db, app.storeId, patch(base));
  const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
  setClock(app.db, app.storeId, { at: now });
  return generateForecast(app.db, app.storeId, app.cfg, { useAi: false, now });
}

test('R2 service model: legacy baseline, physical-table basis and minute model are distinct and explicit', async () => {
  const app = await freshApp();
  try {
    const legacy = await forecastWith(app, (c) => c);
    assert.equal(legacy.peakRequiredStaff, 8);
    assert.equal(legacy.peakGap, 5);
    assert.equal(legacy.model, 'legacy');
    assert.equal(legacy.capacityBasis, 'standard_equivalent');

    const physical = await forecastWith(app, (c) => ({
      ...c,
      staffing: { ...c.staffing, capacityModel: 'legacy', capacityBasis: 'physical_tables' },
    }));
    assert.equal(physical.model, 'legacy');
    assert.equal(physical.capacityBasis, 'physical_tables');
    assert.equal(physical.peakRequiredStaff, 6);
    assert.equal(physical.peakGap, 3);
    assert.ok(physical.peakRequiredStaff < legacy.peakRequiredStaff);

    const partial = await forecastWith(app, (c) => ({
      ...c,
      staffing: { ...c.staffing, capacityModel: 'service_minutes', serviceMode: 'partial', calibrationStatus: 'unverified' },
    }));
    assert.equal(partial.model, 'service_minutes');
    assert.equal(partial.serviceMode, 'partial');
    assert.ok(partial.peakRequiredStaff > legacy.peakRequiredStaff);
    assert.equal(partial.reliability, 'medium');
    assert.ok(partial.modelWarning?.includes('未'));

    const calibrated = await forecastWith(app, (c) => ({
      ...c,
      staffing: { ...c.staffing, capacityModel: 'service_minutes', serviceMode: 'partial', calibrationStatus: 'calibrated' },
    }));
    assert.equal(calibrated.reliability, 'high');
    assert.equal(calibrated.modelWarning, undefined);
  } finally {
    await app.close();
  }
});

test('R2 service model: full-assisted > partial > self-grill requirements', async () => {
  const app = await freshApp();
  try {
    const results: Array<{ mode: string; required: number; gap: number }> = [];
    for (const mode of ['full', 'partial', 'self'] as const) {
      const f = await forecastWith(app, (c) => ({
        ...c,
        staffing: { ...c.staffing, capacityModel: 'service_minutes', serviceMode: mode, calibrationStatus: 'unverified' },
      }));
      results.push({ mode, required: f.peakRequiredStaff, gap: f.peakGap });
    }
    assert.ok(results[0].required > results[1].required);
    assert.ok(results[1].required > results[2].required);
    assert.ok(results[0].gap > results[2].gap);
    assert.deepEqual(results.map((r) => r.mode), ['full', 'partial', 'self']);
  } finally {
    await app.close();
  }
});

test('R2 service model: raising per-table service minutes raises the requirement', async () => {
  const app = await freshApp();
  try {
    const low = await forecastWith(app, (c) => ({
      ...c,
      staffing: {
        ...c.staffing,
        capacityModel: 'service_minutes',
        serviceMinutes: { small: 8, medium: 14, large: 22 },
        calibrationStatus: 'unverified',
      },
    }));
    const high = await forecastWith(app, (c) => ({
      ...c,
      staffing: {
        ...c.staffing,
        capacityModel: 'service_minutes',
        serviceMinutes: { small: 24, medium: 44, large: 70 },
        calibrationStatus: 'unverified',
      },
    }));
    assert.ok(high.peakRequiredStaff > low.peakRequiredStaff);
    assert.ok((high.slots[0].workloadMinutes ?? 0) > (low.slots[0].workloadMinutes ?? 0));
  } finally {
    await app.close();
  }
});

test('R2 service model: calibrated status requires real-sample admin evidence and cannot be self-declared by the manager UI', async () => {
  const app = await freshApp();
  try {
    const manager = await managerLogin(app);
    const before = await api<{ config: ReturnType<typeof parseConfig> }>(app.base, 'GET', '/api/manager/store', undefined, manager);
    const config = before.data.config;
    const selfDeclared = await api(app.base, 'PATCH', '/api/manager/store/config', {
      config: { ...config, staffing: { ...config.staffing, calibrationStatus: 'calibrated' } },
    }, manager);
    assert.equal(selfDeclared.status, 400);
    assert.equal(selfDeclared.json.error?.code, 'CALIBRATION_EVIDENCE_REQUIRED');

    const admin = await adminLogin(app);
    const calibrated = await api<{ config: ReturnType<typeof parseConfig>; calibration: { sample_size: number } }>(
      app.base,
      'POST',
      `/api/admin/stores/${app.storeId}/service-calibration`,
      {
        sampleSize: 42,
        evidenceNote: '42 个真实服务班次的观察记录，含桌型、清台与结账时间',
        serviceMinutes: { small: 10, medium: 20, large: 30 },
        effectiveServiceMinutesPerSlot: 25,
      },
      admin,
    );
    assert.equal(calibrated.status, 200);
    assert.equal(calibrated.data.config.staffing.calibrationStatus, 'calibrated');
    assert.equal(calibrated.data.calibration.sample_size, 42);

    const now = Math.floor(storeNow(app.db, app.storeId) / 60_000) * 60_000;
    setClock(app.db, app.storeId, { at: now });
    const f = await generateForecast(app.db, app.storeId, app.cfg, { useAi: false, now });
    assert.equal(f.calibrationStatus, 'calibrated');
    assert.equal(f.reliability, 'high');
    assert.equal(f.modelWarning, undefined);

    const managerCfg = (await api<{ config: ReturnType<typeof parseConfig> }>(app.base, 'GET', '/api/manager/store', undefined, manager)).data.config;
    const same = await api(app.base, 'PATCH', '/api/manager/store/config', { config: managerCfg }, manager);
    assert.equal(same.status, 200);

    const changed = await api(app.base, 'PATCH', '/api/manager/store/config', {
      config: { ...managerCfg, staffing: { ...managerCfg.staffing, serviceMinutes: { small: 11, medium: 20, large: 30 } } },
    }, manager);
    assert.equal(changed.status, 400);
    assert.equal(changed.json.error?.code, 'CALIBRATION_EVIDENCE_REQUIRED');
  } finally {
    await app.close();
  }
});
