import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { audit } from './notify.js';
import { getStore } from './stores.js';

export interface PilotInput {
  anonymousCode: string;
  serviceMode: 'full' | 'partial' | 'self';
  hoursStart: string;
  hoursEnd: string;
  tableConfig?: unknown;
  staffing?: unknown;
  roles?: string[];
  dataSources?: string[];
  coverageStart?: string;
  coverageEnd?: string;
  owner?: string;
  startDate?: string;
  endDate?: string;
  authorizationStatus?: 'pending' | 'authorized' | 'revoked';
}

export interface PilotRow {
  id: string;
  store_id: string;
  anonymous_code: string;
  service_mode: string;
  hours_start: string;
  hours_end: string;
  table_config_json: string;
  staffing_json: string;
  roles_json: string;
  data_sources_json: string;
  coverage_start: string | null;
  coverage_end: string | null;
  authorization_status: string;
  owner: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: number;
  updated_at: number;
}

function serialize(row: PilotRow) {
  return {
    id: row.id,
    storeId: row.store_id,
    anonymousCode: row.anonymous_code,
    serviceMode: row.service_mode,
    hours: { start: row.hours_start, end: row.hours_end },
    tableConfig: JSON.parse(row.table_config_json),
    staffing: JSON.parse(row.staffing_json),
    roles: JSON.parse(row.roles_json),
    dataSources: JSON.parse(row.data_sources_json),
    coverage: { start: row.coverage_start, end: row.coverage_end },
    authorizationStatus: row.authorization_status,
    owner: row.owner,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateNoPii(value: string | undefined, field: string): void {
  if (!value) return;
  if (/\b1[3-9]\d{9}\b/.test(value) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)) {
    throw new AppError(400, 'PII_NOT_ALLOWED', `${field} 不能包含手机号或邮箱`);
  }
}

export function createPilot(db: Db, storeId: string, input: PilotInput, actorId: string) {
  const store = getStore(db, storeId);
  validateNoPii(input.owner, 'owner');
  if (!input.anonymousCode.trim()) throw new AppError(400, 'PILOT_CODE_REQUIRED', '缺少匿名门店编号');
  if (get(db, 'SELECT id FROM pilot_profiles WHERE anonymous_code = ?', [input.anonymousCode.trim()])) {
    throw new AppError(409, 'PILOT_CODE_TAKEN', '匿名编号已存在');
  }
  const now = Date.now();
  const pilotId = id('pilot');
  run(
    db,
    `INSERT INTO pilot_profiles(id, store_id, anonymous_code, service_mode, hours_start, hours_end, table_config_json, staffing_json, roles_json, data_sources_json, coverage_start, coverage_end, authorization_status, owner, start_date, end_date, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      pilotId, store.id, input.anonymousCode.trim(), input.serviceMode,
      input.hoursStart, input.hoursEnd, JSON.stringify(input.tableConfig ?? {}), JSON.stringify(input.staffing ?? {}),
      JSON.stringify(input.roles ?? []), JSON.stringify(input.dataSources ?? []), input.coverageStart ?? null, input.coverageEnd ?? null,
      input.authorizationStatus ?? 'pending', input.owner?.trim() ?? null, input.startDate ?? null, input.endDate ?? null, now, now,
    ],
  );
  audit(db, { storeId, actorId, actorRole: 'admin', action: 'pilot.create', entity: 'pilot', entityId: pilotId, detail: { anonymousCode: input.anonymousCode }, at: now });
  return getPilot(db, pilotId);
}

export function getPilot(db: Db, pilotId: string) {
  const row = get<PilotRow>(db, 'SELECT * FROM pilot_profiles WHERE id = ?', [pilotId]);
  if (!row) throw new AppError(404, 'PILOT_NOT_FOUND', '试点档案不存在');
  return serialize(row);
}

export function listPilots(db: Db, storeId: string) {
  return all<PilotRow>(db, 'SELECT * FROM pilot_profiles WHERE store_id = ? ORDER BY created_at DESC', [storeId]).map(serialize);
}

export function updatePilot(db: Db, pilotId: string, patch: Partial<PilotInput>, actorId: string) {
  const row = get<PilotRow>(db, 'SELECT * FROM pilot_profiles WHERE id = ?', [pilotId]);
  if (!row) throw new AppError(404, 'PILOT_NOT_FOUND', '试点档案不存在');
  validateNoPii(patch.owner, 'owner');
  const next: PilotInput = {
    anonymousCode: patch.anonymousCode ?? row.anonymous_code,
    serviceMode: (patch.serviceMode ?? row.service_mode) as PilotInput['serviceMode'],
    hoursStart: patch.hoursStart ?? row.hours_start,
    hoursEnd: patch.hoursEnd ?? row.hours_end,
    tableConfig: patch.tableConfig ?? JSON.parse(row.table_config_json),
    staffing: patch.staffing ?? JSON.parse(row.staffing_json),
    roles: patch.roles ?? JSON.parse(row.roles_json),
    dataSources: patch.dataSources ?? JSON.parse(row.data_sources_json),
    coverageStart: patch.coverageStart ?? row.coverage_start ?? undefined,
    coverageEnd: patch.coverageEnd ?? row.coverage_end ?? undefined,
    owner: patch.owner ?? row.owner ?? undefined,
    startDate: patch.startDate ?? row.start_date ?? undefined,
    endDate: patch.endDate ?? row.end_date ?? undefined,
    authorizationStatus: patch.authorizationStatus ?? row.authorization_status as PilotInput['authorizationStatus'],
  };
  const now = Date.now();
  run(
    db,
    `UPDATE pilot_profiles SET anonymous_code=?, service_mode=?, hours_start=?, hours_end=?, table_config_json=?, staffing_json=?, roles_json=?, data_sources_json=?, coverage_start=?, coverage_end=?, authorization_status=?, owner=?, start_date=?, end_date=?, updated_at=? WHERE id=?`,
    [next.anonymousCode, next.serviceMode, next.hoursStart, next.hoursEnd, JSON.stringify(next.tableConfig), JSON.stringify(next.staffing), JSON.stringify(next.roles), JSON.stringify(next.dataSources), next.coverageStart ?? null, next.coverageEnd ?? null, next.authorizationStatus ?? 'pending', next.owner ?? null, next.startDate ?? null, next.endDate ?? null, now, pilotId],
  );
  audit(db, { storeId: row.store_id, actorId, actorRole: 'admin', action: 'pilot.update', entity: 'pilot', entityId: pilotId, detail: { authorizationStatus: next.authorizationStatus }, at: now });
  return getPilot(db, pilotId);
}

export function assertPilotAuthorized(db: Db, pilotId: string) {
  const pilot = getPilot(db, pilotId);
  if (pilot.authorizationStatus !== 'authorized') {
    throw new AppError(403, 'PILOT_NOT_AUTHORIZED', '试点数据未获授权，禁止导入');
  }
  return pilot;
}
