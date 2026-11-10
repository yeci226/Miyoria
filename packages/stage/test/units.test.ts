// Ports of the Rust unit tests (`#[cfg(test)]` modules of protocol, avatar, emotion, motion,
// lipsync and link::forward), plus TS-specific shape and config checks.

import { fileURLToPath } from "node:url";
import type { ContextKey, ContextKind, Event, PlaybackState } from "@miyoria/types";
import { customEvent, newId, SONG_TOPIC } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  AvatarProfile,
  type CoreMessage,
  checkHello,
  DEFAULT_VOWEL_TEMPLATES,
  defaultLipSyncConfig,
  dominantVowel,
  EMOTION_TOPIC,
  EmotionController,
  Envelope,
  encodeMessage,
  Forwarder,
  GazeConfigSchema,
  goliveFollow,
  IdleMotion,
  Levels,
  type LipSyncConfig,
  MotionConfigSchema,
  MouthShaper,
  overlayUrl,
  parseAvatarAction,
  parseCoreMessage,
  parseGazeTarget,
  parseLevelFrame,
  parseStageConfig,
  parseStageMessage,
  Random,
  StageLinkConfigSchema,
  type StageMessage,
  tokenMatches,
  VOICE_GOLIVE_TOPIC,
  type Vowel,
  type VtsCommand,
} from "../src/index.js";

describe("protocol", () => {
  it("core_messages_match_the_spec", () => {
    const cases: [CoreMessage, unknown][] = [
      [
        { type: "emotion", name: "happy", intensity: 1.0 },
        { type: "emotion", name: "happy", intensity: 1.0 },
      ],
      [
        { type: "subtitle", turn: "t1", text: "早安", final: true },
        { type: "subtitle", turn: "t1", text: "早安", final: true },
      ],
      [
        { type: "speaking", state: "started" },
        { type: "speaking", state: "started" },
      ],
      [
        { type: "scene", name: "Game", id: 3 },
        { type: "scene", name: "Game", id: 3 },
      ],
      [
        { type: "stream", action: "stop" },
        { type: "stream", action: "stop" },
      ],
      [
        { type: "avatar_hotkey", name: "Wave" },
        { type: "avatar_hotkey", name: "Wave" },
      ],
      [
        { type: "gaze", target: "chat" },
        { type: "gaze", target: "chat" },
      ],
    ];
    for (const [msg, expected] of cases) {
      expect(JSON.parse(encodeMessage(msg))).toStrictEqual(expected);
      expect(parseCoreMessage(expected)).toStrictEqual(msg);
    }
  });

  it("stage_status_is_flat", () => {
    const msg: StageMessage = {
      type: "status",
      vts: true,
      obs: false,
      scene: "Talk",
      streaming: false,
      scenes: ["Talk", "Game"],
      hotkeys: ["Wave"],
      overlay_url: "http://127.0.0.1:7884/overlay/",
      id: 7,
    };
    expect(JSON.parse(encodeMessage(msg))).toStrictEqual({
      type: "status",
      vts: true,
      obs: false,
      scene: "Talk",
      streaming: false,
      scenes: ["Talk", "Game"],
      hotkeys: ["Wave"],
      overlay_url: "http://127.0.0.1:7884/overlay/",
      id: 7,
    });
    expect(parseStageMessage(JSON.parse(encodeMessage(msg)))).toStrictEqual(msg);
    // Older nodes send only the v1 fields.
    expect(parseStageMessage({ type: "status", vts: false, obs: true })).toStrictEqual({
      type: "status",
      vts: false,
      obs: true,
      scene: null,
      streaming: false,
      scenes: [],
      hotkeys: [],
      overlay_url: null,
    });
  });

  it("overlay_url_from_the_bind_address", () => {
    expect(overlayUrl("127.0.0.1:7884")).toBe("http://127.0.0.1:7884/overlay/");
    expect(overlayUrl("0.0.0.0:7884")).toBe("http://127.0.0.1:7884/overlay/");
    expect(overlayUrl({ host: "::", port: 9000 })).toBe("http://127.0.0.1:9000/overlay/");
    expect(overlayUrl({ host: "::1", port: 9000 })).toBe("http://[::1]:9000/overlay/");
    expect(overlayUrl("nonsense")).toBeNull();
  });

  it("level_frames", () => {
    const f = parseLevelFrame(JSON.parse(`{"t": 120, "rms": 0.25}`));
    expect(f).toStrictEqual({ t: 120, rms: 0.25 });
    expect(parseLevelFrame({ rms: 0.5 })).toStrictEqual({ rms: 0.5 });
    expect(parseLevelFrame({ t: 0, rms: 0.1, bands: [0.01, 0.2] })).toStrictEqual({
      t: 0,
      rms: 0.1,
      bands: [0.01, 0.2],
    });
    expect(() => parseLevelFrame({ t: 1 })).toThrow();
  });

  it("unknown_fields_are_ignored_and_bad_messages_rejected", () => {
    expect(parseCoreMessage({ type: "ping", extra: 1 })).toStrictEqual({ type: "ping" });
    expect(parseStageMessage({ type: "error", message: "x", id: null })).toStrictEqual({
      type: "error",
      message: "x",
    });
    expect(() => parseCoreMessage({ type: "nope" })).toThrow();
    expect(() => parseCoreMessage({ type: "gaze", target: "floor" })).toThrow();
    expect(parseGazeTarget(" Chat ")).toBe("chat");
    expect(parseGazeTarget("floor")).toBeNull();
  });

  it("hello_validation", () => {
    const hello = (v: unknown) => checkHello(JSON.stringify(v), "secret");
    expect(checkHello("not json", "secret")).toMatchObject({ ok: false, code: 4400 });
    expect(hello({ type: "status" })).toMatchObject({ ok: false, code: 4400 });
    expect(hello({ type: "hello", version: 1, token: "nope" })).toMatchObject({
      ok: false,
      code: 4401,
    });
    expect(hello({ type: "hello", version: 9, token: "secret" })).toMatchObject({
      ok: false,
      code: 4400,
      reason: "unsupported version",
    });
    expect(hello({ type: "hello", version: 1, token: "secret" })).toStrictEqual({
      ok: true,
      node: "",
      capabilities: [],
    });
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });
});

