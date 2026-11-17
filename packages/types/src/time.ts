import type { Timestamp } from "@miyoria/contracts/wire";

/** A point in time as an RFC 3339 / ISO 8601 UTC string (a contract: `@miyoria/contracts/wire`). */
export type { Timestamp } from "@miyoria/contracts/wire";

/** Source of "now". Inject it instead of calling `Date.now()` so tests can control time. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Wall clock. Vitest fake timers (`vi.useFakeTimers()`) also control this one. */
export const systemClock: Clock = { now: () => Date.now() };

/** `Timestamp` of an epoch-milliseconds value or a `Date`. */
export function toTimestamp(at: number | Date): Timestamp {
  return (typeof at === "number" ? new Date(at) : at).toISOString();
}

/** Epoch milliseconds of a `Timestamp`; throws `RangeError` when it does not parse. */
export function timestampMs(ts: Timestamp): number {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new RangeError(`invalid timestamp \`${ts}\``);
  return ms;
}
