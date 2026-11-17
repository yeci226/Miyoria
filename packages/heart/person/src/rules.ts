// The heart's rules (docs/design/v5-heart.md §2.3; H3, H4, H9): she proposes, the program sets
// the size and the pace. Pure functions, no I/O; "now" is passed in as epoch ms.
//
// - A `feel` proposal has a direction only; its size is `step_share` of the field's daily cap in
//   that direction (a bad direction's cap is `negative_factor` times the good one's), and the n-th
//   of a day for one field, person and direction counts `repeat_damping^(n-1)`.
// - Every day has caps per field and direction for what her proposals, her reflection and
//   evidence may move. The bond's cap depends on the bond (H3). The day's totals come from the
//   day's `heart.changed` events (`DayLedger`).
// - From 知心 up a tier needs an anchor: without it a rise stops half a point below (H4).
//   `tier_floor` rises only when a tier is actually entered.
// - Once a day, `decayDay`: bond falls after a week without contact but never below the floor of
//   the highest tier reached; warmth relaxes toward what the bond makes normal; longing rises while
//   they are away and falls once they are back; a grudge fades to a floor and no further;
//   familiarity blurs slowly.

import type { HeartChangedData } from "@miyoria/store";
import {
  ANCHORED_TIER_MIN,
  BOND_LADDER,
  CARES_THRESHOLD,
  type Timestamp,
  tierFloorOf,
  tierProgress,
  tiersEntered,
  toTimestamp,
} from "@miyoria/types";
import type { HeartPersonConfig } from "./config.js";
import {
  clampField,
  type Direction,
  goodDirection,
  HEART_FIELDS,
  type HeartCause,
  type HeartField,
  type HeartPerson,
  hasAnchor,
  hasTag,
  OWNER_TAG,
  type ProposalField,
} from "./model.js";

const DAY_MS = 86_400_000;

// ---- days ---------------------------------------------------------------------------------

/** Her local calendar day as a day number (days since 1970-01-01 in her time zone). */
export type LocalDay = number;

/** Her local day of `ms`. */
export function localDay(
  ms: number,
  rules: Pick<HeartPersonConfig, "utc_offset_minutes">,
): LocalDay {
  return Math.floor((ms + rules.utc_offset_minutes * 60_000) / DAY_MS);
}

/** The instant her local `day` starts. */
export function dayStart(
  day: LocalDay,
  rules: Pick<HeartPersonConfig, "utc_offset_minutes">,
): number {
  return day * DAY_MS - rules.utc_offset_minutes * 60_000;
}

// ---- steps, damping, caps -----------------------------------------------------------------

/** Whether moving `field` in `direction` is the bad way for the two of them. */
export function isNegative(field: HeartField, direction: Direction): boolean {
  return direction !== goodDirection(field);
}

/** The most bond a day may add, starting from `bond` (H3). */
export function bondGainCap(bond: number, rules: HeartPersonConfig): number {
  let cap = rules.bond_gain_caps[0]?.[1] ?? 0;
  for (const [min, value] of rules.bond_gain_caps) if (bond >= min) cap = value;
  return cap;
}

/**
 * The most `field` may move in `direction` on one day (bond: at the current bond). The bad
 * direction gets `negative_factor` times the good one.
 */
export function dailyCap(
  field: HeartField,
  direction: Direction,
  rules: HeartPersonConfig,
  bond = 0,
): number {
  let good: number;
  if (field === "bond") good = bondGainCap(bond, rules);
  else if (field in rules.caps) good = rules.caps[field as keyof HeartPersonConfig["caps"]];
  else return Number.POSITIVE_INFINITY;
  return isNegative(field, direction) ? good * rules.negative_factor : good;
}

/**
 * The signed change one `feel` proposal asks for, before damping and caps: `step_share` of the
 * day's cap in that direction (the bond's at `bond`), so every field and every tier takes as many
 * proposals to reach its cap, and a bad direction is `negative_factor` times a good one.
 */
export function proposalStep(
  field: ProposalField,
  direction: Direction,
  rules: HeartPersonConfig,
  bond = 0,
): number {
  const size = dailyCap(field, direction, rules, bond) * rules.step_share;
  return direction === "up" ? size : -size;
}

/** What the n-th proposal of a day (1, 2, 3, ...) for one field, person and direction counts. */
export function repeatFactor(n: number, rules: HeartPersonConfig): number {
  return rules.repeat_damping ** Math.max(n - 1, 0);
}

