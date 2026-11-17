// The affect service: rule events, appraisals, derived mood, what she shows and biases. How she
// feels about each person is the heart's (a fake one here).

import {
  AFFECT_EVENT_KINDS,
  APPRAISAL_STRENGTH,
  type EmotionReading,
  renderAffectMood,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { shownEmotion } from "../src/display.js";
import { eventEffects, NO_CONTEXT, socialEffects, strengthOf } from "../src/events.js";
import { ev, HOUR, level, MINUTE, rig, T0 } from "./helpers.js";

const reading = (name: EmotionReading["name"], intensity: number): EmotionReading => ({
  name,
  intensity,
  cause: "",
  at: toTimestamp(T0),
  person: null,
});

describe("the rule-event table", () => {
  it("has an entry for every kind, and only uses the shared strengths", () => {
    const allowed = new Set<number>([
      ...Object.values(APPRAISAL_STRENGTH),
      // Drives, calming and the like carry their own sizes.
    ]);
    for (const kind of AFFECT_EVENT_KINDS) {
      const effects = eventEffects(kind, NO_CONTEXT);
      expect(effects.length, kind).toBeGreaterThan(0);
      for (const f of effects) {
        if (f.type === "emotion" && f.amount > 0)
          expect(allowed.has(f.amount), `${kind}`).toBe(true);
      }
    }
  });

  it("praise: joy medium, and a little shyness for a tsundere (more for her crush)", () => {
    const joy = (c: Partial<typeof NO_CONTEXT>) =>
      eventEffects("praised", { ...NO_CONTEXT, ...c }).flatMap((f) =>
        f.type === "emotion" ? [[f.emotion, f.amount] as const] : [],
      );
    expect(joy({})).toEqual([["joy", 0.2]]);
    expect(joy({ tsundere: true })).toEqual([
      ["joy", 0.2],
      ["shy", 0.1],
    ]);
    expect(joy({ tsundere: true, crush: true })).toContainEqual(["shy", 0.2]);
  });

  it("someone she cares about arrives: joy by how much she cares, missing eases, company", () => {
    const joy = (c: Partial<typeof NO_CONTEXT>) =>
      eventEffects("cared_arrived", { ...NO_CONTEXT, ...c }).find(
        (f) => f.type === "emotion" && f.emotion === "joy",
      );
    expect(joy({ care: 0.3 })).toMatchObject({ amount: 0.1 });
    expect(joy({ care: 0.8 })).toMatchObject({ amount: 0.2 });
    expect(joy({ care: 0.8, missed: 0.7 })).toMatchObject({ amount: 0.35 });
    const all = eventEffects("cared_arrived", NO_CONTEXT);
    expect(all).toContainEqual({ type: "toward", emotion: "missing", amount: -0.2 });
    expect(all.some((f) => f.type === "companionship")).toBe(true);
  });

  it("a topic nobody picked up, interruptions and being ignored", () => {
    expect(eventEffects("topic_ignored", NO_CONTEXT)).toEqual([
      { type: "emotion", emotion: "lonely", amount: 0.1 },
      { type: "emotion", emotion: "frustration", amount: 0.1 },
    ]);
    for (const kind of ["interrupted", "ignored"] as const) {
      expect(eventEffects(kind, NO_CONTEXT)[0]).toEqual({
        type: "emotion",
        emotion: "frustration",
        amount: 0.1,
      });
    }
  });

  it("a song finished is a weak pride; it is medium only when people reacted", () => {
    const pride = (kind: "song_finished" | "song_applauded") =>
      eventEffects(kind, NO_CONTEXT).find((f) => f.type === "emotion" && f.emotion === "pride");
    expect(pride("song_finished")).toMatchObject({ amount: 0.1 });
    expect(pride("song_applauded")).toMatchObject({ amount: 0.2 });
  });

  it("someone she cares about being warm with others: jealousy toward them, more for a crush", () => {
    const e = (c: Partial<typeof NO_CONTEXT>) =>
      eventEffects("cared_close_with_other", { ...NO_CONTEXT, ...c })[0];
    expect(e({ care: 0.3 })).toMatchObject({
      emotion: "jealousy",
      amount: 0.1,
      toward: "jealousy",
    });
    expect(e({ crush: true })).toMatchObject({ amount: 0.2 });
  });

  it("social event kinds scale with the LLM's scale and have no rule for unknown kinds", () => {
    expect(socialEffects("insult", NO_CONTEXT)).not.toBeNull();
    expect(socialEffects("nonsense", NO_CONTEXT)).toBeNull();
    const half = socialEffects("rude", { ...NO_CONTEXT, scale: 0.5 })?.[0];
    expect(half).toMatchObject({ emotion: "anger", amount: 0.1 });
  });

  it("extension nudges only pick a step", () => {
    expect([strengthOf(0.05), strengthOf(0.2), strengthOf(0.5), strengthOf(-0.3)]).toEqual([
      "weak",
      "medium",
      "strong",
      "strong",
    ]);
  });
});

describe("rule events through the service", () => {
  it("praise raises joy; the same praise within two hours counts half", () => {
    const r = rig();
    r.affect.applyEvent(ev("praised", T0, { key: "praise|p1" }));
    expect(level(r, "joy")).toBeCloseTo(0.2, 3);
    r.advance(MINUTE);
    r.affect.applyEvent(ev("praised", T0 + MINUTE, { key: "praise|p1" }));
    // The second adds 0.1 of the remaining room (less, the first faded a hair).
    expect(level(r, "joy")).toBeGreaterThan(0.27);
    expect(level(r, "joy")).toBeLessThan(0.3);
  });

  it("topic_ignored stirs lonely and frustration weakly", () => {
    const r = rig();
    r.affect.applyEvent(ev("topic_ignored", T0));
    expect(level(r, "lonely")).toBeCloseTo(0.1, 3);
    expect(level(r, "frustration")).toBeCloseTo(0.1, 3);
  });

  it("joy pushes sorrow down by half of what it stirred", () => {
    const r = rig();
    r.self.feel("sorrow", 0.4, "x");
    r.advance(11 * MINUTE);
    const before = level(r, "sorrow");
    r.affect.applyEvent(ev("praised", r.clock.at));
    expect(level(r, "sorrow")).toBeCloseTo(before - 0.1, 2);
  });

  it("an arrival of someone she cares about: joy by how much she missed them, company eases lonely", () => {
    const r = rig();
    r.cares.set("p1", 0.6);
    r.advance(11 * MINUTE);
    r.self.feel("lonely", 0.4, "x");
    const lonely = level(r, "lonely");
    r.affect.applyEvent(ev("cared_arrived", r.clock.at, { person: "p1", key: "arrive|p1" }), {
      missed: 0.6,
    });
    expect(level(r, "joy")).toBeGreaterThanOrEqual(0.2);
    expect(level(r, "lonely")).toBeLessThan(lonely);
  });

  it("drives follow: a song finished satisfies esteem", () => {
    const r = rig();
    const before = r.self.drives().esteem;
    r.affect.applyEvent(ev("song_finished", T0));
    expect(r.self.drives().esteem).toBeLessThan(before);
  });
});

describe("appraisals", () => {
  it("map strength to 0.1 / 0.2 / 0.35 times her gain, and report what was applied", () => {
    const r = rig({ temperament: { emotions: { shy: { gain: 2 } } } });
    const out = r.affect.appraise({
      source: "appraise",
      context: null,
      at: toTimestamp(T0),
      events: [
        { emotion: "joy", strength: "weak", toward: null, cause: "a" },
        { emotion: "pride", strength: "medium", toward: null, cause: "b" },
        { emotion: "shy", strength: "strong", toward: null, cause: "c" },
      ],
    });
    expect(out.map((o) => o.amount)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      // 0.35 × 2 = 0.7, limited by what is left of the 10-minute budget (0.9 - 0.3).
      expect.closeTo(0.6, 6),
    ]);
    expect(out.every((o) => o.habituation === 1)).toBe(true);
  });

  it("takes at most three, ignores unknown emotions and strengths, and no number gets in", () => {
    const r = rig();
    const out = r.affect.appraise({
      source: "appraise",
      context: null,
      at: toTimestamp(T0),
      events: [
        { emotion: "joy", strength: "weak", toward: null, cause: "a" },
        { emotion: "love" as never, strength: "weak", toward: null, cause: "b" },
        { emotion: "pride", strength: "huge" as never, toward: null, cause: "c" },
        { emotion: "anger", strength: "weak", toward: null, cause: "d" },
        { emotion: "fear", strength: "weak", toward: null, cause: "e" },
        { emotion: "disgust", strength: "weak", toward: null, cause: "f" },
      ],
    });
    // Only the first three events count; of them the unknown ones are skipped.
    expect(out.map((o) => o.emotion)).toEqual(["joy"]);
  });

  it("repeats of one cause habituate", () => {
    const r = rig();
    const one = () =>
      r.affect.appraise({
        source: "appraise",
        context: null,
        at: toTimestamp(r.clock.at),
        events: [{ emotion: "shy", strength: "medium", toward: null, cause: "他說想聽我唱歌" }],
      })[0];
    expect(one()?.habituation).toBe(1);
    r.advance(5 * MINUTE);
    expect(one()?.habituation).toBe(0.5);
  });
});

