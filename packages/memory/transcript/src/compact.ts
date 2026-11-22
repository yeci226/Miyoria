// When a transcript has grown past a threshold, its oldest part is replaced by a summary. That
// costs one cache miss (the request's history starts differently once), so it is done rarely and
// in one step: everything but the newest `keepTokens` goes at once.
//
// This file picks where to cut and drives the store; the model call that writes the summary is
// the caller's (`Summarise`). The caller is also the one to write what is worth keeping into the
// longer-lived memory layers before the entries are summarised (v5-architecture §7.4).

import { timestampMs } from "@miyoria/types";
import { type SpeakerNames, speakerNamesOf } from "./convert.js";
import { splitsPair } from "./pairing.js";
import type { TranscriptStore } from "./store.js";
import type { TranscriptEntry, TranscriptSummary, TranscriptTail } from "./types.js";

export interface CompactionBudget {
  /** Compaction starts once the entries after the summary are estimated above this. */
  thresholdTokens: number;
  /** About this many of the newest tokens are kept as they are. */
  keepTokens: number;
}

/**
 * Writes the summary that stands for `entries` (oldest first, tombstones included) and for
 * `previous`, the summary before them (`null`: none, or it was stale and is being made again).
 * `names`: her handles for the speakers, so the summary names people the way her prompt does
 * (`nameSpeakers`); `null`: not known.
 */
export type Summarise = (
  entries: readonly TranscriptEntry[],
  previous: string | null,
  names?: SpeakerNames | null,
) => Promise<string>;

/**
 * Whether `entries` may be cut before index `i` (`0 < i <= entries.length`): not inside a turn
 * (an entry of that turn on each side) and not between a tool call and its result.
 */
function cuttable(entries: readonly TranscriptEntry[], i: number, lastOfTurn: Map<string, number>) {
  for (let j = 0; j < i; j++) {
    const turn = entries[j]?.turn ?? null;
    if (turn !== null && (lastOfTurn.get(turn) ?? j) >= i) return false;
  }
  return !splitsPair(entries, (entries[i - 1] as TranscriptEntry).seq);
}

/**
 * Where to cut `tail` for `budget`: the sequence the new summary should go up to, or `null` when
 * the entries are within the threshold or no cut is possible. The cut leaves about `keepTokens` of
 * the newest entries: it is the latest allowed place at or before that point, so a little more
 * than `keepTokens` may stay; when there is none (the kept part starts inside the first turn),
 * the earliest allowed place after it.
 */
export function pickCut(tail: TranscriptTail, budget: CompactionBudget): number | null {
  const entries = tail.entries;
  const total = entries.reduce((n, e) => n + e.tokens, 0);
  if (entries.length === 0 || total <= budget.thresholdTokens) return null;
  // The first index of the part kept as it is.
  let target = entries.length;
  let kept = 0;
  while (target > 0 && kept < budget.keepTokens)
    kept += (entries[--target] as TranscriptEntry).tokens;
  // Everything fits in what is to be kept: nothing to summarise.
  if (target === 0) return null;
  const lastOfTurn = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.turn !== null) lastOfTurn.set(e.turn, i);
  });
  for (let i = target; i > 0; i--) {
    if (cuttable(entries, i, lastOfTurn)) return (entries[i - 1] as TranscriptEntry).seq;
  }
  for (let i = target + 1; i <= entries.length; i++) {
    if (cuttable(entries, i, lastOfTurn)) return (entries[i - 1] as TranscriptEntry).seq;
  }
  return null;
}

export interface CompactOptions extends CompactionBudget {
  summarise: Summarise;
  /** The turn doing it, recorded on the summary. */
  turn?: string | null;
  /**
   * Called with the cut once one is picked, before anything is summarised: where the longer-lived
   * memory reads the entries up to it (the segment pass). It bounds its own wait; a rejection is
   * ignored and the compaction goes ahead.
   */
  before?: (uptoSeq: number) => Promise<unknown>;
}

export interface IdleCompactOptions extends Omit<CompactOptions, "before"> {
  /** `CompactOptions.before`, told which session it is for. */
  before?: (session: string, uptoSeq: number) => Promise<unknown>;
  /** A session nothing was appended to for this long is idle. */
  idleMs: number;
  /** The time now (epoch ms). */
  now: number;
  signal?: AbortSignal;
  /** Called for each session that fails; the others go on. */
  failed?: (session: string, error: unknown) => void;
}

/**
 * Compacts every idle session that has grown past the threshold (or whose summary is stale), the
 * ones nobody runs in: a run compacts its own session afterwards, and no other session would be
 * compacted at all. Returns the sessions compacted.
 */
export async function compactIdle(
  store: TranscriptStore,
  options: IdleCompactOptions,
): Promise<string[]> {
  const idleBefore = options.now - options.idleMs;
  const done: string[] = [];
  for (const head of store.heads()) {
    if (options.signal?.aborted) break;
    if (head.last_seq <= 0 || timestampMs(head.last_at) > idleBefore) continue;
    const stale = store.tail(head.session).summary?.stale === true;
    if (!stale && store.tokens(head.session) <= options.thresholdTokens) continue;
    try {
      const {
        before,
        idleMs: _idle,
        now: _now,
        signal: _signal,
        failed: _failed,
        ...rest
      } = options;
      const made = await compactIfNeeded(store, head.session, {
        ...rest,
        ...(before ? { before: (upto: number) => before(head.session, upto) } : {}),
      });
      if (made !== null) done.push(head.session);
    } catch (error) {
      options.failed?.(head.session, error);
    }
  }
  return done;
}

/**
 * Compacts `session` when it needs it, and returns the summary made (`null`: nothing to do).
 *
 * - The summary in use is stale (an entry it covers was redacted): it is made again from the
 *   covered entries still on disk, at the same sequence.
 * - Else, the entries after it are over the threshold: the oldest part, up to `pickCut`, is
 *   summarised together with the summary in use.
 *
 * `summarise` is awaited outside any transaction. Entries appended meanwhile are after the cut and
 * stay; if another compaction of the session finished meanwhile, this one is dropped.
 */
export async function compactIfNeeded(
  store: TranscriptStore,
  session: string,
  options: CompactOptions,
): Promise<TranscriptSummary | null> {
  const tail = store.tail(session);
  const meta = { turn: options.turn ?? null };
  const names = speakerNamesOf(store);
  // Only when known: a summariser of two arguments is called as before.
  const summarise = (entries: readonly TranscriptEntry[], previous: string | null) =>
    names === null
      ? options.summarise(entries, previous)
      : options.summarise(entries, previous, names);
  const unchanged = () => (store.summaries(session)[0]?.id ?? null) === (tail.summary?.id ?? null);

  if (tail.summary?.stale === true) {
    const covered = store.covered(session);
    const tokens = covered.reduce((n, e) => n + e.tokens, 0);
    const text = await summarise(covered, null);
    if (!unchanged()) return null;
    return store.compact(session, tail.summary.upto_seq, text, { ...meta, tokensReplaced: tokens });
  }

  const upto = pickCut(tail, options);
  if (upto === null) return null;
  if (options.before) await options.before(upto).catch(() => undefined);
  const old = tail.entries.filter((e) => e.seq <= upto);
  const text = await summarise(old, tail.summary?.summary ?? null);
  if (!unchanged()) return null;
  return store.compact(session, upto, text, meta);
}
