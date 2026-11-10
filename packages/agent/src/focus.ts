// Turn ownership (docs/design/v2-architecture.md §3.9): every turn knows whom it answers.
//
// `selectFocus` splits a turn's input into `focus` (the messages that called her, plus the
// same people's follow-ups) and `background` (everything else). The prompt's "要回的訊息"
// block only shows the focus, naming who asked, and the reply quotes its first message.
//
// `TurnFocusBoard` keeps the focus of every turn in flight (or still speaking) per context:
// the agent provides it as `TurnFocusViewKey` so voice barge-in can ask, on its hot path, whom
// the turn is for, and every change is published as `agent.turn.focus`.

import {
  type AccountRef,
  type ContextKey,
  type Handle,
  type IncomingMessage,
  type MessageRef,
  sameAccount,
  type TurnFocus,
  type TurnFocusView,
  type TurnId,
  type TurnPhase,
  type TurnReason,
  timestampMs,
} from "@miyoria/types";
import { isQuestion } from "./attention.js";
import { contextId } from "./util.js";

/** How one message relates to her. */
export type CallKind =
  /** It calls her: a mention, her name, a DM, a question right after she spoke (voice). */
  | "address"
  /** It replies to one of her messages. */
  | "reply"
  | null;

/** What is known about a voice context when classifying its utterances. */
export interface VoiceCallFacts {
  /** When she last spoke (clock ms), if ever. */
  lastSelfAt: number | null;
  /** A question this soon (ms) after she spoke addresses her. */
  questionWindowMs: number;
  /** People in the channel besides her (`null`: unknown). */
  others: number | null;
}

/**
 * How `msg` relates to her. `direct` is attention's `directReason` (mention, name, reply, DM);
 * in voice a question right after she spoke, or anything said one-on-one, also calls her.
 */
export function callKind(
  msg: IncomingMessage,
  direct: string | null,
  voice: VoiceCallFacts | null,
): CallKind {
  if (direct === "reply") return "reply";
  if (direct !== null) return "address";
  if (voice === null) return null;
  if (voice.others === 1) return "address";
  const last = voice.lastSelfAt;
  if (last !== null && isQuestion(msg.text.toLowerCase())) {
    const gap = timestampMs(msg.ts) - last;
    if (gap >= -voice.questionWindowMs && gap <= voice.questionWindowMs) return "address";
  }
  return null;
}

export interface FocusSelection {
  reason: TurnReason;
  /** The messages the reply answers, oldest first. */
  focus: IncomingMessage[];
  /** The rest of the turn's input: context only. */
  background: IncomingMessage[];
  /** The people who called her (or replied to her), in the order they did. */
  addressed: IncomingMessage["author"][];
  /** Authors of the focus messages (for an ambient turn: the last speaker). */
  authors: AccountRef[];
  /** How each focus message relates to her (same order as `focus`). */
  kinds: CallKind[];
}

/**
 * Splits `inputs` (oldest first) into focus and background.
 *
 * - Someone called her (or replied to her): the focus is their messages from the first one that
 *   called her on; everyone else's are background. `reason` is `addressed` (or `reply_to_her`
 *   when every call was a reply).
 * - Nobody did but `followsHer` (someone answering what she just said): the last speaker's
 *   messages, `reply_to_her`.
 * - Otherwise `ambient`: the last speaker's messages, nobody in `addressed`.
 */
