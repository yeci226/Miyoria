// The game director, mood nudge and queue topics: their tiers and scopes, and payloads as their
// publishers build them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();
const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "voice" } as const;
const at = "2026-11-15T00:00:00.000Z";

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["game.chat.link", "owner", "short"],
    ["game.director.session", null, "short"],
    ["game.director.goal", null, "short"],
    ["game.director.skill", "self", "short"],
    ["game.director.decision", "owner", "short"],
    ["mood.nudge", null, "short"],
    ["queue.item_activated", null, "short"],
    ["queue.vote_result", null, "short"],
    ["queue.changed", null, "ambient"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("a session that ended because the game went away", () => {
    const session = { state: "stopped", game: "minecraft", game_name: "Minecraft", context: ctx };
    expect(problems("game.director.session", session)).toEqual([]);
    expect(
      problems("game.director.session", { ...session, code: "disconnected", reason: "gone" }),
    ).toEqual([]);
    expect(problems("game.director.session", { ...session, state: "paused" })).not.toEqual([]);
  });

  it("a goal's end takes the director's own codes and a task's", () => {
    const end = {
      game: "minecraft",
      goal: "get stone",
      source: "director",
      status: "done",
      code: "reported",
      task: null,
      detail: "",
      at,
      attention_key: "game:goal:stone",
    };
    expect(problems("game.director.goal", end)).toEqual([]);
    expect(problems("game.director.goal", { ...end, code: "timeout", status: "failed" })).toEqual(
      [],
    );
    expect(problems("game.director.goal", { ...end, code: "nonsense" })).not.toEqual([]);
  });

  it("a skill's time is epoch milliseconds, as the director keeps it", () => {
    const skill = { game: "minecraft", target: "bread", goal: "make bread", steps: ["obtain"] };
    expect(problems("game.director.skill", { ...skill, at: 1_760_000_000_000 })).toEqual([]);
    expect(problems("game.director.skill", { ...skill, at })).not.toEqual([]);
  });

  it("a decision trace", () => {
    expect(
      problems("game.director.decision", {
        game: "minecraft",
        trigger: ["求生"],
        goal: null,
        action: null,
        verdict: "Replace",
        commentary: null,
        busy: false,
        observation: "",
        want: { item: "stone", count: 3 },
        held: [],
      }),
    ).toEqual([]);
  });

  it("the queue: an activated item, a vote result, a snapshot with and without a vote", () => {
    const item = {
      id: 1,
      requester: { platform: "discord", id: "u1" },
      requester_name: "Owen",
      kind: "song",
      text: "something",
      context: null,
      created_at: at,
      priority: 0,
      votes: 0,
      state: "active",
      position: null,
    };
    expect(problems("queue.item_activated", item)).toEqual([]);
    expect(
      problems("queue.vote_result", {
        options: ["a", "b"],
        tallies: [2, 1],
        winner: 0,
        winner_option: "a",
        total: 3,
        ended_at: at,
      }),
    ).toEqual([]);
    expect(problems("queue.changed", { items: [item], paused: false })).toEqual([]);
    expect(
      problems("queue.changed", {
        items: [],
        paused: true,
        vote: { options: ["a"], tallies: [0], total: 0, started_at: at, ends_at: at },
      }),
    ).toEqual([]);
  });
});
