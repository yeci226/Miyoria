// How well she takes part, per local day (docs/design/v4-plan.md §13): `GET /api/turns/metrics?days=N`.
// Read-only. It joins the two logs the turn engine keeps: every turn has an outcome row
// (`agent.turn.outcome`; a turn the gate refused ends in `silence`) and a decision trace whose
// reasons say which gate stopped it. A trace without an outcome row (older data, or a write that
// was lost) is counted too; it carries no `TurnReason`, so its reason is read off what the gate
// wrote (`attention.ts`): "replying to her" marks a follow-up, "direct:" an addressed one,
// `intent:` / `initiative:` her own. Whatever is none of these was ambient.
// The aggregation is a pure function over records; the route only fetches and clamps.
//
// The after-the-fact corrections of her output (docs/design/v4-patches.md) come from the same
// outcome rows: a turn that reached the model says which of them fired and how often
// (`CountedOutcome.corrections`), so each one is counted beside the turns it was measured over.

import { type DecisionLog, DecisionLogKey, type DecisionRecord } from "@miyoria/store";
import {
  CORRECTION_KINDS,
  type CorrectionCounts,
  type CorrectionKind,
  correctionsOf,
  type ProfileId,
  type TurnOutcomeRecord,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { clampLimit, readQuery, usizeParam } from "./extract.js";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
/** How much history one request reads. A busy week is a few tens of thousands of rows. */
export const MAX_OUTCOME_ROWS = 40_000;
export const MAX_DECISION_ROWS = 80_000;
const DAY_MS = 86_400_000;

/** `sent / total`; `rate` is `null` with no samples, never 0. */
export interface Ratio {
  sent: number;
  total: number;
  rate: number | null;
}

export interface LatencyStat {
  p50_ms: number | null;
  p90_ms: number | null;
  samples: number;
}

/** Why a follow-up she did not answer stopped. */
export interface StopReasons {
  /** Her share of the recent messages was over the cap. */
  anti_spam: number;
  /** The score was under the level's minimum. */
  low_score: number;
  /** The gate passed it on and the dice said no. */
  lost_roll: number;
  /** The floor (the microphone or the channel) was refused. */
  floor: number;
  /** "Talking with her": handed to the model, which chose silence. */
  passed_silent: number;
  /** Anything else: the model's other silences, cancelled, errors, other gates. */
  other: number;
}

/** How often one correction fired in one channel: firings, and the turns it fired in. */
export interface CorrectionCount {
  events: number;
  turns: number;
}

/** One correction, in voice and in text. */
export interface CorrectionStat {
  voice: CorrectionCount;
  text: CorrectionCount;
}

export interface CorrectionsBucket {
  /**
   * Turns that reached the model and carry their corrections, by channel: what a share like
   * "fired on 0.3% of replies" is counted over. Rows written before the count existed are not.
   */
  measured: { voice: number; text: number };
  /** Every kind, zeros included. */
  kinds: Record<CorrectionKind, CorrectionStat>;
}

export interface MetricsBucket {
  /** Turns counted (outcomes plus refused gate decisions). */
  turns: number;
  /** Someone replied to what she said: how often she answered (`reply_to_her`). */
  followup: Ratio;
  /** Nobody called her: how often she joined in (`ambient`). */
  ambient: Ratio;
  /** Someone called her (`addressed`). */
  addressed: Ratio;
  /** Voice, addressed turns that made sound: from the last focus input to her first output. */
  voice_latency: LatencyStat;
  /** Voice turns that made sound: `initiative` against `addressed` and `reply_to_her`. */
  voice_origin: { self_started: number; answering: number };
  /** Turns by how they ended; a refused gate decision counts as `silence`. */
  outcomes: { sent: number; silence: number; cancelled: number; error: number };
  /** Follow-ups that got no answer, by why. */
  followup_stopped: StopReasons;
  /** What the code changed of her output after the model wrote it. */
  corrections: CorrectionsBucket;
}

export interface MetricsDay extends MetricsBucket {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
}

export interface TurnMetrics {
  days: number;
  /** ISO time the window starts (the local midnight `days - 1` days ago). */
  from: string;
  /** More history than one request reads: the oldest day may be partial. */
  truncated: boolean;
  overall: MetricsBucket;
  /** Oldest first, one per local day of the window, empty days included. */
  daily: MetricsDay[];
}

type Kind = "addressed" | "reply_to_her" | "ambient" | "initiative" | "notice";

interface Row {
  at: number;
  kind: Kind;
  voice: boolean;
  /** A gate refusal that never became a turn counts as `silence`. */
  outcome: "sent" | "silence" | "cancelled" | "error";
  latency: number | null;
  stop: keyof StopReasons;
  /** `null`: the turn was not measured (it never reached the model, or predates the count). */
  corrections: CorrectionCounts | null;
}

const has = (reasons: readonly string[], needle: string) => reasons.some((r) => r.includes(needle));

function kindOfRefused(reasons: readonly string[]): Kind {
  if (has(reasons, "replying to her")) return "reply_to_her";
  if (reasons.some((r) => r.startsWith("direct:"))) return "addressed";
  if (reasons.some((r) => r.startsWith("intent:") || r.startsWith("initiative:")))
    return "initiative";
  return "ambient";
}

/** Why a gate decision that said no stopped. */
export function stopOfRefused(reasons: readonly string[]): keyof StopReasons {
  if (has(reasons, "floor:")) return "floor";
  if (has(reasons, "anti-spam")) return "anti_spam";
  if (reasons.some((r) => /^score .* < /.test(r))) return "low_score";
  if (reasons.some((r) => /\broll\b/.test(r))) return "lost_roll";
  return "other";
}

function ms(ts: string): number {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? Number.NaN : v;
}

/** `YYYY-MM-DD` in the server's local time. */
export function localDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

function ratio(sent: number, total: number): Ratio {
  return { sent, total, rate: total === 0 ? null : sent / total };
}

function corrections(rows: readonly Row[]): CorrectionsBucket {
  const zero = (): CorrectionStat => ({
    voice: { events: 0, turns: 0 },
    text: { events: 0, turns: 0 },
  });
  const kinds = Object.fromEntries(CORRECTION_KINDS.map((k) => [k, zero()])) as Record<
    CorrectionKind,
    CorrectionStat
  >;
  const measured = { voice: 0, text: 0 };
  for (const r of rows) {
    if (r.corrections === null) continue;
    const channel = r.voice ? "voice" : "text";
    measured[channel] += 1;
    for (const kind of CORRECTION_KINDS) {
      const n = r.corrections[kind] ?? 0;
      if (n <= 0) continue;
      kinds[kind][channel].events += n;
      kinds[kind][channel].turns += 1;
    }
  }
  return { measured, kinds };
}

function bucket(rows: readonly Row[]): MetricsBucket {
  const count = (kind: Kind) => {
    const of = rows.filter((r) => r.kind === kind);
    return ratio(of.filter((r) => r.outcome === "sent").length, of.length);
  };
  const stopped: StopReasons = {
    anti_spam: 0,
    low_score: 0,
    lost_roll: 0,
    floor: 0,
    passed_silent: 0,
    other: 0,
  };
  const outcomes = { sent: 0, silence: 0, cancelled: 0, error: 0 };
  let selfStarted = 0;
  let answering = 0;
  const latencies: number[] = [];
  for (const r of rows) {
    outcomes[r.outcome] += 1;
    if (r.kind === "reply_to_her" && r.outcome !== "sent") stopped[r.stop] += 1;
    if (r.voice && r.outcome === "sent") {
      if (r.kind === "initiative") selfStarted += 1;
      else if (r.kind === "addressed" || r.kind === "reply_to_her") answering += 1;
      if (r.kind === "addressed" && r.latency !== null) latencies.push(r.latency);
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    turns: rows.length,
    followup: count("reply_to_her"),
    ambient: count("ambient"),
    addressed: count("addressed"),
    voice_latency: {
      p50_ms: percentile(latencies, 0.5),
      p90_ms: percentile(latencies, 0.9),
      samples: latencies.length,
    },
    voice_origin: { self_started: selfStarted, answering },
    outcomes,
    followup_stopped: stopped,
    corrections: corrections(rows),
  };
}

/**
 * The metrics of the last `days` local days (today included) from the records, newest or oldest
 * first alike. `truncated`: the caller hit its read cap inside the window.
 */
export function aggregateTurnMetrics(
  outcomes: readonly TurnOutcomeRecord[],
  decisions: readonly DecisionRecord[],
  options: { now: number; days: number; truncated?: boolean },
): TurnMetrics {
  const today = new Date(options.now);
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (options.days - 1),
  ).getTime();
  const rows: Row[] = [];
  const ran = new Set<string>();

  // The decision trace of a turn tells why a silence was silent ("talking with her").
  const traceOf = new Map<string, readonly string[]>();
  for (const d of decisions) traceOf.set(d.trace.turn, d.trace.reasons);

  for (const o of outcomes) {
    const at = ms(o.at);
    ran.add(o.turn);
    if (Number.isNaN(at) || at < start) continue;
    const reasons = traceOf.get(o.turn) ?? [];
    const type = o.outcome.type;
    rows.push({
      at,
      kind: o.reason,
      voice: o.context.kind === "voice",
      outcome: type,
      latency: o.latency_ms,
      corrections: correctionsOf(o),
      // A turn the gate refused has an outcome row too (`silence`), and its trace says which gate.
      stop:
        type !== "silence"
          ? "other"
          : has(reasons, "talking with her")
            ? "passed_silent"
            : stopOfRefused(reasons),
    });
  }
  for (const d of decisions) {
    // A turn that ran is counted from its outcome; so is a decision that said yes but whose
    // outcome is missing (still running), which is not a measurement yet.
    if (d.trace.respond || ran.has(d.trace.turn)) continue;
    const at = ms(d.ts);
    if (Number.isNaN(at) || at < start) continue;
    rows.push({
      at,
      kind: kindOfRefused(d.trace.reasons),
      voice: d.trace.context.kind === "voice",
      outcome: "silence",
      latency: null,
      stop: stopOfRefused(d.trace.reasons),
      corrections: null,
    });
  }

  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const key = localDay(r.at);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }
  const daily: MetricsDay[] = [];
  for (let i = 0; i < options.days; i++) {
    const day = localDay(
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - (options.days - 1) + i,
      ).getTime(),
    );
    daily.push({ day, ...bucket(byDay.get(day) ?? []) });
  }
  return {
    days: options.days,
    from: new Date(start).toISOString(),
    truncated: options.truncated === true,
    overall: bucket(rows),
    daily,
  };
}

