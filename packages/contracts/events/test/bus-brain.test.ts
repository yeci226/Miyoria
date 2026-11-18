// The brain's bus topics: their tiers and scopes, task topics as families, and payloads as their
// publishers build them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();
const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const at = "2026-11-15T00:00:00.000Z";

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["agent.turn.outcome", null, "short"],
    ["agent.turn.focus", null, "short"],
    ["agent.prompt", "owner", "short"],
    ["agent.tool", null, "short"],
    ["agent.tool.running", null, "ambient"],
    ["agent.emotion", null, "short"],
    ["agent.message.excluded", "owner", "keep"],
    ["agent.notice", null, "short"],
    ["activity.changed", "self", "short"],
    ["activity.started", null, "short"],
    ["activity.done", null, "short"],
    ["activity.failed", null, "short"],
    ["activity.restore", "self", "short"],
    ["arbiter.impulse", null, "short"],
    ["arbiter.decision", null, "short"],
    ["arbiter.ledger", null, "short"],
    ["directive.changed", "owner", "keep"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("task topics", () => {
  it("resolve to the family of their event type, whatever the owner", () => {
    for (const owner of ["worklane", "sing", "game.minecraft", "ext.test.fixture"]) {
      expect(registry.familyOf(`${owner}.task.done`)).toBe("**.task.done");
      expect(registry.familyOf(`${owner}.task.steered`)).toBe("**.task.steered");
    }
    // A game's own events are the game adapter family, not a task topic.
    expect(registry.familyOf("game.minecraft.death")).toBe("game.*.*");
  });

  it("carry only their own event type", () => {
    const done = { type: "done", task: "t1", detail: "ok", data: null, at };
    expect(problems("game.minecraft.task.done", done)).toEqual([]);
    expect(problems("game.minecraft.task.failed", done)).toEqual([
      { kind: "invalid", path: "type", message: expect.any(String) },
    ]);
    expect(
      problems("sing.task.steered", {
        type: "steered",
        task: "t1",
        steer: "s1",
        outcome: "too_late",
        detail: "",
        at,
      }),
    ).toEqual([]);
  });
});

describe("payloads as they are published", () => {
  it("a snapshot while she goes live and plays a game", () => {
    expect(
      problems("activity.changed", {
        version: 7,
        at,
        presence: { type: "in", channel: { ...ctx, kind: "voice" }, since: at },
        broadcast: { type: "live", guild: "g1", golive: true, obs: true, task: null, since: at },
        activity: {
          type: "game",
          target: "minecraft",
          phase: "failed",
          task: "t2",
          failure: { code: "disconnected", detail: "gone", at },
          since: at,
        },
        override: null,
        scene: "game",
      }),
    ).toEqual([]);
  });

  it("an impulse with its attention and claim, and the decision on it", () => {
    expect(
      problems("arbiter.impulse", {
        id: "i1",
        source: "game",
        kind: "speak",
        target: { context: ctx, person: null, account: null },
        capability: null,
        args: {},
        priority: "idle",
        expires_at: at,
        why: "death",
        hint: "她死了",
        about: [],
        coalesce_key: null,
        goal: null,
        created_at: at,
        attention: { key: "game:death", repeat_after_ms: 60000 },
        claim: "result",
      }),
    ).toEqual([]);
    expect(
      problems("arbiter.decision", {
        impulse: "i1",
        source: "game",
        verdict: "deferred",
        reason: "busy",
        detail: "等一下",
        retry_at: at,
        merged_into: null,
        turn: null,
        task: null,
        at,
      }),
    ).toEqual([]);
  });

  it("a rule added and a proposal dropped", () => {
    const directive = {
      id: "d1",
      issuer: { platform: "discord", id: "1" },
      authority: "owner",
      scope: { capability: "game.*" },
      effect: "deny",
      text: "不要玩 Minecraft",
      expires: "until_revoked",
      source_event: "msg:1",
      created_at: at,
    };
    expect(
      problems("directive.changed", { op: "add", text: "新規則", directive, by: "discord:1" }),
    ).toEqual([]);
    expect(
      problems("directive.changed", {
        op: "proposal_dropped",
        text: "提案作廢",
        directive: null,
        by: "directive",
        proposal: "p1",
      }),
    ).toEqual([]);
  });
});
