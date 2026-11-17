import { describe, expect, it } from "vitest";
import type { Thought } from "@/api/types";
import type { TelemetryPoint } from "@miyoria/contracts/api";
import { extent, niceMax, ticks } from "@/components/charts/scale";
import { bucketize, quantile, thoughtColumns, thoughtOutcome } from "./telemetry";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const MIN = 60_000;

function point(min: number, calls: number, firstToken: { count: number; buckets: [number, number][] }, events = {}): TelemetryPoint {
  return {
    at: new Date(T0 + min * MIN).toISOString(),
    mood: null,
    boredom: null,
    drives: null,
    initiative: null,
    llm: {
      calls,
      prompt_tokens: calls * 100,
      cached_prompt_tokens: calls * 60,
      completion_tokens: calls * 10,
      cost_usd: calls * 0.01,
      errors: 0,
      first_token: { count: firstToken.count, sum_s: 0, buckets: firstToken.buckets.map(([le_s, count]) => ({ le_s, count })) },
    },
    voice_sessions: 0,
    speaking: false,
    events,
  };
}

describe("telemetry", () => {
  it("interpolates quantiles inside histogram buckets", () => {
    const b = [
      { le_s: 0.5, count: 2 },
      { le_s: 1, count: 4 },
    ];
    expect(quantile(b, 4, 0.5)).toBe(0.5);
    expect(quantile(b, 4, 0.75)).toBe(0.75);
    expect(quantile(b, 0, 0.5)).toBeNull();
    // Past the last finite bound: the bound.
    expect(quantile(b, 5, 0.95)).toBe(1);
  });

  it("turns cumulative counters into per-bucket deltas, surviving a restart", () => {
    const points = [
      point(0, 10, { count: 10, buckets: [[0.5, 5], [1, 10]] }),
      point(1, 14, { count: 14, buckets: [[0.5, 5], [1, 14]] }, { messages: 3 }),
      // Core restarted: counters start over.
      point(6, 2, { count: 2, buckets: [[0.5, 2], [1, 2]] }, { messages: 1 }),
    ];
    const buckets = bucketize(points, 5 * MIN, 10, T0 + 10 * MIN);
    const first = buckets.find((b) => b.t === T0);
    const second = buckets.find((b) => b.t === T0 + 5 * MIN);
    expect(first).toMatchObject({ calls: 4, cached: 240, prompt: 160, completion: 40, events: { messages: 3 } });
    // The 4 calls in the first bucket all fell between 0.5 s and 1 s.
    expect(first?.p50).toBeCloseTo(0.75);
    expect(second).toMatchObject({ calls: 2, events: { messages: 1 } });
    expect(second?.p50).toBeCloseTo(0.25);
  });

  it("buckets thoughts by what came of them", () => {
    const thought = (min: number, statuses: string[]): Thought =>
      ({
        id: String(min),
        at: new Date(T0 + min * MIN).toISOString(),
        triggers: [],
        thought: "",
        changes: [],
        intents: statuses.map((status, i) => ({ id: String(i), status })),
        tokens: null,
        error: null,
        ms: 0,
      }) as unknown as Thought;
    expect(thoughtOutcome(thought(0, []))).toBe("none");
    expect(thoughtOutcome(thought(0, ["denied", "done"]))).toBe("acted");
    expect(thoughtOutcome(thought(0, ["denied"]))).toBe("held");
    const cols = thoughtColumns([thought(1, ["done"]), thought(2, []), thought(7, ["dropped"])], 5 * MIN, 10, T0 + 10 * MIN);
    expect(cols.find((c) => c.t === T0)?.values).toEqual({ acted: 1, held: 0, none: 1 });
    expect(cols.find((c) => c.t === T0 + 5 * MIN)?.values).toEqual({ acted: 0, held: 1, none: 0 });
  });
});

describe("chart scales", () => {
  it("picks round ticks and tops", () => {
    expect(ticks([0, 1], 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceMax(173)).toEqual([0, 200]);
    expect(niceMax(0)).toEqual([0, 1]);
    expect(extent([null, 2, 8])[0]).toBeLessThanOrEqual(2);
  });
});
