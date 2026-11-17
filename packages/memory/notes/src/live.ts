// The segment pass on live conversation (v5-brain.md, 記憶收成兩個寫入點): the turn runner's
// transcripts are read session by session, and each segment that has ended (`nextSegment`: a
// pause, enough lines, or the session quiet since its last line) goes through `runSegmentPass`
// once. Before a compaction summarises a session's oldest lines, the segments up to the cut are
// passed first (`beforeCompaction`, the `SegmentFlush` port the runner calls).
//
// - Position: per session in `event_cursors` (`segment.ts`), moved in the transaction that writes
//   the documents, so a restart neither repeats nor skips a segment. A session the pass has not
//   read yet starts after the newest line the rebuild read (`RebuildState.upto`).
// - Only once the notes are the source (`switch.ts`): before the rebuild has finished here,
//   nothing runs and `beforeCompaction` answers `off`.
// - One session at a time: the background tick and a compaction's flush of the same session wait
//   for each other, so a segment is never passed twice at once.
// - Failure: a pass that throws (the provider, the budget) puts the session on a backoff that
//   doubles up to `retryMaxMs`; a reply the pass could not use counts the same, and after
//   `abandonLimit` of those in a row the segment is skipped (logged). A compaction never waits
//   longer than `compactionWaitMs`, nor at all while its session is on a backoff: it goes ahead,
//   and the miss is logged and counted. Nothing is lost by a miss: the entries behind a summary
//   stay on disk until the sweep (`entriesAfter` reads them), and the tick passes them later.
// - Places: a session with no platform context (a helper's) is not read. A segment whose place
//   names nothing to scope by (a DM with nobody known in it) is skipped.

import type { Completer } from "@miyoria/llm/llm";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type PersonId,
  type SegmentFlush,
  type SegmentFlushOutcome,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import type { TranscriptStore } from "../../transcript/src/store.js";
import type { TranscriptEntry } from "../../transcript/src/types.js";
import type { EpisodeSink } from "./episodes.js";
import { type PassUsage, runSegmentPass, type SegmentPerson } from "./pass.js";
import type { PromiseLedger } from "./promises.js";
import { type NotePlace, placeScope, type ScopeResolver } from "./scope.js";
import {
  entriesAfter,
  markProcessed,
  nextSegment,
  processedUpTo,
  type Segment,
  type SegmentCursor,
  segmentsBeforeCompaction,
} from "./segment.js";
import type { NotesStore } from "./store.js";
import { type RebuildState, switched } from "./switch.js";
import type { NotesSearch } from "./vectors.js";

const log = getLogger("memory.segment");

/** `[modules.memory.segment]`, in milliseconds. */
export interface LiveSegmentConfig {
  enabled: boolean;
  /** A pause this long ends a segment, and a session this quiet ends its last one. */
  idleMs: number;
  /** Lines (people's and hers) in one segment at most. */
  maxLines: number;
  /** The longest a compaction waits for the pass. */
  compactionWaitMs: number;
  /** The first wait after a failed pass; it doubles up to `retryMaxMs`. */
  retryMs: number;
  retryMaxMs: number;
  /** Unusable replies in a row after which a segment is skipped. */
  abandonLimit: number;
  /** Segments passed per session per tick at most. */
  perTick: number;
  /** Model purpose of the pass. */
  purpose: string;
}

export interface LiveSegmentDeps {
  transcripts: Pick<TranscriptStore, "heads" | "covered" | "tail" | "contextOf">;
  notes: NotesStore;
  /** Related documents by meaning too; absent: by words. */
  search?: NotesSearch | null;
  /** Where episodes and follow-ups go, and open follow-ups are read and closed. */
  episodes: EpisodeSink | null;
  /** Her promises (the agent's commitment book); absent: not recorded. */
  promises?: PromiseLedger | null;
  /** `EventCursors`, or a fake. */
  cursor: SegmentCursor;
  router: Completer;
  resolver: ScopeResolver;
  /** The name she knows a person by (their handle); absent or `null`: the name they wrote under. */
  nameOf?: (person: PersonId) => string | null;
  now: () => number;
  config: () => LiveSegmentConfig;
  /** The rebuild's state (`switch.ts`): the pass runs once it is done. */
  state: () => RebuildState | null;
}

