import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatching, candidateEligibility, type MatchRange } from '../src/domain/matching.js';
import { DEFAULT_STORE_CONFIG, type MatchCandidate } from '../src/domain/types.js';
import { epochFromLocal, localParts, windowCovers } from '../src/lib/time.js';

const config = DEFAULT_STORE_CONFIG;
const dateKey = localParts(Date.now()).dateKey;
const startAt = epochFromLocal(dateKey, 18 * 60 + 30);
const endAt = epochFromLocal(dateKey, 21 * 60 + 30);
const range: MatchRange = { startAt, endAt, headcount: 2 };
const now = epochFromLocal(dateKey, 18 * 60);
const weekday = localParts(startAt).weekday;
const fullWindow = [{ weekday, startMin: 16 * 60, endMin: 24 * 60 }];

function candidate(overrides: Partial<MatchCandidate>): MatchCandidate {
  return {
    staffId: overrides.staffId ?? 'staff_x',
    nickname: overrides.nickname ?? '测试兼职',
    distanceKm: 1,
    expectedRate: 32,
    experienceYears: 2,
    onTimeRate: 0.95,
    skills: ['烤肉辅助'],
    qualified: true,
    status: 'approved',
    windows: fullWindow,
    commitments: [],
    shiftsCompleted: 10,
    noShowCount: 0,
    ...overrides,
  };
}

test('matching: hard filters reject unapproved, untrained, unavailable, distant and conflicting staff', () => {
  const rangeOne = { ...range, headcount: 1 };
  assert.equal(candidateEligibility(candidate({ status: 'pending' }), rangeOne, config, now).ok, false);
  assert.equal(candidateEligibility(candidate({ qualified: false }), rangeOne, config, now).ok, false);
  assert.equal(
    candidateEligibility(candidate({ windows: [{ weekday, startMin: 20 * 60, endMin: 24 * 60 }] }), rangeOne, config, now).ok,
    false,
  );
  assert.equal(candidateEligibility(candidate({ distanceKm: 9 }), rangeOne, config, now).ok, false);
  assert.equal(candidateEligibility(candidate({ skills: ['传菜'] }), rangeOne, config, now).ok, false);
  assert.equal(
    candidateEligibility(
      candidate({ commitments: [{ startAt: startAt + 30 * 60_000, endAt: startAt + 60 * 60_000, label: '其他班次' }] }),
      rangeOne,
      config,
      now,
    ).ok,
    false,
  );
  assert.equal(candidateEligibility(candidate({}), rangeOne, config, now).ok, true);
});

test('matching: notification and travel time are respected', () => {
  const tooLate = { startAt: now + 10 * 60_000, endAt: now + 120 * 60_000, headcount: 1 };
  assert.equal(candidateEligibility(candidate({}), tooLate, config, now).ok, false);
  const tightConfig = { ...config, matching: { ...config.matching, minNoticeMin: 15 } };
  const farAway = candidate({ distanceKm: 4.9 });
  // 4.9km at 18km/h is ~16 minutes; a shift in 15 minutes cannot be reached in time.
  assert.equal(
    candidateEligibility(farAway, { startAt: now + 15 * 60_000, endAt: now + 120 * 60_000, headcount: 1 }, tightConfig, now).ok,
    false,
  );
});

test('matching: overnight availability windows cover late shifts', () => {
  const overnight = [{ weekday, startMin: 22 * 60, endMin: 3 * 60 }];
  const late = { startAt: epochFromLocal(dateKey, 23 * 60), endAt: epochFromLocal(dateKey, 25 * 60), headcount: 1 };
  assert.equal(windowCovers(overnight, late.startAt, late.endAt), true);
});

test('matching: economic plan minimizes cost while guarantee plan picks reliability', () => {
  const cheap = candidate({ staffId: 's_cheap', nickname: '低价', expectedRate: 26, onTimeRate: 0.78, experienceYears: 0, distanceKm: 3.5 });
  const strong = candidate({ staffId: 's_strong', nickname: '资深', expectedRate: 38, onTimeRate: 0.99, experienceYears: 6, distanceKm: 0.5 });
  const mid = candidate({ staffId: 's_mid', nickname: '中档', expectedRate: 32, onTimeRate: 0.92, experienceYears: 2, distanceKm: 1.5 });
  const input = { now, config, candidates: [cheap, strong, mid], planType: 'economic' as const };
  const economic = runMatching({ ...input, ranges: [{ ...range, headcount: 1 }] });
  const guarantee = runMatching({ ...input, planType: 'guarantee', ranges: [{ ...range, headcount: 1 }] });
  assert.equal(economic.draft.items[0].staffId, 's_cheap');
  assert.equal(guarantee.draft.items[0].staffId, 's_strong');
  assert.ok(economic.draft.totalCost < guarantee.draft.totalCost);
  assert.ok(economic.draft.items[0].reason.includes('成本优先'));
});

test('matching: shortage is reported honestly and no staff are fabricated', () => {
  const only = candidate({ staffId: 's1', nickname: '唯一' });
  const result = runMatching({
    now,
    config,
    candidates: [only],
    planType: 'economic',
    ranges: [{ ...range, headcount: 3 }],
  });
  assert.equal(result.draft.items.length, 1);
  assert.deepEqual(result.draft.shortage, [{ startAt, endAt, needed: 3, found: 1 }]);
  assert.equal(result.skipped.length, 1);
});

test('matching: a person is never double-booked across overlapping ranges', () => {
  const only = candidate({ staffId: 's1', nickname: '唯一' });
  const result = runMatching({
    now,
    config,
    candidates: [only],
    planType: 'guarantee',
    ranges: [
      { startAt, endAt: startAt + 60 * 60_000, headcount: 1 },
      { startAt: startAt + 30 * 60_000, endAt: endAt, headcount: 1 },
    ],
  });
  assert.equal(result.draft.items.length, 1);
  assert.equal(result.draft.shortage.length, 1);
});
