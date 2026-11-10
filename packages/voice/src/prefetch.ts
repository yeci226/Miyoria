// TTS prefetch: the next lines of a reply are synthesized while the current one plays.
//
// `prepare` tells the voice sink a line is coming; the line's turn at `speak` comes later, after
// the lines before it were played. Synthesizing at `prepare` time hides the TTS latency of every
// line after the first. At most `limit` lines are synthesized at once (the TTS worker is a
// shared GPU), unclaimed lines expire, and a line nobody takes can be cancelled together with the
// rest of its guild's (barge-in, a song taking the floor).

import type { AudioChunk } from "@miyoria/speech";
import type { TtsTiming } from "./e2e.js";
import { Semaphore } from "./util.js";

/** Audio that is produced in the background and read from the start by one consumer. */
export class BufferedAudio implements AsyncIterable<AudioChunk> {
  readonly #chunks: AudioChunk[] = [];
  readonly #waiters: Array<() => void> = [];
  #ended = false;
  #error: unknown = null;
  #failed = false;
  #abandoned = false;
  /** Everything arrived before anyone gave up on it. */
  #whole = false;
  readonly #onAbandon: () => void;

  /** `onAbandon` runs when the consumer stops reading before the end. */
  constructor(onAbandon: () => void = () => undefined) {
    this.#onAbandon = onAbandon;
  }

  get abandoned(): boolean {
    return this.#abandoned;
  }

  push(chunk: AudioChunk): void {
    if (this.#ended) return;
    this.#chunks.push(chunk);
    this.#wake();
  }

  /** No more audio is coming. `whole`: because all of it came, not because it was stopped. */
  end(whole = true): void {
    this.#whole = whole && !this.#ended && !this.#abandoned;
    this.#ended = true;
    this.#wake();
  }

  /** How long the whole line is, in ms; `null`: it was not all there when it ended. */
  get totalMs(): number | null {
    if (!this.#whole) return null;
    const ms = this.#chunks.reduce((sum, c) => sum + (c.samples.length / c.sampleRate) * 1000, 0);
    return Math.round(ms);
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#failed = true;
    this.#error = error;
    this.#wake();
  }

  #wake(): void {
    for (const w of this.#waiters.splice(0)) w();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AudioChunk> {
    let at = 0;
    const self = this;
    const it: AsyncIterableIterator<AudioChunk> = {
      async next() {
        for (;;) {
          if (self.#abandoned) return { value: undefined, done: true };
          const chunk = self.#chunks[at];
          if (chunk !== undefined) {
            at++;
            return { value: chunk, done: false };
          }
          if (self.#ended) {
            if (self.#failed) throw self.#error;
            return { value: undefined, done: true };
          }
          await new Promise<void>((resolve) => self.#waiters.push(resolve));
        }
      },
      async return() {
        if (!self.#abandoned && !(self.#ended && at >= self.#chunks.length)) {
          self.#abandoned = true;
          self.#onAbandon();
          self.#wake();
        }
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return it;
      },
    };
    return it;
  }
}

/** A line whose first audio is ready; the rest keeps arriving in `audio`. */
export interface PreparedLine {
  provider: string;
  /** What was sent to TTS. */
  said: string;
  /** It is the filtered line: moderation stopped the text or its translation (the rule). */
  blocked?: string | null;
  sampleRate: number;
  audio: BufferedAudio;
  /** When the TTS request went out and its first audio came (latency metric). */
  timing?: TtsTiming;
}

/**
 * What a producer returns: the line once its first audio is there, and `done` which settles
 * when the whole line was synthesized (or abandoned / failed): the concurrency slot is held
 * until then.
 */
export interface Production {
  line: PreparedLine;
  done: Promise<void>;
}

export type Producer = (signal: AbortSignal) => Promise<Production>;

interface Entry {
  group: string;
  controller: AbortController;
  result: Promise<PreparedLine>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PrefetchOptions {
  /** Lines synthesized at the same time. */
  limit: number;
  /** A line nobody took is dropped after this long. */
  ttlMs: number;
  /** Aborts everything (module stop). */
  signal?: AbortSignal;
}

/** The cache of lines being synthesized ahead of their turn. */
export class LinePrefetch {
  readonly #o: PrefetchOptions;
  readonly #slots: Semaphore;
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;

  constructor(options: PrefetchOptions) {
    this.#o = options;
    this.#slots = new Semaphore(Math.max(1, options.limit));
    this.#maxEntries = Math.max(1, options.limit) * 2;
    options.signal?.addEventListener("abort", () => this.clear(), { once: true });
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Starts synthesizing `key` (in `group`, e.g. the guild) unless it is already there. Lines
   * start in the order they were asked for, `limit` at a time; past `2 × limit` held lines the
   * oldest is dropped.
   */
  start(key: string, group: string, produce: Producer): void {
    if (this.#entries.has(key) || this.#o.signal?.aborted) return;
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#drop(oldest);
    }
    const controller = new AbortController();
    const result = this.#run(controller, produce);
    // A line nobody takes must not leave an unhandled rejection behind.
    result.catch(() => undefined);
    const entry: Entry = { group, controller, result, timer: null };
    if (this.#o.ttlMs > 0) {
      entry.timer = setTimeout(() => this.#drop(key), this.#o.ttlMs);
      entry.timer.unref?.();
    }
    this.#entries.set(key, entry);
  }

  async #run(controller: AbortController, produce: Producer): Promise<PreparedLine> {
    const release = await this.#slots.acquire(controller.signal);
    let production: Production;
    try {
      production = await produce(controller.signal);
    } catch (error) {
      release();
      throw error;
    }
    void production.done.then(release, release);
    return production.line;
  }

  /**
   * Takes the line for `key` out of the cache (once): resolves with it when its first audio is
   * ready, rejects when producing it failed. `null` when nothing was prefetched.
   */
  take(key: string): Promise<PreparedLine> | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    if (entry.timer !== null) clearTimeout(entry.timer);
    return entry.result;
  }

  /** Drops every line of `group` (and stops synthesizing them). */
  cancelGroup(group: string): void {
    for (const [key, entry] of [...this.#entries]) {
      if (entry.group === group) this.#drop(key);
    }
  }

  clear(): void {
    for (const key of [...this.#entries.keys()]) this.#drop(key);
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.controller.abort(new Error("prefetch cancelled"));
    // A line that was already produced holds a TTS stream: let go of it.
    entry.result.then(
      (line) => void line.audio[Symbol.asyncIterator]().return?.(),
      () => undefined,
    );
  }
}
