import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { getStore, parseConfig, updateStoreConfig } from './stores.js';
import { audit } from './notify.js';
import type { StoreConfig } from './types.js';

export interface ServiceCalibrationInput {
  sampleSize: number;
  evidenceNote: string;
  serviceMode?: StoreConfig['staffing']['serviceMode'];
  serviceMinutes?: StoreConfig['staffing']['serviceMinutes'];
  effectiveServiceMinutesPerSlot?: number;
}

export interface CalibrationRow {
  id: string;
  store_id: string;
  sample_size: number;
  source: string;
  evidence_note: string;
  parameters_json: string;
  created_by: string | null;
  created_at: number;
  active: number;
}

function calibrationParams(staffing: StoreConfig['staffing']) {
  return {
    serviceMode: staffing.serviceMode,
    serviceMinutes: staffing.serviceMinutes,
    effectiveServiceMinutesPerSlot: staffing.effectiveServiceMinutesPerSlot,
  };
}

function sameParams(a: ReturnType<typeof calibrationParams>, b: ReturnType<typeof calibrationParams>): boolean {
  return (
    a.serviceMode === b.serviceMode &&
    a.serviceMinutes.small === b.serviceMinutes.small &&
    a.serviceMinutes.medium === b.serviceMinutes.medium &&
    a.serviceMinutes.large === b.serviceMinutes.large &&
    a.effectiveServiceMinutesPerSlot === b.effectiveServiceMinutesPerSlot
  );
}

export function latestCalibration(db: Db, storeId: string): CalibrationRow | null {
  return (
    get<CalibrationRow>(
      db,
      'SELECT * FROM service_calibrations WHERE store_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
      [storeId],
    ) ?? null
  );
}

export function calibrationMatches(
  db: Db,
  storeId: string,
  staffing: StoreConfig['staffing'],
): boolean {
  const row = latestCalibration(db, storeId);
  if (!row) return false;
  try {
    const stored = JSON.parse(row.parameters_json) as ReturnType<typeof calibrationParams>;
    return sameParams(stored, calibrationParams(staffing));
  } catch {
    return false;
  }
}

/**
 * Records calibration evidence from real observations. This does not derive
 * parameters from simulation; the caller must supply the observed parameters
 * and an evidence note. The setup UI cannot mark a store calibrated without it.
 */
export function recordServiceCalibration(
  db: Db,
  storeId: string,
  input: ServiceCalibrationInput,
  actorId: string,
): { calibration: CalibrationRow; config: StoreConfig } {
  if (input.sampleSize < 30) throw new AppError(400, 'CALIBRATION_SAMPLE_TOO_SMALL', '至少需要 30 个真实服务样本');
  if (input.evidenceNote.trim().length < 10) throw new AppError(400, 'CALIBRATION_EVIDENCE_REQUIRED', '请填写真实观测证据说明');
  const store = getStore(db, storeId);
  const base = parseConfig(store);
  const serviceMinutes = input.serviceMinutes
    ? {
        small: Math.max(1, Math.min(120, input.serviceMinutes.small)),
        medium: Math.max(1, Math.min(120, input.serviceMinutes.medium)),
        large: Math.max(1, Math.min(120, input.serviceMinutes.large)),
      }
    : base.staffing.serviceMinutes;
  const effective = Math.max(5, Math.min(30, input.effectiveServiceMinutesPerSlot ?? base.staffing.effectiveServiceMinutesPerSlot));
  const next: StoreConfig = {
    ...base,
    staffing: {
      ...base.staffing,
      capacityModel: 'service_minutes',
      serviceMode: input.serviceMode ?? base.staffing.serviceMode,
      serviceMinutes,
      effectiveServiceMinutesPerSlot: effective,
      calibrationStatus: 'calibrated',
    },
  };
  const params = calibrationParams(next.staffing);
  // updateStoreConfig opens its own transaction; keep this sequence outside a
  // nested transaction and roll the evidence row back if the config write fails.
  run(db, 'UPDATE service_calibrations SET active = 0 WHERE store_id = ? AND active = 1', [storeId]);
  const calibrationId = id('cal');
  run(
    db,
    `INSERT INTO service_calibrations(id, store_id, sample_size, source, evidence_note, parameters_json, created_by, created_at, active)
     VALUES(?,?,?,?,?,?,?,?,1)`,
    [calibrationId, storeId, input.sampleSize, 'real_observations', input.evidenceNote.trim(), JSON.stringify(params), actorId, Date.now()],
  );
  try {
    updateStoreConfig(db, storeId, next);
  } catch (err) {
    run(db, 'DELETE FROM service_calibrations WHERE id = ?', [calibrationId]);
    throw err;
  }
  audit(db, {
    storeId,
    actorId,
    actorRole: 'admin',
    action: 'service.calibrate',
    entity: 'service_calibration',
    entityId: calibrationId,
    detail: { sampleSize: input.sampleSize, parameters: params, evidenceNote: input.evidenceNote.trim() },
    at: Date.now(),
  });
  return {
    calibration: get<CalibrationRow>(db, 'SELECT * FROM service_calibrations WHERE id = ?', [calibrationId])!,
    config: parseConfig(getStore(db, storeId)),
  };
}

export function listServiceCalibrations(db: Db, storeId: string) {
  return all<CalibrationRow>(
    db,
    'SELECT * FROM service_calibrations WHERE store_id = ? ORDER BY created_at DESC LIMIT 20',
    [storeId],
  );
}
