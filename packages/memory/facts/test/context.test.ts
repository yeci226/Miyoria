// Working Context: a writer only touches its own bucket, state replaces, events are capped, and a
// bucket leaves with its module.

import {
  type BucketWrite,
  type ContextEntry,
  type ContextKey,
  type JsonValue,
  type LogEvent,
  type ObservationBody,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WorkingContextView } from "../src/context.js";

const T0 = Date.UTC(2026, 10, 7, 12);
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

function entry(text: string, context: ContextKey | null = null): ContextEntry {
  return {
    event: text,
    at: toTimestamp(T0),
    text,
    attention_key: `k:${text}`,
    revision: 1,
    context,
    from: null,
    untrusted: false,
    restored: false,
  };
}

function observation(summary: string, buckets: BucketWrite[]): LogEvent {
  const body: ObservationBody = {
    observation: {
      source: "game.minecraft",
      silent: true,
      salience: "ambient",
      attention_key: "game:x",
      revision: 2,
      summary,
      addressed_to_her: false,
      from: "Owen",
      context: VOICE,
    },
    buckets,
    speech: false,
    origin: null,
  };
  return {
    id: "id",
    at: toTimestamp(T0),
    kind: "observation",
    source: "game.minecraft",
    cause: null,
    context: VOICE,
    person: "Owen",
    body: body as unknown as JsonValue,
  };
}

const texts = (ctx: WorkingContextView, writer: string) =>
  ctx.bucket(writer)?.entries.map((e) => e.text);

describe("buckets", () => {
  it("replace-self keeps only the newest state", () => {
    const ctx = new WorkingContextView();
    ctx.replaceSelf("game", "game", entry("血量 20"));
    ctx.replaceSelf("game", "game", entry("血量 12"));
    expect(texts(ctx, "game")).toEqual(["血量 12"]);
    expect(ctx.bucket("game")?.mode).toBe("replace-self");
  });

  it("append-self keeps the newest entries up to the cap", () => {
    const ctx = new WorkingContextView({ maxEntries: 2 });
    for (const t of ["a", "b", "c"]) ctx.appendSelf("events", "game", entry(t));
    expect(texts(ctx, "events")).toEqual(["b", "c"]);
  });

  it("append-self may set a cap of its own", () => {
    const ctx = new WorkingContextView({ maxEntries: 5 });
    for (const t of ["a", "b", "c"]) ctx.appendSelf("events", "game", entry(t), 1);
    expect(texts(ctx, "events")).toEqual(["c"]);
  });

  it("caps the length of an entry", () => {
    const ctx = new WorkingContextView({ maxChars: 4 });
    ctx.replaceSelf("x", null, entry("石頭鎬子做好了"));
    expect(texts(ctx, "x")).toEqual(["石頭鎬…"]);
  });

  it("keeps writers apart", () => {
    const ctx = new WorkingContextView();
    ctx.replaceSelf("a", "m1", entry("1"));
    ctx.replaceSelf("b", "m2", entry("2"));
    ctx.replaceSelf("a", "m1", entry("3"));
    expect(texts(ctx, "b")).toEqual(["2"]);
    expect(ctx.buckets().map((b) => b.writer)).toEqual(["a", "b"]);
  });

  it("a writer that leaves takes its bucket with it", () => {
    const ctx = new WorkingContextView();
    ctx.replaceSelf("a", "m1", entry("1"));
    ctx.leave("a");
    expect(ctx.bucket("a")).toBeNull();
  });

  it("a module that leaves takes all its buckets with it", () => {
    const ctx = new WorkingContextView();
    ctx.replaceSelf("a", "ext.minecraft", entry("1"));
    ctx.appendSelf("b", "ext.minecraft", entry("2"));
    ctx.replaceSelf("c", "voice", entry("3"));
    ctx.leaveOwner("ext.minecraft");
    expect(ctx.buckets().map((b) => b.writer)).toEqual(["c"]);
  });

  it("filters by place, keeping what belongs nowhere", () => {
    const ctx = new WorkingContextView();
    ctx.appendSelf("a", null, entry("voice", VOICE));
    ctx.appendSelf("a", null, entry("text", TEXT));
    ctx.appendSelf("a", null, entry("everywhere"));
    ctx.replaceSelf("b", null, entry("only text", TEXT));
    const here = ctx.buckets(VOICE);
    expect(here.map((b) => b.writer)).toEqual(["a"]);
    expect(here[0]?.entries.map((e) => e.text)).toEqual(["voice", "everywhere"]);
    expect(ctx.buckets(null)[0]?.entries.map((e) => e.text)).toEqual(["everywhere"]);
  });

  it("hands out copies", () => {
    const ctx = new WorkingContextView();
    ctx.replaceSelf("a", null, entry("1"));
    const copy = ctx.bucket("a");
    if (copy?.entries[0]) copy.entries[0].text = "changed";
    expect(texts(ctx, "a")).toEqual(["1"]);
  });
});

describe("as a projection", () => {
  it("folds what an observation says", () => {
    const ctx = new WorkingContextView();
    ctx.apply(
      observation("做好了", [
        { op: "replace-self", writer: "game", owner: "ext.minecraft", untrusted: true },
        { op: "append-self", writer: "log", owner: "ext.minecraft", untrusted: false },
      ]),
    );
    expect(ctx.bucket("game")?.entries[0]).toMatchObject({
      text: "做好了",
      attention_key: "game:x",
      revision: 2,
      from: "Owen",
      context: VOICE,
      untrusted: true,
      restored: false,
    });
    ctx.apply(observation("", [{ op: "leave", writer: "game" }]));
    expect(ctx.bucket("game")).toBeNull();
    ctx.apply(observation("", [{ op: "leave-owner", owner: "ext.minecraft" }]));
    expect(ctx.buckets()).toEqual([]);
  });

  it("marks what it knows as from before a start, until the writer says it again", () => {
    const ctx = new WorkingContextView();
    const write: BucketWrite = {
      op: "replace-self",
      writer: "game",
      owner: null,
      untrusted: false,
    };
    ctx.apply(observation("舊的", [write]));
    ctx.apply(observation("", [{ op: "boot" }]));
    expect(ctx.bucket("game")?.entries[0]?.restored).toBe(true);
    ctx.apply(observation("新的", [write]));
    expect(ctx.bucket("game")?.entries[0]).toMatchObject({ text: "新的", restored: false });
  });

  it("ignores everything else", () => {
    const ctx = new WorkingContextView();
    ctx.apply({ ...observation("x", []), kind: "thought", body: { text: "嗯" } });
    expect(ctx.buckets()).toEqual([]);
  });
});
