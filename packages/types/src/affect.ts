// Affect and People (docs/design/v2-architecture.md §3.1, §3.6): her feelings with one writer.
//
// Two layers here: drives (hours, pure homeostasis) and emotions (minutes, rule events and her
// `feel`). How she feels about each person is the heart's (`heart.ts`, `heart_person`). Mood is not
// stored: it is derived from the layers (plus the time-of-day energy curve).
//
// The only inputs to emotions are *events* (`AffectEvent` rule events and `AppraisalEvent`s);
// nobody writes absolute numbers, and the program turns events into numbers (habituation,
// mutual inhibition, a stir budget, decay toward the temperament's baseline). `<emo:…>` tags are
// expression only and never feed back. Plan / mind never write emotions.
//
// The existing `Drives`, `DriveName`, `EmotionName`, `PersonEmotionName`, `EmotionReading` and
// `ShownEmotion` (self.ts) and `Mood` (social.ts) are reused as they are.

import type { AffectEventData, AffectSnapshotData } from "@miyoria/contracts/events";
import {
  BOND_TIER_FLOORS,
  RELATIONSHIP_LABELS,
  type RelationshipLabel,
  TIER_STAGE_NUMERALS,
  type TierStage,
} from "@miyoria/contracts/wire";
import { AFFINITY_MAX, AFFINITY_MIN, clampAffinity } from "./bond.js";
import type { Handle } from "./handle.js";
import type { PersonId } from "./ids.js";
import type { ContextKey } from "./platform.js";
import type { DriveName, EmotionName, EmotionReading } from "./self.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

// ---- appraisal ------------------------------------------------------------------------------

export type AppraisalStrength = "weak" | "medium" | "strong";

/** Base stir of each strength, before her temperament's gain and habituation. */
export const APPRAISAL_STRENGTH: Readonly<Record<AppraisalStrength, number>> = {
  weak: 0.1,
  medium: 0.2,
  strong: 0.35,
};

/**
 * One appraisal (what the Appraise call outputs, at most 3 per interaction):
 * `{"emotion": "shy", "strength": "weak", "toward": "Owen", "cause": "他說想聽我唱歌"}`.
 */
export interface AppraisalEvent {
  emotion: EmotionName;
  strength: AppraisalStrength;
  /** Who it is about (a handle, never a `u1` code); `null`: nobody in particular. */
  toward: Handle | null;
  /** What caused it, short zh-TW in her words (data in prompts: may quote people). */
  cause: string;
}

/** Who produced an affect input. */
export type AffectSource = "rule" | "appraise" | "feel" | "reflect" | "drive" | "panel";

/**
 * Rule events (cheap, immediate), published by whoever sees them as `Events.AffectEvent`; the
 * affect module maps each kind to emotions (the §3.6 table).
 */
export const AFFECT_EVENT_KINDS = [
  /** Someone praised her directly. */
  "praised",
  /** Someone she cares about came online / joined voice. */
  "cared_arrived",
  /** She opened a topic and nobody picked it up (the Arbiter's ledger). */
  "topic_ignored",
  /** She finished a song. */
  "song_finished",
  /** People reacted to her song. */
  "song_applauded",
  /** Her speech was cut off / she was talked over. */
  "interrupted",
  /** Someone she addressed ignored her. */
  "ignored",
  /** Someone she cares about is warm with someone else while leaving her out. */
  "cared_close_with_other",
  /** A task / activity of hers succeeded or failed (game goal, going live). */
  "task_succeeded",
  "task_failed",
  /** She won / lost / died in a game. */
  "game_won",
  "game_lost",
] as const;

export type AffectEventKind = (typeof AFFECT_EVENT_KINDS)[number];

/** A rule event for her emotions (contract: `AffectEventSchema` in @miyoria/contracts/events). */
export type AffectEvent = AffectEventData;

