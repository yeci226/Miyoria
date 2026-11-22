// Where the local stocks' counts come from (docs/design/exchange.md §9): the event log (the
// store's `events` table), which every module's facts already reach, so the exchange adds no
// counter of its own and imports no other module. Each source counts one completed Taipei day
// ([00:00, 24:00) Asia/Taipei, the local stocks' own day) and only rows, never whose they are.
//
// The five sources by role (the stock each moves is the profile's: RICE WHLE NAPS CUBE DPSK by
// default).
//
// - feeding, feedings: `economy.posted` (the coin ledger, kept forever). A `feed` charge counts the
//   bowls it bought (its `ref` is `<food>:<count>`); a `gift` charge counts once when it was food or
//   drink (its `ref` is `<id>:<hunger in thousandths>:<name>` and the hunger is above zero: things
//   that are not food take none); either does not count once refunded (a gift she said no to, a
//   refund by the owner) within two days after. Her own purse (`self`) never counts.
// - songs, songs finished: her observations of `sing.cue` (`facts.observation.ambient`, source
//   `sing`) whose state is `ended` and outcome `finished`: sung to the end, not stopped, skipped,
//   failed or cancelled. Ambient rows are folded after `[modules.facts] fold_after_days` (14), so
//   only the days still whole on record count.
// - silence, silent hours: the 24 hours of the day, less every hour in which one of her lines was
//   delivered (`facts.delivered`: a message the platform took or a voice line that played to the
//   end, text and voice alike), less every hour in which a model call failed (`llm.call` with
//   status `error`), so making her model fail can never make her look quiet. Hours Core was not
//   running count as silent: she was asleep.
// - game, game goals and deaths: her observations (`facts.observation`) of `game.director.goal`
//   with status `done`, and of a game's `death` events (`game.<game>.*` whose type is `death`). The
//   value is goals − deaths: no game played is 0, a neutral day.
// - model, model errors and slow calls: `llm.call` (every call the router made, kept 90 days) with
//   status `error`, plus those that answered (`ok`) slower than `slow_call_seconds`. Calls the
//   caller cancelled count as neither.
//
// A day counts only when it is whole on record: it ended, it began after the log's first row (a
// new instance has no history), and it is within its rows' keeping time. A redacted row has no
// data and counts nowhere.

import { EconomyPosted, GameDirectorGoal, LlmCall, SingCue } from "@miyoria/contracts/events";
import {
  type EventLogStore,
  type EventQuery,
  FactsDelivered,
  FactsObservation,
  FactsObservationAmbient,
  type LoggedEvent,
} from "@miyoria/store";
import { isJsonObject, type JsonObject, timestampMs, toTimestamp } from "@miyoria/types";
import type { LocalRole } from "./local.js";
import { taipeiDayWindow } from "./local.js";
import type { CountSource, DayCount, LocalSources } from "./signals.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Rows per page. */
const PAGE = 1000;
/** Pages per question at most (a day is far fewer). */
const MAX_PAGES = 200;
/** A feeding refunded this long after its day still does not count. */
const REFUND_DAYS = 2;

/** Days each kind of row stays whole on record (the store's tiers; ambient: the facts fold). */
export interface Keeping {
  ambient: number;
  short: number;
  long: number;
}

export const DEFAULT_KEEPING: Keeping = { ambient: 14, short: 90, long: 365 };

/** Every row of `query` in seq order. */
async function each(
  events: EventLogStore,
  query: EventQuery,
  f: (e: LoggedEvent) => void,
): Promise<void> {
  let after: number | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await events.query({
      ...query,
      order: "asc",
      limit: PAGE,
      ...(after === undefined ? {} : { afterSeq: after }),
    });
    for (const e of page) if (e.envelope.redacted_at === null) f(e);
    if (page.length < PAGE) return;
    const last = page.at(-1)?.envelope.seq;
    if (last === undefined || last === null) return;
    after = last;
  }
}

/** The bus event an observation keeps (`origin.event`): its type and data. */
function originOf(data: unknown): { type: string; data: JsonObject } | null {
  if (!isJsonObject(data) || !isJsonObject(data.origin)) return null;
  const event = data.origin.event;
  if (!isJsonObject(event) || typeof event.type !== "string" || !isJsonObject(event.data))
    return null;
  return { type: event.type, data: event.data };
}

