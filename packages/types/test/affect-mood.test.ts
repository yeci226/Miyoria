import { describe, expect, it } from "vitest";
import type { Drives } from "../src/index.js";
import {
  affinityLevel,
  affinityStep,
  circadianEnergy,
  deriveMood,
  emotionsLine,
  intensityWord,
  moodLine,
  nightShape,
  RELATIONSHIP_LABELS,
  relationshipLabel,
  renderAffectMood,
  renderPeople,
  renderPersonLine,
  stanceStale,
  toTimestamp,
} from "../src/index.js";

const calm: Drives = {
  social: 0.3,
  play: 0.3,
  attention: 0.3,
  rest: 0.3,
  curiosity: 0.3,
  esteem: 0.3,
  hunger: 0.3,
  longing: 0,
};
const noEmotion = { valence: 0, arousal: 0, energy: 0 };
/** 12:00 local (UTC+8). */
const noon = Date.UTC(2026, 10, 1, 4, 0, 0);
/** 03:00 local. */
const night = Date.UTC(2026, 10, 1, 19, 0, 0);
const base = {
  baseline: { valence: 0.1, arousal: 0.5, energy: 0.8 },
  emotions: noEmotion,
  drives: calm,
  boredom: 0.2,
  nowMs: noon,
  utcOffsetMinutes: 480,
  nightDip: 0.4,
  emotionWeight: 1,
};

describe("derived mood", () => {
  it("is the baseline at midday with nothing going on, and a pure function of its inputs", () => {
    const m = deriveMood(base);
    expect(m.valence).toBeCloseTo(0.1, 6);
    expect(m.arousal).toBeCloseTo(0.5, 6);
    expect(m.energy).toBeCloseTo(0.8, 6);
    expect(deriveMood({ ...base })).toEqual(m);
  });

  it("the hour sets energy and arousal; emotions move valence, arousal and energy", () => {
    const late = deriveMood({ ...base, nowMs: night, drives: { ...calm, rest: 0.7 } });
    expect(late.energy).toBeLessThan(0.55);
    expect(late.arousal).toBeLessThan(0.45);
    const happy = deriveMood({ ...base, emotions: { valence: 0.4, arousal: 0.2, energy: 0.05 } });
    expect(happy.valence).toBeCloseTo(0.5, 6);
    expect(happy.arousal).toBeCloseTo(0.7, 6);
    expect(
      deriveMood({ ...base, emotions: { valence: 0.4, arousal: 0.2, energy: 0 }, emotionWeight: 0 })
        .valence,
    ).toBeCloseTo(0.1, 6);
  });

  it("unmet wants and boredom weigh on valence; tiredness beyond the hour drains energy", () => {
    const wanting = deriveMood({ ...base, drives: { ...calm, social: 1, esteem: 0.9 } });
    expect(wanting.valence).toBeCloseTo(0.1 - 0.25, 6);
    expect(deriveMood({ ...base, boredom: 1 }).valence).toBeCloseTo(0, 6);
    expect(deriveMood({ ...base, drives: { ...calm, rest: 0.9 } }).energy).toBeLessThan(0.8 - 0.1);
  });

  it("stays in range, whatever it is fed", () => {
    const m = deriveMood({
      ...base,
      emotions: { valence: -5, arousal: 9, energy: -9 },
      drives: { ...calm, social: 1, attention: 1, esteem: 1, hunger: 1, rest: 1 },
      boredom: 1,
    });
    expect(m.valence).toBeGreaterThanOrEqual(-1);
    expect(m.arousal).toBeLessThanOrEqual(1);
    expect(m.energy).toBeGreaterThanOrEqual(0);
    expect(circadianEnergy(Number.NaN, noon, 480, 0.4)).toBe(0);
  });

  it("the sleepiness curve", () => {
    expect(nightShape(4)).toBe(1);
    expect(nightShape(12)).toBe(0);
    expect(nightShape(3.5)).toBeCloseTo(0.975, 6);
    expect(nightShape(28)).toBe(nightShape(4));
  });
});

