// Keeping a client link up (docs/design/v5-hostd.md §6.1): backoff from 1 s doubling to 30 s
// with jitter, a watchdog for a server gone silent, and the close-code policy that says when a
// link must not be dialled again. Nothing here knows about hostd: the voice node and the stage
// node can move their own links onto it (listed for H12).

/** How long to wait before the next attempt. */
export interface BackoffOptions {
  /** The first wait. Default 1 000 ms. */
  initialMs?: number;
  /** The longest wait. Default 30 000 ms. */
  maxMs?: number;
  /** Each wait is moved by up to this fraction either way, so many clients do not dial at once. Default 0.2. */
  jitter?: number;
  /** Default `Math.random`. */
  random?: () => number;
}

/** Waits that double from `initialMs` up to `maxMs`, each with jitter. */
export class Backoff {
  readonly #initial: number;
  readonly #max: number;
  readonly #jitter: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#initial = Math.max(1, options.initialMs ?? 1_000);
    this.#max = Math.max(this.#initial, options.maxMs ?? 30_000);
    this.#jitter = Math.min(1, Math.max(0, options.jitter ?? 0.2));
    this.#random = options.random ?? Math.random;
  }

  /** Attempts since the last `reset`. */
  get attempt(): number {
    return this.#attempt;
  }

  /** The next wait, in ms. */
  next(): number {
    const base = Math.min(this.#max, this.#initial * 2 ** Math.min(this.#attempt, 30));
    this.#attempt++;
    const spread = base * this.#jitter * (this.#random() * 2 - 1);
    return Math.round(Math.min(this.#max, Math.max(0, base + spread)));
  }

  /** Back to the first wait: after a connection that got through. */
  reset(): void {
    this.#attempt = 0;
  }
}

/** How one connection ended. */
export interface SessionEnd {
  /** Dial again. */
  retry: boolean;
  /** It got through (the handshake finished): the backoff starts over. */
  established: boolean;
}

export interface ReconnectOptions extends BackoffOptions {
  /** Runs one connection until it ends. Should end soon after `signal` aborts. */
  session(signal: AbortSignal): Promise<SessionEnd>;
  /** Stops the loop: the running session sees its signal abort, no wait follows. */
  signal: AbortSignal;
  /** Told before each wait. */
  onWait?(delayMs: number, attempt: number): void;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs sessions one after another until one says not to retry or `signal` aborts, waiting by the
 * backoff between them. A session that throws counts as one that ended without getting through.
 */
export async function reconnectLoop(options: ReconnectOptions): Promise<void> {
  const backoff = new Backoff(options);
  const { signal } = options;
  while (!signal.aborted) {
    let end: SessionEnd;
    try {
      end = await options.session(signal);
    } catch {
      end = { retry: true, established: false };
    }
    if (!end.retry || signal.aborted) return;
    if (end.established) backoff.reset();
    const delay = backoff.next();
    options.onWait?.(delay, backoff.attempt);
    await sleep(delay, signal);
  }
}

/** Whether a close code allows dialling again: not when it is one of `final`. */
export function mayRetry(code: number, final: readonly number[]): boolean {
  return !final.includes(code);
}

/**
 * Calls `onSilent` when `bump` has not been called for `ms`: a server that stopped sending, even
 * pings, is gone although the socket has not noticed.
 */
export class Watchdog {
  readonly #ms: number;
  readonly #onSilent: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(ms: number, onSilent: () => void) {
    this.#ms = ms;
    this.#onSilent = onSilent;
    this.bump();
  }

  bump(): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#stopped = true;
      this.#onSilent();
    }, this.#ms);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }
}
