// §12, as a check on the real consumers: an emotion is only worth keeping if something consumes it.
// Each emotion goes in, and what comes out is read where it really comes out: the clip the voice
// sink asks the worker for, the message the Stage gets, the Floor's budget, Plan's list and its
// heartbeat. A new emotion, or a row that no longer reaches anything, fails here.

import { fileURLToPath } from "node:url";
import { ArbiterModule, FloorConfigSchema, FloorCore } from "@miyoria/brain/arbiter";
import { computeBiases, MAX_BIAS, SelfModule, shownEmotion } from "@miyoria/heart/self";
import { EventLogService } from "@miyoria/memory/facts";
import { Supervisor } from "@miyoria/runtime/kernel";
import { Profile } from "@miyoria/runtime/profile";
import { Forwarder } from "@miyoria/stage";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AffectSnapshot,
  AffectStateKey,
  type ContextKey,
  type Drives,
  EMOTION_NAMES,
  EMOTION_OUTPUTS,
  type EmotionName,
  EventLogKey,
  Events,
  eventEnvelope,
  FLOOR_CLAIMS,
  FloorKey,
  MoodSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { VoiceProfile } from "@miyoria/voice/voice";
import { afterEach, describe, expect, it } from "vitest";

const NOW = Date.UTC(2026, 10, 7, 6);
const NOTICE = 0.2;
const ROOM: ContextKey = { platform: "t", scope: "g", channel: "v", kind: "voice" };
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
/** Someone she cares about (the heart's 在意), and how much she misses them. */
type Cared = { handle: string; longing: number };
const OWEN: Cared = { handle: "Owen", longing: 0 };

const PROFILE = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const voice = VoiceProfile.parse("deepseek-chan", (await Profile.loadDir(PROFILE)).voice);

function floorWith(feeling: number): FloorCore {
  return new FloorCore(FloorConfigSchema.parse({}), 3, {
    now: () => NOW,
    humans: () => 2,
    feeling: () => feeling,
  });
}

