// One line of `history.jsonl`: the summary of a live run, as a stable, versioned record. The
// shape is `EvalLiveRunSchema` of `@miyoria/contracts/events` (packages/contracts/events/src/
// eval.ts), which the API reads the file with. This package does not depend on the contracts
// package, so the schema is written again here and test/live-history.test.ts fails when the two
// differ.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LiveRun } from "./run.js";

export const HISTORY_FILE = "history.jsonl";
export const HISTORY_VERSION = 1;

const TokensSchema = z.object({
  calls: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_prompt_tokens: z.number(),
  reasoning_tokens: z.number(),
});

const SuiteSchema = z.object({
  headline: z.record(z.string(), z.number().nullable()),
  items: z.number(),
  unsupported: z.number(),
  stopped: z.boolean(),
});

export const HistoryLineSchema = z.object({
  v: z.literal(HISTORY_VERSION),
  at: z.string(),
  commit: z.string().nullable(),
  subject: z.string(),
  repeat: z.number(),
  suites: z.record(z.string(), SuiteSchema),
  tokens: TokensSchema,
  usd: z.number().nullable(),
  duration_ms: z.number(),
  models: z.array(z.string()),
  stopped: z.enum(["budget"]).nullable(),
});

/** The summary line of a run in `history.jsonl`. */
export type HistoryLine = z.output<typeof HistoryLineSchema>;

export function historyLine(run: LiveRun): HistoryLine {
  return HistoryLineSchema.parse({
    v: HISTORY_VERSION,
    at: run.at,
    commit: run.commit,
    subject: run.subject,
    repeat: run.repeat,
    // A suite that was skipped (no runner, no such suite) is not part of the run.
    suites: Object.fromEntries(
      run.suites
        .filter((s) => s.skipped === undefined)
        .map((s) => [
          s.suite,
          {
            headline: s.headline,
            items: s.items.length,
            unsupported: s.unsupported.length,
            stopped: s.stopped === "budget",
          },
        ]),
    ),
    tokens: run.usage,
    // A model that answered has no price: the cost is unknown.
    usd: run.unpriced.length > 0 ? null : run.usd,
    duration_ms: run.duration_ms,
    // A run file written before the chain was recorded has the models that answered.
    models: run.chain ?? Object.keys(run.models).sort(),
    stopped: run.stopped ?? null,
  } satisfies HistoryLine);
}

/** The name of a run's own file. */
function runFile(run: LiveRun): string {
  const stamp = run.at.replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "");
  return `${stamp}-${run.subject}.json`;
}

/** Writes the run's JSON file into `dir` (created on demand) and appends its history line. */
export function writeRun(run: LiveRun, dir: string): { file: string; history: string } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, runFile(run));
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  const history = join(dir, HISTORY_FILE);
  appendFileSync(history, `${JSON.stringify(historyLine(run))}\n`);
  return { file, history };
}

/**
 * Writes `history.jsonl` in `dir` again from the run files beside it, oldest first: for a folder
 * whose lines were written before the record had a version. A file that is not a run is left out
 * and named in `skipped`.
 */
export function rebuildHistory(dir: string): { runs: number; skipped: string[] } {
  const lines: HistoryLine[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const run = JSON.parse(readFileSync(join(dir, name), "utf8")) as LiveRun;
      lines.push(historyLine(run));
    } catch {
      skipped.push(name);
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  writeFileSync(join(dir, HISTORY_FILE), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { runs: lines.length, skipped };
}
