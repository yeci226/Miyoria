import { describe, expect, it } from "vitest";
import { PlanError, countOf, describeStep, knows, normalizeItem, plan, planksOf } from "../src/planner.js";

const lines = (target: string, inv: Record<string, number> = {}, world = {}, count = 1) =>
  plan(target, count, inv, world).map(describeStep);

describe("planner", () => {
  it("works an iron pickaxe back to bare hands, each source in one go", () => {
    expect(lines("iron_pickaxe")).toEqual([
      "砍原木×4",
      "做木材×16",
      "做工作台×1",
      "放下工作台",
      "做木棒×8",
      "做木鎬×1",
      "挖鵝卵石×11",
      "做熔爐×1",
      "放下熔爐",
      "做石鎬×1",
      "挖粗鐵×3",
      "用熔爐燒鐵錠×3",
      "做鐵鎬×1",
    ]);
  });

  it("starts from what she already has and the stations she can see", () => {
    const steps = plan("iron_pickaxe", 1, { stone_pickaxe: 1, stick: 2, oak_planks: 2, raw_iron: 1 }, { table: true, furnace: true });
    expect(steps.map(describeStep)).toEqual(["挖粗鐵×2", "用熔爐燒鐵錠×3", "做鐵鎬×1"]);
    // the stone pickaxe reaches iron ore: no new tools; two planks are the fuel
    expect(steps[0]).toEqual({ kind: "mine", item: "raw_iron", blocks: ["iron_ore", "deepslate_iron_ore"], count: 2 });
  });

  it("burns coal before planks", () => {
    const steps = plan("iron_ingot", 3, { raw_iron: 3, coal: 1 }, { furnace: true });
    expect(steps).toEqual([{ kind: "smelt", item: "iron_ingot", input: "raw_iron", count: 3 }]);
  });

  it("makes fuel when there is nothing to burn", () => {
    expect(lines("iron_ingot", { raw_iron: 2, oak_log: 1 }, { furnace: true }, 2)).toEqual(["做木材×4", "用熔爐燒鐵錠×2"]);
  });

  it("needs the right pickaxe tier before mining", () => {
    expect(lines("diamond", { iron_pickaxe: 1 })).toEqual(["挖鑽石×1"]);
    expect(lines("cobblestone", {})).toEqual(["砍原木×3", "做木材×12", "做工作台×1", "放下工作台", "做木棒×4", "做木鎬×1", "挖鵝卵石×1"]);
  });

  it("treats tag ingredients as any member", () => {
    expect(countOf({ birch_planks: 2, oak_planks: 3 }, "#planks")).toBe(5);
    expect(lines("stick", { birch_planks: 2 })).toEqual(["做木棒×4"]);
    expect(lines("stone_pickaxe", { cobbled_deepslate: 3, stick: 2, wooden_pickaxe: 1 }, { table: true })).toEqual(["做石鎬×1"]);
    expect(planksOf("stripped_dark_oak_wood")).toBe("dark_oak_planks");
    expect(planksOf("crimson_stem")).toBe("crimson_planks");
  });

  it("knows when she already has it and what it cannot plan", () => {
    expect(plan("torch", 4, { torch: 5 })).toEqual([]);
    expect(normalizeItem("Iron Pickaxe")).toBe("iron_pickaxe");
    expect(normalizeItem("minecraft:planks")).toBe("#planks");
    expect(knows("iron_pickaxe")).toBe(true);
    expect(knows("oak_planks")).toBe(true);
    expect(knows("elytra")).toBe(false);
    expect(() => plan("elytra", 1, {})).toThrow(PlanError);
  });

  it("plans torches through coal", () => {
    expect(lines("torch", { wooden_pickaxe: 1, stick: 1 }, {}, 4)).toEqual(["挖煤炭×1", "做火把×4"]);
  });

  it("plans flint and steel from gravel and iron", () => {
    expect(lines("flint_and_steel", { iron_ingot: 1 })).toEqual(["挖燧石×1", "做打火石×1"]);
  });

  it("plans a bed from wool and planks", () => {
    expect(lines("white_bed", { white_wool: 3, oak_planks: 3 }, { table: true })).toEqual(["做白色床×1"]);
    // Wool of another colour does not make a white bed.
    expect(() => plan("white_bed", 1, { red_wool: 3, oak_planks: 3 }, { table: true })).toThrow();
  });

  it("needs a diamond pickaxe to mine obsidian", () => {
    expect(lines("obsidian", { diamond_pickaxe: 1 })).toEqual(["挖黑曜石×1"]);
  });

  it("plans ender eyes from blaze rods and ender pearls", () => {
    expect(lines("ender_eye", { blaze_rod: 1, ender_pearl: 2 }, {}, 2)).toEqual(["做烈焰粉×2", "做終界之眼×2"]);
  });

  it("says where mob drops come from instead of planning them", () => {
    expect(() => plan("ender_eye", 1, {})).toThrow("烈焰棒沒辦法自己做出來");
    expect(() => plan("ender_eye", 1, { blaze_rod: 1 })).toThrow("終界珍珠沒辦法自己做出來");
  });

  it("plans obsidian mining through diamonds from stone pickaxe", () => {
    const steps = plan("obsidian", 10, { stone_pickaxe: 1 }, { table: true, furnace: true });
    expect(steps.map(describeStep)).toEqual([
      "挖粗鐵×3",
      "砍原木×1",
      "做木材×4",
      "用熔爐燒鐵錠×3",
      "做木棒×4",
      "做鐵鎬×1",
      "挖鑽石×3",
      "做鑽石鎬×1",
      "挖黑曜石×10",
    ]);
  });
});
