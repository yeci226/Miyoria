// What her feelings go on to do (docs/design/v3-architecture.md §12): the weights of
// `EMOTION_OUTPUTS` as numbers, their limits, and the Affect module as the owner of her mood.

import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AffectBiases,
  type Drives,
  EMOTION_NAMES,
  EMOTION_OUTPUTS,
  type EmotionName,
  MOOD_CHANGED_TOPIC,
  MoodSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { computeBiases, MAX_BIAS, MIN_WANT, SelfModule } from "../src/index.js";
import { HOUR, rig, T0 } from "./helpers.js";

const DRIVES: Drives = {
  social: 0,
  play: 0,
  attention: 0,
  rest: 0,
  curiosity: 0,
  esteem: 0,
  hunger: 0,
  longing: 0,
};

type Inputs = Parameters<typeof computeBiases>[0];
const inputs = (p: Partial<Inputs>): Inputs => ({
  emotions: {},
  drives: DRIVES,
  boredom: 0,
  valence: 0,
  cards: [],
  ...p,
});
const card = (handle: string, attachment = 0.5, more: object = {}) => ({
  handle,
  attachment,
  emotions: {},
  blocked: false,
  ...more,
});
const wanted = (b: AffectBiases, want: string) => b.wants.find((w) => w.want === want);

/** Every emotion whose weight of `key` points that way, at its strongest. */
const all = (key: "talk" | "initiative", sign: 1 | -1) =>
  Object.fromEntries(
    EMOTION_NAMES.filter((n) => EMOTION_OUTPUTS[n][key] * sign > 0).map((n) => [n, 1]),
  ) as Partial<Record<EmotionName, number>>;

describe("the weights of the table", () => {
  it("each emotion leans what its row says", () => {
    for (const name of EMOTION_NAMES) {
      const b = computeBiases(inputs({ emotions: { [name]: 0.6 } }));
      const row = EMOTION_OUTPUTS[name];
      expect(Math.sign(b.talkativeness), name).toBe(Math.sign(row.talk));
      expect(Math.sign(b.initiative), name).toBe(Math.sign(row.initiative));
    }
  });

  it("feelings do not add up: the strongest one each way counts", () => {
    const one = computeBiases(inputs({ emotions: { joy: 0.6 } }));
    const two = computeBiases(inputs({ emotions: { joy: 0.6, pride: 0.6, gratitude: 0.6 } }));
    expect(two.talkativeness).toBe(one.talkativeness);
    const mixed = computeBiases(inputs({ emotions: { joy: 0.6, sorrow: 0.6 } }));
    expect(mixed.talkativeness).toBeCloseTo(0);
  });

  it("whatever she feels, the biases stay inside their limits", () => {
    for (const key of ["talk", "initiative"] as const) {
      const up = computeBiases(inputs({ emotions: all(key, 1) }));
      const down = computeBiases(
        inputs({ emotions: all(key, -1), drives: { ...DRIVES, rest: 1 } }),
      );
      const value = key === "talk" ? "talkativeness" : "initiative";
      expect(up[value]).toBeLessThanOrEqual(MAX_BIAS);
      expect(down[value]).toBeGreaterThanOrEqual(-MAX_BIAS);
    }
  });

  it("background feelings lean nothing", () => {
    const b = computeBiases(inputs({ emotions: { pride: 0.12, sorrow: 0.1 } }));
    expect(b).toEqual({ talkativeness: 0, initiative: 0, wants: [] });
  });
});

describe("what she wants because of it", () => {
  it("each row with a wish lists it", () => {
    const cards = [card("Owen")];
    for (const name of EMOTION_NAMES) {
      const row = EMOTION_OUTPUTS[name].want;
      if (row === null) continue;
      const b = computeBiases(inputs({ emotions: { [name]: 0.8 }, cards }));
      expect(wanted(b, row.want), name).toMatchObject({ why: row.why, from: name });
    }
  });

  it("a wish about someone goes to who stirred it, else to the closest one", () => {
    const cards = [card("Owen", 0.8), card("Amy", 0.3)];
    const stirred = computeBiases(
      inputs({ emotions: { gratitude: 0.8 }, causes: { gratitude: "Amy" }, cards }),
    );
    expect(wanted(stirred, "chat_with")?.person).toBe("Amy");
    const nobody = computeBiases(inputs({ emotions: { gratitude: 0.8 }, cards }));
    expect(wanted(nobody, "chat_with")?.person).toBe("Owen");
  });

  it("never someone blocked", () => {
    const cards = [card("Troll", 0.9, { blocked: true }), card("Owen", 0.4)];
    const b = computeBiases(
      inputs({ emotions: { jealousy: 0.9 }, causes: { jealousy: "Troll" }, cards }),
    );
    expect(wanted(b, "chat_with")?.person).toBe("Owen");
  });

  it("two feelings about the same thing are one wish, the stronger one", () => {
    const b = computeBiases(
      inputs({ emotions: { sorrow: 0.5, lonely: 0.9 }, cards: [card("Owen")] }),
    );
    expect(b.wants.filter((w) => w.want === "chat_with")).toHaveLength(1);
    expect(wanted(b, "chat_with")).toMatchObject({ weight: 0.9, from: "lonely" });
  });

  it("a feeling toward someone in particular points at them", () => {
    const cards = [card("Owen", 0.8), card("Amy", 0.3, { emotions: { gratitude: 0.7 } })];
    const b = computeBiases(inputs({ cards }));
    expect(b.wants).toEqual([
      expect.objectContaining({ want: "chat_with", person: "Amy", from: "gratitude" }),
    ]);
    expect(b.wants[0]?.weight).toBeGreaterThanOrEqual(MIN_WANT);
  });
});

