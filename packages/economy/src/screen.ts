// A paid message on the stream's screen (docs/design/economy.md §13): the text rules, the
// per-person cooldown read from the ledger, and the event the overlay shows.

import type { CoinEntry } from "@miyoria/store";
import type { ScreenEvent } from "./types.js";

/** Longest message, in characters. */
export const MAX_SCREEN_CHARS = 60;

/** The message trimmed and folded to one line, or `null` when it is empty or too long. */
export function screenText(text: string): string | null {
  const body = text.replace(/\s+/g, " ").trim();
  const length = [...body].length;
  return length >= 1 && length <= MAX_SCREEN_CHARS ? body : null;
}

/**
 * How many ms are left before this person may put another message up: from their
 * `screen_message` rows that were not refunded, `0` when none is within `cooldownMs`.
 * `rows` holds the `screen_message` and `refund` rows of that window.
 */
export function screenWait(rows: readonly CoinEntry[], cooldownMs: number, now: number): number {
  const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
  let wait = 0;
  for (const r of rows) {
    if (r.reason !== "screen_message" || refunded.has(r.id)) continue;
    wait = Math.max(wait, Date.parse(r.ts) + cooldownMs - now);
  }
  return wait;
}

/** Whole minutes to tell a person, at least one. */
export function waitMinutes(ms: number): number {
  return Math.max(Math.ceil(ms / 60_000), 1);
}

export function screenEvent(name: string, text: string): ScreenEvent {
  return { kind: "message", name, text, song: null };
}
