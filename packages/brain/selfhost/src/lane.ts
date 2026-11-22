// One text place on the new runner: when its runs start, one at a time.
//
// The rules are the coordinator's for text (agent/coordinator.ts), on the transcript instead of a
// `Session`:
//
// - a line said to her opens a wait (`debounce_ms`), pushed out by more lines and by typing
//   (`typing_extend_ms`), never past `max_debounce_ms` from its start; what arrives meanwhile is
//   merged into the same run;
// - several people calling her in one wait get a run each, in the order they called
//   (`oneCaller`, with `one_caller_per_turn`);
// - one run per place at a time. A line during a run goes by `inputDisposition`: the person the
//   run answers adding something substantial restarts it (at most `MAX_TURN_RESTARTS` times), and
//   someone calling her cuts a run she started herself (a glance, a timer); anything else waits
//   for the next run. Once a line of the run reached someone, nothing restarts it;
// - a glance (triage said one is due) waits for the same quiet as a line said to her, and a run
//   for someone who called her takes it along;
// - results and due timers wait until nothing runs and nobody is waiting for an answer;
// - what the Arbiter admitted (a game's narration, a song's announcement, a notice) is never
//   queued: it starts at once when the place is free, or is answered `busy` and the Arbiter tries
//   again, most urgent first, as the old coordinator answered it. A run she started herself (a
//   glance, a timer, a world event) that has said nothing yet gives way to it, as the old path
//   ordered her own starts after these.
//
// The lines themselves are in the transcript already (the host appends them as they come); a run
// reads them there.

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  type IncomingMessage,
  inputDisposition,
  sameAccount,
  type TurnCancelCause,
} from "@miyoria/types";
import { type CallKind, callsHer, oneCaller } from "../../agent/src/index.js";
import type { Wake } from "../../self/src/index.js";

/** What a lane is told. */
export type LaneInput =
  /**
   * A line of the place, already in its transcript. `call`: how it relates to her, when it wakes
   * her; `glance`: triage gave it a glance; `inert`: it moves nothing (a bot's, a flagged one, a
   * muted place's).
   */
  | { type: "line"; msg: IncomingMessage; call: CallKind; glance: boolean; inert: boolean }
  | { type: "typing" }
  /** Something she started came back, or a timer of hers is due. */
  | { type: "wake"; wake: Wake }
  /** What the Arbiter admitted, as `turn` (`AdmittedInput`). */
  | AdmittedInput
  /** The emergency stop. */
  | { type: "halt" };

/**
 * Something the Arbiter admitted that wants a run here now, as `turn`. `wake` is asked only when
 * it starts (`null`: nothing is left to say); `answer` is called once. `until` (clock ms): a run
 * that has not handed a line to the mouth by then is not worth finishing (a voice lane's, for
 * what must come before something else starts); unset: it runs as long as it takes.
 */
export interface AdmittedInput {
  type: "admitted";
  turn: string;
  wake: () => Wake | null;
  until?: number;
  answer: (answer: AdmittedAnswer) => void;
}

/** How a lane took what the Arbiter admitted. */
export type AdmittedAnswer =
  | { status: "started" }
  /** The place cannot take it now: the Arbiter tries again. */
  | { status: "busy"; why: string }
  /** It had nothing left to say by the time it could start. */
  | { status: "empty" };

/** Whether `wake` is a start of hers that someone calling her (or an admitted claim) may cut. */
export function selfStarted(wake: Wake): boolean {
  return (
    wake.kind === "glance" || wake.kind === "timer" || wake.kind === "self" || wake.kind === "world"
  );
}

/** A run the lane started. */
export interface LaneRun {
  turn: string;
  wake: Wake;
  /** The lines it answers (addressed runs). */
  inputs: IncomingMessage[];
  restarts: number;
  /** Why it was cut, when the lane cut it. */
  cancel: { cause: TurnCancelCause; by: string | null } | null;
  controller: AbortController;
}

