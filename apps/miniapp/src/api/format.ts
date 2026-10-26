export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

export function fmtRange(startAt: number, endAt: number): string {
  return `${fmtTime(startAt)}-${fmtTime(endAt)}`;
}

export function minutesLabel(minutes: number): string {
  if (!minutes) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function countdown(ms: number, now: number): string {
  const left = Math.max(0, Math.round((ms - now) / 60000));
  return left > 0 ? `${left} 分钟后超时` : '已超时';
}

export const SHIFT_STATUS: Record<string, string> = {
  invited: '待接受',
  confirmed: '已确认',
  checked_in: '服务中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '缺席',
};

export const OFFER_STATUS: Record<string, string> = {
  pending: '待回应',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已超时',
  cancelled: '已撤销',
};

export const TABLE_STATUS: Record<string, string> = {
  available: '可入座',
  dining: '用餐中',
  checkout: '已结账',
  cleaning: '待清台',
};

export const BOTTLENECK: Record<string, string> = {
  staff: '人员瓶颈',
  table: '桌位瓶颈',
  none: '供需平衡',
};

export const RELIABILITY: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const STAFF_STATUS: Record<string, string> = {
  approved: '已通过',
  pending: '审核中',
  rejected: '已驳回',
  suspended: '已暂停',
};
