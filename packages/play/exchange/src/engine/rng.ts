// The engine's randomness: a seeded generator, never `Math.random`. Every draw of a round comes
// from a generator made for that round and that purpose (`rngFor(seed, "round", n)`), so a round
// can be drawn again from the seed alone, in any order, and two purposes never share a stream.

/** A 32-bit hash of the parts (xmur3's mixing over the joined text). */
export function hash32(...parts: readonly (string | number)[]): number {
  const text = parts.join("\u0001");
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: small, fast, and good enough for a game's prices. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A standard normal draw (Box-Muller, one of the pair). */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A whole number in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** A number in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** One of `items` (not empty). */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

/** The generator of one purpose under the market's seed. */
export function rngFor(seed: string, ...parts: readonly (string | number)[]): Rng {
  return new Rng(hash32(seed, ...parts));
}
