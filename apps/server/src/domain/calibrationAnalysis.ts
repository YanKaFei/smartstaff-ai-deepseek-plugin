import { AppError } from '../lib/errors.js';
import { round2 } from '../lib/time.js';

export interface CalibrationSample {
  date: string;
  tableType: 'small' | 'medium' | 'large';
  partySize: number;
  seatedAt: number;
  leftAt: number;
  serverInterventions: number;
  grillMinutes: number;
  serveMinutes: number;
  plateChangeMinutes: number;
  checkoutMinutes: number;
  cleaningMinutes: number;
  onDutyStaff: number;
  predictedRequired: number;
  actualRequired: number;
  overloaded: boolean;
}

export interface CalibrationAnalysis {
  status: 'UNCALIBRATED';
  sampleCount: number;
  distinctDays: number;
  byTableType: Record<string, number>;
  averageServiceMinutes: number;
  mae: number;
  bias: number;
  understaffedSamples: number;
  overloadedSamples: number;
  eligibility: {
    minimumSampleMet: boolean;
    allTableTypesCovered: boolean;
    minimumDaysMet: boolean;
    eligibleForManualReview: boolean;
  };
  autoCalibrate: false;
  note: string;
}

/**
 * Descriptive analysis only. It never flips calibrationStatus; a human must
 * review the raw observations and submit evidence through the admin endpoint.
 */
export function analyzeCalibrationSamples(samples: CalibrationSample[]): CalibrationAnalysis {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new AppError(400, 'CALIBRATION_SAMPLES_REQUIRED', '至少提供一份真实观察样本');
  }
  const byTableType: Record<string, number> = { small: 0, medium: 0, large: 0 };
  let serviceTotal = 0;
  let absError = 0;
  let biasTotal = 0;
  let understaffed = 0;
  let overloaded = 0;
  const days = new Set<string>();
  for (const s of samples) {
    if (byTableType[s.tableType] === undefined) throw new AppError(400, 'CALIBRATION_BAD_TABLE_TYPE', '样本桌型必须是 small/medium/large');
    if (!Number.isFinite(s.seatedAt) || !Number.isFinite(s.leftAt) || s.leftAt < s.seatedAt) {
      throw new AppError(400, 'CALIBRATION_BAD_TIME', '样本就餐开始/结束时间无效');
    }
    byTableType[s.tableType] += 1;
    days.add(s.date);
    serviceTotal += s.grillMinutes + s.serveMinutes + s.plateChangeMinutes + s.checkoutMinutes + s.cleaningMinutes;
    const error = s.predictedRequired - s.actualRequired;
    absError += Math.abs(error);
    biasTotal += error;
    if (s.actualRequired > s.predictedRequired) understaffed += 1;
    if (s.overloaded) overloaded += 1;
  }
  const sampleCount = samples.length;
  const allTableTypesCovered = Object.values(byTableType).every((n) => n >= 5);
  const analysis: CalibrationAnalysis = {
    status: 'UNCALIBRATED',
    sampleCount,
    distinctDays: days.size,
    byTableType,
    averageServiceMinutes: round2(serviceTotal / sampleCount),
    mae: round2(absError / sampleCount),
    bias: round2(biasTotal / sampleCount),
    understaffedSamples: understaffed,
    overloadedSamples: overloaded,
    eligibility: {
      minimumSampleMet: sampleCount >= 30,
      allTableTypesCovered,
      minimumDaysMet: days.size >= 7,
      eligibleForManualReview: sampleCount >= 30 && allTableTypesCovered && days.size >= 7,
    },
    autoCalibrate: false,
    note: '描述性统计，不会自动校准。≥30 份只是最低门槛，仍需人工复核样本代表性、统计显著性和经营异常。',
  };
  return analysis;
}
