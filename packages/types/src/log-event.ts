// The fact layer of V3 (docs/design/v3-architecture.md §5, §6, §8).
//
// * `LogEvent`: one immutable line of the EventLog, the single source of what she perceived,
//   thought, decided, said and did. Everything else is a projection of it.
// * `Observation`: what every sensor writes (§6). Silent by default: an observation only means
//   "she knows", never "she should speak".
// * `WorkingContext`: what she knows right now, one bucket per writer (§5).
// * `DeliveryLedger`: what really reached someone (§8). Only an ack counts as said.
//
// In this phase the log runs beside V2: the `facts` module writes it from the bus and nothing
// reads it to make a decision yet (§21). The interfaces are the ones later phases switch to.

import type { Handle } from "./handle.js";
import type { ModuleId, TurnId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

// ---- log events -----------------------------------------------------------------------------

export const LOG_EVENT_KINDS = [
  /** A fact she perceived. */
  "observation",
  /** A thought of the main line or the background. */
  "thought",
  /** A decision of the main line, not speaking included. */
  "decision",
  /** A line about to be said. */
  "utterance",
  /** A delivery ack: voice playback finished, the platform accepted the message. */
  "delivered",
  /** An action request. */
  "action",
  /** An action's result (accepted, done, failed), or a line that did not arrive. */
  "result",
  /** A change of direction of a running task, and how applying it went. */
  "steer",
  /** A rule change. */
  "directive",
  /** A proposal from the background. */
  "proposal",
] as const;

export type LogEventKind = (typeof LOG_EVENT_KINDS)[number];

export function isLogEventKind(value: unknown): value is LogEventKind {
  return typeof value === "string" && (LOG_EVENT_KINDS as readonly string[]).includes(value);
}

/** One line of the log. Treat it as immutable. */
export interface LogEvent {
  /** ULID: sorts in creation order. For an event taken from the bus, the envelope's id. */
  id: string;
  at: Timestamp;
  kind: LogEventKind;
  /** What wrote it: `voice.asr`, `game.minecraft`, `plan`, ... */
  source: string;
  /** The event that caused this one (`null`: nothing in the log did). */
  cause: string | null;
  context: ContextKey | null;
  person: Handle | null;
  body: JsonValue;
}

/** What a writer gives `EventLog.append`; the log fills in what is left out. */
export interface NewLogEvent {
  /** Default: a fresh ULID. */
  id?: string;
  /** Default: now. */
  at?: Timestamp;
  kind: LogEventKind;
  source: string;
  cause?: string | null;
  context?: ContextKey | null;
  person?: Handle | null;
  body: JsonValue;
}

/** `EventLog.query`. Every field narrows the result; none means everything. */
export interface LogEventFilter {
  kinds?: readonly LogEventKind[];
  sources?: readonly string[];
  context?: ContextKey;
  person?: Handle;
  attention_key?: string;
  /** Events whose body names this turn (`turn`, or `turn_outcome.turn`). */
  turn?: string;
  /** Events at or after this time. */
  since?: Timestamp;
  /** Events before this time. */
  until?: Timestamp;
  /** Events older than this id (paging newest first). */
  before?: string;
  /** Events newer than this id (paging oldest first). */
  after?: string;
  /** Default `desc`: newest first. */
  order?: "asc" | "desc";
  /** Default 100. */
  limit?: number;
}

/** A `cause` chain, oldest first: the event asked for is the last one. */
export interface CauseChain {
  events: LogEvent[];
  /** False when an ancestor is gone (compacted away, or never logged) or the walk hit its limit. */
  complete: boolean;
}

/** Follows the log. `apply` must be synchronous and fast. */
export interface Projection {
  apply(event: LogEvent): void;
}

/** Provided by the `facts` module. Writing never throws and never touches the disk. */
export interface EventLog {
  append(event: NewLogEvent): LogEvent;
  /** Appends an `observation`. `options`: what else its `ObservationBody` says. */
  observe(observation: Observation, options?: ObserveOptions): LogEvent;
  /** The newest events from memory, oldest first. */
  recent(limit?: number): LogEvent[];
  get(id: string): Promise<LogEvent | null>;
  query(filter?: LogEventFilter): Promise<LogEvent[]>;
  /** Walks `cause` up from `id`. Empty and not complete when `id` is unknown. */
  chain(id: string, options?: { maxDepth?: number }): Promise<CauseChain>;
  /** What `id` caused, directly or not, oldest first. */
  effects(id: string, options?: { limit?: number; maxDepth?: number }): Promise<LogEvent[]>;
  /**
   * Feeds `projection` the events matching `from` (oldest first; no `from`: none), then every new
   * event. Returns the function that stops it.
   */
  project(
    projection: Projection,
    from?: Omit<LogEventFilter, "limit" | "order">,
  ): Promise<() => void>;
  /** Writes what is buffered. Resolves when it was tried; a failed write stays buffered. */
  flush(): Promise<void>;
}

export const EventLogKey = serviceKey<EventLog>("EventLog");

// ---- observations ---------------------------------------------------------------------------

export const SALIENCES = ["ambient", "notable", "urgent"] as const;

export type Salience = (typeof SALIENCES)[number];

/** The unified form of everything she perceives (§6). */
export interface Observation {
  source: string;
  /** Default true: she knows, and that is all. */
  silent: boolean;
  salience: Salience;
  /** The same thing always has the same key (`game:craft:stone_pickaxe`). */
  attention_key: string;
  /** Goes up by one only when the thing really changed. */
  revision: number;
  /** One sentence for her. May quote people: see `BucketWrite.untrusted`. */
  summary: string;
  addressed_to_her: boolean;
  from: Handle | null;
  context: ContextKey | null;
}

/** Where an observation came from on the bus: enough to replay it. */
export interface ObservationOrigin {
  /** The module that published it. */
  module: ModuleId;
  topic: string;
  /** The bus `Event`, as published (JSON). */
  event: JsonValue;
  turn: TurnId | null;
}

/** What one observation changes in Working Context. */
export type BucketWrite =
  /** The bucket's only entry becomes this one. */
  | { op: "replace-self"; writer: string; owner: ModuleId | null; untrusted: boolean }
  /** One more entry, the oldest falling out past the cap. */
  | {
      op: "append-self";
      writer: string;
      owner: ModuleId | null;
      untrusted: boolean;
      max_entries?: number;
    }
  /** The writer is gone: its bucket goes with it. */
  | { op: "leave"; writer: string }
  /** The module is gone: every bucket it owns goes with it. */
  | { op: "leave-owner"; owner: ModuleId }
  /** The core started: what is in the buckets now is from before. */
  | { op: "boot" };

export interface ObserveOptions {
  cause?: string | null;
  buckets?: readonly BucketWrite[];
  /** A person said something (what `answered_by` counts). */
  speech?: boolean;
  origin?: ObservationOrigin | null;
  /** Default: `observation.from`. */
  person?: Handle | null;
  /** Default: a fresh ULID. */
  id?: string;
  /** Default: now. */
  at?: Timestamp;
}

/** The `body` of an `observation` event. */
export interface ObservationBody {
  observation: Observation;
  buckets: BucketWrite[];
  speech: boolean;
  origin: ObservationOrigin | null;
}

// ---- working context ------------------------------------------------------------------------

export type BucketMode = "replace-self" | "append-self";

export interface ContextEntry {
  /** The observation it came from. */
  event: string;
  at: Timestamp;
  text: string;
  attention_key: string;
  revision: number;
  context: ContextKey | null;
  from: Handle | null;
  /** Comes from people or the outside: goes into a prompt as data, never as instructions. */
  untrusted: boolean;
  /** Written before the last start: the writer has not confirmed it since. */
  restored: boolean;
}

export interface ContextBucket {
  writer: string;
  mode: BucketMode;
  /** The module that writes it; it is removed when that module leaves. */
  owner: ModuleId | null;
  entries: ContextEntry[];
  updated_at: Timestamp;
}

/** What she knows right now. Read from memory. Writes go through the log (`BucketWrite`). */
export interface WorkingContext {
  /** Every bucket, ordered by writer. `context`: only the entries of that place, or of none. */
  buckets(context?: ContextKey | null): ContextBucket[];
  bucket(writer: string): ContextBucket | null;
}

export const WorkingContextKey = serviceKey<WorkingContext>("WorkingContext");

// ---- delivery -------------------------------------------------------------------------------

export type DeliveryChannel = "voice" | "text";

/** One line that really reached someone (§8). Exists only once it was acked. */
export interface Delivery {
  attention_key: string;
  revision: number;
  channel: DeliveryChannel;
  context: ContextKey;
  said: string;
  delivered_at: Timestamp;
  /** Who was there. */
  audience: Handle[];
  /** Who responded inside the answer window. */
  answered_by: Handle[];
  /** Its `utterance` event. */
  line: string;
}

/**
 * `pending`: going out, no answer yet. The rest are final; only `delivered` means she said it.
 * `interrupted`: cut off. `failed`: did not reach anyone. `cancelled`: never went out.
 * `blocked`: moderation replaced it. Unlike the others it is not to be tried again: the same
 * thing would be blocked the same way.
 */
export type LineState =
  | "pending"
  | "delivered"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "blocked";

export type UndeliveredState = Exclude<LineState, "pending" | "delivered">;

/** One attempt to say something. Retrying is a new line with the same key and revision. */
export interface SpokenLine {
  /** Its `utterance` event. */
  line: string;
  attention_key: string;
  revision: number;
  channel: DeliveryChannel;
  context: ContextKey;
  said: string;
  audience: Handle[];
  turn: TurnId | null;
  state: LineState;
  at: Timestamp;
  /** When it reached a final state. */
  settled_at: Timestamp | null;
  /** Why it did not arrive. */
  reason: string | null;
}

export interface NewLine {
  attention_key: string;
  revision: number;
  channel: DeliveryChannel;
  context: ContextKey;
  said: string;
  audience?: readonly Handle[];
  turn?: TurnId | null;
  /** What led to it (the decision). */
  cause?: string | null;
  /** Default `delivery`. */
  source?: string;
}

/** The `body` of an `utterance` event. */
export interface UtteranceBody {
  attention_key: string;
  revision: number;
  channel: DeliveryChannel;
  said: string;
  audience: Handle[];
  turn: TurnId | null;
}

/** The `body` of a `result` event about a line that did not arrive. */
export interface UndeliveredBody {
  line: string;
  attention_key: string;
  revision: number;
  delivery: UndeliveredState;
  reason: string | null;
}

/** Provided by the `facts` module. Answers from memory. */
export interface DeliveryLedger {
  /** A line is about to go out. Returns its id, for `ack` and `undelivered`. */
  open(line: NewLine): string;
  /** The line arrived. `null`: unknown, or it already ended some other way. Idempotent. */
  ack(line: string): Delivery | null;
  /** The line did not arrive. Ignored once the line is final. */
  undelivered(line: string, state: UndeliveredState, reason?: string | null): void;
  /** The delivery of `key` at `revision` or later (no `revision`: the newest), or `null`. */
  delivered(key: string, revision?: number): Delivery | null;
  /** §6: `notable` or above, and this revision of it has not been delivered. */
  mayClaim(observation: Pick<Observation, "attention_key" | "revision" | "salience">): boolean;
  /** §8's second line of defence: a recent delivery that says about the same as `text`. */
  saidLately(text: string, options?: { context?: ContextKey; withinMs?: number }): Delivery | null;
  /** Deliveries, newest first (the "最近講過" list). */
  recent(options?: { context?: ContextKey; limit?: number }): Delivery[];
  /** Lines that ended undelivered and were not delivered by a later attempt, newest first. */
  retryable(options?: { context?: ContextKey; limit?: number }): SpokenLine[];
  /** The line, in any state. */
  line(id: string): SpokenLine | null;
}

export const DeliveryLedgerKey = serviceKey<DeliveryLedger>("DeliveryLedger");

// ---- lifecycle ------------------------------------------------------------------------------

/**
 * Published by the core right before it stops its modules. What modules say while going down
 * (a game session "ending" with its extension) is not something that happened out there.
 */
export const SYSTEM_SHUTDOWN_TOPIC = "system.shutdown";
