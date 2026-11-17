// One voice channel on the new runner: when its runs start, one at a time. The rules are the
// coordinator's for voice (agent/coordinator.ts), on the transcript instead of a `Session`:
//
// - a line that calls her opens a wait of `direct_debounce_ms`, anything else said in an open wait
//   pushes it out by `debounce_ms`. The wait counts from the person's last sound (the utterance's
//   end, `debounce_from_speech_end`), shortened to `turn_debounce_ms` when a model judged them done
//   (`turn_complete`), extended while someone is speaking, never past `max_debounce_ms` from its
//   start. Everyone who called her in one wait gets one run;
// - when someone called her and part of the wait is left (`speculate`), her run starts at once:
//   the prompt and the model run while the wait ends, and nothing of it is said or done before it
//   does (`VoiceRun.hold`). Anyone going on drops it without a trace and the merged run starts
//   over, at most `speculate_max_per_min` drops a minute;
// - a run is never restarted for new lines (speech that is written plays as is), except one she
//   started herself, which gives way to someone calling her;
// - someone calling her while her own earlier speech plays or waits cuts into it as far as the
//   Floor's interrupt level says (`wrap_up`: the rest is dropped; harder: the sentence playing
//   stops too). A claim from elsewhere (`yield`) and a barge-in (her speech `interrupted`) end the
//   run that speaks;
// - a glance (triage said one is due) waits for the same quiet; results wait until nothing runs,
//   nobody is talking and her last speech has played;
// - what the Arbiter admitted (a game's narration, a song's announcement, a notice) starts at once
//   in that same quiet or is answered `busy` (the Arbiter tries again), never queued; a run she
//   started herself that has handed nothing to the mouth gives way to it. One with a window
//   (`until`: a song's opening) that has handed nothing to the mouth when the window is over is
//   cancelled, not said late.

import type { IncomingMessage } from "@miyoria/types";
import {
  type AccountRef,
  type ContextKey,
  type FloorClaimKind,
  type InterruptLevel,
  inputDisposition,
  type PlaybackState,
  sameAccount,
  type TurnCancelCause,
  timestampMs,
} from "@miyoria/types";
import { type CallKind, callsHer, type VoiceConfig } from "../../agent/src/index.js";
import type { Wake } from "../../self/src/index.js";
import { type AdmittedInput, type LaneRun, selfStarted } from "./lane.js";

/** What a voice lane is told. */
export type VoiceInput =
  /** A line of the place, already in its transcript (`call`: how it relates to her). */
  | { type: "line"; msg: IncomingMessage; call: CallKind; glance: boolean; inert: boolean }
  /** Someone started or stopped speaking. */
  | { type: "speaking" }
  /** A sentence of hers of `turn` started, ended, was cut off or failed. */
  | { type: "playback"; turn: string; state: PlaybackState }
  /** Something she started came back. */
  | { type: "wake"; wake: Wake }
  /** What the Arbiter admitted, as its turn. */
  | AdmittedInput
  /** The window of an admitted run (`AdmittedInput.until`) is over. */
  | { type: "expired"; turn: string }
  /** A claim from elsewhere cuts into her speech here. */
  | { type: "yield"; level: InterruptLevel }
  /** The emergency stop. */
  | { type: "halt" };

/** A run the voice lane started. */
export interface VoiceRun extends LaneRun {
  /** When the newest of its lines reached the lane (clock ms). */
  heardAt: number | null;
  /** It started before the wait was over: it says and does nothing until this resolves. */
  hold: Promise<void> | null;
  /** It started early and was dropped: it never was (no record of it). */
  dropped: boolean;
}

