// Where the segment pass reads from: a session's transcript cut into segments, and how far each
// session has been read.
//
// A segment is a stretch of one session's transcript, `from` to `to` (sequences, both included),
// that ends at a pause (`idleMs` between two entries), at `maxLines` lines (people's and hers;
// tool calls and results ride along), or because the session has been quiet for `idleMs` since its
// last entry. A segment is never cut between a tool call and its result, nor inside a turn.
//
// How far a session has been read is a position in `event_cursors` (consumer `notes.segment`, key
// the session), not in the transcript's state blob: the blob is the turn runner's one opaque value
// and a second writer would have to merge into it, while a cursor only moves forward (two runs
// cannot move it back) and commits in the same transaction as the documents the pass writes. Its
// `seq` here is a transcript sequence, not an event's: the key is the session, so the two never
// meet.

import type { Timestamp } from "@miyoria/types";
import { timestampMs } from "@miyoria/types";
import { splitsPair } from "../../transcript/src/pairing.js";
import type { TranscriptStore } from "../../transcript/src/store.js";
import type { TranscriptEntry } from "../../transcript/src/types.js";

/** The consumer id of the segment pass's positions in `event_cursors`. */
export const SEGMENT_CONSUMER = "notes.segment";

export interface SegmentOptions {
  /** A pause this long ends a segment, and a session this quiet ends its last one. Default 5 minutes. */
  idleMs?: number;
  /** Lines (people's and hers) in one segment at most. Default 40. */
  maxLines?: number;
}

export const DEFAULT_SEGMENT_IDLE_MS = 300_000;
export const DEFAULT_SEGMENT_LINES = 40;

/** A stretch of one session's transcript. */
export interface Segment {
  session: string;
  /** Its first and last sequence. */
  from: number;
  to: number;
  entries: TranscriptEntry[];
  /** Why it ends where it does. */
  ended: "pause" | "lines" | "quiet" | "compaction";
}

const isLine = (e: TranscriptEntry) => e.kind === "other" || e.kind === "self";

/** Whether `entries` may be cut after index `i` (the cut keeps `entries[0..i]`). */
function cuttableAfter(entries: readonly TranscriptEntry[], i: number): boolean {
  const last = entries[i];
  const next = entries[i + 1];
  if (last === undefined) return false;
  if (next === undefined) return true;
  if (last.turn !== null && next.turn === last.turn) return false;
  return !splitsPair(entries, last.seq);
}

/** The first allowed cut at or after index `i`; the last index when there is none. */
function cutAtOrAfter(entries: readonly TranscriptEntry[], i: number): number {
  for (let j = i; j < entries.length; j++) if (cuttableAfter(entries, j)) return j;
  return entries.length - 1;
}

function make(
  session: string,
  entries: readonly TranscriptEntry[],
  ended: Segment["ended"],
): Segment | null {
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined || !entries.some(isLine)) return null;
  return { session, from: first.seq, to: last.seq, entries: [...entries], ended };
}

/**
 * The next segment of `entries` (one session's, in order) after sequence `after`, or `null` when
 * there is none yet: what is left is still going on (no pause, not `maxLines` lines, and its last
 * entry is younger than `idleMs` at `now`). A stretch with nothing anybody said (only tool
 * entries, notes) is skipped: `skipTo` is then where the position may move.
 */
export function nextSegment(
  session: string,
  entries: readonly TranscriptEntry[],
  after: number,
  now: Timestamp,
  options: SegmentOptions = {},
): SegmentStep {
  return cutNext(session, entries, after, now, options);
}

/** A segment, or how far a stretch without lines may be skipped (`skipTo`), or neither. */
export interface SegmentStep {
  segment: Segment | null;
  skipTo: number | null;
}

/** `nextSegment`; with `now === null` the session counts as quiet (the end is forced). */
function cutNext(
  session: string,
  entries: readonly TranscriptEntry[],
  after: number,
  now: Timestamp | null,
  options: SegmentOptions,
): SegmentStep {
  const idle = options.idleMs ?? DEFAULT_SEGMENT_IDLE_MS;
  const most = Math.max(1, options.maxLines ?? DEFAULT_SEGMENT_LINES);
  const rest = entries.filter((e) => e.seq > after && e.redacted_at === null);
  if (rest.length === 0) return { segment: null, skipTo: null };
  let lines = 0;
  for (let i = 0; i < rest.length; i++) {
    const e = rest[i] as TranscriptEntry;
    if (isLine(e)) lines++;
    const next = rest[i + 1];
    let ended: Segment["ended"] | null = null;
    if (next !== undefined && timestampMs(next.at) - timestampMs(e.at) >= idle) ended = "pause";
    else if (lines >= most) ended = "lines";
    if (ended === null) continue;
    const cut = cutAtOrAfter(rest, i);
    const part = rest.slice(0, cut + 1);
    const segment = make(session, part, ended);
    return { segment, skipTo: segment === null ? (part.at(-1)?.seq ?? null) : null };
  }
  const last = rest.at(-1) as TranscriptEntry;
  if (now !== null && timestampMs(now) - timestampMs(last.at) < idle) {
    return { segment: null, skipTo: null };
  }
  const segment = make(session, rest, now === null ? "compaction" : "quiet");
  return { segment, skipTo: segment === null ? last.seq : null };
}

/**
 * Every segment of `entries` after `after` up to and including `uptoSeq`, whether or not the
 * conversation has paused: what the runner hands the pass before it compacts the transcript up
 * to `uptoSeq`, so nothing is summarised away before it was read. Cuts at pauses and `maxLines`
 * as `nextSegment`; the last one ends at `uptoSeq` (`compaction`).
 */
export function segmentsBeforeCompaction(
  session: string,
  entries: readonly TranscriptEntry[],
  after: number,
  uptoSeq: number,
  options: SegmentOptions = {},
): Segment[] {
  const upto = entries.filter((e) => e.seq <= uptoSeq);
  const out: Segment[] = [];
  let from = after;
  for (;;) {
    const { segment, skipTo } = cutNext(session, upto, from, null, options);
    if (segment !== null) {
      out.push(segment);
      from = segment.to;
    } else if (skipTo !== null) {
      from = skipTo;
    } else {
      return out;
    }
  }
}

/**
 * The entries of `session` after sequence `after` that are still on disk: the ones a summary
 * already stands for (a compaction that ran before the pass) and the tail, in order.
 */
export function entriesAfter(
  transcripts: Pick<TranscriptStore, "covered" | "tail">,
  session: string,
  after: number,
): TranscriptEntry[] {
  const covered = transcripts.covered(session);
  const tail = transcripts.tail(session).entries;
  const seen = new Set<number>();
  const out: TranscriptEntry[] = [];
  for (const e of [...covered, ...tail]) {
    if (e.seq <= after || seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Where a session has been read to: `event_cursors` (`EventCursors`), or a fake in tests. */
export interface SegmentCursor {
  get(consumer: string, key?: string): number;
  advance(consumer: string, key: string, seq: number): number;
}

/** The last sequence of `session` the segment pass has handled; 0: none. */
export function processedUpTo(cursor: SegmentCursor, session: string): number {
  return cursor.get(SEGMENT_CONSUMER, session);
}

/** Records that `session` has been handled up to `seq` (never moves back). */
export function markProcessed(cursor: SegmentCursor, session: string, seq: number): number {
  return cursor.advance(SEGMENT_CONSUMER, session, seq);
}
