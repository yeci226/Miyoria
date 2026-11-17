// A capability in the tool registry: one entry that runs through the gate, with the gate's
// refusal as a value.

import type { ToolContext } from "@miyoria/llm/tools";
import { type Principal, Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionDeniedError, CapabilityTool, defineCapability } from "../src/index.js";
import { CTX, decisions, gate, OWEN } from "./helpers.js";

function toolCtx(principal: Principal): ToolContext {
  return {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal,
    message: { context: CTX, id: "m1" },
    priority: "direct",
    signal: new AbortController().signal,
  };
}

const user = () => toolCtx(Principals.user(OWEN, CTX));

describe("a capability as a registry entry", () => {
  it("carries what its tool says it does and the capability's risk", async () => {
    const g = await gate();
    g.registry.register(
      defineCapability({
        name: "t.sing",
        summary: "唱歌",
        risk: "medium",
        args: z.object({}),
        permission: null,
        tool: {
          name: "t_sing",
          description: "唱。",
          properties: {},
          meta: { effect: "act", speed: "long", group: "sing" },
        },
        execute: async () => "ok",
      }),
    );
    const entry = g.tools.entry("t_sing");
    expect(entry?.tool).toBeInstanceOf(CapabilityTool);
    expect(entry).toMatchObject({
      effect: "act",
      speed: "long",
      risk: "medium",
      group: "sing",
      core: false,
      declared: true,
      schema: null,
    });
    // One that says nothing gets the registry's defaults; the gate still uses its own risk.
    expect(g.tools.entry("t_high")).toMatchObject({ declared: false, risk: "medium" });
    expect(g.registry.get("t.high")?.risk).toBe("high");
  });

  it("gives a refusal as a code, the stage and the text she would see", async () => {
    const g = await gate();
    // Owen has no permission for it: `call` throws, `run` answers.
    const thrown = await g.tools
      .get("t_low")
      ?.call(user(), { note: "a" })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ActionDeniedError);
    const refused = await g.tools.run("t_low", user(), { note: "a" });
    expect(refused).toEqual({
      ok: false,
      code: "denied",
      stage: "permission",
      text: (thrown as ActionDeniedError).message,
    });
    expect(refused.text).toMatch(/^not allowed: /);

    await g.registry.setPaused(true);
    expect(await g.tools.run("t_low", user(), { note: "a", on_own: true })).toMatchObject({
      ok: false,
      code: "denied",
      stage: "pause",
    });
    await g.registry.setPaused(false);

    expect(await g.tools.run("t_low", user(), { note: 5, on_own: true })).toMatchObject({
      ok: false,
      code: "denied",
      stage: "args",
    });
    // Every refusal was decided and recorded by the gate, as with `call`.
    expect(decisions(g.events).map((d) => d.stage)).toEqual([
      "permission",
      "permission",
      "pause",
      "args",
    ]);
  });

  it("gives what ran as text, and an executor's failure as `failed`", async () => {
    const g = await gate();
    expect(await g.tools.run("t_low", user(), { note: "a", on_own: true, why: "想" })).toEqual({
      ok: true,
      text: "ran t.low: a",
    });
    expect(g.runs).toEqual(["t.low"]);

    g.registry.register(
      defineCapability({
        name: "t.broken",
        summary: "壞掉的",
        risk: "low",
        args: z.object({}),
        permission: null,
        tool: { name: "t_broken", description: "壞。", properties: {} },
        execute: async () => {
          throw new Error("the device is off");
        },
      }),
    );
    expect(await g.tools.run("t_broken", user(), {})).toMatchObject({
      ok: false,
      code: "failed",
      stage: null,
    });
    await expect(g.tools.get("t_broken")?.call(user(), {})).rejects.toThrow();
  });
});