/** What a lane needs from the host. */
export interface LaneHost {
  readonly context: ContextKey;
  now(): number;
  debounceMs(): number;
  maxDebounceMs(): number;
  typingExtendMs(): number;
  oneCallerPerTurn(): boolean;
  /** Idle this long, the lane ends. */
  idleMs(): number;
  /** A new turn id. */
  newTurn(): string;
  /** The wake of a run for `inputs`, the lines one caller said to her (with what came between). */
  addressedWake(inputs: readonly IncomingMessage[]): Wake | null;
  /** The wake of a glance, or `null` when it is not due any more. */
  glanceWake(): Wake | null;
  /** Runs `run` to its end (never throws). */
  execute(run: LaneRun): Promise<void>;
  /** Lines of `turn` that reached someone so far. */
  delivered(turn: string): number;
  /** Drops what `turn` still has queued in the scheduler. */
  cancelQueued(turn: string): Promise<void>;
  /** The handle of who cut a run. */
  handleOf(author: IncomingMessage["author"]): string;
  warn(what: string, error: unknown): void;
}

/** How long an aborted run is given to end before the next one starts anyway. */
const ABORT_WAIT_MS = 2_000;

class Inbox {
  readonly #items: LaneInput[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: LaneInput): boolean {
    if (this.#closed) return false;
    this.#items.push(item);
    this.#wake();
    return true;
  }

  shift(): LaneInput | undefined {
    return this.#items.shift();
  }

  get empty(): boolean {
    return this.#items.length === 0;
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
  run: LaneRun;
  promise: Promise<void>;
  done: boolean;
  /** Whom it answers: their lines may restart it. */
  authors: AccountRef[];
  /** She started it herself (a glance, a timer): someone calling her cuts it. */
  selfStarted: boolean;
  /** The Arbiter admitted it: another admitted claim does not cut it. */
  admitted: boolean;
}

interface Window {
  opened: number;
  deadline: number;
}

type Next =
  | { type: "stop" }
  | { type: "input"; input: LaneInput }
  | { type: "deadline" }
  | { type: "done" }
  | { type: "idle" };

export class Lane {
  readonly #host: LaneHost;
  readonly #inbox = new Inbox();
  /** Set once the lane ended (idle, or stopped). */
  ended = false;
  /** Nothing runs, waits or is queued here (kept by `run`). */
  #still = true;

  constructor(host: LaneHost) {
    this.#host = host;
  }

  push(input: LaneInput): boolean {
    return this.#inbox.push(input);
  }

  close(): void {
    this.#inbox.close();
  }

  /**
   * Nothing runs, waits for a run or is queued in this place, and no input is waiting to be
   * read: a line taken in now would start the only run here.
   */
  get quiet(): boolean {
    return !this.ended && this.#still && this.#inbox.empty;
  }

