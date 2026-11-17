// Turns `GET /api/telemetry` samples (cumulative counters, one a minute) into what the charts
// plot: per-bucket deltas, first-token percentiles from histogram deltas, and her state over time.

import type { Thought } from "@/api/types";
import type { TelemetryPoint } from "@miyoria/contracts/api";
import type { Column } from "@/components/charts/charts";

export type Range = "1h" | "6h" | "24h";

export const RANGES: { range: Range; label: string; minutes: number; bucketMs: number }[] = [
  { range: "1h", label: "1 小時", minutes: 60, bucketMs: 5 * 60_000 },
  { range: "6h", label: "6 小時", minutes: 360, bucketMs: 15 * 60_000 },
  { range: "24h", label: "24 小時", minutes: 1440, bucketMs: 60 * 60_000 },
];

export const rangeOf = (r: Range) => RANGES.find((x) => x.range === r) ?? (RANGES[1] as (typeof RANGES)[number]);

/** Counter growth from `a` to `b`; a restart (smaller value) counts from zero. */
const grow = (a: number, b: number) => (b >= a ? b - a : b);

/** `p`-quantile (seconds) from cumulative bucket counts, interpolated inside the bucket. */
export function quantile(buckets: { le_s: number; count: number }[], total: number, p: number): number | null {
  if (total <= 0) return null;
  const rank = p * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= rank) {
      const inBucket = b.count - prevCount;
      const frac = inBucket > 0 ? (rank - prevCount) / inBucket : 1;
      return prevLe + (b.le_s - prevLe) * frac;
    }
    prevLe = b.le_s;
    prevCount = b.count;
  }
  // Past the last finite bound.
  return buckets.length > 0 ? (buckets[buckets.length - 1]?.le_s ?? null) : null;
}

export interface Bucket {
  t: number;
  calls: number;
  /** Prompt tokens not served from the cache. */
  prompt: number;
  cached: number;
  completion: number;
  cost: number;
  errors: number;
  /** First-token latency of the calls in this bucket (seconds). */
  p50: number | null;
  p95: number | null;
  events: Record<string, number>;
}

/** Splits the samples into buckets of `bucketMs` ending now, with counter deltas. */
export function bucketize(points: TelemetryPoint[], bucketMs: number, minutes: number, now = Date.now()): Bucket[] {
  const start = Math.floor((now - minutes * 60_000) / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const out: Bucket[] = [];
  for (let t = start; t <= end; t += bucketMs) {
    out.push({ t, calls: 0, prompt: 0, cached: 0, completion: 0, cost: 0, errors: 0, p50: null, p95: null, events: {} });
  }
  const hist = out.map(() => new Map<number, number>());
  const histTotal = out.map(() => 0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as TelemetryPoint;
    const at = Date.parse(p.at);
    const k = Math.floor((at - start) / bucketMs);
    if (k < 0 || k >= out.length) continue;
    const b = out[k] as Bucket;
    for (const [key, n] of Object.entries(p.events)) b.events[key] = (b.events[key] ?? 0) + n;
    const prev = points[i - 1];
    if (!prev) continue;
    const a = prev.llm;
    const c = p.llm;
    const prompt = grow(a.prompt_tokens, c.prompt_tokens);
    const cached = grow(a.cached_prompt_tokens, c.cached_prompt_tokens);
    b.calls += grow(a.calls, c.calls);
    b.cached += Math.min(cached, prompt);
    b.prompt += Math.max(0, prompt - cached);
    b.completion += grow(a.completion_tokens, c.completion_tokens);
    b.cost += grow(a.cost_usd, c.cost_usd);
    b.errors += grow(a.errors, c.errors);
    const restarted = c.first_token.count < a.first_token.count;
    histTotal[k] = (histTotal[k] ?? 0) + (restarted ? c.first_token.count : c.first_token.count - a.first_token.count);
    const h = hist[k] as Map<number, number>;
    for (const cb of c.first_token.buckets) {
      const before = restarted ? 0 : (a.first_token.buckets.find((x) => x.le_s === cb.le_s)?.count ?? 0);
      h.set(cb.le_s, (h.get(cb.le_s) ?? 0) + Math.max(0, cb.count - before));
    }
  }
  out.forEach((b, k) => {
    const h = [...(hist[k] as Map<number, number>).entries()].sort((x, y) => x[0] - y[0]).map(([le_s, count]) => ({ le_s, count }));
    const total = histTotal[k] ?? 0;
    b.p50 = quantile(h, total, 0.5);
    b.p95 = quantile(h, total, 0.95);
  });
  return out;
}

/** Columns of the given bucket fields. */
export function columnsOf(buckets: Bucket[], pick: (b: Bucket) => Record<string, number>): Column[] {
  return buckets.map((b) => ({ t: b.t, values: pick(b) }));
}

/** What a thought led to. */
export type ThoughtOutcome = "acted" | "held" | "none";

export function thoughtOutcome(t: Thought): ThoughtOutcome {
  if (t.intents.length === 0) return "none";
  return t.intents.some((i) => i.status === "done" || i.status === "started") ? "acted" : "held";
}

/** Thoughts per bucket by outcome, for the last `minutes`. */
export function thoughtColumns(thoughts: Thought[], bucketMs: number, minutes: number, now = Date.now()): Column[] {
  const start = Math.floor((now - minutes * 60_000) / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const cols: Column[] = [];
  for (let t = start; t <= end; t += bucketMs) cols.push({ t, values: { acted: 0, held: 0, none: 0 } });
  for (const th of thoughts) {
    const k = Math.floor((Date.parse(th.at) - start) / bucketMs);
    const col = cols[k];
    if (!col) continue;
    const o = thoughtOutcome(th);
    col.values[o] = (col.values[o] ?? 0) + 1;
  }
  return cols;
}

/** Counts by key, largest first. */
export function tally<T>(items: T[], key: (t: T) => string): { key: string; value: number }[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].map(([k, value]) => ({ key: k, value })).sort((a, b) => b.value - a.value);
}
