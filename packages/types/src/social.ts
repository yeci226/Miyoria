import type { SocialEventData } from "@miyoria/contracts/events";
import type { PersonId, ProfileId } from "./ids.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** How she currently feels about someone. Cheap to query. */
export interface Attitude {
  person: PersonId;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100 */
  familiarity: number;
  /** She ignores this person entirely (admin decision). */
  blocked: boolean;
  /** Short label for prompts and `/me`, e.g. `"陌生人"`, `"朋友"`. */
  label: string;
  /** How she addresses them, if set. */
  call_name: string | null;
  /** Tagged `owner` (missing from older producers). */
  owner?: boolean;
  /** Last display name of the person (untrusted; missing from older producers). */
  display_name?: string | null;
  /** How many of their lines she has seen (missing from older producers). */
  interactions?: number;
  /** When they last spoke (missing from older producers). */
  last_interaction?: Timestamp | null;
}

/** Provided by the social module; the agent uses it in attention. Must answer from memory. */
export interface SocialSignals {
  attitude(account: AccountRef): Attitude | null;
  /** The same by person (her emotions about people she knows only by id). */
  attitudeOf?(person: PersonId): Attitude | null;
}

export const SocialSignalsKey = serviceKey<SocialSignals>("SocialSignals");

/**
 * What the economy moves in a relationship besides what someone said: `treat` is a paid gift. It
 * is small, diminishes like any other event and counts toward the daily caps; `kind_cap` limits
 * what that kind alone gains per day on top of them.
 */
export interface RelationshipGain {
  kind: "treat";
  affinity: number;
  trust: number;
  /** Most this kind alone may gain per person per day (`null`: only the overall caps). */
  kind_cap: { affinity: number; trust: number } | null;
}

/** Provided by the heart (`HeartEffects`). Neither call publishes an emotion: the caller already did. */
export interface RelationshipEffects {
  /** Applies a small gain; returns what actually changed (the caps and the decay apply). */
  gain(
    person: PersonId,
    gain: RelationshipGain,
    now: number,
  ): Promise<{ affinity: number; trust: number }>;
}

export const RelationshipEffectsKey = serviceKey<RelationshipEffects>("RelationshipEffects");

/** Payload of `social.event` (contract: `SocialEventSchema` in @miyoria/contracts/events). */
export type SocialEvent = SocialEventData;

/** Global emotional state of the active profile. */
export interface Mood {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 0..1 */
  energy: number;
}

/** Provided by the mood module. */
export interface MoodSignals {
  mood(): Mood;
}

export const MoodSignalsKey = serviceKey<MoodSignals>("MoodSignals");

/** Something she promised or wants to bring up later ("你明天考試考得怎樣?"). */
export interface Followup {
  id: string;
  profile: ProfileId;
  person: PersonId | null;
  /** Where it came up; follow up there (or wherever the person shows up). */
  context: ContextKey | null;
  about: string;
  /** Earliest time it makes sense to bring it up. */
  due: Timestamp;
}

/** Provided by the memory module; used by initiative. */
export interface FollowupSource {
  /** Followups due at `now` (not yet done). */
  due(profile: ProfileId, now: Timestamp): Promise<Followup[]>;
  markDone(id: string): Promise<void>;
}

export const FollowupSourceKey = serviceKey<FollowupSource>("FollowupSource");