describe("mood is derived, not stored", () => {
  it("the same inputs give the same mood; her emotions and the hour move it", () => {
    const r = rig();
    const calm = r.affect.snapshot().mood;
    expect(r.affect.snapshot().mood).toEqual(calm);
    expect(calm.valence).toBeCloseTo(0.1, 2);
    r.affect.applyEvent(ev("game_won", T0, { key: "w" }));
    expect(r.affect.snapshot().mood.valence).toBeGreaterThan(calm.valence + 0.1);
    // Late at night she is tired (no stored energy: the hour alone).
    const night = rig();
    night.clock.at = Date.parse("2026-11-02T20:00:00.000Z");
    expect(night.affect.snapshot().mood.energy).toBeLessThan(calm.energy - 0.2);
  });

  it("unmet wants weigh on valence", () => {
    const r = rig();
    const base = r.affect.snapshot().mood.valence;
    r.self.adjust({ social: 0.7, esteem: 0.7 }, "test");
    expect(r.affect.snapshot().mood.valence).toBeLessThan(base - 0.05);
  });

  it("the mood line and the top emotions are the one renderer", () => {
    const r = rig();
    r.affect.applyEvent(ev("game_won", T0, { key: "w" }));
    const snap = r.affect.snapshot();
    expect(snap.mood_line).toMatch(/^心情/);
    expect(snap.top.length).toBeGreaterThan(0);
    expect(snap.top.length).toBeLessThanOrEqual(3);
    expect(r.affect.renderMood?.()).toBe(renderAffectMood(snap));
    expect(r.affect.renderMood?.()).toContain("你現在心情");
    expect(r.affect.renderMood?.()).not.toMatch(/\d\.\d/);
  });
});

