// What `DecisionLog` returns (`recent`, `decisionsSince`, `recentOutcomes`, `outcomesSince`),
// pinned on fresh databases so the implementation behind it can change: her attention decisions
// and how each turn ended, read back newest first, per place or for the whole character. One
// profile only: one database belongs to one character (v5-data decision D6).

import {
  type ContextKey,
  type ContextKind,
  type Timestamp,
  type TurnOutcomeRecord,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type DecisionLog, type DecisionRecord, SqliteStore, type Store } from "../src/index.js";

const P = "deepseek-chan";
const T0 = Date.UTC(2026, 10, 1, 12);
const SECOND = 1000;

const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<DecisionLog> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store.decisions;
}

const place = (scope: string | null, channel: string, kind: ContextKind): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind,
});
const at = (secs: number): Timestamp => toTimestamp(T0 + secs * SECOND);

const TEXT = place("g1", "c1", "channel");
const VOICE = place("g1", "c1", "voice");
const OTHER_GUILD = place("g2", "c1", "channel");
const THREAD = place("g1", "t1", "thread");
const DM = place(null, "d1", "dm");

function decision(id: string, context: ContextKey, reason: string, secs: number): DecisionRecord {
  return {
    id,
    profile: P,
    ts: at(secs),
    trace: { turn: `turn-${id}`, context, respond: false, score: 0.25, reasons: [reason] },
  };
}

const reasons = (records: readonly DecisionRecord[]) => records.map((r) => r.trace.reasons[0]);

function outcome(
  turn: string,
  context: ContextKey,
  kind: "sent" | "silence" | "cancelled",
  secs: number,
): TurnOutcomeRecord {
  return {
    turn,
    context,
    reason: "addressed",
    outcome:
      kind === "sent"
        ? { type: "sent", parts: 2 }
        : kind === "silence"
          ? { type: "silence" }
          : { type: "cancelled", cause: "input", by: "Owen" },
    addressed_by: ["Owen"],
    focus: [{ context, id: `m-${turn}` }],
    restarts: 0,
    reasoning: null,
    latency_ms: null,
    at: at(secs),
  };
}

const turns = (records: readonly TurnOutcomeRecord[] | undefined) =>
  (records ?? []).map((r) => r.turn);

