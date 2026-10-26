import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { applyOps, type OpsCommand } from './ops.js';
import { getStore, parseConfig } from './stores.js';
import { storeNow } from './clock.js';
import { createException, audit } from './notify.js';
import { MINUTE_MS, round2 } from '../lib/time.js';

export const EVENT_TYPES = [
  'queue_join',
  'queue_call',
  'queue_abandon',
  'seat',
  'checkout',
  'leave',
  'clean',
  'clean_done',
  'table_status',
  'staff_checkin',
  'staff_checkout',
] as const;

export type IngestEventType = (typeof EVENT_TYPES)[number];

const rawEventSchema = z.object({
  externalId: z.string().trim().min(1).max(120).optional(),
  external_id: z.string().trim().min(1).max(120).optional(),
  eventId: z.string().trim().min(1).max(120).optional(),
  id: z.string().trim().min(1).max(120).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  event_type: z.enum(EVENT_TYPES).optional(),
  occurredAt: z.number().int().optional(),
  occurred_at: z.number().int().optional(),
  tableId: z.string().optional(),
  table_id: z.string().optional(),
  tableLabel: z.string().optional(),
  table_label: z.string().optional(),
  queueId: z.string().optional(),
  queue_id: z.string().optional(),
  partySize: z.number().int().min(1).max(30).optional(),
  party_size: z.number().int().min(1).max(30).optional(),
  callNo: z.number().int().min(1).max(99999).optional(),
  call_no: z.number().int().min(1).max(99999).optional(),
  shiftId: z.string().optional(),
  shift_id: z.string().optional(),
  tableStatus: z.enum(['available', 'dining', 'checkout', 'cleaning']).optional(),
  table_status: z.enum(['available', 'dining', 'checkout', 'cleaning']).optional(),
  note: z.string().max(200).optional(),
});

export interface IngestEvent {
  externalId: string;
  type: IngestEventType;
  occurredAt: number;
  tableId?: string;
  tableLabel?: string;
  queueId?: string;
  partySize?: number;
  callNo?: number;
  shiftId?: string;
  tableStatus?: 'available' | 'dining' | 'checkout' | 'cleaning';
  note?: string;
}

export function normalizeEvent(raw: unknown, fallbackNow: number): IngestEvent {
  const parsed = rawEventSchema.parse(raw);
  const externalId = parsed.externalId ?? parsed.external_id ?? parsed.eventId ?? parsed.id;
  const type = parsed.type ?? parsed.event_type;
  if (!externalId) throw new AppError(400, 'EVENT_ID_REQUIRED', '事件缺少外部唯一 ID');
  if (!type) throw new AppError(400, 'EVENT_TYPE_REQUIRED', '事件缺少类型');
  return {
    externalId,
    type,
    occurredAt: parsed.occurredAt ?? parsed.occurred_at ?? fallbackNow,
    tableId: parsed.tableId ?? parsed.table_id,
    tableLabel: parsed.tableLabel ?? parsed.table_label,
    queueId: parsed.queueId ?? parsed.queue_id,
    partySize: parsed.partySize ?? parsed.party_size,
    callNo: parsed.callNo ?? parsed.call_no,
    shiftId: parsed.shiftId ?? parsed.shift_id,
    tableStatus: parsed.tableStatus ?? parsed.table_status,
    note: parsed.note,
  };
}

function updateState(
  db: Db,
  storeId: string,
  input: { receivedAt: number; appliedAt?: number; eventAt?: number; source: string },
): void {
  const current = get<{ last_event_at: number | null }>(db, 'SELECT last_event_at FROM event_ingest_state WHERE store_id = ?', [storeId]);
  const lastEvent = Math.max(current?.last_event_at ?? 0, input.eventAt ?? 0);
  run(
    db,
    `INSERT INTO event_ingest_state(store_id, last_received_at, last_applied_at, last_event_at, last_source, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(store_id) DO UPDATE SET
       last_received_at = excluded.last_received_at,
       last_applied_at = COALESCE(excluded.last_applied_at, event_ingest_state.last_applied_at),
       last_event_at = excluded.last_event_at,
       last_source = excluded.last_source,
       updated_at = excluded.updated_at`,
    [
      storeId,
      input.receivedAt,
      input.appliedAt ?? null,
      lastEvent,
      input.source,
      Date.now(),
    ],
  );
}

