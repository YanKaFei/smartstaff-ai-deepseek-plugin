import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config as appConfig, serverRoot, type AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { all, get, run, transaction } from './lib/db.js';
import { id, hashSeed, mulberry32 } from './lib/ids.js';
import { addDays, epochFromLocal, formatTime, localParts, MINUTE_MS } from './lib/time.js';
import { ensureAdmin, hashPassword } from './lib/auth.js';
import { createStore, finishOnboarding, getStore, parseConfig, updateStoreConfig } from './domain/stores.js';
import { ensureBusinessDay } from './domain/ops.js';
import { createStaff, setAvailability } from './domain/staff.js';
import { setClock, setLastSimAt } from './domain/clock.js';
import type { AvailabilityWindow, StoreConfig, TableType } from './domain/types.js';

const DEMO_CONFIG: StoreConfig = {
  basic: {
    name: '焰遇烤肉 · 科技园店',
    hoursStart: '16:00',
    hoursEnd: '02:00',
    address: '深圳市南山区科技园科苑路 15 号',
    lat: 22.5405,
    lng: 113.9545,
    jobType: '烤肉辅助',
    hourlyRate: 32,
  },
  tables: {
    small: { count: 8, seats: 4, avgDiningMin: 70, weight: 1 },
    medium: { count: 12, seats: 6, avgDiningMin: 85, weight: 1.6 },
    large: { count: 4, seats: 10, avgDiningMin: 100, weight: 2.4 },
    checkoutToLeaveMin: 8,
    leaveToCleanMin: 6,
    partyMapping: [
      { min: 1, max: 4, type: 'small' },
      { min: 5, max: 6, type: 'medium' },
      { min: 7, max: 12, type: 'large' },
    ],
  },
  staffing: {
    onDutyCount: 3,
    shiftStart: '17:00',
    shiftEnd: '23:00',
    tablesPerStaff: 5,
    serviceBufferPct: 0,
    requireQualified: true,
    capacityModel: 'legacy',
    capacityBasis: 'standard_equivalent',
    serviceMode: 'partial',
    serviceMinutes: { small: 14, medium: 26, large: 44 },
    effectiveServiceMinutesPerSlot: 24,
    calibrationStatus: 'unverified',
  },
  matching: {
    maxDistanceKm: 5,
    minNoticeMin: 15,
    offerTtlMinutes: 10,
    travelSpeedKmh: 18,
  },
  policy: {
    staffCancelMinNoticeMin: 60,
    noShowGraceMin: 45,
    autoBackfill: true,
  },
  pilot: { shadowMode: false },
  dataSource: 'simulator',
};

interface StaffSeed {
  nickname: string;
  phone: string;
  area: string;
  distanceKm: number;
  rate: number;
  experience: number;
  onTime: number;
  status: 'approved' | 'pending' | 'suspended' | 'rejected';
  qualified: boolean;
  skills: string[];
  windows: Array<{ weekdayOffset: number; startMin: number; endMin: number }>;
  shiftsCompleted: number;
  noShow: number;
  bio: string;
}

