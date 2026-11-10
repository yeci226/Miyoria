// What she did today and lately (docs/design/v4-plan.md §6.2 「今天的她」, §8.1, §8.2): her life log.
//
// Only what really ran is written, so the summary never claims something she did not do
// (v3 §10.1: "做好了" needs a result): her own capability calls the gate allowed (a search, a
// program, a song she prepared) and what the activity snapshot shows ran for a while (a game, a
// song). Calls made for someone else are theirs, not her life, and are left out.
//
// One settings row per day of hers (`mind:life:<day>`, the day turning at `[modules.mind]
// daily_hour`, so 01:00 still belongs to the evening before), the last `life_keep_days` kept.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  ACTIVITY_CHANGED_TOPIC,
  type Clock,
  type Envelope,
  isJsonObject,
  isLifeActivityId,
  type JsonObject,
  type JsonValue,
  type LifeActivityId,
  type LifeEntry,
  type LifeLog,
  newId,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";
import { LIFE_ACTIVITIES, type LifeTally, lifeActivity } from "./activities.js";

const log = getLogger("mind.life");

/** Settings key prefix of her life log (one row per day of hers). */
export const LIFE_PREFIX = "mind:life:";
const GATE_DECISION_TOPIC = "gate.decision";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Entries kept per day (the oldest go first). */
export const MAX_DAY_ENTRIES = 120;
/** A run shorter than this did not really happen (a game that failed to load). */
const MIN_RUN_MS = MINUTE_MS;
/** `what` is cut to this. */
const MAX_WHAT = 60;

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

