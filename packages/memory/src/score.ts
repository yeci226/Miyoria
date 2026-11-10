// Hybrid ranking and relative dates.

import type { MemoryRecord } from "@miyoria/store";
import { type PersonId, type Timestamp, timestampMs } from "@miyoria/types";
import type { MemoryConfig, Weights } from "./config.js";

const DAY_MS = 86_400_000;

/** Signals of one candidate, each in 0..1. */
export interface Signals {
  vector: number;
  text: number;
  recency: number;
  importance: number;
  subject: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * `w_vec·cos + w_text·text + w_recency·recency + w_importance·importance + w_subject·subject`.
 */
export function signalScore(s: Signals, w: Weights): number {
  return (
    w.vector * s.vector +
    w.text * s.text +
    w.recency * s.recency +
    w.importance * s.importance +
    w.subject * s.subject
  );
}

/** Whole seconds from `then` to `now` (Rust `(now - then).num_seconds()`). */
function secondsBetween(then: Timestamp, now: Timestamp): number {
  return Math.trunc((timestampMs(now) - timestampMs(then)) / 1000);
}

/** `exp(-age / tau)` with age measured from the last update. */
export function recency(updatedAt: Timestamp, now: Timestamp, tauDays: number): number {
  const ageDays = (Math.max(0, secondsBetween(updatedAt, now)) * 1000) / DAY_MS;
  return Math.exp(-ageDays / Math.max(tauDays, 0.01));
}

/**
 * The recency time constant of a record (days): episodes fade over hours to days, everything
 * else (facts, her notes, followups) over weeks.
 */
export function recencyTau(config: MemoryConfig, kind: MemoryRecord["kind"]): number {
  return kind === "episode" ? config.episode_recency_tau_days : config.recency_tau_days;
}

/** Signals of a record. `text` is already normalized (0..1). */
export function signals(
  config: MemoryConfig,
  record: MemoryRecord,
  vector: number | null,
  text: number,
  present: readonly PersonId[],
  now: Timestamp,
): Signals {
  return {
    vector: clamp(vector ?? 0, 0, 1),
    text: clamp(text, 0, 1),
    recency: recency(record.updated_at, now, recencyTau(config, record.kind)),
    importance: clamp(record.importance, 0, 1),
    subject: record.subjects.some((s) => present.includes(s)) ? 1 : 0,
  };
}

/**
 * The confidence of a fact after fading: not reinforced for `decay_after_days`, it loses
 * `decay_per_day` of itself each day. Computed when it is read; the stored value is what the
 * record had when it was last written (so reinforcing it, which rewrites it, starts over).
 * Other kinds do not fade this way (episodes have their own recency and pruning).
 */
export function fadedConfidence(
  config: MemoryConfig,
  record: MemoryRecord,
  now: Timestamp,
): number {
  const c = clamp(record.confidence, 0, 1);
  if (record.kind !== "fact") return c;
  const f = config.forgetting;
  const idleDays =
    (timestampMs(now) - timestampMs(record.updated_at)) / DAY_MS - f.decay_after_days;
  return idleDays > 0 ? c * clamp(f.decay_per_day, 0, 1) ** idleDays : c;
}

/**
 * What she should trust the record: faded, and a memory of unknown provenance (written before
 * origins were recorded) counts for `unknown_origin_factor` of that.
 */
export function effectiveConfidence(
  config: MemoryConfig,
  record: MemoryRecord,
  now: Timestamp,
): number {
  const faded = fadedConfidence(config, record, now);
  return (record.origin ?? "unknown") === "unknown" ? faded * config.unknown_origin_factor : faded;
}

/**
 * Final score: the weighted sum, scaled by confidence for facts (a fact she is unsure about
 * ranks lower). With `now` the confidence is the effective one (faded, origin weighed).
 */
export function finalScore(
  config: MemoryConfig,
  record: MemoryRecord,
  s: Signals,
  now?: Timestamp,
): number {
  const base = signalScore(s, config.weights);
  if (record.kind !== "fact") return base;
  const confidence =
    now === undefined ? record.confidence : effectiveConfidence(config, record, now);
  return base * (0.5 + 0.5 * clamp(confidence, 0, 1));
}

/** Fraction of query tokens contained in the record's tokens. */
export function tokenOverlap(query: readonly string[], recordTokens: string): number {
  if (query.length === 0) return 0;
  const have = new Set(recordTokens.split(/\s+/).filter((t) => t !== ""));
  const matched = query.filter((t) => have.has(t)).length;
  return matched / query.length;
}

/** Chinese relative date such as 「剛剛」「昨天」「三天前」「兩週前」. */
export function relativeDate(then: Timestamp, now: Timestamp): string {
  const secs = secondsBetween(then, now);
  if (secs < 3_600) return "剛剛";
  const hours = Math.trunc(secs / 3_600);
  if (hours < 24) return `${numeral(hours, false)}小時前`;
  const days = Math.trunc(hours / 24);
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  if (days <= 6) return `${numeral(days, false)}天前`;
  if (days <= 29) return `${numeral(Math.trunc(days / 7), true)}週前`;
  if (days <= 364) return `${numeral(Math.trunc(days / 30), true)}個月前`;
  return `${numeral(Math.trunc(days / 365), true)}年前`;
}

const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;

/** Chinese numeral for 1..=99 (falls back to digits). `measure` uses 「兩」 for 2, as in 「兩週」. */
function numeral(n: number, measure: boolean): string {
  if (n === 2 && measure) return "兩";
  if (n >= 0 && n <= 9) return DIGITS[n] as string;
  if (n === 10) return "十";
  if (n >= 11 && n <= 19) return `十${DIGITS[n % 10]}`;
  if (n >= 20 && n <= 99) {
    const ones = n % 10 === 0 ? "" : DIGITS[n % 10];
    return `${DIGITS[Math.trunc(n / 10)]}十${ones}`;
  }
  return String(n);
}
