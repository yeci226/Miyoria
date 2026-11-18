// The economy's bus topics: their tiers and scopes, payloads as the economy publishes them, and
// a check that the hand-written payload types of `packages/economy` still fit the schemas. Those
// types are copied here (`ScreenEvent` and `GiftEvent` of packages/economy/src/types.ts) because
// the contracts part cannot import that package.

import { describe, expect, expectTypeOf, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry, type GiftData, type ScreenLineData } from "../src/index.js";

const registry = busEventRegistry();
const at = "2026-11-15T00:00:00.000Z";

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

interface ScreenEvent {
  name: string;
  text: string;
}

interface GiftEvent {
  name: string;
  item: "rice" | "big_bowl" | "dessert";
  count: number;
  label: string;
}

describe("tiers and default scopes", () => {
  it.each([
    ["economy.commission", null, "keep"],
    ["economy.commission.done", null, "keep"],
    ["economy.room.placed", "public", "keep"],
    ["economy.screen", "public", "short"],
    ["economy.gift", "public", "keep"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("the economy's payload types", () => {
  it("fit the schemas both ways", () => {
    expectTypeOf<ScreenEvent>().toEqualTypeOf<ScreenLineData>();
    expectTypeOf<GiftEvent>().toEqualTypeOf<GiftData>();
  });
});

describe("payloads as they are published", () => {
  it("a commission, and how it ended", () => {
    expect(
      problems("economy.commission", {
        id: "C7XK2P",
        commission: "01HZ",
        kind: "poem",
        brief: "a poem about fish",
        name: "Owen",
        account: { platform: "discord", id: "u1" },
        price: 50,
        due_at: at,
      }),
    ).toEqual([]);
    const done = { id: "C7XK2P", status: "delivered", kind: "poem", account: null, text: "ok" };
    expect(problems("economy.commission.done", done)).toEqual([]);
    expect(problems("economy.commission.done", { ...done, status: "pending" })).not.toEqual([]);
  });

  it("a room item, a screen line and a gift", () => {
    expect(
      problems("economy.room.placed", { item: "kotatsu", label: "暖桌", kind: "furniture" }),
    ).toEqual([]);
    expect(problems("economy.screen", { name: "Owen", text: "hi" })).toEqual([]);
    expect(
      problems("economy.gift", { name: "Owen", item: "rice", count: 1, label: "一碗白飯" }),
    ).toEqual([]);
  });
});
