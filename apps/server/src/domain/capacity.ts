import type { StoreConfig, SlotForecast, TableType, ForecastResult } from './types.js';
import { localParts, MINUTE_MS, SLOT_MINUTES, ceilToSlot, formatSlotLabel, round2, clamp } from '../lib/time.js';

export interface CapacityTableInput {
  type: TableType;
  status: 'available' | 'dining' | 'checkout' | 'cleaning';
  seatedAt?: number | null;
  checkoutAt?: number | null;
  statusUpdatedAt: number;
}

export interface CapacityQueueInput {
  partySize: number;
  desiredType: TableType;
  status: 'queued' | 'called';
}

export interface CapacityInput {
  now: number;
  config: StoreConfig;
  onDutyStaff: number;
  tables: CapacityTableInput[];
  queue: CapacityQueueInput[];
  /** seated_at timestamps of the last ~2 hours, used for the observed arrival rate */
  recentSeatedAt: number[];
  /** seated_at timestamps for the same weekday over the previous 7 days */
  historySeatedAt: number[];
  /** recent call events: context/confidence only, never converted to arrivals */
  recentCalls?: number;
  historyDays: number;
  source: 'manual' | 'simulator' | 'external';
  slotCount?: number;
}

const TYPES: TableType[] = ['small', 'medium', 'large'];

function nextTypeOrder(type: TableType): TableType[] {
  const start = TYPES.indexOf(type);
  return [...TYPES.slice(start), ...TYPES.slice(0, start)];
}

/**
 * Deterministic workload forecast. It never asks an LLM for numbers.
 * Inputs are observed table/queue state plus arrival rates; outputs are
 * 30-minute slots with per-type occupancy, queue, workload and staffing gap.
 */
