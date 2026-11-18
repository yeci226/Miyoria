// One live run: the chosen suites against one subject, under one meter. The result is one JSON
// file per run and one summary line appended to `history.jsonl` beside it, so runs of different
// subjects and commits can be put next to each other.

import type { Completer } from "@miyoria/llm/llm";
import type { Judge } from "./judge.js";
import type { Meter } from "./meter.js";
import type { ModelUsage, Subject } from "./subject.js";
import { type PersonaParts, SuiteRegistry, type SuiteResult } from "./suite.js";
import { runCorrections } from "./suites/corrections.js";
import { runFeel } from "./suites/feel.js";
import { runPersona } from "./suites/persona.js";
import { runPlay } from "./suites/play.js";
import { runRelationship } from "./suites/relationship.js";
import { runTools } from "./suites/tools.js";

export {
  HISTORY_FILE,
  type HistoryLine,
  HistoryLineSchema,
  historyLine,
  rebuildHistory,
  writeRun,
} from "./history.js";

/** The live suites. `memory` is a slot: its runner comes from the recall harness. */
export function defaultSuites(): SuiteRegistry {
  return new SuiteRegistry()
    .register("persona", runPersona)
    .register("tools", (ctx) => runTools(ctx))
    .register("relationship", (ctx) => runRelationship(ctx))
    .register("memory", null)
    .register("corrections", (ctx) => runCorrections(ctx))
    .register("feel", (ctx) => runFeel(ctx))
    .register("play", (ctx) => runPlay(ctx));
}

/**
 * Suites that run only when named: `corrections` is for comparing brains, not the nightly, and
 * `play` is a few hundred model calls at 8 repeats.
 */
const OPT_IN: ReadonlySet<string> = new Set(["corrections", "play"]);

/** The suites a run takes when none is named: the ones that have a runner, but not the opt-in ones. */
export function runnableSuites(registry: SuiteRegistry): string[] {
  return registry.names().filter((n) => registry.get(n) !== null && !OPT_IN.has(n));
}

export interface LiveRunOptions {
  subject: Subject;
  judge: Judge;
  meter: Meter;
  /** The router the suites that call the model themselves use (`play`). */
  router?: Completer;
  registry: SuiteRegistry;
  /** Suite names, in the order to run. */
  suites: readonly string[];
  persona: string;
  /** Her persona as her chat reads it (`SuiteContext.handle`). */
  handle?: PersonaParts;
  repeat?: number;
  seed?: string;
  /** The git commit the run is of (`null`: unknown). */
  commit?: string | null;
  /** The `chat` chain the run is routed through, first choice first (`provider:model`). */
  chain?: readonly string[];
  now?: () => number;
  log?: (line: string) => void;
}

export interface LiveRun {
  at: string;
  commit: string | null;
  subject: string;
  seed: string;
  repeat: number;
  suites: SuiteResult[];
  /** Every model call of the run: the subject's and the judge's. */
  usage: ModelUsage;
  models: Record<string, ModelUsage>;
  /** The `chat` chain the run was routed through; a run file from before it was recorded has none. */
  chain?: string[];
  /** Estimated cost in USD of the calls whose model has a price. */
  usd: number;
  /** Models with no `[llm.pricing]` entry: their cost is unknown and not in `usd`. */
  unpriced: string[];
  duration_ms: number;
  /** The limit was reached: the suites after it did not run, the one in it is partial. */
  stopped?: "budget";
}

export async function runLive(options: LiveRunOptions): Promise<LiveRun> {
  const now = options.now ?? (() => Date.now());
  const start = now();
  const seed = options.seed ?? new Date(start).toISOString();
  const repeat = options.repeat ?? 1;
  const log = options.log ?? (() => undefined);
  const suites: SuiteResult[] = [];
  let stopped = false;
  for (const name of options.suites) {
    const empty = { suite: name, headline: {}, items: [], unsupported: [] };
    if (!options.registry.has(name)) {
      suites.push({ ...empty, skipped: "no suite of this name" });
      continue;
    }
    const runner = options.registry.get(name);
    if (runner === null) {
      suites.push({ ...empty, skipped: "no runner registered for this suite" });
      continue;
    }
    if (stopped || options.meter.spent()) {
      stopped = true;
      suites.push({ ...empty, stopped: "budget" });
      continue;
    }
    const result = await runner({
      subject: options.subject,
      judge: options.judge,
      meter: options.meter,
      ...(options.router === undefined ? {} : { router: options.router }),
      persona: options.persona,
      ...(options.handle === undefined ? {} : { handle: options.handle }),
      repeat,
      seed,
      log,
    });
    suites.push(result);
    if (result.stopped === "budget") stopped = true;
  }
  return {
    at: new Date(start).toISOString(),
    commit: options.commit ?? null,
    subject: options.subject.name,
    seed,
    repeat,
    suites,
    usage: options.meter.usage(),
    models: options.meter.models(),
    ...(options.chain === undefined ? {} : { chain: [...options.chain] }),
    usd: options.meter.usd(),
    unpriced: options.meter.unpriced(),
    duration_ms: Math.max(0, now() - start),
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}

const pct = (n: number | null): string => (n === null ? "  n/a" : n.toFixed(3));

/** A short table of the run. */
export function formatRun(run: LiveRun): string {
  const lines = [
    `live eval: subject ${run.subject}, commit ${run.commit ?? "unknown"}, repeat ${run.repeat}`,
  ];
  for (const s of run.suites) {
    if (s.skipped !== undefined) {
      lines.push(`  ${s.suite.padEnd(13)} skipped: ${s.skipped}`);
      continue;
    }
    const numbers = Object.entries(s.headline)
      .map(([k, v]) => `${k} ${pct(v)}`)
      .join("  ");
    const notes = [
      `${s.items.length} items`,
      ...(s.unsupported.length > 0
        ? [`unsupported: ${s.unsupported.map((u) => u.id).join(", ")}`]
        : []),
      ...(s.stopped ? ["stopped: budget"] : []),
    ];
    lines.push(`  ${s.suite.padEnd(13)} ${numbers || "-"}  (${notes.join("; ")})`);
    for (const row of s.report ?? []) lines.push(`    ${row}`);
  }
  const u = run.usage;
  lines.push(
    `tokens: prompt ${u.prompt_tokens} (cached ${u.cached_prompt_tokens}), completion ${u.completion_tokens} (reasoning ${u.reasoning_tokens}), ${u.calls} model calls`,
  );
  lines.push(
    run.unpriced.length > 0
      ? `cost: unknown (no [llm.pricing] for ${run.unpriced.join(", ")}); priced calls come to $${run.usd.toFixed(4)}`
      : `cost: about $${run.usd.toFixed(4)}`,
  );
  lines.push(`time: ${(run.duration_ms / 1000).toFixed(1)} s`);
  if (run.stopped) lines.push("stopped: budget (the results above are partial)");
  return lines.join("\n");
}
