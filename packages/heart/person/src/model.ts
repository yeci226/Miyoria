// One person as the heart holds them (docs/design/v5-heart.md §2.2): the shape of a
// `heart_person` row. Nine numbers, her words about them, the tier anchors, when she last saw
// them, and what the migration carried over that has no new home.

import type { HeartChangedData } from "@miyoria/store";
import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  type JsonObject,
  type PersonId,
  type Timestamp,
} from "@miyoria/types";

/** A number of a person's row. */
export type HeartField = HeartChangedData["field"];

/** Why a number moved. */
export type HeartCause = HeartChangedData["cause"];

/** Every number, in the order the row lists them. The contract's enum has the same list. */
export const HEART_FIELDS = [
  "bond",
  "trust",
  "familiarity",
  "warmth",
  "respect",
  "ease",
  "grudge",
  "longing",
  "rapport",
] as const satisfies readonly HeartField[];

/** Lowest and highest value of each number. */
export const FIELD_RANGE: Readonly<Record<HeartField, readonly [number, number]>> = {
  bond: [AFFINITY_MIN, AFFINITY_MAX],
  trust: [0, 100],
  familiarity: [0, 100],
  warmth: [-1, 1],
  respect: [-1, 1],
  ease: [0, 1],
  grudge: [0, 1],
  longing: [0, 1],
  rapport: [0, 1],
};

/**
 * The numbers she may propose a change to in `feel` (and her reflection may change). Familiarity
 * grows by lines and longing by time, so neither is hers to propose.
 */
export const PROPOSAL_FIELDS = [
  "bond",
  "trust",
  "warmth",
  "respect",
  "ease",
  "grudge",
  "rapport",
] as const satisfies readonly HeartField[];
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];

export function isProposalField(field: string): field is ProposalField {
  return (PROPOSAL_FIELDS as readonly string[]).includes(field);
}

export type Direction = "up" | "down";

/** The direction that is good for the two of them: up, except for a grudge. */
export function goodDirection(field: HeartField): Direction {
  return field === "grudge" ? "down" : "up";
}

/** Who set a tier anchor: her nightly reflection, the owner, or the migration (grandfathered). */
export type AnchorSource = "reflect" | "admin" | "migrate";

/** The shared memory a tier rests on (H4). */
export interface TierAnchor {
  /** The lowest bond of the tier it anchors (a `BOND_LADDER` tier from 知心 up). */
  tier: number;
  /** The note line she chose (`notes_lines.id`); `null`: none (a migrated tier). */
  note_ref: string | null;
  /** The words of that memory as she quoted them; `""` for a migrated tier. */
  quote: string;
  at: Timestamp;
  by: AnchorSource;
}

/** Tags with a meaning to the rules. Others are free. */
export const OWNER_TAG = "owner";
export const BLOCKED_TAG = "blocked";

/** One person, as a `heart_person` row. */
export interface HeartPerson {
  /** Identity's `persons.id`. */
  person_id: PersonId;
  /** -100..1000: how close they are (the ring). */
  bond: number;
  /** 0..100: do they keep their word and her secrets. */
  trust: number;
  /** 0..100: how much she knows of them and has shared. */
  familiarity: number;
  /** -1..1: how warm she is with them right now. */
  warmth: number;
  /** -1..1: what she thinks of their skill, kindness and taste. */
  respect: number;
  /** 0..1: how relaxed she is with them (how much the tsundere hides). */
  ease: number;
  /** 0..1: a hurt not talked through. */
  grudge: number;
  /** 0..1: how much she misses them. */
  longing: number;
  /** 0..1: how well their banter and jokes click. */
  rapport: number;
  /** How she acts with them, in her words. */
  stance: string;
  /** What she thinks of them. */
  impression: string;
  /** Things not yet talked through. */
  unfinished: string;
  /** Jokes they share. */
  jokes: string;
  /** What she does not like about them. */
  dislikes: string;
  /** The one line shown to them on the member page; `null`: none yet. */
  public_feeling: string | null;
  /** What she calls them; `null`: their name. */
  call_name: string | null;
  /** `owner`, `blocked` and free tags. */
  tags: string[];
  /** The lowest bond of the highest tier ever entered (0 before 朋友): decay stops there. */
  tier_floor: number;
  anchors: TierAnchor[];
  interactions: number;
  /** Last time they talked with her (bond decay counts from here). */
  last_interaction: Timestamp | null;
  /** Last time she saw them say anything anywhere (longing counts from here). */
  last_seen: Timestamp | null;
  /** Last time they spent time with her (talked to her, were in voice with her). */
  last_together: Timestamp | null;
  /** Her local day the daily pass last ran for them; `null`: never. */
  decayed_on: number | null;
  /** What the migration carried over that has no column (the old `romance`, kept, never read: H5). */
  legacy: JsonObject;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Someone she has just met. */
export function newPerson(person: PersonId, at: Timestamp, defaultTrust = 10): HeartPerson {
  return {
    person_id: person,
    bond: 0,
    trust: defaultTrust,
    familiarity: 0,
    warmth: 0,
    respect: 0,
    ease: 0,
    grudge: 0,
    longing: 0,
    rapport: 0,
    stance: "",
    impression: "",
    unfinished: "",
    jokes: "",
    dislikes: "",
    public_feeling: null,
    call_name: null,
    tags: [],
    tier_floor: 0,
    anchors: [],
    interactions: 0,
    last_interaction: null,
    last_seen: null,
    last_together: null,
    decayed_on: null,
    legacy: {},
    created_at: at,
    updated_at: at,
  };
}

/** `value` inside the range of `field` (a non-finite value is the range's 0, or its low end). */
export function clampField(field: HeartField, value: number): number {
  const [lo, hi] = FIELD_RANGE[field];
  if (!Number.isFinite(value)) return Math.min(Math.max(0, lo), hi);
  return Math.min(Math.max(value, lo), hi);
}

export function hasTag(person: Pick<HeartPerson, "tags">, tag: string): boolean {
  return person.tags.includes(tag);
}

export function hasAnchor(person: Pick<HeartPerson, "anchors">, tier: number): boolean {
  return person.anchors.some((a) => a.tier === tier);
}
