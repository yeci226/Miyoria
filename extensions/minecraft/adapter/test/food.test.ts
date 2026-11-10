// Food through `obtain` (docs/design/v4-plan.md §11.2 item 4): the planner knows hunting,
// cooking and harvest, and the runner hunts and harvests with ordinary requests. On 2026-11-08
// `obtain` answered bread, cooked beef, cod and apples with "no recipe" or "missing wheat".

import type { GameEvent } from "@miyoria/sdk";
import { describe, expect, it } from "vitest";
import { ObtainRunner, type RunnerHost, parsePlanPatch, worldOf } from "../src/obtain.js";
import { PlanError, describeStep, knows, normalizeItem, plan } from "../src/planner.js";
import type { Snapshot } from "../src/summary.js";

const kinds = (steps: ReturnType<typeof plan>) => steps.map((s) => `${s.kind} ${s.item}`);

describe("the planner knows food", () => {
  it("cooked beef: hunt a cow, make a furnace, cook it", () => {
    const steps = plan("cooked_beef", 1, { wooden_pickaxe: 1, oak_planks: 8 });
    expect(steps.map(describeStep)).toEqual([
      "做工作台×1",
      "放下工作台",
      "挖鵝卵石×8",
      "做熔爐×1",
      "放下熔爐",
      "打牛、哞菇拿生牛肉×1",
      "用熔爐燒牛排×1",
    ]);
    expect(steps[5]).toEqual({ kind: "hunt", item: "beef", entities: ["cow", "mooshroom"], count: 1 });
    expect(steps.at(-1)).toEqual({ kind: "smelt", item: "cooked_beef", input: "beef", count: 1 });
  });

  it("bread: harvest wheat, then craft it at a table", () => {
    const steps = plan("bread", 2, { crafting_table: 1 });
    expect(kinds(steps)).toEqual(["place crafting_table", "gather wheat", "craft bread"]);
    expect(steps[1]).toMatchObject({ kind: "gather", crops: ["wheat"], count: 6 });
  });

  it("food: the easiest thing the world offers", () => {
    // A pig in sight and no furnace: raw pork.
    expect(kinds(plan("food", 1, {}, { animals: ["pig"] }))).toEqual(["hunt porkchop"]);
    // With a furnace in sight it is cooked.
    expect(kinds(plan("food", 1, { oak_planks: 4 }, { animals: ["pig"], furnace: true }))).toEqual([
      "hunt porkchop",
      "smelt cooked_porkchop",
    ]);
    // Wheat in sight and no animals: bread.
    expect(kinds(plan("food", 1, { crafting_table: 1 }, { crops: ["wheat"] })).at(-1)).toBe("craft bread");
    // Nothing in sight: any meat (the runner explores for an animal).
    expect(plan("food", 1, {})).toEqual([
      { kind: "hunt", item: "#meat", entities: ["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom"], count: 1 },
    ]);
    // Food she has counts.
    expect(plan("food", 1, { bread: 1 })).toEqual([]);
    expect(plan("food", 1, { rotten_flesh: 5 })).not.toEqual([]);
  });

  it("knows what it can do and says what it cannot", () => {
    expect(normalizeItem("Food")).toBe("#food");
    for (const item of ["cooked_beef", "bread", "#food", "beef", "cooked_cod", "wheat", "melon_slice"]) {
      expect(knows(item), item).toBe(true);
    }
    expect(knows("apple")).toBe(false);
    expect(() => plan("apple", 1, {})).toThrow(PlanError);
    expect(() => plan("apple", 1, {})).toThrow(/obtain \{item:"food"\}/);
    expect(parsePlanPatch({ item: "cooked_beef" })).toEqual({ item: "cooked_beef" });
    expect(parsePlanPatch({ item: "apple" })).toMatch(/打獵和收成/);
  });

  it("reads the animals and crops in sight", () => {
    const s: Snapshot = {
      nearby_entities: [
        { type: "zombie", distance: 5, hostile: true },
        { type: "cow", distance: 9, hostile: false },
      ],
      nearby_blocks: [{ block: "wheat", count: 4 }, { block: "furnace", count: 1 }],
    };
    expect(worldOf(s)).toEqual({ table: false, furnace: true, animals: ["cow"], crops: ["wheat"] });
  });
});

/** A field with cows: following one brings it under the crosshair, a hit drops beef. */
class Field implements RunnerHost {
  inv: Record<string, number> = {};
  cows = 2;
  following = false;
  /** Hits a cow takes. */
  hp = 2;
  wheatRipe = 0;
  farming = false;
  readonly requests: Array<{ type: string; params: Record<string, unknown> }> = [];
  readonly emitted: GameEvent[] = [];
  /** Where the crosshair lands while following (`none`: Baritone looks at the ground). */
  aim: "cow" | "none" = "cow";