function resolveTableId(db: Db, storeId: string, input: { tableId?: string; tableLabel?: string }): string | undefined {
  if (input.tableId) {
    const row = get<{ id: string }>(db, 'SELECT id FROM store_tables WHERE id = ? AND store_id = ?', [input.tableId, storeId]);
    if (!row) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位不存在');
    return row.id;
  }
  if (input.tableLabel) {
    const row = get<{ id: string }>(
      db,
      'SELECT id FROM store_tables WHERE store_id = ? AND UPPER(label) = ?',
      [storeId, input.tableLabel.trim().toUpperCase()],
    );
    if (!row) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位标签不存在');
    return row.id;
  }
  return undefined;
}

function applyIngestEvent(db: Db, storeId: string, event: IngestEvent, source: string, actorId?: string): unknown {
  const occurredAt = event.occurredAt;
  switch (event.type) {
    case 'queue_join':
      return applyOps(db, storeId, { type: 'join_queue', partySize: event.partySize ?? 2 }, { source, actorId, at: occurredAt });
    case 'queue_call':
      return applyOps(db, storeId, { type: 'call_next', callNo: event.callNo }, { source, actorId, at: occurredAt });
    case 'queue_abandon':
      return applyOps(db, storeId, { type: 'abandon_queue', queueId: event.queueId }, { source, actorId, at: occurredAt });
    case 'seat': {
      let queueId = event.queueId;
      if (!queueId) {
        const waiting = get<{ id: string }>(
          db,
          `SELECT id FROM queue_entries WHERE store_id = ? AND status IN ('called','queued')
            ORDER BY CASE status WHEN 'called' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
          [storeId],
        );
        if (!waiting) throw new AppError(409, 'NO_QUEUE', '没有可入座的排队记录');
        queueId = waiting.id;
      }
      return applyOps(
        db,
        storeId,
        { type: 'seat', queueId, tableId: resolveTableId(db, storeId, event) },
        { source, actorId, at: occurredAt },
      );
    }
    case 'checkout':
    case 'leave':
    case 'clean':
    case 'clean_done': {
      const tableId = resolveTableId(db, storeId, event);
      if (!tableId) throw new AppError(400, 'TABLE_REQUIRED', '桌位事件必须提供 tableId 或 tableLabel');
      const type = event.type === 'clean_done' ? 'clean' : event.type;
      return applyOps(db, storeId, { type, tableId }, { source, actorId, at: occurredAt });
    }
    case 'table_status': {
      const tableId = resolveTableId(db, storeId, event);
      if (!tableId) throw new AppError(400, 'TABLE_REQUIRED', '桌台状态事件必须提供 tableId 或 tableLabel');
      const desired = event.tableStatus;
      if (!desired) throw new AppError(400, 'TABLE_STATUS_REQUIRED', 'table_status 事件必须提供 tableStatus');
      const table = get<{ status: string }>(db, 'SELECT status FROM store_tables WHERE id = ? AND store_id = ?', [tableId, storeId]);
      if (!table) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位不存在');
      if (desired === 'dining') throw new AppError(422, 'TABLE_STATUS_UNSUPPORTED', '外部同步不允许直接创建就餐会话');
      if (desired === 'available') {
        return applyOps(db, storeId, { type: 'clean', tableId }, { source, actorId, at: occurredAt });
      }
      if (desired === 'checkout') {
        return applyOps(db, storeId, { type: 'checkout', tableId }, { source, actorId, at: occurredAt });
      }
      // desired === 'cleaning': checkout -> leave; cleaning is already clean.
      if (table.status === 'checkout') {
        return applyOps(db, storeId, { type: 'leave', tableId }, { source, actorId, at: occurredAt });
      }
      if (table.status === 'cleaning') return { tableId, status: 'cleaning' };
      throw new AppError(409, 'TABLE_STATUS_CONFLICT', `桌台当前状态 ${table.status} 不能同步为 cleaning`);
    }
    case 'staff_checkin':
    case 'staff_checkout': {
      if (!event.shiftId) throw new AppError(400, 'SHIFT_REQUIRED', '员工上下班事件必须提供 shiftId');
      const shift = get<{ id: string; status: string; start_at: number; end_at: number; hourly_rate: number; checked_in_at: number | null; staff_id: string }>(
        db,
        'SELECT id, status, start_at, end_at, hourly_rate, checked_in_at, staff_id FROM shifts WHERE id = ? AND store_id = ?',
        [event.shiftId, storeId],
      );
      if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
      if (event.type === 'staff_checkin') {
        if (shift.status !== 'confirmed') throw new AppError(409, 'SHIFT_NOT_CONFIRMABLE', '只有已确认班次可签到');
        const late = Math.max(0, Math.round((occurredAt - shift.start_at) / MINUTE_MS));
        run(
          db,
          "UPDATE shifts SET status = 'checked_in', checked_in_at = ?, late_minutes = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'",
          [occurredAt, late, occurredAt, shift.id],
        );
        audit(db, { storeId, actorRole: source, action: 'ingest.staff_checkin', entity: 'shift', entityId: shift.id, at: occurredAt });
      } else {
        if (shift.status !== 'checked_in' || !shift.checked_in_at) throw new AppError(409, 'SHIFT_NOT_CHECKED_IN', '只有已签到班次可签退');
        const minutes = Math.max(1, Math.round((occurredAt - shift.checked_in_at) / MINUTE_MS));
        run(
          db,
          "UPDATE shifts SET status = 'completed', checked_out_at = ?, actual_minutes = ?, pay_amount = ?, updated_at = ? WHERE id = ? AND status = 'checked_in'",
          [occurredAt, minutes, round2((minutes / 60) * shift.hourly_rate), occurredAt, shift.id],
        );
        audit(db, { storeId, actorRole: source, action: 'ingest.staff_checkout', entity: 'shift', entityId: shift.id, at: occurredAt });
      }
      return { shiftId: shift.id };
    }
    default:
      throw new AppError(400, 'EVENT_TYPE_UNSUPPORTED', '不支持的事件类型');
  }
}

export interface IngestOutcome {
  ingestId: string;
  status: 'applied' | 'duplicate' | 'stale' | 'error';
  error?: string;
  result?: unknown;
}

export function ingestEvent(
  db: Db,
  storeId: string,
  source: 'manual' | 'simulator' | 'webhook' | 'correction',
  event: IngestEvent,
  options: { signatureValid?: boolean; actorId?: string; correctionOf?: string; throwOnError?: boolean; externalIdOverride?: string } = {},
): IngestOutcome {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const now = Date.now();
  const externalId = options.externalIdOverride ?? event.externalId;
  const ingestId = id('ing');
  const insert = run(
    db,
    `INSERT OR IGNORE INTO event_ingest(id, store_id, source, external_id, event_type, occurred_at, received_at,
       payload_json, status, error, signature_valid, correction_of, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ingestId,
      storeId,
      source,
      externalId,
      event.type,
      event.occurredAt,
      now,
      JSON.stringify(event),
      'received',
      null,
      options.signatureValid ? 1 : 0,
      options.correctionOf ?? null,
      now,
    ],
  );
  if (Number(insert.changes) !== 1) {
    const existing = get<{ id: string; status: string }>(
      db,
      'SELECT id, status FROM event_ingest WHERE store_id = ? AND source = ? AND external_id = ?',
      [storeId, source, externalId],
    );
    return { ingestId: existing?.id ?? ingestId, status: 'duplicate', error: `重复事件（原状态 ${existing?.status ?? 'unknown'}）` };
  }
  updateState(db, storeId, { receivedAt: now, source });

  const state = get<{ last_event_at: number | null }>(db, 'SELECT last_event_at FROM event_ingest_state WHERE store_id = ?', [storeId]);
  const lastEventAt = state?.last_event_at ?? 0;
  if (lastEventAt > 0 && event.occurredAt < lastEventAt - 5 * MINUTE_MS) {
    run(db, "UPDATE event_ingest SET status = 'stale', error = ? WHERE id = ?", ['事件时间早于最近已应用事件超过 5 分钟', ingestId]);
    createException(db, {
      storeId,
      type: 'ingest_stale',
      severity: 'warning',
      message: `丢弃乱序事件 ${event.type}（${new Date(event.occurredAt).toISOString()}）`,
      payload: { ingestId, event },
      at: storeNow(db, storeId),
    });
    return { ingestId, status: 'stale', error: '事件时间过旧，已保留记录但未应用' };
  }
  if (event.occurredAt > storeNow(db, storeId) + 10 * MINUTE_MS) {
    run(db, "UPDATE event_ingest SET status = 'error', error = ? WHERE id = ?", ['事件时间超前于门店时钟超过 10 分钟', ingestId]);
    return { ingestId, status: 'error', error: '事件时间超前，已拒绝' };
  }

  try {
    const result = applyIngestEvent(db, storeId, event, source, options.actorId);
    run(db, "UPDATE event_ingest SET status = 'applied', error = NULL, applied_event_id = ? WHERE id = ?", [null, ingestId]);
    updateState(db, storeId, { receivedAt: now, appliedAt: Date.now(), eventAt: event.occurredAt, source });
    audit(db, {
      storeId,
      actorId: options.actorId ?? null,
      actorRole: source,
      action: 'ingest.applied',
      entity: 'event_ingest',
      entityId: ingestId,
      detail: { type: event.type, externalId, occurredAt: event.occurredAt, correctionOf: options.correctionOf },
      at: now,
    });
    return { ingestId, status: 'applied', result };
  } catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : '事件应用失败';
    run(db, "UPDATE event_ingest SET status = 'error', error = ? WHERE id = ?", [message.slice(0, 300), ingestId]);
    createException(db, {
      storeId,
      type: 'ingest_error',
      severity: 'warning',
      message: `事件 ${event.type} 应用失败：${message}`,
      payload: { ingestId, event },
      at: storeNow(db, storeId),
    });
    if (options.throwOnError) throw err;
    return { ingestId, status: 'error', error: message };
  }
}

export function ingestManualCommand(
  db: Db,
  storeId: string,
  command: OpsCommand,
  actorId: string,
): { today: unknown; result?: unknown; ingest: IngestOutcome } {
  if (command.type === 'set_on_duty') {
    const result = applyOps(db, storeId, command, { actorId, source: 'manual' });
    return { today: result.today, ingest: { ingestId: '', status: 'applied' } };
  }
  const now = storeNow(db, storeId);
  const typeMap: Record<string, IngestEventType> = {
    join_queue: 'queue_join',
    abandon_queue: 'queue_abandon',
    call_next: 'queue_call',
    seat: 'seat',
    checkout: 'checkout',
    leave: 'leave',
    clean: 'clean',
  };
  const event: IngestEvent = {
    externalId: id('manual'),
    type: typeMap[command.type],
    occurredAt: now,
    tableId: 'tableId' in command ? command.tableId : undefined,
    queueId: 'queueId' in command ? command.queueId : undefined,
    partySize: 'partySize' in command ? command.partySize : undefined,
    callNo: 'callNo' in command ? command.callNo : undefined,
  };
  const outcome = ingestEvent(db, storeId, 'manual', event, { signatureValid: true, actorId, throwOnError: true });
  const applyResult = outcome.result as { today?: unknown } | undefined;
  return { today: applyResult?.today, result: outcome.result, ingest: outcome };
}

export function ingestStatus(db: Db, storeId: string) {
  const state = get<{
    last_received_at: number | null;
    last_applied_at: number | null;
    last_event_at: number | null;
    last_source: string | null;
  }>(db, 'SELECT * FROM event_ingest_state WHERE store_id = ?', [storeId]);
  const counts = all<{ status: string; n: number }>(
    db,
    'SELECT status, COUNT(*) AS n FROM event_ingest WHERE store_id = ? GROUP BY status',
    [storeId],
  );
  const last = get<{
    id: string;
    source: string;
    event_type: string;
    occurred_at: number;
    received_at: number;
    status: string;
  }>(db, 'SELECT id, source, event_type, occurred_at, received_at, status FROM event_ingest WHERE store_id = ? ORDER BY received_at DESC LIMIT 1', [storeId]);
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const now = storeNow(db, storeId);
  const stale = !state?.last_received_at || Date.now() - state.last_received_at > 15 * MINUTE_MS;
  return {
    storeId,
    dataSource: config.dataSource,
    lastReceivedAt: state?.last_received_at ?? null,
    lastAppliedAt: state?.last_applied_at ?? null,
    lastEventAt: state?.last_event_at ?? null,
    lastSource: state?.last_source ?? null,
    stale,
    staleThresholdMinutes: 15,
    webhookConfigured: Boolean(
      get<{ legacy: string | null; enc: string | null }>(
        db,
        'SELECT webhook_secret AS legacy, webhook_secret_enc AS enc FROM stores WHERE id = ?',
        [storeId],
      )?.enc ||
        get<{ legacy: string | null }>(db, 'SELECT webhook_secret AS legacy FROM stores WHERE id = ?', [storeId])?.legacy,
    ),
    lastEvent: last
      ? { id: last.id, source: last.source, type: last.event_type, occurredAt: last.occurred_at, receivedAt: last.received_at, status: last.status }
      : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    now,
  };
}

export function listIngestEvents(db: Db, storeId: string, status?: string) {
  const rows = status
    ? all<Record<string, unknown>>(db, 'SELECT * FROM event_ingest WHERE store_id = ? AND status = ? ORDER BY received_at DESC LIMIT 100', [storeId, status])
    : all<Record<string, unknown>>(db, 'SELECT * FROM event_ingest WHERE store_id = ? ORDER BY received_at DESC LIMIT 100', [storeId]);
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    receivedAt: r.received_at,
    status: r.status,
    error: r.error,
    correctionOf: r.correction_of,
    payload: JSON.parse(String(r.payload_json)),
  }));
}

