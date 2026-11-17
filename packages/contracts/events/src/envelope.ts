// The event envelope (docs/design/v5-data.md §2.2): one shape for the bus, the `events` table and
// every reader of either.
//
// Core stamps `seq`, `source`, `tier` and `redacted_at`: `seq` is the commit order and exists
// only once the store commits, `source` comes from the connection the event arrived on (a
// self-claimed source is not trusted), `tier` is the type's retention policy from the registry,
// and `redacted_at` is set by the store's `redact()` alone. The producer sets everything else:
// `id` and `at` because it creates the event (a retry keeps its id; a remote node knows when it
// happened), and the place, person and `scope` fields because it knows where the event belongs.

import { z } from "zod";
import {
  EventIdSchema,
  JsonValueSchema,
  ModuleIdSchema,
  PersonIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";

/**
 * Where an event's content may be loaded into a prompt or shown (v5-data §2.4). The producer sets
 * it; when it does not, the type's default applies, then the session's. An event derived from
 * others (a decision, a thought, a summary) takes the narrowest scope among its inputs.
 */
export const EventScopeSchema = z
  .enum([
    /** Public posts, the public stage, live events. Loaded anywhere. */
    "public",
    /** Space-wide events (a member joined, a server goal). Sessions of the same `space_id`. */
    "space",
    /**
     * Messages in a guild channel, thread or voice room. Sessions of the same `room_id`; for a
     * thread, its parent room too.
     */
    "room",
    /** DMs. The DM session of `person_id`, and her inner tools after an owner check. */
    "dm",
    /**
     * Her own state with no outside source (a mood tick, the cluster starting). Her own prompts
     * anywhere.
     */
    "self",
    /** Audit, admin, identity, LLM call metadata. The panel and the owner only. */
    "owner",
  ])
  .meta({ id: "EventsScope" });
export type EventScope = z.output<typeof EventScopeSchema>;

/**
 * How long an event is kept (v5-data §2.5). One per registered type, stamped by Core. Compaction
 * removes a row only when no other row names it as `parent`, and counts what it removed per day.
 */
export const EventTierSchema = z
  .enum([
    /** Forever: audit, identity, settings, redactions, ledger postings, artifacts. */
    "keep",
    /** 365 days: chat and voice lines, the raw record later layers are derived from again. */
    "long",
    /** 90 days: turn decisions and thoughts, actions, LLM calls; for debugging and metrics. */
    "short",
    /** Folded into daily counts after 14 days: presence, game hazards, stage ticks. */
    "ambient",
  ])
  .meta({ id: "EventsTier" });
export type EventTier = z.output<typeof EventTierSchema>;

/** The tier of a type that does not name one, and of a type nobody registered. */
export const DEFAULT_EVENT_TIER: EventTier = "short";

/**
 * What a redacted event's `data` is replaced with ("do not remember this", "forget me"). The
 * envelope stays, so counts and `parent` chains survive; the content does not.
 */
export const RedactedDataSchema = z
  .object({ redacted: z.literal(true) })
  .meta({ id: "EventsRedactedData" });
export type RedactedData = z.output<typeof RedactedDataSchema>;

export const REDACTED_DATA: RedactedData = { redacted: true };

/** The fields a producer sets, shared by the draft and the envelope. */
const produced = {
  /** ULID, made when the event is created. Appending the same id twice stores it once. */
  id: EventIdSchema,
  /**
   * When it happened, as an RFC 3339 string like every time on the wire. The store keeps
   * microseconds since the epoch and converts on the way in and out; that is its business, not
   * the envelope's. A remote producer stamps it with its own clock, so it can be skewed: order
   * by `seq`, causality by `parent`.
   */
  at: TimestampSchema,
  /**
   * Registered event type, dotted. Events that exist today keep their bus topic
   * (`platform.message.created`); types new in V5 use the data doc's names (`chat.message`).
   */
  type: z.string().min(1),
} as const;

/** The fields a producer may leave out of a draft: `null` when it does not know them. */
const context = {
  /** The event that caused this one. */
  parent: EventIdSchema.nullable(),
  /** The agent turn it belongs to. */
  turn: TurnIdSchema.nullable(),
  /** Session key: `discord:<guild>:<channel>`, `discord:dm:<person>`, `home`. */
  session: z.string().nullable(),
  /** The session's space, kept on the event for scope checks. */
  space_id: z.string().nullable(),
  /** The session's room, kept on the event for scope checks. */
  room_id: z.string().nullable(),
  /** The acting person (a person id, never a handle). */
  person_id: PersonIdSchema.nullable(),
  /** The acting account. */
  account_id: z.string().nullable(),
  /** Attention and dedupe key, e.g. `msg:discord:<id>`. */
  key: z.string().nullable(),
} as const;

/** Schema version of `data` for this type. */
const version = z.number().int().min(1);

/**
 * An event as it is stored and as every reader receives it. Every key is present, `null` when
 * unset. One database belongs to one character, so there is no profile id.
 */
export const EventEnvelopeSchema = z
  .object({
    ...produced,
    v: version,
    ...context,
    /** Stamped by Core: the commit order and paging cursor. `null` until the store commits it. */
    seq: z.number().int().min(1).nullable(),
    /** Stamped by Core: the plugin, provider or host the event came from. */
    source: ModuleIdSchema,
    scope: EventScopeSchema,
    /** Stamped by Core from the type's registered tier. */
    tier: EventTierSchema,
    /** Stamped by the store's `redact()`: when `data` was replaced by `{"redacted": true}`. */
    redacted_at: TimestampSchema.nullable(),
    /** The payload, checked against the type's schema at `v` by readers that know the type. */
    data: JsonValueSchema,
  })
  .meta({ id: "EventsEnvelope" });
export type EventEnvelope = z.output<typeof EventEnvelopeSchema>;

/**
 * What a producer hands Core: the envelope without what Core stamps (`seq`, `source`, `tier`,
 * `redacted_at`). A draft that carries them anyway parses, and they are dropped.
 */
export const EventDraftSchema = z
  .object({
    ...produced,
    v: version.default(1),
    parent: context.parent.default(null),
    turn: context.turn.default(null),
    session: context.session.default(null),
    space_id: context.space_id.default(null),
    room_id: context.room_id.default(null),
    person_id: context.person_id.default(null),
    account_id: context.account_id.default(null),
    /** `null`: the type's default scope, then the session's. */
    scope: EventScopeSchema.nullable().default(null),
    key: context.key.default(null),
    data: JsonValueSchema,
  })
  .meta({ id: "EventsDraft" });
export type EventDraft = z.output<typeof EventDraftSchema>;
/** A draft as a producer may write it: fields with a default can be left out. */
export type EventDraftInput = z.input<typeof EventDraftSchema>;

/**
 * An event as the bus carries it and as live readers receive it (the admin event stream,
 * extension notifications, replay log lines): a draft with every key present, plus the module the
 * bus stamped as its publisher. It has no `seq`, `tier` or `redacted_at`: those belong to the
 * stored event, and what is on the bus may never be stored.
 */
export const BusEnvelopeSchema = z
  .object({
    ...produced,
    v: version,
    ...context,
    /** `null`: the type's default scope, then the session's. */
    scope: EventScopeSchema.nullable(),
    /** The module that published it. */
    source: ModuleIdSchema,
    data: JsonValueSchema,
  })
  .meta({ id: "EventsBusEnvelope" });
/** A bus envelope as JSON: what `BusEnvelopeSchema` parses. */
export type BusEnvelopeJson = z.output<typeof BusEnvelopeSchema>;

/** Whether `redact()` replaced the event's content. */
export function isRedacted(envelope: Pick<EventEnvelope, "redacted_at">): boolean {
  return envelope.redacted_at !== null;
}