  async request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, params });
    if (type === "baritone" && params.command === "follow") this.following = this.cows > 0;
    if (type === "baritone" && params.command === "farm") this.farming = true;
    if (type === "stop") {
      this.following = false;
      this.farming = false;
    }
    if (type === "look") this.aim = "cow";
    if (type === "attack" && this.following && this.aim === "cow") {
      this.hp -= 1;
      if (this.hp <= 0) {
        this.cows -= 1;
        this.hp = 2;
        this.inv.beef = (this.inv.beef ?? 0) + 1;
      }
    }
    return {};
  }

  async observe(): Promise<Snapshot> {
    if (this.farming && this.wheatRipe > 0) {
      this.wheatRipe -= 1;
      this.inv.wheat = (this.inv.wheat ?? 0) + 1;
    }
    return {
      inventory: { ...this.inv },
      nearby_entities: Array.from({ length: this.cows }, () => ({ type: "cow", distance: 2.5, hostile: false })),
      looking_at:
        this.following && this.aim === "cow" && this.cows > 0
          ? { kind: "entity", entity: "cow", distance: 2.5 }
          : { kind: "none" },
      baritone: { busy: this.following || (this.farming && this.wheatRipe > 0) },
    };
  }

  emit(e: GameEvent): void {
    this.emitted.push(e);
  }
}

const fast = {
  exploreMs: 40,
  explorePollMs: 5,
  huntMs: 400,
  huntPollMs: 2,
  gatherMs: 400,
  pickupWaitMs: 1,
  jobTimeoutMs: 100,
};

describe("hunting and harvest", () => {
  it("follows, hits what is under the crosshair, stops when enough dropped", async () => {
    const field = new Field();
    field.inv.wooden_sword = 1;
    const result = await new ObtainRunner(field, "beef", 2, fast).run();
    expect(result).toEqual({ ok: true, message: "拿到生牛肉×2了" });
    const types = field.requests.map((r) => (r.type === "baritone" ? `baritone ${r.params.command}` : r.type));
    expect(types[0]).toBe("select_slot");
    expect(field.requests[0]?.params).toEqual({ item: "wooden_sword" });
    expect(types).toContain("baritone follow");
    expect(types.filter((t) => t === "attack")).toHaveLength(4);
    expect(types.at(-1)).toBe("stop");
  });

  it("aims down when the animal is near but not under the crosshair", async () => {
    const field = new Field();
    field.aim = "none";
    const result = await new ObtainRunner(field, "beef", 1, fast).run();
    expect(result.ok).toBe(true);
    expect(field.requests.find((r) => r.type === "look")?.params).toEqual({ pitch: 25 });
  });

  it("explores for an animal first, and says so when none shows up", async () => {
    const field = new Field();
    field.cows = 0;
    const result = await new ObtainRunner(field, "beef", 1, fast).run();
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(result.message).toContain("附近看不到牛、哞菇");
    expect(field.requests.some((r) => r.params.command === "explore")).toBe(true);
  });

  it("harvests ripe wheat with Baritone's farm and makes bread", async () => {
    const field = new Field();
    field.wheatRipe = 3;
    const host: RunnerHost = {
      ...field,
      request: async (type, params = {}) => {
        if (type === "craft" && params.item === "bread") {
          field.inv.wheat = (field.inv.wheat ?? 0) - 3;
          field.inv.bread = 1;
          setTimeout(() => runner.feed({ name: "craft_finished", data: { item: "bread", crafted: 1 } }), 1);
          return {};
        }
        if (type === "place") {
          field.inv.crafting_table = 0;
          return {};
        }
        return field.request(type, params);
      },
      observe: async () => ({
        ...(await field.observe()),
        nearby_blocks: [{ block: "crafting_table", count: 1, distance: 2 }],
      }),
      emit: () => {},
    };
    const runner = new ObtainRunner(host, "bread", 1, fast);
    const result = await runner.run();
    expect(result).toEqual({ ok: true, message: "拿到麵包了" });
    expect(field.requests.some((r) => r.params.command === "farm")).toBe(true);
  });

  it("no ripe crops is not_found with what to do instead", async () => {
    const field = new Field();
    const result = await new ObtainRunner(field, "wheat", 1, fast).run();
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(result.message).toContain("改去打獵");
  });
});