const TODAY = 0;
const STAFF_SEEDS: StaffSeed[] = [
  { nickname: '林小雨', phone: '13800000001', area: '科技园', distanceKm: 0.6, rate: 30, experience: 3, onTime: 0.96, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1410 }, { weekdayOffset: 3, startMin: 1020, endMin: 1380 }], shiftsCompleted: 42, noShow: 0, bio: '在烤肉店做过三年助烤，熟悉换篦子和炭火节奏。' },
  { nickname: '陈浩然', phone: '13800000002', area: '深大', distanceKm: 1.4, rate: 32, experience: 2, onTime: 0.92, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1440 }, { weekdayOffset: 4, startMin: 1080, endMin: 1440 }], shiftsCompleted: 28, noShow: 1, bio: '大学生兼职，周末与晚间可到岗。' },
  { nickname: '周佳怡', phone: '13800000003', area: '粤海街道', distanceKm: 1.9, rate: 34, experience: 4, onTime: 0.98, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1050, endMin: 1440 }, { weekdayOffset: 5, startMin: 1020, endMin: 1440 }], shiftsCompleted: 61, noShow: 0, bio: '曾担任烤肉店领班，擅长高峰桌位协调。' },
  { nickname: '赵子涵', phone: '13800000004', area: '后海', distanceKm: 2.7, rate: 31, experience: 1.5, onTime: 0.89, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1380 }, { weekdayOffset: 2, startMin: 1080, endMin: 1440 }], shiftsCompleted: 17, noShow: 1, bio: '做事麻利，可快速上手清台与补炭。' },
  { nickname: '孙明轩', phone: '13800000005', area: '南头', distanceKm: 3.8, rate: 29, experience: 1, onTime: 0.9, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1410 }, { weekdayOffset: 6, startMin: 960, endMin: 1380 }], shiftsCompleted: 12, noShow: 0, bio: '希望增加晚班，可接受临时补位。' },
  { nickname: '吴思远', phone: '13800000006', area: '白石洲', distanceKm: 4.2, rate: 28, experience: 0.5, onTime: 0.86, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1050, endMin: 1440 }, { weekdayOffset: 1, startMin: 1020, endMin: 1380 }], shiftsCompleted: 6, noShow: 1, bio: '新手，已完成门店岗位培训。' },
  { nickname: '郑晓彤', phone: '13800000007', area: '科技园', distanceKm: 0.9, rate: 35, experience: 5, onTime: 0.99, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1080, endMin: 1440 }, { weekdayOffset: 3, startMin: 1020, endMin: 1440 }], shiftsCompleted: 88, noShow: 0, bio: '资深助烤，熟悉大桌与团体客服务。' },
  { nickname: '冯嘉豪', phone: '13800000008', area: '深大', distanceKm: 1.1, rate: 33, experience: 2.5, onTime: 0.95, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1050, endMin: 1440 }, { weekdayOffset: 5, startMin: 1080, endMin: 1440 }], shiftsCompleted: 35, noShow: 0, bio: '可稳定出勤，擅长高峰翻台配合。' },
  { nickname: '何雅雯', phone: '13800000009', area: '蛇口', distanceKm: 4.8, rate: 36, experience: 3.5, onTime: 0.97, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1410 }, { weekdayOffset: 2, startMin: 1020, endMin: 1380 }], shiftsCompleted: 47, noShow: 0, bio: '距离较远，但交通熟悉，可准时到店。' },
  { nickname: '许志强', phone: '13800000010', area: '科技园', distanceKm: 0.4, rate: 38, experience: 6, onTime: 0.99, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1080, endMin: 1439 }, { weekdayOffset: 4, startMin: 1080, endMin: 1440 }], shiftsCompleted: 102, noShow: 0, bio: '前任烤肉店后厨主管，可带新人。' },
  { nickname: '邓雨桐', phone: '13800000011', area: '后海', distanceKm: 2.2, rate: 30, experience: 1, onTime: 0.88, status: 'approved', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: 1, startMin: 1020, endMin: 1440 }], shiftsCompleted: 9, noShow: 0, bio: '仅周一可到岗。' },
  { nickname: '罗俊杰', phone: '13800000012', area: '南头', distanceKm: 3.1, rate: 27, experience: 0, onTime: 0.8, status: 'pending', qualified: false, skills: ['烤肉辅助'], windows: [], shiftsCompleted: 0, noShow: 0, bio: '新注册，等待审核与培训。' },
  { nickname: '梁静怡', phone: '13800000013', area: '白石洲', distanceKm: 2.9, rate: 31, experience: 2, onTime: 0.93, status: 'pending', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1440 }], shiftsCompleted: 11, noShow: 0, bio: '资料待门店审核。' },
  { nickname: '谢文博', phone: '13800000014', area: '蛇口', distanceKm: 6.5, rate: 40, experience: 4, onTime: 0.7, status: 'suspended', qualified: true, skills: ['烤肉辅助'], windows: [{ weekdayOffset: TODAY, startMin: 1020, endMin: 1440 }], shiftsCompleted: 20, noShow: 3, bio: '因多次迟到暂停接单。' },
];