/** What a voice lane needs from the host. */
export interface VoiceLaneHost {
  readonly context: ContextKey;
  now(): number;
  config(): VoiceConfig;
  newTurn(): string;
  someoneSpeaking(): boolean;
  /** The LLM budget lets her start early (`ok`). */
  budgetOk(): boolean;
  /** The Floor's hold on this place, if any. */
  holder(): { turn: string; kind: FloorClaimKind } | null;
  interruptLevel(incoming: FloorClaimKind, holder: FloorClaimKind): InterruptLevel;
  /** The wake of a run for `inputs`, the lines that called her (with what came between). */
  addressedWake(inputs: readonly IncomingMessage[]): Wake | null;
  /** The wake of a glance, or `null` when it is not due any more. */
  glanceWake(): Wake | null;
  /** Runs `run` to its end (never throws). */
  execute(run: VoiceRun): Promise<void>;
  /** A sentence of `turn` was handed to the mouth. */
  queued(turn: string): boolean;
  /** A sentence of `turn` started playing. */
  played(turn: string): boolean;
  /** Sentences of `turn` handed over and not started yet. */
  waiting(turn: string): boolean;
  /** Nothing more of `turn` is said (she was cut off, or gave way). */
  stop(turn: string): void;
  /** Drops what `turn` still has queued in the scheduler. */
  cancelQueued(turn: string): Promise<void>;
  /** Stops the sentence of `turn` that plays. */
  interrupt(turn: string): Promise<void>;
  /** Who stopped her speech of `turn` by talking over her. */
  bargedBy(turn: string): string | null;
  handleOf(author: IncomingMessage["author"]): string;
  /** A run that started early was confirmed or dropped, after `ms` from its start. */
  speculation(run: VoiceRun, result: "confirmed" | "dropped", ms: number): void;
  warn(what: string, error: unknown): void;
}

/** How long an aborted run is given to end before the next one starts anyway. */
const ABORT_WAIT_MS = 2_000;
/** How long a dropped early start is given to let go of the Floor before the merged run. */
const DROP_WAIT_MS = 1_000;
const MINUTE_MS = 60_000;

class Inbox {
  readonly #items: VoiceInput[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: VoiceInput): boolean {
    if (this.#closed) return false;
    this.#items.push(item);
    this.#wake();
    return true;
  }

  shift(): VoiceInput | undefined {
    return this.#items.shift();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  ready(): Promise<void> {
    if (this.#items.length > 0 || this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = this.#waiter;
      this.#waiter = () => {
        previous?.();
        resolve();
      };
    });
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

interface Running {
  run: VoiceRun;
  promise: Promise<void>;
  done: boolean;
  /** Whom it answers. */
  authors: AccountRef[];
  /** She started it herself (a glance, a timer): someone calling her supersedes it. */
  selfStarted: boolean;
  /** The Arbiter admitted it: another admitted claim does not cut it. */
  admitted: boolean;
  /** Started before the wait was over and not confirmed yet. */
  early: { confirm: () => void; startedAt: number } | null;
}

interface Window {
  opened: number;
  deadline: number;
  /** How long the window stays open past a sign of life. */
  wait: number;
}

type Next =
  | { type: "stop" }
  | { type: "input"; input: VoiceInput }
  | { type: "deadline" }
  | { type: "done" };

export class VoiceLane {
  readonly #host: VoiceLaneHost;
  readonly #inbox = new Inbox();
  /** Set once the lane ended. */
  ended = false;

  constructor(host: VoiceLaneHost) {
    this.#host = host;
  }

  push(input: VoiceInput): boolean {
    return this.#inbox.push(input);
  }

  close(): void {
    this.#inbox.close();
  }

