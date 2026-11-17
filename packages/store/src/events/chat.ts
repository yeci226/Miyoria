// Chat lines on the event log (docs/design/v5-data.md §2.7, §8 step 5): what people say in text
// and voice and what she says and sends, one event each, and `MessageLog` read back from them.
//
// - Writing: `message`, `utterance` and `playback` take the bus events' data as they are, so the
//   payload is what the platform delivered. The place (session, space, room) and, for people's
//   lines, the person and account are resolved through identity when the line is stored; scope
//   comes from the session and the tier from the type (`long`). A line is stored once: the same
//   message or utterance arriving again (two connections, a replay) is left out by its key.
// - Reading: `MessageLog` keeps its interface. `recent` reads a session's lines over a partial
//   index, newest first, skipping redacted ones; `authoredSince` counts them, redacted ones too
//   (the envelope stays for counts). The profile argument is ignored: one database belongs to
//   one character (decision D6).
// - Forgetting: "do not remember this" (`redactMessage`) redacts every event filed under the
//   message's key, her observations of it included; "forget me" (`forgetPerson`) redacts every
//   line of a person, in one transaction each.
//
// Her text lines carry no person or account (she is not a person in identity): `self` in the
// payload marks them. Her voice lines name her account in the payload's `speaker`.

import {
  CHAT_EVENT_TYPES,
  type EventEnvelope,
  type PlatformMessage,
  PlatformMessageCreated,
  type VoicePlayback,
  VoicePlaybackEvent,
  VoiceUtteranceEvent,
} from "@miyoria/contracts/events";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  type ContextKind,
  type IncomingMessage,
  incomingText,
  type MessageRef,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
  type TurnId,
  type VoiceUtterance,
} from "@miyoria/types";
import { fromMicros, parseJson, StoreError, sqlLimit, toMicros } from "../common.js";
import type { Db, Row } from "../db.js";
import type { Identity } from "../identity/identity.js";
import type { AuthoredEntry, LogEntry } from "../records.js";
import type { MessageLog } from "../stores.js";
import type { Awaitable, EventStore, EventWrite } from "./log.js";
import { FactsObservationSaid } from "./types.js";

const log = getLogger("store.chat");

/**
 * The chat types as SQL, written out: the partial indexes of core migration 3 carry the same
 * list, and SQLite uses a partial index only when the query names its condition.
 */
export const CHAT_TYPES_SQL =
  "type IN ('platform.message.created', 'voice.utterance', 'voice.playback')";

/** What `forgetPerson` redacts: their lines, and her observations of what they said. */
const PERSON_LINE_TYPES: readonly string[] = [...CHAT_EVENT_TYPES, FactsObservationSaid.type];

/** The key a text message is filed under, the same as her observation of it. */
export function messageKey(ref: MessageRef): string {
  return `msg:${ref.context.platform}:${ref.id}`;
}

/** The key a voice utterance is filed under, the same as her observation of it. */
export function utteranceKey(id: string): string {
  return `voice:utterance:${id}`;
}

/** Where a line came from, besides its payload. */
export interface ChatLineOptions {
  /** The module that published it (Core's to stamp; the writer passes it on). */
  source: string;
  /** The turn that produced or consumed it. */
  turn?: TurnId | null;
}

/** Writing chat lines and forgetting them. */
export interface ChatLogStore {
  /** A text message; `self` when one of her accounts wrote it. `null`: already stored. */
  message(
    message: IncomingMessage,
    options: ChatLineOptions & { self: boolean },
  ): Awaitable<EventEnvelope | null>;
  /** What someone said in a voice room. `null`: already stored. */
  utterance(utterance: VoiceUtterance, options: ChatLineOptions): Awaitable<EventEnvelope | null>;
  /** A sentence of hers starting to play, at `at`. */
  playback(
    playback: VoicePlayback,
    options: ChatLineOptions & { at: Timestamp },
  ): Awaitable<EventEnvelope | null>;
  /**
   * "Do not remember this": redacts the message's line and every other event filed under its
   * key (her observations of it), in one transaction. Returns the ids redacted.
   */
  redactMessage(message: MessageRef, reason: string, source: string): Awaitable<string[]>;
  /**
   * "Forget me": redacts every line of `person` (and her observations of what they said), in
   * one transaction. Returns how many.
   */
  forgetPerson(person: PersonId, reason: string, source: string): Awaitable<number>;
  /** The ids of the events filed under `key`, redacted ones too. */
  eventsOf(key: string): Awaitable<string[]>;
  /** Which of `ids` name a redacted event. */
  redacted(ids: readonly string[]): Awaitable<Set<string>>;
}

type ChatData =
  | { type: typeof PlatformMessageCreated.type; data: PlatformMessage }
  | { type: typeof VoiceUtteranceEvent.type; data: VoiceUtterance }
  | { type: typeof VoicePlaybackEvent.type; data: VoicePlayback };

