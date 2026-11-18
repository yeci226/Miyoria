// Small concurrency helpers (a watch cell, a bounded queue and a semaphore).

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** `Promise.withResolvers` (ES2024; the workspace targets ES2023 typings). */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A value whose changes can be awaited. */
export class Watch<T> {
  #value: T;
  #version = 0;
  #next = deferred<void>();

  constructor(value: T) {
    this.#value = value;
  }

  get value(): T {
    return this.#value;
  }

  /** Increases on every `set`. */
  get version(): number {
    return this.#version;
  }

  set(value: T): void {
    this.#value = value;
    this.#version++;
    const next = this.#next;
    this.#next = deferred<void>();
    next.resolve();
  }

  /** Resolves on the next `set`. Every caller before that shares one promise. */
  changed(): Promise<void> {
    return this.#next.promise;
  }

  /** Resolves with the first value (current or future) that matches. */
  async waitFor(predicate: (value: T) => boolean): Promise<T> {
    while (!predicate(this.#value)) await this.changed();
    return this.#value;
  }
}

/**
 * A bounded queue read with `for await` / `recv()`. `push` never waits:
 * it returns `false` and drops the item while the queue is full.
 */
export class BoundedQueue<T> implements AsyncIterableIterator<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  constructor(capacity: number, signal?: AbortSignal) {
    this.#capacity = Math.max(1, capacity);
    if (signal?.aborted) this.close();
    else signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get length(): number {
    return this.#items.length;
  }

  /** `false` when the item was dropped (queue full or closed). */
  push(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return true;
    }
    if (this.#items.length >= this.#capacity) return false;
    this.#items.push(item);
    return true;
  }

  /** The next item, or `null` once closed and drained. */
  async recv(): Promise<T | null> {
    const r = await this.next();
    return r.done ? null : r.value;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Stops delivery; buffered items are still read, then iteration ends. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    this.#items.length = 0;
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/** Counting semaphore. */
export class Semaphore {
  #permits: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#permits = Math.max(1, permits);
  }

  /** Takes a permit if one is free right now (never queues); returns its release function. */
  tryAcquire(): (() => void) | null {
    if (this.#permits <= 0) return null;
    this.#permits--;
    return once(() => {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#permits++;
    });
  }

  /** Waits for a permit; returns its release function. Rejects when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const release = once(() => {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#permits++;
    });
    if (this.#permits > 0) {
      this.#permits--;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const i = this.#waiters.indexOf(grant);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(signal?.reason);
      };
      this.#waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** A promise that resolves when `signal` aborts (never rejects). */
export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
