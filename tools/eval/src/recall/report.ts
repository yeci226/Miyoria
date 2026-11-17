// Text reports of a recall run and of a sweep, and the entry the suite registry calls.

import type { Embedder } from "@miyoria/memory/memory";
import { type RecallResult, type RecallTarget, runRecall, type SweepRow } from "./run.js";
import { loadRecallSet } from "./set.js";

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - [...s].length));
const num = (x: number | null): string => (x === null ? "-" : x.toFixed(3));

/** A short table: the totals, then one line per query (ids only). */
export function formatRecallReport(result: RecallResult): string {
  const lines: string[] = [];
  lines.push(
    `recall: ${result.set === "" ? "(unnamed set)" : result.set}, ${result.memories} memories, ` +
      `${result.queries} queries, embedder ${result.embedder ?? "none"}, target ${result.target}`,
  );
  lines.push(
    `config: min_score ${result.config.min_score}  min_vector ${result.config.min_vector}  ` +
      `limit ${result.limit}`,
  );
  lines.push("");
  lines.push(
    `${result.ks.map((k) => `recall@${k} ${num(result.recall_at?.[String(k)] ?? null)}`).join("  ")}` +
      `  MRR ${num(result.mrr)}  (${result.with_relevant} queries)`,
  );
  lines.push(
    `nothing to recall: returned nothing ${num(result.nothing_returned_rate)}, ` +
      `mean returned ${num(result.nothing_mean_returned)}  (${result.nothing} queries)`,
  );
  const block = result.block;
  if (block !== undefined) {
    lines.push(
      `prompt block: recall@5 ${num(block.recall_at?.["5"] ?? null)}  MRR ${num(block.mrr)}  ` +
        `nothing to recall: returned nothing ${num(block.nothing_returned_rate)}, ` +
        `mean returned ${num(block.nothing_mean_returned)}`,
    );
  }
  lines.push(`scope leaks: ${result.leaks}${result.leaks === 0 ? "" : "  (must be 0)"}`);
  if (result.embedding_failures > 0) {
    lines.push(`embedding failures: ${result.embedding_failures}`);
  }
  lines.push("");
  const width = Math.max(...result.per_query.map((q) => q.id.length), 5);
  lines.push(`${pad("query", width)}  found  rr     returned`);
  for (const q of result.per_query) {
    const relevant = new Set(q.relevant);
    const found =
      q.relevant.length === 0
        ? "-"
        : `${q.returned.filter((r) => relevant.has(r.id)).length}/${q.relevant.length}`;
    const leaked = q.leaks.length === 0 ? "" : `  LEAK ${q.leaks.join(",")}`;
    lines.push(
      `${pad(q.id, width)}  ${pad(found, 5)}  ${pad(num(q.reciprocal_rank), 5)}  ` +
        `${q.returned.map((r) => (relevant.has(r.id) ? `*${r.id}` : r.id)).join(" ")}${leaked}`.trimEnd(),
    );
  }
  return lines.join("\n");
}

/** One line per variant of a sweep. */
export function formatSweep(rows: readonly SweepRow[]): string {
  const ks = Object.keys(rows.find((r) => r.recall_at !== null)?.recall_at ?? {});
  const width = Math.max(...rows.map((r) => r.name.length), 7);
  const head = [
    pad("variant", width),
    ...ks.map((k) => pad(`r@${k}`, 5)),
    "MRR  ",
    "none ",
    "leaks",
  ];
  const lines = [head.join("  ")];
  for (const row of rows) {
    lines.push(
      [
        pad(row.name, width),
        ...ks.map((k) => num(row.recall_at?.[k] ?? null)),
        num(row.mrr),
        pad(num(row.nothing_returned_rate), 5),
        String(row.leaks),
      ].join("  "),
    );
  }
  return lines.join("\n");
}

export interface MemorySuiteOptions {
  setPath: string;
  embedder?: Embedder;
  /** Default `records`. */
  target?: RecallTarget;
}

/**
 * The suite `memory`: one run of the set at `setPath` with the default config, against the
 * memory records or her notes. The headline leaves out a number the set has no queries for.
 */
export async function memorySuite(
  options: MemorySuiteOptions,
): Promise<{ headline: Record<string, number>; detail: unknown }> {
  const set = loadRecallSet(options.setPath);
  const result = await runRecall(set, {
    ...(options.embedder ? { embedder: options.embedder } : {}),
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  const headline: Record<string, number> = {};
  const recall5 = result.recall_at?.["5"];
  if (recall5 !== undefined) headline["recall@5"] = recall5;
  if (result.mrr !== null) headline.mrr = result.mrr;
  if (result.nothing_returned_rate !== null) {
    headline.nothing_returned_rate = result.nothing_returned_rate;
  }
  if (result.nothing_mean_returned !== null) {
    headline.nothing_mean_returned = result.nothing_mean_returned;
  }
  const block = result.block;
  if (block !== undefined) {
    const blockRecall5 = block.recall_at?.["5"];
    if (blockRecall5 !== undefined) headline["block_recall@5"] = blockRecall5;
    if (block.nothing_mean_returned !== null) {
      headline.block_nothing_mean_returned = block.nothing_mean_returned;
    }
  }
  headline.leaks = result.leaks;
  return { headline, detail: result };
}
