// The `transcript` plugin's tables on the store's database (`schema.ts`): one transcript per
// session, appended to as the conversation goes, read back as "the summary in use and everything
// after it" (`tail`), and cut down by replacing its oldest part with a summary (`compact`).
//
// A session is named by the identity layer's session key (`Identity.resolve(ctx).session`). A
// caller that only has a `ContextKey` asks `sessionFor(ctx)`: identity's key when it knows the
// room, else the session last written from that context.
//
// Append-only as far as the model is concerned: an entry's sequence never changes, and what an
// entry reads as changes only through the few amendments below, each of which says whether it
// rewrote an entry (`Amendment.effect`). Every write is one `Db.tx` (a savepoint inside a
// caller's), so a turn's entries commit together with whatever else the caller writes.
//
// Tool calls and their results: `tail` never returns one without the other (`pairing.ts`), and
// `compact` refuses a cut between them. The sweep only deletes behind a summary, where `tail`
// does not look.
//
// Forgetting. A redacted entry keeps its row (sequences stay dense, a call keeps its result) and
// loses its text: content, images, reasoning, the flag's note, the part heard. A summary that
// covered it may repeat what it said, and nothing here can tell which words were theirs, so every
// summary of the session that covers the entry loses its text too and is marked stale: `tail`
// returns it as `stale` with an empty summary, and the runner makes it again from the entries
// still on disk (`covered`, then `compact` at the same sequence). Keeping the old text until the
// runner got round to it would leave their words in every prompt meanwhile. What her own tool
// calls and reasoning of the time quoted from them is not found by person; a redaction by message
// id or person does not reach it (the entries behind a summary go with the sweep).