/** A stored payload, checked against its type's schema; `null` when it does not fit. */
function chatData(type: string, json: unknown): ChatData | null {
  switch (type) {
    case PlatformMessageCreated.type: {
      const r = PlatformMessageCreated.data.safeParse(json);
      return r.success ? { type, data: r.data } : null;
    }
    case VoiceUtteranceEvent.type: {
      const r = VoiceUtteranceEvent.data.safeParse(json);
      return r.success ? { type, data: r.data } : null;
    }
    case VoicePlaybackEvent.type: {
      const r = VoicePlaybackEvent.data.safeParse(json);
      return r.success ? { type, data: r.data } : null;
    }
    default:
      return null;
  }
}

function str(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`events column \`${column}\` is not text`);
  return v;
}

function optStr(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
}

function int(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`events column \`${column}\` is not a number`);
}

/** The kind of place of a line whose payload is gone (redacted), from its envelope. */
function envelopeKind(session: string | null, roomKind: string | null): ContextKind {
  if (session !== null && /^[^:]+:dm:voice:/.test(session)) return "voice";
  if (session !== null && /^[^:]+:dm:/.test(session)) return "dm";
  if (session !== null && /^[^:]+:[^:]+:voice:/.test(session)) return "voice";
  return roomKind === "thread" ? "thread" : "channel";
}

/** The entry a stored line reads as. */
function entryOf(profile: ProfileId, row: Row, line: ChatData): LogEntry {
  const base = {
    id: str(row, "id"),
    profile,
    ts: fromMicros(int(row, "at")),
    turn: optStr(row, "turn"),
  };
  switch (line.type) {
    case PlatformMessageCreated.type: {
      const m = line.data;
      return {
        ...base,
        context: m.id.context,
        author: m.author.account,
        author_name: m.author.display_name,
        text: incomingText(m),
        is_self: m.self === true,
      };
    }
    case VoiceUtteranceEvent.type: {
      const u = line.data;
      return {
        ...base,
        context: u.context,
        author: u.speaker.account,
        author_name: u.speaker.display_name,
        text: u.text,
        is_self: false,
      };
    }
    case VoicePlaybackEvent.type: {
      const p = line.data;
      return {
        ...base,
        context: p.context,
        author: p.speaker?.account ?? { platform: p.context.platform, id: "" },
        author_name: p.speaker?.display_name ?? "",
        text: p.text,
        is_self: true,
      };
    }
  }
}

/** The chat lines of one database (one character), and `MessageLog` over them. */
export class ChatLog implements MessageLog, ChatLogStore {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #identity: Identity;

  constructor(db: Db, events: EventStore, identity: Identity) {
    this.#db = db;
    this.#events = events;
    this.#identity = identity;
  }

  // ---- writing ------------------------------------------------------------------------------

