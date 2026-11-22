// Pins what `parseMessage` hands the rest of the overlay for every kind of frame, as literal
// objects. These record the behaviour as it was before the feed types came from the contract;
// they must keep passing unchanged.
import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/feed.js";

const frame = (o: unknown): string => JSON.stringify(o);

describe("parseMessage, every message type", () => {
  it("subtitle", () => {
    expect(parseMessage(frame({ type: "subtitle", turn: "t1", text: "你好", final: true }))).toStrictEqual({
      type: "subtitle",
      turn: "t1",
      text: "你好",
      final: true,
    });
    // `turn` may be a number (kept as a string), missing (""), anything else ("")
    expect(parseMessage(frame({ type: "subtitle", turn: 7, text: "a", final: false }))).toStrictEqual({
      type: "subtitle",
      turn: "7",
      text: "a",
      final: false,
    });
    expect(parseMessage(frame({ type: "subtitle", text: "a" }))).toStrictEqual({
      type: "subtitle",
      turn: "",
      text: "a",
      final: false,
    });
    expect(parseMessage(frame({ type: "subtitle", turn: {}, text: "", final: "yes" }))).toStrictEqual({
      type: "subtitle",
      turn: "",
      text: "",
      final: false,
    });
    expect(parseMessage(frame({ type: "subtitle", text: "x".repeat(2100) }))).toMatchObject({ text: "x".repeat(2000) });
    expect(parseMessage(frame({ type: "subtitle", turn: "t" }))).toBeNull();
    expect(parseMessage(frame({ type: "subtitle", text: 5 }))).toBeNull();
  });

  it("emotion", () => {
    expect(parseMessage(frame({ type: "emotion", name: "Happy", intensity: 0.5 }))).toStrictEqual({
      type: "emotion",
      name: "happy",
      intensity: 0.5,
    });
    expect(parseMessage(frame({ type: "emotion", name: " Sad ", intensity: 7 }))).toStrictEqual({
      type: "emotion",
      name: "sad",
      intensity: 1,
    });
    expect(parseMessage(frame({ type: "emotion", name: "x", intensity: -3 }))).toStrictEqual({
      type: "emotion",
      name: "x",
      intensity: 0,
    });
    // missing or non-numeric intensity is full
    expect(parseMessage(frame({ type: "emotion", name: "x" }))).toStrictEqual({ type: "emotion", name: "x", intensity: 1 });
    expect(parseMessage(frame({ type: "emotion", name: "x", intensity: "0.2" }))).toStrictEqual({
      type: "emotion",
      name: "x",
      intensity: 1,
    });
    expect(parseMessage(frame({ type: "emotion", name: "x".repeat(40), intensity: 1 }))).toMatchObject({
      name: "x".repeat(32),
    });
    expect(parseMessage(frame({ type: "emotion", name: "  ", intensity: 1 }))).toBeNull();
    expect(parseMessage(frame({ type: "emotion", intensity: 1 }))).toBeNull();
  });

  it("speaking", () => {
    expect(parseMessage(frame({ type: "speaking", state: "started" }))).toStrictEqual({ type: "speaking", state: "started" });
    expect(parseMessage(frame({ type: "speaking", state: "stopped" }))).toStrictEqual({ type: "speaking", state: "stopped" });
    expect(parseMessage(frame({ type: "speaking", state: "paused" }))).toBeNull();
    expect(parseMessage(frame({ type: "speaking" }))).toBeNull();
  });

  it("status is wrapped, and every missing flag is false", () => {
    expect(
      parseMessage(frame({ type: "status", core: true, vts: false, obs: true, scene: "Main", streaming: true })),
    ).toStrictEqual({
      type: "status",
      status: { core: true, vts: false, obs: true, scene: "Main", streaming: true },
    });
    expect(parseMessage(frame({ type: "status", scene: "  " }))).toStrictEqual({
      type: "status",
      status: { core: false, vts: false, obs: false, scene: null, streaming: false },
    });
    expect(parseMessage(frame({ type: "status", core: "true", scene: 3 }))).toStrictEqual({
      type: "status",
      status: { core: false, vts: false, obs: false, scene: null, streaming: false },
    });
  });

  it("queue (sent by the demo only)", () => {
    expect(parseMessage(frame({ type: "queue", items: ["a", { title: "b", by: "c" }, 5, ""] }))).toStrictEqual({
      type: "queue",
      items: [
        { title: "a", by: null },
        { title: "b", by: "c" },
      ],
    });
    expect(parseMessage(frame({ type: "queue", items: [] }))).toStrictEqual({ type: "queue", items: [] });
    expect(parseMessage(frame({ type: "queue", items: "no" }))).toBeNull();
    expect(parseMessage(frame({ type: "queue" }))).toBeNull();
  });

  it("levels", () => {
    expect(parseMessage(frame({ type: "levels", rms: 0.25, bands: [0.1, 0.2] }))).toStrictEqual({
      type: "levels",
      rms: 0.25,
      bands: [0.1, 0.2],
    });
    expect(parseMessage(frame({ type: "levels", rms: 0.25 }))).toStrictEqual({ type: "levels", rms: 0.25, bands: null });
    expect(parseMessage(frame({ type: "levels", rms: 3, bands: [-1, 2] }))).toStrictEqual({
      type: "levels",
      rms: 1,
      bands: [0, 2],
    });
    expect(parseMessage(frame({ type: "levels", rms: -1, bands: [] }))).toStrictEqual({ type: "levels", rms: 0, bands: null });
    expect(parseMessage(frame({ type: "levels", rms: 0, bands: new Array(32).fill(0.5) }))).toMatchObject({
      bands: new Array(32).fill(0.5),
    });
    // more than 32 bands (the contract's most), or a non-number in them: the bands are dropped, the frame is kept
    expect(parseMessage(frame({ type: "levels", rms: 0.5, bands: new Array(33).fill(0.5) }))).toStrictEqual({
      type: "levels",
      rms: 0.5,
      bands: null,
    });
    expect(parseMessage(frame({ type: "levels", rms: 0.5, bands: [0.1, "x"] }))).toStrictEqual({
      type: "levels",
      rms: 0.5,
      bands: null,
    });
    expect(parseMessage(frame({ type: "levels" }))).toBeNull();
    expect(parseMessage(frame({ type: "levels", rms: "0.5" }))).toBeNull();
  });

  it("notice", () => {
    expect(parseMessage(frame({ type: "notice", text: " 準備歌曲中… " }))).toStrictEqual({
      type: "notice",
      text: "準備歌曲中…",
    });
    expect(parseMessage(frame({ type: "notice", text: "" }))).toStrictEqual({ type: "notice", text: "" });
    expect(parseMessage(frame({ type: "notice", text: "x".repeat(200) }))).toMatchObject({ text: "x".repeat(160) });
    expect(parseMessage(frame({ type: "notice" }))).toBeNull();
  });

  it("activity is re-shaped to camelCase", () => {
    expect(
      parseMessage(
        frame({
          type: "activity",
          kind: "singing",
          label: "唱歌中",
          detail: "春日影",
          progress: 0.4,
          elapsed_ms: 1000,
          duration_ms: 200000,
        }),
      ),
    ).toStrictEqual({
      type: "activity",
      activity: { kind: "singing", label: "唱歌中", detail: "春日影", progress: 0.4, elapsedMs: 1000, durationMs: 200000 },
    });
    expect(
      parseMessage(
        frame({ type: "activity", kind: "thinking", label: "思考中", detail: null, progress: null, elapsed_ms: null, duration_ms: null }),
      ),
    ).toStrictEqual({
      type: "activity",
      activity: { kind: "thinking", label: "思考中", detail: null, progress: null, elapsedMs: null, durationMs: null },
    });
    // kind null hides it; so does an empty label
    expect(parseMessage(frame({ type: "activity", kind: null }))).toStrictEqual({ type: "activity", activity: null });
    expect(parseMessage(frame({ type: "activity", kind: "thinking", label: " " }))).toStrictEqual({
      type: "activity",
      activity: null,
    });
    // optional fields missing, progress clamped, elapsed without a duration dropped, elapsed defaults to 0
    expect(parseMessage(frame({ type: "activity", kind: "x_y", label: "L", progress: 5 }))).toStrictEqual({
      type: "activity",
      activity: { kind: "x_y", label: "L", detail: null, progress: 1, elapsedMs: null, durationMs: null },
    });
    expect(parseMessage(frame({ type: "activity", kind: "singing", label: "L", elapsed_ms: 5 }))).toMatchObject({
      activity: { elapsedMs: null, durationMs: null },
    });
    expect(parseMessage(frame({ type: "activity", kind: "singing", label: "L", duration_ms: 5000 }))).toMatchObject({
      activity: { elapsedMs: 0, durationMs: 5000 },
    });
    expect(parseMessage(frame({ type: "activity", kind: "singing", label: "L", duration_ms: 0 }))).toMatchObject({
      activity: { durationMs: null },
    });
    expect(parseMessage(frame({ type: "activity", kind: "singing", label: "L", duration_ms: 90_000_000 }))).toMatchObject({
      activity: { durationMs: null },
    });
    expect(parseMessage(frame({ type: "activity", kind: "x".repeat(40), label: "L" }))).toBeNull();
    expect(parseMessage(frame({ type: "activity", kind: "Bad Kind", label: "L" }))).toBeNull();
    expect(parseMessage(frame({ type: "activity", kind: 3, label: "L" }))).toBeNull();
    expect(parseMessage(frame({ type: "activity", label: "L" }))).toBeNull();
  });

  it("gift: empty text becomes null", () => {
    expect(parseMessage(frame({ type: "gift", text: " Owen 餵了她一碗白飯 " }))).toStrictEqual({
      type: "gift",
      text: "Owen 餵了她一碗白飯",
    });
    expect(parseMessage(frame({ type: "gift", text: "" }))).toStrictEqual({ type: "gift", text: null });
    expect(parseMessage(frame({ type: "gift" }))).toStrictEqual({ type: "gift", text: null });
    expect(parseMessage(frame({ type: "gift", text: "x".repeat(200) }))).toMatchObject({ text: "x".repeat(160) });
  });

  it("screen", () => {
    expect(parseMessage(frame({ type: "screen", name: "Owen", text: "加油" }))).toStrictEqual({
      type: "screen",
      name: "Owen",
      text: "加油",
    });
    expect(
      parseMessage(frame({ type: "screen", name: "n".repeat(40), text: "t".repeat(300) })),
    ).toMatchObject({ name: "n".repeat(32), text: "t".repeat(200) });
    expect(parseMessage(frame({ type: "screen", name: "A" }))).toBeNull();
  });

  it("touch", () => {
    expect(parseMessage(frame({ type: "touch", x: 0.25, y: 0.5, part: "head" }))).toStrictEqual({
      type: "touch",
      x: 0.25,
      y: 0.5,
      part: "head",
    });
    for (const part of ["face", "body", "screen"]) {
      expect(parseMessage(frame({ type: "touch", x: 0, y: 1, part }))).toStrictEqual({ type: "touch", x: 0, y: 1, part });
    }
    expect(parseMessage(frame({ type: "touch", x: 1.5, y: 0.5, part: "head" }))).toBeNull();
    expect(parseMessage(frame({ type: "touch", x: 0.5, y: -0.1, part: "head" }))).toBeNull();
    expect(parseMessage(frame({ type: "touch", x: 0.5, y: 0.5, part: "leg" }))).toBeNull();
    expect(parseMessage(frame({ type: "touch", x: 0.5, y: 0.5 }))).toBeNull();
  });
});

