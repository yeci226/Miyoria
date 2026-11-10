// Relationship arithmetic: event values, daily caps, diminishing returns, the owner floor and
// labels. Pure functions, no I/O.

import type { Relationship, RelationshipDelta } from "@miyoria/store";
import {
  type RelationshipLabel,
  relationshipLabel,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import type { SocialConfig } from "./config.js";

export const OWNER_TAG = "owner";
export const BLOCKED_TAG = "blocked";

const DAY_MS = 86_400_000;

/** Something a person did toward her (serialized snake_case, like the Rust enum). */
export type EventKind =
  | "greeting"
  | "thanks"
  | "praise"
  | "gift"
  | "friendly"
  | "apology"
  /** Overall positive tone judged by the LLM (`toward_her > 0`). */
  | "warm"
  /** Overall negative tone judged by the LLM (`toward_her < 0`). */
  | "cold"
  | "rude"
  | "insult"
  | "harassment"
  | "flirt_too_far";

/**
 * Kinds only the economy moves (`RelationshipEffects`): a paid gift and a deal they paid for.
 * Never named by rules or the LLM, so they have no synonyms.
 */
export type EconomyKind = "treat" | "deal_kept";
export const ECONOMY_KINDS: readonly EconomyKind[] = ["treat", "deal_kept"];

/** What a day's budget counts: events and the economy's kinds. */
export type LedgerKind = EventKind | EconomyKind;

/** Every kind, in declaration order (the Rust `Ord`). */
export const EVENT_KINDS: readonly EventKind[] = [
  "greeting",
  "thanks",
  "praise",
  "gift",
  "friendly",
  "apology",
  "warm",
  "cold",
  "rude",
  "insult",
  "harassment",
  "flirt_too_far",
];

const SYNONYMS: Readonly<Record<string, EventKind>> = {
  greeting: "greeting",
  greet: "greeting",
  hello: "greeting",
  thanks: "thanks",
  thank: "thanks",
  gratitude: "thanks",
  praise: "praise",
  compliment: "praise",
  gift: "gift",
  donation: "gift",
  donate: "gift",
  tip: "gift",
  superchat: "gift",
  friendly: "friendly",
  kind: "friendly",
  kindness: "friendly",
  help: "friendly",
  support: "friendly",
  apology: "apology",
  apologize: "apology",
  sorry: "apology",
  warm: "warm",
  cold: "cold",
  rude: "rude",
  rudeness: "rude",
  mean: "rude",
  insult: "insult",
  abuse: "insult",
  abusive: "insult",
  harassment: "harassment",
  harass: "harassment",
  threat: "harassment",
  flirt_too_far: "flirt_too_far",
  flirting_too_far: "flirt_too_far",
  sexual: "flirt_too_far",
  creepy: "flirt_too_far",
};

/** Parses an event name, accepting a few synonyms LLMs like to use. */
export function parseEventKind(name: string): EventKind | null {
  const n = name.trim().toLowerCase().replace(/[- ]/g, "_");
  return Object.hasOwn(SYNONYMS, n) ? (SYNONYMS[n] as EventKind) : null;
}

/** Position in `EVENT_KINDS` (for sorting like the Rust `Ord`). */
export function eventKindOrder(kind: EventKind): number {
  return EVENT_KINDS.indexOf(kind);
}

export function isPositiveKind(kind: EventKind): boolean {
  switch (kind) {
    case "greeting":
    case "thanks":
    case "praise":
    case "gift":
    case "friendly":
    case "apology":
    case "warm":
      return true;
    default:
      return false;
  }
}

/**
 * `[affinity, trust]` before caps. `scale` only matters for `warm` / `cold` (the LLM's
 * `toward_her`, -1..1).
 */
export function baseChange(kind: EventKind, scale: number): [number, number] {
  const s = Math.abs(scale);
  switch (kind) {
    case "greeting":
      return [0.5, 0.1];
    case "thanks":
      return [1.0, 0.5];
    case "praise":
      return [1.5, 0.3];
    case "gift":
      return [3.0, 1.0];
    case "friendly":
      return [0.8, 0.3];
    case "apology":
      return [1.0, 0.8];
    case "warm":
      return [2.0 * s, 0.5 * s];
    case "cold":
      return [-2.0 * s, -0.8 * s];
    case "rude":
      return [-1.5, -0.5];
    case "insult":
      return [-3.0, -1.0];
    case "harassment":
      return [-5.0, -3.0];
    case "flirt_too_far":
      // Full weight from a stranger; `flirtWeight` scales it by how close they are.
      return [-2.0, -1.5];
  }
}

/** Affinity from which sexual jokes cost nothing (friends; the owner's floor is 30). */
export const FLIRT_FREE_AFFINITY = 30;

/**
 * How much a `flirt_too_far` counts against someone with `affinity`: 1 for strangers and people
 * she dislikes, falling to 0 at `FLIRT_FREE_AFFINITY` (from friends it is just teasing).
 */
export function flirtWeight(affinity: number): number {
  return Math.min(Math.max((FLIRT_FREE_AFFINITY - affinity) / FLIRT_FREE_AFFINITY, 0), 1);
}

/**
 * Where a capped change came from; part of the delta `reason`. `mind`: a hint from her own
 * mind loop (how she feels about someone after thinking about them).
 */
export type Source = "rule" | "appraisal" | "mind";

/** `"rule: praise"` → `praise`. Only rule / appraisal / mind / economy reasons count toward caps. */
export function cappedKind(reason: string): LedgerKind | null {
  const i = reason.indexOf(":");
  if (i < 0) return null;
  const source = reason.slice(0, i).trim();
  if (source === "economy") {
    const kind = reason.slice(i + 1).trim();
    return (ECONOMY_KINDS as readonly string[]).includes(kind) ? (kind as EconomyKind) : null;
  }
  if (source !== "rule" && source !== "appraisal" && source !== "mind") return null;
  return parseEventKind(reason.slice(i + 1));
}

/** Her local calendar day as a day number (days since 1970-01-01 in her time zone). */
export type LocalDay = number;

function clip(value: number, cap: number, gained: number, lost: number): number {
  if (value > 0) return Math.min(value, Math.max(cap - gained, 0));
  return Math.max(value, -Math.max(cap - lost, 0));
}

/** One person's appraisal budget for one local day. */
export class DayLedger {
  affinity_gained = 0;
  affinity_lost = 0;
  trust_gained = 0;
  trust_lost = 0;
  readonly counts = new Map<LedgerKind, number>();
  /** What each kind alone gained today: `[affinity, trust]`. */
  readonly kindGained = new Map<LedgerKind, [number, number]>();

  constructor(readonly day: LocalDay) {}

  /** Rebuilds a ledger from the deltas recorded since the start of `day`. */
  static fromDeltas(day: LocalDay, deltas: readonly RelationshipDelta[]): DayLedger {
    const ledger = new DayLedger(day);
    for (const d of deltas) {
      const kind = cappedKind(d.reason);
      if (kind === null) continue;
      ledger.counts.set(kind, (ledger.counts.get(kind) ?? 0) + 1);
      ledger.#book(d.affinity, d.trust, kind);
    }
    return ledger;
  }

  #book(affinity: number, trust: number, kind: LedgerKind | null = null): void {
    if (affinity > 0) this.affinity_gained += affinity;
    else this.affinity_lost -= affinity;
    if (trust > 0) this.trust_gained += trust;
    else this.trust_lost -= trust;
    if (kind === null) return;
    const [a, t] = this.kindGained.get(kind) ?? [0, 0];
    this.kindGained.set(kind, [a + Math.max(affinity, 0), t + Math.max(trust, 0)]);
  }

  /**
   * Applies diminishing returns and the daily caps to a raw change and books what is left.
   * `kindCap`: the most `kind` alone may gain today (affinity, trust), before the overall caps.
   */
  take(
    kind: LedgerKind,
    raw: readonly [number, number],
    config: SocialConfig,
    kindCap: readonly [number, number] | null = null,
  ): [number, number] {
    const count = this.counts.get(kind) ?? 0;
    const factor = Math.min(Math.max(config.repeat_decay, 0), 1) ** count;
    this.counts.set(kind, count + 1);
    let a = raw[0] * factor;
    let t = raw[1] * factor;
    if (kindCap !== null) {
      const [ga, gt] = this.kindGained.get(kind) ?? [0, 0];
      if (a > 0) a = Math.min(a, Math.max(kindCap[0] - ga, 0));
      if (t > 0) t = Math.min(t, Math.max(kindCap[1] - gt, 0));
    }
    const affinity = clip(a, config.daily_affinity_cap, this.affinity_gained, this.affinity_lost);
    const trust = clip(t, config.daily_trust_cap, this.trust_gained, this.trust_lost);
    this.#book(affinity, trust, kind);
    return [affinity, trust];
  }
}

