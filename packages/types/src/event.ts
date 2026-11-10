import {
  type ActionId,
  type EventId,
  type ModuleId,
  newId,
  type PlatformId,
  type TurnId,
} from "./ids.js";
import type { JsonValue } from "./json.js";
import type { AccountRef, ContextKey, IncomingMessage, MessageRef } from "./platform.js";
import { type Timestamp, toTimestamp } from "./time.js";
import type { PlaybackState, VoiceParticipant, VoiceUtterance } from "./voice.js";

export type ModuleStateKind =
  | "disabled"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

/** Why the agent did or did not respond. Shown in the panel for debugging. */
export interface DecisionTrace {
  turn: TurnId;
  context: ContextKey;
  respond: boolean;
  score: number;
  reasons: string[];
}

/**
 * Every bus event. Adjacently tagged exactly like the Rust
 * `#[serde(tag = "type", content = "data", rename_all = "snake_case")]` enum:
 * `{"type": "platform_message_created", "data": {...}}`.
 *
 * Optional (`Option<T>`) fields are always present, `null` when unset.
 */
export type Event =
  /**
   * A platform connection is up. `self_account` is one of her own accounts; messages from her
   * own accounts are never treated as input.
   */
  | { type: "platform_ready"; data: { platform: PlatformId; self_account: AccountRef } }
  | { type: "platform_message_created"; data: IncomingMessage }
  /** Someone started typing (used to extend the reply debounce). */
  | { type: "platform_typing"; data: { context: ContextKey; account: AccountRef } }
  | { type: "agent_turn_started"; data: { turn: TurnId; context: ContextKey } }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: { turn: TurnId; context: ContextKey; text: string } }
  | {
      type: "action_completed";
      data: {
        action: ActionId;
        turn: TurnId | null;
        ok: boolean;
        error: string | null;
        /** The message created by a successful `send_message` (may be missing in old JSON). */
        message: MessageRef | null;
      };
    }
  /** She joined a voice channel (`context.kind === "voice"`). */
  | { type: "voice_joined"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_left"; data: { context: ContextKey; reason: string | null } }
  /** Who is in the voice channel changed. */
  | { type: "voice_participants"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  /** Someone started or stopped speaking (raw signal, before ASR). */
  | {
      type: "voice_speaking";
      data: { context: ContextKey; account: AccountRef; speaking: boolean };
    }
  | { type: "voice_utterance"; data: VoiceUtterance }
  /** Her own speech playback. */
  | {
      type: "voice_playback";
      data: {
        context: ContextKey;
        turn: TurnId | null;
        state: PlaybackState;
        text: string;
        /**
         * Emotion the sentence is spoken with (`null`: none). Missing from older publishers; the
         * Stage shows the emotion when the sentence starts playing.
         */
        emotion?: string | null;
        /** How much of it was audible, in ms (`interrupted`, `finished`). */
        heard_ms?: number | null;
        /** How long all of it is, in ms; `null`: it was still being synthesized. */
        total_ms?: number | null;
        /** Moderation replaced what she meant (the rule): this is not her line reaching anyone. */
        blocked?: string | null;
      };
    }
  /** Asks the agent to start a turn on her own initiative (no new input). */
  | {
      type: "agent_initiative";
      data: {
        context: ContextKey;
        /** Why, for the decision trace (e.g. `"idle_channel"`, `"followup"`). */
        reason: string;
        /** What she might bring up, added to the situation message. */
        hint: string;
        /** Accounts the hint is about, if any. */
        about: AccountRef[];
      };
    }
  | {
      type: "module_state_changed";
      data: { module: ModuleId; state: ModuleStateKind; reason: string | null };
    }
  /** Escape hatch for extensions and experimental modules; `topic` is the bus topic. */
  | { type: "custom"; data: { topic: string; payload: JsonValue } };

export type EventType = Event["type"];
/** The event variant with tag `T`. */
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;
/** The `data` of the event variant with tag `T`. */
export type EventData<T extends EventType> = EventOf<T>["data"];

/** Dotted bus topic of every built-in variant (`custom` carries its own). */
export const EVENT_TOPICS: Readonly<Record<Exclude<EventType, "custom">, string>> = {
  platform_ready: "platform.ready",
  platform_message_created: "platform.message.created",
  platform_typing: "platform.typing",
  agent_turn_started: "agent.turn.started",
  agent_decision: "agent.decision",
  agent_turn_completed: "agent.turn.completed",
  action_completed: "action.completed",
  voice_joined: "voice.joined",
  voice_left: "voice.left",
  voice_participants: "voice.participants",
  voice_speaking: "voice.speaking",
  voice_utterance: "voice.utterance",
  voice_playback: "voice.playback",
  agent_initiative: "agent.initiative",
  module_state_changed: "system.module.state",
};

/** Dotted topic used for subscription filters, e.g. `platform.message.created`. */
export function eventTopic(event: Event): string {
  return event.type === "custom" ? event.data.topic : EVENT_TOPICS[event.type];
}

/** Narrows an event to one variant. */
export function isEvent<T extends EventType>(event: Event, type: T): event is EventOf<T> {
  return event.type === type;
}

/** A `custom` event. */
export function customEvent(topic: string, payload: JsonValue): EventOf<"custom"> {
  return { type: "custom", data: { topic, payload } };
}

/** Every event on the bus is wrapped in an envelope. Treat envelopes as immutable. */
export interface Envelope {
  id: EventId;
  ts: Timestamp;
  source: ModuleId;
  /** The event that caused this one. */
  causation: EventId | null;
  /** The agent turn this event belongs to. */
  correlation: TurnId | null;
  event: Event;
}

export interface EnvelopeOptions {
  causation?: EventId | null;
  correlation?: TurnId | null;
  /** Epoch ms for `ts`; defaults to `Date.now()`. */
  now?: number;
}

export function newEnvelope(
  source: ModuleId,
  event: Event,
  options: EnvelopeOptions = {},
): Envelope {
  return {
    id: newId(),
    ts: toTimestamp(options.now ?? Date.now()),
    source,
    causation: options.causation ?? null,
    correlation: options.correlation ?? null,
    event,
  };
}

/** Topic of an envelope's event. */
export function envelopeTopic(envelope: Envelope): string {
  return eventTopic(envelope.event);
}

/** Module id of the kernel itself: source of `system.module.state` events. */
export const KERNEL_MODULE: ModuleId = "kernel";
