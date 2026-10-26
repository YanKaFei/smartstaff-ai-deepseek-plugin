import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { parseCsv, parseXlsx } from '../lib/tabular.js';

export type DataOrigin = 'REAL' | 'SIMULATED';
export type ImportFormat = 'csv' | 'xlsx';

export interface ImportObservation {
  id?: string;
  importId?: string;
  sourceRow: number;
  storeCode: string | null;
  businessDate: string | null;
  tableType: 'small' | 'medium' | 'large' | null;
  partySize: number | null;
  queueAt: number | null;
  seatAt: number | null;
  checkoutAt: number | null;
  leaveAt: number | null;
  cleanAt: number | null;
  onDutyStaff: number | null;
  serviceMode: 'full' | 'partial' | 'self' | null;
  actualWorkMinutes: number | null;
  managerSufficiency: 'short' | 'adequate' | 'over' | 'unknown' | null;
  managerRequired: number | null;
  managerRequiredReason: string | null;
  dataOrigin: DataOrigin;
  qualityStatus: 'valid' | 'invalid' | 'duplicate';
  issues: string[];
  dedupeKey: string | null;
}

const HEADER_ALIASES: Record<string, string> = {
  store_code: 'storeCode', anonymous_store_id: 'storeCode', '门店匿名编号': 'storeCode', '门店编号': 'storeCode',
  business_date: 'businessDate', date: 'businessDate', '营业日期': 'businessDate', '日期': 'businessDate',
  event_time: 'eventTime', '事件发生时间': 'eventTime',
  table_type: 'tableType', '桌型': 'tableType',
  party_size: 'partySize', '入座人数': 'partySize',
  queue_at: 'queueAt', '叫号时间': 'queueAt',
  seat_at: 'seatAt', '入座时间': 'seatAt',
  checkout_at: 'checkoutAt', '结账时间': 'checkoutAt',
  leave_at: 'leaveAt', '离店时间': 'leaveAt',
  clean_at: 'cleanAt', '清台完成时间': 'cleanAt',
  on_duty_staff: 'onDutyStaff', '实际在岗员工人数': 'onDutyStaff',
  service_mode: 'serviceMode', '服务模式': 'serviceMode',
  actual_work_minutes: 'actualWorkMinutes', '服务员实际工作分钟数': 'actualWorkMinutes',
  manager_sufficiency: 'managerSufficiency', '店长评价的实际人手充足程度': 'managerSufficiency',
  manager_required: 'managerRequired', '店长明确合理需求人数': 'managerRequired',
  manager_required_reason: 'managerRequiredReason', '店长需求判断理由': 'managerRequiredReason',
};

function normalizeHeader(h: string): string {
  return HEADER_ALIASES[h.trim().toLowerCase()] ?? HEADER_ALIASES[h.trim()] ?? h.trim();
}

export function valueOrNull(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' || t.toLowerCase() === 'null' || t === '-' ? null : t;
}

function parseExcelSerial(value: string): { date: string; minutes: number } | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n);
  const fraction = n - days;
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  const d = new Date(ms);
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    minutes: Math.round(fraction * 1440),
  };
}

export function parseBusinessDate(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const serial = parseExcelSerial(value);
  return serial?.date ?? null;
}

export function parseInstant(value: string | null, businessDate: string | null): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
    const iso = value.replace(' ', 'T');
    const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(iso);
    const t = Date.parse(hasZone ? iso : iso + '+08:00');
    return Number.isFinite(t) ? t : null;
  }
  const serial = parseExcelSerial(value);
  if (serial) {
    const base = businessDate ?? serial.date;
    return Date.UTC(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)), 0, serial.minutes) - 8 * 3_600_000;
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (m && businessDate) {
    return Date.UTC(Number(businessDate.slice(0, 4)), Number(businessDate.slice(5, 7)) - 1, Number(businessDate.slice(8, 10)), Number(m[1]), Number(m[2]), Number(m[3] ?? 0)) - 8 * 3_600_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTableType(value: string | null): 'small' | 'medium' | 'large' | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (['small', '小', '小桌', '2'].includes(v)) return 'small';
  if (['medium', '中', '中桌', '4'].includes(v)) return 'medium';
  if (['large', '大', '大桌', '8'].includes(v)) return 'large';
  return null;
}

export function normalizeServiceMode(value: string | null): 'full' | 'partial' | 'self' | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (['full', '全程代烤', '全程', 'full_assisted'].includes(v)) return 'full';
  if (['partial', '部分代烤', '部分'].includes(v)) return 'partial';
  if (['self', '自主烤制', '自主', 'self_grill'].includes(v)) return 'self';
  return null;
}

export function normalizeSufficiency(value: string | null): 'short' | 'adequate' | 'over' | 'unknown' | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (['short', 'under', '偏少', '不足', '缺人'].includes(v)) return 'short';
  if (['adequate', 'ok', '合适', '刚好', '充足'].includes(v)) return 'adequate';
  if (['over', '偏多', '过多', '富余'].includes(v)) return 'over';
  if (['unknown', '未知', '未评价'].includes(v)) return 'unknown';
  return null;
}