describe("decisions", () => {
  it("reads the newest first, for every place or one, up to a limit", async () => {
    const log = await open();
    // Appended out of order.
    for (const d of [
      decision("d2", TEXT, "a2", 2),
      decision("d1", TEXT, "a1", 1),
      decision("d3", VOICE, "b3", 3),
      decision("d4", TEXT, "a4", 4),
      decision("d5", OTHER_GUILD, "g5", 5),
      decision("d6", THREAD, "t6", 6),
    ]) {
      await log.append(d);
    }
    expect(reasons(await log.recent(P, null, 100))).toEqual(["t6", "g5", "a4", "b3", "a2", "a1"]);
    expect(reasons(await log.recent(P, null, 2))).toEqual(["t6", "g5"]);
    expect(reasons(await log.recent(P, null, Number.POSITIVE_INFINITY))).toHaveLength(6);
    expect(reasons(await log.recent(P, TEXT, 100))).toEqual(["a4", "a2", "a1"]);
    expect(reasons(await log.recent(P, TEXT, 1))).toEqual(["a4"]);
    expect(reasons(await log.recent(P, VOICE, 100))).toEqual(["b3"]);
    expect(reasons(await log.recent(P, OTHER_GUILD, 100))).toEqual(["g5"]);
    expect(reasons(await log.recent(P, THREAD, 100))).toEqual(["t6"]);
    expect(await log.recent(P, null, 0)).toEqual([]);
    expect(await log.recent(P, TEXT, 0)).toEqual([]);
    expect(await log.recent(P, place("g1", "nowhere", "channel"), 10)).toEqual([]);
  });

  it("orders decisions of the same time by id, the larger first", async () => {
    const log = await open();
    for (const d of [
      decision("01B", TEXT, "b", 1),
      decision("01A", TEXT, "a", 1),
      decision("01C", TEXT, "c", 1),
    ]) {
      await log.append(d);
    }
    expect(reasons(await log.recent(P, null, 10))).toEqual(["c", "b", "a"]);
    expect(reasons(await log.recent(P, TEXT, 2))).toEqual(["c", "b"]);
  });

  it("gives back each decision as it was appended, a DM's too", async () => {
    const log = await open();
    const dm: DecisionRecord = {
      id: "dm-1",
      profile: P,
      ts: at(1),
      trace: {
        turn: "T1",
        context: DM,
        respond: true,
        score: 0.875,
        reasons: ["被提到了", "direct message"],
      },
    };
    const text = decision("text-1", TEXT, "ambient", 2);
    await log.append(dm);
    await log.append(text);
    expect(await log.recent(P, DM, 10)).toEqual([dm]);
    expect(await log.recent(P, TEXT, 10)).toEqual([text]);
    expect(await log.recent(P, null, 10)).toEqual([text, dm]);
  });

  it("keeps microseconds and normalizes to UTC", async () => {
    const log = await open();
    await log.append({
      ...decision("p1", TEXT, "precise", 0),
      ts: "2026-03-10T12:00:00.123456789Z",
    });
    await log.append({ ...decision("p2", TEXT, "offset", 0), ts: "2026-03-10T20:00:01.5+08:00" });
    expect((await log.recent(P, TEXT, 10)).map((d) => d.ts)).toEqual([
      "2026-03-10T12:00:01.500Z",
      "2026-03-10T12:00:00.123456Z",
    ]);
  });

  it("refuses an id it already has", async () => {
    const log = await open();
    const d = decision("once", TEXT, "once", 1);
    await log.append(d);
    await expect(log.append(d)).rejects.toThrow(/already exists/);
    expect(reasons(await log.recent(P, null, 10))).toEqual(["once"]);
  });

  it("reads every decision since a time, inclusive, newest first, with no cap", async () => {
    const log = await open();
    expect(log.decisionsSince).toBeTypeOf("function");
    for (const d of [
      decision("late", TEXT, "late", 2),
      decision("old", TEXT, "old", 0),
      decision("edge", VOICE, "edge", 1),
    ]) {
      await log.append(d);
    }
    expect(reasons((await log.decisionsSince?.(P, at(1))) ?? [])).toEqual(["late", "edge"]);
    expect(reasons((await log.decisionsSince?.(P, at(0))) ?? [])).toEqual(["late", "edge", "old"]);
    expect(await log.decisionsSince?.(P, at(3))).toEqual([]);
    expect(await log.decisionsSince?.(P, at(2))).toEqual([decision("late", TEXT, "late", 2)]);
  });
});

