// Tool calls that only look run side by side; anything that changes something runs alone, in the
// order the model gave, and every result goes back in call order.

import { MockProvider } from "@miyoria/llm";
import type { Tool } from "@miyoria/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolBatches } from "../src/util.js";
import { channel, Harness, incoming, noCheck, stopHarnesses } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

describe("toolBatches", () => {
  const ro = (c: string) => c.startsWith("r");
  it("groups runs of read-only calls and keeps every other call alone", () => {
    expect(toolBatches([], ro)).toEqual([]);
    expect(toolBatches(["r1", "r2"], ro)).toEqual([["r1", "r2"]]);
    expect(toolBatches(["w1", "w2"], ro)).toEqual([["w1"], ["w2"]]);
    expect(toolBatches(["r1", "r2", "w1", "r3", "w2", "w3", "r4", "r5"], ro)).toEqual([
      ["r1", "r2"],
      ["w1"],
      ["r3"],
      ["w2"],
      ["w3"],
      ["r4", "r5"],
    ]);
  });
});

/** A tool that logs when it starts and ends, and answers its own name. */
function logged(name: string, log: string[], delay: number, readOnly: boolean): Tool {
  return {
    spec: { name, description: "test", parameters: { type: "object" } },
    readOnly,
    async call() {
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      log.push(`end ${name}`);
      return `${name} result`;
    },
  };
}

describe("tool calls in one step", () => {
  it("run side by side when they only look, alone otherwise, results in call order", async () => {
    const call = (index: number, name: string) => ({
      type: "tool_call_delta" as const,
      index,
      id: `c${index}`,
      name,
      arguments: "{}",
    });
    const mock = new MockProvider("chat")
      .events([
        call(0, "look_a"),
        call(1, "look_b"),
        call(2, "act"),
        call(3, "look_c"),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好了");
    const log: string[] = [];
    const tools = [
      logged("look_a", log, 1000, true),
      logged("look_b", log, 500, true),
      logged("act", log, 100, false),
      logged("look_c", log, 100, true),
    ];
    const h = await Harness.build("always", noCheck(), mock, null, { tools });
    h.say(incoming(channel("c"), "Owen", "幫我查一下"));
    await vi.advanceTimersByTimeAsync(5000);

    expect(log).toEqual([
      "start look_a",
      "start look_b",
      "end look_b",
      "end look_a",
      "start act",
      "end act",
      "start look_c",
      "end look_c",
    ]);
    const second = mock.requests()[1];
    const results = (second?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => [m.tool_call_id, m.content]);
    expect(results).toEqual([
      ["c0", "look_a result"],
      ["c1", "look_b result"],
      ["c2", "act result"],
      ["c3", "look_c result"],
    ]);
  });

  it("run one at a time when none says it only looks", async () => {
    const mock = new MockProvider("chat")
      .events([
        { type: "tool_call_delta", index: 0, id: "c0", name: "one", arguments: "{}" },
        { type: "tool_call_delta", index: 1, id: "c1", name: "two", arguments: "{}" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好了");
    const log: string[] = [];
    const tools = [logged("one", log, 500, false), logged("two", log, 100, false)];
    const h = await Harness.build("always", noCheck(), mock, null, { tools });
    h.say(incoming(channel("c"), "Owen", "幫我做兩件事"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(["start one", "end one", "start two", "end two"]);
  });
});
