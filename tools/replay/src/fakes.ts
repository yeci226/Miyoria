// The fakes around the real pipeline: a scripted LLM and the action sink that stands in for the
// scheduler and the platforms (it records what she sends and plays her speech back on fake time).

import type { ChatProvider, ChatRequest, ChatStream } from "@miyoria/llm/llm";
import { type EventBus, sleep } from "@miyoria/runtime/kernel";
import type { ScriptedLlmConfig } from "@miyoria/runtime/replay-log";
import {
  type Action,
  type ActionSettled,
  type ActionSink,
  type ContextKey,
  Events,
  type PlaybackState,
  type TurnId,
} from "@miyoria/types";

const DEFAULT_REPLY = "嗯嗯,我在聽!";

/**
 * Answers every call by its reasoning purpose: replies (`chat_*`) from `replies` after
 * `latency_ms`, anything else `{}`. Deterministic: replies are cycled in call order.
 */
export class ScriptedLlm implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  #replies = 0;

  constructor(readonly script: ScriptedLlmConfig = {}) {}

  /** Replies she generated (a request with a `chat_*` purpose). */
  replyCalls(): number {
    return this.#replies;
  }

  #answer(request: ChatRequest): { text: string; delay: number } {
    const purpose = request.reasoning_purpose ?? "";
    if (purpose.startsWith("chat_")) {
      const replies = this.script.replies ?? [DEFAULT_REPLY];
      const text = replies[this.#replies % Math.max(replies.length, 1)] ?? DEFAULT_REPLY;
      this.#replies += 1;
      return { text, delay: this.script.latency_ms ?? 1500 };
    }
    return { text: "{}", delay: 500 };
  }

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.requests.push(request);
    const { text, delay } = this.#answer(request);
    return (async function* (): ChatStream {
      await sleep(delay, signal);
      yield { type: "text_delta", text };
      yield { type: "done", finish_reason: null, usage: null };
    })();
  }
}

/** One action she submitted, with the fake time it was submitted at. */
export interface SubmittedAction {
  at: number;
  action: Action;
}

/** Before a sentence starts playing (TTS) and how long a character takes to say (ms). */
const PLAYBACK_DELAY_MS = 400;
const MS_PER_CHAR = 180;
const MIN_PLAYBACK_MS = 800;

/**
 * The scheduler and the platforms: records every action and plays her `speak` actions back
 * in submission order per voice channel (`voice.playback` started / finished), so turns go
 * through `speaking` to `done` as with the real voice node. `cancelTurn` drops the turn's
 * sentences that did not start yet (and interrupts the one playing).
 */
export class ReplaySink implements ActionSink {
  readonly actions: SubmittedAction[] = [];
  readonly cancelled: TurnId[] = [];
  /** Per voice channel: when its playback queue is free again (ms). */
  readonly #freeAt = new Map<string, number>();
  readonly #dropped = new Set<TurnId>();

  constructor(
    readonly bus: EventBus,
    readonly now: () => number,
  ) {}

  async submit(action: Action): Promise<void> {
    this.actions.push({ at: this.now(), action: structuredClone(action) });
    const payload = action.payload;
    if (payload.type === "send_message") {
      const message = { context: payload.context, id: `sent-${action.id}` };
      queueMicrotask(() =>
        this.bus.publish("scheduler", Events.ActionCompleted, {
          action: action.id,
          turn: action.turn,
          ok: true,
          error: null,
          message,
        }),
      );
      const settled: ActionSettled = {
        action: action.id,
        turn: action.turn,
        type: "send_message",
        context: payload.context,
        text: payload.message.text,
        ok: true,
        error: null,
        message,
      };
      queueMicrotask(() => this.bus.publish("scheduler", Events.ActionSettled, settled));
      return;
    }
    if (payload.type !== "speak") return;
    const key = JSON.stringify(payload.context);
    const now = this.now();
    const start = Math.max(now + PLAYBACK_DELAY_MS, this.#freeAt.get(key) ?? 0);
    const length = Math.max(MIN_PLAYBACK_MS, [...payload.text].length * MS_PER_CHAR);
    this.#freeAt.set(key, start + length);
    void this.#play(payload.context, action.turn ?? null, payload.text, start - now, length);
  }

  async #play(
    context: ContextKey,
    turn: TurnId | null,
    text: string,
    waitMs: number,
    lengthMs: number,
  ): Promise<void> {
    await sleep(waitMs);
    if (turn !== null && this.#dropped.has(turn)) return;
    this.#playback(context, turn, "started", text);
    await sleep(lengthMs);
    const interrupted = turn !== null && this.#dropped.has(turn);
    this.#playback(context, turn, interrupted ? "interrupted" : "finished", text);
  }

  #playback(context: ContextKey, turn: TurnId | null, state: PlaybackState, text: string): void {
    this.bus.publish(
      "voice",
      Events.VoicePlaybackEvent,
      { context, turn, state, text },
      turn === null ? {} : { turn },
    );
  }

  async cancelTurn(turn: TurnId): Promise<void> {
    this.cancelled.push(turn);
    this.#dropped.add(turn);
  }

  /** Her text messages (`send_message`), in order. */
  messages(): SubmittedAction[] {
    return this.actions.filter((a) => a.action.payload.type === "send_message");
  }

  /** Her sentences (`speak`), in order. */
  speeches(): SubmittedAction[] {
    return this.actions.filter((a) => a.action.payload.type === "speak");
  }
}