// ---- the day's ledger -----------------------------------------------------------------------

/** What one field moved on one day, by direction. */
export interface FieldLedger {
  /** Sum of the rises that count against the caps. */
  up: number;
  /** Sum of the falls that count against the caps (positive). */
  down: number;
  /** `feel` proposals made, by the direction asked (also those the caps took all of). */
  proposed_up: number;
  proposed_down: number;
}

/** One person's day: what counts against the caps and how many proposals were made. */
export interface DayLedger {
  day: LocalDay;
  fields: Record<HeartField, FieldLedger>;
}

/** The causes the daily caps apply to. Decay, the owner and the migration are not capped. */
export const CAPPED_CAUSES: readonly HeartCause[] = ["feel", "reflect", "evidence"];

export function emptyLedger(day: LocalDay): DayLedger {
  const fields = {} as Record<HeartField, FieldLedger>;
  for (const f of HEART_FIELDS) fields[f] = { up: 0, down: 0, proposed_up: 0, proposed_down: 0 };
  return { day, fields };
}

/** The direction of a change: what was asked when something was, else what was applied. */
function directionOf(change: Pick<HeartChange, "delta" | "proposed">): Direction | null {
  const sign = change.proposed !== null && change.proposed !== 0 ? change.proposed : change.delta;
  if (sign > 0) return "up";
  if (sign < 0) return "down";
  return null;
}

/** `ledger` with `change` booked (a new object). */
export function bookChange(ledger: DayLedger, change: HeartChange): DayLedger {
  if (!CAPPED_CAUSES.includes(change.cause)) return ledger;
  const before = ledger.fields[change.field];
  const next: FieldLedger = { ...before };
  if (change.delta > 0) next.up += change.delta;
  else next.down -= change.delta;
  if (change.cause === "feel") {
    const direction = directionOf(change);
    if (direction === "up") next.proposed_up += 1;
    if (direction === "down") next.proposed_down += 1;
  }
  return { day: ledger.day, fields: { ...ledger.fields, [change.field]: next } };
}

/** The ledger of `day` from that day's changes of one person (any order; others are skipped). */
export function ledgerFrom(
  day: LocalDay,
  changes: readonly { at: Timestamp; change: HeartChange }[],
  rules: HeartPersonConfig,
): DayLedger {
  let ledger = emptyLedger(day);
  for (const { at, change } of changes) {
    if (localDay(Date.parse(at), rules) !== day) continue;
    ledger = bookChange(ledger, change);
  }
  return ledger;
}

/** What is left of today's cap for `field` in `direction`. */
export function capLeft(
  ledger: DayLedger,
  field: HeartField,
  direction: Direction,
  rules: HeartPersonConfig,
  bond = 0,
): number {
  const used = direction === "up" ? ledger.fields[field].up : ledger.fields[field].down;
  return Math.max(dailyCap(field, direction, rules, bond) - used, 0);
}

// ---- the bond and its anchors ---------------------------------------------------------------

/** The bond after a change, the tier floor after it, and the tier it was held below if any. */
export interface BondResult {
  bond: number;
  tier_floor: number;
  /** The tier (its lowest bond) the rise stopped under for want of an anchor; `null`: none. */
  held: number | null;
}

/**
 * Applies `delta` to the bond. A rise into a tier from 知心 up that has no anchor (and was never
 * entered) stops `anchor_hold` below it (H4); `anchors: false` (the owner, the migration) skips
 * that. `tier_floor` becomes the highest tier the bond is actually in, if higher.
 */
export function applyBond(
  person: Pick<HeartPerson, "bond" | "tier_floor" | "anchors">,
  delta: number,
  rules: HeartPersonConfig,
  options: { anchors?: boolean } = {},
): BondResult {
  const before = clampField("bond", person.bond);
  let bond = clampField("bond", before + (Number.isFinite(delta) ? delta : 0));
  let held: number | null = null;
  if ((options.anchors ?? true) && bond > before) {
    for (const tier of tiersEntered(before, bond)) {
      if (tier.min < ANCHORED_TIER_MIN || tier.min <= person.tier_floor) continue;
      if (hasAnchor(person, tier.min)) continue;
      // Held just below, never lowered by what was meant as a rise.
      bond = Math.max(before, tier.min - rules.anchor_hold);
      held = tier.min;
      break;
    }
  }
  return { bond, tier_floor: Math.max(person.tier_floor, tierFloorOf(bond)), held };
}

