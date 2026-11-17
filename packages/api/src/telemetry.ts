// `GET /api/telemetry?minutes=360`: what the panel charts over time. The `api` module samples
// once a minute (her mood, drives and boredom, the LLM counters of `/metrics`, the mind's call
// counts) and counts a few bus topics between samples. Samples live in memory for 24 hours, so
// the series starts when the `api` module started.

import type { TelemetryLlm, TelemetryPoint, TelemetryView } from "@miyoria/contracts/api";
import { type MetricFamily, metrics } from "@miyoria/runtime/kernel";
import { type BusEvent, Events, is, SelfStateKey, toTimestamp } from "@miyoria/types";
import { os } from "./contract.js";
import { countOf } from "./extract.js";
import type { ApiState } from "./state.js";

/** One sample a minute. */
export const SAMPLE_EVERY_MS = 60_000;
/** A day of samples. */
export const MAX_POINTS = 24 * 60;
const DEFAULT_MINUTES = 6 * 60;

/** Topics counted per sample, by the key they get in `TelemetryPoint.events`. */
export const TELEMETRY_TOPICS: Readonly<Record<string, string>> = {
  [Events.PlatformMessageCreated.type]: "messages",
  [Events.AgentTurnCompleted.type]: "turns",
  [Events.AgentInitiative.type]: "initiatives",
  [Events.VoiceUtteranceEvent.type]: "utterances",
  [Events.ActionCompleted.type]: "actions",
};

const FIRST_TOKEN = "miyoria_llm_first_token_seconds";

function sum(
  families: readonly MetricFamily[],
  name: string,
  filter?: (l: Record<string, string>) => boolean,
): number {
  let total = 0;
  for (const f of families) {
    for (const s of f.samples) {
      if (s.name !== name) continue;
      if (filter && !filter(s.labels)) continue;
      total += s.value;
    }
  }
  return total;
}

/** The LLM counters of the process registry, summed over models and purposes. */
export function llmTotals(families: readonly MetricFamily[]): TelemetryLlm {
  const tokens = (type: string) =>
    sum(families, "miyoria_llm_tokens_total", (l) => l.type === type);
  const bounds = new Map<string, number>();
  for (const f of families) {
    if (f.name !== FIRST_TOKEN) continue;
    for (const s of f.samples) {
      if (s.name !== `${FIRST_TOKEN}_bucket`) continue;
      const le = s.labels.le ?? "";
      bounds.set(le, (bounds.get(le) ?? 0) + s.value);
    }
  }
  const buckets = [...bounds.entries()]
    .map(([le, count]) => ({ le: le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le), count }))
    .filter((b) => !Number.isNaN(b.le))
    .sort((a, b) => a.le - b.le);
  return {
    calls: sum(families, "miyoria_llm_calls_total"),
    prompt_tokens: tokens("prompt"),
    completion_tokens: tokens("completion"),
    cached_prompt_tokens: tokens("cached_prompt"),
    cost_usd: sum(families, "miyoria_llm_cost_usd_total"),
    errors: sum(families, "miyoria_llm_errors_total"),
    first_token: {
      count: sum(families, `${FIRST_TOKEN}_count`),
      sum_s: sum(families, `${FIRST_TOKEN}_sum`),
      // Cumulative counts at each upper bound; `+Inf` is `null` in JSON, so it is left out.
      buckets: buckets
        .filter((b) => Number.isFinite(b.le))
        .map((b) => ({ le_s: b.le, count: b.count })),
    },
  };
}

export class Telemetry {
  readonly #points: TelemetryPoint[] = [];
  #counts: Record<string, number> = {};

  constructor(private readonly max = MAX_POINTS) {}

  /** Counts a bus envelope toward the next sample. */
  handle(env: BusEvent): void {
    const key = TELEMETRY_TOPICS[env.type];
    if (!key) return;
    // A turn she ended in silence, or that new messages cancelled, is no reply.
    if (is(Events.AgentTurnCompleted, env) && env.data.text.trim() === "") return;
    this.#counts[key] = (this.#counts[key] ?? 0) + 1;
  }

  /** Takes one sample of `state` now. */
  sample(state: ApiState): TelemetryPoint {
    const self = state.optional(SelfStateKey)?.snapshot() ?? null;
    const events: Record<string, number> = {};
    for (const key of Object.values(TELEMETRY_TOPICS)) events[key] = this.#counts[key] ?? 0;
    this.#counts = {};
    const point: TelemetryPoint = {
      at: toTimestamp(state.now()),
      mood: self?.mood ?? null,
      boredom: self ? self.boredom : null,
      drives: self ? { ...self.drives } : null,
      initiative: self ? self.policy.initiative : null,
      llm: llmTotals(metrics.collect()),
      voice_sessions: state.monitor.voice(state.now()).sessions.length,
      speaking: state.monitor.speaking(),
      events,
    };
    this.#points.push(point);
    while (this.#points.length > this.max) this.#points.shift();
    return point;
  }

  /** Samples of the last `minutes`, oldest first. */
  view(nowMs: number, minutes: number): TelemetryView {
    const cutoff = nowMs - minutes * 60_000;
    return {
      interval_ms: SAMPLE_EVERY_MS,
      points: this.#points.filter((p) => Date.parse(p.at) >= cutoff),
    };
  }
}

/** `GET /api/telemetry`, on the route table. */
export const telemetryRpc = os.telemetry.handler(({ input, context }) => {
  const { state } = context;
  const minutes = Math.min(
    Math.max(countOf(input.query.minutes) ?? DEFAULT_MINUTES, 1),
    MAX_POINTS,
  );
  return state.telemetry.view(state.now(), minutes);
});
