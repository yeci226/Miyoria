import type { Tool } from "@miyoria/llm/tools";
import { describe, expect, it } from "vitest";
import { ReactTool, ToolArgumentError, ToolRegistry, truncate } from "../src/index.js";

const named = (name: string): Tool => ({
  spec: { name, description: "test", parameters: { type: "object" } },
  call: async () => "ok",
});

describe("tools", () => {
  it("register_and_unregister", () => {
    const reg = new ToolRegistry();
    expect(reg.isEmpty).toBe(true);
    reg.register(named("b_tool"));
    reg.register(named("a-tool"));
    reg.register(named("a-tool"));
    expect(() => reg.register(named("bad name"))).toThrow();
    expect(() => reg.register(named(""))).toThrow();
    expect(reg.names()).toEqual(["a-tool", "b_tool"]);
    expect(reg.specs().length).toBe(2);
    expect(reg.get("a-tool")).toBeDefined();
    expect(reg.unregister("a-tool")).toBe(true);
    expect(reg.unregister("a-tool")).toBe(false);
    expect(reg.names()).toEqual(["b_tool"]);
  });
});

describe("turn", () => {
  it("truncates_tool_results", () => {
    expect(truncate("短", 5)).toBe("短");
    expect(truncate("一二三四五六", 3)).toBe("一二三…");
  });
});

describe("react", () => {
  const context = { platform: "discord", scope: "g", channel: "100", kind: "channel" } as const;
  function tool() {
    const actions: { payload: { type: string; message?: { id: string } } }[] = [];
    const sink = { submit: async (a: (typeof actions)[number]) => void actions.push(a) };
    const react = new ReactTool({ services: { require: () => sink } } as never);
    return { react, actions };
  }
  const ctx = (message: string) =>
    ({
      turn: "01M7TURNULID",
      context,
      message: { context, id: message },
      priority: "direct",
    }) as never;

  it("reacts to the message that woke her", async () => {
    const { react, actions } = tool();
    expect(await react.call(ctx("112233445566778899"), { emoji: "👍" })).toBe("reacted with 👍");
    expect(actions.map((a) => a.payload)).toEqual([
      { type: "react", message: { context, id: "112233445566778899" }, emoji: "👍" },
    ]);
  });

  // Core's log on text lanes for days: `invalid Discord message id 01M7…`, "action failed": on a
  // glance or a timer the message is the turn's placeholder, whose id is the turn's own ULID.
  it("refuses, sending nothing, when no message woke the turn", async () => {
    const { react, actions } = tool();
    await expect(react.call(ctx("01M7TURNULID"), { emoji: "👍" })).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    expect(actions).toEqual([]);
  });
});