/**
 * Every number in its range, the owner's trust and bond floor, and `tier_floor` raised to the
 * tier the bond is in. Returns a new person. With `only`, the owner's rules hold for that field
 * alone: a change of one field never moves another without its own event (tagging someone owner
 * applies both at once, `HeartStore.edit`).
 */
export function settle(
  person: HeartPerson,
  rules: HeartPersonConfig,
  only: HeartField | null = null,
): HeartPerson {
  const next = { ...person };
  for (const f of HEART_FIELDS) next[f] = clampField(f, next[f]);
  if (hasTag(next, OWNER_TAG)) {
    if (only === null || only === "trust") next.trust = clampField("trust", rules.owner_trust);
    if (only === null || only === "bond") {
      next.bond = Math.max(next.bond, clampField("bond", rules.owner_bond_floor));
    }
  }
  next.tier_floor = Math.max(next.tier_floor, tierFloorOf(next.bond));
  return next;
}

// ---- changes ----------------------------------------------------------------------------------

/** A `heart.changed` payload: what one change asked for and did. */
export type HeartChange = HeartChangedData;

/** What to change. */
export type HeartChangeRequest =
  /**
   * Her proposal: a direction, sized by the program. `feel` (the default) is damped by the day's
   * earlier proposals; `reflect` (her nightly reflection, one per field and direction) is not.
   */
  | {
      type: "propose";
      field: ProposalField;
      direction: Direction;
      quote: string;
      cause?: "feel" | "reflect";
    }
  /** A change of a given size: her reflection, evidence, the owner, decay, the migration. */
  | {
      type: "adjust";
      field: HeartField;
      delta: number;
      cause: Exclude<HeartCause, "feel">;
      quote: string;
    };

/** The person after one change, the event that records it and the ledger with it booked. */
export interface AppliedChange {
  person: HeartPerson;
  change: HeartChange;
  ledger: DayLedger;
  /** The tier a bond rise stopped under for want of an anchor; `null`: none. */
  held: number | null;
}

/**
 * Applies one change to `person`: the step and damping for a proposal, then today's cap (for the
 * capped causes), the range, the anchors (bond), and the owner rules. The returned event says
 * what was asked and what was applied (0 when the caps took all of it). `ledger` must be the
 * person's ledger of `now`'s local day.
 */
export function applyChange(
  person: HeartPerson,
  request: HeartChangeRequest,
  ledger: DayLedger,
  rules: HeartPersonConfig,
  now: number,
): AppliedChange {
  const field = request.field;
  const cause: HeartCause = request.type === "propose" ? (request.cause ?? "feel") : request.cause;
  let proposed: number | null;
  let wanted: number;
  if (request.type === "propose") {
    const step = proposalStep(request.field, request.direction, rules, person.bond);
    const counts = ledger.fields[field];
    const n = (request.direction === "up" ? counts.proposed_up : counts.proposed_down) + 1;
    proposed = step;
    wanted = cause === "feel" ? step * repeatFactor(n, rules) : step;
  } else {
    wanted = Number.isFinite(request.delta) ? request.delta : 0;
    proposed = cause === "decay" || cause === "migrate" ? null : wanted;
  }

  if (CAPPED_CAUSES.includes(cause) && wanted !== 0) {
    const direction: Direction = wanted > 0 ? "up" : "down";
    const left = capLeft(ledger, field, direction, rules, person.bond);
    wanted = wanted > 0 ? Math.min(wanted, left) : Math.max(wanted, -left);
  }

  let next: HeartPerson = { ...person };
  let held: number | null = null;
  if (field === "bond") {
    const anchors = cause !== "admin" && cause !== "migrate";
    const result = applyBond(person, wanted, rules, { anchors });
    next.bond = result.bond;
    next.tier_floor = result.tier_floor;
    held = result.held;
  } else {
    next[field] = clampField(field, person[field] + wanted);
  }
  next = settle(next, rules, field);
  next.updated_at = toTimestamp(now);

  const change: HeartChange = {
    person: person.person_id,
    field,
    delta: next[field] - person[field],
    value_after: next[field],
    proposed,
    reason_quote: request.quote,
    cause,
  };
  return { person: next, change, ledger: bookChange(ledger, change), held };
}

