// The north-star measures of docs/design/v3-architecture.md §18.1, computed from the EventLog and
// the delivery ledger and nothing else. A measure with no source yet is listed in `UNMEASURED`
// with what is missing; none of them is ever filled in by a guess.

import type { Delivery, LogEvent } from "@/api/types";
import { asE2eEvent } from "./e2e";
import type { EvalData, Loaded } from "./eval-data";

export type MetricId = "addressed" | "reply" | "latency" | "repeat" | "monologue" | "broken";

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: "rate" | "ms" | "count";
  /** The V3 target (§18.1). */
  target: number;
  /** Which side of the target is good. */
  good: "above" | "below";
  /** Whether meeting the target needs to be past it (`>`, `<`) rather than on it (`≥`, `≤`). */
  strict: boolean;
  /** The target as written in the table. */
  targetLabel: string;
  /** What it is computed from. */
  source: string;
}

export const METRICS: MetricDef[] = [
  {
    id: "addressed",
    label: "直接叫她的開口率(語音)",
    unit: "rate",
    target: 0.95,
    good: "above",
    strict: true,
    targetLabel: "> 95%",
    source: "對話焦點、她開的句子、送達帳本",
  },
  {
    id: "reply",
    label: "別人回她時的接話率(語音)",
    unit: "rate",
    target: 0.6,
    good: "above",
    strict: true,
    targetLabel: "> 60%",
    source: "對話焦點、她開的句子、送達帳本",
  },
  {
    id: "latency",
    label: "語音說完到出聲",
    unit: "ms",
    target: 2500,
    good: "below",
    strict: false,
    targetLabel: "p50 ≤ 2.5 s",
    source: "voice.latency 的 e2e",
  },
  {
    id: "repeat",
    label: "重複率",
    unit: "rate",
    target: 0.03,
    good: "below",
    strict: true,
    targetLabel: "< 3%",
    source: "送達帳本",
  },
  {
    id: "monologue",
    label: "自言自語(沒人回應的連續句,最長)",
    unit: "count",
    target: 3,
    good: "below",
    strict: false,
    targetLabel: "≤ 3",
    source: "送達帳本",
  },
  {
    id: "broken",
    label: "「說了沒做」(承諾逾期作廢)",
    unit: "count",
    target: 0,
    good: "below",
    strict: false,
    targetLabel: "0",
    source: "承諾紀錄",
  },
];

export const metricOf = (id: MetricId): MetricDef => METRICS.find((m) => m.id === id) as MetricDef;

/** §18.1 rows with no data source yet, and what each one needs. */
export const UNMEASURED: { label: string; targetLabel: string; missing: string }[] = [
  {
    label: "她 : 人類(語音,非表演時)",
    targetLabel: "≤ 1.5 : 1",
    missing: "表演時段(唱歌、直播玩遊戲)的開始與結束沒有寫進事件日誌,算不出「非表演時」",
  },
  {
    label: "主人規則遵守(pass^3)",
    targetLabel: "100%",
    missing: "服從測試(假遊戲、模擬使用者、連跑三次)的執行紀錄",
  },
  {
    label: "做歌時聾啞時間",
    targetLabel: "0(無遊戲時)",
    missing: "做歌期間語音辨識中斷的起訖時間",
  },
];

/** A measure over one window. `value` is `null` when nothing in the window could be measured. */
export interface Reading {
  value: number | null;
  /** What it was measured over: turns, replies, lines or promises. */
  n: number;
  /** For a rate, the ones that count (`value = hit / n`). */
  hit: number | null;
  /** The window actually read, ms: a source that did not reach back cuts the start. */
  from: number;
  to: number;
}

const none = (from: number, to: number): Reading => ({ value: null, n: 0, hit: null, from, to });

const body = (e: LogEvent): Record<string, unknown> =>
  e.body !== null && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Record<string, unknown>) : {};

const at = (e: LogEvent): number => Date.parse(e.at);

/** The start of `[a, …)` moved up to where every one of `sources` can be trusted. */
const covered = (a: number, sources: Loaded<unknown>[]): number => Math.max(a, ...sources.map((s) => s.from));

