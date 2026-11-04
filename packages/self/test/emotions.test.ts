import type { EmotionReading } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { selfConfig } from "../src/config.js";
import { shownEmotion } from "../src/display.js";
import { EmotionEngine, temperament } from "../src/emotions.js";
import { IDLE, REST_OVER_TIREDNESS, SelfEngine } from "../src/engine.js";
import { HeartBook } from "../src/heart.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const base = temperament().temperament;
/** DeepSeek-chan's temperament (profiles/deepseek-chan/profile.toml). */
const tsundere = temperament({
  display: "tsundere",
  emotions: {
    shy: { gain: 1.8, half_life_mins: 12 },
    pride: { gain: 1.6, half_life_mins: 40 },
    anger: { gain: 1.4, half_life_mins: 6 },
    missing: { gain: 0.5, half_life_mins: 720 },
  },
}).temperament;

const reading = (name: EmotionReading["name"], intensity: number): EmotionReading => ({
  name,
  intensity,
  cause: "",
  at: "",
  person: null,
});

describe("emotions", () => {
  it("coexist and fade each at its own pace", () => {
    const e = new EmotionEngine(base, 0.03, T0);
    e.feel("joy", 0.6, "被誇", null, T0);
    e.feel("shy", 0.6, "被誇", null, T0);
    expect(e.readings(T0, 0.2).map((r) => r.name)).toEqual(["joy", "shy"]);
    // Shy halves in 10 minutes, joy in 30.
    expect(e.value("shy", T0 + 10 * MINUTE)).toBeCloseTo(0.3, 6);
    expect(e.value("joy", T0 + 30 * MINUTE)).toBeCloseTo(0.3, 6);
    expect(e.readings(T0 + 30 * MINUTE, 0.2).map((r) => r.name)).toEqual(["joy"]);
    // Far below the floor: forgotten.
    e.advance(T0 + 5 * HOUR);
    expect(e.readings(T0 + 5 * HOUR, 0)).toEqual([]);
  });

  it("saturate when stirred again, calm when told, and survive a restart", () => {
    const e = new EmotionEngine(base, 0.03, T0);
    e.feel("anger", 0.5, "被罵", "p1", T0);
    e.feel("anger", 0.5, "又被罵", "p1", T0);
    expect(e.value("anger", T0)).toBeCloseTo(0.75, 6);
    e.feel("anger", 1, "一直被罵", "p1", T0);
    expect(e.value("anger", T0)).toBe(1);
    e.feel("anger", -0.4, "", null, T0);
    expect(e.value("anger", T0)).toBeCloseTo(0.6, 6);
    expect(e.readings(T0, 0)[0]).toMatchObject({ cause: "一直被罵", person: "p1" });

    const copy = new EmotionEngine(base, 0.03, T0);
    copy.restore(e.toJson(), T0 + 15 * MINUTE);
    expect(copy.value("anger", T0 + 15 * MINUTE)).toBeCloseTo(0.3, 6);
  });

  it("move the mood: joy up, sorrow down, bounded", () => {
    const e = new EmotionEngine(base, 0.03, T0);
    e.feel("joy", 0.8, "", null, T0);
    expect(e.affect(T0).valence).toBeCloseTo(0.4, 6);
    e.feel("sorrow", 1, "", null, T0);
    e.feel("lonely", 1, "", null, T0);
    e.feel("jealousy", 1, "", null, T0);
    expect(e.affect(T0).valence).toBeGreaterThanOrEqual(-0.7);
    expect(e.affect(T0).valence).toBeLessThan(0);
  });
});

