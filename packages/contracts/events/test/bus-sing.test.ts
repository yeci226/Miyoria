// The song topics: their tiers and scopes, and payloads as their publisher builds them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["sing.cue", null, "ambient"],
    ["sing.prepare", null, "ambient"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("the three cues", () => {
    expect(
      problems("sing.cue", {
        state: "started",
        song: "s1",
        title: "A song",
        video: "D:/songs/s1.mp4",
        offset_ms: 0,
        duration_ms: 180000,
        beats: { bpm: 120, times_ms: [500, 1000] },
      }),
    ).toEqual([]);
    expect(problems("sing.cue", { state: "started", song: "s1", title: "" })).toEqual([]);
    expect(problems("sing.cue", { state: "line", song: "s1", index: 3, text: "" })).toEqual([]);
    expect(problems("sing.cue", { state: "ended", song: "s1", outcome: "done" })).toEqual([]);
    expect(problems("sing.cue", { state: "paused", song: "s1" })).not.toEqual([]);
  });

  it("what is being prepared, and nothing", () => {
    expect(
      problems("sing.prepare", {
        no: 2,
        title: "",
        stage: "download",
        progress: 0.4,
        exclusive: null,
      }),
    ).toEqual([]);
    expect(
      problems("sing.prepare", { no: null, title: "", stage: "", progress: 0, exclusive: null }),
    ).toEqual([]);
  });
});
