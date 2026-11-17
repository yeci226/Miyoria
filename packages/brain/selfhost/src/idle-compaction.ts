// Compacts the transcripts of places nobody runs her in. A run compacts its own session after it
// (`SelfRunner`), so a place she only hears would grow without end; this looks at every session
// that has been quiet for a while and compacts the ones past the threshold, with the segment pass
// reading the lines first, as for a run's compaction.

import {
  type CompactionBudget,
  compactIdle,
  type TranscriptStore,
} from "@miyoria/memory/transcript";
import { errorMessage, interval } from "@miyoria/runtime/kernel";
import { SegmentFlushKey } from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import { modelSummarise, type RunModel } from "../../self/src/index.js";

/** A session quiet for this long is compacted if it is over the threshold. */
export const IDLE_COMPACT_AFTER_MS = 30 * 60_000;
/** How often the sessions are looked at. */
export const IDLE_COMPACT_EVERY_MS = 10 * 60_000;

export interface IdleCompactionOptions {
  transcript: TranscriptStore;
  model: RunModel;
  /** The same budget a run compacts to; `null`: never. */
  budget: CompactionBudget | null;
  signal: AbortSignal;
  idleMs?: number;
  everyMs?: number;
}

/** One look at the sessions; returns the ones compacted. */
export async function compactIdleSessions(
  agent: Agent,
  options: IdleCompactionOptions,
): Promise<string[]> {
  if (options.budget === null) return [];
  const flush = agent.ctx.services.get(SegmentFlushKey);
  return compactIdle(options.transcript, {
    ...options.budget,
    summarise: modelSummarise(options.model, options.signal),
    idleMs: options.idleMs ?? IDLE_COMPACT_AFTER_MS,
    now: agent.ctx.clock.now(),
    signal: options.signal,
    ...(flush ? { before: (session, upto) => flush.beforeCompaction(session, upto) } : {}),
    failed: (session, error) =>
      agent.log.warn(
        { session, err: errorMessage(error) },
        "an idle session could not be compacted",
      ),
  });
}

/** Looks every `everyMs` until `signal` aborts. */
export function startIdleCompaction(agent: Agent, options: IdleCompactionOptions): void {
  if (options.budget === null) return;
  agent.ctx.spawn("selfhost.idle-compaction", async (stop) => {
    const both = AbortSignal.any([stop, options.signal]);
    for await (const _ of interval(options.everyMs ?? IDLE_COMPACT_EVERY_MS, both)) {
      try {
        const done = await compactIdleSessions(agent, { ...options, signal: both });
        if (done.length > 0) agent.log.info({ sessions: done.length }, "idle sessions compacted");
      } catch (error) {
        if (both.aborted) return;
        agent.log.warn({ err: errorMessage(error) }, "idle compaction failed");
      }
    }
  });
}