/** What the live pass did since it started. */
export interface LiveSegmentStats {
  /** Segments passed with something written or nothing to write. */
  passed: number;
  /** Segments with nothing anybody said. */
  empty: number;
  /** Replies the pass could not use. */
  abandoned: number;
  /** Segments skipped: no place to scope by, or `abandonLimit` unusable replies. */
  skipped: number;
  /** Passes that threw. */
  failed: number;
  /** Compactions that went ahead before their segments were passed. */
  missed: number;
  usage: PassUsage;
}

interface Backoff {
  failures: number;
  retryAt: number;
  /** Unusable replies in a row for the segment ending at `segment`. */
  abandons: number;
  segment: number;
}

type Ran = "passed" | "skipped" | "failed";

/** Who spoke in `entries`, with the names to write them by. */
function peopleOf(
  entries: readonly TranscriptEntry[],
  nameOf: (person: PersonId) => string | null,
): SegmentPerson[] {
  const out = new Map<PersonId, SegmentPerson>();
  for (const e of entries) {
    if (e.kind !== "other" || e.person_id === null) continue;
    const known = out.get(e.person_id);
    const author = e.author?.trim() ?? "";
    if (known === undefined) {
      const name = nameOf(e.person_id) ?? (author === "" ? e.person_id : author);
      out.set(e.person_id, {
        person: e.person_id,
        name,
        names: author === "" || author === name ? [] : [author],
      });
    } else if (author !== "" && author !== known.name && !(known.names ?? []).includes(author)) {
      known.names = [...(known.names ?? []), author];
    }
  }
  return [...out.values()];
}

/** The place of a session in `context`, as identity names it; a DM's other side from `entries`. */
export function placeOfContext(
  context: ContextKey,
  entries: readonly TranscriptEntry[],
  resolver: ScopeResolver,
): NotePlace {
  const dm = context.kind === "dm" || context.scope === null;
  if (dm) {
    const partner = entries.find((e) => e.kind === "other" && e.person_id !== null);
    return { space: null, room: resolver.roomOf(context), dm: partner?.person_id ?? null };
  }
  return {
    space: resolver.spaceOf(context.platform, context.scope as string),
    room: resolver.roomOf(context),
    dm: null,
  };
}

/** The segment pass over the live transcripts (the file comment). */
export class LiveSegments implements SegmentFlush {
  readonly #d: LiveSegmentDeps;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #backoff = new Map<string, Backoff>();
  readonly stats: LiveSegmentStats = {
    passed: 0,
    empty: 0,
    abandoned: 0,
    skipped: 0,
    failed: 0,
    missed: 0,
    usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
  };

  constructor(deps: LiveSegmentDeps) {
    this.#d = deps;
  }

  /** Whether the pass runs: enabled, and the notes are the source. */
  get running(): boolean {
    return this.#d.config().enabled && switched(this.#d.state());
  }