export function hasTag(rel: Relationship, tag: string): boolean {
  return rel.tags.includes(tag);
}

export function isOwner(rel: Relationship): boolean {
  return hasTag(rel, OWNER_TAG);
}

export function isBlocked(rel: Relationship): boolean {
  return hasTag(rel, BLOCKED_TAG);
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Clamps every number to its range and applies the owner floor. */
export function normalize(rel: Relationship, config: SocialConfig): void {
  rel.affinity = clamp(finite(rel.affinity), -100, 100);
  rel.trust = clamp(finite(rel.trust), 0, 100);
  rel.familiarity = clamp(finite(rel.familiarity), 0, 100);
  if (isOwner(rel)) {
    rel.trust = clamp(config.owner_trust, 0, 100);
    rel.affinity = Math.max(rel.affinity, clamp(config.owner_affinity_floor, -100, 100));
  }
}

/** Adds the changes, normalizes and returns what actually changed. */
export function apply(
  rel: Relationship,
  affinity: number,
  trust: number,
  familiarity: number,
  config: SocialConfig,
): [number, number, number] {
  const before = [rel.affinity, rel.trust, rel.familiarity] as const;
  rel.affinity += affinity;
  rel.trust += trust;
  rel.familiarity += familiarity;
  normalize(rel, config);
  return [rel.affinity - before[0], rel.trust - before[1], rel.familiarity - before[2]];
}

/** The difference between two states as a delta row. */
export function diff(
  before: Relationship,
  after: Relationship,
  reason: string,
  at: number,
): RelationshipDelta {
  return {
    at: toTimestamp(at),
    affinity: after.affinity - before.affinity,
    trust: after.trust - before.trust,
    familiarity: after.familiarity - before.familiarity,
    reason,
  };
}

/**
 * How deep one line is (1..4), for familiarity: any line counts, one said to her counts more,
 * and a longer one (someone actually saying something) more still.
 */
export function lineDepth(text: string, directed: boolean): number {
  const length = [...text.trim()].length;
  let depth = 1;
  if (directed) depth += 1;
  if (length >= 40) depth += 1;
  if (length >= 120) depth += 1;
  return depth;
}

/**
 * Familiarity change for an interaction at `now`: it grows with how much people interact and
 * how deep it goes (`familiarity_per_line` × depth, slowing toward 100: a hundred lines are
 * worth more than ten, but nobody is "fully known" by volume alone), minus the decay for the
 * days without contact. It is not "+1 a day".
 */
export function familiarityChange(
  last: Timestamp | number | null,
  now: number,
  config: SocialConfig,
  current = 0,
  depth = 1,
): number {
  const room = Math.min(Math.max(1 - current / 100, 0), 1);
  const gain = Math.max(config.familiarity_per_line, 0) * Math.max(depth, 0) * room;
  if (last === null) return gain;
  const today = localDay(now, config);
  const lastMs = typeof last === "number" ? last : timestampMs(last);
  const gap = today - localDay(lastMs, config);
  if (gap <= 0) return gain;
  const idleDays = Math.max(gap - 1 - config.familiarity_grace_days, 0);
  return gain - idleDays * config.familiarity_decay_per_day;
}

/** Short label for prompts and `/me`: the one shared scale (`relationshipLabel`). */
export function label(rel: Relationship): RelationshipLabel {
  return relationshipLabel({ affinity: rel.affinity, familiarity: rel.familiarity });
}

function offsetMs(config: SocialConfig): number {
  const minutes = config.utc_offset_minutes;
  // chrono's FixedOffset rejects offsets of a day or more; fall back to UTC like legacy.
  return Math.abs(minutes) < 24 * 60 ? minutes * 60_000 : 0;
}

/** Her local calendar day of `ts` (epoch ms). */
export function localDay(ts: number, config: SocialConfig): LocalDay {
  return Math.floor((ts + offsetMs(config)) / DAY_MS);
}

/** The instant (epoch ms) her local `day` starts. */
export function dayStart(day: LocalDay, config: SocialConfig): number {
  return day * DAY_MS - offsetMs(config);
}