describe("an extreme state", () => {
  it("fades on its own: nothing she feels leans her for good", () => {
    const r = rig();
    for (const name of ["sorrow", "frustration", "fear", "disgust"] as const) {
      for (let i = 0; i < 5; i++) r.self.feel(name, 1, `${name} ${i}`);
      r.advance(11 * 60_000);
    }
    expect(r.affect.snapshot().biases.talkativeness).toBeLessThan(0);
    const calm = rig();
    calm.advance(44 * 60_000 + 48 * HOUR);
    r.advance(48 * HOUR);
    // Two days on she is as tired as anyone who felt nothing, and leans no further than that.
    const later = r.affect.snapshot().biases;
    const without = calm.affect.snapshot().biases;
    expect(later.talkativeness).toBeCloseTo(without.talkativeness, 1);
    expect(later.initiative).toBeCloseTo(without.initiative, 1);
  });

  it("a masked feeling still leans her: display rules hide it, they do not undo it", () => {
    const r = rig({ temperament: { display: "tsundere" } });
    r.self.feel("lonely", 1, "沒人理我");
    const snap = r.affect.snapshot();
    expect(snap.shown?.tag).toBe("neutral");
    expect(wanted(snap.biases, "chat_with")).toBeDefined();
  });
});

describe("Appraise, the one reader of what an interaction meant", () => {
  it("a promise counts toward the person, through the same call", () => {
    const r = rig();
    r.attitudes.set("p1", { affinity: 40, familiarity: 20 });
    r.handles.set("p1", "Owen");
    const at = toTimestamp(T0);
    r.affect.appraise({
      source: "appraise",
      events: [],
      promises: [{ toward: "Owen", kept: false, cause: "Owen食言了" }],
      context: null,
      at,
    });
    expect(r.self.heart("p1")?.emotions.resentment ?? 0).toBeGreaterThan(0);
    r.affect.appraise({
      source: "appraise",
      events: [],
      promises: [{ toward: "Owen", kept: true, cause: "Owen說到做到" }],
      context: null,
      at,
    });
    expect(r.self.heart("p1")?.emotions.gratitude ?? 0).toBeGreaterThan(0);
  });

  it("a promise about nobody she knows is dropped, and at most two count", () => {
    const r = rig();
    r.handles.set("p1", "Owen");
    r.affect.appraise({
      source: "appraise",
      events: [],
      promises: [
        { toward: "Nobody", kept: false, cause: "" },
        { toward: "Owen", kept: false, cause: "a" },
        { toward: "Owen", kept: false, cause: "b" },
      ],
      context: null,
      at: toTimestamp(T0),
    });
    const once = r.self.heart("p1")?.emotions.resentment ?? 0;
    expect(once).toBeGreaterThan(0);
    const fresh = rig();
    fresh.handles.set("p1", "Owen");
    fresh.affect.appraise({
      source: "appraise",
      events: [],
      promises: [
        { toward: "Owen", kept: false, cause: "a" },
        { toward: "Owen", kept: false, cause: "b" },
        { toward: "Owen", kept: false, cause: "c" },
      ],
      context: null,
      at: toTimestamp(T0),
    });
    expect(fresh.self.heart("p1")?.emotions.resentment ?? 0).toBeGreaterThan(once);
  });
});

describe("her mood belongs to the Affect module", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("serves it, and it is the mood of the snapshot", async () => {
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    await sup.register(new SelfModule("p"), null, true);
    await sup.startAll();
    expect(sup.services.ownerOf(MoodSignalsKey)).toBe("self");
    expect(sup.services.require(MoodSignalsKey).mood()).toEqual(
      expect.objectContaining({ valence: expect.any(Number), energy: expect.any(Number) }),
    );
    await sup.stopAll();
    expect(sup.services.has(MoodSignalsKey)).toBe(false);
  });

  it("publishes `mood.changed` when the mood moved, and not for the first reading", () => {
    const r = rig();
    const moods = () => r.published.filter((p) => p.topic === MOOD_CHANGED_TOPIC);
    r.affect.publishIfChanged();
    expect(moods()).toEqual([]);
    r.affect.publishIfChanged();
    expect(moods()).toEqual([]);
    for (let i = 0; i < 4; i++) r.self.feel("sorrow", 1, `${i}`);
    r.affect.publishIfChanged();
    expect(moods()).toHaveLength(1);
    expect(moods()[0]?.payload).toMatchObject({
      reason: "affect",
      valence: r.affect.mood().valence,
    });
  });
});
