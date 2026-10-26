import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCapacityForecast, type CapacityInput, type CapacityTableInput } from '../src/domain/capacity.js';
import { DEFAULT_STORE_CONFIG } from '../src/domain/types.js';
import { epochFromLocal, localParts } from '../src/lib/time.js';

const cfg = {
  ...DEFAULT_STORE_CONFIG,
  tables: {
    ...DEFAULT_STORE_CONFIG.tables,
    small: { ...DEFAULT_STORE_CONFIG.tables.small, count: 8, weight: 1 },
    medium: { ...DEFAULT_STORE_CONFIG.tables.medium, count: 12, weight: 1.6 },
    large: { ...DEFAULT_STORE_CONFIG.tables.large, count: 4, weight: 2.4 },
    checkoutToLeaveMin: 8,
    leaveToCleanMin: 6,
  },
  staffing: { ...DEFAULT_STORE_CONFIG.staffing, onDutyCount: 3, tablesPerStaff: 5 },
};

function tables(status: CapacityTableInput['status'], seatedAt: number): CapacityTableInput[] {
  const out: CapacityTableInput[] = [];
  for (const [type, count] of [['small', 8], ['medium', 12], ['large', 4]] as const) {
    for (let i = 0; i < count; i += 1) {
      out.push({
        type,
        status,
        seatedAt: status === 'available' ? null : seatedAt,
        checkoutAt: status === 'checkout' ? seatedAt : null,
        statusUpdatedAt: seatedAt,
      });
    }
  }
  return out;
}

const dateKey = localParts(Date.now()).dateKey;
const now = epochFromLocal(dateKey, 18 * 60 + 20);

test('capacity: sufficient staff produces no gap and no dispatch ranges', () => {
  const result = computeCapacityForecast({
    now,
    config: cfg,
    onDutyStaff: 12,
    tables: tables('dining', now - 10 * 60_000),
    queue: Array.from({ length: 10 }, () => ({ partySize: 4, desiredType: 'small' as const, status: 'queued' as const })),
    recentSeatedAt: [now - 10 * 60_000, now - 20 * 60_000],
    historySeatedAt: [],
    historyDays: 0,
    source: 'manual',
  });
  assert.equal(result.peakGap, 0);
  assert.deepEqual(result.gapRanges, []);
  assert.ok(result.slots.every((s) => s.gap === 0));
});

test('capacity: understaffed full house yields a contiguous staff gap range', () => {
  const result = computeCapacityForecast({
    now,
    config: cfg,
    onDutyStaff: 3,
    tables: tables('dining', now - 10 * 60_000),
    queue: Array.from({ length: 14 }, () => ({ partySize: 4, desiredType: 'small' as const, status: 'queued' as const })),
    recentSeatedAt: [now - 5 * 60_000, now - 15 * 60_000, now - 25 * 60_000],
    historySeatedAt: [],
    historyDays: 0,
    source: 'simulator',
  });
  assert.ok(result.peakGap > 0);
  assert.equal(result.bottleneck, 'staff');
  assert.ok(result.gapRanges.length >= 1);
  for (const range of result.gapRanges) {
    assert.ok(range.headcount >= 1);
    assert.ok(range.endAt > range.startAt);
  }
  // Consecutive slots merge into one actionable shift rather than six micro-shifts.
  assert.equal(result.gapRanges[0].startAt, result.slots.find((s) => s.gap > 0)!.startAt);
});

test('capacity: queue pressure with enough staff is classified as a table bottleneck', () => {
  const result = computeCapacityForecast({
    now,
    config: cfg,
    onDutyStaff: 20,
    tables: tables('dining', now - 10 * 60_000),
    queue: Array.from({ length: 12 }, () => ({ partySize: 4, desiredType: 'small' as const, status: 'queued' as const })),
    recentSeatedAt: [],
    historySeatedAt: [],
    historyDays: 0,
    source: 'simulator',
  });
  assert.equal(result.peakGap, 0);
  assert.equal(result.bottleneck, 'table');
  assert.equal(result.gapRanges.length, 0);
  assert.ok(result.slots[0].projectedQueueGroups > 0);
  assert.ok(result.slots[0].tableUtilization >= 0.9);
});

test('capacity: checkout does not free a table; cleaning and leaving time are included', () => {
  const checkoutAt = now - 60_000;
  const input: CapacityInput = {
    now,
    config: { ...cfg, matching: { ...cfg.matching, minNoticeMin: 5 } },
    onDutyStaff: 3,
    tables: [
      { type: 'small', status: 'checkout', seatedAt: now - 60 * 60_000, checkoutAt, statusUpdatedAt: checkoutAt },
      ...Array.from({ length: 7 }, () => ({ type: 'small' as const, status: 'available' as const, statusUpdatedAt: now })),
      ...Array.from({ length: 12 }, () => ({ type: 'medium' as const, status: 'available' as const, statusUpdatedAt: now })),
      ...Array.from({ length: 4 }, () => ({ type: 'large' as const, status: 'available' as const, statusUpdatedAt: now })),
    ],
    queue: [],
    recentSeatedAt: [],
    historySeatedAt: [],
    historyDays: 0,
    source: 'manual',
  };
  const result = computeCapacityForecast(input);
  // now 18:20 -> first slot 18:30; checkout + 8 + 6 minutes = 18:34, still unavailable.
  assert.ok(result.slots[0].projectedOccupied.small >= 1);
  assert.ok(result.horizonStart > now);
});

test('capacity: history raises the projected arrival rate', () => {
  const historyNow = epochFromLocal(dateKey, 18 * 60);
  const historySeatedAt: number[] = [];
  for (let day = 1; day <= 7; day += 1) {
    const d = new Date(historyNow + 8 * 3600_000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const dayStart = epochFromLocal(key, 0) - day * 86_400_000;
    for (let i = 0; i < 8; i += 1) historySeatedAt.push(dayStart + 18.5 * 3600_000);
  }
  const base = {
    now: historyNow,
    config: cfg,
    onDutyStaff: 3,
    tables: tables('available', now),
    queue: [],
    recentSeatedAt: [],
    source: 'manual' as const,
  };
  const noHistory = computeCapacityForecast({ ...base, historySeatedAt: [], historyDays: 0 });
  const withHistory = computeCapacityForecast({ ...base, historySeatedAt, historyDays: 7 });
  assert.ok(withHistory.dataPoints > noHistory.dataPoints);
  assert.notEqual(withHistory.arrivalAssumption, noHistory.arrivalAssumption);
  assert.equal(withHistory.reliability, 'medium');
});