/** A promise made to her that was kept or broken: it counts toward the person. */
export interface AppraisedPromise {
  toward: Handle;
  kept: boolean;
  cause: string;
}

/** A batch of appraisals for the affect module (`AffectState.appraise`). */
export interface AffectInput {
  source: AffectSource;
  events: AppraisalEvent[];
  /** Promises she saw kept or broken (at most 2 count). */
  promises?: AppraisedPromise[];
  context: ContextKey | null;
  at: Timestamp;
}

/** What one appraisal did after the dynamics (for the journal and the panel). */
export interface AppliedAppraisal {
  emotion: EmotionName;
  toward: PersonId | null;
  /** The stir actually applied (after gain, habituation and the budget). */
  amount: number;
  /** `0.5ⁿ` habituation factor applied (1 = first time). */
  habituation: number;
  /** Emotions it pushed down (mutual inhibition), name: amount. */
  inhibited: Partial<Record<EmotionName, number>>;
}

// ---- people ---------------------------------------------------------------------------------

/**
 * The one relationship scale (every prompt, `/me` and the panel use this). The list itself is the
 * wire contract's (`@miyoria/contracts/wire`, so the API's enum is made from it); this is where
 * everyone else reads it.
 */
export { RELATIONSHIP_LABELS, type RelationshipLabel, TIER_STAGE_NUMERALS, type TierStage };

/** The tiers past 摯友, highest first: `[lowest bond, label]`. */
export const BOND_TIERS: readonly (readonly [number, RelationshipLabel])[] = [
  ...BOND_TIER_FLOORS,
].reverse();

/** One line naming the whole bond scale, for a prompt that shows levels. */
export const BOND_SCALE_LINE =
  "羈絆等級 -100~1000:-50 以下很討厭、-15 以下討厭、15 朋友、45 好朋友、75 摯友(滿 100 後繼續疊加)、" +
  [...BOND_TIERS]
    .reverse()
    .map(([lv, name]) => `${lv} ${name}`)
    .join("、");

/** What the tier name depends on. */
export interface RelationshipNumbers {
  /** The bond, -100..1000. */
  affinity: number;
  /** `false`: she has not met them yet (no row, or nothing done with her): 陌生人. Default `true`. */
  met?: boolean;
}

/**
 * The tier name shown for someone, everywhere (the member page, `/me profile`, the people API, the
 * prompt, the card): the bond-only ladder (`BOND_LADDER`, `tierProgress`), 討厭 and 很討厭 below
 * it, 陌生人 for someone she has not met. Familiarity no longer gates a tier: from 知心 up the
 * anchors do (H4).
 */
export function relationshipLabel(rel: RelationshipNumbers): RelationshipLabel {
  if (rel.met === false) return "陌生人";
  const a = clampAffinity(rel.affinity);
  if (a <= -50) return "很討厭";
  if (a <= -15) return "討厭";
  return tierProgress(a).tier.label;
}

/** Where plain affinity ends and bond stacking begins. */
export const AFFINITY_FULL = 100;
export {
  AFFINITY_MAX,
  AFFINITY_MIN,
  BOND_BAND_WORDS,
  BOND_BANDS,
  bondBand,
  clampAffinity,
  RING_LAP,
  RING_LAPS,
  type RingPosition,
  ringOf,
} from "./bond.js";
export const AFFINITY_LEVEL_MIN = AFFINITY_MIN;
export const AFFINITY_LEVEL_MAX = AFFINITY_MAX;
/** Levels per step up to 100: crossing into another step is when she may re-decide her stance. */
export const AFFINITY_LEVEL_STEP = 5;

/**
 * Her level with someone (her 羈絆 level): the affinity itself as a whole number (truncated
 * toward zero), -100..1000, one level per point. A non-finite input is level 0. What a level
 * means is hers to decide (`PersonCard.stance`), nothing here prescribes behaviour.
 */