function tablesByType(db: DatabaseSync, storeId: string) {
  return {
    small: all<{ id: string }>(db, 'SELECT id FROM store_tables WHERE store_id = ? AND table_type = ? ORDER BY CAST(SUBSTR(label, 2) AS INTEGER)', [storeId, 'small']),
    medium: all<{ id: string }>(db, 'SELECT id FROM store_tables WHERE store_id = ? AND table_type = ? ORDER BY CAST(SUBSTR(label, 2) AS INTEGER)', [storeId, 'medium']),
    large: all<{ id: string }>(db, 'SELECT id FROM store_tables WHERE store_id = ? AND table_type = ? ORDER BY CAST(SUBSTR(label, 2) AS INTEGER)', [storeId, 'large']),
  };
}

function insertEvent(
  db: DatabaseSync,
  storeId: string,
  type: string,
  at: number,
  opts: { tableId?: string | null; queueId?: string | null; payload?: Record<string, unknown>; source?: string } = {},
) {
  run(
    db,
    'INSERT INTO ops_events(id, store_id, type, table_id, queue_id, payload_json, occurred_at, source) VALUES(?,?,?,?,?,?,?,?)',
    [id('evt'), storeId, type, opts.tableId ?? null, opts.queueId ?? null, JSON.stringify(opts.payload ?? {}), at, opts.source ?? 'history'],
  );
}

