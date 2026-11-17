// A simulated clock for the scenario test: one queue of timed entries, run in order of time, then
// of when they were queued (as the Python recorder's scheduler does), each followed by everything
// it set off at that instant (all promise continuations) before the clock moves on. Nothing real
// waits: an hour of a job takes a second.

import type { Clock, Timers } from "../../src/arbiter/index.js";

interface Entry {
  t: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export class Sim {
  now = 0;
  #seq = 0;
  #queue: Entry[] = [];
  #stopped = false;
  /** Called after every entry and what it set off: the observer samples the state there. */
  afterEach: () => void = () => {};

  readonly clock: Clock = { now: () => this.now };
  readonly timers: Timers = { sleep: (s, signal) => this.sleep(s, signal) };

  at(t: number, fn: () => void): Entry {
    const entry: Entry = { t, seq: this.#seq++, fn, cancelled: false };
    this.#queue.push(entry);
    return entry;
  }

  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = this.at(this.now + seconds, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      const onAbort = (): void => {
        entry.cancelled = true;
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Starts `fn` at this instant, after what is already queued for it (a thread being started). */
  spawn(fn: () => Promise<void>, onError: (e: unknown) => void): void {
    this.at(this.now, () => {
      fn().catch(onError);
    });
  }

  stop(): void {
    this.#stopped = true;
  }

  async run(): Promise<void> {
    while (!this.#stopped) {
      let best: Entry | null = null;
      let at = -1;
      for (let i = 0; i < this.#queue.length; i++) {
        const e = this.#queue[i] as Entry;
        if (e.cancelled) continue;
        if (best === null || e.t < best.t || (e.t === best.t && e.seq < best.seq)) {
          best = e;
          at = i;
        }
      }
      if (best === null) throw new Error("deadlock: nothing left to run");
      this.#queue.splice(at, 1);
      this.#queue = this.#queue.filter((e) => !e.cancelled);
      this.now = Math.max(this.now, best.t);
      best.fn();
      await drain();
      this.afterEach();
    }
  }
}

/** `threading.Event` on the simulated clock: a waiter wakes when it is set, or at its timeout. */
export class SimEvent {
  flag = false;
  #waiters: { entry: Entry; resolve: (v: boolean) => void }[] = [];

  constructor(private readonly sim: Sim) {}

  set(): void {
    this.flag = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) {
      w.entry.cancelled = true;
      this.sim.at(this.sim.now, () => w.resolve(true));
    }
  }

  clear(): void {
    this.flag = false;
  }

  wait(timeoutS: number | null): Promise<boolean> {
    if (this.flag) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = {
        entry: this.sim.at(
          timeoutS === null ? Number.POSITIVE_INFINITY : this.sim.now + timeoutS,
          () => {
            this.#waiters = this.#waiters.filter((x) => x !== w);
            resolve(this.flag);
          },
        ),
        resolve,
      };
      this.#waiters.push(w);
    });
  }
}
