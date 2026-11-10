// The main line owns its lines (docs/design/v3-architecture.md §8): it opens one in the
// DeliveryLedger when a sentence or a message goes to the scheduler and closes it with what really
// happened. Voice ends with the playback (`finished`: heard; `interrupted`, `failed`), or with the
// scheduler when it never got that far; text ends when the platform answered.
//
// The Floor follows the same `utterance` / `delivered` / `result` events in the log, so a hold
// ends exactly when the audio is over, on every failure path too.

import {
  type ActionId,
  type ActionSettled,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type DeliveryChannel,
  type DeliveryLedger,
  type Handle,
  MUTED,
  type PlaybackState,
  type TurnId,
  type UndeliveredState,
} from "@miyoria/types";

/** What the scheduler answers for an action that never went out. */
const NEVER_SENT = new Set(["expired", "cancelled", "coalesced", MUTED]);
/** Lines remembered by action. */
const MEMORY = 2_000;

export interface OpenLine {
  turn: TurnId | null;
  context: ContextKey;
  channel: DeliveryChannel;
  said: string;
  action: ActionId;
  attention_key: string;
  revision: number;
  audience: readonly Handle[];
  cause: string | null;
  /** It is the filtered line: moderation stopped what she meant (the rule). */
  blocked?: string | null;
}

interface Line {
  id: string;
  turn: TurnId | null;
  context: ContextKey;
  action: ActionId;
  /** Clock ms when playback started. */
  startedAt: number | null;
  /** However it ends, this line is not her saying what she meant. */
  blocked: string | null;
}

function speechKey(context: ContextKey, turn: TurnId | null, text: string): string {
  return `${contextKeyString(context)}\n${turn}\n${text}`;
}

export class LineBook {
  readonly #ledger: () => DeliveryLedger | null;
  readonly #now: () => number;
  /** Speech in flight by what it says, oldest first (playback events carry no action id). */
  readonly #speech = new Map<string, Line[]>();
  readonly #byAction = new Map<ActionId, Line>();

  constructor(ledger: () => DeliveryLedger | null, now: () => number) {
    this.#ledger = ledger;
    this.#now = now;
  }

  /** A sentence or message is about to go to the scheduler. */
  open(input: OpenLine): void {
    const ledger = this.#ledger();
    if (ledger === null) return;
    const id = ledger.open({
      attention_key: input.attention_key,
      revision: input.revision,
      channel: input.channel,
      context: input.context,
      said: input.said,
      audience: input.audience,
      turn: input.turn,
      cause: input.cause,
      source: "mainline",
    });
    const line: Line = {
      id,
      turn: input.turn,
      context: input.context,
      action: input.action,
      startedAt: null,
      blocked: input.blocked ?? null,
    };
    this.#byAction.set(input.action, line);
    while (this.#byAction.size > MEMORY) {
      const oldest = this.#byAction.keys().next().value;
      if (oldest === undefined) break;
      this.#byAction.delete(oldest);
    }
    if (input.channel === "voice") {
      const key = speechKey(input.context, input.turn, input.said);
      this.#speech.set(key, [...(this.#speech.get(key) ?? []), line]);
    }
  }

  /** The line of `action` will not reach anyone (the scheduler refused it). */
  failed(action: ActionId, reason: string): void {
    const line = this.#byAction.get(action);
    if (line) this.#end(line, "failed", reason);
  }

  /** Removes `line` from what is in flight and tells the ledger how it ended. */
  #end(line: Line, state: UndeliveredState | "delivered", reason: string | null): void {
    this.#byAction.delete(line.action);
    for (const [key, lines] of this.#speech) {
      if (!lines.includes(line)) continue;
      const left = lines.filter((l) => l !== line);
      if (left.length === 0) this.#speech.delete(key);
      else this.#speech.set(key, left);
      break;
    }
    const ledger = this.#ledger();
    if (state !== "delivered") ledger?.undelivered(line.id, state, reason);
    else if (line.blocked !== null) ledger?.undelivered(line.id, "blocked", line.blocked);
    else ledger?.ack(line.id);
  }

  /** Speech in flight for a report. A line the sink replaced is reported as what it became. */
  #speechOf(
    context: ContextKey,
    turn: TurnId | null,
    text: string,
    blocked: string | null,
  ): Line[] {
    const lines = this.#speech.get(speechKey(context, turn, text)) ?? [];
    if (lines.length > 0 || blocked === null) return lines;
    return [...this.#speech.values()]
      .flat()
      .filter((l) => l.turn === turn && contextKeyEquals(l.context, context));
  }

  /**
   * `voice_playback`. Returns how long the line was audible when it ended, for what she keeps of
   * a sentence that was cut off (`null`: it never started).
   */
  playback(
    context: ContextKey,
    turn: TurnId | null,
    state: PlaybackState,
    text: string,
    blocked: string | null = null,
  ): number | null {
    const lines = this.#speechOf(context, turn, text, blocked);
    if (state === "started") {
      const line = lines.find((l) => l.startedAt === null);
      if (line) line.startedAt = this.#now();
      return null;
    }
    const line = lines.find((l) => l.startedAt !== null) ?? lines[0];
    if (!line) return null;
    line.blocked ??= blocked;
    const heard = line.startedAt === null ? null : this.#now() - line.startedAt;
    if (state === "finished") this.#end(line, "delivered", null);
    else this.#end(line, state === "interrupted" ? "interrupted" : "failed", null);
    return heard;
  }

  /** `action.settled`: text is over here; speech only when it never reached playback. */
  settled(settled: ActionSettled): void {
    const line = this.#byAction.get(settled.action);
    if (!line) return;
    line.blocked ??= settled.blocked ?? null;
    // What started playing ends with its playback, however the scheduler let go of it: a line cut
    // through the abort signal counts as cut, with what was heard, not as never sent.
    if (settled.type === "speak" && (settled.ok || line.startedAt !== null)) return;
    if (settled.ok) {
      this.#end(line, "delivered", null);
      return;
    }
    const state = NEVER_SENT.has(settled.error ?? "") ? "cancelled" : "failed";
    this.#end(line, state, settled.error);
  }

  /** The turn was thrown away: what did not start playing never will. */
  cancelUnstarted(turn: TurnId, why: string): void {
    for (const line of [...this.#byAction.values()]) {
      if (line.turn === turn && line.startedAt === null) this.#end(line, "cancelled", why);
    }
  }

  /** She left `context`: nothing in flight there reaches anyone any more. */
  dropContext(context: ContextKey, why: string): void {
    for (const line of [...this.#byAction.values()]) {
      if (contextKeyEquals(line.context, context)) this.#end(line, "failed", why);
    }
  }
}
