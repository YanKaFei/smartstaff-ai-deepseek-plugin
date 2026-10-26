import type { MatchCandidate, PlanDraft, PlanItem, PlanType, StoreConfig } from './types.js';
import { MINUTE_MS, round2, windowCovers } from '../lib/time.js';

export interface MatchRange {
  startAt: number;
  endAt: number;
  headcount: number;
}

export interface MatchInput {
  now: number;
  config: StoreConfig;
  ranges: MatchRange[];
  candidates: MatchCandidate[];
  planType: PlanType;
}

export interface MatchOutput {
  draft: PlanDraft;
  skipped: Array<{ range: MatchRange; reason: string }>;
}

export const JOB = '烤肉辅助';

export function candidateEligibility(
  candidate: MatchCandidate,
  range: MatchRange,
  config: StoreConfig,
  now: number,
): { ok: boolean; reason?: string } {
  if (candidate.status !== 'approved') return { ok: false, reason: '人员未通过审核' };
  if (config.staffing.requireQualified && !candidate.qualified) return { ok: false, reason: '未完成岗位培训' };
  if (!candidate.windows.length) return { ok: false, reason: '未填写可用时间' };
  if (!windowCovers(candidate.windows, range.startAt, range.endAt)) return { ok: false, reason: '可用时间不覆盖' };
  if (!candidateSkillOk(candidate, config)) return { ok: false, reason: '岗位技能不匹配' };
  if (candidate.distanceKm > config.matching.maxDistanceKm) return { ok: false, reason: '距离超出范围' };
  const travelMin = travelMinutes(candidate.distanceKm, config);
  const arriveAt = range.startAt - travelMin * MINUTE_MS;
  if (now + config.matching.minNoticeMin * MINUTE_MS > range.startAt) return { ok: false, reason: '通知时间不足' };
  if (now > arriveAt) return { ok: false, reason: '无法按时到店' };
  const clash = candidate.commitments.find((c) => c.startAt < range.endAt && c.endAt > range.startAt);
  if (clash) return { ok: false, reason: `与已有班次冲突（${clash.label}）` };
  return { ok: true };
}

function candidateSkillOk(candidate: MatchCandidate, config: StoreConfig): boolean {
  return candidate.skills.includes(config.basic.jobType) || candidate.skills.includes('全部');
}

export function travelMinutes(distanceKm: number, config: StoreConfig): number {
  return Math.max(5, Math.round((distanceKm / Math.max(1, config.matching.travelSpeedKmh)) * 60));
}

export function scoreCandidate(candidate: MatchCandidate, planType: PlanType, config: StoreConfig): number {
  const travel = travelMinutes(candidate.distanceKm, config);
  const economic =
    100 -
    candidate.expectedRate * 1.5 -
    candidate.distanceKm * 3 +
    candidate.onTimeRate * 8 -
    candidate.noShowCount * 4;
  const guarantee =
    candidate.onTimeRate * 55 +
    Math.min(candidate.experienceYears, 6) * 5 +
    (candidate.qualified ? 6 : 0) -
    candidate.distanceKm * 1.5 -
    candidate.noShowCount * 10 -
    candidate.expectedRate * 0.15 -
    travel * 0.1;
  return round2(planType === 'economic' ? economic : guarantee);
}

function reasonFor(candidate: MatchCandidate, planType: PlanType, config: StoreConfig): string {
  const travel = travelMinutes(candidate.distanceKm, config);
  const parts = [
    `可用时间覆盖，距门店 ${candidate.distanceKm.toFixed(1)}km（约 ${travel} 分钟到店）`,
    `近况准点率 ${Math.round(candidate.onTimeRate * 100)}%`,
  ];
  if (candidate.experienceYears > 0) parts.push(`烤肉经验 ${candidate.experienceYears} 年`);
  parts.push(planType === 'economic' ? `期望报酬 ¥${candidate.expectedRate}/小时，成本优先` : '口碑与技能优先，保障高峰服务');
  return parts.join('；');
}

export function runMatching(input: MatchInput): MatchOutput {
  const { config, ranges, candidates, planType, now } = input;
  const items: PlanItem[] = [];
  const shortage: PlanDraft['shortage'] = [];
  const skipped: MatchOutput['skipped'] = [];
  const picked: Array<{ staffId: string; startAt: number; endAt: number }> = [];

  for (const range of ranges) {
    const pool = candidates
      .filter((c) => {
        const inRange = candidateEligibility(c, range, config, now);
        if (!inRange.ok) return false;
        const alreadyPicked = picked.find(
          (p) => p.staffId === c.staffId && p.startAt < range.endAt && p.endAt > range.startAt,
        );
        return !alreadyPicked;
      })
      .map((c) => ({ candidate: c, score: scoreCandidate(c, planType, config) }))
      .sort((a, b) => {
        if (planType === 'economic') {
          return a.candidate.expectedRate - b.candidate.expectedRate || b.score - a.score;
        }
        return b.score - a.score || a.candidate.expectedRate - b.candidate.expectedRate;
      });

    const needed = Math.max(0, range.headcount);
    const chosen = pool.slice(0, needed).map((p) => p.candidate);
    const alternatives = pool.slice(needed, needed + 6).map((p) => p.candidate);

    for (const candidate of chosen) {
      picked.push({ staffId: candidate.staffId, startAt: range.startAt, endAt: range.endAt });
      const hours = Math.max(0.5, (range.endAt - range.startAt) / 3_600_000);
      const travel = travelMinutes(candidate.distanceKm, config);
      items.push({
        staffId: candidate.staffId,
        nickname: candidate.nickname,
        startAt: range.startAt,
        endAt: range.endAt,
        hourlyRate: candidate.expectedRate,
        estimatedCost: round2(hours * candidate.expectedRate),
        distanceKm: candidate.distanceKm,
        arriveAt: range.startAt - travel * MINUTE_MS,
        score: scoreCandidate(candidate, planType, config),
        reason: reasonFor(candidate, planType, config),
        alternatives: alternatives.map((a) => ({
          staffId: a.staffId,
          nickname: a.nickname,
          hourlyRate: a.expectedRate,
          distanceKm: a.distanceKm,
          onTimeRate: a.onTimeRate,
          experienceYears: a.experienceYears,
          score: scoreCandidate(a, planType, config),
          reason: reasonFor(a, planType, config),
        })),
      });
    }

    if (chosen.length < needed) {
      shortage.push({
        startAt: range.startAt,
        endAt: range.endAt,
        needed,
        found: chosen.length,
      });
      skipped.push({ range, reason: `仅找到 ${chosen.length}/${needed} 名符合硬性条件的兼职` });
    }
  }

  return {
    draft: {
      planType,
      items,
      totalCost: round2(items.reduce((sum, i) => sum + i.estimatedCost, 0)),
      headcount: new Set(items.map((i) => i.staffId)).size,
      shortage,
    },
    skipped,
  };
}

