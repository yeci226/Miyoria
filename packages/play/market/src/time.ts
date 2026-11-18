// Her local days and weeks: when the auction opens and when the lottery is drawn. Every time the
// market acts on is derived from these and from the times kept in its tables, so a restart picks
// up where it was.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** The local day number of `ms` (days since 1970-01-01 in her time zone). */
export function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms + offsetMinutes * MINUTE_MS) / DAY_MS);
}

/** Where the local day `day` starts, as epoch ms. */
export function dayStartMs(day: number, offsetMinutes: number): number {
  return day * DAY_MS - offsetMinutes * MINUTE_MS;
}

/** The weekday of a local day: 0 Sunday … 6 Saturday (day 0 was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** Minutes after midnight of `HH:MM`. */
export function minutesOf(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** A weekly moment: a weekday and a time of day, local. */
export interface WeeklyAt {
  weekday: number;
  time: string;
}

/** The latest occurrence of `at` at or before `ms` (epoch ms). */
export function lastSlot(at: WeeklyAt, ms: number, offsetMinutes: number): number {
  const today = localDay(ms, offsetMinutes);
  const back = (weekdayOf(today) - at.weekday + 7) % 7;
  const slot = dayStartMs(today - back, offsetMinutes) + minutesOf(at.time) * MINUTE_MS;
  return slot > ms ? slot - WEEK_MS : slot;
}

/** The first occurrence of `at` strictly after `ms`. */
export function nextSlot(at: WeeklyAt, ms: number, offsetMinutes: number): number {
  return lastSlot(at, ms, offsetMinutes) + WEEK_MS;
}

/** `11/21 (六) 20:00` in her time zone. */
export function localLabel(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * MINUTE_MS);
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${days[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
