// Her local clock: days that roll over at `day_start_hour` and the one set of quiet hours.
// Pure; `now` is epoch ms.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface LocalTime {
  utc_offset_minutes: number;
  day_start_hour: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
}

function local(now: number, t: LocalTime): number {
  return now + t.utc_offset_minutes * 60_000;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Local hour (0..23). */
export function localHour(now: number, t: LocalTime): number {
  return Math.floor(mod(local(now, t), DAY_MS) / HOUR_MS);
}

/** Index of her day (days since the epoch, rolling over at `day_start_hour`). */
export function dayIndex(now: number, t: LocalTime): number {
  return Math.floor((local(now, t) - (t.day_start_hour % 24) * HOUR_MS) / DAY_MS);
}

/** When her next day starts (epoch ms). */
export function nextDayStart(now: number, t: LocalTime): number {
  const day = dayIndex(now, t) + 1;
  return day * DAY_MS + (t.day_start_hour % 24) * HOUR_MS - t.utc_offset_minutes * 60_000;
}

/** Whether quiet hours are configured at all. */
export function hasQuietHours(t: LocalTime): boolean {
  return t.quiet_start_hour % 24 !== t.quiet_end_hour % 24;
}

export function inQuietHours(now: number, t: LocalTime): boolean {
  if (!hasQuietHours(t)) return false;
  const start = t.quiet_start_hour % 24;
  const end = t.quiet_end_hour % 24;
  const hour = localHour(now, t);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** When the quiet hours that are on now end (epoch ms), or `null` outside them. */
export function quietEndsAt(now: number, t: LocalTime): number | null {
  if (!inQuietHours(now, t)) return null;
  const end = t.quiet_end_hour % 24;
  const localNow = local(now, t);
  const midnight = localNow - mod(localNow, DAY_MS);
  let at = midnight + end * HOUR_MS;
  if (at <= localNow) at += DAY_MS;
  return at - t.utc_offset_minutes * 60_000;
}

/** `HH:MM` in her local time. */
export function clockText(at: number, t: LocalTime): string {
  const d = new Date(local(at, t));
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
