// Module `activity` with the real actuator registry and gate port: her tool is routed through
// the manager after the gate, the manager runs the capability as its task's step (`ctx.task`),
// confirmations come from the bus, and the notice goes back to her turn.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { ToolRegistry } from "@miyoria/tools";
import {
  ActivityManagerKey,
  type ContextKey,
  customEvent,
  type Envelope,
  NOTICE_TOPIC,
  Principals,
  v2Payload,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActivityModule } from "../src/index.js";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN = { platform: "discord", id: "100" };

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

describe("activity module", () => {
  it("routes her game_start through the manager and tells her when it is up", async () => {
    const sup = new Supervisor();
    sups.push(sup);
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({
      services: sup.services,
      tools,
      publish: (e) => sup.bus.publish("actions", e),
      builtins: false,
    });
    sup.services.provide("app", ActuatorRegistryKey, registry);
    const tasks: (string | null)[] = [];
    registry.register(
      defineCapability<{ game?: string | null }>({
        name: "game.start",
        summary: "開始玩遊戲",
        risk: "low",
        args: z.object({ game: z.string().nullish() }),
        permission: null,
        tool: { name: "game_start", description: "玩遊戲。", properties: {} },
        activity: (args) => [
          { type: "start", activity: "game", target: args.game ?? "minecraft", goal: null },
        ],
        async execute(args, ctx) {
          tasks.push(ctx.task ?? null);
          await new Promise((resolve) => setTimeout(resolve, 20));
          sup.bus.publish(
            "game",
            customEvent("game.director.session", {
              state: "started",
              game: args.game ?? "minecraft",
              game_name: "Minecraft",
              context: null,
            }),
          );
          return "她開始玩 Minecraft 了";
        },
      }),
    );
    const notices: Envelope[] = [];
    const sub = sup.bus.subscribe(NOTICE_TOPIC);
    void (async () => {
      for await (const env of sub) notices.push(env);
    })();
    await sup.register(new ActivityModule(), null, true);
    await sup.startAll();
    expect(registry.routesActivity).toBe(true);

    const answer = await tools.get("game_start")?.call(
      {
        turn: "t1",
        context: CTX,
        account: OWEN,
        principal: Principals.user(OWEN, CTX),
        message: { context: CTX, id: "m1" },
        priority: "direct",
        signal: new AbortController().signal,
      },
      {},
    );
    expect(answer).toMatch(/開始玩 Minecraft:開始了\(task/);
    const manager = sup.services.require(ActivityManagerKey);
    expect(manager.snapshot().activity).toMatchObject({ type: "game", phase: "starting" });
    await vi.waitFor(() =>
      expect(manager.snapshot().activity).toMatchObject({ type: "game", phase: "running" }),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toBe(manager.tasks(1)[0]?.id);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(v2Payload(notices[0]?.event as never, NOTICE_TOPIC)).toMatchObject({
      turn: "t1",
      context: CTX,
      ok: true,
      text: "Minecraft 開好了,已經開始玩。",
    });

    await sup.stopAll();
    expect(registry.routesActivity).toBe(false);
  });
});
