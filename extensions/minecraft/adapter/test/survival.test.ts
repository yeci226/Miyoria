// What a task changed, exploring, night and death (docs/design/v4-plan.md §11.2 items 3 and 7),
// against the fake mod. Each test is one cause of 2026-11-08: an empty mine and a timed-out
// explore that counted as done, nothing for the night, nothing after a death.

import type { GameEvent, TaskEvent, TaskSpec } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { exploreOutcome, inventoryDelta, outcomeOf, sightings } from "../src/progress.js";
import type { Snapshot } from "../src/summary.js";
import { bedOf, isNight, roofAims, roofBlock } from "../src/survival.js";
import { FakeMod, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

/** A tiny world behind the fake mod: `observe` answers with `world`, requests may change it. */
async function setup(
  world: Snapshot,
  onRequest: (req: Record<string, unknown>, m: FakeMod) => void = () => {},
) {
  mod = await FakeMod.start();
  const m = mod;
  m.respond = (req) => {
    if (req.type === "observe") return { ok: true, data: structuredClone(world) };
    onRequest(req, m);
    return { ok: true, data: req.type === "place" ? { item: req.item, position: { x: 1, y: 64, z: 0 } } : {} };
  };
  bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20, requestTimeoutMs: 500 });
  const adapter = new MinecraftAdapter(bridge, {
    progressSettleMs: 1,
    explorePollMs: 10,
    recoverPickupMs: 1,
    shelterPollMs: 10,
    bedWaitMs: 50,
  });
  const events: GameEvent[] = [];
  void (async () => {
    for await (const e of adapter.events()) events.push(e);
  })();
  const tasks: TaskEvent[] = [];
  void (async () => {
    for await (const e of adapter.tasks.events()) tasks.push(e);
  })();
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter, events, tasks };
}

const spec = (id: string, goal: string, args: Record<string, unknown> = {}, budget_s = 30): TaskSpec => ({
  id,
  goal,
  args,
  budget_s,
});

function end(tasks: TaskEvent[], id: string): TaskEvent | undefined {
  return tasks.find((e) => e.task === id && (e.type === "done" || e.type === "failed"));
}

async function ended(tasks: TaskEvent[], id: string, ms = 3000): Promise<TaskEvent> {
  await waitFor(() => end(tasks, id) !== undefined, ms);
  return end(tasks, id) as TaskEvent;
}

