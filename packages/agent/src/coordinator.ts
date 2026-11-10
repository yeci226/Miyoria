// Turn coordinator: one per conversation context.
//
// Debounces incoming messages into turns and keeps at most one turn in flight. Every turn has a
// focus (focus.ts: whom it answers), and new input is handled by the one cancellation rule,
// `inputDisposition` (docs/design/v2-architecture.md §3.9):
//
// | situation                                              | handling                          |
// |--------------------------------------------------------|-----------------------------------|
// | the turn is still being collected (debounce)           | merged                            |
// | generating, input neither for her nor from the focus   | not cancelled, waits for the next |
// | generating, the focus person adds something substantial | restarted, at most once           |
// | short replies (「對」「嗯」「哈哈」)                     | never cancel                      |
// | voice: written but not played yet                      | played as is, never regenerated   |
// | her own turn (initiative, intent) and someone calls her | it gives way                      |
//
// A text reply is committed once it is handed to the scheduler (from then on input only waits);
// a voice reply is never regenerated. Every turn ends with one `agent.turn.outcome`; the ones
// cancelled here (restarted, superseded, shut down, an intent that expired or was replaced) are
// published by the coordinator, the others by the turn.
//
// In voice channels the debounce is shorter (shorter still when someone calls her, and when a
// model judged the speaker done there is little left to wait for), but it is extended (up to
// `voice.max_debounce_ms`) while someone is speaking.
//
// An initiative request starts a turn without input, but only when the context is quiet: no
// turn in flight, no debounce pending, no speech of hers still queued. While the Arbiter runs
// that is all the coordinator decides (the Arbiter retries a busy place); every rule (cooldowns,
// the level's gap, caps) is the Arbiter's. Without it the old checks apply here: her last words
// a few seconds old and the level's gap.
//
// An intent (something her mind loop decided) waits instead: it never interrupts a turn in
// flight, waiting messages or her speech still queued or playing (nor, in voice, someone still
// talking) and starts once the context is free, unless it expired meanwhile. A turn that
// answered there in the meantime drops it: what she meant to say was decided before that
// answer. A newer intent replaces a waiting one.
//
// Under `pipeline = "v3"` someone calling her while she speaks on her own, or something urgent,
// cuts in as far as the Floor's interrupt level says (§7.3): `wrap_up` finishes the sentence that
// is playing and drops the rest, `cut_short` and `interrupt` stop that sentence too.

import { errorMessage } from "@miyoria/kernel";
import {
  ActionSinkKey,
  type ContextKey,
  type ImpulseRun,
  type IncomingMessage,
  type InterruptLevel,
  inputDisposition,
  newId,
  type PlaybackState,
  sameAccount,
  type TurnCancelCause,
  type TurnId,
  type TurnReason,
  toTimestamp,
} from "@miyoria/types";
import { answersHer, directReason } from "./attention.js";
import { maxDebounceMs, voiceMaxDebounceMs } from "./config.js";
import { type CallKind, callKind, type FocusSelection, selectFocus } from "./focus.js";
import { UNCAPPED_INITIATIVES } from "./levels.js";
import type { Agent, Inbox, Initiative, Input, IntentTurn } from "./runtime.js";
import type { Session } from "./session.js";
import { runTurn, type TurnPlan } from "./turn.js";
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
  /** Voice: she gave way to a claim on the Floor; submit no further sentences. */
  yielded?: boolean;
}

interface Running {
  turn: TurnId;
  inputs: IncomingMessage[];
  flags: TurnFlags;
  controller: AbortController;
  promise: Promise<void>;
  done: boolean;
  plan: TurnPlan;
  /** She started it herself (initiative, intent): it has no focus. */
  selfStarted: boolean;
  /** One of her intents (not an answer to messages or an initiative). */
  intent: boolean;
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
  /** How long the window stays open past a sign of life. */
  wait: number;
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