describe("the one mood renderer", () => {
  it("says the mood in one line with one set of thresholds", () => {
    expect(moodLine({ valence: 0.6, arousal: 0.9, energy: 0.2 })).toBe(
      "心情很好、很睏、情緒有點激動",
    );
    expect(moodLine({ valence: 0, arousal: 0.5, energy: 0.4 })).toBe("心情普通、有點累");
    expect(moodLine({ valence: -0.3, arousal: 0.1, energy: 0.9 })).toBe(
      "有點不爽、精神很好、很平靜",
    );
    expect(moodLine({ valence: -0.8, arousal: 0.5, energy: 0.6 })).toBe("心情很差、精神還可以");
    // The same energy gets one sentence, not two that disagree.
    expect(moodLine({ valence: 0.3, arousal: 0.5, energy: 0.4 })).not.toContain("精神普通");
  });

  it("names the strongest emotions in words, never numbers", () => {
    const top = [
      {
        name: "shy" as const,
        intensity: 0.7,
        cause: "他說想聽我唱歌",
        at: toTimestamp(0),
        person: null,
      },
      { name: "joy" as const, intensity: 0.45, cause: "", at: toTimestamp(0), person: null },
      { name: "pride" as const, intensity: 0.25, cause: "", at: toTimestamp(0), person: null },
    ];
    expect(emotionsLine(top)).toBe("害羞(強)、喜(中)、得意(淡)");
    const text = renderAffectMood({ mood_line: "心情不錯、有點累", top });
    expect(text).toBe(
      "你現在心情不錯、有點累。\n心裡比較明顯的感受:害羞(強)、喜(中)、得意(淡)(最明顯的是因為:他說想聽我唱歌)。",
    );
    expect(renderAffectMood({ mood_line: "心情普通、精神還可以", top: [] })).toBe(
      "你現在心情普通、精神還可以。",
    );
    expect([0.1, 0.4, 0.65].map(intensityWord)).toEqual(["淡", "中", "強"]);
  });

  it("one line per person: handle, one-word label, her feeling sentence", () => {
    const card = { handle: "Owen", label: "好朋友" as const, feeling: "他很可靠,\n有點在意。" };
    expect(renderPersonLine(card)).toBe("- Owen:好朋友;他很可靠, 有點在意。");
    expect(renderPersonLine({ ...card, feeling: "" })).toBe("- Owen:好朋友");
    expect(renderPersonLine({ ...card, feeling: "字".repeat(200) }).length).toBeLessThan(110);
    expect(renderPeople([card, { ...card, handle: "Amy", label: "陌生人", feeling: "" }])).toEqual([
      "- Owen:好朋友;他很可靠, 有點在意。",
      "- Amy:陌生人",
    ]);
  });
});

describe("the relationship label scale", () => {
  const grid = [
    [-60, 50, "很討厭"],
    [-20, 50, "討厭"],
    [0, 0, "陌生人"],
    [0, 5, "認識"],
    [20, 0, "朋友"],
    [50, 12, "好朋友"],
    [50, 5, "朋友"],
    [80, 35, "摯友"],
    [80, 20, "好朋友"],
  ] as const;

  it.each(grid)("affinity %s, familiarity %s: %s", (affinity, familiarity, label) => {
    expect(relationshipLabel({ affinity, familiarity })).toBe(label);
    expect(RELATIONSHIP_LABELS).toContain(label);
  });
});

describe("affinityLevel", () => {
  it("is the affinity as a whole number, truncated toward zero, within -100..100", () => {
    expect(affinityLevel(0)).toBe(0);
    expect(affinityLevel(4.9)).toBe(4);
    expect(Object.is(affinityLevel(-0.5), 0)).toBe(true);
    expect(affinityLevel(45)).toBe(45);
    expect(affinityLevel(-60.7)).toBe(-60);
    expect(affinityLevel(250)).toBe(100);
    expect(affinityLevel(-250)).toBe(-100);
    expect(affinityLevel(Number.NaN)).toBe(0);
  });

  it("re-deciding the stance comes every 5 levels", () => {
    expect(affinityStep(4)).toBe(0);
    expect(affinityStep(5)).toBe(1);
    expect(Object.is(affinityStep(-4), 0)).toBe(true);
    expect(affinityStep(-5)).toBe(-1);
    expect(stanceStale(60, 64)).toBe(false);
    expect(stanceStale(64, 65)).toBe(true);
    expect(stanceStale(66, 61)).toBe(true);
  });
});
