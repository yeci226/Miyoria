// The heart's log events: a change is the owner's and kept forever, evidence takes the session's
// scope and is kept a year; both read back as written and refuse what they do not know.

import { describe, expect, it } from "vitest";
import {
  BUS_EVENTS,
  EventRegistry,
  HEART_LOG_EVENTS,
  HeartChanged,
  HeartEvidence,
  readEventData,
} from "../src/index.js";

describe("heart log events", () => {
  it("are kept as the design says", () => {
    const registry = new EventRegistry().register(...HEART_LOG_EVENTS);
    expect(registry.defaults("heart.changed")).toEqual({ scope: "owner", tier: "keep" });
    expect(registry.defaults("heart.evidence")).toEqual({ scope: null, tier: "long" });
  });

  it("are records of the log, not bus topics", () => {
    const topics = new Set(BUS_EVENTS.map((d) => d.type));
    expect(topics.has("heart.changed")).toBe(false);
    expect(topics.has("heart.evidence")).toBe(false);
  });

  it("read a change back and refuse an unknown field or cause", () => {
    const data = {
      person: "01JZ0000000000000000000000",
      field: "bond",
      delta: 6,
      value_after: 126,
      proposed: 6,
      reason_quote: "他記得我上次說想吃的東西",
      cause: "feel",
    };
    expect(readEventData(HeartChanged, { type: "heart.changed", v: 1, data })).toEqual(data);
    for (const bad of [{ field: "romance" }, { cause: "rule" }, { proposed: undefined }]) {
      expect(() =>
        readEventData(HeartChanged, { type: "heart.changed", v: 1, data: { ...data, ...bad } }),
      ).toThrow();
    }
  });

  it("read evidence back", () => {
    const data = {
      person: "01JZ0000000000000000000000",
      kind: "voice_together",
      detail: "在語音裡待了一小時",
      weight: 60,
      at: "2026-11-17T12:00:00.000Z",
    };
    expect(readEventData(HeartEvidence, { type: "heart.evidence", v: 1, data })).toEqual(data);
    expect(() =>
      readEventData(HeartEvidence, {
        type: "heart.evidence",
        v: 1,
        data: { ...data, kind: "hug" },
      }),
    ).toThrow();
  });
});
