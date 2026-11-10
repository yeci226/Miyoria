// Avatar control units: blinking, vowel classification, emotion poses, gestures and the
// composed injection frame.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AvatarLoop,
  AvatarProfile,
  BlinkConfigSchema,
  BlinkScheduler,
  defaultLipSyncConfig,
  dominantVowel,
  EmotionConfigSchema,
  EmotionController,
  GazeConfigSchema,
  GestureConfigSchema,
  GestureController,
  Levels,
  MotionConfigSchema,
  PoseBlender,
  parseStageConfig,
  Random,
  type Vowel,
  VowelClassifier,
  type VtsCommand,
} from "../src/index.js";
import type { VtsClient } from "../src/vts.js";
import { Watch } from "../src/watch.js";

const TICK = 16.667;

const DEEPSEEK = () =>
  AvatarProfile.load(
    fileURLToPath(new URL("../../../profiles/deepseek-chan/avatar.toml", import.meta.url)),
  );

describe("blink", () => {
  /** Runs `ms` of blinking; returns the start times (ms) of each closed stretch. */
  function closures(b: BlinkScheduler, ms: number, dt = TICK): number[] {
    const starts: number[] = [];
    let wasClosed = false;
    for (let t = 0; t < ms; t += dt) {
      const open = b.update(dt);
      expect(open).toBeGreaterThanOrEqual(0);
      expect(open).toBeLessThanOrEqual(1);
      const closed = open < 0.2;
      if (closed && !wasClosed) starts.push(t);
      wasClosed = closed;
    }
    return starts;
  }

  it("blinks_on_a_random_2_to_6_s_schedule", () => {
    const config = BlinkConfigSchema.parse({ double_chance: 0 });
    const starts = closures(new BlinkScheduler(config, new Random(1)), 120_000);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
    expect(starts.length).toBeGreaterThan(20);
    expect(starts.length).toBeLessThan(60);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(2_000 - 50);
      expect(g).toBeLessThan(6_000 + 400);
    }
    // Not a fixed period.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(1_500);
    // Another seed, another schedule.
    expect(closures(new BlinkScheduler(config, new Random(2)), 120_000)).not.toStrictEqual(starts);
  });

  it("closes_fast_and_opens_slower", () => {
    const b = new BlinkScheduler(BlinkConfigSchema.parse({ min_ms: 0, mean_ms: 1 }), new Random(3));
    const curve: number[] = [];
    for (let t = 0; t < 400; t += 5) curve.push(b.update(5));
    const first = curve.findIndex((v) => v < 1);
    const shut = curve.indexOf(0);
    const reopened = curve.findIndex((v, i) => i > shut && v === 1);
    expect(first).toBeGreaterThanOrEqual(0);
    // ~120 ms closing, ~30 ms closed, ~180 ms opening.
    expect((shut - first) * 5).toBeGreaterThan(90);
    expect((shut - first) * 5).toBeLessThan(150);
    expect((reopened - shut) * 5).toBeGreaterThan(180);
    expect((reopened - shut) * 5).toBeLessThan(260);
  });

  it("double_blinks_and_rate_scaling", () => {
    const always = BlinkConfigSchema.parse({ double_chance: 1 });
    const starts = closures(new BlinkScheduler(always, new Random(4)), 30_000, 5);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
    // Pairs ~0.5 s apart, never three in a row.
    const short = gaps.filter((g) => g < 1_000).length;
    expect(short).toBeGreaterThan(2);
    for (let i = 1; i < gaps.length; i++) {
      expect((gaps[i] as number) < 1_000 && (gaps[i - 1] as number) < 1_000).toBe(false);
    }
    const config = BlinkConfigSchema.parse({ double_chance: 0 });
    const calm = new BlinkScheduler(config, new Random(5));
    const nervous = new BlinkScheduler(config, new Random(5));
    nervous.setRate(2);
    closures(calm, 60_000);
    closures(nervous, 60_000);
    expect(nervous.count()).toBeGreaterThan(calm.count() * 1.5);
    // A sentence start can bring a blink forward.
    const speech = new BlinkScheduler(BlinkConfigSchema.parse({ speech_chance: 1 }), new Random(6));
    for (let i = 0; i < 60; i++) speech.update(TICK);
    const before = speech.count();
    speech.onSpeech();
    for (let i = 0; i < 10; i++) speech.update(TICK);
    expect(speech.count()).toBe(before + 1);
    expect(
      new BlinkScheduler(BlinkConfigSchema.parse({ enabled: false }), new Random()).update(5_000),
    ).toBe(1);
  });
});

