// Survival progression: the harvest-tier refusals, crafting / furnace / place actions, the mod's
// new errors and events, and the guide that reaches the decision prompt.

import { describeActions } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { errorText, toRequests } from "../src/actions.js";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { mapEvent } from "../src/events.js";
import { harvestProblem, pickaxeTier, requiredTier, toolLine } from "../src/harvest.js";
import { compactState, isBusy, summarize } from "../src/summary.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

describe("harvest tiers", () => {
  it("knows which pickaxe each block needs", () => {
    expect(requiredTier("oak_log")).toBe(0);
    expect(requiredTier("dirt")).toBe(0);
    expect(requiredTier("stone")).toBe(1);
    expect(requiredTier("cobblestone")).toBe(1);
    expect(requiredTier("coal_ore")).toBe(1);
    expect(requiredTier("deepslate_coal_ore")).toBe(1);
    expect(requiredTier("nether_gold_ore")).toBe(1);
    expect(requiredTier("iron_ore")).toBe(2);
    expect(requiredTier("deepslate_lapis_ore")).toBe(2);
    expect(requiredTier("copper_ore")).toBe(2);
    expect(requiredTier("diamond_ore")).toBe(3);
    expect(requiredTier("deepslate_diamond_ore")).toBe(3);
    expect(requiredTier("gold_ore")).toBe(3);
    expect(requiredTier("redstone_ore")).toBe(3);
    expect(requiredTier("emerald_ore")).toBe(3);
    expect(requiredTier("obsidian")).toBe(4);
    expect(requiredTier("ancient_debris")).toBe(4);
  });

  it("reads her best pickaxe from the inventory", () => {
    expect(pickaxeTier(undefined)).toBe(0);
    expect(pickaxeTier({ oak_log: 3 })).toBe(0);
    expect(pickaxeTier({ wooden_pickaxe: 1, stone_pickaxe: 1 })).toBe(2);
    expect(pickaxeTier({ golden_pickaxe: 1 })).toBe(1);
    expect(pickaxeTier({ netherite_pickaxe: 1 })).toBe(4);
  });

  it("explains what is missing and what to make next", () => {
    expect(harvestProblem("oak_log", {})).toBeNull();
    expect(harvestProblem("stone", {})).toBe(
      "石頭要木鎬以上才挖得到東西(你現在沒有鎬),現在挖只會白費時間。先空手打原木、做木鎬。",
    );
    expect(harvestProblem("diamond_ore", {})).toContain("鐵鎬以上");
    expect(harvestProblem("diamond_ore", { stone_pickaxe: 1 })).toBe(
      "鑽石礦要鐵鎬以上才挖得到東西(你最好的是石鎬),現在挖只會白費時間。先做鐵鎬。",
    );
    expect(harvestProblem("iron_ore", { wooden_pickaxe: 1 })).toContain("先做石鎬");
    expect(harvestProblem("iron_ore", { stone_pickaxe: 1 })).toBeNull();
    expect(harvestProblem("obsidian", { iron_pickaxe: 1 })).toContain("鑽石鎬以上");
    expect(harvestProblem("obsidian", { diamond_pickaxe: 1 })).toBeNull();
  });

  it("summarizes what her pickaxe can mine", () => {
    expect(toolLine({})).toContain("沒有鎬");
    expect(toolLine({ stone_pickaxe: 1 })).toContain("鐵、銅、青金石");
  });
});

describe("mine refusals", () => {
  it("refuses blocks her pickaxe cannot harvest, before anything is sent", () => {
    expect(() => toRequests({ name: "mine", args: { block: "diamond_ore" } }, { inventory: {} })).toThrow("鐵鎬以上");
    expect(() =>
      toRequests({ name: "mine", args: { blocks: ["oak_log", "iron_ore"] } }, { inventory: { wooden_pickaxe: 1 } }),
    ).toThrow("鐵礦要石鎬以上");
    expect(toRequests({ name: "mine", args: { block: "oak_log" } }, { inventory: {} })).toHaveLength(1);
    expect(toRequests({ name: "mine", args: { block: "iron_ore" } }, { inventory: { stone_pickaxe: 1 } })).toHaveLength(1);
    // unknown inventory: the check is skipped
    expect(toRequests({ name: "mine", args: { block: "diamond_ore" } })).toHaveLength(1);
  });

  it("checks the live inventory when acting", async () => {
    mod = await FakeMod.start();
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), requestTimeoutMs: 500 });
    const adapter = new MinecraftAdapter(bridge);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    m.respond = (req) =>
      req.type === "observe" ? { ok: true, data: { ...SNAPSHOT, inventory: { oak_log: 2 } } } : { ok: true, data: {} };
    expect(await adapter.act({ name: "mine", args: { block: "diamond_ore" } })).toEqual({
      ok: false,
      code: "invalid",
      message: "鑽石礦要鐵鎬以上才挖得到東西(你現在沒有鎬),現在挖只會白費時間。先空手打原木、做木鎬。",
    });
    expect(m.requests.map((r) => r.type)).toEqual(["observe"]);
    expect(await adapter.act({ name: "mine", args: { block: "oak_log", count: 4 } })).toMatchObject({ ok: true });
    expect(m.requests.at(-1)).toMatchObject({ type: "baritone", command: "mine", blocks: ["oak_log"], count: 4 });
  });
});

