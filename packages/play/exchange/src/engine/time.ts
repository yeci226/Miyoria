// The market's clock: a round is a number, `day * rounds_per_day + slot`, and its time is the
// local hour `first_hour + slot` of that local day. The engine never reads a clock; the module
// asks these with the time it has.

import type { EngineParams } from "./params.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The local day number of `ms` in a zone `offsetMinutes` east of UTC. */
export function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms + offsetMinutes * 60_000) / DAY_MS);
}

/** Where the local day `day` starts, as epoch ms. */
export function dayStartMs(day: number, offsetMinutes: number): number {
  return day * DAY_MS - offsetMinutes * 60_000;
}

/** Sunday 0 .. Saturday 6 of a local day (day 0, 1970-01-01, was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** The local day of the Monday that starts the week of `day` (weeks run Monday to Sunday). */
export function weekOf(day: number): number {
  return day - ((weekdayOf(day) + 6) % 7);
}

export function roundDay(round: number, p: EngineParams): number {
  return Math.floor(round / p.rounds_per_day);
}

export function roundSlot(round: number, p: EngineParams): number {
  return round - roundDay(round, p) * p.rounds_per_day;
}

/** When round `round` is due, as epoch ms. */
export function roundAt(round: number, p: EngineParams, offsetMinutes: number): number {
  const day = roundDay(round, p);
  return dayStartMs(day, offsetMinutes) + (p.first_hour + roundSlot(round, p)) * HOUR_MS;
}

/** The last round due at or before `ms` (it may be one of an earlier day). */
export function lastRoundDue(ms: number, p: EngineParams, offsetMinutes: number): number {
  const day = localDay(ms, offsetMinutes);
  const hour = Math.floor((ms - dayStartMs(day, offsetMinutes)) / HOUR_MS);
  const slot = hour - p.first_hour;
  if (slot < 0) return day * p.rounds_per_day - 1;
  return day * p.rounds_per_day + Math.min(slot, p.rounds_per_day - 1);
}

/** Whether `round` is the day's last (the close). */
export function isClose(round: number, p: EngineParams): boolean {
  return roundSlot(round, p) === p.rounds_per_day - 1;
}

/** Whether `round` is the day's first (the open). */
export function isOpen(round: number, p: EngineParams): boolean {
  return roundSlot(round, p) === 0;
}
