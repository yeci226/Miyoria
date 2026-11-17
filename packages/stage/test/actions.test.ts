// The stage capabilities: `stage_scene` as her tool (scenes checked against the node's list),
// `stage.stream` for commands and the panel only.

import { ActuatorRegistry } from "@miyoria/gate/actions";
import { type ToolContext, ToolRegistry } from "@miyoria/llm/tools";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type AccountRef, type ContextKey, Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { defaultStageStatus, type StageLink, type StageStatus } from "../src/index.js";
import { stageCapabilities } from "../src/link/actions.js";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

function setup(scenes: string[]) {
  const calls: string[] = [];
  let status: StageStatus = { ...defaultStageStatus(), obs: true, scene: "Talk", scenes };
  const link = {
    isConnected: () => true,
    status: () => status,
    setScene: async (name: string) => {
      calls.push(`scene ${name}`);
      status = { ...status, scene: name };
      return status;
    },
    stream: async (action: "start" | "stop") => {
      calls.push(`stream ${action}`);
      status = { ...status, streaming: action === "start" };
      return status;
    },
  } as unknown as StageLink;
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({
    services: new ServiceRegistry(),
    tools,
    builtins: false,
  });
  for (const c of stageCapabilities(link)) registry.register(c);
  const ctx: ToolContext = {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal: Principals.self(CTX, OWEN),
    message: { context: CTX, id: "m" },
    priority: "direct",
    signal: new AbortController().signal,
  };
  return { calls, tools, registry, ctx };
}

describe("stage capabilities", () => {
  it("stage_scene switches to reported scenes only", async () => {
    const s = setup(["Talk", "Game", "AFK"]);
    expect(s.tools.names()).toEqual(["stage_scene"]);
    expect(await s.tools.get("stage_scene")?.call(s.ctx, { name: "Game" })).toBe(
      "switched to scene Game",
    );
    await expect(s.tools.get("stage_scene")?.call(s.ctx, { name: "Secret" })).rejects.toThrow(
      /unknown scene `Secret`/,
    );
    expect(s.calls).toEqual(["scene Game"]);
  });

  it("stage.stream is for commands and the panel", async () => {
    const s = setup([]);
    const out = await s.registry.invoke({
      principal: Principals.panel("api"),
      capability: "stage.stream",
      args: { action: "start" },
      why: null,
      turn: null,
    });
    expect(out.status).toBe("done");
    expect(s.calls).toEqual(["stream start"]);
    // Without a scene list any name is passed on.
    expect(await s.tools.get("stage_scene")?.call(s.ctx, { name: "Whatever" })).toContain(
      "Whatever",
    );
  });
});