  async run(signal: AbortSignal): Promise<void> {
    const host = this.#host;
    let pending: IncomingMessage[] = [];
    const calls = new Map<IncomingMessage, CallKind>();
    let glance = false;
    let window: Window | null = null;
    let running: Running | null = null;
    /** Her speech of a run that ended and has not started playing. */
    let unplayed: { turn: string; since: number } | null = null;
    let heardAt: number | null = null;
    /** When early starts were dropped in the last minute. */
    const dropped: number[] = [];
    const queued: Wake[] = [];
    try {
      for (;;) {
        // A run that started early still waits for the end of the window to speak.
        const timed = running === null || running.early !== null ? window : null;
        const next = await this.#next(signal, running, timed);
        const now = host.now();
        const cfg = host.config();
        const maxDebounce = Math.max(cfg.max_debounce_ms, cfg.debounce_ms);
        if (unplayed !== null && now >= unplayed.since + cfg.speak_ttl_ms) unplayed = null;
        switch (next.type) {
          case "stop":
            if (running !== null && !running.done) await this.#abort(running, "shutdown", null);
            return;
          case "done": {
            const r = running as Running;
            running = null;
            // An early start that ended on its own (it failed) took the window's lines with it.
            if (r.early !== null) window = null;
            if (host.waiting(r.run.turn)) unplayed = { turn: r.run.turn, since: now };
            break;
          }
          case "deadline": {
            if (window !== null) {
              const cap = window.opened + maxDebounce;
              if (now < cap && host.someoneSpeaking()) {
                window.deadline = Math.min(now + window.wait, cap);
                break;
              }
            }
            window = null;
            if (running?.early) {
              this.#confirm(running);
              break;
            }
            if (pending.length > 0) {
              const inputs = pending;
              pending = [];
              glance = false;
              const wake = host.addressedWake(inputs);
              if (wake !== null) running = this.#start(wake, inputs, heardAt, false);
            } else if (glance) {
              glance = false;
              const wake = host.glanceWake();
              if (wake !== null) running = this.#start(wake, [], heardAt, false);
            }
            break;
          }
          case "input": {
            const input = next.input;
            switch (input.type) {
              case "line": {
                if (input.inert) break;
                const msg = input.msg;
                const said = callsHer(input.call);
                if (said) calls.set(msg, input.call);
                // They went on while her run ran ahead of the wait: it is dropped and its lines
                // are merged with this, as the wait would have done.
                if (running?.early && !running.done) {
                  pending = [...(await this.#drop(running, dropped)), ...pending];
                  running = null;
                }
                if (running !== null && !running.done && !host.played(running.run.turn)) {
                  const r = running;
                  const disposition = inputDisposition({
                    phase: host.queued(r.run.turn) ? "speaking" : "generating",
                    voice: true,
                    addressesHer: said,
                    fromFocus: r.authors.some((a) => sameAccount(a, msg.author.account)),
                    text: msg.text,
                    restarts: r.run.restarts,
                    selfStarted: r.selfStarted,
                  });
                  if (disposition === "restart") {
                    await this.#abort(r, "superseded", host.handleOf(msg.author));
                    running = null;
                    pending = [...r.run.inputs, ...pending];
                    window = null;
                  }
                }
                // Someone calling her cuts into what she still says; a run that speaks it ends.
                if (said) {
                  const kind = input.call === "reply" ? "reply" : "addressed";
                  const stopped = await this.#giveWay(kind, running);
                  if (stopped !== null && running?.run.turn === stopped && !running.done) {
                    await this.#abort(running, "superseded", host.handleOf(msg.author));
                    running = null;
                  }
                }
                if (said) pending.push(msg);
                else if (input.glance) glance = true;
                if (said || input.glance || window !== null) {
                  let wait = said ? cfg.direct_debounce_ms : cfg.debounce_ms;
                  // The wait counts from their last sound: the node's silence and ASR were part
                  // of it already.
                  let from = now;
                  if (msg.turn_complete === true) wait = Math.min(wait, cfg.turn_debounce_ms);
                  else if (cfg.debounce_from_speech_end) from = Math.min(now, timestampMs(msg.ts));
                  const opened: number = window?.opened ?? now;
                  window = {
                    opened,
                    deadline: Math.min(Math.max(from + wait, now), opened + maxDebounce),
                    wait,
                  };
                  heardAt = now;
                }
                if (
                  running === null &&
                  unplayed === null &&
                  window !== null &&
                  this.#mayStartEarly(pending, window, dropped)
                ) {
                  const wake = host.addressedWake(pending);
                  if (wake !== null) {
                    running = this.#start(wake, pending, heardAt, true);
                    pending = [];
                  }
                }
                break;
              }
              case "speaking":
                // Started: do not answer over them. Stopped: give their transcript time to come.
                if (window !== null) {
                  window.deadline = Math.min(
                    Math.max(window.deadline, now + window.wait),
                    window.opened + maxDebounce,
                  );
                }
                break;
              case "playback":
                if (unplayed?.turn === input.turn && input.state !== "failed") unplayed = null;
                if (input.state === "interrupted") {
                  host.stop(input.turn);
                  await this.#cancel(input.turn);
                  if (running !== null && !running.done && running.run.turn === input.turn) {
                    await this.#abort(running, "barge_in", host.bargedBy(input.turn));
                    running = null;
                  }
                }
                break;
              case "wake":
                queued.push(input.wake);
                break;
              case "admitted": {
                let why: string | null = null;
                if (pending.length > 0 || window !== null) why = "lines are waiting for a run";
                else if (queued.length > 0) why = "something she started waits here";
                else if (unplayed !== null) why = "her speech is still queued";
                else if (host.someoneSpeaking()) why = "someone is speaking";
                else if (running !== null && !running.done) {
                  const r = running;
                  if (r.selfStarted && !r.admitted && !host.queued(r.run.turn)) {
                    await this.#abort(r, "superseded", null);
                    running = null;
                  } else {
                    why = "a run is in flight";
                  }
                }
                if (why !== null) {
                  input.answer({ status: "busy", why });
                  break;
                }
                const wake = input.wake();
                if (wake === null) {
                  input.answer({ status: "empty" });
                  break;
                }
                running = this.#start(wake, [], null, false, input.turn, true, input.until ?? null);
                input.answer({ status: "started" });
                break;
              }
              case "expired":
                // Past its window with nothing handed to the mouth: said now, it would be late.
                if (
                  running !== null &&
                  !running.done &&
                  running.run.turn === input.turn &&
                  !host.queued(input.turn)
                ) {
                  await this.#abort(running, "expired", null);
                  running = null;
                }
                break;
              case "yield": {
                // What speaks here gives way as far as the level says: the run that holds the
                // mic ends, and so does the speech of one that ended but still has some queued.
                const holder = host.holder();
                if (holder === null) break;
                await this.#cutInto(holder.turn, input.level);
                if (running !== null && running.run.turn === holder.turn) {
                  if (!running.done) await this.#abort(running, "superseded", null);
                  running = null;
                }
                break;
              }
              case "halt":
                if (running !== null && !running.done) await this.#abort(running, "shutdown", null);
                running = null;
                pending = [];
                calls.clear();
                glance = false;
                window = null;
                queued.length = 0;
                unplayed = null;
                break;
            }
            break;
          }
        }
        const speechWaits = unplayed !== null;
        if (
          running === null &&
          window === null &&
          pending.length === 0 &&
          queued.length > 0 &&
          !speechWaits &&
          !host.someoneSpeaking()
        ) {
          running = this.#start(queued.shift() as Wake, [], null, false);
        }
        const kept = new Set([...pending, ...((running as Running | null)?.run.inputs ?? [])]);
        for (const m of [...calls.keys()]) if (!kept.has(m)) calls.delete(m);
      }
    } finally {
      this.ended = true;
      this.#inbox.close();
    }
  }

  /**
   * Whether `pending` starts its run now rather than at the end of `window`: someone called her,
   * part of the wait is left, nobody is talking, the budget is fine, she holds no mic here and
   * fewer than `speculate_max_per_min` early starts were dropped in the last minute.
   */
  #mayStartEarly(pending: readonly IncomingMessage[], window: Window, dropped: number[]): boolean {
    const host = this.#host;
    const cfg = host.config();
    const now = host.now();
    if (!cfg.speculate || pending.length === 0 || window.deadline <= now) return false;
    if (host.someoneSpeaking() || !host.budgetOk() || host.holder() !== null) return false;
    while (dropped.length > 0 && (dropped[0] as number) <= now - MINUTE_MS) dropped.shift();
    return dropped.length < cfg.speculate_max_per_min;
  }

  #start(
    wake: Wake,
    inputs: IncomingMessage[],
    heardAt: number | null,
    early: boolean,
    turn: string | null = null,
    admitted = false,
    until: number | null = null,
  ): Running {
    const host = this.#host;
    let confirm: () => void = () => undefined;
    const hold = early
      ? new Promise<void>((resolve) => {
          confirm = resolve;
        })
      : null;
    const run: VoiceRun = {
      turn: turn ?? host.newTurn(),
      wake,
      inputs,
      restarts: 0,
      cancel: null,
      controller: new AbortController(),
      heardAt,
      hold,
      dropped: false,
    };
    const authors: AccountRef[] = [];
    for (const m of inputs) {
      if (!authors.some((a) => sameAccount(a, m.author.account))) authors.push(m.author.account);
    }
    const running: Running = {
      run,
      promise: Promise.resolve(),
      done: false,
      authors,
      selfStarted: selfStarted(wake),
      admitted,
      early: early ? { confirm, startedAt: host.now() } : null,
    };
    const expiry =
      until === null
        ? undefined
        : setTimeout(
            () => this.push({ type: "expired", turn: run.turn }),
            Math.max(until - host.now(), 0),
          );
    running.promise = host
      .execute(run)
      .catch((error: unknown) => host.warn("a voice run failed", error))
      .finally(() => {
        running.done = true;
        clearTimeout(expiry);
      });
    return running;
  }

