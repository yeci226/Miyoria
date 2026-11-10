// What a task changed (docs/design/v4-plan.md §11.2 item 3). Every body task is measured: her
// inventory before and after (plus what `item_picked` reported meanwhile), how far she moved,
// what new she saw. The result goes into the `done` event's `data.outcome` (the core's
// `GameTaskOutcome`), and the director counts a `done` without progress as a failed attempt.
//
// On 2026-11-08, 33 of 41 "done" goals changed nothing: `stop`, `explore` running out its time
// over open sea, `mine` with nothing left in sight, "already have a wooden sword". Pure.

import { zh } from "./names.js";
import type { Snapshot } from "./summary.js";

export type Counts = Record<string, number>;

/** `data.outcome` of a `done` (the core's `GameTaskOutcome`). */
export interface Outcome {
  progressed: boolean;
  gained: Counts;
  lost: Counts;
  inventory: Counts | null;
  note: string;
}

/** Goals whose progress is what her inventory gained. */
export const ITEM_GOALS = new Set(["mine", "farm", "obtain", "get", "craft", "smelt", "hunt", "recover"]);
/** Goals that got her somewhere when they end `done` (reached, followed, built). */
export const PLACE_GOALS = new Set(["goto", "follow", "build"]);

export function inventoryDelta(before: Counts, after: Counts): { gained: Counts; lost: Counts } {
  const gained: Counts = {};
  const lost: Counts = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[id] ?? 0) - (before[id] ?? 0);
    if (d > 0) gained[id] = d;
    else if (d < 0) lost[id] = -d;
  }
  return { gained, lost };
}

/** `生牛肉×2、皮革×1`. */
export function itemsText(c: Counts): string {
  return Object.entries(c)
    .map(([id, n]) => `${zh(id)}×${n}`)
    .join("、");
}

function distance(a: Snapshot | null, b: Snapshot | null): number | null {
  const p = a?.block_position ?? a?.position;
  const q = b?.block_position ?? b?.position;
  if (!p || !q) return null;
  return Math.round(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
}

/**
 * The outcome of a `goal` task from the snapshots before and after it and what was picked up
 * meanwhile. `met`: the task says its target is in her inventory (an `obtain` of something she
 * has: said in the note, still no progress). `null` when it cannot tell (no inventory seen) or
 * the goal measures itself (explore, shelter).
 */
export function outcomeOf(
  goal: string,
  before: Snapshot | null,
  after: Snapshot | null,
  picked: Counts = {},
  met = false,
): Outcome | null {
  const b = before?.inventory;
  const a = after?.inventory;
  if (!b || !a) return null;
  const { gained, lost } = inventoryDelta(b, a);
  // A pickup the inventory no longer shows (eaten, crafted away) still happened.
  for (const [id, n] of Object.entries(picked)) if ((gained[id] ?? 0) < n) gained[id] = n;
  const got = Object.keys(gained).length > 0;
  if (ITEM_GOALS.has(goal)) {
    // Asking for what she already has is no progress either (2026-11-08: a wooden sword, four
    // times); the goal it was for is met all the same, and the director sees that.
    const note = got ? `+${itemsText(gained)}` : met ? "背包裡本來就有了,不用再拿" : "背包沒有變化";
    return { progressed: got, gained, lost, inventory: a, note };
  }
  if (PLACE_GOALS.has(goal)) {
    const moved = distance(before, after);
    const parts = [moved === null ? "" : `移動了 ${moved} 格`, got ? `+${itemsText(gained)}` : ""];
    return { progressed: true, gained, lost, inventory: a, note: parts.filter(Boolean).join(",") };
  }
  return null;
}

/** What she sees, as ids: notable blocks, creatures and the biome (what is new to explore). */
export function sightings(s: Snapshot | null): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  for (const b of s.nearby_blocks ?? []) out.add(b.block);
  for (const e of s.nearby_entities ?? []) if (e.type !== "player") out.add(e.type);
  if (s.biome) out.add(`biome:${s.biome}`);
  return out;
}

/** `橡木原木、牛、平原`. */
export function sightingsText(ids: Iterable<string>, max = 6): string {
  return [...ids]
    .slice(0, max)
    .map((id) => zh(id.startsWith("biome:") ? id.slice("biome:".length) : id))
    .join("、");
}

/**
 * The outcome of an `explore`: progress is something she had not seen when it started (a new
 * kind of block or creature, another biome), or what she was looking for (`found`). Running out
 * its time over the same sea is not.
 */
export function exploreOutcome(
  before: Snapshot | null,
  after: Snapshot | null,
  newSights: Set<string>,
  found: string | null,
): Outcome {
  const inventory = after?.inventory ?? null;
  const delta = before?.inventory && inventory ? inventoryDelta(before.inventory, inventory) : { gained: {}, lost: {} };
  const moved = distance(before, after);
  const where = moved === null ? "" : `,移動了 ${moved} 格`;
  if (found !== null) {
    return { progressed: true, ...delta, inventory, note: `找到${zh(found)}了${where}` };
  }
  if (newSights.size > 0) {
    return { progressed: true, ...delta, inventory, note: `看到新的:${sightingsText(newSights)}${where}` };
  }
  return { progressed: false, ...delta, inventory, note: `沒看到新的東西${where}(換個方向 goto 遠一點的座標)` };
}