function snapshotOf(felt: Partial<Record<EmotionName, number>>, display: "open" | "tsundere") {
  const readings = (Object.entries(felt) as [EmotionName, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([name, intensity]) => ({
      name,
      intensity,
      cause: "x",
      at: toTimestamp(NOW),
      person: null,
    }));
  const biases = computeBiases({
    emotions: felt,
    drives: DRIVES,
    boredom: 0,
    valence: 0,
    people: [OWEN],
  });
  return {
    at: toTimestamp(NOW),
    drives: DRIVES,
    boredom: 0,
    top: readings,
    mood: { valence: 0, arousal: 0.5, energy: 0.7 },
    mood_line: "心情普通",
    shown: shownEmotion(readings, display, NOTICE),
    biases,
  } satisfies AffectSnapshot;
}

/** What her own starts read of her feelings (`biases`: the initiative's mood weight and wants). */
const lean = (s: AffectSnapshot) => JSON.stringify([s.biases.initiative, s.biases.wants]);

type Output = "voice" | "expression" | "talk" | "initiative";

/** Which real outputs `felt` changes, against her feeling nothing. */
function reached(
  felt: Partial<Record<EmotionName, number>>,
  display: "open" | "tsundere",
): Output[] {
  const calm = snapshotOf({}, display);
  const now = snapshotOf(felt, display);
  const out: Output[] = [];
  const tag = now.shown?.tag ?? null;
  const clip = tag === null ? null : voice.referenceFor(tag);
  if (clip !== null && clip !== "neutral") out.push("voice");
  const stage = new Forwarder(false).onEvent(
    eventEnvelope("test", Events.AffectChanged, now as never),
  );
  if (stage.some((m) => m.type === "emotion" && m.resting === true && m.name !== "neutral")) {
    out.push("expression");
  }
  const budget = (s: AffectSnapshot) => floorWith(s.biases.talkativeness).budget(ROOM).allowed;
  if (budget(now) !== budget(calm)) out.push("talk");
  if (lean(now) !== lean(calm)) out.push("initiative");
  return out;
}

describe("every emotion reaches a real output", () => {
  it.each(EMOTION_NAMES)("%s: shown openly, her voice and her face follow it", (name) => {
    expect(reached({ [name]: 0.8 }, "open")).toEqual(
      expect.arrayContaining(["voice", "expression"]),
    );
  });

  it.each(EMOTION_NAMES)("%s: at least one output, also when she hides it", (name) => {
    expect(reached({ [name]: 0.8 }, "tsundere")).not.toEqual([]);
  });

  it.each(EMOTION_NAMES)("%s: what the table says is what happens", (name) => {
    const row = EMOTION_OUTPUTS[name];
    const out = reached({ [name]: 1 }, "open");
    if (row.talk !== 0) expect(out).toContain("talk");
    if (row.initiative !== 0 || row.want !== null) expect(out).toContain("initiative");
  });

  it("missing someone she cares about (the heart's longing) changes what she wants about them", () => {
    const lonely = { emotions: { lonely: 0.5 }, drives: DRIVES, boredom: 0, valence: 0 };
    const snapshot = snapshotOf({ lonely: 0.5 }, "open");
    const biases = computeBiases({ ...lonely, people: [{ ...OWEN, longing: 0.9 }] });
    expect(lean({ ...snapshot, biases })).not.toEqual(lean(snapshot));
  });

  it("the guard itself: a row that reaches nothing is caught", () => {
    const row = EMOTION_OUTPUTS.surprise;
    const dead = { ...row, tag: "neutral", voice: ["neutral"], talk: 0, initiative: 0, want: null };
    const table = EMOTION_OUTPUTS as Record<EmotionName, typeof row>;
    table.surprise = dead;
    try {
      expect(reached({ surprise: 0.8 }, "open")).toEqual([]);
    } finally {
      table.surprise = row;
    }
  });
});

describe("an extreme state", () => {
  const everything = (sign: 1 | -1) =>
    Object.fromEntries(
      EMOTION_NAMES.filter((n) => EMOTION_OUTPUTS[n].talk * sign > 0).map((n) => [n, 1]),
    ) as Partial<Record<EmotionName, number>>;

  it("does not make her silent for good", () => {
    const worst = snapshotOf(everything(-1), "open");
    expect(worst.biases.talkativeness).toBe(-MAX_BIAS);
    const floor = floorWith(worst.biases.talkativeness);
    expect(floor.budget(ROOM).allowed).toBeGreaterThanOrEqual(1);
    expect(floor.check("wish", ROOM)).toBeNull();
    for (const kind of ["addressed", "reply", "result", "urgent"] as const) {
      expect(floor.check(kind, ROOM), kind).toBeNull();
    }
  });

  it("does not flood the room", () => {
    const best = snapshotOf(everything(1), "open");
    expect(best.biases.talkativeness).toBe(MAX_BIAS);
    const config = FloorConfigSchema.parse({});
    const allowed = floorWith(best.biases.talkativeness).budget(ROOM).allowed;
    expect(allowed).toBeLessThanOrEqual(config.budget.base_lines * config.max_feeling_multiplier);
  });

  it("changes nothing about who may cut in", () => {
    const levels = (f: FloorCore) =>
      FLOOR_CLAIMS.flatMap((a) => FLOOR_CLAIMS.map((b) => f.interruptLevel(a, b)));
    expect(levels(floorWith(1))).toEqual(levels(floorWith(0)));
    expect(levels(floorWith(-1))).toEqual(levels(floorWith(0)));
  });
});

describe("the Affect module", () => {
  const running: Supervisor[] = [];
  afterEach(async () => {
    for (const sup of running.splice(0)) await sup.stopAll();
  });

  async function boot() {
    const sup = new Supervisor();
    running.push(sup);
    sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    sup.services.provide("app", EventLogKey, new EventLogService({ profile: "p", store: null }));
    const baseline = { valence: 0, arousal: 0.5, energy: 0.8 };
    // The order of the catalog.
    await sup.register(new SelfModule("p", { baseline }), null, true);
    await sup.register(new ArbiterModule("p"), null, true);
    await sup.startAll();
    return sup;
  }

  it("owns her mood", async () => {
    const sup = await boot();
    expect(sup.services.ownerOf(MoodSignalsKey)).toBe("self");
    const affect = sup.services.require(AffectStateKey);
    expect(sup.services.require(MoodSignalsKey).mood()).toEqual(affect.snapshot().mood);
  });

  it("gives the panel the same snapshot", async () => {
    const sup = await boot();
    const snapshot = sup.services.require(AffectStateKey).snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      "at",
      "biases",
      "boredom",
      "drives",
      "mood",
      "mood_line",
      "shown",
      "top",
    ]);
    expect(Object.keys(snapshot.biases).sort()).toEqual(["initiative", "talkativeness", "wants"]);
  });

  it("reaches the Floor", async () => {
    const sup = await boot();
    const floor = sup.services.get(FloorKey);
    expect(floor?.budget(ROOM).allowed).toBe(6);
    sup.services.provide("app", AffectStateKey, {
      snapshot: () => ({ biases: { talkativeness: -MAX_BIAS } }),
    } as never);
    expect(floor?.budget(ROOM).allowed).toBe(3);
  });
});
