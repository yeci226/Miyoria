// Her own life (docs/design/v4-plan.md §8): what she does when nobody needs her, the timers she
// sets herself.
//
// * `LifeActivityId`: the rows of the §8.1 table, plus singing (she does it, it is not a row).
// * `LifeLog`: what she did today and lately, from what really ran (her own capability calls and
//   the activity snapshot), for "今天的她" (§6.2) and the variety rule of §8.2.
// * `Reminder` / `ReminderDesk`: `remind_me` (§8.3), timers that come back to the main line as a
//   proposal when due; nothing in the background speaks (§15).

import type { ReminderData } from "@miyoria/contracts/events";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** The rows of §8.1 (ids are stable: they are persisted). */
export const LIFE_ACTIVITY_IDS = [
  "browse",
  "diary",
  "code",
  "practice",
  "game",
  "recap",
  "business",
  "care",
  "event",
  "sing",
] as const;

export type LifeActivityId = (typeof LIFE_ACTIVITY_IDS)[number];

export function isLifeActivityId(value: unknown): value is LifeActivityId {
  return typeof value === "string" && (LIFE_ACTIVITY_IDS as readonly string[]).includes(value);
}

/** One thing she did. */
export interface LifeEntry {
  id: string;
  activity: LifeActivityId;
  /** What exactly, short and in her terms (「查了 Minecraft 1.22 的新生物」); may quote others. */
  what: string;
  /** When it started (point entries: when it happened). */
  at: Timestamp;
  /** How long it ran; `null`: a single act (a search, a post). */
  minutes: number | null;
  /** The capability that did it, when one did. */
  capability: string | null;
}

/** What she did, today and lately. Provided by the `mind` module. Reads memory. */
export interface LifeLog {
  /** Entries since `since` (epoch ms), oldest first. */
  entries(since?: number): LifeEntry[];
  /** Today's entries (her local day), oldest first. */
  today(): LifeEntry[];
  /**
   * "今天的她" as prompt lines (zh-TW), or `null` when there is nothing to say. `lately`: the last
   * few days, not only today.
   */
  summary(scope?: "today" | "lately"): string | null;
}

export const LifeLogKey = serviceKey<LifeLog>("LifeLog");

/** Capability id of `remind_me`. */
export const REMIND_CAPABILITY = "self.remind";

/** A timer she set (contract: `ReminderSchema` in @miyoria/contracts/events). */
export type Reminder = ReminderData;

/** Her timers. Provided by the `mind` module. */
export interface ReminderDesk {
  /** Open timers, soonest first. */
  list(): Reminder[];
  /** Cancels by id or key; `false`: no such timer. */
  cancel(idOrKey: string): boolean;
}

export const ReminderDeskKey = serviceKey<ReminderDesk>("ReminderDesk");
