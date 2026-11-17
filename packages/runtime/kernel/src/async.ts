// Small async helpers. They use the global timers (never `node:timers/promises`), so Vitest fake
// timers control them.

/** Message of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

/** True for the errors `AbortSignal` produces (`AbortError` / `TimeoutError`). */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Rejects with `signal.reason` when `signal` is (or becomes) aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ticks every `ms` until `signal` aborts, then ends quietly (no throw). The first tick comes
 * after `ms`. Typical periodic task:
 *
 * ```ts
 * ctx.spawn("flush", async (signal) => {
 *   for await (const _ of interval(5_000, signal)) await store.flush();
 * });
 * ```
 */
export async function* interval(ms: number, signal: AbortSignal): AsyncGenerator<number> {
  for (let tick = 1; ; tick++) {
    try {
      await sleep(ms, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    yield tick;
  }
}

/** Resolves with the promise's value, or `undefined` after `ms` (the promise keeps running). */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs async functions one at a time, in call order (an async mutex). */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
