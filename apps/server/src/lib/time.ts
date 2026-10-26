/**
 * All business timestamps are epoch milliseconds. The product operates on a
 * fixed Asia/Shanghai (UTC+8) civil calendar. The simulator shifts a per-store
 * clock by an offset; every business operation reads the store clock instead of
 * Date.now(), so flows stay consistent when simulated time is accelerated.
 */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
export const MINUTE_MS = 60_000;
export const SLOT_MINUTES = 30;

export function localParts(ms: number) {
  const shifted = new Date(ms + TZ_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    dateKey: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekdayMinute: shifted.getUTCDay() * 1440 + shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Build an epoch ms from a Shanghai civil date/time. */
export function epochFromLocal(dateKey: string, minuteOfDay = 0, second = 0): number {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const h = Math.floor(minuteOfDay / 60);
  const min = minuteOfDay % 60;
  return Date.UTC(y, m - 1, d, h, min, second) - TZ_OFFSET_MS;
}

export function dateKeyToWeekday(dateKey: string): number {
  return localParts(epochFromLocal(dateKey, 720)).weekday;
}

export function addDays(dateKey: string, days: number): string {
  return localParts(epochFromLocal(dateKey, 720) + days * 86_400_000).dateKey;
}

export function formatTime(ms: number): string {
  const p = localParts(ms);
  return `${pad(p.hours)}:${pad(p.minutes)}`;
}

export function formatDateTime(ms: number): string {
  const p = localParts(ms);
  return `${p.dateKey} ${pad(p.hours)}:${pad(p.minutes)}`;
}

export function formatSlotLabel(startMs: number): string {
  return `${formatTime(startMs)}-${formatTime(startMs + SLOT_MINUTES * MINUTE_MS)}`;
}

export function startOfLocalDay(ms: number): number {
  const p = localParts(ms);
  return epochFromLocal(p.dateKey, 0);
}

export function floorToSlot(ms: number): number {
  return Math.floor(ms / (SLOT_MINUTES * MINUTE_MS)) * SLOT_MINUTES * MINUTE_MS;
}

export function ceilToSlot(ms: number): number {
  return Math.ceil(ms / (SLOT_MINUTES * MINUTE_MS)) * SLOT_MINUTES * MINUTE_MS;
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / MINUTE_MS);
}

/** Business date for a store whose operating window may cross midnight. */
export function businessDateKey(ms: number, hoursEnd: string): string {
  const p = localParts(ms);
  const endMin = parseHHMM(hoursEnd);
  if (endMin < parseHHMM('12:00') && p.minuteOfDay < endMin) {
    return localParts(ms - 86_400_000).dateKey;
  }
  return p.dateKey;
}

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid HH:MM value: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid HH:MM value: ${value}`);
  return h * 60 + min;
}

/** Does a weekly availability window cover an absolute [start,end) span? */
export function windowCovers(
  windows: Array<{ weekday: number; startMin: number; endMin: number }>,
  startAt: number,
  endAt: number,
): boolean {
  if (endAt <= startAt) return false;
  // Walk in 15-minute steps; availability windows may cross midnight.
  for (let t = startAt; t < endAt; t += 15 * MINUTE_MS) {
    const p = localParts(t);
    const todayOk = windows.some((w) => {
      if (w.weekday !== p.weekday) return false;
      if (w.endMin >= w.startMin) return p.minuteOfDay >= w.startMin && p.minuteOfDay < w.endMin;
      return p.minuteOfDay >= w.startMin;
    });
    // A window declared on the previous weekday may spill past midnight,
    // e.g. Monday 17:00-02:00 must cover Tuesday 00:30-02:00.
    const previousWeekday = (p.weekday + 6) % 7;
    const spillOk = windows.some(
      (w) => w.weekday === previousWeekday && w.endMin < w.startMin && p.minuteOfDay < w.endMin,
    );
    if (!todayOk && !spillOk) return false;
  }
  return true;
}

export function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
