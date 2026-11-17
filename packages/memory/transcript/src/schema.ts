// The tables of the `transcript` plugin: L1 of her memory (docs/design/v5-architecture.md §7.4,
// docs/design/v5-brain.md B3), as Drizzle definitions. One transcript per session, in the model's
// own message form, append-only, compacted when it grows, kept across restarts.
//
// The design names this `memory_transcripts` under the `memory` plugin. It is a plugin of its own
// here: a store plugin is one schema with one piece of code over it, and the `memory` plugin is
// the record store of `memory/memory`, which phase 3 redesigns separately. The runner's lint wants
// every table of a plugin under its prefix, so the tables are `transcript_*`.
//
// - `transcript_sessions`: one row per session that has a transcript. The key is the identity
//   layer's session key (`sessions.key`: `discord:<guild>:<channel>`, `discord:dm:<person>`,
//   `home`), with the platform context last written from, so a transcript is found from a
//   `ContextKey` even before identity knows the room. It holds the next sequence number (sequences
//   are never reused, also after a sweep) and the runner's own state blob.
// - `transcript_entries`: the conversation. `(session, seq)` is the order the model sees.
// - `transcript_summaries`: what stands for every entry of a session up to `upto_seq`. The newest
//   row of a session is the one in use; older rows are history.
//
// No foreign keys: like the event log, a transcript must accept a session, a person or a room
// that identity has not resolved (or that a wipe of another category removed). `migrations.ts`
// holds the SQL drizzle-kit generates from these tables, `STRICT` added; the store's drift test
// keeps the two together.

import { micros } from "@miyoria/store";
import type { AccountRef, ContextKey, JsonValue } from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * What an entry is:
 * - `other`: a line of someone else (typed or spoken);
 * - `self`: a line of hers (an assistant message without tool calls);
 * - `tool_calls`: an assistant message of hers that calls tools (it may also carry text);
 * - `tool_result`: the result of one of those calls;
 * - `note`: something the runner put there (an inbox item, a quoted reply parent).
 */
