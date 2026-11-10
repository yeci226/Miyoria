import type { DecisionLog, DecisionRecord } from "@miyoria/store";
import {
  CORRECTION_KINDS,
  type ContextKey,
  type CountedOutcome,
  type TurnOutcome,
  type TurnOutcomeRecord,
  type TurnReason,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  aggregateTurnMetrics,
  loadTurnRows,
  localDay,
  MAX_DECISION_ROWS,
  MAX_OUTCOME_ROWS,
  stopOfRefused,
  windowStart,
} from "../src/metrics-turns.js";

const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();
/** `days` ago at noon, local. */
const at = (daysAgo: number) => new Date(2026, 10, 10 - daysAgo, 12, 0, 0).toISOString();

let n = 0;
const outcome = (
  reason: TurnReason,
  result: TurnOutcome,
  o: { daysAgo?: number; context?: ContextKey; latency?: number | null; turn?: string } = {},
): TurnOutcomeRecord => ({
  turn: o.turn ?? `t${++n}`,
  context: o.context ?? TEXT,
  reason,
  outcome: result,
  addressed_by: [],
  focus: [],
  restarts: 0,
  reasoning: null,
  latency_ms: o.latency ?? null,
  at: at(o.daysAgo ?? 0),
});

const refused = (
  reasons: string[],
  o: { daysAgo?: number; context?: ContextKey } = {},
): DecisionRecord => ({
  id: `d${++n}`,
  profile: "p" as never,
  ts: at(o.daysAgo ?? 0),
  trace: {
    turn: `r${n}` as never,
    context: o.context ?? TEXT,
    respond: false,
    score: 0.2,
    reasons,
  },
});

const SENT: TurnOutcome = { type: "sent", parts: 1 };
const SILENCE: TurnOutcome = { type: "silence" };

