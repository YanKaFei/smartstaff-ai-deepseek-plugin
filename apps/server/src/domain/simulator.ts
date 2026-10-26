import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { all, get, run } from '../lib/db.js';
import { id, hashSeed, mulberry32 } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { businessDateKey, formatTime, localParts, MINUTE_MS, parseHHMM } from '../lib/time.js';
import { getClock, setClock, setLastSimAt, storeNow } from './clock.js';
import { ensureBusinessDay } from './ops.js';
import { getStore, mapPartyToTable, parseConfig } from './stores.js';
import { expireDueOffers, processStaleShifts } from './dispatch.js';
import { generateForecast } from './forecast.js';
import { recordSimulatorEvent } from './ingest.js';
import type { QueueRow, TableRow } from './ops.js';
import type { StoreConfig, TableType } from './types.js';

interface SimTable extends TableRow {
  seatedAt: number | null;
  checkoutAt: number | null;
}

const HOUR_FACTOR: Record<number, number> = {
  0: 0.06, 1: 0.02, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0.02, 13: 0.03, 14: 0.05, 15: 0.12, 16: 0.3, 17: 0.65, 18: 1.0, 19: 1.15,
  20: 0.95, 21: 0.62, 22: 0.38, 23: 0.16,
};

function isOpen(cfg: StoreConfig, minuteOfDay: number): boolean {
  const start = parseHHMM(cfg.basic.hoursStart);
  const end = parseHHMM(cfg.basic.hoursEnd);
  if (end > start) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

function sampleParty(rng: () => number, cfg: StoreConfig) {
  const r = rng();
  if (r < 0.28) return 2;
  if (r < 0.62) return 4;
  if (r < 0.86) return 6;
  return 8;
}

function findFreeTable(tables: SimTable[], desired: TableType): SimTable | undefined {
  const order: TableType[] = ['small', 'medium', 'large'];
  const start = order.indexOf(desired);
  const candidates = [...order.slice(start), ...order.slice(0, start)];
  for (const type of candidates) {
    const t = tables.find((x) => x.status === 'available' && x.table_type === type);
    if (t) return t;
  }
  return undefined;
}

function event(
  db: Db,
  storeId: string,
  type: string,
  at: number,
  opts: { tableId?: string | null; queueId?: string | null; payload?: Record<string, unknown> } = {},
): void {
  const eventId = id('evt');
  run(
    db,
    'INSERT INTO ops_events(id, store_id, type, table_id, queue_id, payload_json, occurred_at, source) VALUES(?,?,?,?,?,?,?,?)',
    [
      eventId,
      storeId,
      type,
      opts.tableId ?? null,
      opts.queueId ?? null,
      JSON.stringify(opts.payload ?? {}),
      at,
      'sim',
    ],
  );
  // Mirror every simulator transition into the unified ingestion ledger.
  recordSimulatorEvent(db, storeId, eventId, type, at, { ...(opts.payload ?? {}), tableId: opts.tableId, queueId: opts.queueId });
}

function loadTables(db: Db, storeId: string): SimTable[] {
  const tables = all<TableRow>(db, 'SELECT * FROM store_tables WHERE store_id = ?', [storeId]);
  return tables.map((t) => {
    let seatedAt: number | null = null;
    let checkoutAt: number | null = null;
    if (t.current_session_id) {
      const s = get<{ seated_at: number; checkout_at: number | null }>(
        db,
        'SELECT seated_at, checkout_at FROM dining_sessions WHERE id = ?',
        [t.current_session_id],
      );
      seatedAt = s?.seated_at ?? null;
      checkoutAt = s?.checkout_at ?? null;
    }
    return { ...t, seatedAt, checkoutAt };
  });
}

function seatGroup(
  db: Db,
  storeId: string,
  tables: SimTable[],
  table: SimTable,
  partySize: number,
  at: number,
  businessDate: string,
  queueRow?: QueueRow,
): string {
  const sessionId = id('ses');
  run(
    db,
    `INSERT INTO dining_sessions(id, store_id, table_id, table_type, party_size, seated_at, source, business_date)
     VALUES(?,?,?,?,?,?,?,?)`,
    [sessionId, storeId, table.id, table.table_type, partySize, at, 'sim', businessDate],
  );
  run(db, "UPDATE store_tables SET status = 'dining', current_session_id = ?, status_updated_at = ? WHERE id = ?", [
    sessionId,
    at,
    table.id,
  ]);
  table.status = 'dining';
  table.current_session_id = sessionId;
  table.seatedAt = at;
  table.checkoutAt = null;
  table.status_updated_at = at;
  event(db, storeId, 'seat', at, {
    tableId: table.id,
    queueId: queueRow?.id ?? null,
    payload: { partySize, tableType: table.table_type },
  });
  return sessionId;
}

interface SimSummary {
  from: number;
  to: number;
  arrivals: number;
  seated: number;
  checkout: number;
  left: number;
  cleaned: number;
  calls: number;
  latestCallNo: number;
  queueGroups: number;
  forecastGenerated: boolean;
}

/**
 * Event-driven barbecue restaurant simulator. It writes every transition to
 * the same tables the manual flow uses: arrivals, calls, seating, checkout,
 * leaving and table cleaning. Forecasts only read events at or before "now".
 */
export async function simulateUntil(
  db: Db,
  storeId: string,
  targetNow: number,
  cfg: AppConfig,
): Promise<SimSummary> {
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  const clock = getClock(db, storeId);
  const from = clock.lastSimAt === 0 ? targetNow : Math.max(clock.lastSimAt, targetNow - 240 * MINUTE_MS);
  const startMinute = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
  const tables = loadTables(db, storeId);
  const day = ensureBusinessDay(db, store, targetNow);
  const businessDate = businessDateKey(targetNow, store.hours_end);
  const latestCallRow = get<{ n: number | null }>(
    db,
    'SELECT MAX(call_no) as n FROM queue_entries WHERE store_id = ? AND business_date = ?',
    [storeId, businessDate],
  );
  let latestCallNo = Math.max(day.latest_call_no, latestCallRow?.n ?? 0);
  const rng = mulberry32(hashSeed(`${storeId}:${startMinute}:${targetNow}`));
  const summary: SimSummary = {
    from,
    to: targetNow,
    arrivals: 0,
    seated: 0,
    checkout: 0,
    left: 0,
    cleaned: 0,
    calls: 0,
    latestCallNo,
    queueGroups: 0,
    forecastGenerated: false,
  };

  const totalTables = tables.length;
  const avgTurnover = (() => {
    const total = totalTables || 1;
    const min =
      (config.tables.small.count * config.tables.small.avgDiningMin +
        config.tables.medium.count * config.tables.medium.avgDiningMin +
        config.tables.large.count * config.tables.large.avgDiningMin) /
      total;
    return min + config.tables.checkoutToLeaveMin + config.tables.leaveToCleanMin;
  })();

  let queue: QueueRow[] = all<QueueRow>(
    db,
    "SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called') ORDER BY joined_at",
    [storeId, businessDate],
  );

  const capacityOf = (type: TableType) => config.tables[type];

  for (let minute = startMinute; minute <= targetNow; minute += MINUTE_MS) {
    const p = localParts(minute);
    if (!isOpen(config, p.minuteOfDay)) {
      latestCallNo = Math.max(latestCallNo, 0);
      continue;
    }

    // 1. Turnover: checkout -> leave -> clean.
    for (const table of tables) {
      if (!table.current_session_id) continue;
      if (table.status === 'dining') {
        const dining = capacityOf(table.table_type).avgDiningMin * MINUTE_MS;
        if (table.seatedAt !== null && minute >= table.seatedAt + dining) {
          run(db, 'UPDATE dining_sessions SET checkout_at = ? WHERE id = ?', [minute, table.current_session_id]);
          run(db, "UPDATE store_tables SET status = 'checkout', status_updated_at = ? WHERE id = ?", [minute, table.id]);
          table.status = 'checkout';
          table.checkoutAt = minute;
          table.status_updated_at = minute;
          summary.checkout += 1;
          event(db, storeId, 'checkout', minute, { tableId: table.id });
        }
      } else if (table.status === 'checkout') {
        const checkoutAt = table.checkoutAt ?? table.status_updated_at;
        if (minute >= checkoutAt + config.tables.checkoutToLeaveMin * MINUTE_MS) {
          run(db, 'UPDATE dining_sessions SET left_at = ? WHERE id = ?', [minute, table.current_session_id]);
          run(db, "UPDATE store_tables SET status = 'cleaning', status_updated_at = ? WHERE id = ?", [minute, table.id]);
          table.status = 'cleaning';
          table.checkoutAt = null;
          table.status_updated_at = minute;
          summary.left += 1;
          event(db, storeId, 'leave', minute, { tableId: table.id });
        }
      } else if (table.status === 'cleaning') {
        if (minute >= table.status_updated_at + config.tables.leaveToCleanMin * MINUTE_MS) {
          run(db, 'UPDATE dining_sessions SET cleaned_at = ? WHERE id = ?', [minute, table.current_session_id]);
          run(db, 'UPDATE store_tables SET status = ?, current_session_id = NULL, status_updated_at = ? WHERE id = ?', [
            'available',
            minute,
            table.id,
          ]);
          table.status = 'available';
          table.current_session_id = null;
          table.seatedAt = null;
          table.status_updated_at = minute;
          summary.cleaned += 1;
          event(db, storeId, 'clean_done', minute, { tableId: table.id });
        }
      }
    }

    // 2. New arrivals (only when the store is open).
    const factor = HOUR_FACTOR[p.hours] ?? 0.1;
    const arrivalProbability = (totalTables / Math.max(30, avgTurnover)) * factor;
    if (rng() < arrivalProbability) {
      const partySize = sampleParty(rng, config);
      const desired = mapPartyToTable(config, partySize);
      const queueId = id('q');
      const table = findFreeTable(tables, desired);
      const joinedAt = minute - 2 * MINUTE_MS;
      if (table) {
        latestCallNo += 1;
        run(
          db,
          `INSERT INTO queue_entries(id, store_id, call_no, party_size, desired_type, status, joined_at, called_at, seated_at, table_id, source, business_date)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [queueId, storeId, latestCallNo, partySize, desired, 'seated', joinedAt, minute - MINUTE_MS, minute, table.id, 'sim', businessDate],
        );
        event(db, storeId, 'queue_call', minute - MINUTE_MS, {
          queueId,
          payload: { callNo: latestCallNo, partySize },
        });
        seatGroup(db, storeId, tables, table, partySize, minute, businessDate, {
          id: queueId,
        } as QueueRow);
        summary.calls += 1;
        summary.arrivals += 1;
        summary.seated += 1;
      } else {
        run(
          db,
          `INSERT INTO queue_entries(id, store_id, call_no, party_size, desired_type, status, joined_at, source, business_date)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          [queueId, storeId, null, partySize, desired, 'queued', minute, 'sim', businessDate],
        );
        summary.arrivals += 1;
        event(db, storeId, 'queue_join', minute, { queueId, payload: { partySize, desiredType: desired } });
      }
      queue = all<QueueRow>(
        db,
        "SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called') ORDER BY joined_at",
        [storeId, businessDate],
      );
    }

    // 3. Seat groups that were called at least a minute ago.
    for (const entry of queue.filter((q) => q.status === 'called')) {
      if (!entry.called_at || minute < entry.called_at + MINUTE_MS) continue;
      const table = findFreeTable(tables, entry.desired_type);
      if (!table) continue;
      const updated = run(
        db,
        "UPDATE queue_entries SET status = 'seated', seated_at = ?, table_id = ? WHERE id = ? AND status = 'called'",
        [minute, table.id, entry.id],
      );
      if (Number(updated.changes) !== 1) continue;
      seatGroup(db, storeId, tables, table, entry.party_size, minute, businessDate, entry);
      summary.seated += 1;
    }

    // 4. Call the next waiting group when a table is free.
    queue = all<QueueRow>(
      db,
      "SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called') ORDER BY joined_at",
      [storeId, businessDate],
    );
    const calledWaiting = queue.filter((q) => q.status === 'called');
    const freeCount = tables.filter((t) => t.status === 'available').length;
    if (!calledWaiting.length && freeCount > 0) {
      const waiting = queue.filter((q) => q.status === 'queued');
      for (const entry of waiting.slice(0, freeCount)) {
        latestCallNo += 1;
        const updated = run(
          db,
          "UPDATE queue_entries SET status = 'called', call_no = ?, called_at = ? WHERE id = ? AND status = 'queued'",
          [latestCallNo, minute, entry.id],
        );
        if (Number(updated.changes) !== 1) continue;
        summary.calls += 1;
        event(db, storeId, 'queue_call', minute, {
          queueId: entry.id,
          payload: { callNo: latestCallNo, partySize: entry.party_size },
        });
      }
      queue = all<QueueRow>(
        db,
        "SELECT * FROM queue_entries WHERE store_id = ? AND business_date = ? AND status IN ('queued','called') ORDER BY joined_at",
        [storeId, businessDate],
      );
    }

    // Offers must expire on simulated time, not after the whole jump: an offer
    // that times out at 18:10 still has time to fall back before an 18:30 shift.
    expireDueOffers(db, storeId, minute);
    processStaleShifts(db, storeId, minute);
  }

  // Persist the derived counters used by the manager home.
  const waiting = queue;
  const queueGroups = waiting.length;
  const queueCustomers = waiting.reduce((sum, q) => sum + q.party_size, 0);
  run(
    db,
    'UPDATE business_days SET queue_groups = ?, queue_customers = ?, latest_call_no = ? WHERE id = ?',
    [queueGroups, queueCustomers, latestCallNo, day.id],
  );
  setLastSimAt(db, storeId, targetNow);
  summary.latestCallNo = latestCallNo;
  summary.queueGroups = queueGroups;

  // Offers that timed out while time accelerated must fall back immediately.
  expireDueOffers(db, storeId, targetNow);
  processStaleShifts(db, storeId, targetNow);

  // Recalculate demand on the same cadence a real store would inspect it.
  const latestForecast = get<{ generated_at: number }>(
    db,
    'SELECT generated_at FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1',
    [storeId],
  );
  if (!latestForecast || targetNow - latestForecast.generated_at >= 30 * MINUTE_MS) {
    await generateForecast(db, storeId, cfg, { useAi: false, now: targetNow });
    summary.forecastGenerated = true;
  }

  return summary;
}

export async function advanceSimulation(
  db: Db,
  storeId: string,
  minutes: number,
  cfg: AppConfig,
): Promise<SimSummary> {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    throw new AppError(400, 'BAD_ADVANCE', '模拟推进分钟数必须在 1-240 之间');
  }
  const target = storeNow(db, storeId) + Math.round(minutes) * MINUTE_MS;
  setClock(db, storeId, { at: target, running: false });
  const summary = await simulateUntil(db, storeId, target, cfg);
  setLastSummary(storeId, summary);
  return summary;
}

