// What the agent and the voice module tell each other about a voice turn in flight (v4 §7.5).
//
// The voice module measures a reply from the person's last sound to her first audio
// (`voice.latency`, stage `e2e`). The stretch between the transcript and the model's first
// sentence is the agent's: it marks where its own time went (`VoiceTurns.mark`), so the
// measurement splits it instead of calling all of it the model's. It also says when she will
// answer someone (`expect`), so the voice module can fill a long silence with a short sound of
// hers, and when that no longer holds (`settle`).

import type { TurnId } from "./ids.js";
import type { ContextKey, MessageRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/**
 * The agent's marks of one voice turn, in order (clock ms):
 *
 * - `started`: the turn began (the wait after the utterance is over, or it started early);
 * - `decided`: attention said yes and the Floor gave her the mic;
 * - `context`: memory, contributors and the rest of the prompt's data are in;
 * - `request`: the prompt is built and the model call went out;
 * - `confirmed`: a turn started early may speak (the person did not go on);
 * - `first_token`: the model's first output arrived.
 */
export const VOICE_TURN_MARKS = [
  "started",
  "decided",
  "context",
  "request",
  "confirmed",
  "first_token",
] as const;

export type VoiceTurnMark = (typeof VOICE_TURN_MARKS)[number];

/** Marks known so far (clock ms). */
export type VoiceTurnMarks = Partial<Record<VoiceTurnMark, number>>;

/**
 * Where the time of a voice turn went, from the person's last sound to her first sentence handed
 * to the voice sink (ms, `null` where a boundary is unknown). Known parts add up to the outcome's
 * `latency_ms`. Kept on the turn's outcome row as `voice_stages`; what comes after the first
 * sentence (TTS, playback) is in the `voice.latency` `e2e` record of the same turn.
 */
export interface VoiceTurnStages {
  /** Speech end → the transcript reached the agent: end of speech, ASR and the bus. */
  heard_ms: number | null;
  /** → the turn started: the wait to see whether the person goes on. */
  wait_ms: number | null;
  /** → attention and the Floor said yes. */
  decide_ms: number | null;
  /** → memory, contributors and the rest of the data were in. */
  context_ms: number | null;
  /** → the prompt was built and the model call went out. */
  prompt_ms: number | null;
  /** → the model's first output. */
  first_token_ms: number | null;
  /** → a turn started early was confirmed (0 when that came before the first output). */
  held_ms: number | null;
  /** → her first sentence was handed to the voice sink. */
  first_sentence_ms: number | null;
  /** The turn started before the wait was over (its model call ran while the person might go on). */
  speculative: boolean;
}

/** Provided by the voice module; the agent tells it about its voice turns. Every call is cheap. */
export interface VoiceTurns {
  /** `turn`, which answers `focus`, reached `mark` at clock time `at`. */
  mark(turn: TurnId, focus: readonly MessageRef[], mark: VoiceTurnMark, at: number): void;
  /**
   * She will answer `turn` in `context` (it started at clock time `startedAt`): if nothing of hers
   * can be heard a while after that, a short sound of hers may fill the silence.
   */
  expect(context: ContextKey, turn: TurnId, startedAt: number): void;
  /** `turn` is over or will say nothing: nothing more is done for it. */
  settle(turn: TurnId): void;
}

export const VoiceTurnsKey = serviceKey<VoiceTurns>("VoiceTurns");
