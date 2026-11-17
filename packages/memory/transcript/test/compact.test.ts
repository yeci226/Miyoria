// Where a transcript is cut (`pickCut`) and the compaction driven end to end with a stand-in for
// the summarising model (`compactIfNeeded`).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactIdle,
  compactIfNeeded,
  pickCut,
  type Summarise,
  type TranscriptEntry,
  type TranscriptTail,
} from "../src/index.js";
import { called, entries, MINUTE, own, type Rig, ROOM, rig, said } from "./helpers.js";

const tail = (list: TranscriptEntry[]): TranscriptTail => ({
  session: ROOM,
  summary: null,
  entries: list,
});

/** `n` plain lines of 10 tokens each, alternating speakers, no turns. */
const lines = (n: number) =>
  entries(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? said("Owen", `${i}`) : own(`${i}`))));

describe("pickCut", () => {
  it("cuts nothing while the entries are within the threshold", () => {
    expect(pickCut(tail([]), { thresholdTokens: 0, keepTokens: 0 })).toBeNull();
    expect(pickCut(tail(lines(10)), { thresholdTokens: 100, keepTokens: 30 })).toBeNull();
    expect(pickCut(tail(lines(11)), { thresholdTokens: 100, keepTokens: 30 })).toBe(8);
  });

  it("keeps about the newest keepTokens as they are", () => {
    const list = lines(20);
    expect(pickCut(tail(list), { thresholdTokens: 50, keepTokens: 50 })).toBe(15);
    expect(pickCut(tail(list), { thresholdTokens: 50, keepTokens: 55 })).toBe(14);
    // Keep nothing: everything goes into the summary.
    expect(pickCut(tail(list), { thresholdTokens: 50, keepTokens: 0 })).toBe(20);
    // Keep more than there is: there is nothing to cut.
    expect(pickCut(tail(list), { thresholdTokens: 50, keepTokens: 10_000 })).toBeNull();
  });

  it("never cuts inside a turn: it moves back to the turn's start", () => {
    const list = entries([
      said("Owen", "一"),
      own("二"),
      said("Owen", "查一下"),
      ...called("a", "search", "{}", "結果", { turn: "t1" }),
      own("查到了", { turn: "t1" }),
      said("Owen", "謝謝"),
      own("不客氣", { turn: "t2" }),
    ]);
    // Seqs: 1 2 3 | 4 5 6 (t1) | 7 | 8 (t2). Keeping 30 tokens would start at 6, inside t1.
    expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens: 30 })).toBe(3);
    // Keeping 20 starts at 7: a clean place.
    expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens: 20 })).toBe(6);
  });

  it("treats a turn as one piece even when others spoke in the middle of it", () => {
    const [call, result] = called("a", "search", "{}", "結果", { turn: "t1" });
    const list = entries([
      said("Owen", "一"),
      call,
      said("Amy", "插話"),
      result,
      own("好", { turn: "t1" }),
    ]);
    for (const keepTokens of [10, 20, 30, 40]) {
      expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens })).toBe(1);
    }
  });

  it("never parts a call from its result, with or without turn ids", () => {
    const list = entries([
      said("Owen", "一"),
      ...called("a", "search", "{}", "結果"),
      own("二"),
      said("Owen", "三"),
    ]);
    // Keeping 30 would start at the result (3): the cut moves before the call.
    expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens: 30 })).toBe(1);
    expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens: 20 })).toBe(3);
  });

  it("cuts after the first turn when the kept part would start inside it", () => {
    const list = entries([
      ...called("a", "search", "{}", "結果", { turn: "t1" }),
      own("好", { turn: "t1" }),
      said("Owen", "一"),
      said("Owen", "二"),
    ]);
    // Keeping 40 starts at 2, inside t1, and nothing before it can be cut: the first clean
    // place after it is the end of the turn.
    expect(pickCut(tail(list), { thresholdTokens: 10, keepTokens: 40 })).toBe(3);
    // One turn and nothing else: no cut at all short of everything.
    const one = entries([...called("a", "search", "{}", "結果", { turn: "t1" })]);
    expect(pickCut(tail(one), { thresholdTokens: 10, keepTokens: 10 })).toBe(2);
  });
});

