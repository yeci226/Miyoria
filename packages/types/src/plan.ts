// Goals and her agenda (docs/design/v2-architecture.md §3.7): the agenda becomes structure.
//
// A Goal says what she wants to do, why, when it should happen (a trigger the program checks
// cheaply) and when it stops mattering (`expires`, mandatory). Triggers wake the Plan call; a
// goal's execution is an `Impulse` (arbiter.ts) whose result is written back to the ledger.
// "No time" (`whenever`) is never "due": only `at`, `when_online` and `after_activity` fire.

import type { Handle } from "./handle.js";
import type { ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** When a goal should be acted on (`kind`-tagged, as in §3.7). */
export type GoalTrigger =
  | { kind: "at"; time: Timestamp }
  | { kind: "when_online"; person: Handle }
  /** `activity`: an `ActivityType`, optionally with its target (`game:minecraft`). */
  | { kind: "after_activity"; activity: string }
  /** Any time it fits. Never "due" on its own (`agendaDue` treating it as due was the bug). */
  | { kind: "whenever" };

export type GoalStatus = "pending" | "active" | "done" | "dropped";

/** Who wrote the goal. */
export type GoalSource = "plan" | "plan_daily" | "reflect" | "panel";

export interface Goal {
  id: string;
  /** 「找 Owen 問報告結果」 */
  what: string;
  /** 「好幾天沒跟他講話了,有點想他」 */
  why: string;
  trigger: GoalTrigger;
  /** Coarse steps (開台 → 玩 MC 一小時 → 收台聊天); empty: none. */
  steps: string[];
  status: GoalStatus;
  /** Mandatory: past it the goal is dropped automatically. */
  expires: Timestamp;
  /** Who it is about, when someone. */
  person: Handle | null;
  /** Where it should happen, when somewhere specific. */
  context: ContextKey | null;
  source: GoalSource;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** When it was done or dropped. */
  closed_at: Timestamp | null;
  /** Why it was dropped (expired, she changed her mind, a step failed). */
  close_reason: string | null;
}

/** What the trigger check needs to know (pure; the agenda owner fills it in). */
export interface TriggerProbe {
  /** Epoch ms. */
  now: number;
  /** The person with this handle is online now. */
  online(person: Handle): boolean;
  /** Activities (`game`, `game:minecraft`, `singing`) that ended since the last check. */
  ended: readonly string[];
}

/** True when the goal has expired at `now` (epoch ms); an unparsable `expires` counts as past. */
export function isGoalExpired(goal: Goal, now: number): boolean {
  const at = Date.parse(goal.expires);
  return Number.isNaN(at) || now >= at;
}

/**
 * True when `trigger` fires now. `whenever` never fires: a goal without a time is something
 * she may pick when she plans, not something that wakes her.
 */
export function triggerFires(trigger: GoalTrigger, probe: TriggerProbe): boolean {
  switch (trigger.kind) {
    case "at": {
      const at = Date.parse(trigger.time);
      return !Number.isNaN(at) && probe.now >= at;
    }
    case "when_online":
      return probe.online(trigger.person);
    case "after_activity":
      return probe.ended.includes(trigger.activity);
    case "whenever":
      return false;
  }
}

/** True for a pending / active goal whose trigger fires and that has not expired. */
export function goalDue(goal: Goal, probe: TriggerProbe): boolean {
  if (goal.status !== "pending" && goal.status !== "active") return false;
  return !isGoalExpired(goal, probe.now) && triggerFires(goal.trigger, probe);
}

/** One candidate of the ranked "想做的事" list computed before each Plan call. */
export interface Desire {
  /** `chat_with`, `play`, `stream`, `sing`, `rest`, `goal` ... */
  want: string;
  /** Short zh-TW label (`"找 Owen 聊天"`). */
  label: string;
  /** 0..1, from her emotions, drives and bonds. */
  weight: number;
  /** Why, with the numbers (`"想念 0.6 × 在意 0.8,他在線"`). */
  why: string;
  person: Handle | null;
  /** The capability it would take, if any (`game.start`). */
  capability: string | null;
  /** The goal it advances, if any. */
  goal: string | null;
}

/** Why the Plan call was woken. */
export type PlanWake =
  | "heartbeat"
  | "daily"
  | "goal_trigger"
  | "activity_ended"
  | "salient"
  | "affect"
  | "manual";

/** New goal input (`GoalAgenda.add`). */
export interface GoalInput {
  what: string;
  why: string;
  trigger: GoalTrigger;
  steps?: string[];
  expires: Timestamp;
  person?: Handle | null;
  context?: ContextKey | null;
  source: GoalSource;
}

/** Provided by the planner (`mind` → Plan). Reads answer from memory; writes persist. */
export interface GoalAgenda {
  /** Pending and active goals, soonest trigger first. */
  goals(): Goal[];
  goal(id: string): Goal | null;
  add(input: GoalInput): Goal;
  /** Moves a goal to `active` / `done` / `dropped`; `null` when unknown or already closed. */
  setStatus(id: string, status: GoalStatus, reason?: string | null): Goal | null;
  /** Goals whose trigger fires now (see `goalDue`). */
  due(probe: TriggerProbe): Goal[];
}

export const GoalAgendaKey = serviceKey<GoalAgenda>("GoalAgenda");

/** Payload: `Goal`, for every new or changed goal. */
export const GOAL_TOPIC = "plan.goal";
