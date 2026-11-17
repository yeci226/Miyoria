// How old a recap is (v4 §5.7). The recap of a conversation is folded every few lines or after a
// pause; when folding is behind (a failed fold, a long burst of talk), the prompt showed the old
// recap as if it were current and she had no way to tell. This says up to when it was written
// and, when later lines are known, that there are some.

import type { ConversationState, Timestamp } from "@miyoria/types";

/** Minutes after which a recap says how old it is even when nothing came after it. */
export const RECAP_STALE_MINS = 30;

/** `HH:MM` in local time (`offsetMinutes` east of UTC). */
function hhmm(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * The note that goes after a recap: `(寫到 14:05 為止,之後的話在對話紀錄裡)` when lines came
 * after what was folded, `(寫到 14:05 為止)` when it is older than `RECAP_STALE_MINS`, `""` when
 * it is current (or nothing was folded yet).
 */
export function recapAgeNote(
  state: Pick<ConversationState, "folded_up_to">,
  now: Timestamp,
  options: { lastLineAt?: Timestamp | null; offsetMinutes?: number } = {},
): string {
  const folded = state.folded_up_to;
  if (folded === null) return "";
  const foldedMs = Date.parse(folded.ts);
  const offset = options.offsetMinutes ?? 8 * 60;
  const last = options.lastLineAt ? Date.parse(options.lastLineAt) : null;
  if (last !== null && last > foldedMs) {
    return `(寫到 ${hhmm(foldedMs, offset)} 為止,之後的話在對話紀錄裡)`;
  }
  if (Date.parse(now) - foldedMs >= RECAP_STALE_MINS * 60_000) {
    return `(寫到 ${hhmm(foldedMs, offset)} 為止)`;
  }
  return "";
}
