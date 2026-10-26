export type Role = 'manager' | 'staff' | 'admin';
export type TableType = 'small' | 'medium' | 'large';
export type TableStatus = 'available' | 'dining' | 'checkout' | 'cleaning';
export type QueueStatus = 'queued' | 'called' | 'seated' | 'abandoned';
export type ShiftStatus = 'invited' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
export type PlanType = 'economic' | 'guarantee';

export interface TableConfig {
  count: number;
  seats: number;
  avgDiningMin: number;
  weight: number;
}

export interface StoreConfig {
  basic: {
    name: string;
    hoursStart: string;
    hoursEnd: string;
    address: string;
    lat: number;
    lng: number;
    jobType: string;
    hourlyRate: number;
  };
  tables: {
    small: TableConfig;
    medium: TableConfig;
    large: TableConfig;
    checkoutToLeaveMin: number;
    leaveToCleanMin: number;
    partyMapping: Array<{ min: number; max: number; type: TableType }>;
  };
  staffing: {
    onDutyCount: number;
    shiftStart: string;
    shiftEnd: string;
    tablesPerStaff: number;
    serviceBufferPct: number;
    requireQualified: boolean;
    capacityModel: 'legacy' | 'service_minutes';
    capacityBasis: 'standard_equivalent' | 'physical_tables';
    serviceMode: 'full' | 'partial' | 'self';
    serviceMinutes: { small: number; medium: number; large: number };
    effectiveServiceMinutesPerSlot: number;
    calibrationStatus: 'unverified' | 'calibrated';
  };
  matching: {
    maxDistanceKm: number;
    minNoticeMin: number;
    offerTtlMinutes: number;
    travelSpeedKmh: number;
  };
  policy: {
    /** How long before the shift a part-timer may cancel without a late-cancellation flag. */
    staffCancelMinNoticeMin: number;
    /** Minutes after start before a confirmed shift is marked no-show and backfilled. */
    noShowGraceMin: number;
    /** Whether cancellation/no-show automatically creates a replacement invitation. */
    autoBackfill: boolean;
  };
  pilot: {
    /** Shadow mode predicts/matches but never creates shifts, offers or fees. */
    shadowMode: boolean;
  };
  dataSource: 'manual' | 'simulator' | 'external';
}

export const TABLE_TYPES: TableType[] = ['small', 'medium', 'large'];
export const TABLE_LABELS: Record<TableType, string> = {
  small: '小桌',
  medium: '中桌',
  large: '大桌',
};

export const DEFAULT_STORE_CONFIG: StoreConfig = {
  basic: {
    name: '',
    hoursStart: '16:00',
    hoursEnd: '02:00',
    address: '',
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
    minNoticeMin: 20,
    offerTtlMinutes: 10,
    travelSpeedKmh: 18,
  },
  policy: {
    staffCancelMinNoticeMin: 60,
    noShowGraceMin: 45,
    autoBackfill: true,
  },
  pilot: { shadowMode: false },
  dataSource: 'manual',
};

export interface StaffProfileRow {
  id: string;
  user_id: string;
  store_id: string;
  nickname: string;
  phone: string | null;
  area: string;
  distance_km: number;
  expected_rate: number;
  experience_years: number;
  skills_json: string;
  qualified: number;
  training_status: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  on_time_rate: number;
  shifts_completed: number;
  no_show_count: number;
  bio: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface AvailabilityWindow {
  weekday: number;
  startMin: number;
  endMin: number;
}

export interface ShiftRow {
  id: string;
  store_id: string;
  staff_id: string;
  plan_id: string | null;
  role: string;
  start_at: number;
  end_at: number;
  hourly_rate: number;
  status: ShiftStatus;
  offer_id: string | null;
  demand_id: string | null;
  is_backfill: number;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  cancel_kind: string | null;
  checked_in_at: number | null;
  checked_out_at: number | null;
  actual_minutes: number | null;
  pay_amount: number | null;
  late_minutes: number;
  manager_confirmed: number;
  note: string;
  created_at: number;
  updated_at: number;
}

export interface OfferRow {
  id: string;
  store_id: string;
  shift_id: string;
  staff_id: string;
  status: OfferStatus;
  expires_at: number;
  attempt: number;
  candidates_json: string;
  responded_at: number | null;
  reason: string | null;
  created_at: number;
}

export interface SlotForecast {
  index: number;
  startAt: number;
  endAt: number;
  label: string;
  projectedOccupied: Record<TableType, number>;
  projectedQueueGroups: number;
  projectedWaitMin: number;
  projectedActiveTables: number;
  weightedLoad: number;
  tableCapacity: number;
  tableUtilization: number;
  serviceCapacityTables: number;
  requiredStaff: number;
  onDutyStaff: number;
  gap: number;
  bottleneck: 'none' | 'table' | 'staff';
  workloadMinutes?: number;
  capacityMinutes?: number;
}

export interface ForecastResult {
  horizonStart: number;
  slots: SlotForecast[];
  peakRequiredStaff: number;
  peakGap: number;
  gapRanges: Array<{ startAt: number; endAt: number; headcount: number }>;
  reliability: 'high' | 'medium' | 'low';
  reliabilityReason: string;
  bottleneck: 'none' | 'table' | 'staff';
  bottleneckReason: string;
  dataPoints: number;
  arrivalAssumption: number;
  generatedAt: number;
  model?: 'legacy' | 'service_minutes';
  capacityBasis?: 'standard_equivalent' | 'physical_tables';
  serviceMode?: 'full' | 'partial' | 'self';
  calibrationStatus?: 'unverified' | 'calibrated';
  modelWarning?: string;
}

export interface PlanAlternative {
  staffId: string;
  nickname: string;
  hourlyRate: number;
  distanceKm: number;
  onTimeRate: number;
  experienceYears: number;
  score: number;
  reason: string;
}

export interface PlanItem {
  staffId: string;
  nickname: string;
  startAt: number;
  endAt: number;
  hourlyRate: number;
  estimatedCost: number;
  distanceKm: number;
  arriveAt: number;
  score: number;
  reason: string;
  alternatives: PlanAlternative[];
}

export interface MatchCandidate {
  staffId: string;
  nickname: string;
  distanceKm: number;
  expectedRate: number;
  experienceYears: number;
  onTimeRate: number;
  skills: string[];
  qualified: boolean;
  status: string;
  windows: AvailabilityWindow[];
  commitments: Array<{ startAt: number; endAt: number; label: string }>;
  shiftsCompleted: number;
  noShowCount: number;
}

export interface PlanDraft {
  planType: PlanType;
  items: PlanItem[];
  totalCost: number;
  headcount: number;
  shortage: Array<{ startAt: number; endAt: number; needed: number; found: number }>;
}
