// The fact layer, read-only: lines of the EventLog and what really reached someone.

import { z } from "zod";
import { ContextKeySchema, JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { LooseCount } from "./shared.js";

export const LogEventKindSchema = z
  .enum([
    "observation",
    "thought",
    "decision",
    "utterance",
    "delivered",
    "action",
    "result",
    "steer",
    "directive",
    "proposal",
  ])
  .meta({ id: "ApiLogEventKind" });
export type LogEventKind = z.output<typeof LogEventKindSchema>;

/** One line of the EventLog. */
export const LogEventSchema = z
  .object({
    /** ULID: sorts in creation order. */
    id: z.string(),
    at: TimestampSchema,
    kind: LogEventKindSchema,
    /** What wrote it: `voice.asr`, `game.minecraft`, `plan`, ... */
    source: z.string(),
    /** The line that caused this one (`null`: nothing in the log did). */
    cause: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    /** A person handle. */
    person: z.string().nullable(),
    body: JsonValueSchema,
  })
  .meta({ id: "ApiLogEvent" });
export type LogEvent = z.output<typeof LogEventSchema>;

/** What `GET /api/facts/events/{id}/chain` gives: the causes, oldest first, the event asked for last. */
export const CauseChainSchema = z
  .object({
    events: z.array(LogEventSchema),
    /** `false` when an ancestor is gone (compacted away, or never logged) or the walk hit its limit. */
    complete: z.boolean(),
  })
  .meta({ id: "ApiCauseChain" });
export type CauseChain = z.output<typeof CauseChainSchema>;

export const DeliveryChannelSchema = z.enum(["voice", "text"]).meta({ id: "ApiDeliveryChannel" });

/** One line that really reached someone (it exists only once it was acked). */
export const DeliverySchema = z
  .object({
    attention_key: z.string(),
    revision: z.number(),
    channel: DeliveryChannelSchema,
    context: ContextKeySchema,
    said: z.string(),
    delivered_at: TimestampSchema,
    /** Who was there. */
    audience: z.array(z.string()),
    /** Who responded inside the answer window. */
    answered_by: z.array(z.string()),
    /** Its `utterance` event. */
    line: z.string(),
  })
  .meta({ id: "ApiDelivery" });
export type Delivery = z.output<typeof DeliverySchema>;

/**
 * `limit`: how many lines at most; the server floors it and clamps it to 1..500 (default 100).
 * Not a number: 400.
 */
const LimitQuery = z.object({ limit: z.coerce.number<number | string>().optional() });

/**
 * The filters of the event list, all strings the handler reads (it answers 400 with its own
 * message for a bad one): `kind` and `source` are comma lists; `context` is a context key
 * written `platform:scope:channel` (with `context_kind` when the kind is not a `channel` or a
 * `voice` one); `since` and `until` are timestamps; `before` and `after` are event ids; `order`
 * is `asc` or `desc`; `turn` lists one turn's lines and what they caused (it narrows with the
 * other filters, but not with `before`, `after` and `attention_key`). `limit` is held to 1..500
 * (default 100); one that is not a number is a 400.
 */
const EventsQuery = z.object({
  kind: z.string().optional(),
  source: z.string().optional(),
  person: z.string().optional(),
  attention_key: z.string().optional(),
  context: z.string().optional(),
  context_kind: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  order: z.string().optional(),
  turn: z.string().optional(),
  limit: LooseCount.optional(),
});

/** `context` and `limit` of the delivery lists, read like the event list's. */
const DeliveriesQuery = z.object({
  context: z.string().optional(),
  context_kind: z.string().optional(),
  limit: LooseCount.optional(),
});

export const facts = {
  /** The EventLog, newest first unless `order` says otherwise. */
  events: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events" })
    .input(z.object({ query: EventsQuery }))
    .output(z.array(LogEventSchema)),
  /** One line; `404` when there is none. */
  event: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(LogEventSchema),
  /** Its causes, oldest first; `404` when the line is unknown. */
  chain: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}/chain" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(CauseChainSchema),
  /** What it caused, directly or further down, oldest first. */
  effects: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}/effects" })
    .input(z.object({ params: z.object({ id: z.string() }), query: LimitQuery }))
    .output(z.array(LogEventSchema)),
  /** What really reached someone, newest first. */
  deliveries: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/deliveries" })
    .input(z.object({ query: DeliveriesQuery }))
    .output(z.array(DeliverySchema)),
};