describe("progress, measured", () => {
  it("compares inventories, counts pickups, and tells place from items", () => {
    expect(inventoryDelta({ oak_log: 2, stick: 4 }, { oak_log: 5, stick: 1 })).toEqual({
      gained: { oak_log: 3 },
      lost: { stick: 3 },
    });
    const at = (x: number, inventory: Record<string, number>): Snapshot => ({ inventory, block_position: { x, y: 64, z: 0 } });
    expect(outcomeOf("mine", at(0, { dirt: 1 }), at(0, { dirt: 1 }))).toMatchObject({
      progressed: false,
      note: "背包沒有變化",
    });
    expect(outcomeOf("mine", at(0, {}), at(0, {}), { oak_log: 2 })).toMatchObject({
      progressed: true,
      gained: { oak_log: 2 },
      note: "+橡木原木×2",
    });
    expect(outcomeOf("obtain", at(0, { wooden_sword: 1 }), at(0, { wooden_sword: 1 }), {}, true)).toMatchObject({
      progressed: false,
      note: "背包裡本來就有了,不用再拿",
    });
    expect(outcomeOf("goto", at(0, {}), at(30, {}))).toMatchObject({ progressed: true, note: "移動了 30 格" });
    expect(outcomeOf("mine", {}, at(0, {}))).toBeNull();
    expect(outcomeOf("explore", at(0, {}), at(0, {}))).toBeNull();
  });

  it("explore: only what is new in sight is progress", () => {
    const sea: Snapshot = { biome: "ocean", nearby_entities: [{ type: "drowned", distance: 9, hostile: true }] };
    expect(sightings(sea)).toEqual(new Set(["drowned", "biome:ocean"]));
    expect(exploreOutcome(sea, sea, new Set(), null)).toMatchObject({ progressed: false });
    expect(exploreOutcome(sea, sea, new Set(["biome:beach", "oak_log"]), null)).toMatchObject({
      progressed: true,
      note: "看到新的:沙灘、橡木原木",
    });
    expect(exploreOutcome(sea, sea, new Set(), "cow")).toMatchObject({ progressed: true, note: "找到牛了" });
  });

  it("an empty mine ends done, without progress", async () => {
    const { mod: m, adapter, tasks } = await setup({ inventory: { dirt: 3 } });
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    m.emit("baritone_idle", { process: "Mine", cancelled: false, reason: "nothing_visible" });
    const e = await ended(tasks, "m1");
    expect(e).toMatchObject({
      type: "done",
      detail: "看得到的都挖完了",
      data: { outcome: { progressed: false, note: "背包沒有變化", inventory: { dirt: 3 } } },
    });
  });

  it("a mine whose drops were picked up is progress, even when the inventory lags", async () => {
    const { mod: m, adapter, tasks } = await setup({ inventory: {} });
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    m.emit("item_picked", { items: { oak_log: 3 } });
    m.emit("baritone_idle", { process: "Mine", cancelled: false });
    const e = await ended(tasks, "m1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, gained: { oak_log: 3 } } } });
  });

  it("an explore that runs out its time over the same sea is done without progress", async () => {
    const { adapter, tasks } = await setup({ biome: "ocean", inventory: {} });
    await adapter.tasks.start(spec("x1", "explore", {}, 1));
    const e = await ended(tasks, "x1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: false } } });
    expect((e as { detail: string }).detail).toContain("沒看到新的東西");
  });

  it("an explore with find stops as soon as it is in sight", async () => {
    const world: Snapshot = { biome: "plains", inventory: {}, nearby_entities: [] };
    const { mod: m, adapter, tasks } = await setup(world);
    await adapter.tasks.start(spec("x1", "explore", { find: ["cow"] }, 30));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    expect(m.requests.find((r) => r.type === "baritone")).not.toHaveProperty("find");
    world.nearby_entities = [{ type: "cow", distance: 12, hostile: false }];
    const e = await ended(tasks, "x1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, note: "找到牛了" } } });
    expect(m.requests.some((r) => r.type === "stop")).toBe(true);
  });

  it("hunt refuses what it does not hunt", async () => {
    const { adapter, tasks } = await setup({ inventory: {} });
    await adapter.tasks.start(spec("h1", "hunt", { entity: "creeper" }));
    expect(await ended(tasks, "h1")).toMatchObject({ type: "failed", code: "invalid" });
  });
});

describe("night", () => {
  it("is told once per night from what she sees, from dusk on", async () => {
    const world: Snapshot = { dimension: "overworld", time_phase: "day", time_of_day: 11000, inventory: {} };
    const { mod: m, adapter, events } = await setup(world);
    await adapter.observe();
    world.time_phase = "dusk";
    await adapter.observe();
    await adapter.observe();
    await waitFor(() => events.some((e) => e.type === "night_started"));
    expect(events.filter((e) => e.type === "night_started")).toEqual([
      { type: "night_started", data: { time_of_day: 11000, text: "天快黑了" } },
    ]);
    // The mod's own event for the same night still passes (it is the mod's word).
    m.emit("night_started", { time_of_day: 13000 });
    await waitFor(() => events.filter((e) => e.type === "night_started").length === 2);
    // A new day, a new night.
    world.time_phase = "day";
    await adapter.observe();
    world.time_phase = "night";
    await adapter.observe();
    await waitFor(() => events.filter((e) => e.type === "night_started").length === 3);
  });

  it("shelter without a bed: digs three down, roofs it from inside, waits for the day", async () => {
    const world: Snapshot = {
      dimension: "overworld",
      time_phase: "night",
      block_position: { x: 10, y: 64, z: -5 },
      inventory: { cobblestone: 5 },
    };
    const { adapter, tasks, mod: m } = await setup(world, (req, fake) => {
      if (req.type === "baritone" && req.command === "goto") {
        world.block_position = { x: 10, y: 61, z: -5 };
        setTimeout(() => fake.emit("goal_reached", { goal: "GoalBlock" }), 5);
      }
      // The first aim finds air (a cave); the second takes the block.
      if (req.type === "use" && fake.requests.filter((r) => r.type === "use").length === 2) {
        world.inventory = { cobblestone: 4 };
        setTimeout(() => {
          world.time_phase = "day";
        }, 30);
      }
    });
    await adapter.tasks.start(spec("s1", "shelter", {}, 60));
    const e = await ended(tasks, "s1");
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true } } });
    expect((e as { detail: string }).detail).toBe("往下挖了三格、封了頂,天亮了");
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "goto", x: 10, y: 61, z: -5 });
    expect(m.requests.find((r) => r.type === "select_slot")).toMatchObject({ item: "cobblestone" });
    const looks = m.requests.filter((r) => r.type === "look").map((r) => r.at);
    expect(looks).toEqual(roofAims({ x: 10, y: 61, z: -5 }).slice(0, 2));
  });

  it("shelter with a bed sleeps in it", async () => {
    const world: Snapshot = { dimension: "overworld", time_phase: "night", block_position: { x: 0, y: 64, z: 0 }, inventory: { red_bed: 1 } };
    const { adapter, tasks, mod: m } = await setup(world, (req) => {
      if (req.type === "use") world.time_phase = "day";
    });
    await adapter.tasks.start(spec("s1", "shelter", {}, 60));
    const e = await ended(tasks, "s1");
    expect((e as { detail: string }).detail).toBe("放下紅色床睡了一覺,天亮了");
    expect(m.requests.map((r) => r.type).filter((t) => t !== "observe")).toEqual(["place", "look", "use"]);
    expect(m.requests.some((r) => r.type === "baritone")).toBe(false);
  });

  it("shelter by day or in the nether is nothing to do", async () => {
    const { adapter, tasks } = await setup({ dimension: "the_nether", inventory: {} });
    await adapter.tasks.start(spec("s1", "shelter"));
    expect(await ended(tasks, "s1")).toMatchObject({
      type: "done",
      data: { outcome: { progressed: false, note: "這裡沒有日夜,不用躲" } },
    });
  });

  it("knows night, beds and roof blocks", () => {
    expect(isNight({ time_phase: "dusk" })).toBe(true);
    expect(isNight({ time_phase: "dawn" })).toBe(false);
    expect(isNight({ time_phase: "night", dimension: "the_end" })).toBe(false);
    expect(bedOf({ dirt: 3, white_bed: 1 })).toBe("white_bed");
    expect(roofBlock({ sand: 30, dirt: 2, cobblestone: 9 })).toBe("cobblestone");
    expect(roofBlock({ sand: 30, gravel: 2 })).toBeNull();
  });
});

