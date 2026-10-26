import { z } from 'zod';
import type { Db } from '../db/index.js';
import { all, get, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { DEFAULT_STORE_CONFIG, type StoreConfig, type TableType, TABLE_TYPES } from './types.js';

const tableConfigSchema = z.object({
  count: z.number().int().min(0).max(200),
  seats: z.number().int().min(1).max(50),
  avgDiningMin: z.number().int().min(20).max(300),
  weight: z.number().min(0.5).max(5),
});

export const storeConfigSchema = z.object({
  basic: z.object({
    name: z.string().trim().min(1).max(60),
    hoursStart: z.string().regex(/^\d{2}:\d{2}$/),
    hoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
    address: z.string().trim().min(1).max(200),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    jobType: z.string().trim().min(1).max(30),
    hourlyRate: z.number().min(1).max(500),
  }),
  tables: z.object({
    small: tableConfigSchema,
    medium: tableConfigSchema,
    large: tableConfigSchema,
    checkoutToLeaveMin: z.number().int().min(0).max(60),
    leaveToCleanMin: z.number().int().min(0).max(60),
    partyMapping: z
      .array(
        z.object({
          min: z.number().int().min(1).max(30),
          max: z.number().int().min(1).max(30),
          type: z.enum(['small', 'medium', 'large']),
        }),
      )
      .min(1)
      .max(10),
  }),
  staffing: z.object({
    onDutyCount: z.number().int().min(0).max(100),
    shiftStart: z.string().regex(/^\d{2}:\d{2}$/),
    shiftEnd: z.string().regex(/^\d{2}:\d{2}$/),
    tablesPerStaff: z.number().int().min(1).max(30),
    serviceBufferPct: z.number().min(0).max(50),
    requireQualified: z.boolean(),
    capacityModel: z.enum(['legacy', 'service_minutes']).default('legacy'),
    capacityBasis: z.enum(['standard_equivalent', 'physical_tables']).default('standard_equivalent'),
    serviceMode: z.enum(['full', 'partial', 'self']).default('partial'),
    serviceMinutes: z
      .object({
        small: z.number().min(1).max(120),
        medium: z.number().min(1).max(120),
        large: z.number().min(1).max(120),
      })
      .default(DEFAULT_STORE_CONFIG.staffing.serviceMinutes),
    effectiveServiceMinutesPerSlot: z.number().min(5).max(30).default(24),
    calibrationStatus: z.enum(['unverified', 'calibrated']).default('unverified'),
  }),
  matching: z.object({
    maxDistanceKm: z.number().min(0).max(50),
    minNoticeMin: z.number().int().min(0).max(240),
    offerTtlMinutes: z.number().int().min(1).max(120),
    travelSpeedKmh: z.number().min(1).max(80),
  }),
  policy: z
    .object({
      staffCancelMinNoticeMin: z.number().int().min(0).max(240),
      noShowGraceMin: z.number().int().min(0).max(180),
      autoBackfill: z.boolean(),
    })
    .default(DEFAULT_STORE_CONFIG.policy),
  pilot: z.object({ shadowMode: z.boolean() }).default(DEFAULT_STORE_CONFIG.pilot),
  dataSource: z.enum(['manual', 'simulator', 'external']),
});

export type StoreRow = {
  id: string;
  name: string;
  manager_code: string;
  address: string;
  lat: number;
  lng: number;
  hours_start: string;
  hours_end: string;
  job_type: string;
  hourly_rate: number;
  config_json: string;
  onboarding_step: number;
  onboarded_at: number | null;
  created_at: number;
};

export function parseConfig(row: StoreRow): StoreConfig {
  try {
    const parsed = JSON.parse(row.config_json) as StoreConfig;
    return {
      ...DEFAULT_STORE_CONFIG,
      ...parsed,
      basic: { ...DEFAULT_STORE_CONFIG.basic, ...parsed.basic },
      tables: { ...DEFAULT_STORE_CONFIG.tables, ...parsed.tables },
      staffing: {
        ...DEFAULT_STORE_CONFIG.staffing,
        ...parsed.staffing,
        serviceMinutes: { ...DEFAULT_STORE_CONFIG.staffing.serviceMinutes, ...(parsed.staffing?.serviceMinutes ?? {}) },
      },
      matching: { ...DEFAULT_STORE_CONFIG.matching, ...parsed.matching },
      policy: { ...DEFAULT_STORE_CONFIG.policy, ...(parsed.policy ?? {}) },
    };
  } catch {
    return { ...DEFAULT_STORE_CONFIG };
  }
}

export function serializeStore(row: StoreRow) {
  return {
    id: row.id,
    name: row.name,
    managerCode: row.manager_code,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    hoursStart: row.hours_start,
    hoursEnd: row.hours_end,
    jobType: row.job_type,
    hourlyRate: row.hourly_rate,
    config: parseConfig(row),
    onboardingStep: row.onboarding_step,
    onboardedAt: row.onboarded_at,
    createdAt: row.created_at,
  };
}

export function getStore(db: Db, storeId: string): StoreRow {
  const row = get<StoreRow>(db, 'SELECT * FROM stores WHERE id = ?', [storeId]);
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', '门店不存在');
  return row;
}

/** Keep store row columns in sync with config.basic (single source: config). */
function syncStoreColumns(db: Db, storeId: string, cfg: StoreConfig): void {
  run(
    db,
    `UPDATE stores SET name=?, address=?, lat=?, lng=?, hours_start=?, hours_end=?, job_type=?, hourly_rate=?, config_json=? WHERE id=?`,
    [
      cfg.basic.name,
      cfg.basic.address,
      cfg.basic.lat,
      cfg.basic.lng,
      cfg.basic.hoursStart,
      cfg.basic.hoursEnd,
      cfg.basic.jobType,
      cfg.basic.hourlyRate,
      JSON.stringify(cfg),
      storeId,
    ],
  );
}

/**
 * Create physical table rows to match configured counts. Existing tables keep
 * their state; surplus tables are only removed when idle, never mid-service.
 */
export function syncTables(db: Db, storeId: string, cfg: StoreConfig): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const now = Date.now();
  for (const type of TABLE_TYPES) {
    const desired = cfg.tables[type].count;
    const rows = all<{ id: string; label: string; status: string; current_session_id: string | null }>(
      db,
      'SELECT id, label, status, current_session_id FROM store_tables WHERE store_id = ? AND table_type = ? ORDER BY label',
      [storeId, type],
    );
    if (rows.length < desired) {
      const prefix = type === 'small' ? 'S' : type === 'medium' ? 'M' : 'L';
      const used = new Set(rows.map((r) => r.label));
      let n = 1;
      while (rows.length < desired) {
        const label = `${prefix}${n}`;
        n += 1;
        if (used.has(label)) continue;
        run(
          db,
          'INSERT INTO store_tables(id, store_id, table_type, label, seats, status, status_updated_at) VALUES(?,?,?,?,?,?,?)',
          [id('tbl'), storeId, type, label, cfg.tables[type].seats, 'available', now],
        );
        rows.push({ id: '', label, status: 'available', current_session_id: null });
        added += 1;
      }
    } else if (rows.length > desired) {
      const idle = rows.filter((r) => r.status === 'available' && !r.current_session_id).slice(0, rows.length - desired);
      for (const r of idle) {
        run(db, 'DELETE FROM store_tables WHERE id = ?', [r.id]);
        removed += 1;
      }
    }
  }
  return { added, removed };
}

