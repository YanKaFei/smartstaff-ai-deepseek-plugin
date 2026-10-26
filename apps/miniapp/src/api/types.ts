export interface AvailabilityWindow {
  weekday: number;
  startMin: number;
  endMin: number;
}

export interface Store {
  id: string;
  name: string;
  managerCode: string;
  address: string;
  hoursStart: string;
  hoursEnd: string;
  jobType: string;
  hourlyRate: number;
  config: StoreConfig;
  onboardingStep: number;
  onboardedAt: number | null;
}

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
    partyMapping: Array<{ min: number; max: number; type: 'small' | 'medium' | 'large' }>;
  };
  staffing: {
    onDutyCount: number;
    shiftStart: string;
    shiftEnd: string;
    tablesPerStaff: number;
    serviceBufferPct: number;
    requireQualified: boolean;
  };
  matching: {
    maxDistanceKm: number;
    minNoticeMin: number;
    offerTtlMinutes: number;
    travelSpeedKmh: number;
  };
  pilot: { shadowMode: boolean };
  dataSource: 'manual' | 'simulator' | 'external';
}

export interface StaffProfile {
  id: string;
  nickname: string;
  phone: string;
  area: string;
  distanceKm: number;
  expectedRate: number;
  experienceYears: number;
  skills: string[];
  qualified: boolean;
  trainingStatus: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  onTimeRate: number;
  shiftsCompleted: number;
  noShowCount: number;
  bio: string;
  source?: string;
  availability: AvailabilityWindow[];
}

export interface QueueEntry {
  id: string;
  callNo: number | null;
  partySize: number;
  desiredType: 'small' | 'medium' | 'large';
  status: 'queued' | 'called';
  joinedAt: number;
  calledAt: number | null;
  waitedMin: number;
}

export interface TableItem {
  id: string;
  label: string;
  type: 'small' | 'medium' | 'large';
  seats: number;
  status: 'available' | 'dining' | 'checkout' | 'cleaning';
  elapsedMin: number;
  session: { partySize: number; seatedAt: number } | null;
}

export interface PilotSummary {
  shadowMode: boolean;
  control: { paused: boolean; reason: string | null; updatedBy: string | null; updatedAt: number };
  shadowRuns: Array<{ id: string; planId: string; forecastId: string; totalCost: number; recommendations: unknown[]; createdAt: number }>;
  feedback: { count: number; mae: number | null; bias: number | null; overloaded: number; noShow: number; decisions: Record<string, number> };
  plan?: { shadow?: boolean };
}

export interface IngestStatus {
  dataSource: string;
  lastReceivedAt: number | null;
  lastAppliedAt: number | null;
  lastEventAt: number | null;
  lastSource: string | null;
  stale: boolean;
  staleThresholdMinutes: number;
  webhookConfigured: boolean;
  lastEvent: { id: string; source: string; type: string; occurredAt: number; receivedAt: number; status: string } | null;
  counts: Record<string, number>;
}

export interface DemandView {
  id: string;
  role: string;
  startAt: number;
  endAt: number;
  headcount: number;
  status: 'open' | 'filled' | 'cancelled';
  confirmed: number;
  checkedIn: number;
  completed: number;
  pending: number;
  committed: number;
  unfilled: number;
  uncovered: number;
  cancelled: number;
  noShow: number;
  backfillTasks: Array<{ id: string; status: string; reason: string; startAt: number; endAt: number; shiftId: string | null }>;
}

export interface TodayView {
  store: {
    id: string;
    name: string;
    managerCode: string;
    address: string;
    hoursStart: string;
    hoursEnd: string;
    jobType: string;
    hourlyRate: number;
    onboarded: boolean;
  };
  now: number;
  nowLabel: string;
  businessDate: string;
  businessDay: {
    id: string;
    status: 'draft' | 'confirmed' | 'closed';
    confirmedAt: number | null;
    onDutyStaff: number;
    latestCallNo: number;
    suggestedOnDutyStaff: number;
  };
  queue: {
    groups: number;
    customers: number;
    latestCallNo: number;
    entries: QueueEntry[];
    estimatedWaitMin: number;
  };
  tables: {
    total: number;
    occupied: number;
    byType: Array<{
      type: string;
      label: string;
      total: number;
      available: number;
      dining: number;
      checkout: number;
      cleaning: number;
    }>;
    list: TableItem[];
  };
  metrics: { seatedToday: number; occupancyRate: number };
  forecast: {
    id: string;
    requiredStaff: number;
    onDutyStaff: number;
    gap: number;
    reliability: string;
    bottleneck: string;
    generatedAt: number;
  } | null;
  proposedPlans: number;
  assignments: Record<string, number>;
  unreadNotifications: number;
  coverage?: {
    demands: DemandView[];
    committed: number;
    pending: number;
    unfilled: number;
    noShow: number;
    checkedIn: number;
    confirmed: number;
    openExceptions: number;
  };
  lastEvents: Array<{ id: string; type: string; at: number; tableId: string | null; queueId: string | null }>;
}

