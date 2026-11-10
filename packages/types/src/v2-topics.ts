// The v2 bus topics and their payloads in one table. Like every domain event since the Rust
// port (`world.salient`, `mind.thought`, `sing.cue`), they travel as `custom` events
// (`{type: "custom", data: {topic, payload}}`), so the adjacently tagged `Event` union, its
// `EVENT_TOPICS` table and the SDK copy stay as they are. Task events use dynamic topics
// (`taskTopic(owner, type)`, task.ts) and are not listed here.

import type { ActivitySnapshot, ActivityTaskEvent, Notice } from "./activity.js";
import {
  ACTIVITY_CHANGED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  ACTIVITY_STARTED_TOPIC,
  NOTICE_TOPIC,
} from "./activity.js";
import type { AffectEvent, AffectSnapshot } from "./affect.js";
import { AFFECT_CHANGED_TOPIC, AFFECT_EVENT_TOPIC } from "./affect.js";
import type { ArbiterDecision, Impulse, LedgerEntry } from "./arbiter.js";
import { ARBITER_DECISION_TOPIC, ARBITER_IMPULSE_TOPIC, LEDGER_TOPIC } from "./arbiter.js";
import { customEvent, type Event, type EventOf } from "./event.js";
import { isJsonObject, type JsonValue } from "./json.js";
import type { Goal } from "./plan.js";
import { GOAL_TOPIC } from "./plan.js";
import type { TurnFocus, TurnOutcomeRecord } from "./turn.js";
import { TURN_FOCUS_TOPIC, TURN_OUTCOME_TOPIC } from "./turn.js";

/** Payload type of every v2 topic. */
export interface V2TopicPayloads {
  [ACTIVITY_CHANGED_TOPIC]: ActivitySnapshot;
  [ACTIVITY_STARTED_TOPIC]: Extract<ActivityTaskEvent, { type: "started" }>;
  [ACTIVITY_DONE_TOPIC]: Extract<ActivityTaskEvent, { type: "done" }>;
  [ACTIVITY_FAILED_TOPIC]: Extract<ActivityTaskEvent, { type: "failed" }>;
  [NOTICE_TOPIC]: Notice;
  [ARBITER_IMPULSE_TOPIC]: Impulse;
  [ARBITER_DECISION_TOPIC]: ArbiterDecision;
  [LEDGER_TOPIC]: LedgerEntry;
  [AFFECT_EVENT_TOPIC]: AffectEvent;
  [AFFECT_CHANGED_TOPIC]: AffectSnapshot;
  [GOAL_TOPIC]: Goal;
  [TURN_FOCUS_TOPIC]: TurnFocus;
  [TURN_OUTCOME_TOPIC]: TurnOutcomeRecord;
}

export type V2Topic = keyof V2TopicPayloads;

export const V2_TOPICS: readonly V2Topic[] = [
  ACTIVITY_CHANGED_TOPIC,
  ACTIVITY_STARTED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  NOTICE_TOPIC,
  ARBITER_IMPULSE_TOPIC,
  ARBITER_DECISION_TOPIC,
  LEDGER_TOPIC,
  AFFECT_EVENT_TOPIC,
  AFFECT_CHANGED_TOPIC,
  GOAL_TOPIC,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
];

/**
 * First segments of the v2 topics that are new (`agent.*` is reserved already). The extension
 * host refuses extension publishes under them, like `platform` / `agent` / `game`.
 */
export const V2_TOPIC_PREFIXES: readonly string[] = ["activity", "arbiter", "affect", "plan"];

export function isV2Topic(topic: string): topic is V2Topic {
  return (V2_TOPICS as readonly string[]).includes(topic);
}

/** The `custom` event for a v2 topic (the payload must be plain JSON data). */
export function v2Event<T extends V2Topic>(
  topic: T,
  payload: V2TopicPayloads[T],
): EventOf<"custom"> {
  return customEvent(topic, payload as unknown as JsonValue);
}

/**
 * The payload of `event` when it is the `custom` event of `topic`, else `null`. Only checks that
 * the payload is an object: v2 topics are published by core modules, whose payloads are trusted
 * to have the declared shape. `V2_TOPIC_PREFIXES` must therefore be reserved prefixes in the
 * extension host (extensions may not publish under them).
 */
export function v2Payload<T extends V2Topic>(event: Event, topic: T): V2TopicPayloads[T] | null {
  if (event.type !== "custom" || event.data.topic !== topic) return null;
  const payload = event.data.payload;
  return isJsonObject(payload) ? (payload as unknown as V2TopicPayloads[T]) : null;
}
