// Sliding-window rate limits and a small TTL cache, both in memory.

/** At most `max` hits per `windowMs` for each key. */
export class WindowLimit {
  readonly #hits = new Map<string, number[]>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  #fresh(key: string, now: number): number[] {
    const list = (this.#hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, list);
    return list;
  }

  /** Whether one more hit fits (not recorded). */
  has(key: string, now: number): boolean {
    return this.#fresh(key, now).length < this.max;
  }

  record(key: string, now: number): void {
    this.#hits.set(key, [...this.#fresh(key, now), now]);
  }
}

/** Both limits of one kind of call: per person and for everyone. */
export class Limits {
  constructor(
    readonly person: WindowLimit,
    readonly global: WindowLimit,
  ) {}

  /** Records the call and returns `true`, or returns `false` without recording when over. */
  take(who: string, now: number): boolean {
    if (!this.person.has(who, now) || !this.global.has("*", now)) return false;
    this.person.record(who, now);
    this.global.record("*", now);
    return true;
  }
}

/** Values kept for `ttlMs`, at most `max` entries (the oldest go first). */
export class TtlCache<V> {
  readonly #map = new Map<string, { at: number; value: V }>();
  constructor(
    readonly ttlMs: number,
    readonly max: number,
  ) {}

  get(key: string, now: number): V | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    if (hit.at + this.ttlMs <= now) {
      this.#map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now: number): void {
    if (this.ttlMs <= 0) return;
    this.#map.delete(key);
    this.#map.set(key, { at: now, value });
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  get size(): number {
    return this.#map.size;
  }
}