describe("config", () => {
  it("defaults_match_legacy", () => {
    const { scenes, ...legacy } = StageLinkConfigSchema.parse({});
    expect(scenes).toMatchObject({ director: true, classify_purpose: "fast", roles: {} });
    expect(legacy).toStrictEqual({
      bind: "127.0.0.1:7882",
      token: "",
      ping_interval_ms: 15_000,
      peer_timeout_ms: 45_000,
      hello_timeout_ms: 5_000,
      request_timeout_ms: 10_000,
      subtitle_text_turns: false,
      golive_obs: true,
      golive_start_delay_ms: 3_000,
    });
    const c = parseStageConfig({ vts: { inject_hz: 30 }, gaze: { chat: { face_x: 1 } } });
    expect(c.core_url).toBe("ws://127.0.0.1:7882/stage-link");
    expect(c.node).toBe("stage");
    expect(c.data_dir).toBe("data/stage");
    expect(c.overlay_bind).toBe("127.0.0.1:7884");
    expect(c.overlay_dir).toBe("apps/overlay/dist");
    expect(c.peer_timeout_ms).toBe(45_000);
    expect(c.vts).toMatchObject({
      enabled: true,
      url: "ws://127.0.0.1:8001",
      plugin_name: "Miyoria",
      plugin_developer: "Miyoria",
      plugin_icon: null,
      emotion_hold_ms: 4_000,
      after_speech_ms: 1_500,
      expression_fade: 0.3,
      inject_hz: 30,
      face_found: true,
      idle_motion: true,
      request_timeout_ms: 5_000,
      approval_timeout_ms: 120_000,
    });
    expect(c.obs).toStrictEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      subtitle_source: null,
      subtitle_clear_ms: 6_000,
      poll_ms: 2_000,
      stream_wait_ms: 15_000,
      song_video_source: "Miyoria 歌曲影片",
      song_video_dir: "data/songs",
      song_video_lead_ms: 0,
      song_video_resync_ms: 300,
    });
    expect(c.lipsync).toStrictEqual(defaultLipSyncConfig());
    expect(c.lipsync.bind).toBe("127.0.0.1:7883");
    // A partial pose keeps zero for the rest; a missing one keeps its default.
    expect(c.gaze.chat).toStrictEqual({ face_x: 1, face_y: 0, face_z: 0, eye_x: 0, eye_y: 0 });
    expect(c.gaze.game).toStrictEqual({
      face_x: 8,
      face_y: -10,
      face_z: 0,
      eye_x: 0.3,
      eye_y: -0.5,
    });
    expect(c.gaze.idle_amount).toBe(1);
    expect(c.gaze.turn_ms).toBe(600);
    expect(c.vts.custom_params).toContain("MiyoriaEyeSmile");
    expect(c.vts.custom_params).toContain("JawOpen");
    expect(c.motion.seed).toBeNull();
    expect(c.motion.speech_motion).toBe(1.8);
    expect(c.blink).toMatchObject({ enabled: true, min_ms: 2_000, max_ms: 6_000, close_ms: 120 });
    expect(c.emotion.ease_in_ms).toBe(250);
    expect(c.gesture).toMatchObject({ enabled: true, min_gap_ms: 8_000 });
    expect(c.avatar).toStrictEqual(new AvatarProfile());
  });
});

