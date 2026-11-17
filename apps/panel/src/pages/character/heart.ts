// The heart's numbers as the people pages show them (docs/design/v5-heart.md §2.2, §2.11): their
// names, their scales, the words for why one moved and what happened, and the levels over time
// read back from a history page.

import { BOND_TIER_FLOORS } from "@miyoria/contracts/wire/tiers";
import type { HeartHistoryEntry, PersonEvidence, PersonProfile, PersonRow } from "@miyoria/contracts/api";

export type HeartField = HeartHistoryEntry["field"];
export type HeartCause = HeartHistoryEntry["cause"];

/** How a number runs: the bond, 0..100, 0..1, or -1..1 from a centre line. */
export type HeartScale = "bond" | "hundred" | "unit" | "signed";

export const FIELD: Record<HeartField, { label: string; scale: HeartScale; min: number; max: number }> = {
  bond: { label: "羈絆", scale: "bond", min: -100, max: 1000 },
  trust: { label: "信任", scale: "hundred", min: 0, max: 100 },
  familiarity: { label: "熟悉", scale: "hundred", min: 0, max: 100 },
  warmth: { label: "好感", scale: "signed", min: -1, max: 1 },
  respect: { label: "敬意", scale: "signed", min: -1, max: 1 },
  ease: { label: "自在", scale: "unit", min: 0, max: 1 },
  grudge: { label: "心結", scale: "unit", min: 0, max: 1 },
  longing: { label: "想念", scale: "unit", min: 0, max: 1 },
  rapport: { label: "默契", scale: "unit", min: 0, max: 1 },
};

/** Every number in the order the person page lists them. */
export const FIELDS: readonly HeartField[] = ["bond", "trust", "familiarity", "warmth", "respect", "ease", "grudge", "longing", "rapport"];

/** The eight beside the bond. */
export const VALUES: readonly Exclude<HeartField, "bond">[] = ["trust", "familiarity", "warmth", "respect", "ease", "grudge", "longing", "rapport"];

export const CAUSE: Record<HeartCause, string> = {
  feel: "對話中",
  reflect: "每晚反思",
  evidence: "互動",
  decay: "隨時間",
  admin: "手動調整",
  migrate: "舊紀錄",
};

export const EVIDENCE: Record<PersonEvidence["kind"], string> = {
  voice_together: "一起在語音",
  heard_song: "聽她唱歌",
  played_together: "一起玩",
  task_together: "一起做事",
  gift: "禮物",
  card: "卡片",
  deal_kept: "守約",
  deal_broken: "毀約",
};

const minus = (text: string) => text.replace("-", "−");

/** Digits a number of this scale is written with. */
const digits = (scale: HeartScale) => (scale === "unit" || scale === "signed" ? 2 : 0);

/** A value as the page writes it: whole numbers for the bond and 0..100, two places for the rest. */
export function fmtValue(field: HeartField, value: number): string {
  const { scale } = FIELD[field];
  const text = value.toFixed(digits(scale));
  if (scale === "signed" && value > 0) return `+${text}`;
  return minus(text);
}

/** A change, always signed: one place for the bond and 0..100, two for the rest. */
export function fmtDelta(field: HeartField, delta: number): string {
  const { scale } = FIELD[field];
  const n = Number(delta.toFixed(digits(scale) === 0 ? 1 : 2));
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `−${-n}`;
}

/** The tier as people read it: 「知心 II」, or the name alone from an older Core. */
export const tierText = (row: Pick<PersonRow, "tier" | "tier_label">): string => row.tier_label || row.tier;

/**
 * The tiers an anchor can be set for (知心 and up): every one they have reached, by the bond or the
 * highest tier ever entered, and the next tier when it is one of them.
 */
export function anchorTiers(profile: Pick<PersonProfile, "bond" | "tier_floor" | "next_tier">): { tier: number; name: string }[] {
  const reached = Math.max(profile.bond, profile.tier_floor);
  return BOND_TIER_FLOORS.filter(([tier, name]) => tier <= reached || name === profile.next_tier).map(([tier, name]) => ({ tier, name }));
}

/**
 * The levels of `fields` after each change, oldest first, from a history page (newest first):
 * each change's `value_after`, and before a number's first change in the page the value it moved
 * from. A number without changes holds `now` throughout.
 */
export function levels<F extends HeartField>(
  changes: readonly HeartHistoryEntry[],
  fields: readonly F[],
  now: Record<F, number>,
): { times: number[]; values: Record<F, number[]> } {
  const oldest = changes.filter((c): c is HeartHistoryEntry & { field: F } => fields.includes(c.field as F)).reverse();
  const at = {} as Record<F, number>;
  for (const f of fields) {
    const first = oldest.find((c) => c.field === f);
    at[f] = first ? first.value_after - first.delta : now[f];
  }
  const times: number[] = [];
  const values = Object.fromEntries(fields.map((f) => [f, [] as number[]])) as Record<F, number[]>;
  for (const c of oldest) {
    at[c.field] = c.value_after;
    times.push(Date.parse(c.at));
    for (const f of fields) values[f].push(at[f]);
  }
  return { times, values };
}