describe("compactIfNeeded", () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.store.close();
  });
  async function open() {
    const r = await rig();
    rigs.push(r);
    return r;
  }
  const budget = { thresholdTokens: 50, keepTokens: 20 };

  it("does nothing under the threshold, and never calls the model", async () => {
    const { t } = await open();
    t.append(ROOM, [said("Owen", "嗨", { tokens: 10 }), own("嗨", { tokens: 10 })]);
    const summarise = vi.fn<Summarise>();
    expect(await compactIfNeeded(t, ROOM, { ...budget, summarise })).toBeNull();
    expect(await compactIfNeeded(t, "nowhere", { ...budget, summarise })).toBeNull();
    expect(summarise).not.toHaveBeenCalled();
  });

  it("summarises the oldest part with the summary before it, and keeps the rest", async () => {
    const { t } = await open();
    const ten = { tokens: 10 };
    t.append(ROOM, [
      said("Owen", "一", ten),
      own("二", ten),
      said("Owen", "三", ten),
      ...called("a", "search", "{}", "結果", { ...ten, turn: "t1" }),
      own("六", { ...ten, turn: "t1" }),
      said("Owen", "七", ten),
    ]);
    const summarise = vi.fn<Summarise>(
      async (old, previous) => `${previous ?? "無"}+${old.length}`,
    );
    const first = await compactIfNeeded(t, ROOM, { ...budget, summarise, turn: "t2" });
    // Keeping 20 would start at 6, inside t1: the cut is before the turn.
    expect(first).toMatchObject({ upto_seq: 3, summary: "無+3", turn: "t2", tokens_replaced: 30 });
    expect(summarise.mock.calls[0]?.[0].map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(t.tail(ROOM).entries.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    // 40 tokens left: under the threshold.
    expect(await compactIfNeeded(t, ROOM, { ...budget, summarise })).toBeNull();

    t.append(ROOM, [own("八", ten), said("Owen", "九", ten)]);
    const second = await compactIfNeeded(t, ROOM, { ...budget, summarise });
    expect(second).toMatchObject({ upto_seq: 7, summary: "無+3+4" });
    expect(summarise).toHaveBeenCalledTimes(2);
    expect(t.summaries(ROOM).map((s) => s.summary)).toEqual(["無+3+4", "無+3"]);
    expect(t.tail(ROOM).entries.map((e) => e.seq)).toEqual([8, 9]);
  });

  it("makes a stale summary again from the covered entries, without the old text", async () => {
    const { t } = await open();
    t.append(ROOM, [said("Owen", "祕密", { message_id: "m1" }), own("好"), said("Owen", "之後")]);
    t.compact(ROOM, 2, "Owen 說了祕密");
    t.redactMessage("m1");
    const summarise = vi.fn<Summarise>(async (old) => old.map((e) => e.content || "∅").join("/"));
    const again = await compactIfNeeded(t, ROOM, { ...budget, summarise });
    expect(summarise).toHaveBeenCalledWith(expect.any(Array), null);
    expect(again).toMatchObject({ upto_seq: 2, summary: "∅/好", stale: false });
    expect(t.tail(ROOM).summary?.summary).toBe("∅/好");
    expect(t.tail(ROOM).entries.map((e) => e.seq)).toEqual([3]);
  });

  it("keeps what was appended while the model was writing, and drops a summary that lost a race", async () => {
    const { t } = await open();
    const ten = { tokens: 10 };
    t.append(
      ROOM,
      Array.from({ length: 8 }, (_, i) => said("Owen", `${i + 1}`, ten)),
    );
    const slow: Summarise = async (old) => {
      t.append(ROOM, [said("Owen", "寫摘要的時候說的", ten)]);
      return `摘要(${old.length})`;
    };
    expect(await compactIfNeeded(t, ROOM, { ...budget, summarise: slow })).toMatchObject({
      upto_seq: 6,
    });
    expect(t.tail(ROOM).entries.map((e) => e.seq)).toEqual([7, 8, 9]);

    t.append(
      ROOM,
      Array.from({ length: 4 }, (_, i) => said("Owen", `再${i}`, ten)),
    );
    const raced: Summarise = async () => {
      t.compact(ROOM, 8, "別人先做了");
      return "來不及";
    };
    expect(await compactIfNeeded(t, ROOM, { ...budget, summarise: raced })).toBeNull();
    expect(t.tail(ROOM).summary?.summary).toBe("別人先做了");
  });
});

describe("compactIdle", () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.store.close();
  });
  const budget = { thresholdTokens: 50, keepTokens: 20 };
  const grow = (t: Rig["t"], session: string, lines: number) =>
    t.append(
      session,
      Array.from({ length: lines }, (_, i) => said("Owen", `${i}`, { tokens: 10 })),
      { context: null },
    );

  it("compacts only the sessions that are idle and over the threshold", async () => {
    const r = await rig();
    rigs.push(r);
    grow(r.t, "quiet", 10);
    grow(r.t, "small", 2);
    r.clock.tick(2 * 60 * MINUTE);
    grow(r.t, "busy", 10);
    const summarise = vi.fn<Summarise>(async () => "摘要");
    const done = await compactIdle(r.t, {
      ...budget,
      summarise,
      idleMs: 30 * MINUTE,
      now: r.clock.now(),
    });
    expect(done).toEqual(["quiet"]);
    expect(r.t.tail("quiet").summary?.summary).toBe("摘要");
    expect(r.t.tail("busy").summary).toBeNull();
    expect(r.t.tail("small").summary).toBeNull();
    // Again: nothing is over the threshold any more.
    expect(
      await compactIdle(r.t, { ...budget, summarise, idleMs: 30 * MINUTE, now: r.clock.now() }),
    ).toEqual([]);
  });

  it("goes on with the other sessions when one fails", async () => {
    const r = await rig();
    rigs.push(r);
    grow(r.t, "a", 10);
    grow(r.t, "b", 10);
    r.clock.tick(60 * MINUTE);
    const failed: string[] = [];
    const summarise: Summarise = async (_old, _previous) => {
      if (r.t.tail("a").summary === null && failed.length === 0) throw new Error("down");
      return "摘要";
    };
    const done = await compactIdle(r.t, {
      ...budget,
      summarise,
      idleMs: 30 * MINUTE,
      now: r.clock.now(),
      failed: (session) => failed.push(session),
    });
    expect(failed).toHaveLength(1);
    expect(done).toHaveLength(1);
  });
});