describe("avatar", () => {
  it("parses_the_deepseek_chan_avatar", () => {
    const path = fileURLToPath(
      new URL("../../../profiles/deepseek-chan/avatar.toml", import.meta.url),
    );
    const p = AvatarProfile.load(path);
    expect(p.vtsModel).toBe("大肥鱼");
    // Every emotion but `neutral` (the resting state) maps to one of the model's expressions.
    expect(p.emotions.size).toBe(8);
    expect([...p.emotions.values()].every((a) => JSON.stringify(a).includes(".exp3.json"))).toBe(
      true,
    );
    expect(p.lipsync).toBe("inject");
    expect(p.mouthOpen).toBe("MouthOpen");
    expect(p.mouthForm).toBe("MouthSmile");
    expect(p.jaw).toBe("JawOpen");
    expect(p.vowels).toBe(true);
    expect(p.shapes.get("o")?.get("MouthFunnel")).toBeGreaterThan(0);
    // Every emotion has a pose; neutral holds the rest values.
    expect([...p.poses.keys()]).toStrictEqual(
      [
        "angry",
        "annoyed",
        "embarrassed",
        "happy",
        "neutral",
        "sad",
        "smug",
        "surprised",
        "thinking",
      ].sort(),
    );
    expect(p.poseFor("neutral").params.get("EyeOpenLeft")).toBeCloseTo(0.55, 5);
    expect(p.poseFor("happy").params.get("MiyoriaEyeSmile")).toBeGreaterThan(0.5);
    // Nothing drives the eye smile through `MouthSmile` any more.
    for (const pose of p.poses.values()) expect(pose.params.has("EyeSmile")).toBe(false);
    // Gestures refer to the model's open / close hotkeys or expressions.
    expect(p.gestures.get("finger")).toMatchObject({
      open: { type: "hotkey", name: "竖手指打开" },
      close: { type: "hotkey", name: "竖手指关闭" },
      group: "hands",
    });
    expect(p.gestures.get("sweat")).toMatchObject({
      open: { type: "expression", file: "流冷汗.exp3.json" },
      close: null,
    });
    for (const pose of p.poses.values()) {
      for (const g of pose.gestures) expect(p.gestures.has(g), g).toBe(true);
    }
    expect(p.idle.gestures).toStrictEqual(["grass"]);
  });

  it("maps_expressions_and_hotkeys", () => {
    const p = AvatarProfile.parse({
      vts_model: "DeepSeek-chan",
      emotion: { neutral: "Reset", Happy: "smile.EXP3.json", smug: "Smug Face", sad: "" },
      lipsync: { mode: "mic", mouth_form: "" },
    });
    expect(p.vtsModel).toBe("DeepSeek-chan");
    expect(p.actionFor("happy")).toStrictEqual({ type: "expression", file: "smile.EXP3.json" });
    expect(p.actionFor("Smug")).toStrictEqual({ type: "hotkey", name: "Smug Face" });
    expect(p.actionFor("neutral")).toStrictEqual({ type: "hotkey", name: "Reset" });
    expect(p.actionFor("sad")).toBeNull();
    expect(p.lipsync).toBe("mic");
    expect(p.mouthForm).toBeNull();
    expect([...p.emotions.keys()]).toStrictEqual(["happy", "neutral", "smug"]);
    expect(AvatarProfile.parse(null)).toStrictEqual(new AvatarProfile());
    expect(() => AvatarProfile.parse({ lipsync: { mode: "puppet" } })).toThrow(/avatar\.toml/);
  });
});