function parseRows(content: string | Buffer, format: ImportFormat): string[][] {
  if (format === 'csv') return parseCsv(typeof content === 'string' ? content : content.toString('utf8'));
  return parseXlsx(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
}

export interface ImportInput {
  filename: string;
  format: ImportFormat;
  content: string | Buffer;
  dataOrigin: DataOrigin;
  actorId: string;
  pilotId?: string | null;
  datasetType?: 'sessions' | 'events' | 'workload';
}

export function importDataset(db: Db, storeId: string, input: ImportInput) {
  const store = get<{ manager_code: string }>(db, 'SELECT manager_code FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店不存在');
  const rows = parseRows(input.content, input.format);
  if (rows.length < 2) throw new AppError(400, 'IMPORT_EMPTY', '文件没有数据行');
  const headers = rows[0].map(normalizeHeader);
  const required = ['storeCode', 'businessDate', 'tableType', 'partySize', 'seatAt', 'leaveAt'];
  for (const field of required) {
    if (!headers.includes(field)) throw new AppError(400, 'IMPORT_HEADER_MISSING', `缺少字段 ${field}`);
  }
  const missingCounts: Record<string, number> = { queueAt: 0, checkoutAt: 0, cleanAt: 0, actualWorkMinutes: 0, managerSufficiency: 0, managerRequired: 0, managerRequiredReason: 0 };
  const observations: ImportObservation[] = [];
  const seen = new Set<string>();
  let timeOrderIssues = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const raw: Record<string, string | null> = {};
    headers.forEach((h, i) => { raw[h] = valueOrNull(rows[r][i]); });
    const businessDate = parseBusinessDate(raw.businessDate);
    const tableType = normalizeTableType(raw.tableType);
    const partySize = raw.partySize ? Number(raw.partySize) : null;
    const queueAt = parseInstant(raw.queueAt, businessDate);
    const seatAt = parseInstant(raw.seatAt, businessDate) ?? parseInstant(raw.eventTime, businessDate);
    const checkoutAt = parseInstant(raw.checkoutAt, businessDate);
    const leaveAt = parseInstant(raw.leaveAt, businessDate);
    const cleanAt = parseInstant(raw.cleanAt, businessDate);
    const onDutyStaff = raw.onDutyStaff ? Number(raw.onDutyStaff) : null;
    const serviceMode = normalizeServiceMode(raw.serviceMode);
    const actualWorkMinutes = raw.actualWorkMinutes ? Number(raw.actualWorkMinutes) : null;
    const managerSufficiency = normalizeSufficiency(raw.managerSufficiency);
    const managerRequired = raw.managerRequired ? Number(raw.managerRequired) : null;
    const managerRequiredReason = raw.managerRequiredReason ?? null;
    const issues: string[] = [];
    if (!raw.storeCode) issues.push('missing_store_code');
    else if (raw.storeCode !== store.manager_code) issues.push('store_code_mismatch');
    if (!businessDate) issues.push('missing_business_date');
    if (!tableType) issues.push('missing_or_bad_table_type');
    if (!partySize || !Number.isFinite(partySize) || partySize < 1) issues.push('bad_party_size');
    if (!seatAt) issues.push('missing_seat_at');
    if (!leaveAt) issues.push('missing_leave_at');
    if (onDutyStaff === null || !Number.isFinite(onDutyStaff) || onDutyStaff < 0) issues.push('bad_on_duty_staff');
    if (!serviceMode) issues.push('missing_service_mode');
    if (managerRequired !== null && (!Number.isInteger(managerRequired) || managerRequired < 0)) issues.push('bad_manager_required');
    if (queueAt && seatAt && queueAt > seatAt) issues.push('queue_after_seat');
    if (seatAt && checkoutAt && seatAt > checkoutAt) issues.push('seat_after_checkout');
    if (checkoutAt && leaveAt && checkoutAt > leaveAt) issues.push('checkout_after_leave');
    if (leaveAt && cleanAt && leaveAt > cleanAt) issues.push('leave_after_clean');
    if (issues.some((i) => i.includes('after'))) timeOrderIssues += 1;
    for (const field of Object.keys(missingCounts)) {
      if (!raw[field]) missingCounts[field] += 1;
    }
    const dedupeKey = raw.storeCode && businessDate && tableType && seatAt && partySize
      ? `${raw.storeCode}|${businessDate}|${tableType}|${seatAt}|${partySize}`
      : null;
    let qualityStatus: ImportObservation['qualityStatus'] = issues.length ? 'invalid' : 'valid';
    if (dedupeKey && seen.has(dedupeKey)) {
      qualityStatus = 'duplicate';
      issues.push('duplicate_row');
    }
    if (dedupeKey) seen.add(dedupeKey);
    observations.push({
      sourceRow: r + 1,
      storeCode: raw.storeCode,
      businessDate,
      tableType,
      partySize,
      queueAt,
      seatAt,
      checkoutAt,
      leaveAt,
      cleanAt,
      onDutyStaff,
      serviceMode,
      actualWorkMinutes,
      managerSufficiency,
      managerRequired,
      managerRequiredReason,
      dataOrigin: input.dataOrigin,
      qualityStatus,
      issues,
      dedupeKey,
    });
  }
  const valid = observations.filter((o) => o.qualityStatus === 'valid');
  const invalid = observations.filter((o) => o.qualityStatus === 'invalid');
  const duplicates = observations.filter((o) => o.qualityStatus === 'duplicate');
  const quality = {
    dataOrigin: input.dataOrigin,
    rowCount: observations.length,
    validCount: valid.length,
    invalidCount: invalid.length,
    duplicateCount: duplicates.length,
    missing: missingCounts,
    timeOrderIssues,
    tableTypes: [...new Set(valid.map((o) => o.tableType))],
    serviceModes: [...new Set(valid.map((o) => o.serviceMode))],
    dateRange: valid.length ? [valid.map((o) => o.businessDate).sort()[0], valid.map((o) => o.businessDate).sort().at(-1)] : null,
    note: input.dataOrigin === 'SIMULATED'
      ? 'SIMULATED data: framework test only; never treated as real calibration evidence.'
      : 'REAL data: de-identification and authorization are the importer responsibility.',
  };
  const importId = id('imp');
  const now = Date.now();
  run(
    db,
    `INSERT INTO data_imports(id, store_id, filename, format, data_origin, row_count, valid_count, invalid_count, duplicate_count, quality_json, pilot_id, dataset_type, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [importId, storeId, input.filename, input.format, input.dataOrigin, observations.length, valid.length, invalid.length, duplicates.length, JSON.stringify(quality), input.pilotId ?? null, input.datasetType ?? 'sessions', input.actorId, now],
  );
  for (const o of observations) {
    run(
      db,
      `INSERT INTO import_observations(id, import_id, store_id, source_row, pilot_id, store_code, business_date, table_type, party_size, queue_at, seat_at, checkout_at, leave_at, clean_at, on_duty_staff, service_mode, actual_work_minutes, manager_sufficiency, manager_required, manager_required_reason, data_origin, quality_status, issues_json, dedupe_key, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id('obs'), importId, storeId, o.sourceRow, input.pilotId ?? null, o.storeCode, o.businessDate, o.tableType, o.partySize, o.queueAt, o.seatAt, o.checkoutAt, o.leaveAt, o.cleanAt, o.onDutyStaff, o.serviceMode, o.actualWorkMinutes, o.managerSufficiency, o.managerRequired, o.managerRequiredReason, o.dataOrigin, o.qualityStatus, JSON.stringify(o.issues), o.dedupeKey, now],
    );
  }
  return { importId, quality };
}

