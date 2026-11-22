// Failure limiting for the admin token (v5-architecture §11.1: 管理 token 加失敗次數限制). A wrong
// bearer token counts against the address it came from (`clientKey`: the visitor behind the tunnel,
// the socket elsewhere); after `maxFailures` within `windowMs` that address is locked out for
// `blockMs`, doubling with each lockout up to `maxBlockMs`. While locked out every bearer request
// from it is `429`, the right token too, so guessing does not go on behind the lock. A right token
// clears the address's record.
//
// The design names `rate-limiter-flexible`; it is not a dependency of this repository, and adding
// one needs an install, so this is a small in-memory limiter behind the same kind of interface
// (`FailureLimiter`). Its state is per process: a restart forgets it, which costs an attacker a
// restart they cannot cause. Keys are bounded; past the bound the oldest are forgotten.

/** Counts failures per key and says when a key must wait. */
export interface FailureLimiter {
  /** How many ms `key` must still wait, `null` when it may try. */
  blocked(key: string, now: number): number | null;
  /** One failure of `key`. Returns how long it must now wait, `null` when not locked out. */
  failed(key: string, now: number): number | null;
  /** A success of `key`: its record goes. */
  succeeded(key: string): void;
}

export interface FailureLimitOptions {
  /** Failures within `windowMs` that lock an address out. Default 10. */
  maxFailures?: number;
  /** Default 15 minutes. */
  windowMs?: number;
  /** The first lockout. Default 15 minutes; each further one doubles it. */
  blockMs?: number;
  /** The longest lockout. Default 24 hours. */
  maxBlockMs?: number;
  /** Addresses remembered at once. Default 10 000. */
  maxKeys?: number;
}

interface Entry {
  /** Times of the failures in the current window, oldest first. */
  failures: number[];
  blockedUntil: number;
  /** Lockouts so far (the next one is `blockMs * 2^strikes`). */
  strikes: number;
  lastAt: number;
}

const MINUTE_MS = 60_000;

/** `FailureLimiter` in memory. */
export class MemoryFailureLimiter implements FailureLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #blockMs: number;
  readonly #maxBlockMs: number;
  readonly #maxKeys: number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: FailureLimitOptions = {}) {
    this.#max = Math.max(1, options.maxFailures ?? 10);
    this.#windowMs = Math.max(1, options.windowMs ?? 15 * MINUTE_MS);
    this.#blockMs = Math.max(1, options.blockMs ?? 15 * MINUTE_MS);
    this.#maxBlockMs = Math.max(this.#blockMs, options.maxBlockMs ?? 24 * 60 * MINUTE_MS);
    this.#maxKeys = Math.max(1, options.maxKeys ?? 10_000);
  }

  blocked(key: string, now: number): number | null {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.blockedUntil <= now) return null;
    return entry.blockedUntil - now;
  }

  failed(key: string, now: number): number | null {
    let entry = this.#entries.get(key);
    // A key quiet for longer than the longest lockout starts over.
    if (entry !== undefined && now - entry.lastAt > this.#maxBlockMs && entry.blockedUntil <= now) {
      this.#entries.delete(key);
      entry = undefined;
    }
    if (entry === undefined) {
      if (this.#entries.size >= this.#maxKeys) this.#evict(now);
      entry = { failures: [], blockedUntil: 0, strikes: 0, lastAt: now };
    } else {
      this.#entries.delete(key);
    }
    // Most recently failed last, so eviction takes the quietest first.
    this.#entries.set(key, entry);
    entry.lastAt = now;
    entry.failures = entry.failures.filter((at) => now - at < this.#windowMs);
    entry.failures.push(now);
    if (entry.failures.length < this.#max) return this.blocked(key, now);
    const lock = Math.min(this.#blockMs * 2 ** entry.strikes, this.#maxBlockMs);
    entry.strikes += 1;
    entry.failures = [];
    entry.blockedUntil = now + lock;
    return lock;
  }

  succeeded(key: string): void {
    this.#entries.delete(key);
  }

  #evict(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.blockedUntil <= now && now - entry.lastAt >= this.#windowMs) {
        this.#entries.delete(key);
      }
    }
    while (this.#entries.size >= this.#maxKeys) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