describe("parseMessage, frames that are not a clean message", () => {
  it("ignores a type it does not know", () => {
    expect(parseMessage(frame({ type: "wave", x: 1 }))).toBeNull();
    expect(parseMessage(frame({ type: "" }))).toBeNull();
    expect(parseMessage(frame({ type: 5 }))).toBeNull();
    expect(parseMessage(frame({ type: "constructor", text: "x" }))).toBeNull();
    expect(parseMessage(frame({ type: "__proto__", text: "x" }))).toBeNull();
    expect(parseMessage(frame({ text: "x" }))).toBeNull();
  });

  it("drops extra keys", () => {
    expect(parseMessage(frame({ type: "speaking", state: "started", extra: 1, more: [2] }))).toStrictEqual({
      type: "speaking",
      state: "started",
    });
    expect(parseMessage(frame({ type: "subtitle", turn: "t", text: "a", final: true, lang: "zh" }))).toStrictEqual({
      type: "subtitle",
      turn: "t",
      text: "a",
      final: true,
    });
    expect(parseMessage(frame({ type: "touch", x: 0.5, y: 0.5, part: "body", who: "v" }))).toStrictEqual({
      type: "touch",
      x: 0.5,
      y: 0.5,
      part: "body",
    });
  });

  it("is null for anything that is not a JSON object", () => {
    for (const text of ["", "{", "not json", "null", "5", '"subtitle"', "[]", '[{"type":"gift"}]', "true"]) {
      expect(parseMessage(text), text).toBeNull();
    }
  });
});