export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads/decrypts the stored secret and lazily migrates a legacy plaintext value. */
export function getWebhookSecret(db: Db, storeId: string, cfg: AppConfig): string | null {
  const row = get<{ legacy: string | null; enc: string | null }>(
    db,
    'SELECT webhook_secret AS legacy, webhook_secret_enc AS enc FROM stores WHERE id = ?',
    [storeId],
  );
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', '门店不存在');
  if (row.enc) {
    try {
      return decryptSecret(row.enc, cfg);
    } catch {
      throw new AppError(500, 'WEBHOOK_SECRET_DECRYPT_FAILED', 'Webhook 密钥无法解密，请轮换密钥');
    }
  }
  if (row.legacy) {
    const enc = encryptSecret(row.legacy, cfg);
    run(db, 'UPDATE stores SET webhook_secret_enc = ?, webhook_secret = NULL, webhook_secret_rotated_at = ? WHERE id = ?', [
      enc,
      Date.now(),
      storeId,
    ]);
    return row.legacy;
  }
  return null;
}

export function ensureWebhookSecret(db: Db, storeId: string, cfg: AppConfig): string {
  return getWebhookSecret(db, storeId, cfg) ?? rotateWebhookSecret(db, storeId, cfg).secret;
}

export function rotateWebhookSecret(db: Db, storeId: string, cfg: AppConfig): { secret: string; note: string } {
  const secret = `whsec_${id('key')}`;
  const enc = encryptSecret(secret, cfg);
  run(db, 'UPDATE stores SET webhook_secret_enc = ?, webhook_secret = NULL, webhook_secret_rotated_at = ? WHERE id = ?', [
    enc,
    Date.now(),
    storeId,
  ]);
  return { secret, note: '仅显示一次；旧签名立即失效；密文使用 AES-256-GCM 存储' };
}