describe("temperament", () => {
  it("is per profile: 害羞 fast, 得意 strong, 怒 fast, 想念 slow", () => {
    const shy = new EmotionEngine(tsundere, 0.03, T0);
    const plain = new EmotionEngine(base, 0.03, T0);
    for (const e of [shy, plain]) {
      e.feel("shy", 0.3, "", null, T0);
      e.feel("pride", 0.3, "", null, T0);
      e.feel("missing", 0.3, "", null, T0);
      e.feel("anger", 0.3, "", null, T0);
    }
    expect(shy.value("shy", T0)).toBeCloseTo(0.54, 6);
    expect(plain.value("shy", T0)).toBeCloseTo(0.3, 6);
    expect(shy.value("pride", T0)).toBeGreaterThan(plain.value("pride", T0));
    expect(shy.value("missing", T0)).toBeCloseTo(0.15, 6);
    // Anger comes fast and goes fast: halved in 6 minutes instead of 15.
    expect(shy.value("anger", T0 + 6 * MINUTE)).toBeCloseTo(shy.value("anger", T0) / 2, 6);
    // ...and 想念 toward someone uses the same temperament.
    expect(tsundere.toward.missing).toEqual({ gain: 0.5, halfLifeMins: 720 });
  });

  it("reports names that are not emotions", () => {
    const t = temperament({ emotions: { love: { gain: 2 }, resentment: { half_life_mins: 60 } } });
    expect(t.unknown).toEqual(["love"]);
    expect(t.temperament.toward.resentment.halfLifeMins).toBe(60);
    expect(t.temperament.display).toBe("open");
  });
});

describe("display rules", () => {
  it("tsundere: felt 害羞 shows as 嫌棄, with a blush when strong", () => {
    expect(shownEmotion([reading("shy", 0.7)], "tsundere", 0.2)).toEqual({
      from: "shy",
      tag: "embarrassed",
      style: "兇回去、嫌棄對方,但臉紅了",
      masked: false,
    });
    expect(shownEmotion([reading("shy", 0.3)], "tsundere", 0.2)).toMatchObject({
      tag: "annoyed",
      masked: true,
    });
  });

  it("tsundere: 想念 is 「才沒有在等你」, 喜 shows as smug, strong 哀 leaks", () => {
    const missing = shownEmotion([reading("missing", 0.5)], "tsundere", 0.2);
    expect(missing?.style).toContain("才沒有在等你");
    expect(missing).toMatchObject({ tag: "annoyed", masked: true });
    expect(shownEmotion([reading("joy", 0.5)], "tsundere", 0.2)?.tag).toBe("smug");
    expect(shownEmotion([reading("joy", 0.9)], "tsundere", 0.2)?.tag).toBe("happy");
    expect(shownEmotion([reading("sorrow", 0.4)], "tsundere", 0.2)?.tag).toBe("annoyed");
    expect(shownEmotion([reading("sorrow", 0.8)], "tsundere", 0.2)?.tag).toBe("sad");
    // Anger is not hidden.
    expect(shownEmotion([reading("anger", 0.5)], "tsundere", 0.2)?.masked).toBe(false);
  });

  it("open shows what she feels; nothing noticeable shows nothing", () => {
    expect(shownEmotion([reading("missing", 0.5)], "open", 0.2)).toMatchObject({
      tag: "sad",
      masked: false,
    });
    expect(shownEmotion([reading("joy", 0.1)], "tsundere", 0.2)).toBeNull();
    expect(shownEmotion([], "tsundere", 0.2)).toBeNull();
  });
});