describe("aggregateTurnMetrics", () => {
  it("counts follow-ups the gate refused as unanswered, split by why", () => {
    const outcomes = [outcome("reply_to_her", SENT), outcome("reply_to_her", SENT)];
    const decisions = [
      refused(["replying to her: skips her quiet setting", "anti-spam: her share 0.50 > 0.15"]),
      refused(["replying to her: skips her quiet setting", "score 0.40 < 0.45"]),
      refused(["replying to her: skips her quiet setting", "p 0.10, roll 0.80"]),
      refused(["replying to her: skips her quiet setting", "floor: song"]),
    ];
    const m = aggregateTurnMetrics(outcomes, decisions, { now: NOW, days: 3 });
    expect(m.overall.followup).toEqual({ sent: 2, total: 6, rate: 2 / 6 });
    expect(m.overall.followup_stopped).toEqual({
      anti_spam: 1,
      low_score: 1,
      lost_roll: 1,
      floor: 1,
      passed_silent: 0,
      other: 0,
    });
  });

  it("a refused follow-up that has its outcome row is counted once, by the gate in its trace", () => {
    // What the live log looks like (2026-11-07 to 11-10): the refused turn has both rows.
    const stopped = (reasons: string[]) => {
      const d = refused(["replying to her: skips her quiet setting", ...reasons]);
      return { d, o: outcome("reply_to_her", SILENCE, { turn: d.trace.turn }) };
    };
    const rows = [
      stopped(["anti-spam: her share 0.45 > 0.15", "p 0.00"]),
      stopped(["level quiet", "score 0.40 < 0.45", "p 0.00"]),
      stopped(["p 0.45, roll 0.65"]),
    ];
    const m = aggregateTurnMetrics(
      rows.map((r) => r.o),
      rows.map((r) => r.d),
      { now: NOW, days: 3 },
    );
    expect(m.overall.followup).toEqual({ sent: 0, total: 3, rate: 0 });
    expect(m.overall.followup_stopped).toMatchObject({
      anti_spam: 1,
      low_score: 1,
      lost_roll: 1,
      other: 0,
    });
  });

  it('tells a silence after "talking with her" from other silences', () => {
    const talking = outcome("reply_to_her", SILENCE, { turn: "tt" });
    const trace: DecisionRecord = {
      id: "dd",
      profile: "p" as never,
      ts: at(0),
      trace: {
        turn: "tt" as never,
        context: TEXT,
        respond: true,
        score: 0.4,
        reasons: ["talking with her: hers to answer or pass"],
      },
    };
    const plain = outcome("reply_to_her", SILENCE);
    const m = aggregateTurnMetrics([talking, plain], [trace], { now: NOW, days: 1 });
    expect(m.overall.followup_stopped.passed_silent).toBe(1);
    expect(m.overall.followup_stopped.other).toBe(1);
    // The decision of a turn that ran is not counted a second time.
    expect(m.overall.turns).toBe(2);
  });

  it("separates ambient participation and addressed answers, and has no rate without samples", () => {
    const outcomes = [
      outcome("addressed", SENT),
      outcome("addressed", SENT),
      outcome("ambient", SENT),
    ];
    const decisions = [
      refused(["talkativeness 0.30 (global)", "score 0.20 < 0.45"]),
      refused(["direct: name"]),
    ];
    const m = aggregateTurnMetrics(outcomes, decisions, { now: NOW, days: 1 });
    expect(m.overall.ambient).toEqual({ sent: 1, total: 2, rate: 0.5 });
    expect(m.overall.addressed).toEqual({ sent: 2, total: 3, rate: 2 / 3 });
    expect(m.overall.followup.rate).toBeNull();
  });

  it("measures voice latency of addressed voice turns and who started the voice turns", () => {
    const outcomes = [
      ...[1000, 2000, 3000, 4000, 10_000].map((ms) =>
        outcome("addressed", SENT, { context: VOICE, latency: ms }),
      ),
      outcome("addressed", SENT, { context: TEXT, latency: 99_999 }),
      outcome("initiative", SENT, { context: VOICE }),
      outcome("initiative", SENT, { context: VOICE }),
      outcome("reply_to_her", SENT, { context: VOICE }),
    ];
    const m = aggregateTurnMetrics(outcomes, [], { now: NOW, days: 1 });
    expect(m.overall.voice_latency).toEqual({ p50_ms: 3000, p90_ms: 10_000, samples: 5 });
    expect(m.overall.voice_origin).toEqual({ self_started: 2, answering: 6 });
  });

  it("groups by local day, fills empty days and drops what is older than the window", () => {
    const outcomes = [
      outcome("addressed", SENT, { daysAgo: 0 }),
      outcome("addressed", SILENCE, { daysAgo: 2 }),
      outcome("addressed", SENT, { daysAgo: 9 }),
    ];
    const m = aggregateTurnMetrics(outcomes, [], { now: NOW, days: 3 });
    expect(m.daily.map((d) => d.day)).toEqual([
      localDay(Date.parse(at(2))),
      localDay(Date.parse(at(1))),
      localDay(Date.parse(at(0))),
    ]);
    expect(m.daily.map((d) => d.turns)).toEqual([1, 0, 1]);
    expect(m.daily[1]?.addressed.rate).toBeNull();
    expect(m.overall.turns).toBe(2);
    expect(m.overall.outcomes).toEqual({ sent: 1, silence: 1, cancelled: 0, error: 0 });
  });

  it("adds up the corrections of the measured turns, by kind and channel, per day", () => {
    const counted = (
      context: ContextKey,
      corrections: CountedOutcome["corrections"],
      daysAgo = 0,
    ): CountedOutcome => ({ ...outcome("addressed", SENT, { context, daysAgo }), corrections });
    const outcomes = [
      counted(TEXT, { claim_reask: 1, claim_held: 2 }),
      counted(TEXT, { claim_held: 1 }),
      counted(TEXT, {}),
      counted(VOICE, { wait_line: 1 }),
      counted(TEXT, { leak_dropped: 3 }, 1),
      // Never reached the model, or written before the count: not measured.
      outcome("addressed", SENT),
      // Malformed counts are left out, the turn is still measured.
      { ...outcome("addressed", SENT), corrections: { nope: 3, claim_held: -1 } } as never,
    ];
    const m = aggregateTurnMetrics(outcomes, [refused(["score 0.1 < 0.45"])], {
      now: NOW,
      days: 2,
    });
    const c = m.overall.corrections;
    expect(c.measured).toEqual({ voice: 1, text: 5 });
    expect(c.kinds.claim_held.text).toEqual({ events: 3, turns: 2 });
    expect(c.kinds.claim_reask.text).toEqual({ events: 1, turns: 1 });
    expect(c.kinds.wait_line).toEqual({
      voice: { events: 1, turns: 1 },
      text: { events: 0, turns: 0 },
    });
    // Every kind is there, zeros included, so the panel's table never changes shape.
    expect(Object.keys(c.kinds)).toEqual([...CORRECTION_KINDS]);
    expect(m.daily.map((d) => d.corrections.kinds.leak_dropped.text.events)).toEqual([3, 0]);
    expect(m.daily.map((d) => d.corrections.measured.text)).toEqual([1, 4]);
  });
});