describe("what she shows is a pure function of what she feels, her rules and who is there", () => {
  const felt = [reading("joy", 0.5)];

  it("open shows it as it is; a tsundere masks it", () => {
    expect(shownEmotion(felt, "open", 0.2)).toMatchObject({ tag: "happy", masked: false });
    expect(shownEmotion(felt, "tsundere", 0.2)).toMatchObject({ tag: "smug", masked: true });
    expect(shownEmotion([], "tsundere", 0.2)).toBeNull();
  });

  it("the same inputs always show the same", () => {
    const a = shownEmotion(felt, "tsundere", 0.2, { care: 0.5, people: 2 });
    expect(shownEmotion(felt, "tsundere", 0.2, { care: 0.5, people: 2 })).toEqual(a);
  });

  it("a feeling leaks sooner in front of someone she cares about, later in a crowd", () => {
    const f = [reading("joy", 0.78)];
    // Alone: joy leaks at 0.85.
    expect(shownEmotion(f, "tsundere", 0.2)?.tag).toBe("smug");
    // In front of someone she cares about: 0.85 - 0.15 = 0.7.
    expect(shownEmotion(f, "tsundere", 0.2, { care: 1, people: 1 })?.tag).toBe("happy");
    // In a crowd it holds back (0.95).
    expect(shownEmotion([reading("joy", 0.9)], "tsundere", 0.2, { care: 0, people: 5 })?.tag).toBe(
      "smug",
    );
    // Open ignores the audience.
    expect(shownEmotion(f, "open", 0.2, { care: 1, people: 5 })).toEqual(
      shownEmotion(f, "open", 0.2),
    );
  });

  it("the snapshot carries it", () => {
    const r = rig({ temperament: { display: "tsundere" } });
    r.affect.applyEvent(ev("praised", T0, { key: "a" }));
    r.advance(MINUTE);
    r.affect.applyEvent(ev("praised", r.clock.at, { key: "b" }));
    // Joy shows as acting unbothered (smug), not as the happy it is.
    expect(r.affect.snapshot().shown).toMatchObject({ from: "joy", tag: "smug", masked: true });
  });
});