  /** The wait is over and nobody went on: the run that started early may speak. */
  #confirm(running: Running): void {
    const early = running.early;
    if (early === null) return;
    running.early = null;
    early.confirm();
    this.#host.speculation(running.run, "confirmed", this.#host.now() - early.startedAt);
  }

  /** They went on before the wait was over: the run that started early never was. */
  async #drop(running: Running, dropped: number[]): Promise<IncomingMessage[]> {
    const host = this.#host;
    const early = running.early;
    running.early = null;
    running.run.dropped = true;
    running.run.controller.abort();
    await this.#cancel(running.run.turn);
    await settle(running.promise, DROP_WAIT_MS);
    const now = host.now();
    dropped.push(now);
    host.speculation(running.run, "dropped", early === null ? 0 : now - early.startedAt);
    return running.run.inputs;
  }

  /**
   * Someone calling her (`kind`) cuts into her speech that holds the mic here (§7.3). Returns the
   * turn it stopped, if any.
   */
  async #giveWay(kind: FloorClaimKind, running: Running | null): Promise<string | null> {
    const host = this.#host;
    const holder = host.holder();
    if (holder === null) return null;
    // Her run still writing is `inputDisposition`'s.
    if (running !== null && running.run.turn === holder.turn && !host.queued(holder.turn)) {
      return null;
    }
    const level = host.interruptLevel(kind, holder.kind);
    if (level === "queue") return null;
    await this.#cutInto(holder.turn, level);
    return holder.turn;
  }

  /** `turn`'s speech gives way: nothing more is said, the rest is dropped; harder, the playing one stops. */
  async #cutInto(turn: string, level: InterruptLevel): Promise<void> {
    const host = this.#host;
    host.stop(turn);
    await this.#cancel(turn);
    if (level === "wrap_up") return;
    try {
      await host.interrupt(turn);
    } catch (error) {
      host.warn("could not stop her speech", error);
    }
  }

  async #cancel(turn: string): Promise<void> {
    try {
      await this.#host.cancelQueued(turn);
    } catch (error) {
      this.#host.warn("could not cancel a run's speech", error);
    }
  }

  async #abort(running: Running, cause: TurnCancelCause, by: string | null): Promise<void> {
    running.run.cancel = { cause, by };
    running.run.controller.abort();
    await this.#cancel(running.run.turn);
    await settle(running.promise, ABORT_WAIT_MS);
  }

  async #next(signal: AbortSignal, running: Running | null, window: Window | null): Promise<Next> {
    for (;;) {
      if (signal.aborted) return { type: "stop" };
      if (running?.done) return { type: "done" };
      const input = this.#inbox.shift();
      if (input) return { type: "input", input };
      if (this.#inbox.closed) return { type: "stop" };
      if (window && this.#host.now() >= window.deadline) return { type: "deadline" };
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
        const ms = Math.max(window.deadline - this.#host.now(), 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      try {
        await Promise.race(waits);
      } finally {
        for (const t of timers) clearTimeout(t);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

/** Waits for `promise`, at most `ms`. */
async function settle(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
