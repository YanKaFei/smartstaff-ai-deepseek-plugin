import type { Db } from '../db/index.js';
import { all, get, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { businessDateKey, formatTime, minutesBetween, round2, startOfLocalDay } from '../lib/time.js';
import { storeNow } from './clock.js';
import { getStore, mapPartyToTable, parseConfig, type StoreRow } from './stores.js';
import { audit, createException } from './notify.js';
import { listDemands } from './dispatch.js';
import { TABLE_TYPES, type TableStatus, type TableType } from './types.js';

export interface TableRow {
  id: string;
  store_id: string;
  table_type: TableType;
  label: string;
  seats: number;
  status: TableStatus;
  current_session_id: string | null;
  status_updated_at: number;
}

export interface QueueRow {
  id: string;
  store_id: string;
  call_no: number | null;
  party_size: number;
  desired_type: TableType;
  status: 'queued' | 'called' | 'seated' | 'abandoned';
  joined_at: number;
  called_at: number | null;
  seated_at: number | null;
  abandoned_at: number | null;
  table_id: string | null;
  source: string;
  business_date: string;
}

export interface BusinessDayRow {
  id: string;
  store_id: string;
  business_date: string;
  status: 'draft' | 'confirmed' | 'closed';
  on_duty_staff: number;
  queue_groups: number;
  queue_customers: number;
  latest_call_no: number;
  confirmed_at: number | null;
  closed_at: number | null;
  created_at: number;
}

export function ensureBusinessDay(db: Db, store: StoreRow, now: number): BusinessDayRow {
  const date = businessDateKey(now, store.hours_end);
  let row = get<BusinessDayRow>(db, 'SELECT * FROM business_days WHERE store_id = ? AND business_date = ?', [
    store.id,
    date,
  ]);
  if (!row) {
    const cfg = parseConfig(store);
    run(
      db,
      `INSERT INTO business_days(id, store_id, business_date, status, on_duty_staff, queue_groups, queue_customers, latest_call_no, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [id('day'), store.id, date, 'draft', cfg.staffing.onDutyCount, 0, 0, 0, now],
    );
    row = get<BusinessDayRow>(db, 'SELECT * FROM business_days WHERE store_id = ? AND business_date = ?', [
      store.id,
      date,
    ])!;
  }
  return row;
}

function dayQueue(db: Db, storeId: string, date: string): QueueRow[] {
  return all<QueueRow>(
    db,
    `SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called')
     ORDER BY CASE status WHEN 'called' THEN 0 ELSE 1 END, joined_at ASC`,
    [storeId, date],
  );
}

function tableList(db: Db, storeId: string): TableRow[] {
  return all<TableRow>(
    db,
    "SELECT * FROM store_tables WHERE store_id = ? ORDER BY CASE table_type WHEN 'small' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, CAST(SUBSTR(label, 2) AS INTEGER)",
    [storeId],
  );
}

export function latestCallNo(db: Db, store: StoreRow, day: BusinessDayRow): number {
  const row = get<{ n: number | null }>(
    db,
    'SELECT MAX(call_no) as n FROM queue_entries WHERE store_id = ? AND business_date = ?',
    [store.id, day.business_date],
  );
  return Math.max(day.latest_call_no, row?.n ?? 0);
}

function sessionOf(db: Db, table: TableRow): Record<string, unknown> | null {
  if (!table.current_session_id) return null;
  const s = get<{
    id: string;
    party_size: number;
    seated_at: number;
    checkout_at: number | null;
    left_at: number | null;
    cleaned_at: number | null;
  }>(db, 'SELECT id, party_size, seated_at, checkout_at, left_at, cleaned_at FROM dining_sessions WHERE id = ?', [
    table.current_session_id,
  ]);
  if (!s) return null;
  return {
    id: s.id,
    partySize: s.party_size,
    seatedAt: s.seated_at,
    checkoutAt: s.checkout_at,
    leftAt: s.left_at,
    cleanedAt: s.cleaned_at,
  };
}

export function tableApi(db: Db, t: TableRow, now: number) {
  const session = sessionOf(db, t);
  return {
    id: t.id,
    label: t.label,
    type: t.table_type,
    seats: t.seats,
    status: t.status,
    statusUpdatedAt: t.status_updated_at,
    elapsedMin: session ? minutesBetween(session.seatedAt as number, now) : 0,
    session,
  };
}

function writeEvent(
  db: Db,
  storeId: string,
  type: string,
  at: number,
  opts: { tableId?: string | null; queueId?: string | null; payload?: Record<string, unknown>; source?: string } = {},
): void {
  run(
    db,
    'INSERT INTO ops_events(id, store_id, type, table_id, queue_id, payload_json, occurred_at, source) VALUES(?,?,?,?,?,?,?,?)',
    [
      id('evt'),
      storeId,
      type,
      opts.tableId ?? null,
      opts.queueId ?? null,
      JSON.stringify(opts.payload ?? {}),
      at,
      opts.source ?? 'manual',
    ],
  );
}

export function todayView(db: Db, storeId: string) {
  const store = getStore(db, storeId);
  const cfg = parseConfig(store);
  const now = storeNow(db, storeId);
  const day = ensureBusinessDay(db, store, now);
  const tables = tableList(db, storeId);
  const queue = dayQueue(db, storeId, day.business_date);
  const groups = queue.length;
  const customers = queue.reduce((sum, q) => sum + q.party_size, 0);
  const latest = latestCallNo(db, store, day);
  const dayStart = startOfLocalDay(now);

  const occupied = tables.filter((t) => t.status !== 'available').length;
  const byType = TABLE_TYPES.map((type) => {
    const ts = tables.filter((t) => t.table_type === type);
    return {
      type,
      label: type === 'small' ? '小桌' : type === 'medium' ? '中桌' : '大桌',
      total: ts.length,
      available: ts.filter((t) => t.status === 'available').length,
      dining: ts.filter((t) => t.status === 'dining').length,
      checkout: ts.filter((t) => t.status === 'checkout').length,
      cleaning: ts.filter((t) => t.status === 'cleaning').length,
    };
  });

  const events = all<{
    id: string;
    type: string;
    occurred_at: number;
    table_id: string | null;
    queue_id: string | null;
    payload_json: string;
  }>(
    db,
    'SELECT * FROM ops_events WHERE store_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 20',
    [storeId, dayStart],
  );

  const lastForecast = get<{
    id: string;
    required_staff: number;
    on_duty_staff: number;
    gap: number;
    reliability: string;
    bottleneck: string;
    generated_at: number;
  }>(
    db,
    'SELECT id, required_staff, on_duty_staff, gap, reliability, bottleneck, generated_at FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1',
    [storeId],
  );

  const planCount = get<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM assignment_plans WHERE store_id = ? AND status = 'proposed'",
    [storeId],
  );
  const shiftCounts = all<{ status: string; n: number }>(
    db,
    "SELECT status, COUNT(*) as n FROM shifts WHERE store_id = ? AND start_at >= ? GROUP BY status",
    [storeId, dayStart],
  );
  const unread = (() => {
    const manager = get<{ id: string }>(
      db,
      "SELECT id FROM users WHERE role = 'manager' AND store_id = ? LIMIT 1",
      [storeId],
    );
    if (!manager) return 0;
    const row = get<{ n: number }>(db, 'SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read = 0', [
      manager.id,
    ]);
    return row?.n ?? 0;
  })();

  const walkIns = all<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM dining_sessions WHERE store_id = ? AND seated_at >= ? AND source != 'history'",
    [storeId, dayStart],
  )[0]?.n ?? 0;

  const lastDay = get<{ on_duty_staff: number }>(
    db,
    "SELECT on_duty_staff FROM business_days WHERE store_id = ? AND status = 'confirmed' AND business_date < ? ORDER BY business_date DESC LIMIT 1",
    [storeId, day.business_date],
  );

  return {
    store: {
      id: store.id,
      name: store.name,
      managerCode: store.manager_code,
      address: store.address,
      hoursStart: store.hours_start,
      hoursEnd: store.hours_end,
      jobType: store.job_type,
      hourlyRate: store.hourly_rate,
      onboarded: Boolean(store.onboarded_at),
    },
    now,
    nowLabel: formatTime(now),
    businessDate: day.business_date,
    businessDay: {
      id: day.id,
      status: day.status,
      confirmedAt: day.confirmed_at,
      onDutyStaff: day.on_duty_staff,
      latestCallNo: latest,
      suggestedOnDutyStaff: lastDay?.on_duty_staff ?? cfg.staffing.onDutyCount,
    },
    queue: {
      groups,
      customers,
      latestCallNo: latest,
      entries: queue.map((q) => ({
        id: q.id,
        callNo: q.call_no,
        partySize: q.party_size,
        desiredType: q.desired_type,
        status: q.status,
        joinedAt: q.joined_at,
        calledAt: q.called_at,
        waitedMin: minutesBetween(q.joined_at, now),
      })),
      estimatedWaitMin: groups === 0 ? 0 : Math.round((groups / Math.max(1, tables.length)) * cfg.tables.medium.avgDiningMin),
    },
    tables: {
      total: tables.length,
      occupied,
      byType,
      list: tables.map((t) => tableApi(db, t, now)),
    },
    metrics: {
      seatedToday: walkIns,
      occupancyRate: tables.length ? round2(occupied / tables.length) : 0,
    },
    forecast: lastForecast
      ? {
          id: lastForecast.id,
          requiredStaff: lastForecast.required_staff,
          onDutyStaff: lastForecast.on_duty_staff,
          gap: lastForecast.gap,
          reliability: lastForecast.reliability,
          bottleneck: lastForecast.bottleneck,
          generatedAt: lastForecast.generated_at,
        }
      : null,
    proposedPlans: planCount?.n ?? 0,
    assignments: Object.fromEntries(shiftCounts.map((s) => [s.status, s.n])),
    unreadNotifications: unread,
    coverage: (() => {
      const demands = listDemands(db, storeId).filter((d) => d.status !== 'cancelled' && d.endAt >= now - 6 * 3_600_000);
      const committed = demands.reduce((sum, d) => sum + d.committed, 0);
      const pending = demands.reduce((sum, d) => sum + d.pending, 0);
      const unfilled = demands.reduce((sum, d) => sum + d.unfilled, 0);
      const noShow = demands.reduce((sum, d) => sum + d.noShow, 0);
      const checkedIn = demands.reduce((sum, d) => sum + d.checkedIn, 0);
      const confirmed = demands.reduce((sum, d) => sum + d.confirmed, 0);
      const openExceptions = get<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM exceptions WHERE store_id = ? AND status = 'open'",
        [storeId],
      )?.n ?? 0;
      return { demands, committed, pending, unfilled, noShow, checkedIn, confirmed, openExceptions };
    })(),
    lastEvents: events.map((e) => ({
      id: e.id,
      type: e.type,
      at: e.occurred_at,
      tableId: e.table_id,
      queueId: e.queue_id,
      payload: JSON.parse(e.payload_json) as Record<string, unknown>,
    })),
  };
}

export function confirmBusinessDay(
  db: Db,
  storeId: string,
  input: {
    onDutyStaff?: number;
    queueGroups?: number;
    latestCallNo?: number;
    actorId?: string;
  },
  now = storeNow(db, storeId),
) {
  const store = getStore(db, storeId);
  return transaction(db, () => {
    const day = ensureBusinessDay(db, store, now);
    const onDuty = input.onDutyStaff ?? (day.status === 'draft' ? day.on_duty_staff : day.on_duty_staff);
    if (onDuty !== undefined) {
      if (!Number.isInteger(onDuty) || onDuty < 0 || onDuty > 100) {
        throw new AppError(400, 'BAD_COUNTER', '在岗员工数量必须是 0-100 的整数');
      }
      run(db, 'UPDATE business_days SET on_duty_staff = ? WHERE id = ?', [onDuty, day.id]);
    }
    if (input.queueGroups !== undefined) {
      syncQueueGroups(db, storeId, day.business_date, input.queueGroups, now);
    }
    if (input.latestCallNo !== undefined && input.latestCallNo > day.latest_call_no) {
      run(db, 'UPDATE business_days SET latest_call_no = ? WHERE id = ?', [input.latestCallNo, day.id]);
    }
    if (day.status === 'draft') {
      run(db, "UPDATE business_days SET status = 'confirmed', confirmed_at = ? WHERE id = ?", [now, day.id]);
    }
    const refreshed = get<BusinessDayRow>(db, 'SELECT * FROM business_days WHERE id = ?', [day.id])!;
    audit(db, {
      storeId,
      actorId: input.actorId ?? null,
      actorRole: 'manager',
      action: day.status === 'draft' ? 'business_day.confirm' : 'business_day.update',
      entity: 'business_day',
      entityId: day.id,
      detail: { onDutyStaff: refreshed.on_duty_staff, queueGroups: input.queueGroups },
      at: now,
    });
    return todayView(db, storeId);
  });
}

/** Keep the manual queue counter honest by materialising/abandoning queue rows. */
function syncQueueGroups(db: Db, storeId: string, date: string, target: number, now: number): void {
  if (!Number.isInteger(target) || target < 0 || target > 200) {
    throw new AppError(400, 'BAD_COUNTER', '排队组数必须是 0-200 的整数');
  }
  const current = dayQueue(db, storeId, date);
  if (current.length < target) {
    const store = getStore(db, storeId);
    const cfg = parseConfig(store);
    for (let i = current.length; i < target; i += 1) {
      const partySize = 2 + (i % 4);
      run(
        db,
        'INSERT INTO queue_entries(id, store_id, party_size, desired_type, status, joined_at, source, business_date) VALUES(?,?,?,?,?,?,?,?)',
        [id('q'), storeId, partySize, mapPartyToTable(cfg, partySize), 'queued', now, 'manual', date],
      );
    }
  } else if (current.length > target) {
    const removable = current.filter((q) => q.status === 'queued').slice(-(current.length - target));
    for (const q of removable) {
      run(db, "UPDATE queue_entries SET status = 'abandoned', abandoned_at = ? WHERE id = ?", [now, q.id]);
      writeEvent(db, storeId, 'queue_abandoned', now, { queueId: q.id, payload: { reason: 'counter_adjust' } });
    }
  }
}

export type OpsCommand =
  | { type: 'join_queue'; partySize?: number }
  | { type: 'abandon_queue'; queueId?: string }
  | { type: 'call_next'; callNo?: number }
  | { type: 'seat'; queueId: string; tableId?: string }
  | { type: 'checkout'; tableId: string }
  | { type: 'leave'; tableId: string }
  | { type: 'clean'; tableId: string }
  | { type: 'set_on_duty'; onDutyStaff: number };

export function applyOps(
  db: Db,
  storeId: string,
  command: OpsCommand,
  opts: { actorId?: string; source?: string; at?: number } = {},
) {
  const store = getStore(db, storeId);
  const now = opts.at ?? storeNow(db, storeId);
  const cfg = parseConfig(store);
  const result = transaction(db, () => {
    const day = ensureBusinessDay(db, store, now);
    switch (command.type) {
      case 'join_queue': {
        const partySize = command.partySize ?? 2;
        if (!Number.isInteger(partySize) || partySize < 1 || partySize > 30) {
          throw new AppError(400, 'BAD_PARTY_SIZE', '顾客人数必须是 1-30 的整数');
        }
        const desired = mapPartyToTable(cfg, partySize);
        const queueId = id('q');
        run(
          db,
          'INSERT INTO queue_entries(id, store_id, party_size, desired_type, status, joined_at, source, business_date) VALUES(?,?,?,?,?,?,?,?)',
          [queueId, storeId, partySize, desired, 'queued', now, opts.source ?? 'manual', day.business_date],
        );
        writeEvent(db, storeId, 'queue_join', now, {
          queueId,
          payload: { partySize, desiredType: desired },
          source: opts.source,
        });
        return { queueId };
      }
      case 'abandon_queue': {
        const rows = dayQueue(db, storeId, day.business_date).filter((q) => q.status === 'queued');
        const target = command.queueId ? rows.find((q) => q.id === command.queueId) : rows[rows.length - 1];
        if (!target) throw new AppError(409, 'NO_QUEUE', '没有可取消的排队');
        run(db, "UPDATE queue_entries SET status = 'abandoned', abandoned_at = ? WHERE id = ?", [now, target.id]);
        writeEvent(db, storeId, 'queue_abandoned', now, { queueId: target.id, source: opts.source });
        return { queueId: target.id };
      }
      case 'call_next': {
        const queued = dayQueue(db, storeId, day.business_date).filter((q) => q.status === 'queued');
        if (!queued.length) throw new AppError(409, 'NO_QUEUE', '当前没有等待叫号的顾客');
        const next = queued[0];
        const currentMax = latestCallNo(db, store, day);
        const callNo = command.callNo ?? currentMax + 1;
        if (callNo <= currentMax && command.callNo !== undefined) {
          throw new AppError(409, 'CALL_NO_BACKWARDS', `叫号号码必须大于当前最新号码 ${currentMax}`);
        }
        run(
          db,
          "UPDATE queue_entries SET status = 'called', call_no = ?, called_at = ? WHERE id = ? AND status = 'queued'",
          [callNo, now, next.id],
        );
        run(db, 'UPDATE business_days SET latest_call_no = ? WHERE id = ?', [Math.max(callNo, currentMax), day.id]);
        writeEvent(db, storeId, 'queue_call', now, {
          queueId: next.id,
          payload: { callNo, partySize: next.party_size },
          source: opts.source,
        });
        return { queueId: next.id, callNo };
      }
      case 'seat': {
        const entry = get<QueueRow>(db, 'SELECT * FROM queue_entries WHERE id = ? AND store_id = ?', [
          command.queueId,
          storeId,
        ]);
        if (!entry) throw new AppError(404, 'QUEUE_NOT_FOUND', '排队记录不存在');
        if (entry.status !== 'queued' && entry.status !== 'called') {
          throw new AppError(409, 'QUEUE_NOT_WAITING', '该排队已结束，不能重复入座');
        }
        const table = pickTable(db, storeId, entry, command.tableId);
        const sessionId = id('ses');
        run(
          db,
          `INSERT INTO dining_sessions(id, store_id, table_id, table_type, party_size, seated_at, source, business_date)
           VALUES(?,?,?,?,?,?,?,?)`,
          [sessionId, storeId, table.id, table.table_type, entry.party_size, now, opts.source ?? 'manual', day.business_date],
        );
        run(
          db,
          "UPDATE queue_entries SET status = 'seated', seated_at = ?, table_id = ? WHERE id = ? AND status IN ('queued','called')",
          [now, table.id, entry.id],
        );
        run(db, "UPDATE store_tables SET status = 'dining', current_session_id = ?, status_updated_at = ? WHERE id = ?", [
          sessionId,
          now,
          table.id,
        ]);
        writeEvent(db, storeId, 'seat', now, {
          tableId: table.id,
          queueId: entry.id,
          payload: { partySize: entry.party_size, tableType: table.table_type },
          source: opts.source,
        });
        return { tableId: table.id, sessionId };
      }
      case 'checkout':
      case 'leave':
      case 'clean': {
        const table = get<TableRow>(db, 'SELECT * FROM store_tables WHERE id = ? AND store_id = ?', [
          command.tableId,
          storeId,
        ]);
        if (!table) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位不存在');
        if (!table.current_session_id) {
          throw new AppError(409, 'NO_SESSION', '该桌位没有进行中的用餐');
        }
        const session = get<{
          id: string;
          seated_at: number;
          checkout_at: number | null;
        }>(db, 'SELECT id, seated_at, checkout_at FROM dining_sessions WHERE id = ?', [table.current_session_id]);
        if (!session) throw new AppError(409, 'NO_SESSION', '用餐记录缺失');

        if (command.type === 'checkout') {
          if (table.status !== 'dining') throw new AppError(409, 'BAD_TABLE_STATE', '只有用餐中的桌位可以结账');
          if (session.checkout_at) throw new AppError(409, 'ALREADY_CHECKOUT', '该桌已结账');
          run(db, 'UPDATE dining_sessions SET checkout_at = ? WHERE id = ?', [now, session.id]);
          run(db, "UPDATE store_tables SET status = 'checkout', status_updated_at = ? WHERE id = ?", [now, table.id]);
          writeEvent(db, storeId, 'checkout', now, { tableId: table.id, source: opts.source });
        } else if (command.type === 'leave') {
          if (table.status !== 'checkout') throw new AppError(409, 'BAD_TABLE_STATE', '请先完成结账');
          run(db, 'UPDATE dining_sessions SET left_at = ? WHERE id = ?', [now, session.id]);
          run(db, "UPDATE store_tables SET status = 'cleaning', status_updated_at = ? WHERE id = ?", [now, table.id]);
          writeEvent(db, storeId, 'leave', now, { tableId: table.id, source: opts.source });
        } else {
          if (table.status !== 'cleaning' && table.status !== 'checkout') {
            throw new AppError(409, 'BAD_TABLE_STATE', '只有待清台的桌位可以完成清台');
          }
          if (table.status === 'checkout') {
            run(db, 'UPDATE dining_sessions SET left_at = ? WHERE id = ?', [now, session.id]);
            writeEvent(db, storeId, 'leave', now, { tableId: table.id, source: opts.source, payload: { inferred: true } });
          }
          run(db, 'UPDATE dining_sessions SET cleaned_at = ? WHERE id = ?', [now, session.id]);
          run(
            db,
            "UPDATE store_tables SET status = 'available', current_session_id = NULL, status_updated_at = ? WHERE id = ?",
            [now, table.id],
          );
          writeEvent(db, storeId, 'clean_done', now, { tableId: table.id, source: opts.source });
        }
        return { tableId: table.id };
      }
      case 'set_on_duty': {
        const n = command.onDutyStaff;
        if (!Number.isInteger(n) || n < 0 || n > 100) {
          throw new AppError(400, 'BAD_COUNTER', '在岗员工数量必须是 0-100 的整数');
        }
        run(db, 'UPDATE business_days SET on_duty_staff = ? WHERE id = ?', [n, day.id]);
        return { onDutyStaff: n };
      }
      default:
        throw new AppError(400, 'UNKNOWN_OPS', '未知操作');
    }
  });
  audit(db, {
    storeId,
    actorId: opts.actorId ?? null,
    actorRole: 'manager',
    action: `ops.${command.type}`,
    entity: 'store',
    entityId: storeId,
    detail: command as unknown as Record<string, unknown>,
    at: now,
  });
  return { ...result, today: todayView(db, storeId) };
}

function pickTable(db: Db, storeId: string, entry: QueueRow, tableId?: string): TableRow {
  if (tableId) {
    const table = get<TableRow>(db, 'SELECT * FROM store_tables WHERE id = ? AND store_id = ?', [tableId, storeId]);
    if (!table) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位不存在');
    if (table.status !== 'available') throw new AppError(409, 'TABLE_BUSY', '该桌位当前不可入座');
    if (table.seats < entry.party_size) throw new AppError(409, 'TABLE_TOO_SMALL', '该桌位座位数不足');
    return table;
  }
  const order: TableType[] = ['small', 'medium', 'large'];
  const start = order.indexOf(entry.desired_type);
  const candidates = [...order.slice(start), ...order.slice(0, start)];
  for (const type of candidates) {
    const table = get<TableRow>(
      db,
      "SELECT * FROM store_tables WHERE store_id = ? AND table_type = ? AND status = 'available' AND seats >= ? ORDER BY label LIMIT 1",
      [storeId, type, entry.party_size],
    );
    if (table) return table;
  }
  throw new AppError(409, 'NO_TABLE', '暂无适配的空桌，请先完成清台');
}

export function tableActionAllowed(status: TableStatus): string[] {
  if (status === 'dining') return ['checkout'];
  if (status === 'checkout') return ['leave', 'clean'];
  if (status === 'cleaning') return ['clean'];
  return ['seat'];
}

export function listExceptions(db: Db, storeId: string) {
  const rows = all<{
    id: string;
    type: string;
    severity: string;
    status: string;
    message: string;
    shift_id: string | null;
    created_at: number;
  }>(
    db,
    'SELECT id, type, severity, status, message, shift_id, created_at FROM exceptions WHERE store_id = ? ORDER BY status ASC, created_at DESC LIMIT 100',
    [storeId],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    status: r.status,
    message: r.message,
    shiftId: r.shift_id,
    createdAt: r.created_at,
  }));
}

export function resolveException(db: Db, storeId: string, exceptionId: string, actorId: string, at: number) {
  const row = get<{ id: string }>(db, 'SELECT id FROM exceptions WHERE id = ? AND store_id = ?', [exceptionId, storeId]);
  if (!row) throw new AppError(404, 'EXCEPTION_NOT_FOUND', '异常记录不存在');
  run(db, "UPDATE exceptions SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?", [
    at,
    actorId,
    exceptionId,
  ]);
  audit(db, { storeId, actorId, actorRole: 'manager', action: 'exception.resolve', entity: 'exception', entityId: exceptionId, at });
  return listExceptions(db, storeId);
}

export { writeEvent };
