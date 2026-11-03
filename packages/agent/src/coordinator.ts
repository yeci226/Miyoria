// Turn coordinator: one per conversation context.
//
// Debounces incoming messages into turns, keeps at most one turn in flight and restarts the
// turn when new input arrives before its reply was committed. A text reply is committed once
// it is handed to the scheduler; a voice reply once it starts playing, so a finished voice turn
// whose speech is still queued is cancelled and regenerated too.
//
// In voice channels the debounce is shorter, but it is extended (up to
// `voice.max_debounce_ms`) while someone is speaking.
//
// An initiative request starts a turn without input, but only when the context is quiet: no
// turn in flight, no debounce pending, no speech of hers still queued and her last words older
// than the ambient cooldown.
//
// An intent (something her mind loop decided) waits instead: it never interrupts a turn in
// flight, waiting messages or her speech still queued or playing (nor, in voice, someone still
// talking) and starts once the context is free, unless it expired meanwhile. A turn that
// answered there in the meantime drops it: what she meant to say was decided before that
// answer. A newer intent replaces a waiting one. New input cancels an intent turn whose reply
// was not committed, like any turn.

import { errorMessage } from "@miyoria/kernel";
import {
  ActionSinkKey,
  type ContextKey,
  type IncomingMessage,
  newId,
  type PlaybackState,
  type TurnId,
} from "@miyoria/types";
import { maxDebounceMs, voiceMaxDebounceMs } from "./config.js";
import { UNCAPPED_INITIATIVES } from "./levels.js";
import type { Agent, Inbox, Initiative, Input, IntentTurn } from "./runtime.js";
import type { Session } from "./session.js";
import { runTurn } from "./turn.js";
import { contextId } from "./util.js";

/** Shared between a turn and its coordinator. */
export interface TurnFlags {
  /**
   * Text: the reply was handed to the scheduler. Voice: her speech started playing. From then
   * on new input no longer cancels the turn.
   */
  committed: boolean;
  /** Voice: at least one sentence was submitted. */
  queued: boolean;
  /** Voice: sentences submitted. */
  sentences: number;
  /** Voice: sentences whose playback ended (finished, interrupted or failed). */
  played: number;
  /** Voice: her speech was interrupted; submit no further sentences. */
  interrupted: boolean;
}

interface Running {
  turn: TurnId;
  inputs: IncomingMessage[];
  /** One of her intents (not an answer to messages or an initiative). */
  intent: boolean;
  flags: TurnFlags;
  controller: AbortController;
  promise: Promise<void>;
  done: boolean;
}

/** A finished voice turn whose speech is queued but has not started playing. */
interface Unplayed {
  turn: TurnId;
  inputs: IncomingMessage[];
  /** Clock ms. */
  since: number;
}

/** A finished voice turn whose speech has not all played yet. */
interface Speaking {
  turn: TurnId;
  flags: TurnFlags;
  /** Clock ms of the turn's end or its last playback event. */
  heard: number;
}

type Wake =
  | { type: "stop" }
  | { type: "input"; input: Input }
  | { type: "deadline" }
  | { type: "turn_done" }
  | { type: "idle" }
  | { type: "tick" };

/** Debounce window (clock ms): when it opened and when the turn should start. */
interface Window {
  opened: number;
  deadline: number;
}

export class Coordinator {
  readonly #agent: Agent;
  readonly #key: ContextKey;
  readonly #session: Session;
  readonly #inbox: Inbox;

  constructor(agent: Agent, key: ContextKey, session: Session, inbox: Inbox) {
    this.#agent = agent;
    this.#key = key;
    this.#session = session;
    this.#inbox = inbox;
  }