/** One-time startup migration: no plaintext webhook secret remains at rest. */
export function migrateWebhookSecrets(db: Db, cfg: AppConfig): number {
  const rows = all<{ id: string; legacy: string }>(
    db,
    'SELECT id, webhook_secret AS legacy FROM stores WHERE webhook_secret IS NOT NULL AND webhook_secret_enc IS NULL',
  );
  for (const row of rows) {
    run(db, 'UPDATE stores SET webhook_secret_enc = ?, webhook_secret = NULL, webhook_secret_rotated_at = ? WHERE id = ?', [
      encryptSecret(row.legacy, cfg),
      Date.now(),
      row.id,
    ]);
  }
  return rows.length;
}

export function correctIngestEvent(
  db: Db,
  storeId: string,
  originalId: string,
  event: IngestEvent,
  actorId: string,
): IngestOutcome {
  const original = get<{ id: string; external_id: string }>(db, 'SELECT id, external_id FROM event_ingest WHERE id = ? AND store_id = ?', [originalId, storeId]);
  if (!original) throw new AppError(404, 'INGEST_NOT_FOUND', '原始事件不存在');
  const outcome = ingestEvent(db, storeId, 'correction', event, {
    signatureValid: true,
    actorId,
    correctionOf: original.id,
    externalIdOverride: `correction-${original.external_id}-${Date.now()}`,
    throwOnError: true,
  });
  run(db, "UPDATE event_ingest SET status = 'corrected' WHERE id = ?", [original.id]);
  return outcome;
}

export function recordSimulatorEvent(
  db: Db,
  storeId: string,
  eventId: string,
  type: string,
  occurredAt: number,
  payload: Record<string, unknown>,
): void {
  const now = Date.now();
  const inserted = run(
    db,
    `INSERT OR IGNORE INTO event_ingest(id, store_id, source, external_id, event_type, occurred_at, received_at,
       payload_json, status, signature_valid, applied_event_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id('ing'), storeId, 'simulator', eventId, type, occurredAt, now, JSON.stringify(payload), 'applied', 1, eventId, now],
  );
  if (Number(inserted.changes) === 1) {
    updateState(db, storeId, { receivedAt: now, appliedAt: now, eventAt: occurredAt, source: 'simulator' });
  }
}
