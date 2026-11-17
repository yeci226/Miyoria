// The code gates every opportunity to wake her passes before she is woken (docs/design/
// v5-architecture.md §7.6): plain rules over counts and times, no dice, no score of what she
// wants, no second model call. What passes wakes her; whether she says anything is hers.
//
// In order, the first that stops an opportunity is recorded:
//
//   no_place     there is no place to wake her in (a home item with no home place, a person she
//                has no DM with);
//   switch       the panel's pause of her own initiative (the actions gate's `paused`);
//   quiet_hours  the Arbiter's quiet hours;
//   budget       exhausted: nothing; degraded: only what someone else is owed (a followup, a
//                promise), as the Arbiter let only non-chatter through;
//   consent      a DM: the person is blocked, or opted out of DMs or of being approached;
//   level        the owner's level of the place (off, mention-only) or its opt-out entry;
//   daily_cap    her starts today, all places;
//   place_cap    her starts today in that place;
//   person_cap   her starts today aimed at that person;
//   min_gap      the shortest time between any two of her starts;
//   backoff      the time between two starts in one place: doubled for each one nobody answered
//                (up to `max_backoff`), one doubling forgotten per `backoff_decay_hours`, reset when
//                someone answers there;
//   unanswered   `max_unanswered` starts there in a row with no person speaking since;
//   cooldown     the time between two starts of the same kind (by kind; `0`: none);
//   same_kind    the start before was of the same kind, within `row_window_ms` (her timers are
//                exempt: each is a time she asked for).
//
// A day is her local day (`day_start_hour`). Pure but for the book's own state.

import { type AccountRef, type ContextKey, contextKeyString } from "@miyoria/types";
import type { ChannelMode } from "../../agent/src/index.js";
import {
  dayIndex,
  inQuietHours,
  type LocalTime,
  nextDayStart,
  quietEndsAt,
} from "../../arbiter/src/index.js";

const HOUR_MS = 3_600_000;

