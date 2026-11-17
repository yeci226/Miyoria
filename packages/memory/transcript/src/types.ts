// The shapes the transcript store reads and writes (`store.ts`). Persisted, so snake_case and
// `T | null` with every key present on what is read back; what is written may leave fields out.

import type { AccountRef, ContextKey, PersonId, Timestamp } from "@miyoria/types";
import type { EntryKind, ImageRef, StoredToolCall } from "./schema.js";

export type { EntryKind, ImageRef, StoredToolCall } from "./schema.js";

/** One entry of a transcript as stored. */
export interface TranscriptEntry {
  session: string;
  /** Its place in the session: 1, 2, 3, ... */
  seq: number;
  kind: EntryKind;
  person_id: PersonId | null;
  account: AccountRef | null;
  /** The name shown at the time. */
  author: string | null;
  content: string;
  images: ImageRef[];
  /** `tool_calls` entries: the calls; empty otherwise. */
  tool_calls: StoredToolCall[];
  /** `tool_result` entries: the call answered. */
  tool_call_id: string | null;
  reasoning: string | null;
  turn: string | null;
  message_id: string | null;
  reply_to: string | null;
  label: string | null;
  about_seq: number | null;
  addressed: boolean;
  bot: boolean;
  spoken: boolean;
  /** The input defence's note; `null`: not flagged. */
  flagged: string | null;
  interrupted: boolean;
  /** With `interrupted`: the part that reached anyone. */
  heard: string | null;
  tokens: number;
  at: Timestamp;
  /** Its text was removed; the entry is a tombstone. */
  redacted_at: Timestamp | null;
}

/**
 * An entry to append: its kind, and whatever else it has. The store assigns `seq`, fills `at`
 * with now and estimates `tokens` when they are left out.
 */
export type EntryInput = Pick<TranscriptEntry, "kind"> &
  Partial<Omit<TranscriptEntry, "session" | "seq" | "kind" | "redacted_at">>;

/** What stands for the entries of a session up to `upto_seq`. */
export interface TranscriptSummary {
  id: number;
  session: string;
  upto_seq: number;
  /** Empty when `stale` came from a redaction. */
  summary: string;
  tokens: number;
  tokens_replaced: number;
  turn: string | null;
  made_at: Timestamp;
  /** An entry it covers lost its text since: it has to be made again (`compact` at `upto_seq`). */
  stale: boolean;
}

/** What the model is shown of a session: the summary in use and every entry after it, in order. */
export interface TranscriptTail {
  session: string;
  summary: TranscriptSummary | null;
  entries: TranscriptEntry[];
}

/** What `compact` records beside the summary. */
export interface CompactionMeta {
  /** The turn that made the summary. */
  turn?: string | null;
  /** The tokens it replaced; default: the entries it newly covers plus the summary before it. */
  tokensReplaced?: number;
}

/** The runner's own state of a session, opaque to the store. */
export interface SessionState<T = unknown> {
  /** The version of the shape of `value`, as its writer numbers it. */
  version: number;
  value: T;
}

/**
 * What an amendment did. `rewrites`: it changed how an entry already in the transcript reads, so
 * a prompt prefix cached up to that entry is no longer the one the next request sends (one cache
 * miss from `seq` on). `appends`: it only added an entry at the end.
 */
export interface Amendment {
  /** The entry changed or added; `null`: nothing matched. */
  seq: number | null;
  effect: "rewrites" | "appends" | "none";
}

/** How long transcripts are kept (`sweep`). */
export interface TranscriptRetention {
  /**
   * Entries the summary in use covers are deleted once they are older than this many days.
   * Default 30; the raw events stay in the event log for 365.
   */
  coveredDays?: number;
  /** The whole transcript of a session nothing was appended to for this many days goes. Default 90. */
  idleDays?: number;
}

export interface SweepResult {
  /** Covered entries deleted. */
  entries: number;
  /** Idle sessions whose transcript was deleted whole. */
  sessions: number;
}

/** Where a session's transcript is written from. */
export interface AppendOptions {
  /** The platform context of the session, remembered for `sessionFor`. */
  context?: ContextKey | null;
}