/** When the log begins (its first row), asked once it has one. */
class Coverage {
  #first: number | null = null;

  constructor(private readonly events: EventLogStore) {}

  async first(): Promise<number | null> {
    if (this.#first !== null) return this.#first;
    const rows = await this.events.query({ order: "asc", limit: 1 });
    const at = rows[0]?.envelope.at;
    if (at !== undefined) this.#first = timestampMs(at);
    return this.#first;
  }

  /** Whether Taipei day `day` is whole on record at `now`, for rows kept `keepDays`. */
  async whole(day: number, now: number, keepDays: number): Promise<boolean> {
    const { start, end } = taipeiDayWindow(day);
    if (end > now || start < now - keepDays * DAY) return false;
    const first = await this.first();
    return first !== null && first <= start;
  }
}

export interface SourceDeps {
  /** The event log; `null`: there is none (every source is missing). */
  events: () => EventLogStore | null;
  /** Whether each company's module runs now (its service is there). */
  present: Readonly<Record<LocalRole, () => boolean>>;
  /** What each company's module is called, for "is off". */
  modules?: Readonly<Partial<Record<LocalRole, string>>>;
  /** The model stock: a call slower than this (ms) is slow. */
  slowMs: () => number;
  keeping?: Keeping;
}

const MODULE: Readonly<Record<LocalRole, string>> = {
  feeding: "economy",
  songs: "sing",
  silence: "facts",
  game: "game",
  model: "llm",
};

/** The five sources over the event log. */
export function eventLogSources(deps: SourceDeps): LocalSources {
  const keep = deps.keeping ?? DEFAULT_KEEPING;
  let coverage: { events: EventLogStore; c: Coverage } | null = null;
  const cover = (events: EventLogStore) => {
    if (coverage?.events !== events) coverage = { events, c: new Coverage(events) };
    return coverage.c;
  };
  const make = (
    role: LocalRole,
    label: string,
    keepDays: number,
    count: (events: EventLogStore, day: number, now: number) => Promise<DayCount>,
  ): CountSource => ({
    label,
    missing: () => {
      if (deps.events() === null) return "沒有事件紀錄";
      return deps.present[role]() ? null : `${deps.modules?.[role] ?? MODULE[role]} 沒有開`;
    },
    count: async (day, now) => {
      const events = deps.events();
      if (events === null || !(await cover(events).whole(day, now, keepDays))) return null;
      return count(events, day, now);
    },
  });
  return {
    feeding: make("feeding", "餵食(經濟模組的帳)", Number.POSITIVE_INFINITY, countFeedings),
    songs: make("songs", "唱完的歌(唱歌模組)", keep.ambient, countSongs),
    silence: make(
      "silence",
      "沒說話的小時(她送出的話)",
      Math.min(keep.long, keep.short),
      countSilence,
    ),
    game: make("game", "遊戲目標和死掉(遊戲模組)", keep.short, countGame),
    model: make("model", "模型出錯和太慢(模型路由)", keep.short, (events, day) =>
      countModel(events, day, deps.slowMs()),
    ),
  };
}

// ---- the counting rules ------------------------------------------------------------------------

/** feeding: bowls fed and food or drink gifts taken on `day`, refunds taken out. */
export async function countFeedings(
  events: EventLogStore,
  day: number,
  now: number,
): Promise<DayCount> {
  const { start, end } = taipeiDayWindow(day);
  const charges = new Map<string, number>();
  const refunded = new Set<string>();
  // Refunds come after the charge (a gift she said no to, minutes later; the owner's, later):
  // read on for `REFUND_DAYS` past the day, up to now.
  const until = Math.max(end, Math.min(now, end + REFUND_DAYS * DAY));
  await each(
    events,
    { types: [EconomyPosted.type], since: toTimestamp(start), until: toTimestamp(until) },
    (e) => {
      const d = e.envelope.data;
      if (!isJsonObject(d) || typeof d.reason !== "string" || typeof d.delta !== "number") return;
      const ref = typeof d.ref === "string" ? d.ref : null;
      if (d.reason === "refund") {
        if (ref !== null) refunded.add(ref);
        return;
      }
      const at = timestampMs(e.envelope.at);
      if (at >= end || d.delta >= 0 || d.person_id === "self") return;
      const id = typeof d.entry_id === "string" ? d.entry_id : e.envelope.id;
      if (d.reason === "feed") charges.set(id, fedCount(ref));
      else if (d.reason === "gift" && giftIsFood(ref)) charges.set(id, 1);
    },
  );
  let feeds = 0;
  for (const [id, n] of charges) if (!refunded.has(id)) feeds += n;
  return { value: feeds, parts: { feeds } };
}

/** A feed row's bowls (`<food>:<count>`); one when the count is not readable. */
export function fedCount(ref: string | null): number {
  const n = Number(ref?.split(":")[1]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** A gift row was food or drink: its hunger (`<id>:<thousandths>:<name>`) is above zero. */
export function giftIsFood(ref: string | null): boolean {
  const milli = Number(ref?.split(":")[1]);
  return Number.isFinite(milli) && milli > 0;
}

/** songs: songs sung to the end on `day`. */
export async function countSongs(events: EventLogStore, day: number): Promise<DayCount> {
  const { start, end } = taipeiDayWindow(day);
  let songs = 0;
  await each(
    events,
    {
      types: [FactsObservationAmbient.type, FactsObservation.type],
      sources: ["sing"],
      since: toTimestamp(start),
      until: toTimestamp(end),
    },
    (e) => {
      const o = originOf(e.envelope.data);
      if (o?.type === SingCue.type && o.data.state === "ended" && o.data.outcome === "finished")
        songs += 1;
    },
  );
  return { value: songs, parts: { songs } };
}

/** silence: hours of `day` with no line of hers delivered and no failed model call. */
export async function countSilence(events: EventLogStore, day: number): Promise<DayCount> {
  const { start, end } = taipeiDayWindow(day);
  const busy = new Set<number>();
  const hour = (e: LoggedEvent) => Math.floor((timestampMs(e.envelope.at) - start) / HOUR);
  await each(
    events,
    { types: [FactsDelivered.type], since: toTimestamp(start), until: toTimestamp(end) },
    (e) => busy.add(hour(e)),
  );
  await each(
    events,
    { types: [LlmCall.type], since: toTimestamp(start), until: toTimestamp(end) },
    (e) => {
      const d = e.envelope.data;
      if (isJsonObject(d) && d.status === "error") busy.add(hour(e));
    },
  );
  const hours = 24 - [...busy].filter((h) => h >= 0 && h < 24).length;
  return { value: hours, parts: { hours } };
}

/** game: game goals reached less deaths on `day`. */
export async function countGame(events: EventLogStore, day: number): Promise<DayCount> {
  const { start, end } = taipeiDayWindow(day);
  let goals = 0;
  let deaths = 0;
  await each(
    events,
    { types: [FactsObservation.type], since: toTimestamp(start), until: toTimestamp(end) },
    (e) => {
      const o = originOf(e.envelope.data);
      if (o === null) return;
      if (o.type === GameDirectorGoal.type) {
        if (o.data.status === "done") goals += 1;
        return;
      }
      const game = /^game\.([^.]+)\.(.+)$/.exec(o.type);
      if (game === null || game[1] === "director" || game[1] === "chat") return;
      const kind = typeof o.data.type === "string" ? o.data.type : game[2];
      if (kind === "death") deaths += 1;
    },
  );
  return { value: goals - deaths, parts: { goals, deaths } };
}

/** model: model calls that failed, and those that answered slower than `slowMs`, on `day`. */
export async function countModel(
  events: EventLogStore,
  day: number,
  slowMs: number,
): Promise<DayCount> {
  const { start, end } = taipeiDayWindow(day);
  let errors = 0;
  let slow = 0;
  await each(
    events,
    { types: [LlmCall.type], since: toTimestamp(start), until: toTimestamp(end) },
    (e) => {
      const d = e.envelope.data;
      if (!isJsonObject(d)) return;
      if (d.status === "error") errors += 1;
      else if (d.status === "ok" && typeof d.duration_ms === "number" && d.duration_ms > slowMs)
        slow += 1;
    },
  );
  return { value: errors + slow, parts: { errors, slow } };
}