export const ENTRY_KINDS = ["other", "self", "tool_calls", "tool_result", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** An image of a line, by reference: never its bytes. */
export interface ImageRef {
  /** Where it is: a platform attachment id, an artifact id or a URL. */
  ref: string;
  /** What stands in for it as text; `null`: not described. */
  alt: string | null;
}

/** A tool call as the model wrote it. `arguments` is its raw text, valid JSON or not. */
export interface StoredToolCall {
  id: string;
  name: string;
  arguments: string;
}

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const transcriptSessions = sqliteTable(
  "transcript_sessions",
  {
    /** The identity layer's session key. */
    session: text().primaryKey(),
    /** The platform context it was last written from; `null`: never given (`home`). */
    context: text({ mode: "json" }).$type<ContextKey>(),
    /** The canonical text of `context` (`contextText`), for lookup. */
    context_key: text(),
    /** The sequence the next entry gets. Starts at 1 and only grows. */
    next_seq: integer().notNull().default(1),
    /** The runner's state for this session (the loaded tools); opaque here. */
    state: text({ mode: "json" }).$type<JsonValue>(),
    /** The version of the shape of `state`, as its writer numbers it. */
    state_version: integer().notNull().default(0),
    created_at: micros().notNull(),
    /** When an entry was last appended: what the idle sweep goes by. */
    last_at: micros().notNull(),
  },
  (t) => [
    index("transcript_sessions_context_idx")
      .on(t.context_key)
      .where(sql`${t.context_key} IS NOT NULL`),
    index("transcript_sessions_last_idx").on(t.last_at),
    check("transcript_sessions_next_seq_check", sql`${t.next_seq} >= 1`),
  ],
);

export const transcriptEntries = sqliteTable(
  "transcript_entries",
  {
    session: text().notNull(),
    /** 1, 2, 3, ... within the session, in the order appended. */
    seq: integer().notNull(),
    kind: text({ enum: ENTRY_KINDS }).notNull(),
    /** Who spoke (`other`), or whom a note quotes; identity's `persons.id`. */
    person_id: text(),
    /** The account they spoke from. */
    account: text({ mode: "json" }).$type<AccountRef>(),
    /** The name shown at the time. */
    author: text(),
    /** The text. Empty for a call without words, and once redacted. */
    content: text().notNull().default(""),
    /** The images of the line, as references. */
    images: text({ mode: "json" }).$type<ImageRef[]>(),
    /** `tool_calls`: the calls, in the model's order. */
    tool_calls: text({ mode: "json" }).$type<StoredToolCall[]>(),
    /** `tool_result`: the call it answers. */
    tool_call_id: text(),
    /** Her reasoning for this assistant message. */
    reasoning: text(),
    /** The turn that produced it; `null` for what arrived between turns. */
    turn: text(),
    /** The platform's id of the message, when it is one: how an edit or a redaction finds it. */
    message_id: text(),
    /** The platform id of the message it replies to. */
    reply_to: text(),
    /** `note`: what kind (`inbox`, `reply_parent`, ...), the runner's word. */
    label: text(),
    /** `note`: the sequence of the entry it is about. */
    about_seq: integer(),
    /** `other`: said to her (a mention, a reply to her, a DM). */
    addressed: integer({ mode: "boolean" }).notNull().default(false),
    /** `other`: written by a bot account. */
    bot: integer({ mode: "boolean" }).notNull().default(false),
    /** Said out loud (a voice transcript, or her speech). */
    spoken: integer({ mode: "boolean" }).notNull().default(false),
    /** The input defence flagged it, with this note; the line is then shown as data. */
    flagged: text(),
    /** Her line was cut off, or never delivered. */
    interrupted: integer({ mode: "boolean" }).notNull().default(false),
    /** With `interrupted`: the part that reached anyone (empty: none of it). */
    heard: text(),
    /** A rough token count of what the entry adds to a prompt. */
    tokens: integer().notNull().default(0),
    at: micros().notNull(),
    /** Set when its text was removed (a redaction, a forgotten person); the row stays. */
    redacted_at: micros(),
  },
  (t) => [
    primaryKey({ name: "transcript_entries_pk", columns: [t.session, t.seq] }),
    index("transcript_entries_message_idx")
      .on(t.message_id)
      .where(sql`${t.message_id} IS NOT NULL`),
    index("transcript_entries_person_idx").on(t.person_id).where(sql`${t.person_id} IS NOT NULL`),
    index("transcript_entries_turn_idx").on(t.session, t.turn).where(sql`${t.turn} IS NOT NULL`),
    check("transcript_entries_kind_check", sql`${t.kind} IN (${oneOf(ENTRY_KINDS)})`),
    check("transcript_entries_seq_check", sql`${t.seq} >= 1`),
    // A result names its call; calls are on a `tool_calls` entry and nowhere else.
    check(
      "transcript_entries_tool_check",
      sql`(${t.kind} = 'tool_result') = (${t.tool_call_id} IS NOT NULL) AND (${t.kind} = 'tool_calls') = (${t.tool_calls} IS NOT NULL)`,
    ),
  ],
);

export const transcriptSummaries = sqliteTable(
  "transcript_summaries",
  {
    /** The order they were made in: the newest of a session is the one in use. */
    id: integer().primaryKey({ autoIncrement: true }),
    session: text().notNull(),
    /** It stands for every entry with `seq <= upto_seq`. */
    upto_seq: integer().notNull(),
    /** The summary. Empty once `stale_at` is set by a redaction. */
    summary: text().notNull(),
    /** A rough token count of `summary`. */
    tokens: integer().notNull().default(0),
    /** The tokens it took the place of (the entries, and the summary before it). */
    tokens_replaced: integer().notNull().default(0),
    /** The turn that made it; `null`: made between turns. */
    turn: text(),
    made_at: micros().notNull(),
    /** Set when an entry it covers lost its text: the summary has to be made again. */
    stale_at: micros(),
  },
  (t) => [
    index("transcript_summaries_session_idx").on(t.session, t.id),
    check("transcript_summaries_upto_check", sql`${t.upto_seq} >= 1`),
  ],
);

export type TranscriptSessionRow = typeof transcriptSessions.$inferSelect;
export type TranscriptEntryRow = typeof transcriptEntries.$inferSelect;
export type TranscriptSummaryRow = typeof transcriptSummaries.$inferSelect;