// ---- the daily pass -------------------------------------------------------------------------

/** One person's daily pass: the local day it is for and the changes it makes. */
export interface DecayPass {
  day: LocalDay;
  changes: HeartChangeRequest[];
}

/** `[bond, warmth]` points the warmth baseline runs through, by bond. */
const WARMTH_BASELINE: readonly (readonly [number, number])[] = [
  [-100, -0.6],
  [-15, -0.1],
  [0, 0],
  [45, 0.2],
  [120, 0.4],
  [300, 0.55],
  [600, 0.7],
  [1000, 0.8],
];

function interpolate(points: readonly (readonly [number, number])[], x: number): number {
  const first = points[0] as readonly [number, number];
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i] as readonly [number, number];
    const [x0, y0] = points[i - 1] as readonly [number, number];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return (points.at(-1) as readonly [number, number])[1];
}

/** How warm she is with someone of `bond` when nothing in particular is going on. */
export function warmthBaseline(bond: number): number {
  return interpolate(WARMTH_BASELINE, clampField("bond", bond));
}

/**
 * How at ease she starts with someone the migration brings over: the old records had no such
 * value, and zero would read 「拘謹」 for an old friend. It follows how well she knows them.
 */
export function startingEase(bond: number, familiarity: number): number {
  return bond < 0 ? 0 : clampField("ease", (0.8 * clampField("familiarity", familiarity)) / 100);
}

/** The same for how well their banter clicks. */
export function startingRapport(bond: number, familiarity: number): number {
  return bond < 0 ? 0 : clampField("rapport", (0.6 * clampField("familiarity", familiarity)) / 100);
}

function dayOf(ts: Timestamp | null, rules: HeartPersonConfig): LocalDay | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : localDay(ms, rules);
}

/**
 * The daily pass for `person` on the local day of `now` (and the days before it the pass missed,
 * up to `max_catch_up_days`), as changes with cause `decay`: one per field that moved, summed
 * over the days. Nothing for a day the pass already ran (`decayed_on`), so a second call on the
 * same day returns nothing; `applyDecay` applies the pass and records the day.
 */
export function decayDay(person: HeartPerson, now: number, rules: HeartPersonConfig): DecayPass {
  const today = localDay(now, rules);
  const d = rules.decay;
  if (person.decayed_on !== null && person.decayed_on >= today) return { day: today, changes: [] };
  const from =
    person.decayed_on === null
      ? today
      : Math.max(person.decayed_on + 1, today - d.max_catch_up_days + 1);
  const lastInteraction = dayOf(person.last_interaction, rules);
  const lastSeen = dayOf(person.last_seen ?? person.last_interaction, rules);
  const v = { ...person };
  const relax = 1 - 0.5 ** (1 / d.warmth_half_life_days);
  for (let day = from; day <= today; day++) {
    const idle = lastInteraction === null ? null : day - lastInteraction;
    const away = lastSeen === null ? null : day - lastSeen;
    if (idle !== null && idle > d.bond_grace_days) {
      const floor = Math.max(v.tier_floor, 0);
      if (v.bond > floor) v.bond = Math.max(v.bond - d.bond_per_day, floor);
    }
    const base = warmthBaseline(v.bond);
    if (Math.abs(base - v.warmth) >= d.min_change) v.warmth += (base - v.warmth) * relax;
    if (away !== null && away >= d.longing_away_days) {
      const target = caresBase(v.bond, v.warmth);
      if (target - v.longing >= d.min_change) v.longing += (target - v.longing) * d.longing_rise;
    } else if (away !== null && away >= 0 && away <= 1 && v.longing > 0) {
      v.longing = v.longing < d.min_change ? 0 : v.longing * (1 - d.longing_fall);
    }
    if (v.grudge > d.grudge_time_floor) {
      v.grudge = Math.max(v.grudge - d.grudge_fade_per_day, d.grudge_time_floor);
    }
    if (idle !== null && idle > d.familiarity_grace_days && v.familiarity > d.familiarity_floor) {
      v.familiarity = Math.max(v.familiarity - d.familiarity_blur_per_day, d.familiarity_floor);
    }
  }
  const changes: HeartChangeRequest[] = [];
  for (const field of ["bond", "warmth", "longing", "grudge", "familiarity"] as const) {
    const delta = v[field] - person[field];
    if (Math.abs(delta) < d.min_change) continue;
    changes.push({ type: "adjust", field, delta, cause: "decay", quote: "" });
  }
  return { day: today, changes };
}