/** The middle value of `xs`; `null` for none. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Voice turns of one reason, each with the time of its first focus line: `addressed` is someone
 * calling her, `reply_to_her` someone answering what she said.
 */
function voiceTurns(data: EvalData, reason: string, a: number, b: number): { turn: string; at: number }[] {
  const first = new Map<string, { reason: unknown; at: number }>();
  for (const e of data.focus.items) {
    if (e.context?.kind !== "voice") continue;
    const o = body(e);
    // The first line of a turn names why it began; later ones only move the focus.
    if (typeof o.turn === "string" && !first.has(o.turn)) first.set(o.turn, { reason: o.reason, at: at(e) });
  }
  return [...first]
    .filter(([, x]) => x.reason === reason && x.at >= a && x.at < b)
    .map(([turn, x]) => ({ turn, at: x.at }));
}

/** The turns that got a voice line delivered. */
function spokenTurns(data: EvalData): Set<string> {
  const delivered = new Set(data.deliveries.items.map((d) => d.line));
  const out = new Set<string>();
  for (const e of data.utterances.items) {
    const o = body(e);
    if (o.channel === "voice" && typeof o.turn === "string" && delivered.has(e.id)) out.add(o.turn);
  }
  return out;
}

function turnRate(data: EvalData, reason: string, a: number, b: number): Reading {
  const from = covered(a, [data.focus, data.utterances, data.deliveries]);
  const turns = voiceTurns(data, reason, from, b);
  if (turns.length === 0) return none(from, b);
  const spoke = spokenTurns(data);
  const hit = turns.filter((t) => spoke.has(t.turn)).length;
  return { value: hit / turns.length, n: turns.length, hit, from, to: b };
}

function latency(data: EvalData, a: number, b: number): Reading {
  const from = covered(a, [data.latency]);
  const totals: number[] = [];
  for (const e of data.latency.items) {
    const t = at(e);
    if (t < from || t >= b) continue;
    const r = asE2eEvent(e);
    if (r === null || !r.complete || r.total_ms === null || r.context.kind !== "voice") continue;
    totals.push(r.total_ms);
  }
  const value = median(totals);
  return value === null ? none(from, b) : { value, n: totals.length, hit: null, from, to: b };
}

/** Per delivery (oldest first): an earlier one of the same key is at the same or a newer revision. */
export function repeats(deliveries: Delivery[]): boolean[] {
  const newest = new Map<string, number>();
  return deliveries.map((d) => {
    const seen = newest.get(d.attention_key);
    newest.set(d.attention_key, Math.max(seen ?? Number.NEGATIVE_INFINITY, d.revision));
    return seen !== undefined && seen >= d.revision;
  });
}

function repeat(data: EvalData, a: number, b: number): Reading {
  const from = covered(a, [data.deliveries]);
  const all = data.deliveries.items;
  const again = repeats(all);
  let n = 0;
  let hit = 0;
  all.forEach((d, i) => {
    const t = Date.parse(d.delivered_at);
    if (t < from || t >= b) return;
    n++;
    if (again[i]) hit++;
  });
  return n === 0 ? none(from, b) : { value: hit / n, n, hit, from, to: b };
}

/** A line this young may still be answered. */
export const ANSWER_GRACE_MS = 120_000;

/**
 * Her lines in a row that nobody answered, per place: the run grows with every line whose
 * `answered_by` is empty and starts over after one somebody answered. Lines still inside the
 * answer window are left out.
 */
export function unansweredRuns(deliveries: Delivery[], now: number): { at: number; run: number }[] {
  const run = new Map<string, number>();
  const out: { at: number; run: number }[] = [];
  for (const d of deliveries) {
    const t = Date.parse(d.delivered_at);
    if (now - t < ANSWER_GRACE_MS) continue;
    const key = `${d.context.platform}:${d.context.scope ?? ""}:${d.context.channel}:${d.context.kind}`;
    const next = d.answered_by.length > 0 ? 0 : (run.get(key) ?? 0) + 1;
    run.set(key, next);
    out.push({ at: t, run: next });
  }
  return out;
}

