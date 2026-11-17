// The warm pool: fresh runs started ahead of time, per language. A pooled container is exactly
// the `docker run` of a fresh run, flags and all, whose command first waits for one line on
// stdin (`standbyCommand`); the run writes its program and inputs into the mounted workspace,
// sends that line and the program's stdin, and the container ends with the program. So a pooled
// container serves exactly one run by construction, and `take` hands each out once. The model
// never sees the pool: a run without a ready container starts one as before.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { ExecResult } from "./runner.js";
import type { Language } from "./types.js";
import type { RunDirs } from "./workspace.js";

const log = getLogger("sandbox.pool");

/** A started container waiting for its one program. */
export interface Standby {
  /** Run id of the run it will serve (its workspace is `runs/<id>`). */
  id: string;
  /** Container name. */
  name: string;
  language: Language;
  dirs: RunDirs;
  /** The `docker run` CLI's result: it settles when the container is gone. */
  result: Promise<ExecResult>;
  /** The container ended before its run (it died, or Docker went away). */
  exited: boolean;
  /**
   * Starts the program: sends the go line and `stdin`, and hands the run's kill switches to the
   * waiting CLI (`signal` drops it, `onOutputLimit` fires past `caps.kill_output_bytes`).
   */
  go(
    stdin: string,
    wiring: { signal: AbortSignal; onOutputLimit: () => void },
  ): Promise<ExecResult>;
  /** Drops the waiting CLI (the container is removed by name first). */
  abort(): void;
}

export interface WarmPoolOptions {
  /** Containers kept ready per language. */
  size: number;
  languages: readonly Language[];
  /** Starts one (throws when it cannot). */
  start(language: Language): Promise<Standby>;
  /** Destroys one that will never run (container and workspace). */
  discard(entry: Standby): Promise<void>;
}

/** Counters for tests and the status line. */
export interface PoolStats {
  ready: Record<Language, number>;
  /** Containers being started. */
  starting: number;
  /** Runs served from the pool. */
  served: number;
  /** Containers started (served, ready or discarded). */
  started: number;
}

export class WarmPool {
  readonly #o: WarmPoolOptions;
  readonly #ready = new Map<Language, Standby[]>();
  readonly #starting = new Map<Language, number>();
  readonly #pending = new Set<Promise<unknown>>();
  #enabled = false;
  #closed = false;
  #served = 0;
  #started = 0;

  constructor(options: WarmPoolOptions) {
    this.#o = options;
    for (const language of options.languages) {
      this.#ready.set(language, []);
      this.#starting.set(language, 0);
    }
  }

  get stats(): PoolStats {
    const ready = {} as Record<Language, number>;
    for (const [language, list] of this.#ready) {
      ready[language] = list.filter((entry) => !entry.exited).length;
    }
    let starting = 0;
    for (const n of this.#starting.values()) starting += n;
    return { ready, starting, served: this.#served, started: this.#started };
  }

  /** Starts filling (after startup reaped the leftovers); later `fill` calls top it up. */
  enable(): void {
    if (this.#closed || this.#o.size === 0) return;
    this.#enabled = true;
    this.fill();
  }

  /**
   * Starts containers until each language has `size` ready or starting. A failed start is not
   * retried until the next call (a run, or a successful Docker health check).
   */
  fill(): void {
    if (!this.#enabled || this.#closed) return;
    for (const language of this.#o.languages) this.#fill(language);
  }

  #fill(language: Language): void {
    const ready = this.#ready.get(language) ?? [];
    while (ready.length + (this.#starting.get(language) ?? 0) < this.#o.size) {
      this.#starting.set(language, (this.#starting.get(language) ?? 0) + 1);
      const task = this.#o.start(language).then(
        async (entry) => {
          this.#started++;
          this.#starting.set(language, (this.#starting.get(language) ?? 1) - 1);
          if (this.#closed || !this.#enabled) await this.#discard(entry);
          else ready.push(entry);
        },
        (error: unknown) => {
          this.#starting.set(language, (this.#starting.get(language) ?? 1) - 1);
          if (!this.#closed) {
            log.warn({ language, err: errorMessage(error) }, "cannot start a pooled container");
          }
        },
      );
      this.#track(task);
    }
  }

  #track(task: Promise<unknown>): void {
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  #discard(entry: Standby): Promise<void> {
    return this.#o.discard(entry).catch((error: unknown) => {
      log.warn({ container: entry.name, err: errorMessage(error) }, "cannot discard a container");
    });
  }

  /**
   * A ready container for `language`, removed from the pool for good (the caller destroys it
   * after its run), or `null`. Starts its replacement.
   */
  take(language: Language): Standby | null {
    if (!this.#enabled || this.#closed) return null;
    const ready = this.#ready.get(language) ?? [];
    let entry = ready.shift() ?? null;
    while (entry?.exited) {
      void this.#discard(entry);
      entry = ready.shift() ?? null;
    }
    if (entry) this.#served++;
    this.#fill(language);
    return entry;
  }

  /** Destroys every ready container (Docker went away or came back: they may be gone). */
  discardAll(): Promise<void> {
    const all = [...this.#ready.values()].flatMap((list) => list.splice(0));
    const task = Promise.all(all.map((entry) => this.#discard(entry))).then(() => undefined);
    this.#track(task);
    return task;
  }

  /** Stops filling and destroys every container it holds (module stop). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#enabled = false;
    await this.discardAll();
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
