// The event log over the `events` table (docs/design/v5-data.md §2): append, read, redact and
// compact. Hand-written SQL on the shared connection; every statement text is fixed or built from
// a small set of filters, so `Db` prepares each once.
//
// Two write paths, one table (§2.3):
// - batched: `append(writes)` commits many events in one transaction. The facts module's buffer
//   calls it every `flush_ms` (500 ms), so a turn or the voice path never waits on the disk (§9 R1);
// - transactional: `appendNow(write)` inside the caller's `db.tx`, when a plugin's own row and its
//   event must commit together.
//
// The store stamps what the producer does not set: `seq` (commit order), `tier` (the type's, or its
// family's, from the registry), and `scope` when the draft has none (the type's default, then the
// session's). A write may name its place as a platform `ContextKey` instead of a session: identity
// resolves it (space, room, session) in the same transaction, and an author or a handle into
// `person_id`.

import type { SQLInputValue } from "node:sqlite";
import {
  type EventDraftInput,
  type EventEnvelope,
  type EventRegistry,
  type EventScope,
  EventScopeSchema,
  type EventTier,
  REDACTED_DATA,
} from "@miyoria/contracts/events";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type ContextKind,
  contextKeyString,
  type Handle,
  isJsonObject,
  type JsonValue,
  newId,
  type PersonId,
  type Timestamp,
} from "@miyoria/types";
import {
  fromMicros,
  normalizeTimestamp,
  optionalMicros,
  optionalTimestamp,
  parseJson,
  StoreError,
  sqlLimit,
  toMicros,
} from "../common.js";
import type { Db, Params, Row } from "../db.js";
import { HOME_SESSION, type Identity, type Place, type PlaceAuthor } from "../identity/identity.js";
import { coreEventRegistry, PrivacyRedacted, typeDefaults } from "./types.js";

const log = getLogger("store.events");

const DAY_MICROS = 86_400_000_000;
const DEFAULT_LIMIT = 100;
/** What `redact()` writes into `data`; the trigger allows exactly this text. */
const REDACTED_JSON = JSON.stringify(REDACTED_DATA);
const SCOPES: readonly string[] = EventScopeSchema.options;
/** Redacted keys remembered for lines appended after their redaction (see `RedactionFilter`). */
const REDACTED_KEYS = 10_000;

export type Awaitable<T> = T | Promise<T>;

/** One event to append: the producer's draft, and what the store resolves for it. */
export interface EventWrite {
  draft: EventDraftInput;
  /** The plugin, provider or host it came from (Core's to stamp; the writer passes it on). */
  source: string;
  /**
   * Where it happened, as the platform names it. Used when the draft has no `session`: identity
   * resolves it into `space_id`, `room_id` and `session`, creating them on first sight.
   */
  context?: ContextKey | null;
  /** Who wrote it there. Identity sees them; sets `person_id` and `account_id` when unset. */
  author?: PlaceAuthor | null;
  /** Her handle for the acting person, when neither `person_id` nor an author is given. */
  handle?: Handle | null;
}

/** An event as the log reads it back, with what its place and person ids stand for. */
export interface LoggedEvent {
  envelope: EventEnvelope;
  /** The platform context of `room_id` (and the lane `session` names); `null` without a room. */
  context: ContextKey | null;
  /** Her handle for `person_id`. */
  handle: Handle | null;
}

/** `query`. Every field narrows the result; none means everything. */
export interface EventQuery {
  types?: readonly string[];
  sources?: readonly string[];
  session?: string;
  /** The session of this platform context (looked up, never created). */
  context?: ContextKey;
  personId?: PersonId;
  /** The person this handle names. */
  handle?: Handle;
  key?: string;
  turn?: string;
  /** Events naming one of these as `parent`. */
  parents?: readonly string[];
  /** At or after this time. */
  since?: Timestamp;
  /** Before this time. */
  until?: Timestamp;
  /** Committed after the event with this id (by `seq`). */
  after?: string;
  /** Committed before the event with this id (by `seq`). */
  before?: string;
  afterSeq?: number;
  beforeSeq?: number;
  /** Default `desc`: newest first, by `seq`. */
  order?: "asc" | "desc";
  /** Default 100. */
  limit?: number;
}