function monologue(data: EvalData, a: number, b: number): Reading {
  const from = covered(a, [data.deliveries]);
  const runs = unansweredRuns(data.deliveries.items, data.now).filter((r) => r.at >= from && r.at < b);
  if (runs.length === 0) return none(from, b);
  return { value: Math.max(...runs.map((r) => r.run)), n: runs.length, hit: null, from, to: b };
}

interface Promised {
  made: number;
  status: string;
}

/** Each promise with the time it was made and the state it ended in (or is in). */
function promises(events: LogEvent[]): Promised[] {
  const byId = new Map<string, Promised>();
  for (const e of events) {
    const c = body(e).commitment;
    if (c === null || typeof c !== "object") continue;
    const o = c as { id?: unknown; status?: unknown; made_at?: unknown };
    if (typeof o.id !== "string" || typeof o.status !== "string") continue;
    const made = typeof o.made_at === "string" ? Date.parse(o.made_at) : at(e);
    byId.set(o.id, { made: Number.isFinite(made) ? made : at(e), status: o.status });
  }
  return [...byId.values()];
}

function broken(data: EvalData, a: number, b: number): Reading {
  const from = covered(a, [data.commitments]);
  const made = promises(data.commitments.items).filter((p) => p.made >= from && p.made < b);
  if (made.length === 0) return none(from, b);
  const hit = made.filter((p) => p.status === "broken").length;
  return { value: hit, n: made.length, hit, from, to: b };
}

/** One measure over `[a, b)`. */
export function read(id: MetricId, data: EvalData, a: number, b: number): Reading {
  switch (id) {
    case "addressed":
      return turnRate(data, "addressed", a, b);
    case "reply":
      return turnRate(data, "reply_to_her", a, b);
    case "latency":
      return latency(data, a, b);
    case "repeat":
      return repeat(data, a, b);
    case "monologue":
      return monologue(data, a, b);
    case "broken":
      return broken(data, a, b);
  }
}

/** The bucket starts covering `[a, b)`, `bucketMs` apart. */
export function bucketStarts(a: number, b: number, bucketMs: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(a / bucketMs) * bucketMs; t < b; t += bucketMs) out.push(t);
  return out;
}

/** One measure per bucket; `null` where nothing was measured. */
export function trend(
  id: MetricId,
  data: EvalData,
  a: number,
  b: number,
  bucketMs: number,
): { t: number; value: number | null; n: number }[] {
  return bucketStarts(a, b, bucketMs).map((t) => {
    const r = read(id, data, t, t + bucketMs);
    return { t, value: r.value, n: r.n };
  });
}

/** Whether `value` meets the target of `def`. */
export function meets(def: MetricDef, value: number): boolean {
  if (def.good === "above") return def.strict ? value > def.target : value >= def.target;
  return def.strict ? value < def.target : value <= def.target;
}

export type FloorClaim = "addressed" | "reply" | "result" | "urgent" | "notable" | "wish" | "ambient";

export const FLOOR_CLAIM_LABEL: Record<FloorClaim, string> = {
  addressed: "有人叫她",
  reply: "有人回她",
  result: "有人等的結果",
  urgent: "緊急",
  notable: "值得一提",
  wish: "她自己想說",
  ambient: "大家在聊",
};

const CLAIM_ORDER = Object.keys(FLOOR_CLAIM_LABEL) as FloorClaim[];

/** How often each claim took the mic in `[a, b)`, in the claim order of §7.1. */
export function floorMix(data: EvalData, a: number, b: number): { kind: FloorClaim; count: number }[] {
  const from = covered(a, [data.floor]);
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const e of data.floor.items) {
    const t = at(e);
    if (t < from || t >= b) continue;
    const o = body(e);
    if (typeof o.floor_turn === "string") {
      if (seen.has(o.floor_turn)) continue;
      seen.add(o.floor_turn);
    }
    if (typeof o.kind === "string") counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  }
  return CLAIM_ORDER.map((kind) => ({ kind, count: counts.get(kind) ?? 0 })).filter((x) => x.count > 0);
}