  /**
   * Passes every segment that has ended, session by session (at most `perTick` a session).
   * Returns how many segments were handled.
   */
  async tick(signal?: AbortSignal): Promise<number> {
    if (!this.running) return 0;
    const now = this.#d.now();
    let handled = 0;
    for (const head of this.#d.transcripts.heads()) {
      if (signal?.aborted) break;
      if (head.context === null || head.last_seq <= 0) continue;
      const wait = this.#backoff.get(head.session);
      if (wait !== undefined && wait.retryAt > now) continue;
      if (head.last_seq <= processedUpTo(this.#d.cursor, head.session)) continue;
      const done = await this.#locked(head.session, () =>
        this.#pass(head.session, head.context as ContextKey, null, signal),
      );
      handled += done.handled;
    }
    return handled;
  }

  async beforeCompaction(session: string, uptoSeq: number): Promise<SegmentFlushOutcome> {
    if (!this.running) return "off";
    const now = this.#d.now();
    const wait = this.#backoff.get(session);
    if (wait !== undefined && wait.retryAt > now) {
      this.#missed(session, uptoSeq, "the pass is waiting to be retried");
      return "failed";
    }
    if (uptoSeq <= processedUpTo(this.#d.cursor, session)) return "done";
    const context = this.#d.transcripts.contextOf(session);
    if (context === null) return "done";
    const work = this.#locked(session, () => this.#pass(session, context, uptoSeq)).then(
      (done): SegmentFlushOutcome => (done.failed ? "failed" : "done"),
      (): SegmentFlushOutcome => "failed",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<SegmentFlushOutcome>((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, this.#d.config().compactionWaitMs));
    });
    const outcome = await Promise.race([work, late]).finally(() => clearTimeout(timer));
    if (outcome !== "done") {
      this.#missed(session, uptoSeq, outcome === "late" ? "the pass took too long" : "it failed");
    }
    return outcome;
  }

  #missed(session: string, uptoSeq: number, why: string): void {
    this.stats.missed += 1;
    log.warn(
      { session, upto: uptoSeq, missed: this.stats.missed, why },
      "a compaction went ahead before the segment pass; the lines are passed later",
    );
  }

  /** Runs `fn` after whatever else holds `session`'s lock. */
  async #locked<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(session) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(session, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(session) === settled) this.#locks.delete(session);
    }
  }

