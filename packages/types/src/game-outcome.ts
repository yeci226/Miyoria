// What a game task's `done` says about progress (docs/design/v4-plan.md §11.2 item 3).
//
// A task that ended `done` only says the executor finished what it was asked; on 2026-11-08 a
// `stop`, an `explore` that ran out its time and a `mine` with nothing left in sight all ended
// `done`, and 33 of 41 "done" goals changed nothing. A game executor that can tell puts an
// `outcome` in the `done` event's `data`: whether the task got her anywhere (items gained, the
// place reached, something new in sight) and what her inventory gained or lost meanwhile. The
// director counts a `done` without progress as a failed attempt. `@miyoria/sdk` extensions write
// the same shape (they do not depend on this package).

import type { JsonObject, JsonValue } from "./json.js";

/** `data.outcome` of a game task's `done` event. */
export interface GameTaskOutcome {
  /** It changed something that counts for what it was for. */
  progressed: boolean;
  /** Items (id → count) her inventory gained / lost while it ran. */
  gained: Record<string, number>;
  lost: Record<string, number>;
  /** Her inventory when it ended, when the executor knows it. */
  inventory: Record<string, number> | null;
  /** Short neutral line on what changed (or why nothing did), for her record. */
  note: string;
}

function counts(value: JsonValue | undefined): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** The outcome in a `done` event's `data`, or `null` when the executor sent none. */
export function parseGameOutcome(data: JsonValue | undefined): GameTaskOutcome | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const raw = (data as JsonObject).outcome;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (typeof raw.progressed !== "boolean") return null;
  return {
    progressed: raw.progressed,
    gained: counts(raw.gained) ?? {},
    lost: counts(raw.lost) ?? {},
    inventory: counts(raw.inventory),
    note: typeof raw.note === "string" ? raw.note : "",
  };
}
