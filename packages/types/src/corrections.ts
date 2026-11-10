// What the code changed of her output after the model wrote it, counted (docs/design/v4-plan.md
// §2.5, §4.5; the table is docs/design/v4-patches.md).
//
// Each of these was added after a real incident, and each treats a symptom V4 changes at the
// root. They are retired one at a time, and only once they are measured: every turn that reached
// the model says in its outcome which of them fired and how often, never what she said. The
// per-day metrics route (`GET /api/turns/metrics`) adds them up beside the turn totals.

import type { TurnOutcomeRecord } from "./turn.js";

export const CORRECTION_KINDS = [
  /** A line the gate held until the stream ended (it claimed something, or one before it did). */
  "claim_held",
  /** A line that said something is done waited for its result; 「開始了,等我一下。」 went first. */
  "claim_parked",
  /** A claim with no action behind it: its line was dropped. */
  "claim_dropped",
  /** A claim nothing backs: she was told so and asked once more (`claimReminder`). */
  "claim_reask",
  /** A tool written as text: she was asked once more to call it (`toolTextReminder`). */
  "tool_text_reask",
  /** A tool written as text and never called became a commitment. */
  "tool_text_commit",
  /** A promise in her words ("我等一下進語音") with no call became a commitment. */
  "promise_commit",
  /** A line of the reply was her reasoning: the screen dropped it (and the rest of the reply). */
  "leak_dropped",
  /** A fixed wait line went out for an output that acts and says nothing. */
  "wait_line",
  /** A fixed line went out because the call failed or gave nothing. */
  "fallback_line",
  /** A long tool result came with the reminder to keep a note of it. */
  "keep_hint",
  /** An argument of a tool call was changed or dropped (`groundArgs`). */
  "ground_args",
  /** A sentence she had said in an earlier round of the tool loop was cut from her line. */
  "repeat_cut",
  /** An output that only kept a note was called back by a result turn to say something. */
  "noted_callback",
  /** A line that was a note to herself about how to answer was left out (`isSelfTalk`). */
  "self_talk_cut",
  /** A plain "don't play <game>" she did not write down was written as a rule for her. */
  "prohibition_written",
] as const;

export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/** How often each correction fired in one turn; kinds that did not fire are left out. */
export type CorrectionCounts = Partial<Record<CorrectionKind, number>>;

/**
 * The outcome of a turn with its corrections. `corrections` is there for every turn that reached
 * the model (`{}` when nothing fired) and missing for the rest, so "fired on N% of replies" is
 * counted over the turns that were measured.
 */
export interface CountedOutcome extends TurnOutcomeRecord {
  corrections?: CorrectionCounts;
}

export function isCorrectionKind(kind: string): kind is CorrectionKind {
  return (CORRECTION_KINDS as readonly string[]).includes(kind);
}

/** The counts of a record, when it carries them (anything malformed is left out). */
export function correctionsOf(record: unknown): CorrectionCounts | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = (record as { corrections?: unknown }).corrections;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: CorrectionCounts = {};
  for (const [kind, n] of Object.entries(raw)) {
    if (isCorrectionKind(kind) && typeof n === "number" && Number.isFinite(n) && n > 0) {
      out[kind] = Math.floor(n);
    }
  }
  return out;
}