/** What can wake her on her own. */
export const OPPORTUNITY_KINDS = [
  "timer",
  "commitment",
  "followup",
  "world",
  "quiet",
  "longing",
  "morning",
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** Kinds that only pass a degraded budget: someone is owed them. */
const OWED: ReadonlySet<OpportunityKind> = new Set(["followup", "commitment"]);
/** Kinds the same-kind rule leaves alone. */
const ANY_ROW: ReadonlySet<OpportunityKind> = new Set(["timer"]);

/** Something that may wake her, before the gates. */
export interface Opportunity {
  /** Names it for the records (the inbox key, or `<kind>:<place>:<day>`). */
  id: string;
  kind: OpportunityKind;
  /** Where she would be woken; `null`: nowhere to (the `no_place` gate). */
  place: ContextKey | null;
  /** Whom it is aimed at (a person key: their id or handle), for the per-person cap. */
  person: string | null;
  /** The account a DM reaches, for consent. */
  account: AccountRef | null;
  /** It would wake her in a DM. */
  dm: boolean;
  /** What block 7 says woke her (the wake's note). */
  note: string;
  /** The inbox item behind it. */
  item: number | null;
}

export interface GateConfig {
  quiet: LocalTime | null;
  maxPerDay: number;
  maxPerPlacePerDay: number;
  maxPerPersonPerDay: number;
  minGapMs: number;
  gapMs: number;
  maxBackoff: number;
  backoffDecayMs: number;
  replyWindowMs: number;
  maxUnanswered: number;
  cooldownMs: Readonly<Partial<Record<OpportunityKind, number>>>;
  rowWindowMs: number;
  /** The place is on the owner's opt-out list (`[modules.arbiter] disabled_contexts`). */
  disabled(place: ContextKey): boolean;
}

/** What the gates read of the world at one moment. */
export interface GateFacts {
  now: number;
  paused: boolean;
  budget: "ok" | "degraded" | "exhausted";
  level(place: ContextKey): ChannelMode;
  /** Why she may not DM `account` on her own (`null`: she may). */
  consent(account: AccountRef): string | null;
}

export type GateName =
  | "no_place"
  | "switch"
  | "quiet_hours"
  | "budget"
  | "consent"
  | "level"
  | "daily_cap"
  | "place_cap"
  | "person_cap"
  | "min_gap"
  | "backoff"
  | "unanswered"
  | "cooldown"
  | "same_kind";

export type GateVerdict =
  | { pass: true }
  | { pass: false; gate: GateName; detail: string; retryAt: number | null };

/** One start of hers. */
export interface Start {
  at: number;
  kind: OpportunityKind;
  place: string | null;
  person: string | null;
}

/** What a place remembers of her starts there. */
export interface PlaceBackoff {
  lastStartAt: number | null;
  /** Starts nobody answered in a row (decayed by `backoffDecayMs`). */
  misses: number;
  missesAt: number;
  /** Starts with no person speaking there since. */
  unanswered: number;
  /** She spoke in a start there and waits for an answer since then. */
  waitingSince: number | null;
}

export interface GateSnapshot {
  day: number;
  starts: Start[];
  places: Record<string, PlaceBackoff>;
  lastByKind: Partial<Record<OpportunityKind, number>>;
  last: { kind: OpportunityKind; at: number } | null;
}

const EMPTY: GateSnapshot = { day: -1, starts: [], places: {}, lastByKind: {}, last: null };

const stop = (gate: GateName, detail: string, retryAt: number | null = null): GateVerdict => ({
  pass: false,
  gate,
  detail,
  retryAt,
});

/** The gates' books: today's starts, each place's back-off, the last start of each kind. */
export class GateBook {
  readonly #cfg: GateConfig;
  #s: GateSnapshot;

  constructor(config: GateConfig, snapshot: GateSnapshot | null = null) {
    this.#cfg = config;
    this.#s = snapshot === null ? structuredClone(EMPTY) : structuredClone(snapshot);
  }

  get config(): GateConfig {
    return this.#cfg;
  }

  snapshot(): GateSnapshot {
    return structuredClone(this.#s);
  }

  /** The books as they were kept. */
  restore(snapshot: GateSnapshot): void {
    this.#s = { ...structuredClone(EMPTY), ...structuredClone(snapshot) };
  }

  #day(now: number): number {
    return this.#cfg.quiet === null
      ? Math.floor(now / (24 * HOUR_MS))
      : dayIndex(now, this.#cfg.quiet);
  }

  /** Today's starts (a new day starts with none). */
  #today(now: number): Start[] {
    const day = this.#day(now);
    if (this.#s.day !== day) {
      this.#s.day = day;
      this.#s.starts = [];
    }
    return this.#s.starts;
  }

  #place(key: string): PlaceBackoff {
    let p = this.#s.places[key];
    if (p === undefined) {
      p = { lastStartAt: null, misses: 0, missesAt: 0, unanswered: 0, waitingSince: null };
      this.#s.places[key] = p;
    }
    return p;
  }

  /** Misses at `place` now, after decay. */
  misses(place: string, now: number): number {
    const p = this.#s.places[place];
    if (p === undefined || p.misses === 0) return 0;
    const forgotten = Math.floor((now - p.missesAt) / Math.max(this.#cfg.backoffDecayMs, 1));
    return Math.max(p.misses - Math.max(forgotten, 0), 0);
  }

  #maxDoublings(): number {
    return Math.max(Math.floor(Math.log2(Math.max(this.#cfg.maxBackoff, 1))), 0);
  }

  /** The gap between two starts at `place` now: base × 2^misses. */
  gapMs(place: string, now: number): number {
    return this.#cfg.gapMs * 2 ** Math.min(this.misses(place, now), this.#maxDoublings());
  }

  /** Her starts today (all places), for the panel and tests. */
  startsToday(now: number): number {
    return this.#today(now).length;
  }

  check(o: Opportunity, f: GateFacts): GateVerdict {
    const cfg = this.#cfg;
    const now = f.now;
    if (o.place === null) return stop("no_place", "沒有可以叫醒她的地方");
    const place = keyOf(o.place);
    if (f.paused) return stop("switch", "面板暫停了她自己起頭的事");
    if (cfg.quiet !== null && inQuietHours(now, cfg.quiet)) {
      return stop("quiet_hours", "安靜時段", quietEndsAt(now, cfg.quiet));
    }
    if (f.budget === "exhausted") return stop("budget", "今天的預算用完了");
    if (f.budget === "degraded" && !OWED.has(o.kind)) return stop("budget", "今天的預算快用完了");
    if (o.dm) {
      if (o.account === null) return stop("consent", "不知道私訊的是誰");
      const why = f.consent(o.account);
      if (why !== null) return stop("consent", why);
    }
    if (o.place.kind !== "dm") {
      const level = f.level(o.place);
      if (level === "off" || level === "mention-only")
        return stop("level", `這裡的等級是 ${level}`);
    }
    if (cfg.disabled(o.place)) return stop("level", "這裡設定成不主動說話");
    const today = this.#today(now);
    const tomorrow = cfg.quiet === null ? null : nextDayStart(now, cfg.quiet);
    if (cfg.maxPerDay > 0 && today.length >= cfg.maxPerDay) {
      return stop(
        "daily_cap",
        `今天已經自己起頭 ${today.length} 次(上限 ${cfg.maxPerDay})`,
        tomorrow,
      );
    }
    const here = today.filter((s) => s.place === place).length;
    if (cfg.maxPerPlacePerDay > 0 && here >= cfg.maxPerPlacePerDay) {
      return stop(
        "place_cap",
        `今天在這裡已經 ${here} 次(上限 ${cfg.maxPerPlacePerDay})`,
        tomorrow,
      );
    }
    if (o.person !== null && cfg.maxPerPersonPerDay > 0) {
      const theirs = today.filter((s) => s.person === o.person).length;
      if (theirs >= cfg.maxPerPersonPerDay) {
        return stop(
          "person_cap",
          `今天已經找對方 ${theirs} 次(上限 ${cfg.maxPerPersonPerDay})`,
          tomorrow,
        );
      }
    }
    const last = this.#s.last;
    if (last !== null && now - last.at < cfg.minGapMs) {
      return stop("min_gap", "剛剛才自己起頭過", last.at + cfg.minGapMs);
    }
    const p = this.#s.places[place];
    if (p !== undefined && p.lastStartAt !== null) {
      const until = p.lastStartAt + this.gapMs(place, now);
      if (now < until) {
        const misses = this.misses(place, now);
        return stop(
          "backoff",
          misses > 0 ? `這裡連續 ${misses} 次沒人回,要等久一點` : "剛在這裡起頭過",
          until,
        );
      }
    }
    if (p !== undefined && cfg.maxUnanswered > 0 && p.unanswered >= cfg.maxUnanswered) {
      return stop("unanswered", `這裡連續 ${p.unanswered} 次沒人說話,等有人說話`);
    }
    const cooldown = cfg.cooldownMs[o.kind] ?? 0;
    const lastOfKind = this.#s.lastByKind[o.kind];
    if (cooldown > 0 && lastOfKind !== undefined && now - lastOfKind < cooldown) {
      return stop("cooldown", `同一種事剛有過`, lastOfKind + cooldown);
    }
    if (
      !ANY_ROW.has(o.kind) &&
      last !== null &&
      last.kind === o.kind &&
      now - last.at < cfg.rowWindowMs
    ) {
      return stop("same_kind", "上一次也是同一種事", last.at + cfg.rowWindowMs);
    }
    return { pass: true };
  }

  /** `o` woke her at `now`. */
  started(o: Opportunity, now: number): void {
    const place = o.place === null ? null : keyOf(o.place);
    this.#today(now).push({ at: now, kind: o.kind, place, person: o.person });
    this.#s.last = { kind: o.kind, at: now };
    this.#s.lastByKind[o.kind] = now;
    if (place !== null) this.#place(place).lastStartAt = now;
  }

  /** A run she started herself said something at `place`: it waits for an answer. */
  spoke(place: string, now: number): void {
    const p = this.#place(place);
    p.unanswered += 1;
    p.waitingSince = now;
  }

  /** A person spoke at `place` (`answered`: to her: a mention, a reply, a DM). */
  heard(place: string, answered: boolean): void {
    const p = this.#s.places[place];
    if (p === undefined) return;
    p.unanswered = 0;
    if (answered) {
      p.misses = 0;
      p.waitingSince = null;
    }
  }

  /** Starts nobody answered within the reply window become misses; their places are returned. */
  settle(now: number): string[] {
    const out: string[] = [];
    for (const [key, p] of Object.entries(this.#s.places)) {
      if (p.waitingSince === null || now - p.waitingSince < this.#cfg.replyWindowMs) continue;
      p.misses = Math.min(this.misses(key, now) + 1, this.#maxDoublings());
      p.missesAt = now;
      p.waitingSince = null;
      out.push(key);
    }
    return out;
  }
}

/** The key of a place in the books (the host's, `contextKeyString`). */
export function keyOf(place: ContextKey): string {
  return contextKeyString(place);
}