export function listImports(db: Db, storeId: string) {
  return all<Record<string, unknown>>(db, 'SELECT * FROM data_imports WHERE store_id = ? ORDER BY created_at DESC LIMIT 50', [storeId]).map((r) => ({
    id: r.id,
    filename: r.filename,
    format: r.format,
    dataOrigin: r.data_origin,
    rowCount: r.row_count,
    validCount: r.valid_count,
    invalidCount: r.invalid_count,
    duplicateCount: r.duplicate_count,
    quality: JSON.parse(String(r.quality_json)),
    createdAt: r.created_at,
  }));
}

export function getImport(db: Db, storeId: string, importId: string) {
  const row = get<{
    id: string; filename: string; format: string; data_origin: string; row_count: number; valid_count: number;
    invalid_count: number; duplicate_count: number; quality_json: string; created_at: number;
  }>(db, 'SELECT * FROM data_imports WHERE id = ? AND store_id = ?', [importId, storeId]);
  if (!row) throw new AppError(404, 'IMPORT_NOT_FOUND', '导入批次不存在');
  return { ...row, quality: JSON.parse(row.quality_json) };
}

export function listObservations(db: Db, importId: string, status = 'valid') {
  return all<Record<string, unknown>>(
    db,
    'SELECT * FROM import_observations WHERE import_id = ? AND quality_status = ? ORDER BY seat_at',
    [importId, status],
  ).map((r) => ({
    id: r.id,
    sourceRow: r.source_row,
    tableType: r.table_type,
    partySize: r.party_size,
    queueAt: r.queue_at,
    seatAt: r.seat_at,
    checkoutAt: r.checkout_at,
    leaveAt: r.leave_at,
    cleanAt: r.clean_at,
    onDutyStaff: r.on_duty_staff,
    serviceMode: r.service_mode,
    actualWorkMinutes: r.actual_work_minutes,
    managerSufficiency: r.manager_sufficiency,
    managerRequired: r.manager_required,
    managerRequiredReason: r.manager_required_reason,
    dataOrigin: r.data_origin,
    issues: JSON.parse(String(r.issues_json)),
  }));
}