/** Where the window of `days` local days ending today starts (local midnight of its first day). */
export function windowStart(now: number, days: number): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
}

/**
 * The rows the window needs. A log that can answer "since" returns every row of the window, so
 * nothing is cut; one that cannot is read newest first up to a cap, and `truncated` says when the
 * cap was hit with the oldest row still inside the window (the first days are then partial).
 */
export async function loadTurnRows(
  log: DecisionLog,
  profile: ProfileId,
  now: number,
  days: number,
): Promise<{
  outcomes: TurnOutcomeRecord[];
  decisions: DecisionRecord[];
  truncated: boolean;
}> {
  if (log.recentOutcomes === undefined) {
    throw ApiError.unavailable("this decision log does not keep turn outcomes");
  }
  const since = toTimestamp(windowStart(now, days));
  if (log.outcomesSince !== undefined && log.decisionsSince !== undefined) {
    const [outcomes, decisions] = await Promise.all([
      log.outcomesSince(profile, since),
      log.decisionsSince(profile, since),
    ]);
    return { outcomes, decisions, truncated: false };
  }
  const [outcomes, decisions] = await Promise.all([
    log.recentOutcomes(profile, null, MAX_OUTCOME_ROWS),
    log.recent(profile, null, MAX_DECISION_ROWS),
  ]);
  // Newest first: hitting the cap with the oldest row still inside the window means the
  // window's first days are partial.
  const cutoff = now - days * DAY_MS;
  const oldest = (rows: readonly { ts?: string; at?: string }[], cap: number) => {
    if (rows.length < cap) return false;
    const last = rows[rows.length - 1];
    const t = Date.parse(last?.ts ?? last?.at ?? "");
    return !Number.isNaN(t) && t > cutoff;
  };
  return {
    outcomes,
    decisions,
    truncated: oldest(outcomes, MAX_OUTCOME_ROWS) || oldest(decisions, MAX_DECISION_ROWS),
  };
}

const QuerySchema = z.object({ days: usizeParam.optional() });

export function turnMetricsRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/turns/metrics",
      handler: async (c) => {
        const q = readQuery(c, QuerySchema);
        const days = clampLimit(q.days, DEFAULT_DAYS, MAX_DAYS);
        const log = state.service(DecisionLogKey, "decision log");
        const now = Date.now();
        const { outcomes, decisions, truncated } = await loadTurnRows(
          log,
          state.profile(),
          now,
          days,
        );
        return json(aggregateTurnMetrics(outcomes, decisions, { now, days, truncated }));
      },
    },
  ];
}