describe("romance and crush", () => {
  const book = (now = T0) => new HeartBook(selfConfig().heart, base, 480, 20 * HOUR, now);

  it("the crush is the highest romance above the threshold, or nobody", () => {
    const h = book();
    h.romance("a", 0.06, T0);
    expect(h.crush(T0)).toBeNull();
    // Romance gains are limited per local day.
    h.romance("a", 0.5, T0);
    expect(h.romanceOf("a")).toBeCloseTo(0.06, 2);
    let t = T0;
    for (let day = 1; day <= 8; day++) {
      t = T0 + day * DAY;
      h.romance("a", 0.06, t);
    }
    expect(h.romanceOf("a")).toBeGreaterThan(0.35);
    expect(h.crush(t)?.person).toBe("a");
  });

  it("changes only when someone clearly passes the current one, and can fall to nobody", () => {
    const h = book();
    for (let d = 0; d < 9; d++) {
      h.romance("a", 0.06, T0 + d * DAY);
      h.romance("b", 0.06, T0 + d * DAY);
    }
    const t = T0 + 9 * DAY;
    const a = h.romanceOf("a");
    expect(h.romanceOf("b")).toBeCloseTo(a, 6);
    expect(h.crush(t)?.person).toBe("a");
    // b a little ahead: not enough.
    h.romance("b", 0.03, t);
    expect(h.crush(t)?.person).toBe("a");
    // a hurt her: b takes the place.
    h.romance("a", -0.3, t);
    expect(h.crush(t)?.person).toBe("b");
    h.romance("b", -1, t);
    expect(h.crush(t)).toBeNull();
    // It fades slowly on its own.
    h.romance("c", 0.06, t);
    h.advance(t + 45 * DAY);
    expect(h.romanceOf("c")).toBeCloseTo(0.03, 2);
  });

  it("persists the people and the crush", () => {
    const h = book();
    for (let d = 0; d < 9; d++) h.romance("a", 0.06, T0 + d * DAY);
    h.seen("a", "Owen", true, T0 + 9 * DAY);
    h.feel("a", "gratitude", 0.5, T0 + 9 * DAY);
    const copy = book(T0 + 9 * DAY);
    copy.restore(h.toJson(), T0 + 9 * DAY);
    expect(copy.crush(T0 + 9 * DAY)).toMatchObject({ person: "a", name: "Owen" });
    expect(copy.heart("a", T0 + 9 * DAY)?.emotions.gratitude).toBeCloseTo(0.5, 6);
  });
});