describe("emotion", () => {
  function profile(entries: [string, string][]): AvatarProfile {
    const p = new AvatarProfile();
    for (const [k, v] of entries) {
      const a = parseAvatarAction(v);
      if (a) p.emotions.set(k, a);
    }
    return p;
  }
  const expr = (file: string, active: boolean): VtsCommand => ({
    type: "expression",
    file,
    active,
  });
  const hotkey = (name: string): VtsCommand => ({ type: "hotkey", name });
  const HOLD = 4_000;
  const AFTER = 1_000;

  it("expression_is_held_then_reverts", () => {
    const p = profile([
      ["happy", "happy.exp3.json"],
      ["sad", "sad.exp3.json"],
    ]);
    const c = new EmotionController(p, HOLD, AFTER);
    const t0 = 1_000_000;
    expect(c.rest()).toStrictEqual([]);
    expect(c.onEmotion("Happy", t0)).toStrictEqual([expr("happy.exp3.json", true)]);
    expect(c.current()).toBe("happy");
    // Repeating extends the hold without new requests.
    expect(c.onEmotion("happy", t0 + 2_000)).toStrictEqual([]);
    expect(c.tick(t0 + HOLD)).toStrictEqual([]);
    expect(c.tick(t0 + 6_000)).toStrictEqual([expr("happy.exp3.json", false)]);
    expect(c.current()).toBeNull();
    // One main expression: switching deactivates the old one first.
    c.onEmotion("happy", t0);
    expect(c.onEmotion("sad", t0)).toStrictEqual([
      expr("happy.exp3.json", false),
      expr("sad.exp3.json", true),
    ]);
    // Neutral and unmapped emotions return to rest at once.
    expect(c.onEmotion("neutral", t0)).toStrictEqual([expr("sad.exp3.json", false)]);
    c.onEmotion("sad", t0);
    expect(c.onEmotion("thinking", t0)).toStrictEqual([expr("sad.exp3.json", false)]);
    expect(c.onEmotion("thinking", t0)).toStrictEqual([]);
  });

  it("speaking_keeps_the_expression", () => {
    const c = new EmotionController(profile([["happy", "happy.exp3.json"]]), HOLD, AFTER);
    const t0 = 0;
    c.onEmotion("happy", t0);
    c.setSpeaking(true, t0);
    expect(c.tick(t0 + 10_000)).toStrictEqual([]);
    c.setSpeaking(false, t0 + 10_000);
    expect(c.tick(t0 + 10_500)).toStrictEqual([]);
    expect(c.tick(t0 + 11_000)).toStrictEqual([expr("happy.exp3.json", false)]);
  });

  it("hotkeys_and_neutral_rest", () => {
    let c = new EmotionController(
      profile([
        ["neutral", "Clear"],
        ["smug", "Smug"],
        ["happy", "happy.exp3.json"],
      ]),
      HOLD,
      AFTER,
    );
    const t0 = 0;
    expect(c.rest()).toStrictEqual([hotkey("Clear")]);
    expect(c.onEmotion("smug", t0)).toStrictEqual([hotkey("Smug")]);
    expect(c.onEmotion("happy", t0)).toStrictEqual([
      hotkey("Clear"),
      expr("happy.exp3.json", true),
    ]);
    expect(c.tick(t0 + HOLD)).toStrictEqual([expr("happy.exp3.json", false), hotkey("Clear")]);

    // A neutral expression is active while resting.
    c = new EmotionController(
      profile([
        ["neutral", "calm.exp3.json"],
        ["happy", "happy.exp3.json"],
      ]),
      HOLD,
      AFTER,
    );
    expect(c.rest()).toStrictEqual([expr("calm.exp3.json", true)]);
    expect(c.onEmotion("happy", t0)).toStrictEqual([
      expr("calm.exp3.json", false),
      expr("happy.exp3.json", true),
    ]);
    expect(c.onEmotion("neutral", t0)).toStrictEqual([
      expr("happy.exp3.json", false),
      expr("calm.exp3.json", true),
    ]);
  });
});

