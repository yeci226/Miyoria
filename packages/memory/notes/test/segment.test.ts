import { EventCursors, SqliteStore } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import { toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { transcriptTables } from "../../transcript/src/index.js";
import {
  entriesAfter,
  markProcessed,
  nextSegment,
  processedUpTo,
  SEGMENT_CONSUMER,
  segmentsBeforeCompaction,
} from "../src/index.js";
import { AMY, by, entry, MINUTE, OWEN, own, SESSION, T0 } from "./helpers.js";

const at = (minutes: number) => toTimestamp(T0 + minutes * MINUTE);
const said = (seq: number, minute: number, text = `第 ${seq} 句`) => ({
  ...by(seq, OWEN, "Owen", text),
  at: at(minute),
});

describe("nextSegment", () => {
  it("ends a segment at a pause", () => {
    const entries = [said(1, 1), said(2, 2), said(3, 10), said(4, 11)];
    const { segment } = nextSegment(SESSION, entries, 0, at(12));
    expect(segment).toMatchObject({ from: 1, to: 2, ended: "pause" });
    expect(segment?.entries.map((e) => e.seq)).toEqual([1, 2]);
    // The rest is still going on.
    expect(nextSegment(SESSION, entries, 2, at(12)).segment).toBeNull();
    // Once it has been quiet for long enough, it is a segment too.
    expect(nextSegment(SESSION, entries, 2, at(17)).segment).toMatchObject({
      from: 3,
      to: 4,
      ended: "quiet",
    });
  });

  it("ends a segment at the line limit, counting only what people and she said", () => {
    const entries = [
      said(1, 1),
      entry(2, { kind: "note", content: "x", at: at(1) }),
      { ...own(3, "嗯"), at: at(1) },
      said(4, 2),
      said(5, 2),
    ];
    expect(nextSegment(SESSION, entries, 0, at(3), { maxLines: 3 }).segment).toMatchObject({
      from: 1,
      to: 4,
      ended: "lines",
    });
  });

  it("never cuts between a tool call and its result, nor inside a turn", () => {
    const entries = [
      said(1, 1),
      entry(2, {
        kind: "tool_calls",
        tool_calls: [{ id: "c1", name: "x", arguments: "{}" }],
        at: at(1),
        turn: "t1",
      }),
      entry(3, { kind: "tool_result", tool_call_id: "c1", content: "ok", at: at(9), turn: "t1" }),
      { ...own(4, "好了"), at: at(9), turn: "t1" },
      said(5, 20),
    ];
    // The pause after seq 2 falls inside the call and the turn: the cut moves to the turn's end.
    expect(nextSegment(SESSION, entries, 0, at(10)).segment).toMatchObject({
      from: 1,
      to: 4,
      ended: "pause",
    });
  });

  it("skips a stretch nobody said anything in", () => {
    const entries = [
      entry(1, { kind: "note", content: "x", at: at(1) }),
      entry(2, { kind: "note", content: "y", at: at(20) }),
    ];
    expect(nextSegment(SESSION, entries, 0, at(21))).toEqual({ segment: null, skipTo: 1 });
    expect(nextSegment(SESSION, [], 0, at(21))).toEqual({ segment: null, skipTo: null });
  });

  it("leaves out redacted entries", () => {
    const entries = [said(1, 1), { ...said(2, 1), redacted_at: at(2) }];
    expect(nextSegment(SESSION, entries, 0, at(30)).segment?.entries.map((e) => e.seq)).toEqual([
      1,
    ]);
  });
});

describe("segmentsBeforeCompaction", () => {
  it("cuts everything up to the compaction, whether or not the conversation paused", () => {
    const entries = [said(1, 1), said(2, 2), said(3, 30), said(4, 31), said(5, 32), said(6, 33)];
    const segments = segmentsBeforeCompaction(SESSION, entries, 0, 5);
    expect(segments.map((s) => [s.from, s.to, s.ended])).toEqual([
      [1, 2, "pause"],
      [3, 5, "compaction"],
    ]);
    expect(segmentsBeforeCompaction(SESSION, entries, 2, 5).map((s) => [s.from, s.to])).toEqual([
      [3, 5],
    ]);
    expect(segmentsBeforeCompaction(SESSION, entries, 5, 5)).toEqual([]);
    expect(
      segmentsBeforeCompaction(SESSION, entries, 0, 6, { maxLines: 2 }).map((s) => [s.from, s.to]),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });
});

describe("the position of a session", () => {
  it("is kept in event_cursors, only moves forward, and commits with the caller", () => {
    const t = openTestDb();
    try {
      const cursors = new EventCursors(t.db, t.events);
      expect(processedUpTo(cursors, SESSION)).toBe(0);
      expect(markProcessed(cursors, SESSION, 7)).toBe(7);
      expect(markProcessed(cursors, SESSION, 3)).toBe(7);
      expect(processedUpTo(cursors, "other")).toBe(0);
      expect(() =>
        t.db.tx(() => {
          markProcessed(cursors, SESSION, 9);
          throw new Error("the pass failed");
        }),
      ).toThrow(/pass failed/);
      expect(processedUpTo(cursors, SESSION)).toBe(7);
      expect(cursors.list(SEGMENT_CONSUMER)).toEqual([
        expect.objectContaining({ key: SESSION, seq: 7 }),
      ]);
    } finally {
      t.close();
    }
  });

  it("reads what is left of a transcript, compacted or not", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [transcriptTables] });
    try {
      const transcripts = store.plugin(transcriptTables);
      transcripts.append(SESSION, [
        { kind: "other", person_id: OWEN, content: "一" },
        { kind: "other", person_id: AMY, content: "二" },
        { kind: "self", content: "三" },
        { kind: "other", person_id: OWEN, content: "四" },
      ]);
      transcripts.compact(SESSION, 2, "前兩句");
      expect(entriesAfter(transcripts, SESSION, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(entriesAfter(transcripts, SESSION, 3).map((e) => e.content)).toEqual(["四"]);
    } finally {
      await store.close();
    }
  });
});