describe("how her feelings lean her behaviour", () => {
  it("joy and pride up, sorrow and frustration down", () => {
    const happy = rig();
    happy.affect.applyEvent(ev("game_won", T0, { key: "w" }));
    const up = happy.affect.snapshot().biases;
    expect(up.talkativeness).toBeGreaterThan(0);
    expect(up.initiative).toBeGreaterThan(0);

    const sad = rig();
    sad.self.feel("sorrow", 0.6, "x");
    sad.advance(11 * MINUTE);
    sad.self.feel("frustration", 0.6, "y");
    const down = sad.affect.snapshot().biases;
    expect(down.talkativeness).toBeLessThan(0);
    expect(down.initiative).toBeLessThan(0);
  });

  it("lonely: wanting someone to talk to ranks first, with the one she cares about most", () => {
    const r = rig();
    r.cares.set("p1", 0.7);
    r.handles.set("p1", "Owen");
    r.cares.set("p2", 0.1);
    r.handles.set("p2", "Amy");
    r.engine.adjust({ social: 1, attention: 1 });
    for (let h = 1; h <= 8; h++) {
      r.advance(HOUR);
      r.self.now();
    }
    // Nothing else is pressing.
    r.engine.adjust({ play: -1, boredom: -1, curiosity: -1, esteem: -1 });
    const wants = r.affect.snapshot().biases.wants;
    expect(wants[0]).toMatchObject({ want: "chat_with", person: "Owen" });
    expect(wants[0]?.weight).toBeGreaterThan(0.4);
  });

  it("missing someone: a strong wish to go find them (the heart's longing)", () => {
    const r = rig();
    r.cares.set("p1", 0.6);
    r.longing.set("p1", 0.7);
    r.handles.set("p1", "Owen");
    const wants = r.affect.snapshot().biases.wants;
    expect(wants.find((w) => w.want === "find_person")).toMatchObject({ person: "Owen" });
  });

  it("drives: play, stream, rest and sing show up when they are high", () => {
    const r = rig();
    r.self.adjust({ play: 0.6, rest: 0.6, esteem: 0.6, attention: 0.6 }, "test");
    const wants = r.affect.snapshot().biases.wants.map((w) => w.want);
    expect(wants).toEqual(expect.arrayContaining(["play", "rest", "sing", "stream"]));
    expect(r.affect.snapshot().biases.talkativeness).toBeLessThan(0);
  });

  it("calm: no biases", () => {
    const b = rig().affect.snapshot().biases;
    expect(b.talkativeness).toBe(0);
    expect(b.wants).toEqual([]);
  });
});

describe("affect.changed", () => {
  it("is published when the mood or her strongest emotions moved, not otherwise", () => {
    const r = rig();
    expect(r.affect.publishIfChanged()).toBe(true);
    expect(r.affect.publishIfChanged()).toBe(false);
    r.affect.applyEvent(ev("game_won", T0, { key: "w" }));
    expect(r.affect.publishIfChanged()).toBe(true);
    expect(r.published.filter((p) => p.topic === "affect.changed")).toHaveLength(2);
  });
});
