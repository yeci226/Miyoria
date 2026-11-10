// §12, as a check on the real consumers: an emotion is only worth keeping if something consumes it.
// Each emotion goes in, and what comes out is read where it really comes out: the clip the voice
// sink asks the worker for, the message the Stage gets, the Floor's budget, Plan's list and its
// heartbeat. A new emotion, or a row that no longer reaches anything, fails here.

import { fileURLToPath } from "node:url";
import { ArbiterModule, FloorConfigSchema, FloorCore } from "@miyoria/arbiter";
import { EventLogService } from "@miyoria/facts";
import { Supervisor } from "@miyoria/kernel";
import { heartbeatMs, mindConfig, rankDesires } from "@miyoria/mind";
import { Profile } from "@miyoria/profile";
import { computeBiases, MAX_BIAS, SelfModule, shownEmotion } from "@miyoria/self";
import { MoodModule } from "@miyoria/social";
import { Forwarder } from "@miyoria/stage";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AffectSnapshot,
  AffectStateKey,
  type ContextKey,
  customEvent,
  type Drives,
  EMOTION_NAMES,
  EMOTION_OUTPUTS,
  type EmotionName,
  EventLogKey,
  FLOOR_CLAIMS,
  FloorKey,
  type JsonValue,
  MoodSignalsKey,
  PERSON_EMOTION_NAMES,
  type PersonCard,
  type Pipeline,
  PipelineKey,
  toTimestamp,
} from "@miyoria/types";
import { VoiceProfile } from "@miyoria/voice";
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
type Card = Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">;
const OWEN: Card = { handle: "Owen", attachment: 0.8, emotions: {}, blocked: false };

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
    cards: [OWEN],
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

const desires = (snapshot: AffectSnapshot, cards: readonly Card[] = [OWEN]) =>
  rankDesires({
    affect: snapshot,
    cards,
    where: () => "online",
    goals: [],
    fired: new Set(),
    capabilities: new Set(["chat.start", "chat.dm", "game.start", "sing.request"]),
    activity: null,
    inVoice: false,
    cared: 0.9,
  }).map((d) => `${d.want}:${d.person ?? ""}:${d.weight}`);

const beat = (s: AffectSnapshot) =>
  heartbeatMs(
    {
      urge: 0,
      emptyStreak: 0,
      quiet: false,
      budget: "ok",
      initiative: s.biases.initiative,
    },
    mindConfig(),
  );

type Output = "voice" | "expression" | "talk" | "planner";

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
    customEvent("affect.changed", now as unknown as JsonValue),
  );
  if (stage.some((m) => m.type === "emotion" && m.resting === true && m.name !== "neutral")) {
    out.push("expression");
  }
  const budget = (s: AffectSnapshot) => floorWith(s.biases.talkativeness).budget(ROOM).allowed;
  if (budget(now) !== budget(calm)) out.push("talk");
  const plan = (s: AffectSnapshot) => JSON.stringify([desires(s), beat(s)]);
  if (plan(now) !== plan(calm)) out.push("planner");
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
    if (row.initiative !== 0 || row.want !== null) expect(out).toContain("planner");
  });

  it.each(PERSON_EMOTION_NAMES)("%s toward someone changes what she wants about them", (name) => {
    // She wants company: what she feels toward him changes what that means for him.
    const lonely = { emotions: { lonely: 0.5 }, drives: DRIVES, boredom: 0, valence: 0 };
    const snapshot = snapshotOf({ lonely: 0.5 }, "open");
    const cards: Card[] = [{ ...OWEN, emotions: { [name]: 0.9 } }];
    const biases = computeBiases({ ...lonely, cards });
    expect(desires({ ...snapshot, biases }, cards)).not.toEqual(desires(snapshot));
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
    // Plan keeps thinking about what she wants, and it is not nothing.
    expect(beat(worst)).not.toBeNull();
    expect(desires(worst).length).toBeGreaterThan(0);
  });

  it("does not flood the room", () => {
    const best = snapshotOf(everything(1), "open");
    expect(best.biases.talkativeness).toBe(MAX_BIAS);
    const config = FloorConfigSchema.parse({});
    const allowed = floorWith(best.biases.talkativeness).budget(ROOM).allowed;
    expect(allowed).toBeLessThanOrEqual(config.budget.base_lines * config.max_feeling_multiplier);
    expect(beat(best)).toBeGreaterThanOrEqual(mindConfig().min_heartbeat_mins * 60_000);
  });

  it("changes nothing about who may cut in", () => {
    const levels = (f: FloorCore) =>
      FLOOR_CLAIMS.flatMap((a) => FLOOR_CLAIMS.map((b) => f.interruptLevel(a, b)));
    expect(levels(floorWith(1))).toEqual(levels(floorWith(0)));
    expect(levels(floorWith(-1))).toEqual(levels(floorWith(0)));
  });
});

describe.each(["v2", "v3"] as const)(
  "the Affect module under pipeline %s",
  (pipeline: Pipeline) => {
    const running: Supervisor[] = [];
    afterEach(async () => {
      for (const sup of running.splice(0)) await sup.stopAll();
    });

    async function boot() {
      const sup = new Supervisor();
      running.push(sup);
      sup.services.provide("app", PipelineKey, { pipeline });
      sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
      if (pipeline === "v3") {
        sup.services.provide(
          "app",
          EventLogKey,
          new EventLogService({ profile: "p", store: null }),
        );
      }
      const baseline = { valence: 0, arousal: 0.5, energy: 0.8 };
      // The order of the catalog.
      await sup.register(new MoodModule("p", baseline), null, true);
      await sup.register(new SelfModule("p", { baseline }), null, true);
      await sup.register(new ArbiterModule("p"), null, true);
      await sup.startAll();
      return sup;
    }

    it("owns her mood; `mood` is running and idle, whichever pipeline runs", async () => {
      const sup = await boot();
      expect(sup.services.ownerOf(MoodSignalsKey)).toBe("self");
      const affect = sup.services.require(AffectStateKey);
      expect(sup.services.require(MoodSignalsKey).mood()).toEqual(affect.snapshot().mood);
      expect(sup.list().find((m) => m.id === "mood")?.state).toBe("running");
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

    it("reaches the Floor only where there is one", async () => {
      const sup = await boot();
      const floor = sup.services.get(FloorKey);
      if (pipeline === "v2") {
        expect(floor).toBeUndefined();
        return;
      }
      expect(floor?.budget(ROOM).allowed).toBe(6);
      sup.services.provide("app", AffectStateKey, {
        snapshot: () => ({ biases: { talkativeness: -MAX_BIAS } }),
      } as never);
      expect(floor?.budget(ROOM).allowed).toBe(3);
    });
  },
);