describe("motion", () => {
  const TICK = 16.667;
  const motion = (seed = 7) =>
    new IdleMotion(
      GazeConfigSchema.parse({}),
      MotionConfigSchema.parse({ seed }),
      new Random(seed),
    );

  it("turns_towards_the_target_and_stays_gentle", () => {
    const m = motion();
    let maxDx = 0;
    let prev = m.update(TICK);
    for (let i = 0; i < 600; i++) {
      const v = m.update(TICK);
      expect(Math.abs(v.FaceAngleX)).toBeLessThanOrEqual(30);
      expect(Math.abs(v.EyeRightX)).toBeLessThanOrEqual(1);
      maxDx = Math.max(maxDx, Math.abs(v.FaceAngleX - prev.FaceAngleX));
      prev = v;
    }
    expect(maxDx, "smooth").toBeLessThan(0.5);
    expect(Math.abs(prev.FaceAngleX), "near the camera pose").toBeLessThan(8);

    m.setTarget("chat");
    for (let i = 0; i < 240; i++) prev = m.update(TICK);
    // Within the noise of the chat pose.
    expect(Math.abs(prev.FaceAngleX - -12)).toBeLessThan(8);
    expect(Math.abs(prev.EyeRightX - -0.6)).toBeLessThan(0.35);
    expect(prev.EyeRightX).toBe(prev.EyeLeftX);

    const still = new IdleMotion(GazeConfigSchema.parse({ idle_amount: 0 }));
    expect(Object.values(still.update(TICK)).every((v) => v === 0)).toBe(true);
  });

  it("is_not_a_loop_and_depends_on_the_seed", () => {
    const run = (seed: number) => {
      const m = motion(seed);
      const xs: number[] = [];
      for (let i = 0; i < 60 * 40; i++) xs.push(m.update(TICK).FaceAngleX);
      return xs;
    };
    const a = run(1);
    expect(run(1)).toStrictEqual(a);
    expect(run(2)).not.toStrictEqual(a);
    // No short repeat (like the old 13 s tracking-lost loop): the second half does not replay
    // the first.
    const half = a.length / 2;
    let same = 0;
    for (let i = 0; i < half; i++) {
      if (Math.abs((a[i] as number) - (a[i + half] as number)) < 0.05) same++;
    }
    expect(same / half).toBeLessThan(0.2);
  });

  it("saccades_jump_quickly_and_settle", () => {
    const m = motion(3);
    let jumps = 0;
    let prev = m.update(TICK).EyeRightX;
    for (let i = 0; i < 60 * 30; i++) {
      const x = m.update(TICK).EyeRightX;
      if (Math.abs(x - prev) > 0.02) jumps++;
      prev = x;
    }
    // A saccade every ~1.6 s, each crossing a couple of frames.
    expect(jumps).toBeGreaterThan(10);
    expect(jumps).toBeLessThan(150);
  });

  it("speech_moves_the_head_more_and_nods_on_onsets", () => {
    // Mean head speed over several performances.
    const speed = (speaking: boolean) => {
      let sum = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const m = motion(seed);
        let prev = m.update(TICK).FaceAngleY;
        for (let i = 0; i < 60 * 20; i++) {
          // Syllables: the mouth opens and closes four times a second.
          const open = speaking && i % 15 < 7 ? 0.7 : 0;
          const y = m.update(TICK, { speaking, open }).FaceAngleY;
          sum += Math.abs(y - prev);
          prev = y;
        }
      }
      return sum;
    };
    expect(speed(true)).toBeGreaterThan(speed(false) * 1.3);

    // One onset: the head dips (nods) and comes back.
    const cfg = MotionConfigSchema.parse({});
    const m = new IdleMotion(GazeConfigSchema.parse({}), cfg, new Random(5));
    const quiet = new IdleMotion(GazeConfigSchema.parse({}), cfg, new Random(5));
    let dip = 0;
    for (let i = 0; i < 30; i++) {
      const open = i >= 5 ? 0.8 : 0;
      const a = m.update(TICK, { speaking: true, open }).FaceAngleY;
      const b = quiet.update(TICK, { speaking: true, open: 0 }).FaceAngleY;
      dip = Math.min(dip, a - b);
    }
    expect(dip).toBeLessThan(-0.5);
  });

  it("body_is_a_lagged_smaller_copy_of_the_head", () => {
    const gaze = GazeConfigSchema.parse({ camera: { face_x: 20 } });
    const m = new IdleMotion(
      gaze,
      MotionConfigSchema.parse({ body_drift: 0, body_follow: 0.35 }),
      new Random(1),
    );
    let v = m.update(TICK);
    const early = v.MiyoriaBodyX;
    for (let i = 0; i < 300; i++) v = m.update(TICK);
    expect(Math.abs(early)).toBeLessThan(Math.abs(v.MiyoriaBodyX));
    // About `body_follow` (0.35) of the head.
    expect(v.MiyoriaBodyX / v.FaceAngleX).toBeGreaterThan(0.2);
    expect(v.MiyoriaBodyX / v.FaceAngleX).toBeLessThan(0.5);
  });
});