export function selectFocus(
  inputs: readonly IncomingMessage[],
  classify: (msg: IncomingMessage) => CallKind,
  followsHer: boolean,
): FocusSelection {
  const kinds = inputs.map(classify);
  const addressed: IncomingMessage["author"][] = [];
  const firstCall = new Map<string, number>();
  let anyAddress = false;
  inputs.forEach((m, i) => {
    const kind = kinds[i];
    if (kind === null || kind === undefined) return;
    if (kind === "address") anyAddress = true;
    const key = authorKey(m.author.account);
    if (!firstCall.has(key)) {
      firstCall.set(key, i);
      addressed.push(m.author);
    }
  });
  let take: (m: IncomingMessage, i: number) => boolean;
  let reason: TurnReason;
  if (addressed.length > 0) {
    reason = anyAddress ? "addressed" : "reply_to_her";
    take = (m, i) => {
      const from = firstCall.get(authorKey(m.author.account));
      return from !== undefined && i >= from;
    };
  } else {
    const last = inputs.at(-1);
    reason = followsHer && last !== undefined ? "reply_to_her" : "ambient";
    if (reason === "reply_to_her" && last) addressed.push(last.author);
    take = (m) => last !== undefined && sameAccount(m.author.account, last.author.account);
  }
  const focus: IncomingMessage[] = [];
  const focusKinds: CallKind[] = [];
  const background: IncomingMessage[] = [];
  inputs.forEach((m, i) => {
    if (take(m, i)) {
      focus.push(m);
      focusKinds.push(kinds[i] ?? null);
    } else {
      background.push(m);
    }
  });
  const authors: AccountRef[] = [];
  for (const m of focus) {
    if (!authors.some((a) => sameAccount(a, m.author.account))) authors.push(m.author.account);
  }
  return { reason, focus, background, addressed, authors, kinds: focusKinds };
}

function authorKey(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

/** How the focus block introduces a message (`Owen 問你:…`). */
export function focusVerb(kind: CallKind, first: boolean): string {
  if (!first) return "接著說";
  if (kind === "address") return "問你";
  if (kind === "reply") return "回你";
  return "說";
}

export interface TurnFocusInit {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  addressed_by: Handle[];
  addressed_accounts: AccountRef[];
  focus: MessageRef[];
  background: MessageRef[];
  restarts: number;
}

/**
 * The focus of every turn in flight, per context (`TurnFocusView`). A finished voice turn whose
 * speech is still queued stays (phase `speaking`) until its speech is over, it is replaced by a
 * newer turn, or `speakingHoldMs` passed.
 */
export class TurnFocusBoard implements TurnFocusView {
  readonly #turns = new Map<string, TurnFocus>();
  /** Clock ms after which a `speaking` entry is dropped. */
  readonly #holds = new Map<TurnId, number>();

  constructor(
    readonly now: () => number,
    readonly publish: (focus: TurnFocus) => void,
  ) {}

  current(context: ContextKey): TurnFocus | null {
    const id = contextId(context);
    const focus = this.#turns.get(id) ?? null;
    if (focus === null) return null;
    const hold = this.#holds.get(focus.turn);
    if (hold !== undefined && this.now() >= hold) {
      this.#turns.delete(id);
      this.#holds.delete(focus.turn);
      return null;
    }
    return structuredClone(focus);
  }

  all(): TurnFocus[] {
    const out: TurnFocus[] = [];
    for (const focus of [...this.#turns.values()]) {
      const current = this.current(focus.context);
      if (current !== null) out.push(current);
    }
    return out;
  }

  /** A new turn in its context (replacing whatever was there). */
  start(init: TurnFocusInit, phase: TurnPhase = "generating"): TurnFocus {
    const at = new Date(this.now()).toISOString();
    const focus: TurnFocus = { ...init, phase, started_at: at, updated_at: at };
    const id = contextId(init.context);
    const before = this.#turns.get(id);
    if (before) this.#holds.delete(before.turn);
    this.#turns.set(id, focus);
    this.publish(structuredClone(focus));
    return focus;
  }

  /** The focus of `turn`, if it is still on the board. */
  get(turn: TurnId): TurnFocus | null {
    for (const focus of this.#turns.values()) if (focus.turn === turn) return focus;
    return null;
  }

  /** Moves `turn` to `phase` (`holdMs`: for `speaking`, how long it may stay at most). */
  phase(turn: TurnId, phase: TurnPhase, holdMs: number | null = null): void {
    const focus = this.get(turn);
    if (focus === null) return;
    if (holdMs !== null) this.#holds.set(turn, this.now() + holdMs);
    if (focus.phase === phase) return;
    focus.phase = phase;
    focus.updated_at = new Date(this.now()).toISOString();
    if (phase === "done") {
      this.#turns.delete(contextId(focus.context));
      this.#holds.delete(turn);
    }
    this.publish(structuredClone(focus));
  }

  /** `turn` is over (no-op when a newer turn replaced it). */
  end(turn: TurnId): void {
    this.phase(turn, "done");
  }
}