/** Which events `redactWhere` takes the content of: every given field must match. */
export interface RedactionFilter {
  /**
   * Events filed under this key (a chat message and her observations of it share one). An event
   * with this key appended later (a line still waiting in a writer's buffer) is stored redacted.
   */
  key?: string;
  personId?: PersonId;
  /** Only these types. */
  types?: readonly string[];
}

/** What one redaction took the content of, told to `onRedacted` listeners once it committed. */
export interface Redaction {
  /** The events whose content went. */
  ids: readonly string[];
  /** The keys redacted (`RedactionFilter.key`): what a cache of lines must drop by key. */
  keys: readonly string[];
}

export type RedactionListener = (redaction: Redaction) => void;

/** The tiers compaction removes from; `keep` is never removed. */
export type CompactedTier = Exclude<EventTier, "keep">;

export const COMPACTED_TIERS: readonly CompactedTier[] = ["ambient", "short", "long"];

/** What one compaction pass may remove. */
export interface EventCompaction {
  /** Per tier: rows from before this time may go (`null`: none of that tier). */
  before: Readonly<Record<CompactedTier, Timestamp | null>>;
  /** Rows removed at most in this pass (it blocks whatever else uses the database). */
  maxRows: number;
}

export interface EventCompactionResult {
  removed: Record<CompactedTier, number>;
  /** Another pass may find more: what the removed rows caused is gone, so their parents are leaves. */
  more: boolean;
}

/** How many events compaction removed, per UTC day, type and source. */
export interface EventRollup {
  day: Timestamp;
  type: string;
  source: string;
  count: number;
  first_at: Timestamp;
  last_at: Timestamp;
}

/** The log as its readers and the facts writer see it. Implementations may answer at once. */
export interface EventLogStore {
  /** Appends `writes` in one transaction, in order. An id already stored is left as it is. */
  append(writes: readonly EventWrite[]): Awaitable<EventEnvelope[]>;
  get(id: string): Awaitable<LoggedEvent | null>;
  query(query?: EventQuery): Awaitable<LoggedEvent[]>;
  /**
   * Replaces the event's content with `{"redacted": true}` and appends a `privacy.redacted`
   * record of it, in one transaction. Returns the record; `null` when the event is unknown or
   * already redacted.
   */
  redact(id: string, reason: string, source: string): Awaitable<EventEnvelope | null>;
  /**
   * Hears every redaction once it is committed, so a reader that keeps lines in memory can drop
   * their content too. Returns the function that stops it. Optional for test doubles.
   */
  onRedacted?(listener: RedactionListener): () => void;
  /**
   * Removes old rows by tier, leaves first: a row goes only when no row names it as `parent`, so
   * what stays keeps its whole chain. What it removes is counted in the rollups.
   */
  compact(policy: EventCompaction): Awaitable<EventCompactionResult>;
  /** What compaction removed, newest day first. */
  rollups(limit: number): Awaitable<EventRollup[]>;
}

export interface EventStoreOptions {
  /** Resolves places and people; without it `context`, `author` and `handle` are ignored. */
  identity?: Identity | null;
  /** The types whose tier and default scope are stamped. Default: `coreEventRegistry()`. */
  registry?: EventRegistry;
}

// ---- rows -----------------------------------------------------------------------------------

function text(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`events column \`${column}\` is not text`);
  return v;
}

function optText(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : text(row, column);
}

function int(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`events column \`${column}\` is not a number`);
}

function optInt(row: Row, column: string): number | null {
  const v = row[column];
  return v === null || v === undefined ? null : int(row, column);
}

function envelopeOf(row: Row): EventEnvelope {
  return {
    id: text(row, "id"),
    at: fromMicros(int(row, "at")),
    type: text(row, "type"),
    v: int(row, "v"),
    parent: optText(row, "parent"),
    turn: optText(row, "turn"),
    session: optText(row, "session"),
    space_id: optText(row, "space_id"),
    room_id: optText(row, "room_id"),
    person_id: optText(row, "person_id"),
    account_id: optText(row, "account_id"),
    key: optText(row, "key"),
    seq: int(row, "seq"),
    source: text(row, "source"),
    scope: text(row, "scope") as EventScope,
    tier: text(row, "tier") as EventTier,
    redacted_at: optionalTimestamp(optInt(row, "redacted_at")),
    data: parseJson<JsonValue>(text(row, "data"), "event data"),
  };
}