describe("crafting actions", () => {
  it("maps craft, smelt and place", () => {
    expect(toRequests({ name: "craft", args: { item: "Oak Planks", count: 4 } })).toEqual([
      { type: "craft", params: { item: "oak_planks", count: 4 } },
    ]);
    expect(toRequests({ name: "craft", args: { item: "stick", count: 500 } })[0]?.params).toEqual({ item: "stick", count: 64 });
    expect(toRequests({ name: "smelt", args: { item: "raw_iron", count: 3, fuel: "coal" } })).toEqual([
      { type: "smelt", params: { item: "raw_iron", count: 3, fuel: "coal" } },
    ]);
    expect(toRequests({ name: "smelt" })).toEqual([{ type: "smelt", params: {} }]);
    expect(toRequests({ name: "place", args: { item: "crafting_table" } })).toEqual([
      { type: "place", params: { item: "crafting_table" } },
    ]);
    expect(() => toRequests({ name: "craft", args: {} })).toThrow("craft 要給 item");
    expect(() => toRequests({ name: "place", args: {} })).toThrow("place 要給 item");
  });
});

describe("mod errors", () => {
  it("turns the new refusals into instructions", () => {
    expect(errorText("not_visible", "no oak_log/birch_log in sight within 16 blocks")).toContain(
      "附近看不到橡木原木、樺木原木",
    );
    expect(errorText("too_far", "nearest iron_ore in sight is 14 blocks away at 10,-5,3")).toBe(
      '看得到的鐵礦在 14 格外(10, -5, 3),先 goto {"block":"iron_ore"} 走過去再做',
    );
    expect(errorText("missing_items", "missing stick x2, oak_planks+ x3; also needs a crafting_table within reach")).toBe(
      "材料不夠:還缺 木棒×2、橡木材(或同類)×3,而且要站在工作台旁邊做",
    );
    expect(errorText("missing_items", "missing fuel x1")).toContain("燃料(煤炭、木炭、木材或原木)");
    expect(errorText("needs_station", "needs a crafting_table within reach; none in sight")).toContain(
      "craft crafting_table",
    );
    expect(errorText("needs_station", "needs a furnace within reach; none in sight")).toContain("8 個鵝卵石");
    expect(errorText("busy", "still busy with craft")).toContain("還沒做完");
  });
});

describe("crafting events", () => {
  it("reports finished and failed jobs", () => {
    expect(mapEvent({ name: "craft_finished", data: { item: "stick", crafted: 4, requested: 4 } })).toMatchObject({
      type: "craft_finished",
      important: false,
      data: { text: "做好了 木棒×4" },
    });
    expect(mapEvent({ name: "craft_finished", data: { item: "stick", crafted: 4, requested: 8 } })?.data).toMatchObject({
      text: "做好了 木棒×4(材料只夠做 4 個)",
    });
    expect(mapEvent({ name: "craft_failed", data: { item: "wooden_pickaxe", error: "inventory full" } })).toMatchObject({
      important: true,
      data: { text: "合成 木鎬 失敗:背包滿了" },
    });
    expect(mapEvent({ name: "craft_failed", data: { item: "stick", error: "stopped", cancelled: true } })?.important).toBe(
      false,
    );
    expect(
      mapEvent({
        name: "smelt_finished",
        data: { collected: { iron_ingot: 2 }, item: "raw_iron", count: 3, fuel: "coal", fuel_count: 1, ready_in_secs: 30 },
      })?.data,
    ).toMatchObject({
      text: "從熔爐拿出 鐵錠×2;把 粗鐵×3 放進熔爐,燃料 煤炭×1,約 30 秒後再 smelt 一次拿出來",
    });
    expect(mapEvent({ name: "smelt_finished", data: {} })?.data).toMatchObject({ text: "熔爐裡沒有燒好的東西" });
    expect(mapEvent({ name: "baritone_idle", data: { cancelled: false, reason: "nothing_visible" } })?.data).toMatchObject({
      text: "看得到的都挖完了(附近看不到更多),停下來",
    });
  });
});

describe("what she sees", () => {
  it("adds tools, food, the clock and a running craft", () => {
    const fresh = {
      ...SNAPSHOT,
      food: 5,
      time_of_day: 18000,
      time_phase: "night",
      inventory: { oak_log: 3, cobblestone: 4 },
      held_item: null,
      nearby_blocks: [],
      baritone: { available: true, busy: false, process: null, goal: null },
      crafting: { kind: "craft", item: "oak_planks" },
    };
    const text = summarize(fresh);
    expect(text).toContain("飢餓 5/20(餓了,先吃東西)");
    expect(text).toContain("晚上(約 4 分鐘後天亮)");
    expect(text).toContain("沒有鎬");
    expect(text).toContain("食物:沒有");
    expect(text).toContain("看得到的方塊:沒有特別的");
    expect(text).toContain("正在合成 橡木材");
    expect(isBusy(fresh)).toBe(true);
    expect(compactState(fresh)).toMatchObject({ busy: true, pickaxe_tier: 0, crafting: { kind: "craft" } });
    expect(compactState(SNAPSHOT)).toMatchObject({ pickaxe_tier: 3 });
  });
});

describe("guide", () => {
  it("rides along with the executor's goals", () => {
    const b = new BridgeClient({ endpoint: () => ({ url: "ws://127.0.0.1:1", token: "x" }) });
    const info = new MinecraftAdapter(b).describe();
    for (const step of ["crafting_table", "wooden_pickaxe", "stone_pickaxe", "furnace", "raw_iron", "鐵鎬", "天黑前"]) {
      expect(info.guide, step).toContain(step);
    }
    const description = describeActions(info);
    expect(description).toContain("- obtain:");
    expect(description).not.toContain("- craft:");
    expect(description.endsWith(info.guide ?? "")).toBe(true);
    expect(describeActions({ ...info, guide: undefined })).not.toContain("生存的進度");
  });
});
