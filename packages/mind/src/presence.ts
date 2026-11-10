// When the people she cares about usually show up (§3.7 "在意的人通常幾點上線"), from what
// she saw: the first time each person showed up on each local day (a message, a voice line, a
// salient "came online"), kept for `MAX_DAYS` days. Seeded from the message log once a day,
// kept up to date from live events, persisted with her plan state. Pure apart from its memory.

import type { Handle, JsonValue } from "@miyoria/types";
import { isJsonObject } from "@miyoria/types";

const MINUTE_MS = 60_000;
/** Days remembered per person. */
export const MAX_DAYS = 14;
/** People remembered (the least recently seen dropped). */
const MAX_PEOPLE = 60;
/** Days with a sighting needed before she speaks of a habit. */
export const MIN_DAYS = 2;

/** `YYYY-MM-DD` and minute of the day of `at` in her time zone. */
function local(at: number, offsetMinutes: number): { day: string; minute: number } {
  const d = new Date(at + offsetMinutes * MINUTE_MS);
  return { day: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Someone's habit: around when they usually show up first, and on how many days. */
export interface PresenceHabit {
  handle: Handle;
  /** Median first-seen minute of the day (local). */
  minute: number;
  /** Days with a sighting, of the days kept. */
  days: number;
  /** They were already seen today. */
  today: boolean;
}

export class PresenceStats {
  /** handle → local day → first-seen minute of that day. */
  readonly #days = new Map<Handle, Map<string, number>>();

  constructor(private readonly offsetMinutes: number) {}

  /** `handle` showed up at `at` (epoch ms). */
  seen(handle: Handle, at: number): void {
    if (handle === "") return;
    const { day, minute } = local(at, this.offsetMinutes);
    let days = this.#days.get(handle);
    if (!days) {
      days = new Map();
      this.#days.set(handle, days);
      if (this.#days.size > MAX_PEOPLE) {
        const stale = [...this.#days.entries()]
          .map(([h, d]) => [h, [...d.keys()].sort().at(-1) ?? ""] as const)
          .sort((a, b) => (a[1] < b[1] ? -1 : 1))[0];
        if (stale) this.#days.delete(stale[0]);
      }
    } else {
      // Most recently seen last, for the bound above.
      this.#days.delete(handle);
      this.#days.set(handle, days);
    }
    const prev = days.get(day);
    if (prev === undefined || minute < prev) days.set(day, minute);
    if (days.size > MAX_DAYS) {
      for (const d of [...days.keys()].sort().slice(0, days.size - MAX_DAYS)) days.delete(d);
    }
  }

  /** `handle`'s habit as of `now`, or `null` with fewer than `MIN_DAYS` days seen. */
  habit(handle: Handle, now: number): PresenceHabit | null {
    const days = this.#days.get(handle);
    if (!days || days.size < MIN_DAYS) return null;
    const minutes = [...days.values()].sort((a, b) => a - b);
    const mid = Math.floor(minutes.length / 2);
    const median =
      minutes.length % 2 === 1
        ? (minutes[mid] as number)
        : Math.round(((minutes[mid - 1] as number) + (minutes[mid] as number)) / 2);
    return {
      handle,
      minute: median,
      days: days.size,
      today: days.has(local(now, this.offsetMinutes).day),
    };
  }

  /** People with a habit, the most regular first. */
  habits(now: number): PresenceHabit[] {
    return [...this.#days.keys()]
      .flatMap((h) => {
        const habit = this.habit(h, now);
        return habit ? [habit] : [];
      })
      .sort((a, b) => b.days - a.days || a.minute - b.minute);
  }

  toJSON(): JsonValue {
    const out: Record<string, Record<string, number>> = {};
    for (const [h, days] of this.#days) out[h] = Object.fromEntries(days);
    return out;
  }

  load(value: JsonValue | undefined): void {
    if (!isJsonObject(value)) return;
    for (const [h, days] of Object.entries(value)) {
      if (!isJsonObject(days)) continue;
      const map = new Map<string, number>();
      for (const [day, minute] of Object.entries(days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof minute === "number") map.set(day, minute);
      }
      if (map.size > 0) this.#days.set(h, map);
    }
  }
}

/** `21:05` */
export function clock(minute: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(minute / 60) % 24)}:${p(minute % 60)}`;
}

/** One line per habit (`Owen:通常 21:05 左右出現(最近 9 天有 7 天),今天還沒看到`). */
export function renderHabit(h: PresenceHabit, kept: number = MAX_DAYS): string {
  return `${h.handle}:通常 ${clock(h.minute)} 左右出現(最近 ${kept} 天裡有 ${h.days} 天)${h.today ? ",今天已經看到了" : ",今天還沒看到"}`;
}