export function createStore(
  db: Db,
  input: {
    name: string;
    managerCode: string;
    address?: string;
    lat?: number;
    lng?: number;
    config?: Partial<StoreConfig>;
  },
): StoreRow {
  const cfg: StoreConfig = {
    ...DEFAULT_STORE_CONFIG,
    ...input.config,
    basic: {
      ...DEFAULT_STORE_CONFIG.basic,
      ...input.config?.basic,
      name: input.name,
      address: input.address ?? input.config?.basic?.address ?? '待完善地址',
      lat: input.lat ?? input.config?.basic?.lat ?? DEFAULT_STORE_CONFIG.basic.lat,
      lng: input.lng ?? input.config?.basic?.lng ?? DEFAULT_STORE_CONFIG.basic.lng,
    },
  };
  const storeId = id('store');
  const code = input.managerCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(code)) throw new AppError(400, 'INVALID_CODE', '门店编码需为 3-10 位字母或数字');
  const exists = get(db, 'SELECT id FROM stores WHERE manager_code = ?', [code]);
  if (exists) throw new AppError(409, 'CODE_TAKEN', '门店编码已被使用');
  transaction(db, () => {
    run(
      db,
      `INSERT INTO stores(id, name, manager_code, address, lat, lng, hours_start, hours_end, job_type, hourly_rate, config_json, onboarding_step, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId,
        cfg.basic.name,
        code,
        cfg.basic.address,
        cfg.basic.lat,
        cfg.basic.lng,
        cfg.basic.hoursStart,
        cfg.basic.hoursEnd,
        cfg.basic.jobType,
        cfg.basic.hourlyRate,
        JSON.stringify(cfg),
        0,
        Date.now(),
      ],
    );
    run(db, 'INSERT INTO store_clocks(store_id, offset_ms, running, speed, last_sim_at, updated_at) VALUES(?,?,?,?,?,?)', [
      storeId,
      0,
      0,
      120,
      0,
      Date.now(),
    ]);
    syncTables(db, storeId, cfg);
  });
  return getStore(db, storeId);
}

export function updateStoreConfig(db: Db, storeId: string, cfg: StoreConfig, step?: number): StoreRow {
  return transaction(db, () => {
    syncStoreColumns(db, storeId, cfg);
    syncTables(db, storeId, cfg);
    if (step !== undefined) {
      run(db, 'UPDATE stores SET onboarding_step = ? WHERE id = ?', [step, storeId]);
    }
    return getStore(db, storeId);
  });
}

export function finishOnboarding(db: Db, storeId: string): StoreRow {
  run(db, 'UPDATE stores SET onboarding_step = 4, onboarded_at = ? WHERE id = ?', [Date.now(), storeId]);
  return getStore(db, storeId);
}

export function assertTableType(value: string): TableType {
  if (!TABLE_TYPES.includes(value as TableType)) throw new AppError(400, 'BAD_TABLE_TYPE', '未知桌型');
  return value as TableType;
}

export function mapPartyToTable(cfg: StoreConfig, partySize: number): TableType {
  const found = cfg.tables.partyMapping.find((m) => partySize >= m.min && partySize <= m.max);
  if (found) return found.type;
  if (partySize <= cfg.tables.small.seats) return 'small';
  if (partySize <= cfg.tables.medium.seats) return 'medium';
  return 'large';
}
