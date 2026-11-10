// Turn ownership (docs/design/v2-architecture.md §3.9): every turn knows whom it answers, new
// input cannot kill it unconditionally, and every turn ends with a recorded outcome.
//
// * `TurnFocus`: who addressed her (`addressed_by`), the messages the reply is for (`focus`:
//   the ones that called her plus the same person's follow-ups) and the rest (`background`).
//   The prompt's "要回的訊息" block shows only `focus`; the reply quotes `focus[0]`.
// * `inputDisposition`: the one cancellation rule (the §3.9 table), shared by the agent's
//   coordinator and anything else that has to tell "worth stopping for" from chatter.
// * `TurnFocusView` (provided by the agent) lets voice barge-in ask, on its hot path, whom the
//   turn in flight is for. Focus changes are also published as `TURN_FOCUS_TOPIC`.
// * `TurnOutcomeRecord` (`TURN_OUTCOME_TOPIC`): sent / silence / cancelled (by whom) / error,
//   for the decision trace ("決定回了但沒發" must have a reason).
//
// Messages are `MessageRef`s; a voice utterance is `{context, id: utterance.id}` (that is how
// the agent already wraps utterances as messages).

import type { Handle } from "./handle.js";
import type { TurnId } from "./ids.js";
import type { AccountRef, ContextKey, MessageRef } from "./platform.js";
import type { ReasoningLevel } from "./reasoning.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Why a turn exists. */
export type TurnReason =
  /** Someone @-mentioned her, said her name, or DMed her. */
  | "addressed"
  /** Someone replied to what she just said. */
  | "reply_to_her"
  /** Nobody addressed her; she may join in. */
  | "ambient"
  /** She starts it herself (an accepted impulse / intent / initiative). */
  | "initiative"
  /** She reacts to a notice (a task outcome). */
  | "notice";

/**
 * `debounce`: collecting input; `generating`: the model is writing; `speaking`: voice, her
 * speech of this turn is queued or playing; `done`: over.
 */
export type TurnPhase = "debounce" | "generating" | "speaking" | "done";

export interface TurnFocus {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  phase: TurnPhase;
  /** The people the reply is for (handles, in the order they addressed her). */
  addressed_by: Handle[];
  /** Their accounts, same order (what voice barge-in matches speakers against). */
  addressed_accounts: AccountRef[];
  /** The messages the reply answers, oldest first. */
  focus: MessageRef[];
  /** Other input of the turn: context only, never "what to answer". */
  background: MessageRef[];
  /** How often the turn was restarted for new focus input (at most `MAX_TURN_RESTARTS`). */
  restarts: number;
  started_at: Timestamp;
  updated_at: Timestamp;
}

/** Payload: `TurnFocus`, whenever a turn's focus or phase changes. */
export const TURN_FOCUS_TOPIC = "agent.turn.focus";

/** Provided by the agent. Answers from memory (safe on the voice hot path). */
export interface TurnFocusView {
  /** The turn in flight (or still speaking) in `context`, if any. */
  current(context: ContextKey): TurnFocus | null;
  /** Every turn in flight. */
  all(): TurnFocus[];
}

export const TurnFocusViewKey = serviceKey<TurnFocusView>("TurnFocusView");

// ---- cancellation ---------------------------------------------------------------------------

/** A turn restarts for new focus input at most this often (text); voice never restarts. */
export const MAX_TURN_RESTARTS = 1;

/** Input with at most this many characters (letters, CJK; no spaces / punctuation) is short. */
export const SHORT_REPLY_MAX_CHARS = 4;

const NOISE = /[\s\p{P}\p{S}]/gu;

/**
 * Backchannel-sized input (「對」「嗯」「哈哈」「www」「好啊好啊」): at most
 * `SHORT_REPLY_MAX_CHARS` meaningful characters, or only one or two distinct ones repeated.
 * Never a reason to cancel or interrupt anything.
 */
export function isShortReply(text: string): boolean {
  const core = [...text.replace(NOISE, "")];
  return core.length <= SHORT_REPLY_MAX_CHARS || new Set(core).size <= 2;
}

/** What is known about new input that arrives while a turn exists. */
export interface NewInputFacts {
  phase: TurnPhase;
  voice: boolean;
  /** It addresses her (mention, her name, reply to her, DM). */
  addressesHer: boolean;
  /** Its author is one of the turn's `addressed_accounts`. */
  fromFocus: boolean;
  text: string;
  /** The turn's `restarts` so far. */
  restarts: number;
  /**
   * The turn is one she started herself (`initiative` / `notice`, an intent) and has no focus:
   * input that addresses her takes the floor from it (absent: `false`).
   */
  selfStarted?: boolean;
}

/**
 * `merge`: add it to the turn being collected; `restart`: cancel the generation and start
 * again with it as focus; `background`: leave the turn alone, the input goes into the next
 * turn (as background, or as that turn's focus when it addresses her).
 */
export type InputDisposition = "merge" | "restart" | "background";

/**
 * The §3.9 table. While collecting, merge. Once generation started: short replies and input
 * that is neither for her nor from the focus person never cancel; voice never regenerates
 * (speech that is written but not played yet is played as is); in text the focus person's
 * substantive follow-up restarts the turn at most `MAX_TURN_RESTARTS` times. A turn she started
 * herself gives way (`restart`) to substantive input that addresses her, voice included.
 */
export function inputDisposition(facts: NewInputFacts): InputDisposition {
  if (facts.phase === "debounce") return "merge";
  if (facts.phase !== "generating") return "background";
  if (isShortReply(facts.text)) return "background";
  if (facts.selfStarted === true && facts.addressesHer) return "restart";
  if (facts.voice) return "background";
  if (!facts.fromFocus) return "background";
  return facts.restarts < MAX_TURN_RESTARTS ? "restart" : "background";
}

// ---- outcome --------------------------------------------------------------------------------

/** What cancelled a turn. */
export type TurnCancelCause =
  /** New input restarted it (`inputDisposition` said `restart`). */
  | "input"
  /** Voice: someone talked over her and barge-in stopped her. */
  | "barge_in"
  /** A more urgent turn / impulse took the floor. */
  | "superseded"
  /** Its input or impulse expired before it could be sent. */
  | "expired"
  /** The floor was held (a song, the GPU lent out) and the line was dropped. */
  | "floor"
  /** The module stopped, or the emergency stop did. */
  | "shutdown";

export type TurnOutcome =
  /** She said something (messages sent / sentences spoken). */
  | { type: "sent"; parts: number }
  /** She chose silence (`<silence/>` or nothing to say). */
  | { type: "silence" }
  /** `by`: the handle of the person whose input or voice caused it, when one did. */
  | { type: "cancelled"; cause: TurnCancelCause; by: Handle | null }
  | { type: "error"; error: string };

/** Payload of `TURN_OUTCOME_TOPIC`, one per turn. */
export interface TurnOutcomeRecord {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  outcome: TurnOutcome;
  addressed_by: Handle[];
  focus: MessageRef[];
  restarts: number;
  /** Reasoning level the reply was generated with (`null`: no generation). */
  reasoning: ReasoningLevel | null;
  /** From the last focus input to her first output (`null`: nothing went out). */
  latency_ms: number | null;
  at: Timestamp;
}

/** Payload: `TurnOutcomeRecord`. */
export const TURN_OUTCOME_TOPIC = "agent.turn.outcome";