describe("turn outcomes", () => {
  it("reads the newest first, for every place or one, up to a limit", async () => {
    const log = await open();
    expect(log.appendOutcome).toBeTypeOf("function");
    expect(log.recentOutcomes).toBeTypeOf("function");
    const sent = outcome("T1", TEXT, "sent", 1);
    const silent = outcome("T2", TEXT, "silence", 2);
    const cancelled = outcome("T3", VOICE, "cancelled", 3);
    const dm = outcome("T4", DM, "sent", 4);
    for (const o of [silent, dm, sent, cancelled]) await log.appendOutcome?.(P, o);

    // The record comes back as written.
    expect(await log.recentOutcomes?.(P, null, 10)).toEqual([dm, cancelled, silent, sent]);
    expect(await log.recentOutcomes?.(P, TEXT, 10)).toEqual([silent, sent]);
    expect(await log.recentOutcomes?.(P, VOICE, 1)).toEqual([cancelled]);
    expect(await log.recentOutcomes?.(P, DM, 10)).toEqual([dm]);
    expect(turns(await log.recentOutcomes?.(P, null, 2))).toEqual(["T4", "T3"]);
    expect(await log.recentOutcomes?.(P, null, 0)).toEqual([]);
    expect(await log.recentOutcomes?.(P, OTHER_GUILD, 10)).toEqual([]);
  });

  it("keeps one per turn: writing a turn again replaces it, and moves it with its time", async () => {
    const log = await open();
    const sent = outcome("T1", TEXT, "sent", 1);
    const silent = outcome("T2", TEXT, "silence", 2);
    for (const o of [sent, silent]) await log.appendOutcome?.(P, o);

    // "Decided to reply" became "nothing was sent", at the same time.
    const failed: TurnOutcomeRecord = { ...sent, outcome: { type: "error", error: "timeout" } };
    await log.appendOutcome?.(P, failed);
    expect(await log.recentOutcomes?.(P, TEXT, 10)).toEqual([silent, failed]);

    // Written again later: it is the newest now.
    const later: TurnOutcomeRecord = { ...failed, at: at(5) };
    await log.appendOutcome?.(P, later);
    expect(await log.recentOutcomes?.(P, null, 10)).toEqual([later, silent]);
    expect(await log.outcomesSince?.(P, at(0))).toEqual([later, silent]);
  });

  it("orders outcomes of the same time by turn, the larger first", async () => {
    const log = await open();
    for (const turn of ["T2", "T1", "T3"])
      await log.appendOutcome?.(P, outcome(turn, TEXT, "sent", 1));
    expect(turns(await log.recentOutcomes?.(P, null, 10))).toEqual(["T3", "T2", "T1"]);
    expect(turns(await log.outcomesSince?.(P, at(1)))).toEqual(["T3", "T2", "T1"]);
  });

  it("keeps what a record carries besides the outcome", async () => {
    const log = await open();
    const counted = {
      ...outcome("T1", VOICE, "sent", 1),
      reasoning: "low" as const,
      latency_ms: 812,
      restarts: 1,
      corrections: { claim_held: 2 },
      voice_stages: {
        heard_ms: 120,
        wait_ms: 300,
        decide_ms: 5,
        context_ms: 40,
        prompt_ms: 12,
        first_token_ms: 300,
        held_ms: 0,
        first_sentence_ms: 35,
        speculative: true,
      },
    };
    await log.appendOutcome?.(P, counted);
    expect(await log.recentOutcomes?.(P, VOICE, 10)).toEqual([counted]);
  });

  it("reads every outcome since a time, inclusive, newest first, with no cap", async () => {
    const log = await open();
    expect(log.outcomesSince).toBeTypeOf("function");
    const first = outcome("T1", TEXT, "sent", 0);
    const second = outcome("T2", TEXT, "silence", 1);
    const third = outcome("T3", VOICE, "sent", 2);
    for (const o of [third, first, second]) await log.appendOutcome?.(P, o);
    expect(await log.outcomesSince?.(P, at(1))).toEqual([third, second]);
    expect(await log.outcomesSince?.(P, at(0))).toEqual([third, second, first]);
    expect(await log.outcomesSince?.(P, at(3))).toEqual([]);
  });
});

describe("decisions and outcomes in the data inventory", () => {
  it("counts both under `decisions` and exports them in their old columns", async () => {
    const store = await SqliteStore.open(":memory:");
    stores.push(store);
    const d = decision("d1", TEXT, "replied", 1);
    const o = outcome("T1", TEXT, "sent", 2);
    await store.decisions.append(d);
    await store.decisions.appendOutcome?.(P, o);
    const inventory = await store.profileData.inventory(P);
    const decisions = inventory.categories.find((c) => c.id === "decisions");
    expect(decisions?.count).toBe(2);
    expect(decisions?.parts.map((p) => [p.id, p.count])).toEqual([
      ["decision_log", 1],
      ["turn_outcomes", 1],
    ]);
    expect(decisions?.updated_at).toBe(at(2));

    const backup = await store.profileData.export(P, ["decisions"]);
    expect(backup.categories).toEqual(["decisions"]);
    expect(backup.parts.decision_log).toHaveLength(1);
    expect(backup.parts.decision_log?.[0]).toMatchObject({ id: "d1", ts: at(1), trace: d.trace });
    expect(backup.parts.turn_outcomes).toHaveLength(1);
    expect(backup.parts.turn_outcomes?.[0]).toMatchObject({
      id: "T1",
      ts: at(2),
      outcome: "sent",
      record: o,
    });

    expect(await store.profileData.wipe(P, ["decisions"])).toEqual({
      decision_log: 1,
      turn_outcomes: 1,
    });
    expect(await store.decisions.recent(P, null, 10)).toEqual([]);
    expect(await store.decisions.recentOutcomes?.(P, null, 10)).toEqual([]);
  });
});
