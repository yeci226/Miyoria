import type { TimeContext } from "@miyoria/types";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Part of the day of a local hour (0..23). */
export function partOfDay(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 8) return "清晨";
  if (hour < 11) return "早上";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  return "晚上";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time at `now` (epoch ms) in a UTC offset. */
export function timeContext(now: number, utcOffsetMinutes: number): TimeContext {
  const offset = Math.abs(utcOffsetMinutes) < 24 * 60 ? utcOffsetMinutes : 0;
  const d = new Date(now + offset * 60_000);
  const weekday = d.getUTCDay();
  return {
    local: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekday,
    weekend: weekday === 0 || weekday === 6,
    part_of_day: partOfDay(d.getUTCHours()),
    utc_offset_minutes: offset,
  };
}

/** `星期一` etc. */
export function weekdayName(weekday: number): string {
  return `星期${WEEKDAYS[((weekday % 7) + 7) % 7]}`;
}

/** Short Chinese duration: `5 分鐘`, `1 小時 20 分`. */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}