function seedHistory(db: DatabaseSync, storeId: string, cfg: StoreConfig, todayKey: string) {
  const tables = tablesByType(db, storeId);
  const byType: Record<TableType, string[]> = {
    small: tables.small.map((t) => t.id),
    medium: tables.medium.map((t) => t.id),
    large: tables.large.map((t) => t.id),
  };
  const factors: Record<number, number> = {
    16: 0.3, 17: 0.65, 18: 1.0, 19: 1.15, 20: 0.95, 21: 0.62, 22: 0.38, 23: 0.16, 0: 0.06, 1: 0.02,
  };
  let days = 0;
  let sessions = 0;
  let calls = 0;
  transaction(db, () => {
    for (let back = 7; back >= 1; back -= 1) {
      const dateKey = addDays(todayKey, -back);
      const dayStart = epochFromLocal(dateKey, 16 * 60);
      const dayEnd = epochFromLocal(dateKey, 16 * 60 + 540); // 01:00 next day
      const source = 'history';
      const rng = mulberry32(hashSeed(`${dateKey}:history:v1`)); // date-only seed: reproducible demo history across store IDs
      const freeAt = new Map<string, number>();
      for (const list of Object.values(byType)) for (const t of list) freeAt.set(t, 0);
      let latestCall = 0;
      const waiting: Array<{ id: string; partySize: number; desired: TableType; joinedAt: number }> = [];
      const pickTable = (desired: TableType, minute: number, partySize: number): string | undefined => {
        const order: TableType[] = ['small', 'medium', 'large'];
        const start = order.indexOf(desired);
        const seq = [...order.slice(start), ...order.slice(0, start)];
        for (const type of seq) {
          for (const tableId of byType[type]) {
            if ((freeAt.get(tableId) ?? 0) <= minute) return tableId;
          }
        }
        return undefined;
      };
      const seat = (tableId: string, partySize: number, joinedAt: number, seatedAt: number, desired: TableType) => {
        const type = (Object.keys(byType) as TableType[]).find((t) => byType[t].includes(tableId)) ?? desired;
        const dining = cfg.tables[type].avgDiningMin;
        const checkoutAt = seatedAt + dining * MINUTE_MS;
        const leftAt = checkoutAt + cfg.tables.checkoutToLeaveMin * MINUTE_MS;
        const cleanedAt = leftAt + cfg.tables.leaveToCleanMin * MINUTE_MS;
        const sessionId = id('ses');
        latestCall += 1;
        const queueId = id('q');
        const calledAt = Math.max(joinedAt, seatedAt - 2 * MINUTE_MS);
        run(
          db,
          `INSERT INTO queue_entries(id, store_id, call_no, party_size, desired_type, status, joined_at, called_at, seated_at, table_id, source, business_date)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [queueId, storeId, latestCall, partySize, desired, 'seated', joinedAt, calledAt, seatedAt, tableId, source, dateKey],
        );
        run(
          db,
          `INSERT INTO dining_sessions(id, store_id, table_id, table_type, party_size, seated_at, checkout_at, left_at, cleaned_at, source, business_date)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [sessionId, storeId, tableId, type, partySize, seatedAt, checkoutAt, leftAt, cleanedAt, source, dateKey],
        );
        freeAt.set(tableId, cleanedAt);
        sessions += 1;
        calls += 1;
        insertEvent(db, storeId, 'queue_call', calledAt, { queueId, tableId, payload: { callNo: latestCall, partySize } });
        insertEvent(db, storeId, 'seat', seatedAt, { queueId, tableId, payload: { partySize, tableType: type } });
        insertEvent(db, storeId, 'checkout', checkoutAt, { tableId, payload: { sessionId } });
        insertEvent(db, storeId, 'leave', leftAt, { tableId, payload: { sessionId } });
        insertEvent(db, storeId, 'clean_done', cleanedAt, { tableId, payload: { sessionId } });
      };

      for (let minute = dayStart; minute < dayEnd; minute += MINUTE_MS) {
        const lp = localParts(minute);
        const factor = factors[lp.hours] ?? 0;
        if (factor <= 0) continue;
        // Seat waiting groups whenever a table frees up.
        for (let idx = 0; idx < waiting.length; ) {
          const entry = waiting[idx];
          const tableId = pickTable(entry.desired, minute, entry.partySize);
          if (tableId) {
            const type = (Object.keys(byType) as TableType[]).find((t) => byType[t].includes(tableId)) ?? entry.desired;
            const dining = cfg.tables[type].avgDiningMin;
            const checkoutAt = minute + dining * MINUTE_MS;
            const leftAt = checkoutAt + cfg.tables.checkoutToLeaveMin * MINUTE_MS;
            const cleanedAt = leftAt + cfg.tables.leaveToCleanMin * MINUTE_MS;
            latestCall += 1;
            run(
              db,
              "UPDATE queue_entries SET call_no = ?, status = 'seated', called_at = ?, seated_at = ?, table_id = ? WHERE id = ?",
              [latestCall, minute - MINUTE_MS, minute, tableId, entry.id],
            );
            const sessionId = id('ses');
            run(
              db,
              `INSERT INTO dining_sessions(id, store_id, table_id, table_type, party_size, seated_at, checkout_at, left_at, cleaned_at, source, business_date)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              [sessionId, storeId, tableId, type, entry.partySize, minute, checkoutAt, leftAt, cleanedAt, source, dateKey],
            );
            freeAt.set(tableId, cleanedAt);
            insertEvent(db, storeId, 'queue_call', minute - MINUTE_MS, { queueId: entry.id, tableId });
            insertEvent(db, storeId, 'seat', minute, { queueId: entry.id, tableId });
            insertEvent(db, storeId, 'checkout', checkoutAt, { tableId });
            insertEvent(db, storeId, 'leave', leftAt, { tableId });
            insertEvent(db, storeId, 'clean_done', cleanedAt, { tableId });
            waiting.splice(idx, 1);
            sessions += 1;
            calls += 1;
          } else {
            idx += 1;
          }
        }

        const totalTables = byType.small.length + byType.medium.length + byType.large.length;
        const avgTurnover =
          (cfg.tables.small.count * cfg.tables.small.avgDiningMin +
            cfg.tables.medium.count * cfg.tables.medium.avgDiningMin +
            cfg.tables.large.count * cfg.tables.large.avgDiningMin) /
          Math.max(1, totalTables);
        const probability = (totalTables / (avgTurnover + 14)) * factor;
        if (rng() >= probability) continue;

        const r = rng();
        const partySize = r < 0.28 ? 2 : r < 0.62 ? 4 : r < 0.86 ? 6 : 8;
        const desired: TableType = partySize <= 4 ? 'small' : partySize <= 6 ? 'medium' : 'large';
        const tableId = pickTable(desired, minute, partySize);
        const joinedAt = minute - Math.round(2 + rng() * 8) * MINUTE_MS;
        if (tableId) {
          seat(tableId, partySize, joinedAt, minute, desired);
        } else {
          const queueId = id('q');
          run(
            db,
            'INSERT INTO queue_entries(id, store_id, party_size, desired_type, status, joined_at, source, business_date) VALUES(?,?,?,?,?,?,?,?)',
            [queueId, storeId, partySize, desired, 'queued', joinedAt, source, dateKey],
          );
          waiting.push({ id: queueId, partySize, desired, joinedAt });
        }
      }

      for (const entry of waiting) {
        const abandonedAt = dayEnd + 5 * MINUTE_MS;
        run(db, "UPDATE queue_entries SET status = 'abandoned', abandoned_at = ? WHERE id = ?", [abandonedAt, entry.id]);
        insertEvent(db, storeId, 'queue_abandoned', abandonedAt, { queueId: entry.id, payload: { reason: 'closing' } });
      }

      run(
        db,
        `INSERT INTO business_days(id, store_id, business_date, status, on_duty_staff, queue_groups, queue_customers, latest_call_no, confirmed_at, closed_at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [id('day'), storeId, dateKey, 'closed', 3, 0, 0, latestCall, dayStart, dayEnd, dayStart],
      );
      days += 1;
    }
  });
  return { days, sessions, calls };
}

function seedCurrentDay(db: DatabaseSync, storeId: string, cfg: StoreConfig, now: number) {
  const store = getStore(db, storeId);
  const tables = tablesByType(db, storeId);
  const dateKey = localParts(now).dateKey;
  const day = ensureBusinessDay(db, store, now);
  const seatPlan: Array<{ type: TableType; status: 'dining' | 'checkout' | 'cleaning'; offset: number; extra?: number }> = [
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'small' as TableType, status: 'dining' as const, offset: [55, 48, 40, 33, 26][i] })),
    { type: 'small' as TableType, status: 'checkout' as const, offset: 62, extra: 4 },
    { type: 'small' as TableType, status: 'cleaning' as const, offset: 75, extra: 2 },
    ...Array.from({ length: 9 }, (_, i) => ({ type: 'medium' as TableType, status: 'dining' as const, offset: [65, 58, 50, 44, 38, 31, 25, 20, 15][i] })),
    { type: 'medium' as TableType, status: 'checkout' as const, offset: 70, extra: 6 },
    { type: 'medium' as TableType, status: 'checkout' as const, offset: 60, extra: 3 },
    ...Array.from({ length: 3 }, (_, i) => ({ type: 'large' as TableType, status: 'dining' as const, offset: [70, 55, 35][i] })),
  ];

  const queues: Array<{ party: number; status: 'queued' | 'called'; offset: number; callNo?: number; calledOffset?: number }> = [
    { party: 2, status: 'queued', offset: 55 },
    { party: 4, status: 'queued', offset: 50 },
    { party: 3, status: 'queued', offset: 46 },
    { party: 6, status: 'queued', offset: 41 },
    { party: 2, status: 'queued', offset: 37 },
    { party: 5, status: 'called', offset: 34, callNo: 36, calledOffset: 6 },
    { party: 8, status: 'queued', offset: 31 },
    { party: 3, status: 'queued', offset: 27 },
    { party: 4, status: 'queued', offset: 24 },
    { party: 2, status: 'queued', offset: 20 },
    { party: 6, status: 'called', offset: 17, callNo: 37, calledOffset: 4 },
    { party: 5, status: 'queued', offset: 14 },
    { party: 4, status: 'queued', offset: 10 },
    { party: 3, status: 'called', offset: 8, callNo: 38, calledOffset: 2 },
  ];

  transaction(db, () => {
    run(db, 'UPDATE business_days SET on_duty_staff = ?, latest_call_no = ? WHERE id = ?', [cfg.staffing.onDutyCount, 38, day.id]);
    const used = { small: 0, medium: 0, large: 0 };
    for (const plan of seatPlan) {
      const list = tables[plan.type];
      const table = list[used[plan.type]];
      if (!table) continue;
      used[plan.type] += 1;
      const sessionId = id('ses');
      const seatedAt = now - plan.offset * MINUTE_MS;
      const tableCfg = cfg.tables[plan.type];
      const checkoutAt = plan.status === 'dining' ? null : plan.status === 'checkout' ? now - (plan.extra ?? 4) * MINUTE_MS : now - 10 * MINUTE_MS;
      const leftAt = plan.status === 'cleaning' ? now - (plan.extra ?? 2) * MINUTE_MS : null;
      const statusUpdatedAt = plan.status === 'cleaning' ? (leftAt ?? now) : (checkoutAt ?? seatedAt);
      const partySize = plan.type === 'small' ? 3 : plan.type === 'medium' ? 5 : 8;
      run(
        db,
        `INSERT INTO dining_sessions(id, store_id, table_id, table_type, party_size, seated_at, checkout_at, left_at, source, business_date)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [sessionId, storeId, table.id, plan.type, partySize, seatedAt, checkoutAt, leftAt, 'seed', dateKey],
      );
      run(db, 'UPDATE store_tables SET status = ?, current_session_id = ?, status_updated_at = ? WHERE id = ?', [
        plan.status,
        sessionId,
        statusUpdatedAt,
        table.id,
      ]);
      insertEvent(db, storeId, 'seat', seatedAt, { tableId: table.id, payload: { partySize, seed: true }, source: 'seed' });
      if (checkoutAt) insertEvent(db, storeId, 'checkout', checkoutAt, { tableId: table.id, source: 'seed' });
      if (leftAt) insertEvent(db, storeId, 'leave', leftAt, { tableId: table.id, source: 'seed' });
      void tableCfg;
    }

    for (const q of queues) {
      const desired = q.party <= 4 ? 'small' : q.party <= 6 ? 'medium' : 'large';
      const queueId = id('q');
      const joinedAt = now - q.offset * MINUTE_MS;
      run(
        db,
        `INSERT INTO queue_entries(id, store_id, call_no, party_size, desired_type, status, joined_at, called_at, source, business_date)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [queueId, storeId, q.callNo ?? null, q.party, desired, q.status, joinedAt, q.calledOffset ? now - q.calledOffset * MINUTE_MS : null, 'seed', dateKey],
      );
      insertEvent(db, storeId, 'queue_join', joinedAt, { queueId, payload: { partySize: q.party, seed: true }, source: 'seed' });
      if (q.callNo && q.calledOffset) {
        insertEvent(db, storeId, 'queue_call', now - q.calledOffset * MINUTE_MS, { queueId, payload: { callNo: q.callNo }, source: 'seed' });
      }
    }
  });
  return day;
}

export interface SeedResult {
  storeId: string;
  managerCode: string;
  staffCount: number;
  history: { days: number; sessions: number; calls: number };
  simNow: number;
}

export function seedDemo(db: DatabaseSync, cfg: AppConfig = appConfig, force = false, options: { dateKey?: string } = {}): SeedResult {
  const existing = get<{ id: string }>(db, 'SELECT id FROM stores LIMIT 1');
  if (existing && !force) {
    const store = get<{ id: string; manager_code: string }>(db, 'SELECT id, manager_code FROM stores WHERE id = ?', [existing.id])!;
    return {
      storeId: store.id,
      managerCode: store.manager_code,
      staffCount: get<{ n: number }>(db, 'SELECT COUNT(*) as n FROM staff_profiles')!.n,
      history: { days: 7, sessions: 0, calls: 0 },
      simNow: 0,
    };
  }
  ensureAdmin(db, cfg.adminPassword);
  const todayKey = options.dateKey ?? localParts(Date.now()).dateKey;
  const simNow = epochFromLocal(todayKey, 18 * 60);

  const store = createStore(db, {
    name: DEMO_CONFIG.basic.name,
    managerCode: 'K001',
    address: DEMO_CONFIG.basic.address,
    config: DEMO_CONFIG,
  });
  updateStoreConfig(db, store.id, DEMO_CONFIG, 4);
  finishOnboarding(db, store.id);
  const managerId = id('usr');
  run(db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
    managerId,
    'manager',
    '王店长',
    null,
    null,
    store.id,
    null,
    0,
    Date.now(),
  ]);
  run(db, 'UPDATE stores SET owner_user_id = ? WHERE id = ?', [managerId, store.id]);

  const todayWeekday = localParts(simNow).weekday;
  for (const s of STAFF_SEEDS) {
    const userId = id('usr');
    run(db, 'INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
      userId,
      'staff',
      s.nickname,
      s.phone,
      hashPassword('staff123'),
      store.id,
      null,
      1,
      Date.now(),
    ]);
    const profile = createStaff(db, {
      userId,
      storeId: store.id,
      nickname: s.nickname,
      phone: s.phone,
      area: s.area,
      distanceKm: s.distanceKm,
      expectedRate: s.rate,
      experienceYears: s.experience,
      skills: s.skills,
      bio: s.bio,
      status: s.status as 'approved' | 'pending' | 'suspended' | 'rejected',
      onTimeRate: s.onTime,
      source: 'simulator',
    });
    run(db, 'UPDATE staff_profiles SET qualified = ?, training_status = ?, shifts_completed = ?, no_show_count = ?, updated_at = ? WHERE id = ?', [
      s.qualified ? 1 : 0,
      s.qualified ? 'qualified' : 'pending',
      s.shiftsCompleted,
      s.noShow,
      Date.now(),
      profile.id,
    ]);
    const windows: AvailabilityWindow[] = s.windows.map((w) => ({
      weekday: (todayWeekday + w.weekdayOffset) % 7,
      startMin: w.startMin,
      endMin: w.endMin,
    }));
    if (windows.length) setAvailability(db, profile.id, windows);
  }

  const history = seedHistory(db, store.id, DEMO_CONFIG, todayKey);
  seedCurrentDay(db, store.id, DEMO_CONFIG, simNow);

  // Anchor the store clock at 18:00 on the demo date.
  setClock(db, store.id, { at: simNow, running: false, speed: 120 });
  setLastSimAt(db, store.id, simNow);
  return {
    storeId: store.id,
    managerCode: 'K001',
    staffCount: STAFF_SEEDS.length,
    history,
    simNow,
  };
}

function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    if (existsSync(appConfig.databasePath)) rmSync(appConfig.databasePath);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const p = `${appConfig.databasePath}${suffix}`;
      if (existsSync(p)) rmSync(p);
    }
  }
  const handle = openDatabase();
  const result = seedDemo(handle.db, appConfig, reset);
  handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(JSON.stringify({ ok: true, ...result, simTime: formatTime(result.simNow) }, null, 2));
  console.log(`\n店长登录: 门店编码 ${result.managerCode}`);
  console.log('兼职登录: 手机号 13800000001（林小雨）');
  console.log(`管理员后台: http://127.0.0.1:${appConfig.port}/admin/  密码见 .env ADMIN_PASSWORD（仅开发环境显式设置）`);
  handle.close();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main();
}

void serverRoot;
void parseConfig;
