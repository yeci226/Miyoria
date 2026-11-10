// Steer against the real rules and the real gate (§10.6 rule 5): the goal is checked as it would be
// after the patch, so a steer cannot turn an allowed task into a forbidden one.

import { defineCapability } from "@miyoria/actions";
import { ActivityConfigSchema, ActivityService, GatePort } from "@miyoria/activity";
import {
  customEvent,
  type Event,
  type JsonObject,
  newEnvelope,
  newId,
  Principals,
  type RegisteredTaskExecutor,
  type SteerReceipt,
  TaskExecutorsKey,
  type TaskSteer,
  taskTopic,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CTX, closeStores, ownerRule, type World, world } from "./helpers.js";

afterEach(closeStores);

const OWNER_ID = "game.minecraft";

interface Desk {
  w: World;
  service: ActivityService;
  /** What reached the executor. */
  steers: TaskSteer[];
  steer(patch: JsonObject): Promise<SteerReceipt>;
}

async function desk(): Promise<Desk> {
  const w = await world();
  const steers: TaskSteer[] = [];
  const executor = {
    info: { owner: OWNER_ID, name: "Minecraft", goals: [], guide: null },
    steer: async (s: TaskSteer) => {
      steers.push(s);
    },
  } as unknown as RegisteredTaskExecutor;
  w.services.provide("ext", TaskExecutorsKey, {
    get: (owner) => (owner === OWNER_ID ? executor : undefined),
    list: () => [executor],
  });
  // `game.act` with a steer hands it to the executor, as the real capability does.
  w.registry.register(
    defineCapability({
      name: "game.act",
      summary: "在遊戲裡做事",
      risk: "low",
      args: z.looseObject({ game: z.string() }),
      permission: null,
      async execute(args) {
        const steer = (args as { steer?: TaskSteer }).steer;
        if (steer !== undefined) await executor.steer?.(steer);
        return { text: "ok", data: null };
      },
    }),
  );
  const events: Event[] = [];
  let service!: ActivityService;
  service = new ActivityService({
    port: new GatePort(w.services),
    services: w.services,
    clock: { now: w.now },
    config: ActivityConfigSchema.parse({}),
    publish: (e) => {
      events.push(e);
      queueMicrotask(() => service.observe(newEnvelope("activity", e)));
    },
  });
  // A running task that gets ore, as the executor told it.
  service.track(OWNER_ID, { id: "t1", goal: "obtain", args: { item: "iron" }, budget_s: 240 });
  service.observe(
    newEnvelope(
      "ext",
      customEvent(taskTopic(OWNER_ID, "started"), {
        type: "started",
        task: "t1",
        goal: "obtain",
        at: toTimestamp(w.now()),
      }),
    ),
  );
  return {
    w,
    service,
    steers,
    steer: (patch) =>
      service.steer({
        owner: OWNER_ID,
        principal: Principals.self(CTX),
        steer: { id: newId(), task: "t1", patch, why: "主線判斷", cause: "e1" },
      }),
  };
}

describe("a steer", () => {
  it("that patches an allowed goal into a denied one is refused before the executor", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不要挖鑽石", activity: "diamond" });
    const receipt = await d.steer({ item: "diamond_ore" });
    expect(receipt).toMatchObject({ status: "rejected", reason: "rule" });
    if (receipt.status === "rejected") expect(receipt.detail).toContain("不要挖鑽石");
    expect(d.steers).toEqual([]);
  });

  it("cannot hide the word in a new key, a nested value or another spelling", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不要挖鑽石", activity: "diamond" });
    const hidden: JsonObject[] = [
      { goal: "DIAMOND" },
      { plan: { steps: [{ item: "Dia mond" }] } },
      { ｄｉａｍｏｎｄ: true },
      { target: "dia\u200bmond_ore" },
    ];
    for (const patch of hidden) {
      const receipt = await d.steer(patch);
      expect(receipt, JSON.stringify(patch)).toMatchObject({ status: "rejected", reason: "rule" });
    }
    expect(d.steers).toEqual([]);
  });

  it("that stays inside the rules goes through, and keeps the task", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不要挖鑽石", activity: "diamond" });
    expect(await d.steer({ item: "gold" })).toMatchObject({ status: "accepted" });
    expect(d.steers).toHaveLength(1);
  });

  it("of a game the owner forbade is refused whatever it asks for", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    expect(await d.steer({ item: "gold" })).toMatchObject({ status: "rejected", reason: "rule" });
    expect(d.steers).toEqual([]);
  });

  it("is stopped by a rule on starting the game or on acting in it", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不准開遊戲", capability: "game.start" });
    expect(await d.steer({ item: "gold" })).toMatchObject({ status: "rejected", reason: "rule" });
  });

  it("cannot wait for an approval: require_approval refuses it", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "挖金子要先問", activity: "gold" }, "require_approval");
    expect(await d.steer({ item: "gold" })).toMatchObject({ status: "rejected", reason: "rule" });
    expect(d.steers).toEqual([]);
  });

  it("fails closed when the store cannot answer", async () => {
    const d = await desk();
    d.w.flaky.fail = true;
    const receipt = await d.steer({ item: "gold" });
    expect(receipt).toMatchObject({ status: "rejected", reason: "rule" });
    if (receipt.status === "rejected") expect(receipt.detail).toContain("讀不到規則");
    expect(d.steers).toEqual([]);
  });

  it("a rule added after the steer's own check still meets the gate", async () => {
    const d = await desk();
    await ownerRule(d.w, { text: "不要挖鑽石", activity: "diamond" });
    // What the gate sees of a steer that went around the desk.
    const outcome = await d.w.registry.invoke({
      principal: Principals.self(CTX),
      capability: "game.act",
      args: {
        game: "minecraft",
        call: { action: "obtain", args: { item: "diamond_ore" } },
        steer: { id: "s1", task: "t1", patch: { item: "diamond_ore" }, why: "x", cause: "e" },
      },
      why: null,
      turn: null,
    });
    expect(outcome).toMatchObject({ status: "denied", decision: { stage: "directive" } });
  });
});