  get #now(): number {
    return this.#agent.ctx.clock.now();
  }

  async run(signal: AbortSignal): Promise<void> {
    const cfg = this.#agent.config;
    const voice = this.#key.kind === "voice";
    const debounce = voice ? cfg.voice.debounce_ms : cfg.debounce_ms;
    const maxDebounce = voice ? voiceMaxDebounceMs(cfg.voice) : maxDebounceMs(cfg);
    let pending: IncomingMessage[] = [];
    let window: Window | null = null;
    let running: Running | null = null;
    let unplayed: Unplayed | null = null;
    let speaking: Speaking | null = null;
    /** Her intent waiting for the context to be free. */
    let waiting: IntentTurn | null = null;
    /** Clock ms until which her speech of `speaking` still holds `waiting` back. */
    const speechHold = (now: number): number | null => {
      if (speaking === null || waiting === null) return null;
      const f = speaking.flags;
      if (f.interrupted || f.played >= f.sentences) return null;
      const until = speaking.heard + cfg.voice.speak_ttl_ms;
      return now < until ? until : null;
    };
    for (;;) {
      // Voice contexts live until she leaves the channel.
      const idle = pending.length === 0 && running === null && waiting === null && !voice;
      const wake = await this.#next(
        signal,
        running,
        running === null ? window : null,
        idle,
        speechHold(this.#now),
      );
      const now = this.#now;
      switch (wake.type) {
        case "stop": {
          if (running) await this.#abort(running);
          if (unplayed) await this.#cancel(unplayed.turn);
          if (waiting) this.#agent.intentSkipped(this.#key, waiting, "the context closed");
          return;
        }
        case "input": {
          const input = wake.input;
          switch (input.type) {
            case "message": {
              if (running && !running.flags.committed) {
                const merged = await this.#abort(running);
                running = null;
                pending = [...merged, ...pending];
                window = null;
              }
              if (unplayed) {
                const u = unplayed;
                unplayed = null;
                if (now < u.since + cfg.voice.speak_ttl_ms) {
                  this.#agent.log.debug(
                    { turn: u.turn, context: contextId(this.#key) },
                    "speech not played yet, regenerating",
                  );
                  await this.#cancel(u.turn);
                  if (speaking?.turn === u.turn) speaking = null;
                  pending = [...u.inputs, ...pending];
                  window = null;
                }
              }
              pending.push(input.message);
              const opened: number = window?.opened ?? now;
              window = { opened, deadline: Math.min(now + debounce, opened + maxDebounce) };
              break;
            }
            case "typing":
              if (window) {
                window.deadline = Math.min(
                  Math.max(window.deadline, now + cfg.typing_extend_ms),
                  window.opened + maxDebounce,
                );
              }
              break;
            case "speaking":
              // Started: do not answer over them. Stopped: give the transcript of what they
              // said time to arrive.
              if (window) {
                window.deadline = Math.min(
                  Math.max(window.deadline, now + debounce),
                  window.opened + maxDebounce,
                );
              }
              break;
            case "playback": {
              const flags =
                running && running.turn === input.turn
                  ? running.flags
                  : speaking && speaking.turn === input.turn
                    ? speaking.flags
                    : null;
              if (speaking && speaking.turn === input.turn) speaking.heard = now;
              if (await this.#playback(input.turn, input.state, flags, unplayed)) unplayed = null;
              break;
            }
            case "initiative": {
              const started = await this.#initiative(
                input.initiative,
                running !== null,
                pending.length > 0,
                unplayed !== null,
              );
              if (started) running = started;
              break;
            }
            case "intent":
              if (waiting) {
                this.#agent.intentSkipped(this.#key, waiting, "replaced by a newer intent");
              }
              waiting = input.intent;
              break;
          }
          break;
        }
        case "deadline": {
          if (window) {
            const cap = window.opened + maxDebounce;
            if (voice && now < cap && this.#session.someoneSpeaking()) {
              window.deadline = Math.min(now + debounce, cap);
              break;
            }
          }
          window = null;
          const inputs = pending;
          pending = [];
          running = this.#start(inputs, null, signal);
          break;
        }
        case "turn_done": {
          const r = running as Running;
          running = null;
          const flags = r.flags;
          if (voice && flags.queued && !flags.committed && !flags.interrupted) {
            unplayed = { turn: r.turn, inputs: r.inputs, since: now };
          }
          if (voice && flags.queued && !flags.interrupted) {
            speaking = { turn: r.turn, flags, heard: now };
          }
          if (waiting !== null && !r.intent && (flags.committed || flags.queued)) {
            this.#agent.intentSkipped(this.#key, waiting, "she just answered here");
            waiting = null;
          }
          break;
        }
        case "tick":
          break;
        case "idle":
          if (this.#agent.retire(this.#key, this.#inbox)) {
            this.#agent.log.debug(
              { context: contextId(this.#key) },
              "context idle, session dropped",
            );
            return;
          }
          break;
      }
      if (waiting !== null && running === null && pending.length === 0) {
        const speechQueued = unplayed !== null && now < unplayed.since + cfg.voice.speak_ttl_ms;
        const playing = speechHold(now) !== null;
        if (!speechQueued && !playing && !(voice && this.#session.someoneSpeaking())) {
          const w = waiting;
          waiting = null;
          running = this.#intent(w, signal);
        }
      }
    }
  }

  /** Starts her intent turn, unless it expired while waiting. */
  #intent(input: IntentTurn, signal: AbortSignal): Running | null {
    if (this.#now >= Date.parse(input.intent.expires_at)) {
      this.#agent.intentSkipped(this.#key, input, "expired");
      return null;
    }
    // The channel's level (checked again: another start may have come first).
    const blocked = this.#agent.startBlocked(this.#key);
    if (blocked !== null) {
      this.#agent.intentSkipped(this.#key, input, blocked);
      return null;
    }
    this.#agent.noteStart(this.#key);
    return this.#start([], null, signal, input);
  }

  /** Waits for the next thing to do (Rust `select!` over the coordinator's sources). */
  async #next(
    signal: AbortSignal,
    running: Running | null,
    window: Window | null,
    idle: boolean,
    /** Clock ms to wake at, so a waiting intent is looked at again (`null`: none). */
    tickAt: number | null,
  ): Promise<Wake> {
    let idleFired = false;
    for (;;) {
      if (signal.aborted) return { type: "stop" };
      if (running?.done) return { type: "turn_done" };
      const input = this.#inbox.shift();
      if (input) return { type: "input", input };
      if (this.#inbox.closed) return { type: "stop" };
      if (window && this.#now >= window.deadline) return { type: "deadline" };
      if (idleFired) return { type: "idle" };
      if (tickAt !== null && this.#now >= tickAt) return { type: "tick" };

      const timers: ReturnType<typeof setTimeout>[] = [];
      let onAbort: (() => void) | undefined;
      const waits: Promise<unknown>[] = [
        this.#inbox.ready(),
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ];
      if (running) waits.push(running.promise);
      if (window) {
        const ms = Math.max(window.deadline - this.#now, 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      if (tickAt !== null) {
        const ms = Math.max(tickAt - this.#now, 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      if (idle) {
        waits.push(
          new Promise<void>((resolve) =>
            timers.push(
              setTimeout(() => {
                idleFired = true;
                resolve();
              }, this.#agent.config.session_idle_ms),
            ),
          ),
        );
      }
      try {
        await Promise.race(waits);
      } finally {
        for (const t of timers) clearTimeout(t);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Handles an initiative request; returns the started turn, if any. */
  async #initiative(
    initiative: Initiative,
    turnRunning: boolean,
    messagesWaiting: boolean,
    speechQueued: boolean,
  ): Promise<Running | null> {
    const busy = turnRunning
      ? "a turn is in flight"
      : messagesWaiting
        ? "messages are waiting for a turn"
        : speechQueued
          ? "her speech is still queued"
          : null;
    if (busy !== null) {
      this.#agent.initiativeSkipped(this.#key, initiative.reason, busy);
      return null;
    }
    // Live game commentary is rate-limited by the game director itself, and a result someone
    // is waiting for (`action_result`) is no chatter to space out.
    const last =
      initiative.reason === "game" || initiative.reason === "action_result"
        ? null
        : this.#session.lastSelfAt();
    const capped = !UNCAPPED_INITIATIVES.includes(initiative.reason);
    if (last !== null) {
      const cooldown = this.#agent.ambientCooldownMs(this.#key, capped);
      const since = this.#now - last;
      if (since < cooldown) {
        this.#agent.initiativeSkipped(
          this.#key,
          initiative.reason,
          `cooldown (${since}ms since she spoke)`,
        );
        return null;
      }
    }
    if (capped) {
      const blocked = this.#agent.startBlocked(this.#key);
      if (blocked !== null) {
        this.#agent.initiativeSkipped(this.#key, initiative.reason, blocked);
        return null;
      }
      this.#agent.noteStart(this.#key);
    }
    return this.#start([], initiative, this.#agent.ctx.signal);
  }

  #start(
    inputs: IncomingMessage[],
    initiative: Initiative | null,
    signal: AbortSignal,
    intent: IntentTurn | null = null,
  ): Running {
    const turn = intent?.turn ?? newId();
    this.#agent.ctx.publish(
      { type: "agent_turn_started", data: { turn, context: this.#key } },
      { turn },
    );
    const flags: TurnFlags = {
      committed: false,
      queued: false,
      sentences: 0,
      played: 0,
      interrupted: false,
    };
    const controller = new AbortController();
    if (signal.aborted) controller.abort(signal.reason);
    const running: Running = {
      turn,
      inputs,
      intent: intent !== null,
      flags,
      controller,
      promise: Promise.resolve(),
      done: false,
    };
    running.promise = runTurn(
      this.#agent,
      this.#key,
      this.#session,
      turn,
      inputs,
      initiative,
      flags,
      controller.signal,
      intent,
    )
      .catch((error: unknown) => {
        this.#agent.log.warn({ turn, error: errorMessage(error) }, "turn failed");
      })
      .finally(() => {
        running.done = true;
      });
    return running;
  }

  /**
   * Her speech of `turn` started, ended or was cut off (`flags`: those of `turn` if it is the
   * running turn). Returns whether `unplayed` is resolved.
   */
  async #playback(
    turn: TurnId,
    state: PlaybackState,
    flags: TurnFlags | null,
    unplayed: Unplayed | null,
  ): Promise<boolean> {
    if (flags) {
      if (state !== "started") flags.played += 1;
      if (state === "started" || state === "finished") {
        flags.committed = true;
      } else if (state === "interrupted") {
        flags.committed = true;
        flags.interrupted = true;
      }
    }
    const resolved = state !== "failed" && unplayed !== null && unplayed.turn === turn;
    if (state === "interrupted") {
      // The rest of what she meant to say would no longer fit.
      this.#agent.log.debug(
        { turn, context: contextId(this.#key) },
        "speech interrupted, dropping the rest",
      );
      await this.#cancel(turn);
    }
    return resolved;
  }

  /** Drops the queued actions of `turn`. */
  async #cancel(turn: TurnId): Promise<void> {
    const sink = this.#agent.ctx.services.get(ActionSinkKey);
    if (!sink) return;
    try {
      await sink.cancelTurn(turn);
    } catch (error) {
      this.#agent.log.debug({ turn, error: errorMessage(error) }, "could not cancel turn");
    }
  }

  /** Cancels a turn whose reply was not committed yet; returns its inputs. */
  async #abort(running: Running): Promise<IncomingMessage[]> {
    running.controller.abort();
    this.#agent.log.debug(
      { turn: running.turn, context: contextId(this.#key) },
      "turn cancelled by new input",
    );
    await this.#cancel(running.turn);
    this.#agent.ctx.publish(
      {
        type: "agent_turn_completed",
        data: { turn: running.turn, context: this.#key, text: "" },
      },
      { turn: running.turn },
    );
    return running.inputs;
  }
}