/**
 * The platform context a row's room stands for. The lane is in the session key: a voice
 * channel's text chat is the same room as its voice, but a `channel` context, not a `voice` one.
 */
function contextOf(row: Row): ContextKey | null {
  const platform = optText(row, "room_platform");
  const channel = optText(row, "room_channel");
  if (platform === null || channel === null) return null;
  const scope = optText(row, "space_scope");
  const session = optText(row, "session") ?? "";
  let kind: ContextKind;
  if (scope === null) kind = session.startsWith(`${platform}:dm:voice:`) ? "voice" : "dm";
  else if (session.startsWith(`${platform}:${scope}:voice:`)) kind = "voice";
  else if (optText(row, "room_kind") === "thread") kind = "thread";
  else kind = "channel";
  return { platform, scope, channel, kind };
}

function loggedOf(row: Row): LoggedEvent {
  return { envelope: envelopeOf(row), context: contextOf(row), handle: optText(row, "handle") };
}

/** The scope of an event that names none, from its session (§2.4). */
export function sessionScope(session: string | null, spaceId: string | null): EventScope {
  if (session === null || session === HOME_SESSION) return "self";
  if (spaceId !== null) return "room";
  return /^[^:]+:dm:/.test(session) ? "dm" : "room";
}

function limitOf(limit: number | undefined): number {
  return sqlLimit(limit ?? DEFAULT_LIMIT) ?? -1;
}

// ---- the store ------------------------------------------------------------------------------

/** The event log of one database (one character). */
export class EventStore implements EventLogStore {
  readonly registry: EventRegistry;
  readonly #db: Db;
  readonly #identity: Identity | null;
  readonly #select: string;
  readonly #listeners = new Set<RedactionListener>();
  /** Keys redacted in this process, oldest first: a later append of one is stored redacted. */
  readonly #redactedKeys = new Set<string>();

  constructor(db: Db, options: EventStoreOptions = {}) {
    this.#db = db;
    this.#identity = options.identity ?? null;
    this.registry = options.registry ?? coreEventRegistry();
    this.#select = this.#identity
      ? "SELECT e.*, r.platform AS room_platform, r.external_id AS room_channel, " +
        "r.kind AS room_kind, s.external_id AS space_scope, p.handle AS handle FROM events e " +
        "LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN spaces s ON s.id = r.space_id " +
        "LEFT JOIN persons p ON p.id = e.person_id"
      : "SELECT e.*, NULL AS room_platform, NULL AS room_channel, NULL AS room_kind, " +
        "NULL AS space_scope, NULL AS handle FROM events e";
  }

  // ---- writing ------------------------------------------------------------------------------

  /** Appends one event, inside the caller's `db.tx` when there is one (as a savepoint). */
  appendNow(write: EventWrite): EventEnvelope {
    return this.#db.tx(() => this.#insert(write, new Map()));
  }

  append(writes: readonly EventWrite[]): EventEnvelope[] {
    if (writes.length === 0) return [];
    try {
      return this.#db.tx(() => {
        const places = new Map<string, Place | null>();
        return writes.map((write) => this.#insert(write, places));
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot append to the event log", { cause });
    }
  }

  /** The place of `context`; places without an author are resolved once per batch. */
  #place(
    identity: Identity,
    context: ContextKey,
    author: PlaceAuthor | null,
    places: Map<string, Place | null>,
  ): Place | null {
    const memo = author === null ? contextKeyString(context) : null;
    if (memo !== null && places.has(memo)) return places.get(memo) ?? null;
    let place: Place | null = null;
    try {
      place = identity.resolve(context, author);
    } catch (error) {
      // A DM nobody has written in yet has no session: the event keeps no place.
      log.debug({ err: errorMessage(error), context: contextKeyString(context) }, "no place");
    }
    if (memo !== null) places.set(memo, place);
    return place;
  }