describe("lipsync", () => {
  const TICK = 16.667;
  const config = (over: Partial<LipSyncConfig> = {}): LipSyncConfig => ({
    ...defaultLipSyncConfig(),
    ...over,
  });
  const db = (d: number) => 10 ** (d / 20);

  it("defaults", () => {
    const c = defaultLipSyncConfig();
    expect(c.latency_ms).toBe(180);
    expect(c.attack_ms).toBeGreaterThanOrEqual(20);
    expect(c.attack_ms).toBeLessThanOrEqual(25);
    expect(c.release_ms).toBeGreaterThanOrEqual(70);
    expect(c.release_ms).toBeLessThanOrEqual(90);
  });

  it("gate_and_db_curve", () => {
    const e = new Envelope(config());
    expect(e.target(0)).toBe(0);
    expect(e.target(db(-60))).toBe(0);
    expect(e.target(Number.NaN)).toBe(0);
    // At the reference: fully open; 13 dB down is about half, not linear in RMS.
    const ref = e.reference();
    expect(e.target(db(ref))).toBeCloseTo(1, 5);
    const half = e.target(db(ref - 13));
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.7);
    // Normal speech (RMS ~0.06, -24 dBFS) opens the mouth well past the old 0.18.
    expect(e.target(0.06)).toBeGreaterThan(0.5);
  });

  it("agc_lets_quiet_lines_open_the_mouth", () => {
    const e = new Envelope(config());
    const quiet = db(-34);
    const before = e.target(quiet);
    // Four seconds of quiet speech (syllables).
    let peak = 0;
    for (let i = 0; i < 60 * 4; i++) {
      const v = e.update(i % 15 < 8 ? quiet : db(-45), TICK);
      if (i > 60 * 3) peak = Math.max(peak, v);
    }
    expect(e.reference()).toBeLessThan(-26);
    expect(e.target(quiet)).toBeGreaterThan(before + 0.3);
    expect(peak).toBeGreaterThan(0.6);
    // A loud line pulls the reference up quickly.
    for (let i = 0; i < 30; i++) e.update(db(-10), TICK);
    expect(e.reference()).toBeGreaterThan(-14);
    // Silence does not move it.
    const r = e.reference();
    for (let i = 0; i < 300; i++) e.update(null, TICK);
    expect(e.reference()).toBe(r);
    expect(e.value()).toBe(0);
  });

  it("attack_is_faster_than_release", () => {
    const e = new Envelope(config({ curve: 1 }));
    const loud = db(e.reference());
    // One attack time constant reaches ~63% of the target.
    const v = e.update(loud, 22);
    expect(Math.abs(v - (1 - Math.exp(-1)))).toBeLessThan(0.03);
    for (let i = 0; i < 30; i++) e.update(loud, TICK);
    expect(e.value()).toBeGreaterThan(0.95);
    // After one attack time constant of silence the mouth is still mostly open.
    expect(e.update(null, 22)).toBeGreaterThan(0.7);
    for (let i = 0; i < 60; i++) e.update(null, TICK);
    expect(e.value(), "fully closed after silence").toBe(0);
  });

  it("vowels_follow_the_band_shape", () => {
    const m = new MouthShaper(config());
    const bands = (v: Vowel) => DEFAULT_VOWEL_TEMPLATES[v].map((d) => 0.01 * 10 ** (d / 20));
    // Without bands (an older voice node) the vowel inputs are not driven.
    expect(m.update({ rms: 0.1, bands: null }, TICK).vowels).toBeNull();
    let mouth = m.update({ rms: 0.1, bands: bands("o") }, TICK);
    for (let i = 0; i < 20; i++) mouth = m.update({ rms: 0.1, bands: bands("o") }, TICK);
    expect(mouth.vowels).not.toBeNull();
    expect(dominantVowel(mouth.weights)).toBe("o");
    expect(mouth.vowels?.o).toBeGreaterThan(0.5);
    expect(mouth.silence).toBe(0);
    expect(mouth.jaw).toBeCloseTo(mouth.open * 0.8, 5);
    for (let i = 0; i < 20; i++) mouth = m.update({ rms: 0.1, bands: bands("i") }, TICK);
    expect(dominantVowel(mouth.weights)).toBe("i");
    // Closing: vowel inputs fall with the opening, silence rises.
    for (let i = 0; i < 60; i++) mouth = m.update(null, TICK);
    expect(mouth.open).toBe(0);
    expect(mouth.silence).toBe(1);
    expect(Math.max(...Object.values(mouth.vowels ?? {}))).toBe(0);
    expect(m.reset().open).toBe(0);
  });

  it("levels_use_the_frame_timeline_latency_and_aggregate", () => {
    const t0 = 50_000;
    const levels = new Levels(config({ latency_ms: 100 }));
    expect(levels.take(t0)).toBeNull();
    // Frames 10 ms apart that arrive in a burst are spread by their own `t`; the least delayed
    // one (the last, t = 40) anchors the timeline: t = 0 at t0 - 38.
    for (let i = 0; i < 5; i++) levels.push({ t: i * 10, rms: 0.1 * (i + 1) }, t0 + 2);
    expect(levels.take(t0 + 61)).toBeNull();
    expect(levels.take(t0 + 62)?.rms).toBeCloseTo(0.1, 5);
    // Both frames due by now are combined (RMS), none dropped.
    const two = Math.sqrt((0.2 ** 2 + 0.3 ** 2) / 2);
    expect(levels.take(t0 + 82)?.rms).toBeCloseTo(two, 5);
    // Nothing new: the last sample is held until stale.
    expect(levels.take(t0 + 90)?.rms).toBeCloseTo(two, 5);
    expect(levels.take(t0 + 102)?.rms).toBeCloseTo(Math.sqrt((0.4 ** 2 + 0.5 ** 2) / 2), 5);
    expect(levels.take(t0 + 400)).toBeNull();

    // Jitter: a late frame does not move later frames.
    const j = new Levels(config({ latency_ms: 0 }));
    j.push({ t: 0, rms: 0.5 }, 1_000);
    j.push({ t: 10, rms: 0.5 }, 1_040);
    j.push({ t: 20, rms: 0.6 }, 1_020);
    expect(j.take(1_019)?.rms).toBeCloseTo(0.5, 5);
    expect(j.take(1_020)?.rms).toBeCloseTo(0.6, 5);
    // A stall (a frame arrives much later than its timeline) re-anchors.
    j.push({ t: 30, rms: 0.7 }, 1_500);
    expect(j.take(1_100)?.rms ?? 0).not.toBeCloseTo(0.7, 5);
    expect(j.take(1_500)?.rms).toBeCloseTo(0.7, 5);
    // A new playback (t back to 0) anchors again.
    j.push({ t: 0, rms: 0.2 }, 2_000);
    expect(j.take(2_000)?.rms).toBeCloseTo(0.2, 5);
    // Frames without `t` are placed by arrival; `clear` forgets.
    j.push({ rms: 0.9 }, 3_000);
    expect(j.current(3_000)).toBeCloseTo(0.9, 5);
    j.push(2.0, 3_010);
    expect(j.current(3_010)).toBe(1);
    j.clear();
    expect(j.take(3_020)).toBeNull();

    const max = new Levels(config({ latency_ms: 0, aggregate: "max" }));
    max.push({ t: 0, rms: 0.1 }, 0);
    max.push({ t: 10, rms: 0.4 }, 10);
    expect(max.take(20)?.rms).toBe(0.4);
    const banded = new Levels(config({ latency_ms: 0 }));
    banded.push({ t: 0, rms: 0.1, bands: [0.3, 0.4] }, 0);
    banded.push({ t: 10, rms: 0.1, bands: [0.4, 0.3] }, 10);
    const b = banded.take(10)?.bands ?? [];
    expect(b[0]).toBeCloseTo(Math.sqrt((0.09 + 0.16) / 2), 5);
    expect(b[1]).toBeCloseTo(Math.sqrt((0.16 + 0.09) / 2), 5);
  });
});