  /** Appends `write` unless a line of its type is filed under its key already. */
  #record(write: EventWrite): EventEnvelope | null {
    return this.#db.tx(() => {
      const key = write.draft.key ?? null;
      if (key !== null) {
        const stored = this.#db.get("SELECT 1 AS x FROM events WHERE key = $key AND type = $type", {
          key,
          type: write.draft.type,
        });
        if (stored !== undefined) return null;
      }
      return this.#events.appendNow(write);
    });
  }

  message(
    message: IncomingMessage,
    options: ChatLineOptions & { self: boolean },
  ): EventEnvelope | null {
    const data: PlatformMessage = options.self ? { ...message, self: true } : { ...message };
    return this.#record({
      draft: {
        id: newId(),
        at: message.ts,
        type: PlatformMessageCreated.type,
        v: PlatformMessageCreated.v,
        turn: options.turn ?? null,
        key: messageKey(message.id),
        data,
      },
      source: options.source,
      context: message.id.context,
      // Her own lines name no person: she is not one of the people she meets.
      author: options.self ? null : message.author,
    });
  }

  utterance(utterance: VoiceUtterance, options: ChatLineOptions): EventEnvelope | null {
    return this.#record({
      draft: {
        id: newId(),
        at: utterance.ended_at,
        type: VoiceUtteranceEvent.type,
        v: VoiceUtteranceEvent.v,
        turn: options.turn ?? null,
        key: utteranceKey(utterance.id),
        data: utterance,
      },
      source: options.source,
      context: utterance.context,
      author: utterance.speaker,
    });
  }

  playback(
    playback: VoicePlayback,
    options: ChatLineOptions & { at: Timestamp },
  ): EventEnvelope | null {
    return this.#record({
      draft: {
        id: newId(),
        at: options.at,
        type: VoicePlaybackEvent.type,
        v: VoicePlaybackEvent.v,
        turn: options.turn ?? playback.turn,
        data: playback,
      },
      source: options.source,
      context: playback.context,
    });
  }

  // ---- MessageLog -----------------------------------------------------------------------------

  /** A line from a `LogEntry`, as the bus would have carried it. */
  async append(entry: LogEntry): Promise<void> {
    const source = "store.messages";
    const turn = entry.turn;
    try {
      this.#db.tx(() => {
        if (this.#db.get("SELECT 1 AS x FROM events WHERE id = $id", { id: entry.id })) {
          throw new StoreError(`log entry \`${entry.id}\` already exists`);
        }
        const ts = fromMicros(toMicros(entry.ts));
        const author = { account: entry.author, display_name: entry.author_name, is_bot: false };
        let write: EventWrite;
        if (entry.context.kind === "voice" && entry.is_self) {
          const data: VoicePlayback = {
            context: entry.context,
            turn,
            state: "started",
            text: entry.text,
            speaker: { ...author, is_bot: true },
          };
          write = {
            draft: { id: entry.id, at: ts, type: VoicePlaybackEvent.type, turn, data },
            source,
            context: entry.context,
          };
        } else if (entry.context.kind === "voice") {
          const data: VoiceUtterance = {
            id: entry.id,
            context: entry.context,
            speaker: author,
            text: entry.text,
            language: null,
            emotion: null,
            audio_events: [],
            started_at: ts,
            ended_at: ts,
            asr_ms: 0,
          };
          write = {
            draft: { id: entry.id, at: ts, type: VoiceUtteranceEvent.type, turn, data },
            source,
            context: entry.context,
            author,
          };
        } else {
          const data: PlatformMessage = {
            id: { context: entry.context, id: entry.id },
            author,
            text: entry.text,
            mentions_self: false,
            reply_to_self: false,
            attachments: [],
            ts,
            ...(entry.is_self ? { self: true } : {}),
          };
          write = {
            draft: { id: entry.id, at: ts, type: PlatformMessageCreated.type, turn, data },
            source,
            context: entry.context,
            author: entry.is_self ? null : author,
          };
        }
        this.#events.appendNow(write);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot append log entry", { cause });
    }
  }

  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const n = sqlLimit(limit) ?? -1;
    if (n === 0) return [];
    const session = this.#identity.sessionOf(context);
    if (session === null) return [];
    const rows = this.#db.all(
      "SELECT id, at, type, turn, data FROM events WHERE session = $session AND " +
        `${CHAT_TYPES_SQL} AND redacted_at IS NULL ORDER BY at DESC, seq DESC LIMIT $limit`,
      { session, limit: n },
    );
    const out: LogEntry[] = [];
    for (const row of rows.reverse()) {
      const line = chatData(str(row, "type"), parseJson(str(row, "data"), "chat line"));
      if (line === null) {
        log.warn({ event: row.id }, "a stored chat line does not fit its type: left out");
        continue;
      }
      out.push(entryOf(profile, row, line));
    }
    return out;
  }

  async authoredSince(
    _profile: ProfileId,
    authors: readonly AccountRef[],
    since: Timestamp,
    limit: number,
  ): Promise<AuthoredEntry[]> {
    const accounts = authors.flatMap((a) => this.#identity.account(a)?.id ?? []);
    if (accounts.length === 0) return [];
    const rows = this.#db.all(
      "SELECT e.at, e.session, r.kind AS room_kind, " +
        "coalesce(json_extract(e.data, '$.id.context.kind'), " +
        "json_extract(e.data, '$.context.kind')) AS kind FROM events e " +
        "LEFT JOIN rooms r ON r.id = e.room_id WHERE e.account_id IN " +
        `(SELECT value FROM json_each($accounts)) AND e.${CHAT_TYPES_SQL} AND e.at >= $since ` +
        "ORDER BY e.at DESC, e.seq DESC LIMIT $limit",
      {
        accounts: JSON.stringify(accounts),
        since: toMicros(since),
        limit: sqlLimit(limit) ?? -1,
      },
    );
    return rows.reverse().map((row) => ({
      ts: fromMicros(int(row, "at")),
      kind:
        (optStr(row, "kind") as ContextKind | null) ??
        envelopeKind(optStr(row, "session"), optStr(row, "room_kind")),
    }));
  }

  async purge(_profile: ProfileId): Promise<number> {
    return this.#db.run(`DELETE FROM events WHERE ${CHAT_TYPES_SQL}`);
  }

  // ---- forgetting ---------------------------------------------------------------------------

  redactMessage(message: MessageRef, reason: string, source: string): string[] {
    return this.#events
      .redactWhere({ key: messageKey(message) }, reason, source)
      .flatMap((r) => targetOf(r) ?? []);
  }

  forgetPerson(person: PersonId, reason: string, source: string): number {
    return this.#events.redactWhere({ personId: person, types: PERSON_LINE_TYPES }, reason, source)
      .length;
  }

  eventsOf(key: string): string[] {
    return this.#db
      .all("SELECT id FROM events WHERE key = $key ORDER BY seq", { key })
      .map((r) => str(r, "id"));
  }

  redacted(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.#db.all(
      "SELECT id FROM events WHERE id IN (SELECT value FROM json_each($ids)) " +
        "AND redacted_at IS NOT NULL",
      { ids: JSON.stringify(ids) },
    );
    return new Set(rows.map((r) => str(r, "id")));
  }
}

/** The id a `privacy.redacted` record names. */
function targetOf(record: EventEnvelope): string | null {
  const data = record.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const target = (data as { target?: unknown }).target;
  return typeof target === "string" ? target : null;
}
