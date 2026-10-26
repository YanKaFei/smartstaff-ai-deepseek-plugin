/**
 * R1 validation harness — NOT a product feature.
 * Replays the seeded 24-table / 3-staff / 14-queue scene at a frozen clock,
 * then re-runs the capacity engine under three explicit BBQ service modes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig, updateStoreConfig } from '../src/domain/stores.js';
import { setClock } from '../src/domain/clock.js';
import { todayView } from '../src/domain/ops.js';
import { localParts } from '../src/lib/time.js';

const MODES = [
  {
    key: 'full_assisted',
    label: '全程代烤',
    tablesPerStaff: 4,
    assumption: '服务员全程代烤、换篦、分餐；1 人可同时照看 4 张桌',
  },
  {
    key: 'partial_assisted',
    label: '部分代烤',
    tablesPerStaff: 5,
    assumption: '服务员在入座、翻台与高峰时段代烤；1 人可同时照看 5 张桌（当前门店配置）',
  },
  {
    key: 'self_grill',
    label: '顾客自主烤制',
    tablesPerStaff: 7,
    assumption: '顾客自主烤制，服务员主要负责补炭、换篦与清台；1 人可同时照看 7 张桌',
  },
] as const;

const cfg = makeConfig({ adminPassword: 'r1-audit', nodeEnv: 'test' });
const handle = openDatabase(':memory:');
const seeded = seedDemo(handle.db, cfg);
const db = handle.db;
const storeId = seeded.storeId;
const simNow = seeded.simNow;
setClock(db, storeId, { at: simNow });

const store = getStore(db, storeId);
const config = parseConfig(store);
const day = todayView(db, storeId);
const baseTables = day.tables.byType;
const queue = day.queue;

const baseline = await generateForecast(db, storeId, cfg, { useAi: false, now: simNow });

const modeRuns: Array<{
  key: string;
  label: string;
  tablesPerStaff: number;
  assumption: string;
  peakRequiredStaff: number;
  peakGap: number;
  slots: Array<{ label: string; activeTables: number; load: number; required: number; gap: number; physicalRequired: number }>;
}> = [];

for (const mode of MODES) {
  const modeConfig = { ...config, staffing: { ...config.staffing, tablesPerStaff: mode.tablesPerStaff } };
  updateStoreConfig(db, storeId, modeConfig);
  const forecast = await generateForecast(db, storeId, cfg, { useAi: false, now: simNow });
  modeRuns.push({
    ...mode,
    peakRequiredStaff: forecast.peakRequiredStaff,
    peakGap: forecast.peakGap,
    slots: forecast.slots.map((s) => ({
      label: s.label,
      activeTables: s.projectedActiveTables,
      load: s.weightedLoad,
      required: s.requiredStaff,
      gap: s.gap,
      // Alternative reading of the same "tables per staff" parameter:
      // ceil(physical tables / tables per staff), ignoring weights.
      physicalRequired: Math.ceil(s.projectedActiveTables / mode.tablesPerStaff),
    })),
  });
}

const baselineDetail = baseline.slots.map((s) => ({
  label: s.label,
  occupied: s.projectedOccupied,
  activeTables: s.projectedActiveTables,
  queue: s.projectedQueueGroups,
  weightedLoad: s.weightedLoad,
  tableComponent:
    s.projectedOccupied.small * config.tables.small.weight +
    s.projectedOccupied.medium * config.tables.medium.weight +
    s.projectedOccupied.large * config.tables.large.weight,
  queueComponent: Math.round(s.projectedQueueGroups * 0.2 * 100) / 100,
  capacityTableEquivalents: s.serviceCapacityTables,
  required: s.requiredStaff,
  gap: s.gap,
  bottleneck: s.bottleneck,
  waitMin: s.projectedWaitMin,
  tableUtilization: s.tableUtilization,
}));

const out = {
  generatedAt: new Date().toISOString(),
  scene: {
    store: store.name,
    clock: localParts(simNow).dateKey + ' ' + localParts(simNow).hours + ':' + String(localParts(simNow).minutes).padStart(2, '0'),
    onDutyStaff: day.businessDay.onDutyStaff,
    tables: baseTables,
    totalTables: day.tables.total,
    queueGroups: queue.groups,
    queueCustomers: queue.customers,
    latestCallNo: queue.latestCallNo,
    tablesPerStaff: config.staffing.tablesPerStaff,
    weights: {
      small: config.tables.small.weight,
      medium: config.tables.medium.weight,
      large: config.tables.large.weight,
    },
    checkoutToLeaveMin: config.tables.checkoutToLeaveMin,
    leaveToCleanMin: config.tables.leaveToCleanMin,
  },
  baseline: {
    peakRequiredStaff: baseline.peakRequiredStaff,
    peakGap: baseline.peakGap,
    reliability: baseline.reliability,
    reliabilityReason: baseline.reliabilityReason,
    bottleneck: baseline.bottleneck,
    bottleneckReason: baseline.bottleneckReason,
    arrivalAssumption: baseline.arrivalAssumption,
    gapRanges: baseline.gapRanges,
    slots: baselineDetail,
    recentCalls: (baseline as { recentCalls?: number }).recentCalls ?? null,
  },
  modeComparison: modeRuns,
  semantics: {
    currentFormula: 'ceil((Σ 桌数×权重 + 排队组数×0.2) / 每人可负责桌数)',
    rawTableFormula: 'ceil(在用桌数 / 每人可负责桌数)',
    note:
      'The seeded tablesPerStaff=5 is documented as "每人可负责桌数". The engine divides the weighted load by 5, ' +
      'which only makes sense if 5 means standard-table equivalents, not physical tables. ' +
      'If the manager reads it as physical tables, the engine overestimates.',
  },
};

const outDir = path.join(serverRoot, '..', '..', 'docs', 'r1-evidence');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'algorithm-audit.json'), JSON.stringify(out, null, 2));

console.log('=== scene ===');
console.log(JSON.stringify(out.scene, null, 2));
console.log('\n=== baseline per 30 min ===');
console.log('slot | active S/M/L | queue | tableLoad | queueLoad | totalLoad | capacity | required | gap | physicalReq');
for (const s of baselineDetail) {
  console.log(
    [
      s.label,
      `${s.occupied.small}/${s.occupied.medium}/${s.occupied.large}`,
      s.queue,
      s.tableComponent.toFixed(1),
      s.queueComponent.toFixed(1),
      s.weightedLoad.toFixed(1),
      s.capacityTableEquivalents,
      s.required,
      s.gap,
      Math.ceil(s.activeTables / config.staffing.tablesPerStaff),
    ].join(' | '),
  );
}
console.log('\n=== mode comparison (engine) ===');
for (const m of modeRuns) {
  console.log(
    `${m.label} (${m.tablesPerStaff}/人) peak required=${m.peakRequiredStaff} gap=${m.peakGap} slots=` +
      m.slots.map((s) => `${s.label}:${s.required}/${s.gap}/raw${s.physicalRequired}`).join(' '),
  );
}
console.log('\nJSON written to docs/r1-evidence/algorithm-audit.json');
handle.close();