export function computeCapacityForecast(input: CapacityInput): ForecastResult {
  const { config, now, onDutyStaff } = input;
  const slotCount = input.slotCount ?? 6;
  const slotMs = SLOT_MINUTES * MINUTE_MS;
  // Start at the next half-hour boundary so a recommended shift is actionable
  // rather than already partially elapsed when the manager confirms.
  // The first actionable slot must respect the matching notice window; otherwise
  // the forecast can report a gap that no candidate can legally accept.
  const horizonStart = ceilToSlot(Math.max(now + MINUTE_MS, now + config.matching.minNoticeMin * MINUTE_MS));
  const cfg = config.tables;
  const weights: Record<TableType, number> = {
    small: cfg.small.weight,
    medium: cfg.medium.weight,
    large: cfg.large.weight,
  };
  const totals: Record<TableType, number> = {
    small: cfg.small.count,
    medium: cfg.medium.count,
    large: cfg.large.count,
  };
  const totalTables = totals.small + totals.medium + totals.large;
  const tablesPerStaff = Math.max(1, config.staffing.tablesPerStaff);

  // Observed arrival rate: recent seatings are the only non-speculative signal.
  const recentWindowStart = now - 120 * MINUTE_MS;
  const recentCount = input.recentSeatedAt.filter((t) => t >= recentWindowStart && t <= now).length;
  const observedRate = recentCount / 4; // groups per 30 min

  const historySlotCounts = new Map<string, number>();
  const historyDates = new Set<string>();
  for (const t of input.historySeatedAt) {
    const p = localParts(t);
    // Traffic follows the time of day; using 7 daily samples gives a stable rate.
    const key = `${Math.floor(p.minuteOfDay / SLOT_MINUTES)}`;
    historySlotCounts.set(key, (historySlotCounts.get(key) ?? 0) + 1);
    historyDates.add(p.dateKey);
  }
  const historyDenominator = Math.max(1, Math.min(7, input.historyDays || historyDates.size || 1));

  const fallbackRate = Math.max(1, Math.round(totalTables * 0.32));

  // Working projection state.
  const freeAtByType: Record<TableType, number[]> = { small: [], medium: [], large: [] };
  const occupiedCount: Record<TableType, number> = { small: 0, medium: 0, large: 0 };
  for (const table of input.tables) {
    if (table.type !== 'small' && table.type !== 'medium' && table.type !== 'large') continue;
    const typeCfg = cfg[table.type];
    let freeAt = 0;
    if (table.status === 'dining') {
      freeAt = (table.seatedAt ?? now) + typeCfg.avgDiningMin * MINUTE_MS + cfg.checkoutToLeaveMin * MINUTE_MS + cfg.leaveToCleanMin * MINUTE_MS;
    } else if (table.status === 'checkout') {
      const checkoutAt = table.checkoutAt ?? table.statusUpdatedAt;
      freeAt = checkoutAt + cfg.checkoutToLeaveMin * MINUTE_MS + cfg.leaveToCleanMin * MINUTE_MS;
    } else if (table.status === 'cleaning') {
      freeAt = table.statusUpdatedAt + cfg.leaveToCleanMin * MINUTE_MS;
    }
    if (freeAt > 0) freeAtByType[table.type].push(freeAt);
  }

  // Queue by desired type; called groups are still waiting for a table.
  const queueByType: Record<TableType, number> = { small: 0, medium: 0, large: 0 };
  for (const q of input.queue) queueByType[q.desiredType] += 1;

  const slots: SlotForecast[] = [];
  let arrivalSum = 0;
  let staffBottleneckSlots = 0;
  let tableBottleneckSlots = 0;
  let dataPoints = recentCount + input.queue.length + Math.min(20, input.recentCalls ?? 0);

  for (let index = 0; index < slotCount; index += 1) {
    const startAt = horizonStart + index * slotMs;
    const endAt = startAt + slotMs;
    const p = localParts(startAt + slotMs / 2);
    // Traffic follows the time of day; using 7 daily samples gives a stable rate.
    const key = `${Math.floor(p.minuteOfDay / SLOT_MINUTES)}`;
    const historyRate = (historySlotCounts.get(key) ?? 0) / historyDenominator;
    const hasHistory = historySlotCounts.has(key) && input.historyDays >= 1;
    const blended = hasHistory ? observedRate * 0.5 + historyRate * 0.5 : observedRate > 0 ? observedRate : fallbackRate;
    const arrivals = Math.max(0, Math.round(blended));
    arrivalSum += arrivals;
    dataPoints += hasHistory ? 2 : 0;

    // Release tables whose free time has passed by slot start. Snapshot the
    // tables freeing during this slot BEFORE we project new seatings.
    const freeTables: Record<TableType, number> = { small: 0, medium: 0, large: 0 };
    const seatDuration = (type: TableType) =>
      (cfg[type].avgDiningMin + cfg.checkoutToLeaveMin + cfg.leaveToCleanMin) * MINUTE_MS;
    let freeingThisSlot = 0;
    for (const type of TYPES) {
      freeingThisSlot += freeAtByType[type].filter((t) => t > startAt && t <= endAt).length;
      freeAtByType[type] = freeAtByType[type].filter((t) => t > startAt);
      freeTables[type] = totals[type] - freeAtByType[type].length;
      occupiedCount[type] = freeAtByType[type].length;
    }

    // Seat waiting groups first (FIFO across types, exact type preferred).
    for (const type of TYPES) {
      for (const candidate of nextTypeOrder(type)) {
        const seatable = Math.min(queueByType[type], freeTables[candidate]);
        if (seatable <= 0) continue;
        queueByType[type] -= seatable;
        freeTables[candidate] -= seatable;
        freeAtByType[candidate].push(startAt + seatDuration(candidate));
        occupiedCount[candidate] += seatable;
      }
    }

    // Seat new arrivals according to the configured party-size mapping mix.
    const mix = arrivalMix(config, input.queue.length);
    for (const type of TYPES) {
      const groups = Math.round(arrivals * mix[type]);
      for (let g = 0; g < groups; g += 1) {
        let seated = false;
        for (const candidate of nextTypeOrder(type)) {
          if (freeTables[candidate] > 0) {
            freeTables[candidate] -= 1;
            freeAtByType[candidate].push(startAt + seatDuration(candidate));
            occupiedCount[candidate] += 1;
            seated = true;
            break;
          }
        }
        if (!seated) queueByType[type] += 1;
      }
    }

    const queueAfter = queueByType.small + queueByType.medium + queueByType.large;
    const weightedLoad =
      occupiedCount.small * weights.small +
      occupiedCount.medium * weights.medium +
      occupiedCount.large * weights.large +
      queueAfter * 0.2;
    const intensity = config.staffing.serviceMode === 'full' ? 1.55 : config.staffing.serviceMode === 'self' ? 0.55 : 1;
    // In the legacy model the service mode still changes effective table coverage.
    const modeCapacityFactor = config.staffing.serviceMode === 'full' ? 0.8 : config.staffing.serviceMode === 'self' ? 1.4 : 1;
    const effectiveTablesPerStaff = Math.max(1, tablesPerStaff * modeCapacityFactor);
    const serviceMinutes = config.staffing.serviceMinutes;
    const slotMinutes = 30;
    const attentionMinutes =
      occupiedCount.small * serviceMinutes.small * intensity * (slotMinutes / (cfg.small.avgDiningMin + cfg.checkoutToLeaveMin + cfg.leaveToCleanMin)) +
      occupiedCount.medium * serviceMinutes.medium * intensity * (slotMinutes / (cfg.medium.avgDiningMin + cfg.checkoutToLeaveMin + cfg.leaveToCleanMin)) +
      occupiedCount.large * serviceMinutes.large * intensity * (slotMinutes / (cfg.large.avgDiningMin + cfg.checkoutToLeaveMin + cfg.leaveToCleanMin));
    const queueMinutes = queueAfter * 2;
    const cleaningMinutes = freeingThisSlot * (cfg.checkoutToLeaveMin + cfg.leaveToCleanMin) * intensity * 0.5;
    const workloadMinutes = round2(attentionMinutes + queueMinutes + cleaningMinutes);
    const effectiveMinutes = Math.max(1, config.staffing.effectiveServiceMinutesPerSlot);
    const serviceRequired = Math.max(
      0,
      Math.ceil((workloadMinutes / effectiveMinutes) * (1 + config.staffing.serviceBufferPct / 100)),
    );
    const rawRequired = Math.max(
      0,
      Math.ceil(((occupiedCount.small + occupiedCount.medium + occupiedCount.large + queueAfter * 0.2) / effectiveTablesPerStaff) * (1 + config.staffing.serviceBufferPct / 100)),
    );
    const requiredStaff =
      config.staffing.capacityModel === 'service_minutes'
        ? serviceRequired
        : config.staffing.capacityBasis === 'physical_tables'
          ? rawRequired
          : Math.max(0, Math.ceil((weightedLoad / effectiveTablesPerStaff) * (1 + config.staffing.serviceBufferPct / 100)));
    const gap = Math.max(0, requiredStaff - onDutyStaff);
    const tableUtilization = totalTables ? round2(
      (occupiedCount.small + occupiedCount.medium + occupiedCount.large) / totalTables,
    ) : 0;
    const freeNow = freeTables.small + freeTables.medium + freeTables.large;
    const isTableBottleneck = queueAfter >= 2 && freeNow === 0;
    const isStaffBottleneck = gap > 0 && !(isTableBottleneck && tableUtilization >= 0.9 && gap <= 1);
    const bottleneck: SlotForecast['bottleneck'] = isStaffBottleneck
      ? 'staff'
      : isTableBottleneck
        ? 'table'
        : 'none';
    if (bottleneck === 'staff') staffBottleneckSlots += 1;
    if (bottleneck === 'table') tableBottleneckSlots += 1;

    slots.push({
      index,
      startAt,
      endAt,
      label: formatSlotLabel(startAt),
      projectedOccupied: { ...occupiedCount },
      projectedQueueGroups: queueAfter,
      projectedWaitMin:
        queueAfter === 0 ? 0 : clamp(Math.round((queueAfter / Math.max(1, freeingThisSlot || totals.small)) * 30), 5, 180),
      projectedActiveTables: occupiedCount.small + occupiedCount.medium + occupiedCount.large,
      weightedLoad: round2(weightedLoad),
      tableCapacity: totalTables,
      tableUtilization,
      serviceCapacityTables: onDutyStaff * tablesPerStaff,
      requiredStaff,
      onDutyStaff,
      gap,
      bottleneck,
      workloadMinutes,
      capacityMinutes: onDutyStaff * effectiveMinutes,
    });
  }

  const peakGap = Math.max(0, ...slots.map((s) => s.gap));
  const peakRequiredStaff = Math.max(0, ...slots.map((s) => s.requiredStaff));
  const gapRanges = mergeGapRanges(slots);
  const reliabilityScore =
    (recentCount >= 12 ? 2 : recentCount >= 4 ? 1 : 0) +
    (input.historyDays >= 7 ? 2 : input.historyDays >= 3 ? 1 : 0);
  const baseReliability: ForecastResult['reliability'] =
    reliabilityScore >= 3 ? 'high' : reliabilityScore >= 1 ? 'medium' : 'low';
  const serviceUncalibrated =
    config.staffing.capacityModel === 'service_minutes' && config.staffing.calibrationStatus !== 'calibrated';
  const reliability: ForecastResult['reliability'] = serviceUncalibrated && baseReliability === 'high' ? 'medium' : baseReliability;
  const baseReason =
    baseReliability === 'high'
      ? `最近 2 小时有 ${recentCount} 次实际入座、${input.recentCalls ?? 0} 次叫号，且已有 ${input.historyDays} 天历史数据`
      : baseReliability === 'medium'
        ? `最近 2 小时有 ${recentCount} 次实际入座、${input.recentCalls ?? 0} 次叫号，历史样本 ${input.historyDays} 天`
        : '实时入座样本与历史数据均不足，预测仅供参考';
  const reliabilityReason = serviceUncalibrated
    ? `${baseReason}；服务工时参数未用真实门店记录校准，分钟模型的可靠性受限，仅供与旧算法比较`
    : baseReason;

  const bottleneck: ForecastResult['bottleneck'] =
    staffBottleneckSlots > tableBottleneckSlots ? 'staff' : tableBottleneckSlots > 0 ? 'table' : 'none';
  const bottleneckReason =
    bottleneck === 'staff'
      ? `${staffBottleneckSlots} 个时段的服务工作量超出在岗 ${onDutyStaff} 人产能`
      : bottleneck === 'table'
        ? '等待主要来自桌位容量与翻台限制，优先加快结账、离店与清台，而不是直接加人'
        : '当前桌位与服务人力基本匹配，无需增派';

  return {
    horizonStart,
    slots,
    peakRequiredStaff,
    peakGap,
    gapRanges,
    reliability,
    reliabilityReason,
    bottleneck,
    bottleneckReason,
    dataPoints,
    arrivalAssumption: round2(arrivalSum / slotCount),
    generatedAt: now,
    model: config.staffing.capacityModel,
    capacityBasis: config.staffing.capacityBasis,
    serviceMode: config.staffing.serviceMode,
    calibrationStatus: config.staffing.calibrationStatus,
    modelWarning: serviceUncalibrated
      ? '服务分钟模型尚未用真实工作记录校准；请勿把模拟结果当作真实经营校准。'
      : undefined,
  };
}