export function affinityLevel(affinity: number): number {
  if (!Number.isFinite(affinity)) return 0;
  const level = Math.trunc(affinity) + 0; // `+ 0`: no negative zero
  return Math.min(Math.max(level, AFFINITY_LEVEL_MIN), AFFINITY_LEVEL_MAX);
}

// ---- the ladder, the ring and the bands (docs/design/v5-heart.md §2.7, H1–H4) ---------------

/** One tier of the bond ladder: the lowest bond in it and its name. */
export interface BondTier {
  min: number;
  label: RelationshipLabel;
}

/**
 * The tiers a bond of 0 or more climbs through, lowest first, by bond alone: the one ladder every
 * tier name comes from (`relationshipLabel`). From 知心 up they are `BOND_TIERS`.
 */
export const BOND_LADDER: readonly BondTier[] = [
  { min: 0, label: "認識" },
  { min: 15, label: "朋友" },
  { min: 45, label: "好朋友" },
  { min: 75, label: "摯友" },
  ...[...BOND_TIERS].reverse().map(([min, label]) => ({ min, label })),
];

/** From this tier up, entering a tier needs a shared memory as its anchor (H4). */
export const ANCHORED_TIER_MIN = 120;

/** Where a bond sits on the ladder. */
export interface TierProgress {
  tier: BondTier;
  /** Its place in `BOND_LADDER`. */
  index: number;
  /** The tier above; `null` at the top. */
  next: BondTier | null;
  /** 0..1 of the way from this tier's lowest bond to the next one's (1 at the top, 0 below 0). */
  progress: number;
  /**
   * Which third of the tier's span the bond is in (H10): 1, 2 or 3; `null` at the top, which has
   * none. A bond below 0 is stage 1 of the first tier. Derived, never stored.
   */
  stage: TierStage | null;
}

/**
 * The tier of `bond`, how far into it and what comes next. A bond below 0 is not on the ladder:
 * it reads as the first tier with no progress (the ring shows it with `RingPosition.below`).
 */
export function tierProgress(bond: number): TierProgress {
  const b = clampAffinity(bond);
  let index = 0;
  for (let i = 0; i < BOND_LADDER.length; i++) {
    if (b >= (BOND_LADDER[i] as BondTier).min) index = i;
  }
  const tier = BOND_LADDER[index] as BondTier;
  const next = BOND_LADDER[index + 1] ?? null;
  const progress =
    next === null
      ? 1
      : b <= 0
        ? 0
        : Math.min(Math.max((b - tier.min) / (next.min - tier.min), 0), 1);
  return { tier, index, next, progress, stage: stageIn(b, tier, next) };
}

/** The stage of `bond` in `tier` (equal thirds of its span up to `next`); `null` with no next. */
function stageIn(bond: number, tier: BondTier, next: BondTier | null): TierStage | null {
  if (next === null) return null;
  // A hair over: a bond at a third computed in floating point (870 + 2 * 130 / 3) is in the next.
  const into = Math.max(bond - tier.min, 0) * 3 + 1e-9;
  const span = next.min - tier.min;
  if (into < span) return 1;
  if (into < span * 2) return 2;
  return 3;
}

/** The name of a tier with its stage, as people read it: 「知心 II」; the bare name without one. */
export function tierLabel(tier: RelationshipLabel, stage: TierStage | null): string {
  return stage === null ? tier : `${tier} ${TIER_STAGE_NUMERALS[stage - 1]}`;
}

/** Where someone stands, as a person reads it (H10). */
export interface TierStanding {
  /** The tier's bare name (what code keys on: tones, her lines, the poses). */
  tier: RelationshipLabel;
  /** Its stage; `null` for 陌生人, 討厭, 很討厭 and 永恆羈絆. */
  stage: TierStage | null;
  /** Name and stage, 「知心 II」: what a person reads. */
  label: string;
  /** The next step: the next stage, or the next tier's first after III; `null`: none. */
  next_label: string | null;
}

