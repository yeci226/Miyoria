/** Counting semaphore with a bounded wait queue; waiting honours an `AbortSignal`. */
export class Semaphore {
  #free: number;
  readonly #waiters: Array<() => void> = [];

  constructor(
    permits: number,
    readonly maxQueued: number,
  ) {
    this.#free = permits;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * Resolves with a release function once a permit is free. Returns `null` when the queue is
   * full; rejects with `signal.reason` when it aborts while waiting.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#releaser());
    }
    if (this.#waiters.length >= this.maxQueued) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.#releaser());
      };
      const onAbort = () => {
        const i = this.#waiters.indexOf(wake);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(signal?.reason);
      };
      this.#waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    };
  }
}
