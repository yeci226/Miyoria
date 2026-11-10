import { type ActionId, newId, type TurnId } from "./ids.js";
import {
  type ContextKey,
  contextKeyString,
  type MessageRef,
  type OutgoingMessage,
} from "./platform.js";
import { serviceKey } from "./service-key.js";
import { type Timestamp, timestampMs, toTimestamp } from "./time.js";

/** Output lane. Actions in the same lane run one at a time, in priority order. */
export type LaneKey = string;

/** `text:<context>` (see `contextKeyString`). */
export function textLane(context: ContextKey): LaneKey {
  return `text:${contextKeyString(context)}`;
}

/** `voice:<platform>:<scope>`: she has one mouth per guild. */
export function voiceLane(platform: string, scope: string): LaneKey {
  return `voice:${platform}:${scope}`;
}

export const AVATAR_LANE: LaneKey = "avatar";

/**
 * Serialized as the snake_case name. Lower rank = more urgent (see `PRIORITY_RANK`):
 * `system` (system / admin output) > `direct` (reply to someone who addressed her) >
 * `request` (explicit user / viewer request) > `initiative` (she decided to speak) >
 * `idle` (filler).
 */
export type Priority = "system" | "direct" | "request" | "initiative" | "idle";

export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  system: 0,
  direct: 1,
  request: 2,
  initiative: 3,
  idle: 4,
};

/** Sort comparator: more urgent first. */
export function comparePriority(a: Priority, b: Priority): number {
  return PRIORITY_RANK[a] - PRIORITY_RANK[b];
}

/**
 * Internally tagged (`{"type": "send_message", ...}`), like the Rust serde shape.
 * `speak` says `text` in a voice channel (executed through `VoiceSink`); use a `voiceLane` so
 * her speech is serialized.
 * `actuate` runs a capability call the gate already approved (`ticket`, executed through
 * `ActuatorExecutor`), e.g. joining voice or switching a scene from inside a turn; `context` is
 * where it happens (for the platform), `null` when it is not tied to one.
 */
export type ActionPayload =
  | { type: "send_message"; context: ContextKey; message: OutgoingMessage }
  | { type: "react"; message: MessageRef; emoji: string }
  | { type: "typing"; context: ContextKey }
  | { type: "speak"; context: ContextKey; text: string; emotion: string | null }
  | { type: "actuate"; capability: string; ticket: string; context: ContextKey | null };

/** Platform the payload goes to (`core` for an `actuate` without a context). */
/**
 * Payload of `ACTION_SETTLED_TOPIC`: how a line of hers left the scheduler. `action_completed`
 * says an action ended; this says which line it was, so "sent" can be told from a dropped typing
 * indicator (`error`: `expired`, `cancelled` and `coalesced` mean it never went out).
 */
export interface ActionSettled {
  action: ActionId;
  turn: TurnId | null;
  type: "send_message" | "speak";
  context: ContextKey;
  text: string;
  ok: boolean;
  error: string | null;
  /** The message a successful `send_message` created. */
  message: MessageRef | null;
  /** Moderation replaced the line (the rule): what she meant did not reach anyone. */
  blocked?: string | null;
}

/** Published next to `action_completed` for every `send_message` and `speak` action. */
export const ACTION_SETTLED_TOPIC = "action.settled";

export function actionPlatform(payload: ActionPayload): string {
  if (payload.type === "react") return payload.message.context.platform;
  if (payload.type === "actuate") return payload.context?.platform ?? "core";
  return payload.context.platform;
}

/** `act:<name>`: lane of `actuate` actions (e.g. `act:voice:discord:<guild>`). */
export function actLane(name: string): LaneKey {
  return `act:${name}`;
}

export interface Action {
  id: ActionId;
  lane: LaneKey;
  priority: Priority;
  created_at: Timestamp;
  /** Milliseconds. The action is dropped if it has not started within this time. */
  ttl: number;
  /** Queued actions with the same key are replaced by the newest one. */
  coalesce_key: string | null;
  turn: TurnId | null;
  payload: ActionPayload;
  /** The text is the filtered line: moderation blocked what she meant (the rule). */
  blocked?: string;
}

export const DEFAULT_ACTION_TTL_MS = 120_000;

/** The error of a line that met the emergency stop in the scheduler. */
export const MUTED = "muted";

export interface NewActionOptions {
  /** Milliseconds; default `DEFAULT_ACTION_TTL_MS`. */
  ttl?: number;
  turn?: TurnId | null;
  coalesce_key?: string | null;
  /** Epoch ms for `created_at`; defaults to `Date.now()`. */
  now?: number;
  /** See `Action.blocked`. */
  blocked?: string | null;
}

export function newAction(
  lane: LaneKey,
  priority: Priority,
  payload: ActionPayload,
  options: NewActionOptions = {},
): Action {
  return {
    id: newId(),
    lane,
    priority,
    created_at: toTimestamp(options.now ?? Date.now()),
    ttl: options.ttl ?? DEFAULT_ACTION_TTL_MS,
    coalesce_key: options.coalesce_key ?? null,
    turn: options.turn ?? null,
    payload,
    ...(options.blocked == null ? {} : { blocked: options.blocked }),
  };
}

/** True once the action is older than its ttl (`now` in epoch ms). */
export function isActionExpired(action: Action, now: number): boolean {
  const age = now - timestampMs(action.created_at);
  return age >= 0 && age > action.ttl;
}

/**
 * Provided by the scheduler. Everything that wants to produce output submits actions here
 * instead of calling platforms directly.
 */
export interface ActionSink {
  submit(action: Action): Promise<void>;
  /**
   * Drops queued (not yet started) actions of a turn, e.g. when the agent regenerates a reply
   * because new messages arrived.
   */
  cancelTurn(turn: TurnId): Promise<void>;
  /** Stops what of `turn` is running right now too (§7.3 `cut_short`, `interrupt`). */
  interruptTurn?(turn: TurnId): Promise<void>;
  /**
   * The emergency stop: everything queued is dropped and every line going out is stopped, whoever
   * it belongs to. Returns how many actions that was.
   */
  silence?(): Promise<number>;
}

export const ActionSinkKey = serviceKey<ActionSink>("ActionSink");
