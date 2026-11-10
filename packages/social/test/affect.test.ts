// The social side of the affect layer: one label scale, a derived mood nobody nudges, her own
// tags that never feed back, and the bond changes Reflect proposes.

import type { Relationship } from "@miyoria/store";
import { AFFECT_BOND_TOPIC, customEvent, type Mood, relationshipLabel } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { applyBond, label, MoodState, moodConfig, socialConfig } from "../src/index.js";
import { acc, dm, Harness, t } from "./helpers.js";

const baseline = { valence: 0.1, arousal: 0.5, energy: 0.7 };
const noon = Date.UTC(2026, 10, 1, 4, 0, 0);

describe("one label scale", () => {
  it("`label` is `relationshipLabel` for every combination", () => {
    for (let affinity = -100; affinity <= 100; affinity += 5) {
      for (const familiarity of [0, 2, 3, 9, 10, 29, 30, 80]) {
        expect(label({ affinity, familiarity } as Relationship)).toBe(
          relationshipLabel({ affinity, familiarity }),
        );
      }
    }
  });

  it("the attitude carries the label of the shared scale, and what the affect card needs", async () => {
    const h = new Harness();
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const attitude = h.social.attitude(acc("discord:2"));
    expect(attitude).toMatchObject({
      label: relationshipLabel({
        affinity: h.rel("discord:2").affinity,
        familiarity: h.rel("discord:2").familiarity,
      }),
      owner: false,
      display_name: "Amy",
      interactions: 1,
    });
    expect(attitude?.last_interaction).not.toBeNull();
  });
});

describe("a derived mood", () => {
  const derived: Mood = { valence: 0.3, arousal: 0.4, energy: 0.6 };

  it("is served as it is and nobody nudges it", () => {
    const state = new MoodState(baseline, moodConfig(), noon, undefined, undefined, () => derived);
    expect(state.mood()).toEqual(derived);
    expect(state.at(noon + 3_600_000)).toEqual(derived);
    expect(
      state.handle(customEvent("mood.nudge", { valence: -0.2, reason: "game" }), noon),
    ).toBeNull();
    expect(
      state.handle(customEvent("social.relationship", { kind: "insult", affinity: -3 }), noon),
    ).toBeNull();
    expect(state.handle(customEvent("agent.emotion", { emotion: "angry" }), noon)).toBeNull();
    expect(state.mood()).toEqual(derived);
  });

  it("falls back to its own dynamics without the affect service", () => {
    const state = new MoodState(baseline, moodConfig(), noon, undefined, undefined, () => null);
    expect(
      state.handle(customEvent("mood.nudge", { valence: -0.1, reason: "game" }), noon),
    ).not.toBeNull();
  });
});

describe("her `<emo:…>` tags", () => {
  it("never feed back into the mood, however many there are", () => {
    const state = new MoodState(baseline, moodConfig(), noon);
    const before = state.mood();
    for (let i = 0; i < 50; i++) {
      state.handle(customEvent("agent.emotion", { emotion: "angry" }), noon + i * 1000);
      state.handle(customEvent("agent.emotion", { emotion: "smug" }), noon + i * 1000);
    }
    expect(state.mood()).toEqual(before);
  });
});

describe("bond changes proposed by Reflect", () => {
  it("are applied to the relationship as small steps", async () => {
    const h = new Harness(socialConfig());
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const person = h.person("discord:2");
    const before = h.rel("discord:2");
    await applyBond(
      h.social,
      { person, affinity: 2, trust: 1, familiarity: 2, why: "她很照顧我" },
      t(1, 11),
    );
    const after = h.rel("discord:2");
    expect(after.affinity).toBeCloseTo(before.affinity + 2, 6);
    expect(after.trust).toBeCloseTo(before.trust + 1, 6);
    expect(after.familiarity).toBeCloseTo(before.familiarity + 2, 6);
    expect(h.store.deltas(person).map((d) => d.reason)).toContain("reflect: 她很照顧我");
  });

  it("ignores malformed payloads", async () => {
    const h = new Harness(socialConfig());
    await h.say("discord:2", "Amy", "你好", dm(), t(1, 10));
    const before = JSON.stringify(h.rel("discord:2"));
    await applyBond(h.social, "nonsense", t(1, 11));
    await applyBond(h.social, { person: "x" }, t(1, 11));
    await applyBond(h.social, { person: h.person("discord:2") }, t(1, 11));
    expect(JSON.stringify(h.rel("discord:2"))).toBe(before);
    expect(AFFECT_BOND_TOPIC).toBe("affect.bond");
  });
});