const str = (o: JsonObject, key: string): string | null => {
  const v = o[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

/** What one of her own calls did, in her terms; `null`: not part of her life log. */
export function pointOf(
  capability: string,
  args: JsonObject,
): { activity: LifeActivityId; what: string } | null {
  switch (capability) {
    case "web.search": {
      const q = str(args, "query");
      return { activity: "browse", what: q === null ? "查了東西" : `查了「${cut(q, 40)}」` };
    }
    case "web.read": {
      const url = str(args, "url");
      let host: string | null = null;
      try {
        host = url === null ? null : new URL(url).hostname;
      } catch {
        host = null;
      }
      return { activity: "browse", what: host === null ? "讀了一篇網頁" : `讀了 ${host} 的網頁` };
    }
    case "code.run":
    case "workspace.write":
    case "skill.run": {
      const lang = str(args, "language");
      return { activity: "code", what: lang === null ? "寫了程式" : `寫了一段 ${lang}` };
    }
    case "sing.request": {
      const q = str(args, "query");
      return { activity: "practice", what: q === null ? "練了一首歌" : `準備了〈${cut(q, 30)}〉` };
    }
    case "diary.write":
      return { activity: "diary", what: "寫了日記" };
    case "notebook.write":
      return { activity: "recap", what: "整理了筆記" };
    case "economy.post_bounty":
      return { activity: "business", what: "開了懸賞" };
    case "economy.propose_goal":
      return { activity: "business", what: "發起了募資" };
    case "party.start": {
      const game = str(args, "game");
      return { activity: "event", what: game === null ? "辦了派對遊戲" : `辦了${cut(game, 20)}` };
    }
    default:
      return null;
  }
}

function parseEntry(value: JsonValue): LifeEntry | null {
  if (!isJsonObject(value)) return null;
  const { id, activity, what, at, minutes, capability } = value;
  if (typeof id !== "string" || !isLifeActivityId(activity) || typeof what !== "string") {
    return null;
  }
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return {
    id,
    activity,
    what,
    at,
    minutes: typeof minutes === "number" && minutes >= 0 ? minutes : null,
    capability: typeof capability === "string" ? capability : null,
  };
}

export interface LifeBookOptions {
  store: SettingsStore | null;
  profile: ProfileId;
  clock: Clock;
  /** Her UTC offset, minutes. */
  offsetMinutes: number;
  /** Her day turns at this local hour. */
  dayStartHour: number;
  /** Days kept. */
  keepDays: number;
  /** Every entry as it is written (her daily posts follow it). */
  onRecord?: (entry: LifeEntry) => void;
}

/** Her life log: `LifeLogKey`. Reads answer from memory; writes persist in the background. */
export class LifeBook implements LifeLog {
  readonly #o: LifeBookOptions;
  /** Day → entries, oldest first. */
  readonly #days = new Map<string, LifeEntry[]>();
  readonly #writes = new SerialQueue();
  #running: { type: string; target: string | null; since: number } | null = null;

  constructor(options: LifeBookOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.clock.now();
  }

  /** Her day of `at` (`2026-11-10`): the local date, turning at `dayStartHour`. */
  dayOf(at: number): string {
    const shifted = at + this.#o.offsetMinutes * MINUTE_MS - this.#o.dayStartHour * HOUR_MS;
    return new Date(shifted).toISOString().slice(0, 10);
  }

  /** Epoch ms her day of `at` began. */
  dayStart(at: number): number {
    const day = this.dayOf(at);
    return (
      Date.parse(`${day}T00:00:00.000Z`) -
      this.#o.offsetMinutes * MINUTE_MS +
      this.#o.dayStartHour * HOUR_MS
    );
  }

  /** Minutes she has been up today (at least an hour, so a share is never of nothing). */
  awakeMinutes(at = this.#now()): number {
    return Math.max(60, (at - this.dayStart(at)) / MINUTE_MS);
  }

  async load(): Promise<void> {
    const store = this.#o.store;
    if (!store) return;
    const keep = new Set<string>();
    const now = this.#now();
    for (let i = 0; i < this.#o.keepDays; i++) keep.add(this.dayOf(now - i * DAY_MS));
    for (const [key, value] of await store.list(this.#o.profile, LIFE_PREFIX)) {
      const day = key.slice(LIFE_PREFIX.length);
      if (!keep.has(day)) {
        void this.#writes
          .run(() => store.set(this.#o.profile, key, null))
          .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "cannot drop a day"));
        continue;
      }
      if (!Array.isArray(value)) continue;
      const entries = value.flatMap((v) => {
        const e = parseEntry(v);
        return e ? [e] : [];
      });
      this.#days.set(day, entries);
    }
  }

  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  /** Writes one entry (its day is the day it started). */
  record(entry: Omit<LifeEntry, "id"> & { id?: string }): LifeEntry {
    const kept: LifeEntry = {
      id: entry.id ?? newId(),
      activity: entry.activity,
      what: cut(entry.what, MAX_WHAT),
      at: entry.at,
      minutes: entry.minutes === null ? null : Math.round(entry.minutes),
      capability: entry.capability,
    };
    const day = this.dayOf(Date.parse(kept.at));
    const list = [...(this.#days.get(day) ?? []), kept].slice(-MAX_DAY_ENTRIES);
    this.#days.set(day, list);
    this.#prune();
    this.#persist(day);
    this.#o.onRecord?.({ ...kept });
    return { ...kept };
  }

  #prune(): void {
    const now = this.#now();
    const keep = new Set<string>();
    for (let i = 0; i < this.#o.keepDays; i++) keep.add(this.dayOf(now - i * DAY_MS));
    for (const day of [...this.#days.keys()]) {
      if (keep.has(day)) continue;
      this.#days.delete(day);
      this.#persist(day);
    }
  }

  #persist(day: string): void {
    const store = this.#o.store;
    if (!store) return;
    const list = this.#days.get(day);
    const value = list === undefined ? null : (JSON.parse(JSON.stringify(list)) as JsonValue);
    void this.#writes
      .run(() => store.set(this.#o.profile, `${LIFE_PREFIX}${day}`, value))
      .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "cannot persist her day"));
  }

  /** Follows the bus: her own allowed calls, and runs of the activity snapshot. */
  observe(env: Envelope): void {
    const event = env.event;
    if (event.type !== "custom") return;
    const { topic, payload } = event.data;
    if (topic === GATE_DECISION_TOPIC) this.#decision(payload);
    else if (topic === ACTIVITY_CHANGED_TOPIC) this.#activity(payload);
  }

  #decision(payload: JsonValue): void {
    if (!isJsonObject(payload) || payload.allowed !== true) return;
    const principal = isJsonObject(payload.principal) ? payload.principal : null;
    // Only what she does as herself is her life; what she does for someone is theirs.
    if (principal?.kind !== "self") return;
    const capability = typeof payload.capability === "string" ? payload.capability : "";
    const args = isJsonObject(payload.args) ? payload.args : {};
    // A song someone asked for is theirs, not her practice: she sings it as herself, but with them
    // as the requester. Only a song she picked (no requester), or one the sing module marks as
    // practice, is (2026-11-10: every request counted as her practice).
    if (capability === "sing.request" && principal.requester != null && args.practice !== true) {
      return;
    }
    const point = pointOf(capability, args);
    if (point === null) return;
    const at = typeof payload.at === "string" ? payload.at : toTimestamp(this.#now());
    this.record({ ...point, at, minutes: null, capability });
  }

  #activity(payload: JsonValue): void {
    if (!isJsonObject(payload) || !isJsonObject(payload.activity)) return;
    const a = payload.activity;
    const type = typeof a.type === "string" ? a.type : "idle";
    const running = a.phase === "running" && (type === "game" || type === "singing");
    const target = typeof a.target === "string" ? a.target : null;
    const prev = this.#running;
    if (prev !== null && (!running || prev.type !== type || prev.target !== target)) {
      this.#running = null;
      const ms = this.#now() - prev.since;
      if (ms >= MIN_RUN_MS) {
        const game = prev.type === "game";
        this.record({
          activity: game ? "game" : "sing",
          what: game ? (prev.target ?? "遊戲") : `唱了〈${prev.target ?? "一首歌"}〉`,
          at: toTimestamp(prev.since),
          minutes: ms / MINUTE_MS,
          capability: game ? "game.start" : "sing.play",
        });
      }
    }
    if (running && this.#running === null) {
      const since = typeof a.since === "string" ? Date.parse(a.since) : Number.NaN;
      this.#running = {
        type,
        target,
        since: Number.isNaN(since) ? this.#now() : Math.min(since, this.#now()),
      };
    }
  }

  entries(since = 0): LifeEntry[] {
    return [...this.#days.values()]
      .flat()
      .filter((e) => Date.parse(e.at) >= since)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((e) => ({ ...e }));
  }

  today(): LifeEntry[] {
    return (this.#days.get(this.dayOf(this.#now())) ?? []).map((e) => ({ ...e }));
  }

  /** Today per row (for the variety rule); a game still running counts already. */
  tally(at = this.#now()): Map<LifeActivityId, LifeTally> {
    const out = new Map<LifeActivityId, LifeTally>();
    const add = (id: LifeActivityId, minutes: number, when: number) => {
      const t = out.get(id) ?? { count: 0, minutes: 0, last: null };
      out.set(id, {
        count: t.count + 1,
        minutes: t.minutes + minutes,
        last: t.last === null ? when : Math.max(t.last, when),
      });
    };
    for (const e of this.#days.get(this.dayOf(at)) ?? []) {
      const when = Date.parse(e.at) + (e.minutes ?? 0) * MINUTE_MS;
      add(e.activity, e.minutes ?? lifeActivity(e.activity).actMinutes, when);
    }
    const r = this.#running;
    if (r !== null) {
      const start = Math.max(r.since, this.dayStart(at));
      add(r.type === "game" ? "game" : "sing", Math.max(0, at - start) / MINUTE_MS, at);
    }
    return out;
  }

  summary(scope: "today" | "lately" = "today"): string | null {
    const now = this.#now();
    if (scope === "today") return renderToday(this.today(), now, this.#o.offsetMinutes);
    const since = this.dayStart(now) - 2 * DAY_MS;
    return renderLately(this.entries(since), now, (at) => this.dayOf(at), this.#o.offsetMinutes);
  }
}

// ---- the renderer -------------------------------------------------------------------------------

function duration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} 小時` : `${h} 小時 ${m % 60} 分`;
}

function hhmm(at: number, offsetMinutes: number): string {
  return new Date(at + offsetMinutes * MINUTE_MS).toISOString().slice(11, 16);
}

/** One line per row she did, in the order she first did it. */
export function renderLines(entries: readonly LifeEntry[]): string[] {
  const groups = new Map<LifeActivityId, LifeEntry[]>();
  for (const e of entries) groups.set(e.activity, [...(groups.get(e.activity) ?? []), e]);
  const lines: string[] = [];
  for (const [id, list] of groups) {
    const label = LIFE_ACTIVITIES.find((a) => a.id === id)?.label ?? id;
    const timed = list.filter((e) => e.minutes !== null);
    const minutes = timed.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
    const parts: string[] = [];
    if (timed.length > 0 && minutes >= 1) parts.push(duration(minutes));
    else if (list.length > 1) parts.push(`${list.length} 次`);
    const whats = [...new Set(list.map((e) => e.what))];
    const shown = whats.slice(-3).join("、");
    const more = whats.length > 3 ? ` 等 ${whats.length} 件` : "";
    lines.push(`- ${label}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}:${shown}${more}`);
  }
  return lines;
}

/**
 * 「今天的她」: what she did today, one line per kind of thing, or `null` when nothing yet. What
 * she searched may quote others: the caller shows it as data, not as rules.
 */
export function renderToday(
  entries: readonly LifeEntry[],
  now: number,
  offsetMinutes: number,
): string | null {
  if (entries.length === 0) return null;
  return [`今天到 ${hhmm(now, offsetMinutes)} 你做過的事:`, ...renderLines(entries)].join("\n");
}

/** The last three days, today first; `null` when nothing. */
export function renderLately(
  entries: readonly LifeEntry[],
  now: number,
  dayOf: (at: number) => string,
  offsetMinutes: number,
): string | null {
  if (entries.length === 0) return null;
  const byDay = new Map<string, LifeEntry[]>();
  for (const e of entries) {
    const day = dayOf(Date.parse(e.at));
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const today = dayOf(now);
  const yesterday = dayOf(now - DAY_MS);
  const out: string[] = [];
  for (const day of [...byDay.keys()].sort().reverse()) {
    const name =
      day === today
        ? `今天(到 ${hhmm(now, offsetMinutes)})`
        : day === yesterday
          ? "昨天"
          : `${day.slice(5, 7)}/${day.slice(8, 10)}`;
    out.push(`${name}:`, ...renderLines(byDay.get(day) ?? []));
  }
  return out.join("\n");
}