/**
 * The tier of `rel` with its stage (`relationshipLabel` plus `tierProgress`): the next step is the
 * next stage, or after III the next tier (its stage I, or 永恆羈絆, which has none); below the
 * ladder it is 認識 I, for someone not met yet there is none.
 */
export function tierStanding(rel: RelationshipNumbers): TierStanding {
  const tier = relationshipLabel(rel);
  if (rel.met === false) return { tier, stage: null, label: tier, next_label: null };
  const place = tierProgress(rel.affinity);
  const first = tierLabel(BOND_LADDER[0]?.label ?? "認識", 1);
  if (tier !== place.tier.label) return { tier, stage: null, label: tier, next_label: first };
  const stage = place.stage;
  let next: string | null = null;
  if (stage !== null && stage < 3) next = tierLabel(tier, (stage + 1) as TierStage);
  else if (place.next !== null) {
    const after = tierProgress(place.next.min);
    next = tierLabel(place.next.label, after.stage === null ? null : 1);
  }
  return { tier, stage, label: tierLabel(tier, stage), next_label: next };
}

/** The lowest bond of the tier `bond` is in (0 for a bond below 0). */
export function tierFloorOf(bond: number): number {
  return tierProgress(bond).tier.min;
}

/** The tiers whose lowest bond lies in `(from, to]`, lowest first: what a rise from `from` to `to` enters. */
export function tiersEntered(from: number, to: number): BondTier[] {
  const a = clampAffinity(from);
  const b = clampAffinity(to);
  return BOND_LADDER.filter((t) => t.min > a && t.min <= b);
}

/** The member-facing words for trust (0..100), never the number. */
export function trustBand(value: number): string {
  if (value < 15) return "還不信任";
  if (value < 40) return "有點信任";
  if (value < 70) return "信任";
  return "很信任";
}

/** The member-facing words for familiarity (0..100), never the number. */
export function familiarityBand(value: number): string {
  if (value < 3) return "陌生";
  if (value < 10) return "見過幾次";
  if (value < 30) return "有點熟";
  if (value < 60) return "熟";
  return "很熟";
}

// ---- snapshot and effects -------------------------------------------------------------------

/**
 * Weighted behaviour offsets her feelings imply (§3.6 table), visible on the panel. They are
 * biases, not switches: Plan decides, the Arbiter enforces the floors.
 */
export interface AffectBiases {
  /** Added to her talkativeness (-1..1). */
  talkativeness: number;
  /** Added to her willingness to start things (-1..1). */
  initiative: number;
  /** Per wish (`chat_with`, `play`, `stream`, `rest`, `sing`): weight 0..1 and why. */
  wants: {
    want: string;
    weight: number;
    person: Handle | null;
    why: string;
    /** The emotion behind it, when one is (a drive otherwise). */
    from?: EmotionName;
  }[];
}

/** Her state of feeling (contract: `AffectSnapshotSchema` in @miyoria/contracts/events). */
export type AffectSnapshot = AffectSnapshotData;

/** Provided by the affect owner (`self`). Reads answer from memory. */
export interface AffectState {
  snapshot(): AffectSnapshot;
  /** What she feels, strongest first, at or above `min`. */
  emotions(min?: number): EmotionReading[];
  /**
   * The only write path for what an interaction meant: events in, numbers computed here. Her
   * `feel` block is the one that calls it for a conversation (source `feel`).
   */
  appraise(input: AffectInput): AppliedAppraisal[];
  /** A drive was satisfied (`amount` < 0) or frustrated (> 0) by something she did. */
  satisfy(drive: DriveName, amount: number, reason: string): void;

  /**
   * The canonical prompt text of her mood (`renderAffectMood` of the snapshot): the mood line
   * and her strongest 2-3 emotions. Optional so test doubles need not implement it.
   */
  renderMood?(): string;
}

export const AffectStateKey = serviceKey<AffectState>("AffectState");
