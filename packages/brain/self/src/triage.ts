// When to wake her and where to look (docs/design/v5-brain.md 「設計的結論」, v5-architecture §7.1).
// Plain rules, no dice and no scores:
//
// - her own lines, bots' lines, flagged lines and anything muted never wake her;
// - a line said to her (a mention, her name, a reply to her, a DM) always does;
// - a result of something she started, a timer that is due and a salient world event do;
// - anything else people say is ambient: at most N glances an hour per place, by the place's
//   level (owner decision Q5: quiet 2, normal 6, talkative 12), spread out (a glance waits at
//   least half the average gap after the one before), and a cap for the day over all places.
//   An ambient line that gets no glance waits: the next glance at the place reads it too.
//
// Pure: the caller keeps the state and notes each glance it starts (`noteGlance`).

import type { ChannelMode } from "../../agent/src/index.js";
import type { AddressedReason } from "./types.js";

export const HOUR_MS = 3_600_000;

/** Glances an hour per place by the place's level (`ChannelMode`). */
export const GLANCES_PER_HOUR: Readonly<Record<ChannelMode, number>> = {
  off: 0,
  "mention-only": 0,
  quiet: 2,
  normal: 6,
  lively: 12,
  always: 12,
};

export type TriageEvent =
  /** A line someone (or she) wrote in a place. */
  | {
      kind: "line";
      /** The place (`contextKeyString`). */
      place: string;
      at: number;
      /** Why it is said to her (`addressedReason`); `null`: it is not. */
      addressed: AddressedReason | null;
      /** Hers. */
      own: boolean;
      bot: boolean;
      /** The input defence flagged it. */
      flagged: boolean;
      /** Its author or its place is muted for her. */
      muted: boolean;
    }
  /** Something she started came back. */
  | { kind: "result" }
  /** A timer of hers; `due`: its time came. */
  | { kind: "timer"; due: boolean }
  /** Something happened in the world; `salient`: the world module marked it worth a look. */
  | { kind: "world"; salient: boolean };

export interface TriageConfig {
  /** The master switch of glances (the panel's). Off: ambient lines never wake her. */
  glances: boolean;
  /** Glances a day over all places. */
  perDay: number;
}

export const DEFAULT_TRIAGE: TriageConfig = { glances: true, perDay: 120 };

export interface TriageState {
  config: TriageConfig;
  /** The level of a place (`contextKeyString`). */
  level(place: string): ChannelMode;
  /** When she glanced at each place, oldest first (only the last hour is read). */
  glances: ReadonlyMap<string, readonly number[]>;
  /** Glances started today over all places. */
  today: number;
}

export type TriageDecision =
  | { decision: "wake"; why: "addressed" | "result" | "timer" | "world" }
  | { decision: "glance" }
  | {
      decision: "hold";
      why:
        | "own"
        | "bot"
        | "flagged"
        | "muted"
        | "not_due"
        | "not_salient"
        | "glances_off"
        | "level"
        | "hourly_cap"
        | "too_soon"
        | "daily_cap";
    };

const hold = (why: Extract<TriageDecision, { decision: "hold" }>["why"]): TriageDecision => ({
  decision: "hold",
  why,
});

/** What to do with `event`. */
export function triage(event: TriageEvent, state: TriageState, now: number): TriageDecision {
  switch (event.kind) {
    case "result":
      return { decision: "wake", why: "result" };
    case "timer":
      return event.due ? { decision: "wake", why: "timer" } : hold("not_due");
    case "world":
      return event.salient ? { decision: "wake", why: "world" } : hold("not_salient");
    case "line":
      break;
  }
  if (event.own) return hold("own");
  if (event.bot) return hold("bot");
  if (event.flagged) return hold("flagged");
  if (event.muted) return hold("muted");
  if (event.addressed !== null) return { decision: "wake", why: "addressed" };
  if (!state.config.glances) return hold("glances_off");
  const perHour = GLANCES_PER_HOUR[state.level(event.place)];
  if (perHour <= 0) return hold("level");
  const recent = (state.glances.get(event.place) ?? []).filter((at) => now - at < HOUR_MS);
  if (recent.length >= perHour) return hold("hourly_cap");
  const last = recent.at(-1);
  if (last !== undefined && now - last < HOUR_MS / (2 * perHour)) return hold("too_soon");
  if (state.today >= state.config.perDay) return hold("daily_cap");
  return { decision: "glance" };
}

/** `state` after a glance at `place` at `at`: the hour before it kept, the day's count up. */
export function noteGlance(state: TriageState, place: string, at: number): TriageState {
  const glances = new Map(state.glances);
  const kept = (glances.get(place) ?? []).filter((t) => at - t < HOUR_MS);
  glances.set(place, [...kept, at]);
  return { ...state, glances, today: state.today + 1 };
}

/**
 * Today's `directReason` (agent/attention.ts) as a word: `dm`, `mention`, `reply`, or `name` for
 * her name in the line; `null` when the line is not said to her.
 */
export function addressedReason(reason: string | null): AddressedReason | null {
  if (reason === null) return null;
  if (reason === "dm" || reason === "mention" || reason === "reply") return reason;
  return reason.startsWith("name") ? "name" : null;
}