describe("death", () => {
  it("remembers where she died and what she had, and goes back for it", async () => {
    const world: Snapshot = {
      dimension: "overworld",
      block_position: { x: 0, y: 64, z: 0 },
      inventory: { wooden_pickaxe: 1, oak_log: 4 },
    };
    const { mod: m, adapter, tasks } = await setup(world, (req) => {
      if (req.type === "baritone" && req.command === "goto") {
        world.inventory = { wooden_pickaxe: 1, oak_log: 4 };
        setTimeout(() => m.emit("goal_reached", { goal: "GoalNear" }), 5);
      }
    });
    await adapter.observe(); // she had the pickaxe and the logs
    m.emit("death", { dimension: "overworld", position: { x: 1392.4, y: 62, z: 1849.6 }, last_attacker: "drowned" });
    world.inventory = {};
    let obs = await adapter.observe();
    for (let i = 0; i < 100 && obs.state.last_death === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      obs = await adapter.observe();
    }
    expect(obs.state.last_death).toMatchObject({
      x: 1392,
      y: 62,
      z: 1850,
      dimension: "overworld",
      lost: { wooden_pickaxe: 1, oak_log: 4 },
    });
    expect(obs.summary).toContain("上次死在 (1392, 62, 1850)");
    expect(obs.summary).toContain("掉了 木鎬×1、橡木原木×4");

    await adapter.tasks.start(spec("r1", "recover"));
    const e = await ended(tasks, "r1");
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "goto", x: 1392, y: 62, z: 1850, near: 1 });
    expect(e).toMatchObject({ type: "done", data: { outcome: { progressed: true, gained: { wooden_pickaxe: 1, oak_log: 4 } } } });
    // Got it back: nothing to recover any more.
    expect((await adapter.observe()).state).not.toHaveProperty("last_death");
    await adapter.tasks.start(spec("r2", "recover"));
    expect(await ended(tasks, "r2")).toMatchObject({ type: "failed", code: "precondition" });
  });
});