  get #voice(): boolean {
    return this.#key.kind === "voice";
  }

  /** How `msg` relates to her (focus.ts). */
  #callKind(msg: IncomingMessage): CallKind {
    const cfg = this.#agent.config.voice;
    const voice = this.#voice
      ? {
          lastSelfAt: this.#session.lastSelfAt(),
          questionWindowMs: cfg.question_window_ms,
          others: this.#session.voiceMembers().length,
        }
      : null;
    return callKind(msg, directReason(msg, this.#agent.persona.names()), voice);
  }

  async run(signal: AbortSignal): Promise<void> {
    const cfg = this.#agent.config;
    const voice = this.#voice;
    const debounce = voice ? cfg.voice.debounce_ms : cfg.debounce_ms;
    const maxDebounce = voice ? voiceMaxDebounceMs(cfg.voice) : maxDebounceMs(cfg);
    let pending: IncomingMessage[] = [];
    let window: Window | null = null;
    let running: Running | null = null;
    let unplayed: Unplayed | null = null;
    let speaking: Speaking | null = null;
    /** Restarts carried into the next turn (the restarted one's count plus one). */
    let restarts = 0;
    /** Her intent waiting for the context to be free. */
    let waiting: IntentTurn | null = null;
    /** Clock ms until which her speech of `speaking` still holds `waiting` back. */
    const speechHold = (now: number): number | null => {
      if (speaking === null || waiting === null) return null;
      const f = speaking.flags;
      if (f.interrupted || f.yielded || f.played >= f.sentences) return null;
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
          if (running && !running.done) await this.#abort(running, "shutdown", null);
          if (unplayed) await this.#cancel(unplayed.turn);
          if (waiting) {
            this.#agent.intentSkipped(this.#key, waiting, "the context closed");
            this.#cancelled(waiting.turn, "initiative", "shutdown");
          }
          return;
        }
        case "input": {
          const input = wake.input;
          switch (input.type) {
            case "message": {
              const msg = input.message;
              const kind = this.#callKind(msg);
              if (running && !running.flags.committed && !running.done) {
                const r = running;
                const disposition = inputDisposition({
                  phase: r.flags.queued ? "speaking" : "generating",
                  voice,
                  addressesHer: kind !== null,
                  fromFocus: (r.plan.selection?.authors ?? []).some((a) =>
                    sameAccount(a, msg.author.account),
                  ),
                  text: msg.text,
                  restarts: r.plan.focus.restarts,
                  selfStarted: r.selfStarted,
                });
                if (disposition === "restart") {
                  const by = this.#agent.handleOf(msg.author.account, msg.author.display_name);
                  const cause: TurnCancelCause = r.selfStarted ? "superseded" : "input";
                  const merged = await this.#abort(r, cause, by);
                  running = null;
                  pending = [...merged, ...pending];
                  window = null;
                  restarts = r.selfStarted ? 0 : r.plan.focus.restarts + 1;
                }
              }
              // Someone calling her cuts into what she says on her own.
              if (kind !== null) {
                await this.#giveWay(kind === "reply" ? "reply" : "addressed", running, unplayed);
              }
              // Her speech that is written but not played yet is played as is (§3.9).
              pending.push(msg);
              let wait = voice && kind !== null ? cfg.voice.direct_debounce_ms : debounce;
              if (voice && msg.turn_complete === true) {
                wait = Math.min(wait, cfg.voice.turn_debounce_ms);
              }
              const opened: number = window?.opened ?? now;
              window = { opened, deadline: Math.min(now + wait, opened + maxDebounce), wait };
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
                  Math.max(window.deadline, now + window.wait),
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
                pending.length > 0 || waiting !== null,
                unplayed !== null && now < unplayed.since + cfg.voice.speak_ttl_ms,
                input.reply ?? null,
              );
              if (started) running = started;
              break;
            }
            case "yield": {
              const holder = this.#agent.mainline?.floor()?.holder(this.#key)?.turn ?? null;
              if (holder !== null) await this.#apply(input.level, holder, running);
              break;
            }
            case "halt": {
              if (running && !running.done) await this.#abort(running, "shutdown", null);
              running = null;
              if (unplayed) await this.#cancel(unplayed.turn);
              unplayed = null;
              if (waiting) {
                this.#agent.intentSkipped(this.#key, waiting, "the emergency stop");
                this.#cancelled(waiting.turn, "initiative", "shutdown");
              }
              waiting = null;
              pending = [];
              window = null;
              restarts = 0;
              break;
            }
            case "intent":
              if (waiting) {
                this.#agent.intentSkipped(this.#key, waiting, "replaced by a newer intent");
                this.#cancelled(waiting.turn, "initiative", "superseded");
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
              window.deadline = Math.min(now + window.wait, cap);
              break;
            }
          }
          window = null;
          const inputs = pending;
          pending = [];
          running = this.#start(inputs, null, signal, null, restarts);
          restarts = 0;
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
            // Still speaking: barge-in keeps seeing whom it was for.
            this.#agent.focusBoard.phase(r.turn, "speaking", cfg.voice.speak_ttl_ms);
          } else {
            this.#agent.focusBoard.end(r.turn);
          }
          if (voice && flags.queued && !flags.interrupted) {
            speaking = { turn: r.turn, flags, heard: now };
          }
          if (waiting !== null && !r.intent && (flags.committed || flags.queued)) {
            this.#agent.intentSkipped(this.#key, waiting, "she just answered here");
            this.#cancelled(waiting.turn, "initiative", "superseded");
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

  /** V3: a claim of `kind` arrives while she may be speaking here. */
  async #giveWay(
    kind: "addressed" | "reply",
    running: Running | null,
    unplayed: Unplayed | null,
  ): Promise<void> {
    const floor = this.#agent.mainline?.floor();
    const holder = floor?.holder(this.#key) ?? null;
    if (!floor || holder === null) return;
    // Her own turn still generating is `inputDisposition`'s: it restarts.
    if (running !== null && running.turn === holder.turn && !running.flags.queued) return;
    const turn = unplayed?.turn === holder.turn ? unplayed.turn : holder.turn;
    await this.#apply(floor.interruptLevel(kind, holder.kind), turn, running);
  }

  /** §7.3 on `turn`. */
  async #apply(level: InterruptLevel, turn: TurnId, running: Running | null): Promise<void> {
    if (level === "queue") return;
    if (running?.turn === turn) running.flags.yielded = true;
    this.#agent.log.debug({ turn, level }, "she gives way");
    await this.#cancel(turn);
    if (level === "wrap_up") return;
    const sink = this.#agent.ctx.services.get(ActionSinkKey);
    try {
      await sink?.interruptTurn?.(turn);
    } catch (error) {
      this.#agent.log.debug({ turn, error: errorMessage(error) }, "could not stop her speech");
    }
  }

  /** Starts her intent turn, unless it expired while waiting. */
  #intent(input: IntentTurn, signal: AbortSignal): Running | null {
    if (this.#now >= Date.parse(input.intent.expires_at)) {
      this.#agent.intentSkipped(this.#key, input, "expired");
      this.#cancelled(input.turn, "initiative", "expired");
      return null;
    }
    // The channel's level (checked again: another start may have come first). An intent the
    // Arbiter let through was checked there and booked as her start.
    if (!input.gated) {
      const blocked = this.#agent.startBlocked(this.#key);
      if (blocked !== null) {
        this.#agent.intentSkipped(this.#key, input, blocked);
        return null;
      }
      this.#agent.noteStart(this.#key);
    }
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

  /**
   * Handles an initiative request; returns the started turn, if any. With `reply` it is an
   * impulse the Arbiter accepted: the rules were the Arbiter's, only whether the place is free
   * is decided here (and told back through `reply`).
   */
  async #initiative(
    initiative: Initiative,
    turnRunning: boolean,
    messagesWaiting: boolean,
    speechQueued: boolean,
    reply: ((run: ImpulseRun) => void) | null,
  ): Promise<Running | null> {
    const busy = turnRunning
      ? "a turn is in flight"
      : messagesWaiting
        ? "messages are waiting for a turn"
        : speechQueued
          ? "her speech is still queued"
          : null;
    if (reply !== null) {
      if (busy !== null || (this.#voice && this.#session.someoneSpeaking())) {
        reply({ status: "busy", detail: busy ?? "someone is speaking" });
        return null;
      }
      const started = this.#start([], initiative, this.#agent.ctx.signal);
      reply({ status: "started", turn: started.turn, task: null, detail: "" });
      return started;
    }
    if (busy !== null) {
      this.#agent.initiativeSkipped(this.#key, initiative.reason, busy);
      return null;
    }
    // Live game commentary is rate-limited by the game director itself, and a result someone
    // is waiting for (`action_result`, `notice`) is no chatter to space out.
    const last =
      initiative.reason === "game" ||
      initiative.reason === "action_result" ||
      initiative.reason === "notice"
        ? null
        : this.#session.lastSelfAt();
    const capped = !UNCAPPED_INITIATIVES.includes(initiative.reason);
    if (last !== null) {
      const cooldown = this.#agent.afterSpeechMs(this.#key);
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

  /** What a new turn is for: its focus split and the focus record. */
  #plan(
    turn: TurnId,
    inputs: readonly IncomingMessage[],
    initiative: Initiative | null,
    restarts: number,
  ): TurnPlan {
    let selection: FocusSelection | null = null;
    let reason: TurnReason;
    if (inputs.length > 0) {
      const follows = answersHer(this.#session, inputs, this.#now);
      selection = selectFocus(inputs, (m) => this.#callKind(m), follows);
      reason = selection.reason;
    } else {
      reason = initiative?.reason === "notice" ? "notice" : "initiative";
    }
    const addressed = selection?.addressed ?? [];
    return {
      selection,
      focus: {
        turn,
        context: this.#key,
        reason,
        addressed_by: addressed.map((a) => this.#agent.handleOf(a.account, a.display_name)),
        addressed_accounts: addressed.map((a) => ({ ...a.account })),
        focus: (selection?.focus ?? []).map((m) => ({ ...m.id })),
        background: (selection?.background ?? []).map((m) => ({ ...m.id })),
        restarts,
      },
    };
  }

  #start(
    inputs: IncomingMessage[],
    initiative: Initiative | null,
    signal: AbortSignal,
    intent: IntentTurn | null = null,
    restarts = 0,
  ): Running {
    const turn = intent?.turn ?? newId();
    this.#agent.ctx.publish(
      { type: "agent_turn_started", data: { turn, context: this.#key } },
      { turn },
    );
    const plan = this.#plan(turn, inputs, initiative, restarts);
    this.#agent.focusBoard.start(plan.focus);
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
      flags,
      controller,
      promise: Promise.resolve(),
      done: false,
      plan,
      selfStarted: inputs.length === 0,
      intent: intent !== null,
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
      plan,
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
      this.#agent.focusBoard.end(turn);
      await this.#cancel(turn);
    }
    return resolved;
  }

  /** Drops the queued actions of `turn`. */
  async #cancel(turn: TurnId): Promise<void> {
    const sink = this.#agent.ctx.services.get(ActionSinkKey);
    if (sink) {
      try {
        await sink.cancelTurn(turn);
      } catch (error) {
        this.#agent.log.debug({ turn, error: errorMessage(error) }, "could not cancel turn");
      }
    }
    this.#agent.mainline?.lines.cancelUnstarted(turn, "the turn was cancelled");
  }

  /** The outcome of a turn that never ran or was stopped here. */
  #cancelled(
    turn: TurnId,
    reason: TurnReason,
    cause: TurnCancelCause,
    by: string | null = null,
    running: Running | null = null,
  ): void {
    const f = running?.plan.focus;
    this.#agent.focusBoard.end(turn);
    this.#agent.publishOutcome({
      turn,
      context: this.#key,
      reason: f?.reason ?? reason,
      outcome: { type: "cancelled", cause, by },
      addressed_by: [...(f?.addressed_by ?? [])],
      focus: (f?.focus ?? []).map((m) => ({ ...m })),
      restarts: f?.restarts ?? 0,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(this.#now),
    });
  }

  /** Cancels a turn whose reply was not committed yet; returns its inputs. */
  async #abort(
    running: Running,
    cause: TurnCancelCause,
    by: string | null,
  ): Promise<IncomingMessage[]> {
    running.controller.abort();
    this.#agent.log.debug(
      { turn: running.turn, context: contextId(this.#key), cause },
      cause === "shutdown" ? "turn stopped" : "turn cancelled by new input",
    );
    await this.#cancel(running.turn);
    this.#agent.ctx.publish(
      {
        type: "agent_turn_completed",
        data: { turn: running.turn, context: this.#key, text: "" },
      },
      { turn: running.turn },
    );
    this.#cancelled(running.turn, running.plan.focus.reason, cause, by, running);
    return running.inputs;
  }
}