describe("stopOfRefused", () => {
  it("reads the gate's own wording", () => {
    expect(stopOfRefused(["anti-spam: her share 0.60 > 0.15"])).toBe("anti_spam");
    expect(stopOfRefused(["score 0.10 < 0.45"])).toBe("low_score");
    expect(stopOfRefused(["p 0.11, roll 0.90"])).toBe("lost_roll");
    expect(stopOfRefused(["floor: held"])).toBe("floor");
    expect(stopOfRefused(["someone is speaking"])).toBe("other");
  });
});

describe("loadTurnRows", () => {
  const PROFILE = "p" as never;

  it("asks a log that can for everything since the first local midnight, with no cap", async () => {
    const calls: string[] = [];
    const log: DecisionLog = {
      append: async () => undefined,
      recent: async () => {
        calls.push("recent");
        return [];
      },
      recentOutcomes: async () => {
        calls.push("recentOutcomes");
        return [];
      },
      outcomesSince: async (_p, since) => {
        calls.push(`outcomes ${since}`);
        return [outcome("addressed", SENT)];
      },
      decisionsSince: async (_p, since) => {
        calls.push(`decisions ${since}`);
        return [refused(["score 0.1 < 0.45"])];
      },
    };
    const rows = await loadTurnRows(log, PROFILE, NOW, 3);
    const since = new Date(windowStart(NOW, 3)).toISOString();
    expect(since).toBe(new Date(2026, 10, 8).toISOString());
    expect(calls.sort()).toEqual([`decisions ${since}`, `outcomes ${since}`]);
    expect(rows.outcomes).toHaveLength(1);
    expect(rows.decisions).toHaveLength(1);
    expect(rows.truncated).toBe(false);
  });

  it("falls back to the capped read, and says so when the cap cut into the window", async () => {
    const many = (n: number, daysAgo: number) =>
      Array.from({ length: n }, () => outcome("addressed", SENT, { daysAgo }));
    const capped = (ago: number): DecisionLog => ({
      append: async () => undefined,
      recent: async () => [],
      recentOutcomes: async (_p, _c, limit) => {
        expect(limit).toBe(MAX_OUTCOME_ROWS);
        return many(MAX_OUTCOME_ROWS, ago);
      },
    });
    expect((await loadTurnRows(capped(0), PROFILE, NOW, 3)).truncated).toBe(true);
    expect((await loadTurnRows(capped(9), PROFILE, NOW, 3)).truncated).toBe(false);
    expect(MAX_DECISION_ROWS).toBeGreaterThan(MAX_OUTCOME_ROWS);
  });

  it("refuses a log that keeps no outcomes", async () => {
    const log: DecisionLog = { append: async () => undefined, recent: async () => [] };
    await expect(loadTurnRows(log, PROFILE, NOW, 3)).rejects.toThrow(/turn outcomes/);
  });
});