export interface SlotForecast {
  index: number;
  startAt: number;
  endAt: number;
  label: string;
  projectedOccupied: Record<string, number>;
  projectedQueueGroups: number;
  projectedWaitMin: number;
  projectedActiveTables: number;
  weightedLoad: number;
  requiredStaff: number;
  onDutyStaff: number;
  gap: number;
  bottleneck: 'none' | 'table' | 'staff';
  workloadMinutes?: number;
  capacityMinutes?: number;
}

export interface Forecast {
  id: string;
  horizonStart: number;
  generatedAt: number;
  slots: SlotForecast[];
  peakRequiredStaff: number;
  peakGap: number;
  gapRanges: Array<{ startAt: number; endAt: number; headcount: number }>;
  reliability: 'high' | 'medium' | 'low';
  reliabilityReason: string;
  bottleneck: 'none' | 'table' | 'staff';
  bottleneckReason: string;
  onDutyStaff: number;
  aiStatus: 'ok' | 'fallback';
  aiError?: string;
  aiCached?: boolean;
  model?: 'legacy' | 'service_minutes';
  capacityBasis?: 'standard_equivalent' | 'physical_tables';
  serviceMode?: 'full' | 'partial' | 'self';
  calibrationStatus?: 'unverified' | 'calibrated';
  modelWarning?: string;
  ai: {
    summary: string;
    riskLevel: 'low' | 'medium' | 'high';
    bottleneckExplanation: string;
    slotNotes: Array<{ slotIndex: number; note: string }>;
    cautions: string[];
    recommendations: Array<{ slotIndex: number; startAt: number; endAt: number; headcount: number; reason: string }>;
  };
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
  arriveLabel: string;
  startLabel: string;
  endLabel: string;
  score: number;
  reason: string;
  alternatives: PlanAlternative[];
}

export interface Plan {
  id: string;
  planType: 'economic' | 'guarantee';
  status: 'proposed' | 'confirmed' | 'superseded';
  items: PlanItem[];
  totalCost: number;
  headcount: number;
  shortage: Array<{ startAt: number; endAt: number; needed: number; found: number }>;
  storeName: string;
  createdAt: number;
}

export interface PlanBundle {
  forecast: Forecast;
  needsStaff: boolean;
  ranges: Array<{ startAt: number; endAt: number; headcount: number; label?: string }>;
  plans: Plan[];
  message: string;
}

export interface Shift {
  id: string;
  storeId: string;
  storeName: string;
  storeAddress: string;
  managerCode: string;
  staffId: string;
  staffName: string;
  staffPhone: string;
  role: string;
  startAt: number;
  endAt: number;
  hourlyRate: number;
  status: 'invited' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
  demandId?: string | null;
  isBackfill?: boolean;
  cancelledAt?: number | null;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  cancelKind?: string | null;
  offerStatus: string | null;
  offerExpiresAt: number | null;
  checkedInAt: number | null;
  checkedOutAt: number | null;
  actualMinutes: number | null;
  payAmount: number | null;
  lateMinutes: number;
  managerConfirmed: boolean;
  note: string;
  offer?: { id: string; status: string; expiresAt: number; attempt: number } | null;
}

export interface StaffOffer {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: number;
  attempt: number;
  payEstimate: number;
  store: { id: string; name: string; address: string; managerCode: string };
  shift: Shift;
}

export interface AssignmentView {
  items: Shift[];
  demands: DemandView[];
  groups: { pending: number; confirmed: number; checkedIn: number; completed: number; exceptions: number };
  now: number;
}

export interface ExceptionItem {
  id: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  shiftId: string | null;
  createdAt: number;
}