  /**
   * Passes the segments of `session`: every one up to `uptoSeq` (a compaction), or the ones that
   * have ended (`null`). Returns how many were handled, and whether one failed.
   */
  async #pass(
    session: string,
    context: ContextKey,
    uptoSeq: number | null,
    signal?: AbortSignal,
  ): Promise<{ handled: number; failed: boolean }> {
    const d = this.#d;
    const config = d.config();
    const options = { idleMs: config.idleMs, maxLines: config.maxLines };
    let after = processedUpTo(d.cursor, session);
    let entries = entriesAfter(d.transcripts, session, after);
    // A session not read yet: what the rebuild read is behind it.
    const upto = d.state()?.upto ?? null;
    if (after === 0 && upto !== null) {
      const read = entries.filter((e) => timestampMs(e.at) <= timestampMs(upto));
      const last = read.at(-1);
      if (last !== undefined) {
        after = d.notes.tx(() => markProcessed(d.cursor, session, last.seq));
        entries = entries.filter((e) => e.seq > after);
      }
    }
    let handled = 0;
    if (uptoSeq !== null) {
      for (const segment of segmentsBeforeCompaction(session, entries, after, uptoSeq, options)) {
        if (signal?.aborted) return { handled, failed: true };
        const ran = await this.#run(segment, context, signal);
        handled += 1;
        if (ran === "failed") return { handled, failed: true };
      }
      // What is left up to the cut has nothing anybody said: the position moves past it.
      const last = entries.filter((e) => e.seq <= uptoSeq).at(-1);
      if (last !== undefined) d.notes.tx(() => markProcessed(d.cursor, session, last.seq));
      return { handled, failed: false };
    }
    for (let i = 0; i < Math.max(1, config.perTick); i++) {
      if (signal?.aborted) break;
      const step = nextSegment(session, entries, after, toTimestamp(d.now()), options);
      if (step.segment === null) {
        if (step.skipTo === null) break;
        const to = step.skipTo;
        after = d.notes.tx(() => markProcessed(d.cursor, session, to));
        continue;
      }
      const ran = await this.#run(step.segment, context, signal);
      handled += 1;
      if (ran === "failed") return { handled, failed: true };
      after = processedUpTo(d.cursor, session);
    }
    return { handled, failed: false };
  }

  /** Passes one segment; on a failure, sets the session's backoff. */
  async #run(segment: Segment, context: ContextKey, signal?: AbortSignal): Promise<Ran> {
    const d = this.#d;
    const config = d.config();
    const session = segment.session;
    const place = placeOfContext(context, segment.entries, d.resolver);
    if (placeScope(place) === null) {
      d.notes.tx(() => markProcessed(d.cursor, session, segment.to));
      this.stats.skipped += 1;
      log.info({ session, to: segment.to }, "a segment with no place to keep it in was skipped");
      return "skipped";
    }
    const nameOf = d.nameOf ?? (() => null);
    try {
      const result = await runSegmentPass(
        {
          session,
          entries: segment.entries,
          place,
          people: peopleOf(segment.entries, nameOf),
          context,
        },
        {
          router: d.router,
          notes: d.notes,
          ...(d.search ? { search: d.search } : {}),
          episodes: d.episodes,
          promises: d.promises ?? null,
          cursor: d.cursor,
          now: d.now,
          purpose: config.purpose,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      this.stats.usage.calls += result.usage.calls;
      this.stats.usage.prompt_tokens += result.usage.prompt_tokens;
      this.stats.usage.completion_tokens += result.usage.completion_tokens;
      if (result.status === "abandoned") {
        this.stats.abandoned += 1;
        const b = this.#fail(session, segment.to);
        b.abandons += 1;
        if (b.abandons >= Math.max(1, config.abandonLimit)) {
          d.notes.tx(() => markProcessed(d.cursor, session, segment.to));
          this.#backoff.delete(session);
          this.stats.skipped += 1;
          log.warn(
            { session, from: segment.from, to: segment.to, error: result.error },
            "the segment pass could not use the reply again; the segment was skipped",
          );
          return "skipped";
        }
        log.warn({ session, error: result.error }, "the segment pass could not use the reply");
        return "failed";
      }
      this.#backoff.delete(session);
      if (result.status === "empty") this.stats.empty += 1;
      else this.stats.passed += 1;
      if (
        result.applied.length > 0 ||
        result.episode !== null ||
        result.closed.length > 0 ||
        result.promises.length > 0
      ) {
        log.info(
          {
            session,
            from: segment.from,
            to: segment.to,
            written: result.applied.length,
            dropped: result.dropped.length,
            episode: result.episode?.stored ?? null,
            followups: result.followups.length,
            closed: result.closed.length,
            promises: result.promises.filter((p) => p.stored !== null).length,
          },
          "segment passed",
        );
      }
      return "passed";
    } catch (error) {
      if (signal?.aborted) return "failed";
      this.stats.failed += 1;
      const b = this.#fail(session, segment.to);
      log.warn(
        { session, error: errorMessage(error), retry_in_ms: b.retryAt - d.now() },
        "the segment pass failed, will retry",
      );
      return "failed";
    }
  }

  /** One more failure of `session` (at the segment ending at `segmentTo`), and its new backoff. */
  #fail(session: string, segmentTo: number): Backoff {
    const config = this.#d.config();
    const old = this.#backoff.get(session);
    const failures = (old?.failures ?? 0) + 1;
    const delay = Math.min(
      Math.max(0, config.retryMaxMs),
      Math.max(0, config.retryMs) * 2 ** Math.min(20, failures - 1),
    );
    const b: Backoff = {
      failures,
      retryAt: this.#d.now() + delay,
      abandons: old !== undefined && old.segment === segmentTo ? old.abandons : 0,
      segment: segmentTo,
    };
    this.#backoff.set(session, b);
    return b;
  }

  /** When `session` may be tried again (ms); `null`: it is not waiting. */
  retryAt(session: string): number | null {
    return this.#backoff.get(session)?.retryAt ?? null;
  }
}