describe("vowel classifier", () => {
  // Band vectors the voice node measured on formant-synthesised vowels at other pitches than
  // the templates' average (dB around their mean, see `apps/voice-node/test/levels.test.ts`).
  const MEASURED: Record<Vowel, number[][]> = {
    a: [
      [-8, 2, 9.9, 7.5, -1.1, -10.2],
      [-6.1, 2.2, 10.9, 6.9, -2.4, -11.4],
    ],
    i: [
      [7.9, 3.6, -4, -8.2, -2.7, 3.3],
      [16.4, 3.7, -4.3, -9.7, -5.7, -0.5],
    ],
    u: [
      [4.5, 6.3, -1.3, 1.7, -0.9, -10.3],
      [11.5, 1.9, -2.2, 1.4, -2.1, -10.5],
    ],
    e: [
      [-0.8, 4, 0.4, -5, 0.9, 0.4],
      [-0.5, 6.2, 0.8, -6.1, -0.1, -0.3],
    ],
    o: [
      [4.5, 9.5, 9.7, 1.9, -8.7, -16.9],
      [4.1, 8.9, 9.7, 2.4, -8.4, -16.8],
    ],
  };
  const toBands = (shape: number[], level = 0.02) => shape.map((d) => level * 10 ** (d / 20));

  it("classifies_measured_vowels_at_any_level", () => {
    const c = new VowelClassifier(defaultLipSyncConfig());
    for (const [vowel, shapes] of Object.entries(MEASURED)) {
      for (const shape of shapes) {
        for (const level of [0.002, 0.02, 0.2]) {
          const w = c.classify(toBands(shape, level));
          expect(w, vowel).not.toBeNull();
          if (!w) continue;
          expect(dominantVowel(w), `${vowel} ${shape}`).toBe(vowel);
          expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it("rejects_bad_input_and_takes_custom_templates", () => {
    const c = new VowelClassifier(defaultLipSyncConfig());
    expect(c.classify([])).toBeNull();
    expect(c.classify([0.1, Number.NaN, 0.1, 0.1, 0.1, 0.1])).toBeNull();
    expect(c.classify([0.1, 0.1])).toBeNull();
    const custom = new VowelClassifier({
      ...defaultLipSyncConfig(),
      vowel_templates: { a: [5, -5], i: [-5, 5], u: [0, 0], e: [0, 0], o: [0, 0] },
    });
    const w = custom.classify([1, 0.01]);
    expect(w && dominantVowel(w)).toBe("a");
  });
});

describe("emotion poses", () => {
  const profile = () => DEEPSEEK();
  const cfg = EmotionConfigSchema.parse({});

  it("eases_in_decays_and_eases_out", () => {
    const p = new PoseBlender(profile(), cfg);
    const rest = p.rest("MiyoriaEyeSmile");
    const target = profile().poseFor("happy").params.get("MiyoriaEyeSmile") as number;
    let now = 0;
    let f = p.update(TICK, now);
    expect(f.values.get("MiyoriaEyeSmile")).toBe(rest);
    p.set("happy", 1, now);
    const series: number[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      now += TICK;
      f = p.update(TICK, now);
      series.push(f.values.get("MiyoriaEyeSmile") as number);
    }
    // ~95% of the way in 250 ms, not in the first frame.
    expect(series[0] as number).toBeLessThan(rest + 0.3 * (target - rest));
    expect(series[16] as number).toBeGreaterThan(rest + 0.85 * (target - rest));
    // Decays towards `sustain` (0.65) while held.
    const late = series.at(-1) as number;
    expect(late).toBeLessThan(rest + 0.8 * (target - rest));
    expect(late).toBeGreaterThan(rest + 0.55 * (target - rest));
    // Offsets: head tilt added to the motion.
    expect(f.offsets.get("FaceAngleZ")).toBeGreaterThan(1);
    // Release.
    p.set(null, 0, now);
    for (let i = 0; i < 120; i++) {
      now += TICK;
      f = p.update(TICK, now);
    }
    expect(f.values.get("MiyoriaEyeSmile")).toBeCloseTo(rest, 2);
    expect(p.weight()).toBeLessThan(0.01);
  });

  it("scales_with_intensity_and_cross_fades", () => {
    const run = (intensity: number) => {
      const p = new PoseBlender(profile(), cfg);
      p.set("sad", intensity, 0);
      let f = p.update(TICK, 0);
      for (let i = 1; i < 30; i++) f = p.update(TICK, i * TICK);
      return f.values.get("BrowInnerUp") as number;
    };
    const full = run(1);
    const half = run(0.5);
    expect(full).toBeGreaterThan(0.3);
    expect(half).toBeCloseTo(full / 2, 1);

    // Switching: the old pose fades while the new one comes in; values stay in range.
    const p = new PoseBlender(profile(), cfg);
    p.set("happy", 1, 0);
    let now = 0;
    const step = () => {
      now += TICK;
      return p.update(TICK, now);
    };
    for (let i = 0; i < 30; i++) step();
    p.set("sad", 1, now);
    expect(p.current()).toBe("sad");
    let f = step();
    expect(f.values.get("MiyoriaEyeSmile")).toBeGreaterThan(0.3);
    for (let i = 0; i < 90; i++) {
      f = step();
      for (const [, v] of f.values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(f.values.get("MiyoriaEyeSmile")).toBeLessThan(0.05);
    expect(f.values.get("BrowInnerUp")).toBeGreaterThan(0.3);
    // Blink rate follows the emotion.
    expect(f.blink).toBeLessThan(1);
  });

  it("accent_needs_enough_intensity", () => {
    const c = new EmotionController(profile(), 4_000, 1_000);
    // Happy's heart eyes need intensity 0.7; the pose alone shows below that.
    expect(c.onEmotion("happy", 0, 0.4)).toStrictEqual([]);
    expect(c.current()).toBe("happy");
    expect(c.onEmotion("happy", 100, 0.9)).toStrictEqual([
      { type: "expression", file: "爱心眼.exp3.json", active: true },
    ]);
    expect(c.onEmotion("happy", 200, 0.3)).toStrictEqual([]);
    expect(c.tick(5_000)).toStrictEqual([
      { type: "expression", file: "爱心眼.exp3.json", active: false },
    ]);
    expect(c.current()).toBeNull();
  });
});

describe("gestures", () => {
  const config = (over = {}) => GestureConfigSchema.parse({ min_gap_ms: 0, ...over });
  const names = (cmds: VtsCommand[]) =>
    cmds.map((c) => (c.type === "hotkey" ? c.name : `${c.file}:${c.active}`));

  it("opens_holds_closes_and_cools_down", () => {
    const p = DEEPSEEK();
    const g = new GestureController(p, config(), new Random(1), 0);
    // Thinking always gestures at chance 1 (scale).
    const always = new GestureController(p, config({ chance_scale: 10 }), new Random(1), 0);
    const first = names(always.onEmotion("thinking", 1, 0));
    expect(first.length).toBe(1);
    expect(["竖手指打开", "加载.exp3.json:true"]).toContain(first[0]);
    const name = always.active()[0] as string;
    const gesture = p.gestures.get(name);
    expect(gesture).toBeDefined();
    if (!gesture) return;
    // Held at least `hold_ms[0]`, closed by `hold_ms[1]`.
    expect(always.tick(gesture.holdMs[0] - 1)).toStrictEqual([]);
    const closed = names(always.tick(gesture.holdMs[1] + 1));
    expect(closed).toStrictEqual(
      gesture.close?.type === "hotkey"
        ? [gesture.close.name]
        : [`${(gesture.open as { file: string }).file}:false`],
    );
    expect(always.active()).toStrictEqual([]);
    // The other variant is preferred next; the same one never repeats within its cooldown.
    const seen: string[] = [];
    for (let t = 10_000; t < 200_000; t += 500) {
      for (const c of names(always.onEmotion("thinking", 1, t))) seen.push(`${t}:${c}`);
      always.tick(t);
    }
    const opens = seen.filter((s) => !s.endsWith(":false") && !s.includes("关闭"));
    const byName = new Map<string, number[]>();
    for (const s of opens) {
      const [t, n] = s.split(":") as [string, string];
      byName.set(n, [...(byName.get(n) ?? []), Number(t)]);
    }
    expect(byName.size).toBe(2);
    for (const [n, times] of byName) {
      const cooldown = n.startsWith("竖手指") ? 30_000 : 45_000;
      for (let i = 1; i < times.length; i++) {
        expect((times[i] as number) - (times[i - 1] as number), n).toBeGreaterThanOrEqual(cooldown);
      }
    }
    // An emotion without gestures does nothing; unknown emotions neither.
    expect(g.onEmotion("surprised", 0, 0)).toBeDefined();
    expect(g.onEmotion("nonsense", 1, 0)).toStrictEqual([]);
  });

  it("groups_gaps_idle_and_takeover", () => {
    const p = DEEPSEEK();
    const g = new GestureController(
      p,
      config({ chance_scale: 10, min_gap_ms: 5_000 }),
      new Random(2),
      0,
    );
    // Quiet long enough: the idle gesture (grass) comes.
    let out: string[] = [];
    for (let t = 0; t <= 200_000 && out.length === 0; t += 1_000) out = names(g.tick(t));
    expect(out).toStrictEqual(["狗尾巴草打开"]);
    const t1 = 200_001;
    // An emotion gesture in the same group (hands) takes over: grass closes, the new one opens
    // after the switch time. The gap rule still applies to the start.
    const takeover = names(g.onEmotion("smug", 1, t1 + 10_000));
    if (takeover.includes("狗尾巴草关闭")) {
      expect(g.active()).not.toContain("grass");
      const opened = names(g.tick(t1 + 10_000 + 1_300));
      expect(opened.length).toBe(1);
    }
    // Within `min_gap_ms` of a start nothing new starts.
    const g2 = new GestureController(
      p,
      config({ chance_scale: 10, min_gap_ms: 5_000 }),
      new Random(3),
      0,
    );
    expect(names(g2.onEmotion("embarrassed", 1, 0)).length).toBe(1);
    expect(g2.onEmotion("annoyed", 1, 1_000)).toStrictEqual([]);
    // Speaking keeps idle gestures away; reset takes everything back.
    const g3 = new GestureController(p, config(), new Random(4), 0);
    g3.setSpeaking(true, 0);
    for (let t = 0; t < 400_000; t += 1_000) expect(g3.tick(t)).toStrictEqual([]);
    const g4 = new GestureController(p, config({ chance_scale: 10 }), new Random(5), 0);
    g4.onEmotion("thinking", 1, 0);
    expect(g4.reset().length).toBe(1);
    expect(g4.active()).toStrictEqual([]);
    const off = new GestureController(
      p,
      config({ enabled: false, chance_scale: 10 }),
      new Random(5),
      0,
    );
    expect(off.onEmotion("thinking", 1, 0)).toStrictEqual([]);
  });
});

describe("avatar loop frame", () => {
  function loop(latency = 0) {
    const config = parseStageConfig(
      {
        lipsync: { latency_ms: latency },
        motion: { seed: 9 },
        blink: { double_chance: 0 },
      },
      DEEPSEEK(),
    );
    let now = 1_000;
    const clock = { now: () => now };
    const levels = new Levels(config.lipsync);
    const l = new AvatarLoop(
      config,
      levels,
      new Watch<VtsClient | null>(null),
      clock,
      new Random(9),
    );
    const step = (ms = TICK) => {
      now += ms;
      return l.frame(ms, now);
    };
    return { l, levels, step, now: () => now, config };
  }

  it("her resting face: a weaker pose while no marker is shown, and nothing else", () => {
    const { l, step } = loop();
    const settle = (): number => {
      let v = 0;
      for (let i = 0; i < 200; i++) v = step().get("MouthSmile") ?? 0;
      return v;
    };
    const rest = settle();
    l.resting("sad", 1);
    const sad = settle();
    expect(sad).not.toBeCloseTo(rest, 2);
    // A marker takes over, and when it is over she looks the way she did.
    l.emotion("happy", 1);
    const happy = settle();
    expect(happy).toBeGreaterThan(sad);
    for (let i = 0; i < 600; i++) step();
    expect(settle()).toBeCloseTo(sad, 1);
    l.resting("neutral", 0);
    expect(settle()).toBeCloseTo(rest, 1);
    l.resting("no such face", 1);
    expect(settle()).toBeCloseTo(rest, 1);
  });

  it("her resting face opens no accent and starts no gesture, a marker does", async () => {
    const config = parseStageConfig({ motion: { seed: 9 } }, DEEPSEEK());
    const sent: string[] = [];
    const vts = {
      isClosed: () => false,
      setExpression: async (file: string) => {
        sent.push(file);
      },
      triggerHotkey: async (name: string) => {
        sent.push(name);
        return name;
      },
    } as unknown as VtsClient;
    let now = 1_000;
    const l = new AvatarLoop(
      config,
      new Levels(config.lipsync),
      new Watch<VtsClient | null>(vts),
      { now: () => now },
      new Random(9),
    );
    const run = async () => {
      for (let i = 0; i < 90; i++) {
        now += TICK;
        l.frame(TICK, now);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    l.resting("happy", 1);
    await run();
    expect(sent).toEqual([]);
    l.emotion("happy", 1);
    await run();
    expect(sent.length).toBeGreaterThan(0);
  });

  it("drives_every_part_of_the_face", () => {
    const { l, levels, step, now } = loop();
    const params = l.parameters();
    for (const p of [
      "EyeOpenLeft",
      "MiyoriaEyeSmile",
      "MouthOpen",
      "MouthSmile",
      "JawOpen",
      "VoiceA",
      "VoiceSilence",
      "FaceAngleX",
      "MiyoriaBodyX",
      "MouthFunnel",
      "Brows",
    ]) {
      expect(params, p).toContain(p);
    }
    // Never `EyeSmile` through anything but the custom parameter.
    expect(params).not.toContain("EyeSmile");
    let f = step();
    expect(f.get("EyeOpenLeft")).toBeCloseTo(0.55, 1);
    expect(f.get("MouthOpen")).toBe(0);
    expect(f.get("MouthSmile")).toBeCloseTo(0.58, 2);
    // Speech with bands: the mouth, jaw and vowels move.
    l.speaking(true);
    let maxOpen = 0;
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < 2; k++) {
        levels.push(
          { t: i * 17 + k * 8, rms: 0.08, bands: [0.002, 0.008, 0.02, 0.015, 0.006, 0.002] },
          now(),
        );
      }
      f = step();
      maxOpen = Math.max(maxOpen, f.get("MouthOpen") ?? 0);
    }
    expect(maxOpen).toBeGreaterThan(0.5);
    expect(f.get("JawOpen")).toBeGreaterThan(0.3);
    expect(f.get("VoiceA")).toBeGreaterThan(0.3);
    expect(f.get("VoiceSilence")).toBeLessThan(0.5);
    // Blinks happen within a few seconds.
    let blinked = false;
    for (let i = 0; i < 60 * 8; i++) if ((step().get("EyeOpenLeft") ?? 1) < 0.1) blinked = true;
    expect(blinked).toBe(true);
    // Every value is inside its input range.
    for (const [name, v] of step()) {
      expect(Number.isFinite(v), name).toBe(true);
      expect(Math.abs(v), name).toBeLessThanOrEqual(30);
    }
  });

  it("emotion_follows_latency_and_shows_its_pose", () => {
    const { l, step } = loop(180);
    const before = step().get("MiyoriaEyeSmile") ?? 0;
    l.emotion("happy", 1);
    // Not yet: the sentence is not heard before `latency_ms`.
    for (let i = 0; i < 6; i++) expect(step().get("MiyoriaEyeSmile")).toBeCloseTo(before, 3);
    let f = step();
    for (let i = 0; i < 30; i++) f = step();
    expect(f.get("MiyoriaEyeSmile")).toBeGreaterThan(before + 0.5);
    expect(f.get("MouthSmile")).toBeGreaterThan(0.8);
  });

  it("uses_the_default_gaze_and_motion_config", () => {
    // Plain configs still build a loop (no profile poses: only motion, blink and mouth).
    const config = parseStageConfig({ motion: { seed: 1 } });
    const l = new AvatarLoop(
      config,
      new Levels(config.lipsync),
      new Watch<VtsClient | null>(null),
      {
        now: () => 0,
      },
    );
    expect(l.parameters()).toContain("FaceAngleX");
    expect(l.frame(TICK, TICK).get("EyeOpenLeft")).toBe(1);
    expect(GazeConfigSchema.parse({}).turn_ms).toBe(600);
    expect(MotionConfigSchema.parse({}).seed).toBeNull();
  });
});

describe("avatar loop run", () => {
  it("rests the model while nobody is watching", async () => {
    const config = parseStageConfig({ vts: { inject_hz: 100 } }, DEEPSEEK());
    const injected: number[] = [];
    const all = new Set(
      new AvatarLoop(config, new Levels(config.lipsync), new Watch<VtsClient | null>(null), {
        now: () => Date.now(),
      }).parameters(),
    );
    const client = {
      isClosed: () => false,
      inject: () => injected.push(Date.now()),
      inputParameterLists: async () => ({ defaults: all, custom: new Set<string>() }),
      inputParameters: async () => all,
      createParameter: async () => {},
      expression: async () => {},
      hotkey: async () => {},
    } as unknown as VtsClient;
    const loop = new AvatarLoop(
      config,
      new Levels(config.lipsync),
      new Watch<VtsClient | null>(client),
      { now: () => Date.now() },
      new Random(9),
    );
    let live = true;
    const controller = new AbortController();
    const done = loop.run(controller.signal, () => live);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(150);
    const whileLive = injected.length;
    expect(whileLive).toBeGreaterThan(3);
    live = false;
    await wait(30);
    const atPause = injected.length;
    await wait(150);
    expect(injected.length).toBe(atPause);
    live = true;
    await wait(150);
    expect(injected.length).toBeGreaterThan(atPause + 3);
    controller.abort();
    await done;
  });
});
