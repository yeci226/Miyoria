// The two open namespaces: game adapter events and extension topics.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("families", () => {
  it("a game's events are `game.*.*`, but the director's topics and task events are not", () => {
    for (const topic of ["game.minecraft.death", "game.neuro.force.done", "game.x.player.joined"]) {
      expect(registry.familyOf(topic)).toBe("game.*.*");
    }
    expect(registry.resolve("game.director.session")?.type).toBe("game.director.session");
    expect(registry.resolve("game.chat.link")?.type).toBe("game.chat.link");
    expect(registry.resolve("game.minecraft.task.done")?.type).toBe("**.task.done");
  });

  it("an extension's topics are `ext.**`, but its task events are not", () => {
    expect(registry.familyOf("ext.hello.ping")).toBe("ext.**");
    expect(registry.familyOf("ext.a.b.c")).toBe("ext.**");
    expect(registry.resolve("ext.hello.task.done")?.type).toBe("**.task.done");
  });

  it("tiers and default scopes", () => {
    expect(registry.defaults("game.minecraft.death")).toEqual({ scope: null, tier: "ambient" });
    expect(registry.defaults("ext.hello.ping")).toEqual({ scope: null, tier: "short" });
  });
});

describe("payloads as they are published", () => {
  it("a game event is what the adapter yielded", () => {
    expect(problems("game.minecraft.death", { type: "death" })).toEqual([]);
    expect(
      problems("game.minecraft.damage", { type: "damage", data: { amount: 2 }, important: true }),
    ).toEqual([]);
    expect(problems("game.minecraft.death", "dead")).not.toEqual([]);
    expect(problems("game.minecraft.death", { data: {} })).not.toEqual([]);
  });

  it("an extension event is any JSON value", () => {
    for (const value of [null, 1, "x", [1, { a: null }], { deep: { list: [true] } }]) {
      expect(problems("ext.hello.ping", value)).toEqual([]);
    }
  });
});