  #insert(write: EventWrite, places: Map<string, Place | null>): EventEnvelope {
    const d = write.draft;
    if (typeof d.type !== "string" || d.type === "" || /\s/.test(d.type)) {
      throw new StoreError(`event type \`${String(d.type)}\` is empty or has whitespace`);
    }
    const v = d.v ?? 1;
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new StoreError(`event \`${d.type}\`: version ${v} is not 1 or more`);
    }
    if (d.scope != null && !SCOPES.includes(d.scope)) {
      throw new StoreError(`event \`${d.type}\`: unknown scope \`${d.scope}\``);
    }
    let session = d.session ?? null;
    let spaceId = d.space_id ?? null;
    let roomId = d.room_id ?? null;
    let personId = d.person_id ?? null;
    let accountId = d.account_id ?? null;
    const identity = this.#identity;
    if (identity !== null) {
      // Ids are a lookup, not the event: when identity cannot answer, the event still goes in.
      try {
        const author = write.author ?? null;
        let seen = false;
        if (session === null && write.context) {
          const place = this.#place(identity, write.context, author, places);
          if (place !== null) {
            session = place.session;
            spaceId ??= place.space_id;
            roomId ??= place.room_id;
            if (author !== null) {
              personId ??= place.person_id;
              seen = true;
            }
          }
        }
        if (author !== null) {
          if (personId === null && !seen) {
            personId = identity.see(author.account, author.display_name).id;
          }
          accountId ??= identity.account(author.account)?.id ?? null;
        }
        if (personId === null && write.handle) {
          personId = identity.personByHandle(write.handle)?.id ?? null;
        }
      } catch (error) {
        log.warn({ err: errorMessage(error), event: d.id }, "cannot resolve an event's place");
      }
    }
    const defaults = typeDefaults(this.registry, d.type);
    const envelope: EventEnvelope = {
      id: d.id,
      at: normalizeTimestamp(d.at),
      type: d.type,
      v,
      parent: d.parent ?? null,
      turn: d.turn ?? null,
      session,
      space_id: spaceId,
      room_id: roomId,
      person_id: personId,
      account_id: accountId,
      key: d.key ?? null,
      seq: null,
      source: write.source,
      // A DM whose session did not resolve (nobody has written in it yet) is still a DM.
      scope:
        d.scope ??
        defaults.scope ??
        (session === null && write.context?.scope === null ? "dm" : sessionScope(session, spaceId)),
      tier: defaults.tier,
      redacted_at: null,
      // A draft's `data` is typed by zod's input side of `JsonValueSchema`; producers hand JSON.
      data: (d.data ?? null) as JsonValue,
    };
    // A line of a key redacted before it reached the store (it waited in a writer's buffer).
    const late = envelope.key !== null && this.#redactedKeys.has(envelope.key);
    if (late) {
      envelope.data = { ...REDACTED_DATA };
      envelope.redacted_at = fromMicros(this.#db.nowMicros());
    }
    const inserted = this.#db.get(
      "INSERT INTO events (id, at, type, v, source, parent, turn, session, space_id, room_id, " +
        "person_id, account_id, scope, tier, key, data, redacted_at) VALUES ($id, $at, $type, " +
        "$v, $source, $parent, $turn, $session, $space_id, $room_id, $person_id, $account_id, " +
        "$scope, $tier, $key, $data, $redacted_at) ON CONFLICT (id) DO NOTHING RETURNING seq",
      {
        id: envelope.id,
        at: toMicros(envelope.at),
        type: envelope.type,
        v: envelope.v,
        source: envelope.source,
        parent: envelope.parent,
        turn: envelope.turn,
        session: envelope.session,
        space_id: envelope.space_id,
        room_id: envelope.room_id,
        person_id: envelope.person_id,
        account_id: envelope.account_id,
        scope: envelope.scope,
        tier: envelope.tier,
        key: envelope.key,
        data: JSON.stringify(envelope.data),
        redacted_at: optionalMicros(envelope.redacted_at),
      },
    );
    if (late && inserted !== undefined) this.#record(envelope, "redacted on arrival", write.source);
    if (inserted === undefined) {
      // Appended before (a retry keeps its id): what is stored stands.
      const stored = this.#db.get("SELECT * FROM events WHERE id = $id", { id: envelope.id });
      if (stored === undefined) throw new StoreError(`event \`${envelope.id}\` vanished`);
      return envelopeOf(stored);
    }
    return { ...envelope, seq: int(inserted, "seq") };
  }

  // ---- reading ------------------------------------------------------------------------------

  get(id: string): LoggedEvent | null {
    const row = this.#db.get(`${this.#select} WHERE e.id = $id`, { id });
    return row ? loggedOf(row) : null;
  }

  #seqOf(id: string): number | null {
    const row = this.#db.get("SELECT seq FROM events WHERE id = $id", { id });
    return row === undefined ? null : int(row, "seq");
  }

  query(query: EventQuery = {}): LoggedEvent[] {
    const where: string[] = [];
    const params: Params = { limit: limitOf(query.limit) };
    const add = (clause: string, name: string, value: SQLInputValue) => {
      where.push(clause);
      params[name] = value;
    };
    const list = (column: string, name: string, values: readonly string[]) =>
      add(`e.${column} IN (SELECT value FROM json_each($${name}))`, name, JSON.stringify(values));

    if (query.types) {
      if (query.types.length === 0) return [];
      // One type: `(type, seq)` serves it in order. Several (a reader's whole family): the `+`
      // keeps the planner off that index, which would read every row of them and sort.
      if (query.types.length === 1) add("e.type = $type", "type", query.types[0] as string);
      else
        add(
          "+e.type IN (SELECT value FROM json_each($types))",
          "types",
          JSON.stringify(query.types),
        );
    }
    if (query.sources) {
      if (query.sources.length === 0) return [];
      list("source", "sources", query.sources);
    }
    let session = query.session;
    if (query.context) {
      const found = this.#identity?.sessionOf(query.context) ?? null;
      // A place nobody resolved has no events; nor do two different sessions at once.
      if (found === null || (session !== undefined && session !== found)) return [];
      session = found;
    }
    if (session !== undefined) add("e.session = $session", "session", session);
    let personId = query.personId;
    if (query.handle !== undefined) {
      const found = this.#identity?.personByHandle(query.handle)?.id ?? null;
      if (found === null || (personId !== undefined && personId !== found)) return [];
      personId = found;
    }
    if (personId !== undefined) add("e.person_id = $person", "person", personId);
    if (query.key !== undefined) add("e.key = $key", "key", query.key);
    if (query.turn !== undefined) add("e.turn = $turn", "turn", query.turn);
    if (query.parents) {
      if (query.parents.length === 0) return [];
      list("parent", "parents", query.parents);
    }
    // A time window also bounds `seq` (taking nothing away: every row in the window is within
    // the bound), so the planner walks the primary key in order instead of sorting the window.
    if (query.since !== undefined) {
      add(
        "e.at >= $since AND e.seq >= (SELECT min(seq) FROM events WHERE at >= $since)",
        "since",
        toMicros(query.since),
      );
    }
    if (query.until !== undefined) {
      add(
        "e.at < $until AND e.seq <= (SELECT max(seq) FROM events WHERE at < $until)",
        "until",
        toMicros(query.until),
      );
    }
    for (const [id, op, name] of [
      [query.after, ">", "after"],
      [query.before, "<", "before"],
    ] as const) {
      if (id === undefined) continue;
      const seq = this.#seqOf(id);
      // An id that is gone (compacted) still pages: ULIDs sort in creation order.
      if (seq === null) add(`e.id ${op} $${name}`, name, id);
      else add(`e.seq ${op} $${name}`, name, seq);
    }
    if (query.afterSeq !== undefined) add("e.seq > $after_seq", "after_seq", query.afterSeq);
    if (query.beforeSeq !== undefined) add("e.seq < $before_seq", "before_seq", query.beforeSeq);
    const filter = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    const order = query.order === "asc" ? "ASC" : "DESC";
    return this.#db
      .all(`${this.#select}${filter} ORDER BY e.seq ${order} LIMIT $limit`, params)
      .map(loggedOf);
  }

  // ---- redaction ----------------------------------------------------------------------------

  /** A bound function: it works on wrappers of the store (`Object.create`) too. */
  readonly onRedacted = (listener: RedactionListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Appends the `privacy.redacted` record of `target` (never its text). */
  #record(target: EventEnvelope, reason: string, source: string): EventEnvelope {
    return this.#insert(
      {
        draft: {
          id: newId(),
          at: fromMicros(this.#db.nowMicros()),
          type: PrivacyRedacted.type,
          v: PrivacyRedacted.v,
          // Not `parent`: a record kept forever would keep the redacted row forever too.
          session: target.session,
          space_id: target.space_id,
          room_id: target.room_id,
          person_id: target.person_id,
          data: { target: target.id, reason },
        },
        source,
      },
      new Map(),
    );
  }

  /** Redacts `rows` and records each; the caller holds the transaction. */
  #redactRows(rows: readonly Row[], reason: string, source: string): EventEnvelope[] {
    const at = this.#db.nowMicros();
    const records: EventEnvelope[] = [];
    for (const row of rows) {
      const target = envelopeOf(row);
      if (target.redacted_at !== null) continue;
      this.#db.run(
        "UPDATE events SET data = $data, redacted_at = $at WHERE id = $id AND redacted_at IS NULL",
        { data: REDACTED_JSON, at, id: target.id },
      );
      records.push(this.#record(target, reason, source));
    }
    return records;
  }

  /**
   * Tells the listeners once the redaction is committed: inside a larger transaction (forgetting a
   * person runs every schema's hook in one) that is when the whole of it is, and never when it
   * rolls back.
   */
  #told(redaction: Redaction): void {
    if (redaction.ids.length === 0 && redaction.keys.length === 0) return;
    this.#db.afterCommit(() => {
      for (const key of redaction.keys) {
        this.#redactedKeys.delete(key);
        this.#redactedKeys.add(key);
      }
      while (this.#redactedKeys.size > REDACTED_KEYS) {
        const oldest = this.#redactedKeys.values().next().value;
        if (oldest === undefined) break;
        this.#redactedKeys.delete(oldest);
      }
      for (const listener of this.#listeners) {
        try {
          listener(redaction);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "a redaction listener failed");
        }
      }
    });
  }

  redact(id: string, reason: string, source: string): EventEnvelope | null {
    let records: EventEnvelope[];
    try {
      records = this.#db.tx(() => {
        const row = this.#db.get("SELECT * FROM events WHERE id = $id", { id });
        return row === undefined ? [] : this.#redactRows([row], reason, source);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot redact the event", { cause });
    }
    const record = records[0] ?? null;
    if (record !== null) this.#told({ ids: [id], keys: [] });
    return record;
  }

  /**
   * Redacts every event `filter` matches, in one transaction, each with its `privacy.redacted`
   * record; returns the records. A filter must name a key or a person: nothing redacts the
   * whole log.
   */
  redactWhere(filter: RedactionFilter, reason: string, source: string): EventEnvelope[] {
    if (filter.key === undefined && filter.personId === undefined) {
      throw new StoreError("a redaction names a key or a person");
    }
    if (filter.types?.length === 0) return [];
    const where = ["redacted_at IS NULL"];
    const params: Params = {};
    if (filter.key !== undefined) {
      where.push("key = $key");
      params.key = filter.key;
    }
    if (filter.personId !== undefined) {
      where.push("person_id = $person");
      params.person = filter.personId;
    }
    if (filter.types !== undefined) {
      where.push("type IN (SELECT value FROM json_each($types))");
      params.types = JSON.stringify(filter.types);
    }
    let records: EventEnvelope[];
    try {
      records = this.#db.tx(() => {
        const rows = this.#db.all(
          `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq`,
          params,
        );
        return this.#redactRows(rows, reason, source);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot redact the events", { cause });
    }
    const keys = filter.key === undefined ? [] : [filter.key];
    const ids = records.flatMap((r) => {
      const data = r.data;
      return isJsonObject(data) && typeof data.target === "string" ? [data.target] : [];
    });
    this.#told({ ids, keys });
    return records;
  }

  /**
   * Takes the words out of the events `filter` matches and keeps the rest of their payload: each
   * of `fields` that holds a non-empty string becomes `""`, and the payload is marked
   * `"redacted": true` (core migration 7). For events that must stay readable after "forget me"
   * (a change's numbers are the day's caps and a person's history), where `redactWhere` would take
   * the whole payload. An event with none of `fields` to empty is left as it is. In one
   * transaction, each with its `privacy.redacted` record; returns the records.
   */
  redactFields(
    filter: RedactionFilter,
    fields: readonly string[],
    reason: string,
    source: string,
  ): EventEnvelope[] {
    if (filter.key === undefined && filter.personId === undefined) {
      throw new StoreError("a redaction names a key or a person");
    }
    if (filter.types?.length === 0 || fields.length === 0) return [];
    const where = ["redacted_at IS NULL"];
    const params: Params = {};
    if (filter.key !== undefined) {
      where.push("key = $key");
      params.key = filter.key;
    }
    if (filter.personId !== undefined) {
      where.push("person_id = $person");
      params.person = filter.personId;
    }
    if (filter.types !== undefined) {
      where.push("type IN (SELECT value FROM json_each($types))");
      params.types = JSON.stringify(filter.types);
    }
    let records: EventEnvelope[];
    try {
      records = this.#db.tx(() => {
        const at = this.#db.nowMicros();
        const out: EventEnvelope[] = [];
        const rows = this.#db.all(
          `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq`,
          params,
        );
        for (const row of rows) {
          const target = envelopeOf(row);
          const data = target.data;
          if (!isJsonObject(data) || data.redacted === true) continue;
          const words = fields.filter((f) => typeof data[f] === "string" && data[f] !== "");
          if (words.length === 0) continue;
          const kept: Record<string, JsonValue> = { ...data, redacted: true };
          for (const f of words) kept[f] = "";
          this.#db.run(
            "UPDATE events SET data = $data, redacted_at = $at WHERE id = $id AND redacted_at IS NULL",
            { data: JSON.stringify(kept), at, id: target.id },
          );
          out.push(this.#record(target, reason, source));
        }
        return out;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot redact the events", { cause });
    }
    const ids = records.flatMap((r) => {
      const data = r.data;
      return isJsonObject(data) && typeof data.target === "string" ? [data.target] : [];
    });
    // No keys: a later event of the same key is not one whose words were asked to go.
    this.#told({ ids, keys: [] });
    return records;
  }

  // ---- compaction ---------------------------------------------------------------------------

  /** Rows of `tier` from before `before` that no row names as its parent, oldest first. */
  #leaves(tier: CompactedTier, before: Timestamp, limit: number): Row[] {
    return this.#db.all(
      "SELECT e.seq, e.at, e.type, e.source FROM events e WHERE e.tier = $tier " +
        "AND e.at < $before AND NOT EXISTS (SELECT 1 FROM events c WHERE c.parent = e.id) " +
        "ORDER BY e.at LIMIT $limit",
      { tier, before: toMicros(before), limit },
    );
  }

  /** Counts `rows` in the rollups and deletes them. */
  #remove(rows: readonly Row[]): void {
    const groups = new Map<string, { day: number; type: string; source: string; at: number[] }>();
    for (const row of rows) {
      const at = int(row, "at");
      const day = Math.floor(at / DAY_MICROS) * DAY_MICROS;
      const type = text(row, "type");
      const source = text(row, "source");
      const key = JSON.stringify([day, type, source]);
      let group = groups.get(key);
      if (!group) {
        group = { day, type, source, at: [] };
        groups.set(key, group);
      }
      group.at.push(at);
    }
    for (const group of groups.values()) {
      this.#db.run(
        "INSERT INTO event_rollups (day, type, source, count, first_at, last_at) " +
          "VALUES ($day, $type, $source, $count, $first, $last) " +
          "ON CONFLICT (day, type, source) DO UPDATE SET count = count + excluded.count, " +
          "first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)",
        {
          day: group.day,
          type: group.type,
          source: group.source,
          count: group.at.length,
          first: Math.min(...group.at),
          last: Math.max(...group.at),
        },
      );
    }
    this.#db.run("DELETE FROM events WHERE seq IN (SELECT value FROM json_each($seqs))", {
      seqs: JSON.stringify(rows.map((r) => int(r, "seq"))),
    });
  }

  compact(policy: EventCompaction): EventCompactionResult {
    let left = Math.max(1, Math.floor(policy.maxRows));
    try {
      return this.#db.tx(() => {
        const removed: Record<CompactedTier, number> = { ambient: 0, short: 0, long: 0 };
        for (const tier of COMPACTED_TIERS) {
          const before = policy.before[tier];
          if (before === null || left === 0) continue;
          const rows = this.#leaves(tier, before, left);
          if (rows.length === 0) continue;
          this.#remove(rows);
          removed[tier] = rows.length;
          left -= rows.length;
        }
        return { removed, more: removed.ambient + removed.short + removed.long > 0 };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot compact the event log", { cause });
    }
  }

  rollups(limit: number): EventRollup[] {
    return this.#db
      .all("SELECT * FROM event_rollups ORDER BY day DESC, type, source LIMIT $limit", {
        limit: limitOf(limit),
      })
      .map((r) => ({
        day: fromMicros(int(r, "day")),
        type: text(r, "type"),
        source: text(r, "source"),
        count: int(r, "count"),
        first_at: fromMicros(int(r, "first_at")),
        last_at: fromMicros(int(r, "last_at")),
      }));
  }
}