describe("drives and emotions", () => {
  /** An engine whose crush is `a`. */
  function withCrush(): SelfEngine {
    const e = new SelfEngine(selfConfig(), T0, base);
    for (let d = 0; d < 10; d++) e.hearts.romance("a", 0.06, T0 - (10 - d) * DAY);
    e.hearts.seen("a", "Owen", true, T0);
    expect(e.hearts.crush(T0)?.person).toBe("a");
    return e;
  }

  it("longing rises while the crush is away and is satisfied by time together", () => {
    const e = withCrush();
    expect(e.drives().longing).toBe(0);
    e.advance(T0 + 4 * HOUR, IDLE);
    const away = e.drives().longing;
    expect(away).toBeGreaterThan(0.2);
    e.advance(T0 + 5 * HOUR, { ...IDLE, crushTogether: true });
    expect(e.drives().longing).toBeLessThan(0.05);

    // Without a crush there is nobody to long for.
    const nobody = new SelfEngine(selfConfig(), T0, base);
    nobody.adjust({ longing: 0.8 });
    nobody.advance(T0 + 6 * HOUR, IDLE);
    expect(nobody.drives().longing).toBeCloseTo(0.4, 6);
  });

  it("her nudges lift rest only a little above how tired she is", () => {
    const e = new SelfEngine(selfConfig(), T0, base);
    e.advance(T0 + 6 * HOUR, { ...IDLE, energy: 0.75 });
    const tired = e.drives().rest;
    expect(tired).toBeCloseTo(0.25, 1);
    for (let i = 0; i < 20; i++) e.adjust({ rest: 0.12 });
    expect(e.drives().rest).toBeCloseTo(1 - 0.75 + REST_OVER_TIREDNESS, 6);
    // Satisfying it still works.
    e.adjust({ rest: -0.3 });
    expect(e.drives().rest).toBeCloseTo(1 - 0.75 + REST_OVER_TIREDNESS - 0.3, 6);
  });

  it("longing unmet for long turns into 想念, kept while it lasts", () => {
    const e = withCrush();
    // The longing alone (not yet an absence: no care function) builds 想念 over a day or two.
    for (let h = 1; h <= 48; h++) e.advance(T0 + h * HOUR, IDLE);
    const felt = e.emotions.readings(T0 + 48 * HOUR, 0.1);
    expect(felt.find((r) => r.name === "missing")?.person).toBe("a");
    // Together again: the pressure is gone and the feeling starts to fade.
    const before = e.emotions.value("missing", T0 + 48 * HOUR);
    e.advance(T0 + 54 * HOUR, { ...IDLE, crushTogether: true });
    expect(e.emotions.value("missing", T0 + 54 * HOUR)).toBeLessThan(before);
  });

  it("someone she cares about away for days is missed, and it does not fade while they are away", () => {
    const e = new SelfEngine(selfConfig(), T0, base);
    e.hearts.seen("b", "Bob", true, T0);
    const care = { ...IDLE, care: (p: string) => (p === "b" ? 0.8 : 0) };
    e.advance(T0 + 10 * HOUR, care);
    expect(e.hearts.emotion("b", "missing", T0 + 10 * HOUR)).toBe(0);
    for (let h = 21; h <= 24 * 4; h++) e.advance(T0 + h * HOUR, care);
    const missing = e.hearts.emotion("b", "missing", T0 + 4 * DAY);
    expect(missing).toBeGreaterThan(0.3);
    expect(missing).toBeLessThanOrEqual(0.8);
    expect(e.emotions.value("missing", T0 + 4 * DAY)).toBeCloseTo(missing, 2);
    // Someone she does not care about is not missed.
    const other = new SelfEngine(selfConfig(), T0, base);
    other.hearts.seen("c", "C", true, T0);
    other.advance(T0 + 4 * DAY, { ...IDLE, care: () => 0 });
    expect(other.hearts.emotion("c", "missing", T0 + 4 * DAY)).toBe(0);
  });

  it("ignored for a long time: 寂寞; esteem and hunger unmet: 不甘心", () => {
    const e = new SelfEngine(selfConfig(), T0, base);
    e.adjust({ social: 1, hunger: 1 });
    for (let h = 1; h <= 6; h++) e.advance(T0 + h * HOUR, IDLE);
    expect(e.emotions.value("lonely", T0 + 6 * HOUR)).toBeGreaterThan(0.4);
    expect(e.emotions.value("frustration", T0 + 6 * HOUR)).toBeGreaterThan(0.2);
    // Once met, it fades at its own pace instead of vanishing.
    e.adjust({ social: -1 });
    e.advance(T0 + 7 * HOUR, IDLE);
    const lonely = e.emotions.value("lonely", T0 + 7 * HOUR);
    expect(lonely).toBeGreaterThan(0.3);
    e.advance(T0 + 15 * HOUR, IDLE);
    expect(e.emotions.value("lonely", T0 + 15 * HOUR)).toBeCloseTo(lonely / 4, 2);
  });

  it("saves and restores emotions, hearts and the new drives", () => {
    const e = withCrush();
    e.emotions.feel("pride", 0.5, "唱完一首歌", null, T0);
    e.adjust({ esteem: 0.2 });
    const copy = new SelfEngine(selfConfig(), T0, base);
    expect(copy.restore(e.toJson(), T0)).toBe(true);
    expect(copy.emotions.value("pride", T0)).toBeCloseTo(0.5, 6);
    expect(copy.drives().esteem).toBeCloseTo(0.5, 6);
    expect(copy.hearts.crush(T0)?.person).toBe("a");
    // Records saved before emotions existed still load.
    const old = e.toJson() as Record<string, unknown>;
    delete old.emotions;
    delete old.hearts;
    delete old.pressure;
    (old.drives as Record<string, unknown>).longing = undefined;
    expect(
      new SelfEngine(selfConfig(), T0, base).restore(JSON.parse(JSON.stringify(old)), T0),
    ).toBe(true);
  });
});