function arrivalMix(config: StoreConfig, existingQueue: number): Record<TableType, number> {
  const counts: Record<TableType, number> = {
    small: config.tables.small.count,
    medium: config.tables.medium.count,
    large: config.tables.large.count,
  };
  const total = counts.small + counts.medium + counts.large || 1;
  // Capacity share dominates; 14 waiting groups would otherwise overfit the mix.
  const base: Record<TableType, number> = {
    small: counts.small / total,
    medium: counts.medium / total,
    large: counts.large / total,
  };
  if (existingQueue === 0) return base;
  return base;
}

function mergeGapRanges(slots: SlotForecast[]): Array<{ startAt: number; endAt: number; headcount: number }> {
  const ranges: Array<{ startAt: number; endAt: number; headcount: number }> = [];
  let current: { startAt: number; endAt: number; headcount: number } | null = null;
  for (const slot of slots) {
    const needsStaff = slot.gap > 0 && slot.bottleneck === 'staff';
    if (needsStaff) {
      if (!current) {
        current = { startAt: slot.startAt, endAt: slot.endAt, headcount: slot.gap };
      } else {
        current.endAt = slot.endAt;
        current.headcount = Math.max(current.headcount, slot.gap);
      }
    } else if (current) {
      ranges.push(current);
      current = null;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}
