// Night and death (docs/design/v4-plan.md §11.2 item 7): the pieces of `shelter` and `recover`
// that do not talk to the game. On 2026-11-08 she started at night in the sea, died five times,
// mostly at night, and lost her pickaxe with each death; nothing took her out of the dark or
// back to her things. Pure.

import type { Counts } from "./progress.js";
import type { Snapshot } from "./summary.js";

interface Pos {
  x: number;
  y: number;
  z: number;
}

/** Where she died and what she had on her (from the last snapshot before it). */
export interface Death {
  position: Pos;
  dimension: string | null;
  at: number;
  lost: Counts;
}

/** Items lie on the ground 5 minutes (while the chunk is loaded); a little slack for the walk. */
export const RECOVER_WINDOW_MS = 6 * 60_000;

/** Night for sheltering: dusk and night in the overworld (other dimensions have no night). */
export function isNight(s: Snapshot): boolean {
  if (s.dimension !== undefined && s.dimension !== "overworld") return false;
  return s.time_phase === "dusk" || s.time_phase === "night" || (s.time_phase === undefined && s.is_night === true);
}

/** A bed in her inventory, if she has one. */
export function bedOf(inventory: Counts | undefined): string | null {
  return Object.keys(inventory ?? {}).find((id) => id.endsWith("_bed")) ?? null;
}

/** Full blocks that make a roof (no sand or gravel: they fall on her). */
const ROOF_BLOCKS = [
  "cobblestone",
  "dirt",
  "cobbled_deepslate",
  "stone",
  "deepslate",
  "netherrack",
  "andesite",
  "diorite",
  "granite",
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
];

/** The roof block she has most of. */
export function roofBlock(inventory: Counts | undefined): string | null {
  let best: string | null = null;
  let most = 0;
  for (const id of ROOF_BLOCKS) {
    const n = inventory?.[id] ?? 0;
    if (n > most) [best, most] = [id, n];
  }
  return best;
}

/** How deep she digs in: feet three blocks down, so the roof goes where the ground was. */
export const DIG_DEPTH = 3;

/**
 * Where to look to put the roof on, standing at `feet` at the bottom of a 1×1 shaft: the side
 * faces of the four wall blocks one above her head. Right-clicking such a face with a block
 * puts it in the shaft above her head, like a player closing a hole from inside. Tried in turn
 * until one takes (a wall can be air: a cave).
 */
export function roofAims(feet: Pos): Pos[] {
  const y = feet.y + 2.5;
  return [
    { x: feet.x + 1, y, z: feet.z + 0.5 },
    { x: feet.x, y, z: feet.z + 0.5 },
    { x: feet.x + 0.5, y, z: feet.z + 1 },
    { x: feet.x + 0.5, y, z: feet.z },
  ];
}

/** Seconds since `death`, rounded. */
export function secsSince(death: Death, now: number): number {
  return Math.max(0, Math.round((now - death.at) / 1000));
}
