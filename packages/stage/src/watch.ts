// A tiny watch cell: one current value, listeners told about changes.

export type Unsubscribe = () => void;

/** Holds a value and notifies listeners when it changes (by `equals`). */
export class Watch<T> {
  #value: T;
  readonly #equals: (a: T, b: T) => boolean;
  readonly #listeners = new Set<(value: T) => void>();

  constructor(initial: T, equals: (a: T, b: T) => boolean = Object.is) {
    this.#value = initial;
    this.#equals = equals;
  }

  get(): T {
    return this.#value;
  }

  /** Sets the value; returns true (and notifies) when it changed. */
  set(value: T): boolean {
    if (this.#equals(this.#value, value)) return false;
    this.#value = value;
    for (const listener of [...this.#listeners]) listener(value);
    return true;
  }

  /** Calls `listener` on every change (not with the current value). */
  subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** Structural equality of JSON-like values. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && jsonEquals(ra[k], rb[k]));
}