describe("forward", () => {
  const ctx = (kind: ContextKind): ContextKey => ({
    platform: "discord",
    scope: "g",
    channel: "c",
    kind,
  });
  const playback = (turn: string, state: PlaybackState, text: string): Event => ({
    type: "voice_playback",
    data: { context: ctx("voice"), turn, state, text },
  });
  const completed = (turn: string, kind: ContextKind, text: string): Event => ({
    type: "agent_turn_completed",
    data: { turn, context: ctx(kind), text },
  });
  const subs = (msgs: CoreMessage[]): [string, boolean][] =>
    msgs.flatMap((m) => (m.type === "subtitle" ? [[m.text, m.final] as [string, boolean]] : []));

  it("voice_turn_emotions_wait_for_their_sentence", () => {
    const f = new Forwarder(false);
    const turn = newId();
    const marker = (emotion: string, intensity?: number) =>
      customEvent(EMOTION_TOPIC, {
        turn,
        context: { ...ctx("voice") },
        emotion,
        ...(intensity === undefined ? {} : { intensity }),
      });
    const emotions = (msgs: CoreMessage[]) => msgs.filter((m) => m.type === "emotion");
    const spoken = (state: PlaybackState, text: string, emotion?: string | null): Event => ({
      type: "voice_playback",
      data: {
        context: ctx("voice"),
        turn,
        state,
        text,
        ...(emotion === undefined ? {} : { emotion }),
      },
    });
    // Parsed while the previous sentence is still playing: nothing yet.
    expect(f.onEvent(marker("happy", 0.5))).toStrictEqual([]);
    expect(f.onEvent(marker("smug"))).toStrictEqual([]);
    // The sentence spoken with it starts: now, with the marker's intensity.
    expect(emotions(f.onEvent(spoken("started", "欸!", "happy")))).toStrictEqual([
      { type: "emotion", name: "happy", intensity: 0.5 },
    ]);
    expect(emotions(f.onEvent(spoken("finished", "欸!", "happy")))).toStrictEqual([]);
    expect(emotions(f.onEvent(spoken("started", "哼。", "smug")))).toStrictEqual([
      { type: "emotion", name: "smug", intensity: 1 },
    ]);
    expect(emotions(f.onEvent(spoken("started", "嗯。", null)))).toStrictEqual([]);
    // An older voice module (no `emotion` field): the latest marker, once.
    f.onEvent(marker("sad", 0.3));
    expect(emotions(f.onEvent(spoken("started", "唉。")))).toStrictEqual([
      { type: "emotion", name: "sad", intensity: 0.3 },
    ]);
    expect(emotions(f.onEvent(spoken("started", "唉。")))).toStrictEqual([]);
    // Text turns are not deferred.
    expect(
      f.onEvent(
        customEvent(EMOTION_TOPIC, { turn, context: { ...ctx("channel") }, emotion: "sad" }),
      ),
    ).toStrictEqual([{ type: "emotion", name: "sad", intensity: 1 }]);
  });

  it("emotions", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { turn: "x", emotion: " Happy " }))).toStrictEqual([
      { type: "emotion", name: "happy", intensity: 1 },
    ]);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { emotion: "sad", intensity: 0.4 }))).toStrictEqual(
      [{ type: "emotion", name: "sad", intensity: 0.4 }],
    );
    expect(f.onEvent(customEvent(EMOTION_TOPIC, {}))).toStrictEqual([]);
    expect(f.onEvent(customEvent(EMOTION_TOPIC, { name: "Smug", intensity: 7 }))).toStrictEqual([
      { type: "emotion", name: "smug", intensity: 1 },
    ]);
    expect(f.onEvent(customEvent("other", { emotion: "sad" }))).toStrictEqual([]);
  });

  it("songs_show_their_lyrics_and_make_her_speak", () => {
    const f = new Forwarder(false);
    const cue = (payload: Record<string, string | number>) =>
      f.onEvent(customEvent(SONG_TOPIC, { song: "yt-x", ...payload }));
    expect(cue({ state: "started", title: "On & On" })).toStrictEqual([
      { type: "speaking", state: "started" },
    ]);
    expect(cue({ state: "line", index: 0, text: " Hold me close " })).toStrictEqual([
      { type: "subtitle", turn: "song:yt-x:0", text: "Hold me close", final: true },
    ]);
    expect(cue({ state: "ended", outcome: "finished" })).toStrictEqual([
      { type: "speaking", state: "stopped" },
      { type: "subtitle", turn: "song:yt-x:end", text: "", final: true },
    ]);
    expect(f.onEvent(customEvent(SONG_TOPIC, { state: "line" }))).toStrictEqual([]);
  });

  it("voice_turn_subtitles_follow_playback", () => {
    const f = new Forwarder(false);
    const turn = newId();
    let out = f.onEvent(playback(turn, "started", "哼,"));
    expect(out[0]).toStrictEqual({ type: "speaking", state: "started" });
    expect(subs(out)).toStrictEqual([["哼,", false]]);
    out = f.onEvent(playback(turn, "finished", "哼,"));
    expect(subs(out)).toStrictEqual([]);
    out = f.onEvent(playback(turn, "started", "才不是在等你呢。"));
    expect(subs(out)).toStrictEqual([["哼,才不是在等你呢。", false]]);
    // Completion while speaking: final comes when the playback ends.
    out = f.onEvent(completed(turn, "voice", "哼,才不是在等你呢。"));
    expect(out).toStrictEqual([]);
    out = f.onEvent(playback(turn, "interrupted", ""));
    expect(out[0]).toStrictEqual({ type: "speaking", state: "stopped" });
    expect(subs(out)).toStrictEqual([["哼,才不是在等你呢。", true]]);
  });

  it("completion_after_speech_finalizes_immediately", () => {
    const f = new Forwarder(false);
    const turn = newId();
    f.onEvent(playback(turn, "started", "Hello"));
    f.onEvent(playback(turn, "finished", "Hello"));
    f.onEvent(playback(turn, "started", "there."));
    f.onEvent(playback(turn, "finished", "there."));
    expect(subs(f.onEvent(completed(turn, "voice", "Hello there.")))).toStrictEqual([
      ["Hello there.", true],
    ]);
  });

  it("text_turns_are_optional", () => {
    const turn = newId();
    const done = completed(turn, "channel", "早安");
    expect(new Forwarder(false).onEvent(done)).toStrictEqual([]);
    expect(subs(new Forwarder(true).onEvent(done))).toStrictEqual([["早安", true]]);
    // A failed TTS start does not count as a running playback.
    const f = new Forwarder(false);
    f.onEvent(playback(turn, "started", "a"));
    f.onEvent(playback(turn, "failed", "b"));
    expect(subs(f.onEvent(completed(turn, "voice", "a b")))).toStrictEqual([["a", true]]);
  });

  it("playback_without_turn", () => {
    const f = new Forwarder(false);
    const event = (state: PlaybackState, text: string): Event => ({
      type: "voice_playback",
      data: { context: ctx("voice"), turn: null, state, text },
    });
    expect(f.onEvent(event("started", " hi "))).toStrictEqual([
      { type: "speaking", state: "started" },
      { type: "subtitle", turn: "", text: "hi", final: false },
    ]);
    expect(f.onEvent(event("finished", "hi"))).toStrictEqual([
      { type: "speaking", state: "stopped" },
      { type: "subtitle", turn: "", text: "hi", final: true },
    ]);
    expect(f.onEvent(event("failed", "hi"))).toStrictEqual([
      { type: "speaking", state: "stopped" },
    ]);
  });
});

describe("go live follow", () => {
  it("maps_states_to_obs_actions", () => {
    expect(VOICE_GOLIVE_TOPIC).toBe("voice.golive");
    expect(goliveFollow("starting")).toBe("start");
    expect(goliveFollow("live")).toBeNull();
    expect(goliveFollow("stopped")).toBe("stop");
    expect(goliveFollow("failed")).toBe("stop");
    expect(goliveFollow(undefined)).toBeNull();
    expect(goliveFollow("nonsense")).toBeNull();
  });

  it("config_defaults_follow_go_live", () => {
    const config = StageLinkConfigSchema.parse({ token: "x" });
    expect(config.golive_obs).toBe(true);
    expect(config.golive_start_delay_ms).toBe(3_000);
  });
});
