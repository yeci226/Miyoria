// The bus check: what tests publish is held to the registered payload schemas.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BusCheck,
  BusCheckError,
  busCheckMode,
  checkBusEvent,
  formatBusCheckSummary,
  mergeBusCheckReports,
} from "../src/bus-check.js";
import { defineEvent, EventRegistry } from "../src/registry.js";

const Ping = defineEvent({
  type: "test.ping",
  v: 1,
  data: z.object({ n: z.number(), note: z.string().optional(), tags: z.array(z.string()) }),
});
const Steps = defineEvent({
  type: "test.steps.*",
  v: 1,
  data: z.object({ step: z.string(), extra: z.record(z.string(), z.number()).optional() }),
});
const registry = () => new EventRegistry().register(Ping, Steps);

const place = { file: "test/x.test.ts", test: "does a thing" };

describe("busCheckMode", () => {
  it("is off unless asked for, and reads the three modes", () => {
    expect(busCheckMode(undefined)).toBe("off");
    expect(busCheckMode("")).toBe("off");
    expect(busCheckMode("report")).toBe("report");
    expect(busCheckMode("off")).toBe("off");
    expect(busCheckMode(" Strict ")).toBe("strict");
    expect(() => busCheckMode("loud")).toThrow("MIYORIA_BUS_CHECK=loud");
  });
});

describe("checkBusEvent", () => {
  it("passes a payload that fits", () => {
    const check = checkBusEvent(registry(), "test.ping", { n: 1, tags: ["a"] });
    expect(check).toEqual({ governedBy: "test.ping", problems: [], undefinedAt: [] });
  });

  it("says a topic nobody registered is unregistered", () => {
    expect(checkBusEvent(registry(), "test.pong", {}).problems).toEqual([{ kind: "unregistered" }]);
  });

  it("checks a topic built from parts against its family", () => {
    const check = checkBusEvent(registry(), "test.steps.one.two", { step: 1 });
    expect(check.governedBy).toBe("test.steps.*");
    expect(check.problems).toEqual([
      { kind: "invalid", path: "step", message: expect.stringContaining("string") },
    ]);
  });

  it("names the first failing path", () => {
    const check = checkBusEvent(registry(), "test.ping", { n: 1, tags: ["a", 2] });
    expect(check.problems).toEqual([
      { kind: "invalid", path: "tags[1]", message: expect.any(String) },
    ]);
  });

  it("reports keys the schema would drop", () => {
    const check = checkBusEvent(registry(), "test.ping", { n: 1, tags: [], who: "x", why: null });
    expect(check.problems).toEqual([
      { kind: "unknown_key", path: "who" },
      { kind: "unknown_key", path: "why" },
    ]);
    // A record keeps every key.
    const steps = checkBusEvent(registry(), "test.steps.x", { step: "a", extra: { k: 1 } });
    expect(steps.problems).toEqual([]);
  });

  it("reports what JSON cannot carry, and notes properties set to undefined", () => {
    class Thing {
      n = 1;
    }
    const payload = {
      n: 1,
      tags: [],
      note: undefined,
      at: new Date(0),
      seen: new Map(),
      thing: new Thing(),
      run: () => 1,
      big: Number.POSITIVE_INFINITY,
      list: [undefined],
    };
    const check = checkBusEvent(registry(), "test.ping", payload);
    expect(check.undefinedAt).toEqual(["note"]);
    const notJson = check.problems.filter((p) => p.kind === "not_json");
    expect(notJson).toEqual([
      { kind: "not_json", path: "at", what: "Date" },
      { kind: "not_json", path: "seen", what: "Map" },
      { kind: "not_json", path: "thing", what: "instance of Thing" },
      { kind: "not_json", path: "run", what: "function" },
      { kind: "not_json", path: "big", what: "Infinity" },
      { kind: "not_json", path: "list[0]", what: "undefined in an array (JSON makes it null)" },
    ]);
  });

  it("finds a cycle without looping", () => {
    const payload: Record<string, unknown> = { n: 1, tags: [] };
    payload.self = payload;
    const check = checkBusEvent(registry(), "test.ping", payload);
    expect(check.problems).toContainEqual({ kind: "not_json", path: "self", what: "a cycle" });
  });
});