// Keep the latest summary for the simulator status panel.
let lastSummary: { storeId: string; summary: SimSummary } | null = null;

export function setLastSummary(storeId: string, summary: SimSummary): void {
  lastSummary = { storeId, summary };
}

export async function advanceSimulationAndSummarize(
  db: Db,
  storeId: string,
  minutes: number,
  cfg: AppConfig,
): Promise<SimSummary> {
  const summary = await advanceSimulation(db, storeId, minutes, cfg);
  setLastSummary(storeId, summary);
  return summary;
}

export function setSimRunning(db: Db, storeId: string, running: boolean, speed?: number): void {
  const clock = getClock(db, storeId);
  setClock(db, storeId, {
    running,
    speed: speed ?? clock.speed,
  });
  if (running && clock.lastSimAt === 0) setLastSimAt(db, storeId, storeNow(db, storeId));
}

export async function tickRunningStores(db: Db, cfg: AppConfig): Promise<void> {
  const stores = all<{ store_id: string; speed: number; updated_at: number; offset_ms: number }>(
    db,
    'SELECT store_id, speed, updated_at, offset_ms FROM store_clocks WHERE running = 1',
  );
  for (const store of stores) {
    const elapsed = Math.min(5000, Math.max(0, Date.now() - store.updated_at));
    if (elapsed < 200) continue;
    const delta = Math.round(elapsed * store.speed);
    const target = Date.now() + store.offset_ms + delta;
    setClock(db, store.store_id, { at: target, running: true });
    try {
      const summary = await simulateUntil(db, store.store_id, target, cfg);
      setLastSummary(store.store_id, summary);
    } catch (err) {
      // Keep the ticker alive; surface the failure in logs.
      console.error('simulation_tick_failed', { storeId: store.store_id, err });
    }
  }
}

export function simulationStatus(db: Db, storeId: string) {
  const store = getStore(db, storeId);
  const clock = getClock(db, storeId);
  const now = storeNow(db, storeId);
  const day = ensureBusinessDay(db, store, now);
  return {
    storeId,
    now,
    nowLabel: formatTime(now),
    businessDate: day.business_date,
    running: clock.running,
    speed: clock.speed,
    lastSimAt: clock.lastSimAt,
    lastSummary: lastSummary?.storeId === storeId ? lastSummary.summary : null,
    dataSource: parseConfig(store).dataSource,
  };
}

export type { SimSummary };