/** Applies a daily pass to `person` and records its day, also when it changed nothing. */
export function applyDecay(
  person: HeartPerson,
  pass: DecayPass,
  ledger: DayLedger,
  rules: HeartPersonConfig,
  now: number,
): { person: HeartPerson; changes: HeartChange[] } {
  let current = person;
  const changes: HeartChange[] = [];
  for (const request of pass.changes) {
    const applied = applyChange(current, request, ledger, rules, now);
    current = applied.person;
    changes.push(applied.change);
  }
  return { person: { ...current, decayed_on: pass.day }, changes };
}

// ---- 在意 -----------------------------------------------------------------------------------

/**
 * How much she cares about someone by their tier alone, one value per tier of `BOND_LADDER`
 * (認識 0 ... 永恆羈絆 1): rising fast through the first tiers and slowly after.
 */
export const CARE_BY_TIER: readonly number[] = [
  0, 0.1, 0.26, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.84, 0.88, 0.92, 0.96, 1,
];

/**
 * From this much on, she cares (在意): world, self, mind and her initiative all use this. Defined
 * with the heart's service in `@miyoria/types`, which they read it from.
 */
export { CARES_THRESHOLD };

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0);

/** 在意 without longing (what longing grows toward). A bond below 0 is no care at all. */
export function caresBase(bond: number, warmth: number): number {
  if (!(bond >= 0)) return 0;
  const tier = CARE_BY_TIER[tierProgress(bond).index] ?? 0;
  return clamp01(tier + 0.2 * clampField("warmth", warmth));
}

/**
 * How much she cares about someone (在意), 0..1: the one definition, from the bond's tier,
 * how warm she is with them now and how much she misses them; never under the threshold for
 * someone tagged `owner`. At 好朋友 with the warmth the bond
 * makes normal it is just at `CARES_THRESHOLD`.
 */
export function cares(
  person: Pick<HeartPerson, "bond" | "warmth" | "longing"> & { tags?: readonly string[] },
): number {
  // The owner is always someone she cares about, however the numbers stand today.
  const owner = person.tags?.includes(OWNER_TAG) === true ? CARES_THRESHOLD : 0;
  if (!(person.bond >= 0)) return owner;
  return Math.max(
    owner,
    clamp01(caresBase(person.bond, person.warmth) + 0.15 * clampField("longing", person.longing)),
  );
}

// ---- familiarity ----------------------------------------------------------------------------

/**
 * How deep one line is (1..4), for familiarity: any line counts, one said to her counts more,
 * and a longer one more still (as the old `social` module had it).
 */
export function lineDepth(text: string, directed: boolean): number {
  const length = [...text.trim()].length;
  let depth = 1;
  if (directed) depth += 1;
  if (length >= 40) depth += 1;
  if (length >= 120) depth += 1;
  return depth;
}

/** Familiarity one line of `depth` adds, slowing toward 100 (only grows; the daily pass blurs it). */
export function familiarityGain(current: number, depth: number, rules: HeartPersonConfig): number {
  const room = clamp01(1 - current / 100);
  return Math.max(rules.familiarity_per_line, 0) * Math.max(depth, 0) * room;
}

/**
 * The tier the bond of `person` is held under for want of an anchor (H4): the next tier from 知心
 * up, never entered, without an anchor, with the bond at most `anchor_hold` (and a hair) below
 * it. `null` when it is not held.
 */
export function heldTier(
  person: Pick<HeartPerson, "bond" | "tier_floor" | "anchors">,
  rules: Pick<HeartPersonConfig, "anchor_hold">,
): { tier: number; label: string } | null {
  const next = tierProgress(person.bond).next;
  if (next === null || next.min < ANCHORED_TIER_MIN || next.min <= person.tier_floor) return null;
  if (hasAnchor(person, next.min)) return null;
  if (person.bond < next.min - rules.anchor_hold - 0.01) return null;
  return { tier: next.min, label: next.label };
}

/** The tier floors of `BOND_LADDER` that need an anchor (知心 and up). */
export const ANCHORED_TIERS: readonly number[] = BOND_LADDER.filter(
  (t) => t.min >= ANCHORED_TIER_MIN,
).map((t) => t.min);