import type {
  CategoryData,
  Db,
  Identity,
  PersonForget,
  PersonMerge,
  StorePlugin,
} from "@miyoria/store";
import { tablePart } from "@miyoria/store";
import {
  type ContextKey,
  type JsonValue,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { transcriptSchema } from "./migrations.js";
import { pairedEntries, splitsPair } from "./pairing.js";
import {
  type TranscriptEntryRow,
  type TranscriptSummaryRow,
  transcriptEntries,
  transcriptSessions,
  transcriptSummaries,
} from "./schema.js";
import { entryTokens, estimateTokens } from "./tokens.js";
import type {
  Amendment,
  AppendOptions,
  CompactionMeta,
  EntryInput,
  SessionState,
  SweepResult,
  TranscriptEntry,
  TranscriptRetention,
  TranscriptSummary,
  TranscriptTail,
} from "./types.js";

const E = transcriptEntries;
const S = transcriptSessions;
const M = transcriptSummaries;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Covered entries are kept this long (`TranscriptRetention.coveredDays`). */
export const DEFAULT_COVERED_DAYS = 30;
/** An idle session's transcript is kept this long (`TranscriptRetention.idleDays`). */
export const DEFAULT_IDLE_DAYS = 90;
/** The label of the note `attachParent` appends. */
export const REPLY_PARENT_LABEL = "reply_parent";

/** A transcript was asked for something it cannot do (an unknown session, a cut inside a pair). */
export class TranscriptError extends Error {
  override readonly name = "TranscriptError";
}

/** One text for a context, exact (the kind is part of it, unlike `contextKeyString`). */
export function contextText(ctx: ContextKey): string {
  return JSON.stringify([ctx.platform, ctx.scope, ctx.channel, ctx.kind]);
}

function entryOf(row: TranscriptEntryRow): TranscriptEntry {
  return {
    session: row.session,
    seq: row.seq,
    kind: row.kind,
    person_id: row.person_id as PersonId | null,
    account: row.account,
    author: row.author,
    content: row.content,
    images: row.images ?? [],
    tool_calls: row.tool_calls ?? [],
    tool_call_id: row.tool_call_id,
    reasoning: row.reasoning,
    turn: row.turn,
    message_id: row.message_id,
    reply_to: row.reply_to,
    label: row.label,
    about_seq: row.about_seq,
    addressed: row.addressed,
    bot: row.bot,
    spoken: row.spoken,
    flagged: row.flagged,
    interrupted: row.interrupted,
    heard: row.heard,
    tokens: row.tokens,
    at: row.at,
    redacted_at: row.redacted_at,
  };
}

function summaryOf(row: TranscriptSummaryRow): TranscriptSummary {
  return {
    id: row.id,
    session: row.session,
    upto_seq: row.upto_seq,
    summary: row.summary,
    tokens: row.tokens,
    tokens_replaced: row.tokens_replaced,
    turn: row.turn,
    made_at: row.made_at,
    stale: row.stale_at !== null,
  };
}

/** The row of an entry to append. */
function rowOf(session: string, seq: number, input: EntryInput, now: Timestamp) {
  const calls = input.tool_calls ?? [];
  if (input.kind === "tool_calls" && calls.length === 0) {
    throw new TranscriptError("a `tool_calls` entry needs at least one call");
  }
  if (input.kind !== "tool_calls" && calls.length > 0) {
    throw new TranscriptError(`a \`${input.kind}\` entry cannot carry tool calls`);
  }
  if ((input.kind === "tool_result") !== (input.tool_call_id != null)) {
    throw new TranscriptError("a `tool_result` entry, and only one, names the call it answers");
  }
  const images = (input.images ?? []).map((i) => ({ ref: i.ref, alt: i.alt }));
  return {
    session,
    seq,
    kind: input.kind,
    person_id: input.person_id ?? null,
    account: input.account ?? null,
    author: input.author ?? null,
    content: input.content ?? "",
    images: images.length === 0 ? null : images,
    tool_calls:
      input.kind === "tool_calls"
        ? calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
        : null,
    tool_call_id: input.tool_call_id ?? null,
    reasoning: input.reasoning ?? null,
    turn: input.turn ?? null,
    message_id: input.message_id ?? null,
    reply_to: input.reply_to ?? null,
    label: input.label ?? null,
    about_seq: input.about_seq ?? null,
    addressed: input.addressed ?? false,
    bot: input.bot ?? false,
    spoken: input.spoken ?? false,
    flagged: input.flagged ?? null,
    interrupted: input.interrupted ?? false,
    heard: input.heard ?? null,
    tokens: input.tokens ?? entryTokens(input),
    at: input.at ?? now,
  };
}

/** A quoted parent to attach to the line that replies to it (`attachParent`). */
export interface ReplyParent {
  /** The name its author showed. */
  author: string;
  text: string;
  person_id?: PersonId | null;
  /** The parent's own platform id, so a redaction of it also finds the quote. */
  message_id?: string | null;
  /** The turn that fetched it. */
  turn?: string | null;
}

/** The session transcripts of one database. */
export class TranscriptStore {
  readonly #db: Db;
  readonly #identity: Identity | null;

  constructor(db: Db, identity: Identity | null = null) {
    this.#db = db;
    this.#identity = identity;
  }

  #now(): Timestamp {
    return toTimestamp(this.#db.clock.now());
  }

  // ---- sessions -----------------------------------------------------------------------------

  /**
   * The session of `ctx`: the identity layer's key when it knows the room (nothing is created),
   * else the session a transcript was last written to from that context; `null` when neither.
   */
  sessionFor(ctx: ContextKey): string | null {
    const known = this.#identity?.sessionOf(ctx) ?? null;
    if (known !== null) return known;
    const row = this.#db.orm
      .select({ session: S.session })
      .from(S)
      .where(eq(S.context_key, contextText(ctx)))
      .orderBy(desc(S.last_at))
      .limit(1)
      .get();
    return row?.session ?? null;
  }

  /** The platform context `session` was last written from. */
  contextOf(session: string): ContextKey | null {
    const row = this.#db.orm
      .select({ context: S.context })
      .from(S)
      .where(eq(S.session, session))
      .get();
    return row?.context ?? null;
  }

  /** Whether anything was ever appended to `session` (one cheap read, not the tail). */
  started(session: string): boolean {
    const row = this.#db.orm
      .select({ next: S.next_seq })
      .from(S)
      .where(eq(S.session, session))
      .get();
    return row !== undefined && row.next > 1;
  }

  /** The sessions that have a transcript, most recently written first. */
  sessions(): string[] {
    return this.#db.orm
      .select({ session: S.session })
      .from(S)
      .orderBy(desc(S.last_at), asc(S.session))
      .all()
      .map((r) => r.session);
  }

  /**
   * Each session written at `since` or later (every one without it): its last sequence (0: none
   * yet), when it was last written and its platform context, most recently written first.
   */
  heads(
    since: Timestamp | null = null,
  ): Array<{ session: string; last_seq: number; last_at: Timestamp; context: ContextKey | null }> {
    return this.#db.orm
      .select({ session: S.session, next: S.next_seq, last_at: S.last_at, context: S.context })
      .from(S)
      .where(since === null ? undefined : gte(S.last_at, since))
      .orderBy(desc(S.last_at), asc(S.session))
      .all()
      .map((r) => ({
        session: r.session,
        last_seq: r.next - 1,
        last_at: r.last_at,
        context: r.context ?? null,
      }));
  }

  /** The session's row, made on first use. Inside the caller's transaction. */
  #open(session: string, now: Timestamp) {
    if (session === "") throw new TranscriptError("a session key cannot be empty");
    this.#db.orm
      .insert(S)
      .values({ session, created_at: now, last_at: now })
      .onConflictDoNothing()
      .run();
    const row = this.#db.orm.select().from(S).where(eq(S.session, session)).get();
    if (!row) throw new TranscriptError(`cannot open the transcript of \`${session}\``);
    return row;
  }

  // ---- appending and reading ----------------------------------------------------------------

  /**
   * Appends `entries` in order, in one transaction, and returns the sequence each got. Sequences
   * are 1, 2, 3, ... within the session and never reused.
   */
  append(session: string, entries: readonly EntryInput[], options: AppendOptions = {}): number[] {
    return this.#db.tx(() => {
      const now = this.#now();
      const opened = this.#open(session, now);
      const seqs: number[] = [];
      let seq = opened.next_seq;
      for (const input of entries) {
        this.#db.orm
          .insert(E)
          .values(rowOf(session, seq, input, now))
          .run();
        seqs.push(seq++);
      }
      const ctx = options.context ?? null;
      this.#db.orm
        .update(S)
        .set({
          next_seq: seq,
          ...(entries.length > 0 && { last_at: now }),
          ...(ctx !== null && { context: ctx, context_key: contextText(ctx) }),
        })
        .where(eq(S.session, session))
        .run();
      return seqs;
    });
  }

  #latest(session: string): TranscriptSummaryRow | null {
    return (
      this.#db.orm
        .select()
        .from(M)
        .where(eq(M.session, session))
        .orderBy(desc(M.id))
        .limit(1)
        .get() ?? null
    );
  }

  /** The entries of `session` with `after < seq <= upto`, in order, as stored. */
  #range(session: string, after: number, upto: number | null): TranscriptEntry[] {
    return this.#db.orm
      .select()
      .from(E)
      .where(
        and(eq(E.session, session), gt(E.seq, after), upto === null ? undefined : lte(E.seq, upto)),
      )
      .orderBy(asc(E.seq))
      .all()
      .map(entryOf);
  }

  /**
   * The summary in use (if any) and every entry after it, in order. Calls and results come
   * paired: a call still waiting for its result (a turn in flight, or one a crash cut short) and
   * a result without its call are left out (`pairedEntries`).
   */
  tail(session: string): TranscriptTail {
    return this.#db.tx(() => {
      const latest = this.#latest(session);
      const entries = pairedEntries(this.#range(session, latest?.upto_seq ?? 0, null));
      return { session, summary: latest === null ? null : summaryOf(latest), entries };
    });
  }

  /**
   * The entries the summary in use stands for that are still on disk, in order (tombstones
   * included): what a stale summary is made again from.
   */
  covered(session: string): TranscriptEntry[] {
    const latest = this.#latest(session);
    return latest === null ? [] : this.#range(session, 0, latest.upto_seq);
  }

  /** One entry, as stored. */
  entry(session: string, seq: number): TranscriptEntry | null {
    const row = this.#db.orm
      .select()
      .from(E)
      .where(and(eq(E.session, session), eq(E.seq, seq)))
      .get();
    return row ? entryOf(row) : null;
  }

  /** Estimated tokens of the entries after the summary in use (the summary's own not counted). */
  tokens(session: string): number {
    const upto = this.#latest(session)?.upto_seq ?? 0;
    const row = this.#db.orm
      .select({ n: sql<number>`coalesce(sum(${E.tokens}), 0)` })
      .from(E)
      .where(and(eq(E.session, session), gt(E.seq, upto)))
      .get();
    return Number(row?.n ?? 0);
  }

  /** Every summary made for `session`, the one in use first. */
  summaries(session: string): TranscriptSummary[] {
    return this.#db.orm
      .select()
      .from(M)
      .where(eq(M.session, session))
      .orderBy(desc(M.id))
      .all()
      .map(summaryOf);
  }

  // ---- compaction ---------------------------------------------------------------------------

  /**
   * Makes `summary` stand for every entry of `session` up to `uptoSeq`. The entries stay on disk
   * until the sweep; the summaries before stay as history. Refused when the cut would part a tool
   * call from its result, when `uptoSeq` is not an entry's, or when it does not go past the
   * summary in use (the same sequence again is allowed only to replace a stale one).
   */
  compact(
    session: string,
    uptoSeq: number,
    summary: string,
    meta: CompactionMeta = {},
  ): TranscriptSummary {
    return this.#db.tx(() => {
      const opened = this.#db.orm.select().from(S).where(eq(S.session, session)).get();
      if (!opened) throw new TranscriptError(`\`${session}\` has no transcript`);
      if (!Number.isInteger(uptoSeq) || uptoSeq < 1 || uptoSeq >= opened.next_seq) {
        throw new TranscriptError(`\`${session}\` has no entry ${uptoSeq} to compact up to`);
      }
      const latest = this.#latest(session);
      const from = latest?.upto_seq ?? 0;
      const redo = latest !== null && latest.stale_at !== null && uptoSeq === from;
      if (uptoSeq <= from && !redo) {
        throw new TranscriptError(`\`${session}\` is already compacted up to ${from}`);
      }
      const after = this.#range(session, from, null);
      if (splitsPair(after, uptoSeq)) {
        throw new TranscriptError(
          `compacting \`${session}\` up to ${uptoSeq} would part a tool call from its result`,
        );
      }
      const replaced =
        meta.tokensReplaced ??
        after.filter((e) => e.seq <= uptoSeq).reduce((n, e) => n + e.tokens, 0) +
          (latest?.tokens ?? 0);
      const row = this.#db.orm
        .insert(M)
        .values({
          session,
          upto_seq: uptoSeq,
          summary,
          tokens: estimateTokens(summary),
          tokens_replaced: Math.max(0, Math.floor(replaced)),
          turn: meta.turn ?? null,
          made_at: this.#now(),
        })
        .returning()
        .get();
      return summaryOf(row);
    });
  }

  // ---- amendments ---------------------------------------------------------------------------

  /**
   * The input defence flagged platform message `messageId`: its line is from now on shown as data
   * beside `note`, not as conversation. Rewrites the entry: a flagged line must stop reading as
   * something said to her, also in the turns that already saw it. (`Session.flag` today.)
   */
  flag(session: string, messageId: string, note: string): Amendment {
    const row = this.#db.orm
      .update(E)
      .set({ flagged: note })
      .where(and(eq(E.session, session), eq(E.message_id, messageId), isNull(E.redacted_at)))
      .returning({ seq: E.seq })
      .all()
      .at(-1);
    return row ? { seq: row.seq, effect: "rewrites" } : { seq: null, effect: "none" };
  }

  /**
   * Of her line only `heard` reached anyone (an interruption; empty: nothing did, as for a reply
   * that was never delivered). The line is named by its sequence, or is the newest line with text
   * of `turn`. Rewrites the entry: the transcript must not go on saying she said what nobody
   * heard. It is normally her newest line, which no request has carried yet, so in practice the
   * cached prefix ends before it anyway. (`Session.recordInterruption`, `keepHeard` and
   * `forgetAction` today.)
   */
  heard(session: string, line: { seq: number } | { turn: string }, heard: string): Amendment {
    return this.#db.tx(() => {
      const own = and(eq(E.session, session), inArray(E.kind, ["self", "tool_calls"]));
      const found =
        "seq" in line
          ? this.#db.orm
              .select({ seq: E.seq })
              .from(E)
              .where(and(own, eq(E.seq, line.seq)))
              .get()
          : this.#db.orm
              .select({ seq: E.seq })
              .from(E)
              .where(and(own, eq(E.turn, line.turn), sql`${E.content} <> ''`))
              .orderBy(desc(E.seq))
              .limit(1)
              .get();
      if (!found) return { seq: null, effect: "none" };
      this.#db.orm
        .update(E)
        .set({ interrupted: true, heard })
        .where(and(eq(E.session, session), eq(E.seq, found.seq)))
        .run();
      return { seq: found.seq, effect: "rewrites" };
    });
  }

  /**
   * The text of the message platform message `messageId` replies to, fetched after the reply was
   * recorded. Appends a note about that entry (`REPLY_PARENT_LABEL`) and changes nothing already
   * there. (`Session.setParents` today, which put the quote before the line.)
   */
  attachParent(session: string, messageId: string, parent: ReplyParent): Amendment {
    return this.#db.tx(() => {
      const about = this.#db.orm
        .select({ seq: E.seq })
        .from(E)
        .where(and(eq(E.session, session), eq(E.message_id, messageId), ne(E.kind, "note")))
        .orderBy(desc(E.seq))
        .limit(1)
        .get();
      if (!about) return { seq: null, effect: "none" };
      const [seq] = this.append(session, [
        {
          kind: "note",
          label: REPLY_PARENT_LABEL,
          about_seq: about.seq,
          author: parent.author,
          person_id: parent.person_id ?? null,
          message_id: parent.message_id ?? null,
          content: parent.text,
          turn: parent.turn ?? null,
        },
      ]);
      return { seq: seq ?? null, effect: "appends" };
    });
  }

  /**
   * The platform's id of entry `seq`, known only once her message was delivered. Nothing the
   * model reads changes. (The echo of a pending reply in `Session.recordMessage` today.)
   */
  confirm(session: string, seq: number, messageId: string): Amendment {
    const { changes } = this.#db.orm
      .update(E)
      .set({ message_id: messageId })
      .where(and(eq(E.session, session), eq(E.seq, seq)))
      .run();
    return { seq: Number(changes) > 0 ? seq : null, effect: "none" };
  }

  // ---- forgetting ---------------------------------------------------------------------------

  /** Takes the text of the matching entries and of the summaries that covered them. */
  #redact(where: SQL | undefined): { entries: number; summaries: number } {
    return this.#db.tx(() => {
      const now = this.#now();
      const rows = this.#db.orm
        .update(E)
        .set({
          content: "",
          images: null,
          reasoning: null,
          flagged: null,
          heard: null,
          tokens: 0,
          redacted_at: now,
        })
        .where(and(where, isNull(E.redacted_at)))
        .returning({ session: E.session, seq: E.seq })
        .all();
      let summaries = 0;
      const first = new Map<string, number>();
      for (const r of rows) first.set(r.session, Math.min(first.get(r.session) ?? r.seq, r.seq));
      for (const [session, seq] of first) {
        // Notes about a redacted entry quote it or its parent: they go the same way.
        const about = rows.filter((r) => r.session === session).map((r) => r.seq);
        this.#db.orm
          .update(E)
          .set({ content: "", tokens: 0, redacted_at: now })
          .where(and(eq(E.session, session), inArray(E.about_seq, about), isNull(E.redacted_at)))
          .run();
        const { changes } = this.#db.orm
          .update(M)
          .set({ summary: "", tokens: 0, stale_at: now })
          .where(and(eq(M.session, session), sql`${M.upto_seq} >= ${seq}`, isNull(M.stale_at)))
          .run();
        summaries += Number(changes);
      }
      return { entries: rows.length, summaries };
    });
  }

  /**
   * "Do not remember this": every entry of platform message `messageId` (the line, and a quote of
   * it under another line) becomes a tombstone, in `session` or in every session. Returns how
   * many entries lost their text.
   */
  redactMessage(messageId: string, session: string | null = null): number {
    return this.#redact(
      and(eq(E.message_id, messageId), session === null ? undefined : eq(E.session, session)),
    ).entries;
  }

  /** "Forget me": every entry of the persons `ids`, in every session, becomes a tombstone. */
  forgetPerson(ids: readonly PersonId[]): { entries: number; summaries: number } {
    if (ids.length === 0) return { entries: 0, summaries: 0 };
    return this.#redact(inArray(E.person_id, [...ids]));
  }

  /** `absorb`'s entries become `keep`'s. Nothing the model reads changes. */
  mergePerson(keep: PersonId, absorb: PersonId): number {
    const { changes } = this.#db.orm
      .update(E)
      .set({ person_id: keep })
      .where(eq(E.person_id, absorb))
      .run();
    return Number(changes);
  }

  // ---- the runner's state -------------------------------------------------------------------

  readonly state = {
    /** The state kept for `session`; `null`: none. */
    get: <T = unknown>(session: string): SessionState<T> | null => {
      const row = this.#db.orm
        .select({ state: S.state, version: S.state_version })
        .from(S)
        .where(and(eq(S.session, session), isNotNull(S.state)))
        .get();
      return row ? { version: row.version, value: row.state as T } : null;
    },
    /** Replaces the state of `session` (`null` removes it). */
    set: (session: string, value: JsonValue | null, version = 1): void => {
      if (!Number.isInteger(version) || version < 0) {
        throw new TranscriptError("a state version is a whole number, 0 or more");
      }
      this.#db.tx(() => {
        this.#open(session, this.#now());
        this.#db.orm
          .update(S)
          .set({ state: value, state_version: value === null ? 0 : version })
          .where(eq(S.session, session))
          .run();
      });
    },
  };

  // ---- retention ----------------------------------------------------------------------------

  /**
   * Deletes what is past keeping: entries the summary in use covers that are older than
   * `coveredDays` (not while that summary is stale: it is made again from them), and the whole
   * transcript (entries, summaries, state) of a session nothing was appended to for `idleDays`.
   * `tail` reads only after the summary, so neither can part a call from its result there.
   */
  sweep(retention: TranscriptRetention = {}): SweepResult {
    const now = this.#db.clock.now();
    const coveredBefore = toTimestamp(
      now - (retention.coveredDays ?? DEFAULT_COVERED_DAYS) * DAY_MS,
    );
    const idleBefore = toTimestamp(now - (retention.idleDays ?? DEFAULT_IDLE_DAYS) * DAY_MS);
    return this.#db.tx(() => {
      const idle = this.#db.orm
        .select({ session: S.session })
        .from(S)
        .where(lt(S.last_at, idleBefore))
        .all()
        .map((r) => r.session);
      for (const session of idle) {
        this.#db.orm.delete(E).where(eq(E.session, session)).run();
        this.#db.orm.delete(M).where(eq(M.session, session)).run();
        this.#db.orm.delete(S).where(eq(S.session, session)).run();
      }
      let entries = 0;
      for (const session of this.sessions()) {
        const latest = this.#latest(session);
        if (latest === null || latest.stale_at !== null) continue;
        const { changes } = this.#db.orm
          .delete(E)
          .where(and(eq(E.session, session), lte(E.seq, latest.upto_seq), lt(E.at, coveredBefore)))
          .run();
        entries += Number(changes);
      }
      return { entries, sessions: idle.length };
    });
  }
}

