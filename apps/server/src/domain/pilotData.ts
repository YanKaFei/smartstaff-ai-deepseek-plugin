import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { parseCsv, parseXlsx } from '../lib/tabular.js';
import {
  normalizeServiceMode,
  normalizeSufficiency,
  normalizeTableType,
  parseInstant,
  valueOrNull,
} from './dataImport.js';
import type { ImportFormat } from './dataImport.js';
import { getPilot } from './pilots.js';

const EVENT_TYPES = ['queue_join', 'queue_call', 'seat', 'checkout', 'leave', 'clean', 'staff_checkin', 'staff_checkout', 'table_status'];
const PII = /(\b1[3-9]\d{9}\b)|([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;

const EVENT_HEADERS: Record<string, string> = {
  pilot_id: 'pilotId', store_code: 'storeCode', business_date: 'businessDate', event_id: 'eventId', event_type: 'eventType',
  occurred_at: 'occurredAt', table_label: 'tableLabel', table_type: 'tableType', party_size: 'partySize',
  staff_role: 'staffRole', staff_anonymous_id: 'staffAnonymousId', call_no: 'callNo', service_mode: 'serviceMode',
  on_duty_staff: 'onDutyStaff', manager_sufficiency: 'managerSufficiency', manager_required: 'managerRequired',
};
const WORKLOAD_HEADERS: Record<string, string> = {
  pilot_id: 'pilotId', store_code: 'storeCode', observation_id: 'observationId', staff_role: 'staffRole',
  service_mode: 'serviceMode', table_type: 'tableType', action: 'action', start_at: 'startAt', end_at: 'endAt',
  minutes: 'minutes', business_date: 'businessDate',
};

function normHeader(h: string, map: Record<string, string>): string {
  return map[h.trim().toLowerCase()] ?? map[h.trim()] ?? h.trim();
}
function rowsFor(content: string | Buffer, format: ImportFormat): string[][] {
  return format === 'csv' ? parseCsv(String(content)) : parseXlsx(Buffer.isBuffer(content) ? content : Buffer.from(content));
}
function cloneMap(headers: string[]): Record<string, string | null>[] { return []; }

function makeImport(db: Db, input: { pilotId: string; storeId: string; filename: string; format: ImportFormat; origin: 'REAL' | 'SIMULATED'; datasetType: string; quality: unknown; rowCount: number; valid: number; invalid: number; duplicate: number; actorId: string }) {
  const importId = id('imp');
  run(
    db,
    `INSERT INTO data_imports(id, store_id, filename, format, data_origin, row_count, valid_count, invalid_count, duplicate_count, quality_json, pilot_id, dataset_type, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [importId, input.storeId, input.filename, input.format, input.origin, input.rowCount, input.valid, input.invalid, input.duplicate, JSON.stringify(input.quality), input.pilotId, input.datasetType, input.actorId, Date.now()],
  );
  return importId;
}

export function importPilotEvents(db: Db, pilotId: string, input: { filename: string; format: ImportFormat; content: string | Buffer; dataOrigin: 'REAL' | 'SIMULATED'; actorId: string }) {
  const pilot = getPilot(db, pilotId);
  const rows = rowsFor(input.content, input.format);
  if (rows.length < 2) throw new AppError(400, 'IMPORT_EMPTY', '事件文件没有数据行');
  const headers = rows[0].map((h) => normHeader(h, EVENT_HEADERS));
  for (const field of ['eventId', 'eventType', 'occurredAt']) {
    if (!headers.includes(field)) throw new AppError(400, 'IMPORT_HEADER_MISSING', `缺少字段 ${field}`);
  }
  const events: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  const missing: Record<string, number> = { businessDate: 0, tableLabel: 0, partySize: 0, staffAnonymousId: 0, onDutyStaff: 0 };
  let piiRows = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const raw: Record<string, string | null> = {};
    headers.forEach((h, i) => { raw[h] = valueOrNull(rows[r][i]); });
    const eventId = raw.eventId;
    const eventType = raw.eventType?.toLowerCase();
    const timestamp = parseInstant(raw.occurredAt, raw.businessDate ?? null);
    const issues: string[] = [];
    if (!eventId) issues.push('missing_event_id');
    if (!eventType || !EVENT_TYPES.includes(eventType)) issues.push('bad_event_type');
    if (!timestamp) issues.push('bad_occurred_at');
    if (!raw.tableLabel && ['seat', 'checkout', 'leave', 'clean', 'table_status'].includes(eventType ?? '')) issues.push('missing_table_label');
    if (PII.test(`${raw.tableLabel ?? ''} ${raw.staffAnonymousId ?? ''}`)) { issues.push('pii_detected'); piiRows += 1; }
    for (const f of Object.keys(missing)) if (!raw[f]) missing[f] += 1;
    let quality: 'valid' | 'invalid' | 'duplicate' = issues.length ? 'invalid' : 'valid';
    if (eventId && seen.has(eventId)) { quality = 'duplicate'; issues.push('duplicate_event'); }
    if (eventId) seen.add(eventId);
    events.push({
      id: id('pev'), eventId, eventType, timestamp,
      businessDate: raw.businessDate ?? (timestamp ? new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 10) : null),
      tableLabel: raw.tableLabel, tableType: normalizeTableType(raw.tableType), partySize: raw.partySize ? Number(raw.partySize) : null,
      staffRole: raw.staffRole, staffAnonymousId: raw.staffAnonymousId, callNo: raw.callNo ? Number(raw.callNo) : null,
      serviceMode: normalizeServiceMode(raw.serviceMode), onDutyStaff: raw.onDutyStaff ? Number(raw.onDutyStaff) : null,
      managerSufficiency: normalizeSufficiency(raw.managerSufficiency), managerRequired: raw.managerRequired ? Number(raw.managerRequired) : null, sourceRow: r + 1, quality, issues,
    });
  }
  const valid = events.filter((e) => e.quality === 'valid');
  const invalid = events.filter((e) => e.quality === 'invalid');
  const duplicate = events.filter((e) => e.quality === 'duplicate');
  const timestampInvalid = events.filter((e) => (e.issues as string[]).includes('bad_occurred_at')).length;
  const quality = {
    dataOrigin: input.dataOrigin,
    datasetType: 'events',
    rowCount: events.length,
    validCount: valid.length,
    invalidCount: invalid.length,
    duplicateCount: duplicate.length,
    missing,
    timestampInvalid,
    piiRows,
    eventTypes: [...new Set(valid.map((e) => e.eventType))],
    dateRange: valid.length ? [valid.map((e) => e.businessDate).sort()[0], valid.map((e) => e.businessDate).sort().at(-1)] : null,
    note: input.dataOrigin === 'SIMULATED' ? 'SIMULATED events; framework test only.' : 'REAL authorized events; no PII.',
  };
  const importId = makeImport(db, { pilotId, storeId: pilot.storeId, filename: input.filename, format: input.format, origin: input.dataOrigin, datasetType: 'events', quality, rowCount: events.length, valid: valid.length, invalid: invalid.length, duplicate: duplicate.length, actorId: input.actorId });
  for (const e of events) {
    run(
      db,
      `INSERT OR IGNORE INTO pilot_events(id, pilot_id, store_id, event_id, event_type, occurred_at, business_date, table_label, table_type, party_size, staff_role, staff_anonymous_id, call_no, service_mode, on_duty_staff, manager_sufficiency, manager_required, source_row, data_origin, quality_status, issues_json, dedupe_key, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [e.id, pilotId, pilot.storeId, e.eventId, e.eventType, e.timestamp ?? 0, e.businessDate, e.tableLabel, e.tableType, e.partySize, e.staffRole, e.staffAnonymousId, e.callNo, e.serviceMode, e.onDutyStaff, e.managerSufficiency, e.managerRequired, e.sourceRow, input.dataOrigin, e.quality, JSON.stringify(e.issues), e.eventId, Date.now()],
    );
  }
  const sessions = materializeSessions(valid as Array<Record<string, any>>);
  let sessionImportId: string | null = null;
  if (sessions.length) {
    const sQuality = { ...quality, datasetType: 'events_sessions', note: 'Derived sessions from events; one row per seat/leave pair.' };
    sessionImportId = makeImport(db, { pilotId, storeId: pilot.storeId, filename: `${input.filename}#sessions`, format: input.format, origin: input.dataOrigin, datasetType: 'events_sessions', quality: sQuality, rowCount: sessions.length, valid: sessions.length, invalid: 0, duplicate: 0, actorId: input.actorId });
    for (const s of sessions) {
      run(
        db,
        `INSERT INTO import_observations(id, import_id, store_id, source_row, pilot_id, store_code, business_date, table_type, party_size, queue_at, seat_at, checkout_at, leave_at, clean_at, on_duty_staff, service_mode, actual_work_minutes, manager_sufficiency, manager_required, data_origin, quality_status, issues_json, dedupe_key, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id('obs'), sessionImportId, pilot.storeId, s.sourceRow, pilotId, pilot.anonymousCode, s.businessDate, s.tableType, s.partySize, s.queueAt, s.seatAt, s.checkoutAt, s.leaveAt, s.cleanAt, s.onDutyStaff, s.serviceMode, null, s.managerSufficiency, s.managerRequired, input.dataOrigin, 'valid', '[]', s.dedupeKey, Date.now()],
      );
    }
  }
  return { importId, sessionImportId, quality, sessionCount: sessions.length };
}

function materializeSessions(events: Array<Record<string, any>>) {
  const byKey = new Map<string, Array<Record<string, any>>>();
  for (const e of events) {
    if (!e.tableLabel || !e.businessDate) continue;
    const key = `${e.businessDate}|${e.tableLabel}`;
    const list = byKey.get(key) ?? [];
    list.push(e); byKey.set(key, list);
  }
  const sessions: Array<Record<string, any>> = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
    for (const seat of sorted.filter((e) => e.eventType === 'seat')) {
      const after = sorted.filter((e) => e.timestamp > seat.timestamp);
      const leave = after.find((e) => e.eventType === 'leave') ?? after.find((e) => e.eventType === 'clean');
      if (!leave) continue;
      const checkout = after.find((e) => e.eventType === 'checkout') ?? null;
      const clean = after.find((e) => e.eventType === 'clean') ?? null;
      const queueEvents = sorted.filter((e) => e.timestamp <= seat.timestamp && ['queue_join', 'queue_call'].includes(e.eventType));
      const queueAt = queueEvents.at(-1)?.timestamp ?? null;
      const onDuty = Math.max(1, ...sorted.map((e) => Number(e.onDutyStaff) || 0));
      sessions.push({
        sourceRow: seat.sourceRow,
        businessDate: seat.businessDate,
        tableType: seat.tableType ?? 'small',
        partySize: seat.partySize ?? 2,
        queueAt,
        seatAt: seat.timestamp,
        checkoutAt: checkout?.timestamp ?? null,
        leaveAt: leave.timestamp,
        cleanAt: clean?.timestamp ?? null,
        onDutyStaff: onDuty,
        serviceMode: seat.serviceMode ?? 'partial',
        managerSufficiency: seat.managerSufficiency ?? 'unknown',
        managerRequired: seat.managerRequired ?? null,
        dedupeKey: key + '|' + seat.timestamp,
      });
    }
  }
  return sessions;
}

export function importPilotWorkload(db: Db, pilotId: string, input: { filename: string; format: ImportFormat; content: string | Buffer; dataOrigin: 'REAL' | 'SIMULATED'; actorId: string }) {
  const pilot = getPilot(db, pilotId);
  const rows = rowsFor(input.content, input.format);
  if (rows.length < 2) throw new AppError(400, 'IMPORT_EMPTY', '工作量文件没有数据行');
  const headers = rows[0].map((h) => normHeader(h, WORKLOAD_HEADERS));
  for (const field of ['observationId', 'action', 'startAt', 'endAt']) {
    if (!headers.includes(field)) throw new AppError(400, 'IMPORT_HEADER_MISSING', `缺少字段 ${field}`);
  }
  const items: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  let piiRows = 0;
  let timeIssues = 0;
  let minutesMismatch = 0;
  const missing: Record<string, number> = { staffRole: 0, tableType: 0, serviceMode: 0, minutes: 0 };
  for (let r = 1; r < rows.length; r += 1) {
    const raw: Record<string, string | null> = {};
    headers.forEach((h, i) => { raw[h] = valueOrNull(rows[r][i]); });
    const start = parseInstant(raw.startAt, raw.businessDate ?? null);
    const end = parseInstant(raw.endAt, raw.businessDate ?? null);
    const issues: string[] = [];
    const observationId = raw.observationId;
    if (!observationId) issues.push('missing_observation_id');
    if (!raw.action) issues.push('missing_action');
    if (!start || !end) issues.push('bad_time');
    if (start && end && end <= start) { issues.push('end_not_after_start'); timeIssues += 1; }
    const computed = start && end ? Math.round(((end - start) / 60000) * 100) / 100 : null;
    const provided = raw.minutes ? Number(raw.minutes) : null;
    if (provided !== null && computed !== null && Math.abs(provided - computed) > 2) { issues.push('minutes_mismatch'); minutesMismatch += 1; }
    if (PII.test(`${raw.staffRole ?? ''} ${raw.action ?? ''}`)) { issues.push('pii_detected'); piiRows += 1; }
    for (const f of Object.keys(missing)) if (!raw[f]) missing[f] += 1;
    let quality: 'valid' | 'invalid' | 'duplicate' = issues.length ? 'invalid' : 'valid';
    if (observationId && seen.has(observationId)) { quality = 'duplicate'; issues.push('duplicate_observation'); }
    if (observationId) seen.add(observationId);
    items.push({
      id: id('wlo'), observationId, staffRole: raw.staffRole, serviceMode: normalizeServiceMode(raw.serviceMode), tableType: normalizeTableType(raw.tableType),
      action: raw.action, startAt: start, endAt: end, minutes: provided ?? computed, sourceRow: r + 1, quality, issues,
    });
  }
  const valid = items.filter((i) => i.quality === 'valid');
  const invalid = items.filter((i) => i.quality === 'invalid');
  const duplicate = items.filter((i) => i.quality === 'duplicate');
  const quality = {
    dataOrigin: input.dataOrigin, datasetType: 'workload', rowCount: items.length, validCount: valid.length,
    invalidCount: invalid.length, duplicateCount: duplicate.length, missing, piiRows, timeIssues, minutesMismatch,
    note: 'One row = one service action; repeated rows are deduplicated by observation_id.',
  };
  const importId = makeImport(db, { pilotId, storeId: pilot.storeId, filename: input.filename, format: input.format, origin: input.dataOrigin, datasetType: 'workload', quality, rowCount: items.length, valid: valid.length, invalid: invalid.length, duplicate: duplicate.length, actorId: input.actorId });
  for (const item of items) {
    run(
      db,
      `INSERT OR IGNORE INTO workload_observations(id, pilot_id, store_id, observation_id, staff_role, service_mode, table_type, action, start_at, end_at, minutes, source_row, data_origin, quality_status, issues_json, dedupe_key, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [item.id, pilotId, pilot.storeId, item.observationId, item.staffRole, item.serviceMode, item.tableType, item.action, item.startAt, item.endAt, item.minutes, item.sourceRow, input.dataOrigin, item.quality, JSON.stringify(item.issues), item.observationId, Date.now()],
    );
  }
  return { importId, quality };
}

export function pilotDataQuality(db: Db, pilotId: string) {
  const pilot = getPilot(db, pilotId);
  const imports = all<Record<string, unknown>>(db, 'SELECT * FROM data_imports WHERE pilot_id = ? ORDER BY created_at DESC', [pilotId]).map((r) => ({
    id: r.id, datasetType: r.dataset_type, filename: r.filename, dataOrigin: r.data_origin,
    rowCount: r.row_count, validCount: r.valid_count, invalidCount: r.invalid_count, duplicateCount: r.duplicate_count,
    quality: JSON.parse(String(r.quality_json)), createdAt: r.created_at,
  }));
  const events = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM pilot_events WHERE pilot_id = ? AND quality_status = 'valid'", [pilotId])?.n ?? 0;
  const workload = get<{ n: number; minutes: number }>(db, "SELECT COUNT(*) AS n, COALESCE(SUM(minutes),0) AS minutes FROM workload_observations WHERE pilot_id = ? AND quality_status = 'valid'", [pilotId])!;
  return { pilot, imports, totals: { validEvents: events, validWorkloadRows: workload.n, workloadMinutes: Math.round(workload.minutes * 100) / 100 } };
}

export function workloadAnalysis(db: Db, pilotId: string) {
  const rows = all<{ staff_role: string | null; table_type: string | null; action: string | null; minutes: number | null }>(
    db,
    "SELECT staff_role, table_type, action, minutes FROM workload_observations WHERE pilot_id = ? AND quality_status = 'valid' ORDER BY start_at",
    [pilotId],
  );
  const total = rows.reduce((s, r) => s + (r.minutes ?? 0), 0);
  const byRole = rows.reduce<Record<string, number>>((acc, r) => { const k = r.staff_role ?? 'unknown'; acc[k] = Math.round(((acc[k] ?? 0) + (r.minutes ?? 0)) * 100) / 100; return acc; }, {});
  const byTable = rows.reduce<Record<string, number>>((acc, r) => { const k = r.table_type ?? 'unknown'; acc[k] = Math.round(((acc[k] ?? 0) + (r.minutes ?? 0)) * 100) / 100; return acc; }, {});
  const byAction = rows.reduce<Record<string, number>>((acc, r) => { const k = r.action ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  return { sampleCount: rows.length, totalMinutes: Math.round(total * 100) / 100, averageMinutes: rows.length ? Math.round((total / rows.length) * 100) / 100 : null, byRole, byTable, byAction, status: rows.length ? 'ENGINEERING_VERIFIED' : 'INSUFFICIENT_DATA' };
}