describe("BusCheck", () => {
  it("collects topics, sources and findings, counting repeats", () => {
    const check = new BusCheck(registry(), "report");
    check.published({ topic: "test.ping", source: "a", payload: { n: 1, tags: [] } }, place);
    check.published({ topic: "test.ping", source: "b", payload: { n: 2, tags: [] } }, place);
    check.published({ topic: "nope", source: "a", payload: {} }, place);
    check.published({ topic: "nope", source: "a", payload: {} }, place);
    check.endTest();
    const report = check.report();
    expect(report.events).toBe(4);
    expect(report.topics["test.ping"]).toMatchObject({ count: 2, sources: ["a", "b"] });
    expect(report.topics.nope).toMatchObject({ count: 2, governedBy: null });
    expect(report.findings).toEqual([
      { kind: "unregistered", topic: "nope", source: "a", ...place, count: 2 },
    ]);
  });

  it("fails the test in strict mode, with the topic, the path and the publisher", () => {
    const check = new BusCheck(registry(), "strict");
    check.published({ topic: "test.ping", source: "voice", payload: { n: "1", tags: [] } }, place);
    check.published({ topic: "test.pong", source: "agent", payload: {} }, place);
    let error: unknown;
    try {
      check.endTest();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BusCheckError);
    const message = (error as Error).message;
    expect(message).toContain("`test.ping` from voice: invalid at n:");
    expect(message).toContain("`test.pong` from agent: unregistered topic");
    expect(message).toContain("test/x.test.ts: does a thing");
    // The next test starts clean.
    check.published({ topic: "test.ping", source: "voice", payload: { n: 1, tags: [] } }, place);
    expect(() => check.endTest()).not.toThrow();
  });

  it("does not fail anything in report mode", () => {
    const check = new BusCheck(registry(), "report");
    check.published({ topic: "test.pong", source: "agent", payload: {} }, place);
    expect(() => check.endTest()).not.toThrow();
  });
});

describe("reports", () => {
  it("merge across files and print one summary", () => {
    const a = new BusCheck(registry(), "report");
    a.published({ topic: "test.ping", source: "a", payload: { n: 1, tags: [] } }, place);
    a.published({ topic: "nope", source: "a", payload: {} }, place);
    const b = new BusCheck(registry(), "report");
    b.published({ topic: "nope", source: "b", payload: {} }, { file: "y", test: null });
    b.published({ topic: "test.ping", source: "b", payload: { n: 1, tags: [], x: 1 } }, place);
    const merged = mergeBusCheckReports([a.report(), b.report()]);
    expect(merged.events).toBe(4);
    expect(merged.topics["test.ping"]?.sources).toEqual(["a", "b"]);
    const summary = formatBusCheckSummary(merged, { mode: "report", project: "packages/x" });
    expect(summary).toBe(
      [
        "bus check (report) packages/x: 4 event(s) on 2 topic(s), 3 problem(s):",
        "  unregistered topics:",
        "    `nope` from a, b [2x]",
        "  keys the schema does not have:",
        "    `test.ping` from b: the schema has no x (test/x.test.ts: does a thing)",
      ].join("\n"),
    );
  });

  it("say so in one line when everything fits", () => {
    const a = new BusCheck(registry(), "report");
    a.published({ topic: "test.ping", source: "a", payload: { n: 1, tags: [] } }, place);
    expect(formatBusCheckSummary(a.report(), { mode: "strict", project: "p" })).toBe(
      "bus check (strict) p: 1 event(s) on 1 topic(s), every payload fits its schema",
    );
  });
});