/** The transcripts among the data categories: counted, exported and wiped with her conversation notes. */
const transcriptData: readonly CategoryData[] = [
  {
    // With her conversation notes: wiping the chat history (`messages`) takes this category too.
    // The three tables go together, so a sequence never outlives the summary that names it.
    category: "conversation",
    parts: [
      tablePart("transcript_entries", "transcript_entries", "node", "at", "session, seq", {
        session: "text",
        seq: "num",
        kind: "text",
        person_id: "text",
        account: "json",
        author: "text",
        content: "text",
        images: "json",
        tool_calls: "json",
        tool_call_id: "text",
        reasoning: "text",
        turn: "text",
        message_id: "text",
        reply_to: "text",
        label: "text",
        about_seq: "num",
        addressed: "bool",
        bot: "bool",
        spoken: "bool",
        flagged: "text",
        interrupted: "bool",
        heard: "text",
        tokens: "num",
        at: "ts",
        redacted_at: "ts",
      }),
      tablePart("transcript_summaries", "transcript_summaries", "node", "made_at", "id", {
        id: "num",
        session: "text",
        upto_seq: "num",
        summary: "text",
        tokens: "num",
        tokens_replaced: "num",
        turn: "text",
        made_at: "ts",
        stale_at: "ts",
      }),
      tablePart("transcript_sessions", "transcript_sessions", "node", "last_at", "session", {
        session: "text",
        context: "json",
        next_seq: "num",
        state: "json",
        state_version: "num",
        created_at: "ts",
        last_at: "ts",
      }),
    ],
  },
];

/**
 * The transcripts as a plugin of the store: Core opens the store with it (`STORE_PLUGINS`), so
 * the tables exist; nothing writes to them until the turn runner does. Forgetting a person takes
 * the text of what they said in every transcript; merging two moves the absorbed person's entries.
 */
export const transcriptTables: StorePlugin<TranscriptStore> = {
  schema: transcriptSchema,
  open: ({ db, identity }) => new TranscriptStore(db, identity),
  data: transcriptData,
  forgetPerson: (store, request: PersonForget) => ({ counts: store.forgetPerson(request.ids) }),
  mergePerson: (store, { keep, absorb }: PersonMerge) => ({
    counts: { entries: store.mergePerson(keep, absorb) },
  }),
};