  async run(signal: AbortSignal): Promise<void> {
    const host = this.#host;
    let pending: IncomingMessage[] = [];
    const calls = new Map<IncomingMessage, CallKind>();
    let glance = false;
    let window: Window | null = null;
    let running: Running | null = null;
    let restarts = 0;
    const queued: Wake[] = [];
    const kind = (m: IncomingMessage): CallKind => calls.get(m) ?? null;
    try {
      for (;;) {
        const idle = pending.length === 0 && !glance && running === null && queued.length === 0;
        this.#still = idle && window === null;
        const next = await this.#next(signal, running, running === null ? window : null, idle);
        const now = host.now();
        switch (next.type) {
          case "stop":
            if (running !== null && !running.done) await this.#abort(running, "shutdown", null);
            return;
          case "idle":
            if (this.#inbox.empty) return;
            break;
          case "done":
            running = null;
            break;
          case "deadline": {
            window = null;
            if (pending.length > 0) {
              const { now: inputs, later } = host.oneCallerPerTurn()
                ? oneCaller(pending, kind)
                : { now: pending, later: [] };
              pending = later;
              // The next caller's run starts as soon as this one is done.
              if (later.length > 0) window = { opened: now, deadline: now };
              glance = false;
              const wake = host.addressedWake(inputs);
              if (wake !== null) {
                running = this.#start(
                  wake,
                  inputs,
                  restarts,
                  inputs.filter((m) => callsHer(kind(m))),
                );
              }
              restarts = 0;
            } else if (glance) {
              glance = false;
              const wake = host.glanceWake();
              if (wake !== null) running = this.#start(wake, [], 0, []);
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
                let merged = false;
                if (running !== null && !running.done) {
                  const r = running;
                  const disposition = inputDisposition({
                    phase: host.delivered(r.run.turn) > 0 ? "speaking" : "generating",
                    voice: false,
                    addressesHer: said,
                    fromFocus: r.authors.some((a) => sameAccount(a, msg.author.account)),
                    text: msg.text,
                    restarts: r.run.restarts,
                    selfStarted: r.selfStarted,
                  });
                  if (disposition === "restart") {
                    const cause: TurnCancelCause = r.selfStarted ? "superseded" : "input";
                    await this.#abort(r, cause, host.handleOf(msg.author));
                    running = null;
                    pending = [...r.run.inputs, ...pending];
                    window = null;
                    restarts = r.selfStarted ? 0 : r.run.restarts + 1;
                    // Their next line is part of what the merged run answers.
                    merged = !said && pending.length > 0;
                  }
                }
                if (said || merged) pending.push(msg);
                else if (input.glance) glance = true;
                // Every line pushes the wait out, as the coordinator's did: people are still talking.
                if (said || merged || input.glance || window !== null) {
                  const opened: number = window?.opened ?? now;
                  window = {
                    opened,
                    deadline: Math.min(now + host.debounceMs(), opened + host.maxDebounceMs()),
                  };
                }
                break;
              }
              case "typing":
                if (window !== null) {
                  window.deadline = Math.min(
                    Math.max(window.deadline, now + host.typingExtendMs()),
                    window.opened + host.maxDebounceMs(),
                  );
                }
                break;
              case "wake":
                queued.push(input.wake);
                break;
              case "admitted": {
                let why: string | null = null;
                if (pending.length > 0 || window !== null) why = "lines are waiting for a run";
                else if (queued.length > 0) why = "something she started waits here";
                else if (running !== null && !running.done) {
                  const r = running;
                  if (r.selfStarted && !r.admitted && host.delivered(r.run.turn) === 0) {
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
                running = this.#start(wake, [], 0, [], input.turn, true);
                input.answer({ status: "started" });
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
                restarts = 0;
                break;
            }
            break;
          }
        }
        if (running === null && window === null && pending.length === 0 && queued.length > 0) {
          const wake = queued.shift() as Wake;
          running = this.#start(wake, [], 0, []);
        }
        const kept = new Set([...pending, ...((running as Running | null)?.run.inputs ?? [])]);
        for (const m of [...calls.keys()]) if (!kept.has(m)) calls.delete(m);
      }
    } finally {
      this.ended = true;
      this.#still = true;
      this.#inbox.close();
    }
  }

  #start(
    wake: Wake,
    inputs: IncomingMessage[],
    restarts: number,
    callers: readonly IncomingMessage[],
    turn: string | null = null,
    admitted = false,
  ): Running {
    const run: LaneRun = {
      turn: turn ?? this.#host.newTurn(),
      wake,
      inputs,
      restarts,
      cancel: null,
      controller: new AbortController(),
    };
    const authors: AccountRef[] = [];
    for (const m of callers) {
      if (!authors.some((a) => sameAccount(a, m.author.account))) authors.push(m.author.account);
    }
    const running: Running = {
      run,
      promise: Promise.resolve(),
      done: false,
      authors,
      selfStarted: selfStarted(wake),
      admitted,
    };
    running.promise = this.#host
      .execute(run)
      .catch((error: unknown) => this.#host.warn("a run failed", error))
      .finally(() => {
        running.done = true;
      });
    return running;
  }

  async #abort(running: Running, cause: TurnCancelCause, by: string | null): Promise<void> {
    running.run.cancel = { cause, by };
    running.run.controller.abort();
    try {
      await this.#host.cancelQueued(running.run.turn);
    } catch (error) {
      this.#host.warn("could not cancel a run's lines", error);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ABORT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  async #next(
    signal: AbortSignal,
    running: Running | null,
    window: Window | null,
    idle: boolean,
  ): Promise<Next> {
    let idleFired = false;
    for (;;) {
      if (signal.aborted) return { type: "stop" };
      if (running?.done) return { type: "done" };
      const input = this.#inbox.shift();
      if (input) return { type: "input", input };
      if (this.#inbox.closed) return { type: "stop" };
      if (window && this.#host.now() >= window.deadline) return { type: "deadline" };
      if (idleFired) return { type: "idle" };
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
      if (idle) {
        waits.push(
          new Promise<void>((resolve) =>
            timers.push(
              setTimeout(() => {
                idleFired = true;
                resolve();
              }, this.#host.idleMs()),
            ),
          ),
        );
      }
      try {
        await Promise.race(waits);
      } catch (error) {
        this.#host.warn("a lane wait failed", errorMessage(error));
      } finally {
        for (const t of timers) clearTimeout(t);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
