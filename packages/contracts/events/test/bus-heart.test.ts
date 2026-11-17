// The heart, memory, llm and gate topics: their tiers and scopes, and payloads as their
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
    ["affect.changed", "self", "short"],
    ["mood.changed", "self", "short"],
    ["affect.event", null, "short"],
    ["self.nudge", null, "short"],
    ["self.feel", null, "short"],
    ["mind.thought", "owner", "short"],
    ["plan.goal", null, "short"],
    ["mind.reminder", null, "short"],
    ["social.event", null, "short"],
    ["world.salient", null, "ambient"],
    ["feedback.signal", null, "short"],
    ["conversation.folded", null, "short"],
    ["knowledge.changed", "owner", "short"],
    ["reflect.run", "owner", "short"],
    ["llm.budget", "owner", "short"],
    ["gate.decision", "owner", "short"],
    ["actions.outcome", null, "short"],
    ["autonomy.emergency", "owner", "keep"],
    ["moderation.block", "owner", "keep"],
    ["moderation.input", "owner", "short"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("a social event from the economy carries `hunger`, one from the social module does not", () => {
    const base = {
      person: "p1",
      name: "Owen",
      kind: "gift",
      source: "economy",
      scale: 0.5,
      context: null,
    };
    expect(problems("social.event", { ...base, hunger: 0 })).toEqual([]);
    expect(problems("social.event", { ...base, source: "rule", context: ctx })).toEqual([]);
    expect(problems("social.event", { ...base, extra: 1 })).not.toEqual([]);
  });

  it("a feedback signal may name nobody she knows", () => {
    const signal = {
      context: ctx,
      account: { platform: "discord", id: "u1" },
      person: null,
      name: "Owen",
      tone: "positive",
      quote: "好可愛",
      at,
    };
    expect(problems("feedback.signal", signal)).toEqual([]);
    expect(problems("feedback.signal", { ...signal, tone: "meh" })).not.toEqual([]);
  });

  it("the budget and the emergency stop", () => {
    expect(
      problems("llm.budget", {
        state: "ok",
        spent_today_usd: 0.1,
        daily_usd: null,
        spent_month_usd: 2,
        monthly_usd: 20,
      }),
    ).toEqual([]);
    expect(
      problems("autonomy.emergency", {
        paused: true,
        by: "panel:api",
        at,
        steps: [{ step: "pause", ok: true, detail: "ok" }],
      }),
    ).toEqual([]);
  });

  it("an action outcome nobody's ledger took", () => {
    expect(
      problems("actions.outcome", {
        kind: "task",
        source: "plan",
        context: null,
        person: null,
        summary: "join a voice channel",
        outcome: "ok",
        detail: null,
        impulse: null,
        turn: null,
        task: null,
        capability: "voice.join",
        status: "done",
        at,
      }),
    ).toEqual([]);
  });

  it("a mood change", () => {
    expect(
      problems("mood.changed", { valence: 0.2, arousal: 0.4, energy: 0.6, reason: "affect" }),
    ).toEqual([]);
  });

  it("no longer knows the types nothing publishes or reads", () => {
    for (const gone of ["affect.bond", "social.appraisal", "social.relationship"]) {
      expect(registry.get(gone), gone).toBeNull();
    }
  });
});
