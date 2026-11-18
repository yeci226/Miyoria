// What the parse functions of the stage link return, for one example of every message in both
// directions and for the inputs they normalise. The expectations are literal and strict (a key
// that is present with `undefined` differs from a key that is absent), so they pin the output the
// rest of the package depends on, whatever the schemas behind the functions look like.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseCoreMessage, parseLevelFrame, parseStageMessage } from "../src/index.js";

const stage = (value: unknown) => parseStageMessage(value);
const core = (value: unknown) => parseCoreMessage(value);

describe("parseStageMessage", () => {
  it("hello", () => {
    expect(
      stage({ type: "hello", version: 1, token: "t", node: "pc", capabilities: ["obs", "vts"] }),
    ).toStrictEqual({
      type: "hello",
      version: 1,
      token: "t",
      node: "pc",
      capabilities: ["obs", "vts"],
    });
  });

  it("hello defaults node and capabilities", () => {
    expect(stage({ type: "hello", version: 1, token: "" })).toStrictEqual({
      type: "hello",
      version: 1,
      token: "",
      node: "",
      capabilities: [],
    });
  });

  it("hello rejects a negative or fractional version and a missing token", () => {
    expect(() => stage({ type: "hello", version: -1, token: "t" })).toThrow(ZodError);
    expect(() => stage({ type: "hello", version: 1.5, token: "t" })).toThrow(ZodError);
    expect(() => stage({ type: "hello", version: 1 })).toThrow(ZodError);
  });

  it("status with every field and an id", () => {
    expect(
      stage({
        type: "status",
        id: 7,
        vts: true,
        obs: true,
        scene: "Talk",
        streaming: true,
        scenes: ["Talk", "Sing"],
        hotkeys: ["wave"],
        overlay_url: "http://pc:7884/overlay/",
        obs_collection: "我的場景",
        obs_warning: "OBS 不在「Miyoria」這份場景集合上(現在是「我的場景」)",
      }),
    ).toStrictEqual({
      type: "status",
      id: 7,
      vts: true,
      obs: true,
      scene: "Talk",
      streaming: true,
      scenes: ["Talk", "Sing"],
      hotkeys: ["wave"],
      overlay_url: "http://pc:7884/overlay/",
      obs_collection: "我的場景",
      obs_warning: "OBS 不在「Miyoria」這份場景集合上(現在是「我的場景」)",
    });
  });

  it("status from an older node: the fields added later and the id take their defaults", () => {
    expect(
      stage({ type: "status", vts: true, obs: false, scene: null, streaming: false }),
    ).toStrictEqual({
      type: "status",
      vts: true,
      obs: false,
      scene: null,
      streaming: false,
      scenes: [],
      hotkeys: [],
      overlay_url: null,
      obs_collection: null,
      obs_warning: null,
    });
  });

  it("status with nothing but the type is all defaults", () => {
    expect(stage({ type: "status" })).toStrictEqual({
      type: "status",
      vts: false,
      obs: false,
      scene: null,
      streaming: false,
      scenes: [],
      hotkeys: [],
      overlay_url: null,
      obs_collection: null,
      obs_warning: null,
    });
  });

  it("status: a null id is left out, an empty scene name stays", () => {
    expect(stage({ type: "status", id: null, scene: "" })).toStrictEqual({
      type: "status",
      vts: false,
      obs: false,
      scene: "",
      streaming: false,
      scenes: [],
      hotkeys: [],
      overlay_url: null,
      obs_collection: null,
      obs_warning: null,
    });
  });

  it("status: id 0 and the largest id are kept, a negative, fractional or too large one throws", () => {
    expect(stage({ type: "status", id: 0 })).toHaveProperty("id", 0);
    expect(stage({ type: "status", id: 0xffff_ffff })).toHaveProperty("id", 0xffff_ffff);
    expect(() => stage({ type: "status", id: -1 })).toThrow(ZodError);
    expect(() => stage({ type: "status", id: 1.5 })).toThrow(ZodError);
    expect(() => stage({ type: "status", id: 0x1_0000_0000 })).toThrow(ZodError);
  });

  it("status: a null where the field is not nullable throws", () => {
    expect(() => stage({ type: "status", vts: null })).toThrow(ZodError);
    expect(() => stage({ type: "status", scenes: null })).toThrow(ZodError);
  });

  it("error, with and without an id", () => {
    expect(stage({ type: "error", message: "no obs", id: 3 })).toStrictEqual({
      type: "error",
      message: "no obs",
      id: 3,
    });
    expect(stage({ type: "error", message: "no obs" })).toStrictEqual({
      type: "error",
      message: "no obs",
    });
    expect(stage({ type: "error", message: "", id: null })).toStrictEqual({
      type: "error",
      message: "",
    });
  });

  it("clip_saved, within and beyond its limits", () => {
    expect(stage({ type: "clip_saved", reason: "laugh", path: "C:\\clips\\a.mkv" })).toStrictEqual({
      type: "clip_saved",
      reason: "laugh",
      path: "C:\\clips\\a.mkv",
    });
    expect(stage({ type: "clip_saved", reason: "x".repeat(120), path: "p" })).toHaveProperty(
      "reason",
    );
    expect(() => stage({ type: "clip_saved", reason: "x".repeat(121), path: "p" })).toThrow(
      ZodError,
    );
    expect(() => stage({ type: "clip_saved", reason: "r", path: "p".repeat(1025) })).toThrow(
      ZodError,
    );
  });

  it("ping and pong", () => {
    expect(stage({ type: "ping" })).toStrictEqual({ type: "ping" });
    expect(stage({ type: "pong" })).toStrictEqual({ type: "pong" });
  });

  it("strips unknown keys", () => {
    expect(stage({ type: "ping", extra: 1 })).toStrictEqual({ type: "ping" });
    expect(stage({ type: "error", message: "m", unknown: { a: 1 } })).toStrictEqual({
      type: "error",
      message: "m",
    });
  });

  it("throws on an unknown or missing type, and on a Core message", () => {
    expect(() => stage({ type: "nope" })).toThrow(ZodError);
    expect(() => stage({})).toThrow(ZodError);
    expect(() => stage(null)).toThrow(ZodError);
    expect(() => stage("ping")).toThrow(ZodError);
    expect(() => stage({ type: "welcome", session: "s" })).toThrow(ZodError);
  });
});

describe("parseCoreMessage", () => {
  it("welcome", () => {
    expect(core({ type: "welcome", session: "s1" })).toStrictEqual({
      type: "welcome",
      session: "s1",
    });
  });

  it("emotion with resting", () => {
    expect(core({ type: "emotion", name: "joy", intensity: 0.5, resting: true })).toStrictEqual({
      type: "emotion",
      name: "joy",
      intensity: 0.5,
      resting: true,
    });
  });

  it("emotion without resting has no resting key", () => {
    expect(core({ type: "emotion", name: "joy", intensity: 0.5 })).toStrictEqual({
      type: "emotion",
      name: "joy",
      intensity: 0.5,
    });
  });

  it("emotion with a null resting", () => {
    const out = core({ type: "emotion", name: "joy", intensity: 0.5, resting: null });
    expect(out).toStrictEqual({ type: "emotion", name: "joy", intensity: 0.5, resting: undefined });
  });

  it("emotion does not bound the intensity", () => {
    expect(core({ type: "emotion", name: "x", intensity: 7, resting: false })).toHaveProperty(
      "intensity",
      7,
    );
    expect(core({ type: "emotion", name: "x", intensity: -2 })).toHaveProperty("intensity", -2);
  });

  it("subtitle", () => {
    expect(core({ type: "subtitle", turn: "t1", text: "嗨", final: false })).toStrictEqual({
      type: "subtitle",
      turn: "t1",
      text: "嗨",
      final: false,
    });
    expect(() => core({ type: "subtitle", turn: "t1", text: "x" })).toThrow(ZodError);
  });

  it("speaking", () => {
    expect(core({ type: "speaking", state: "started" })).toStrictEqual({
      type: "speaking",
      state: "started",
    });
    expect(core({ type: "speaking", state: "stopped" })).toStrictEqual({
      type: "speaking",
      state: "stopped",
    });
    expect(() => core({ type: "speaking", state: "paused" })).toThrow(ZodError);
  });

  it("scene with everything", () => {
    expect(
      core({ type: "scene", name: "Sing", transition: "Fade", transition_ms: 300, id: 9 }),
    ).toStrictEqual({ type: "scene", name: "Sing", transition: "Fade", transition_ms: 300, id: 9 });
  });

  it("scene with only the name: the optional keys are left out", () => {
    expect(core({ type: "scene", name: "Talk" })).toStrictEqual({ type: "scene", name: "Talk" });
  });

  it("scene: nulls are left out", () => {
    expect(
      core({ type: "scene", name: "Talk", transition: null, transition_ms: null, id: null }),
    ).toStrictEqual({ type: "scene", name: "Talk" });
  });

  it("scene: the transition name is trimmed, a blank one is left out", () => {
    expect(core({ type: "scene", name: "Talk", transition: "  Fade \n" })).toStrictEqual({
      type: "scene",
      name: "Talk",
      transition: "Fade",
    });
    expect(core({ type: "scene", name: "Talk", transition: "   " })).toStrictEqual({
      type: "scene",
      name: "Talk",
    });
    expect(core({ type: "scene", name: "Talk", transition: "" })).toStrictEqual({
      type: "scene",
      name: "Talk",
    });
  });

  it("scene: the scene name itself is not trimmed, and an empty one is accepted", () => {
    expect(core({ type: "scene", name: " Talk " })).toStrictEqual({
      type: "scene",
      name: " Talk ",
    });
    expect(core({ type: "scene", name: "" })).toStrictEqual({ type: "scene", name: "" });
  });

  it("scene: transition_ms 0 and the limit are kept, beyond them it throws", () => {
    expect(core({ type: "scene", name: "a", transition_ms: 0 })).toHaveProperty("transition_ms", 0);
    expect(core({ type: "scene", name: "a", transition_ms: 20_000 })).toHaveProperty(
      "transition_ms",
      20_000,
    );
    expect(() => core({ type: "scene", name: "a", transition_ms: 20_001 })).toThrow(ZodError);
    expect(() => core({ type: "scene", name: "a", transition_ms: -1 })).toThrow(ZodError);
    expect(() => core({ type: "scene", name: "a", transition_ms: 1.5 })).toThrow(ZodError);
  });

  it("stream", () => {
    expect(core({ type: "stream", action: "start", id: 1 })).toStrictEqual({
      type: "stream",
      action: "start",
      id: 1,
    });
    expect(core({ type: "stream", action: "stop" })).toStrictEqual({
      type: "stream",
      action: "stop",
    });
    expect(core({ type: "stream", action: "stop", id: null })).toStrictEqual({
      type: "stream",
      action: "stop",
    });
    expect(() => core({ type: "stream", action: "pause" })).toThrow(ZodError);
  });

  it("avatar_hotkey", () => {
    expect(core({ type: "avatar_hotkey", name: "wave", id: 2 })).toStrictEqual({
      type: "avatar_hotkey",
      name: "wave",
      id: 2,
    });
    expect(core({ type: "avatar_hotkey", name: "wave" })).toStrictEqual({
      type: "avatar_hotkey",
      name: "wave",
    });
  });

  it("gaze", () => {
    for (const target of ["chat", "game", "camera"]) {
      expect(core({ type: "gaze", target })).toStrictEqual({ type: "gaze", target });
    }
    expect(() => core({ type: "gaze", target: "floor" })).toThrow(ZodError);
    expect(() => core({ type: "gaze", target: " chat " })).toThrow(ZodError);
  });

  it("avatar_expression, with the seconds at and beyond their limits", () => {
    expect(
      core({ type: "avatar_expression", expression: "heart", seconds: 5, id: 4 }),
    ).toStrictEqual({ type: "avatar_expression", expression: "heart", seconds: 5, id: 4 });
    expect(core({ type: "avatar_expression", expression: "blush", seconds: 1 })).toStrictEqual({
      type: "avatar_expression",
      expression: "blush",
      seconds: 1,
    });
    expect(core({ type: "avatar_expression", expression: "squint", seconds: 15 })).toHaveProperty(
      "seconds",
      15,
    );
    expect(() => core({ type: "avatar_expression", expression: "big_bowl", seconds: 0.5 })).toThrow(
      ZodError,
    );
    expect(() => core({ type: "avatar_expression", expression: "big_bowl", seconds: 16 })).toThrow(
      ZodError,
    );
    expect(() => core({ type: "avatar_expression", expression: "angry", seconds: 3 })).toThrow(
      ZodError,
    );
  });

  it("gift, at and beyond its limits", () => {
    const gift = { type: "gift", name: "Mia", item: "bowl", count: 3, label: "a bowl" };
    expect(core(gift)).toStrictEqual(gift);
    expect(core({ ...gift, count: 99 })).toHaveProperty("count", 99);
    expect(core({ ...gift, name: "n".repeat(32) })).toHaveProperty("name", "n".repeat(32));
    expect(() => core({ ...gift, count: 0 })).toThrow(ZodError);
    expect(() => core({ ...gift, count: 100 })).toThrow(ZodError);
    expect(() => core({ ...gift, count: 1.5 })).toThrow(ZodError);
    expect(() => core({ ...gift, name: "n".repeat(33) })).toThrow(ZodError);
    expect(() => core({ ...gift, item: "i".repeat(33) })).toThrow(ZodError);
    expect(() => core({ ...gift, label: "l".repeat(25) })).toThrow(ZodError);
  });

  it("screen, a paid message", () => {
    expect(core({ type: "screen", name: "Mia", text: "hi" })).toStrictEqual({
      type: "screen",
      name: "Mia",
      text: "hi",
    });
  });

  it("screen: the lengths are bounded", () => {
    expect(() => core({ type: "screen", name: "n".repeat(33), text: "t" })).toThrow(ZodError);
    expect(() => core({ type: "screen", name: "n", text: "t".repeat(201) })).toThrow(ZodError);
  });

  it("touch, at and beyond the picture's edges", () => {
    expect(core({ type: "touch", x: 0, y: 1, part: "head" })).toStrictEqual({
      type: "touch",
      x: 0,
      y: 1,
      part: "head",
    });
    for (const part of ["face", "body", "screen"]) {
      expect(core({ type: "touch", x: 0.5, y: 0.5, part })).toHaveProperty("part", part);
    }
    expect(() => core({ type: "touch", x: 1.01, y: 0.5, part: "head" })).toThrow(ZodError);
    expect(() => core({ type: "touch", x: 0.5, y: -0.01, part: "head" })).toThrow(ZodError);
    expect(() => core({ type: "touch", x: 0.5, y: 0.5, part: "hand" })).toThrow(ZodError);
  });

  it("song_video play with everything", () => {
    expect(
      core({
        type: "song_video",
        action: "play",
        song: "Song",
        path: "C:\\cache\\a.mp4",
        offset_ms: 1500,
        scene: "Sing",
      }),
    ).toStrictEqual({
      type: "song_video",
      action: "play",
      song: "Song",
      path: "C:\\cache\\a.mp4",
      offset_ms: 1500,
      scene: "Sing",
    });
  });

  it("song_video stop: the optional keys are left out", () => {
    expect(core({ type: "song_video", action: "stop", song: "Song" })).toStrictEqual({
      type: "song_video",
      action: "stop",
      song: "Song",
    });
  });

  it("song_video: nulls and empty strings are left out, the scene is trimmed", () => {
    expect(
      core({
        type: "song_video",
        action: "play",
        song: "Song",
        path: null,
        offset_ms: null,
        scene: null,
      }),
    ).toStrictEqual({ type: "song_video", action: "play", song: "Song" });
    expect(
      core({ type: "song_video", action: "play", song: "Song", path: "", scene: "   " }),
    ).toStrictEqual({ type: "song_video", action: "play", song: "Song" });
    expect(
      core({ type: "song_video", action: "play", song: "Song", scene: "  Sing  " }),
    ).toStrictEqual({ type: "song_video", action: "play", song: "Song", scene: "Sing" });
  });

  it("song_video: a path is not trimmed, offset 0 is kept, limits throw", () => {
    expect(
      core({ type: "song_video", action: "play", song: "S", path: " a ", offset_ms: 0 }),
    ).toStrictEqual({
      type: "song_video",
      action: "play",
      song: "S",
      path: " a ",
      offset_ms: 0,
    });
    expect(() => core({ type: "song_video", action: "play", song: "S", offset_ms: -1 })).toThrow(
      ZodError,
    );
    expect(() =>
      core({ type: "song_video", action: "play", song: "S", offset_ms: 86_400_001 }),
    ).toThrow(ZodError);
    expect(() =>
      core({ type: "song_video", action: "play", song: "S", path: "p".repeat(1025) }),
    ).toThrow(ZodError);
    expect(() => core({ type: "song_video", action: "play", song: "s".repeat(129) })).toThrow(
      ZodError,
    );
    expect(() => core({ type: "song_video", action: "seek", song: "S" })).toThrow(ZodError);
  });

  it("beat, and an empty one that stops it", () => {
    expect(
      core({ type: "beat", song: "Song", bpm: 120, times_ms: [0, 500, 1000], offset_ms: 250 }),
    ).toStrictEqual({
      type: "beat",
      song: "Song",
      bpm: 120,
      times_ms: [0, 500, 1000],
      offset_ms: 250,
    });
    expect(core({ type: "beat", song: "Song", bpm: 0, times_ms: [], offset_ms: 0 })).toStrictEqual({
      type: "beat",
      song: "Song",
      bpm: 0,
      times_ms: [],
      offset_ms: 0,
    });
  });

  it("beat: the bpm, the times and the count are bounded", () => {
    const beat = { type: "beat", song: "S", bpm: 120, times_ms: [0], offset_ms: 0 };
    expect(core({ ...beat, bpm: 400 })).toHaveProperty("bpm", 400);
    expect(core({ ...beat, times_ms: new Array(2000).fill(1) })).toHaveProperty(
      "times_ms.length",
      2000,
    );
    expect(() => core({ ...beat, bpm: 401 })).toThrow(ZodError);
    expect(() => core({ ...beat, bpm: -1 })).toThrow(ZodError);
    expect(() => core({ ...beat, times_ms: new Array(2001).fill(1) })).toThrow(ZodError);
    expect(() => core({ ...beat, times_ms: [-1] })).toThrow(ZodError);
    expect(() => core({ ...beat, times_ms: [86_400_001] })).toThrow(ZodError);
    expect(() => core({ ...beat, offset_ms: -1 })).toThrow(ZodError);
  });

  it("clip, with and without an id", () => {
    expect(core({ type: "clip", reason: "laugh", id: 5 })).toStrictEqual({
      type: "clip",
      reason: "laugh",
      id: 5,
    });
    expect(core({ type: "clip", reason: "laugh" })).toStrictEqual({
      type: "clip",
      reason: "laugh",
    });
    expect(() => core({ type: "clip", reason: "x".repeat(121) })).toThrow(ZodError);
  });

  it("notice, and the empty one that clears the line", () => {
    expect(core({ type: "notice", text: "準備歌曲中…" })).toStrictEqual({
      type: "notice",
      text: "準備歌曲中…",
    });
    expect(core({ type: "notice", text: "" })).toStrictEqual({ type: "notice", text: "" });
    expect(() => core({ type: "notice", text: "x".repeat(201) })).toThrow(ZodError);
  });

  it("activity with everything", () => {
    expect(
      core({
        type: "activity",
        kind: "singing",
        label: "唱歌中",
        detail: "Song",
        progress: 0.25,
        elapsed_ms: 5000,
        duration_ms: 200_000,
      }),
    ).toStrictEqual({
      type: "activity",
      kind: "singing",
      label: "唱歌中",
      detail: "Song",
      progress: 0.25,
      elapsed_ms: 5000,
      duration_ms: 200_000,
    });
  });

  it("activity that hides the line, and one with only a kind: the rest default", () => {
    const hidden = {
      type: "activity",
      kind: null,
      label: "",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    };
    expect(core({ type: "activity", kind: null })).toStrictEqual(hidden);
    expect(core(hidden)).toStrictEqual(hidden);
    expect(core({ type: "activity", kind: "thinking" })).toStrictEqual({
      ...hidden,
      kind: "thinking",
    });
  });

  it("activity: every kind is accepted, a missing kind or an unknown one throws", () => {
    for (const kind of ["thinking", "synthesizing", "song_prepare", "singing"]) {
      expect(core({ type: "activity", kind })).toHaveProperty("kind", kind);
    }
    expect(() => core({ type: "activity" })).toThrow(ZodError);
    expect(() => core({ type: "activity", kind: "dancing" })).toThrow(ZodError);
  });

  it("activity: limits throw, an explicit null for a defaulted field stays null", () => {
    expect(() => core({ type: "activity", kind: "singing", label: "l".repeat(41) })).toThrow(
      ZodError,
    );
    expect(() => core({ type: "activity", kind: "singing", detail: "d".repeat(121) })).toThrow(
      ZodError,
    );
    expect(() => core({ type: "activity", kind: "singing", progress: 1.01 })).toThrow(ZodError);
    expect(() => core({ type: "activity", kind: "singing", progress: -0.1 })).toThrow(ZodError);
    expect(() => core({ type: "activity", kind: "singing", elapsed_ms: -1 })).toThrow(ZodError);
    expect(() => core({ type: "activity", kind: "singing", duration_ms: 0 })).toThrow(ZodError);
    expect(() => core({ type: "activity", kind: "singing", duration_ms: 86_400_001 })).toThrow(
      ZodError,
    );
    expect(core({ type: "activity", kind: "singing", progress: 0, duration_ms: 1 })).toMatchObject({
      progress: 0,
      duration_ms: 1,
    });
    expect(core({ type: "activity", kind: "singing", detail: null, progress: null })).toMatchObject(
      {
        detail: null,
        progress: null,
      },
    );
  });

  it("status_request, with and without an id", () => {
    expect(core({ type: "status_request", id: 8 })).toStrictEqual({
      type: "status_request",
      id: 8,
    });
    expect(core({ type: "status_request" })).toStrictEqual({ type: "status_request" });
    expect(core({ type: "status_request", id: null })).toStrictEqual({ type: "status_request" });
  });

  it("ping and pong", () => {
    expect(core({ type: "ping" })).toStrictEqual({ type: "ping" });
    expect(core({ type: "pong" })).toStrictEqual({ type: "pong" });
  });

  it("strips unknown keys", () => {
    expect(core({ type: "notice", text: "t", later: true })).toStrictEqual({
      type: "notice",
      text: "t",
    });
    expect(core({ type: "scene", name: "a", surprise: [1] })).toStrictEqual({
      type: "scene",
      name: "a",
    });
  });

  it("throws on an unknown or missing type, and on a Stage message", () => {
    expect(() => core({ type: "nope" })).toThrow(ZodError);
    expect(() => core({})).toThrow(ZodError);
    expect(() => core(undefined)).toThrow(ZodError);
    expect(() => core([])).toThrow(ZodError);
    expect(() => core({ type: "hello", version: 1, token: "t" })).toThrow(ZodError);
    expect(() => core({ type: "error", message: "m" })).toThrow(ZodError);
  });
});

describe("parseLevelFrame", () => {
  it("a frame with everything", () => {
    expect(parseLevelFrame({ t: 120, rms: 0.4, bands: [0.1, 0.2, 0.3] })).toStrictEqual({
      t: 120,
      rms: 0.4,
      bands: [0.1, 0.2, 0.3],
    });
  });

  it("a frame with only rms has neither key", () => {
    expect(parseLevelFrame({ rms: 0 })).toStrictEqual({ rms: 0 });
  });

  it("an undefined t or bands is left out", () => {
    expect(parseLevelFrame({ rms: 1, t: undefined, bands: undefined })).toStrictEqual({ rms: 1 });
  });

  it("does not clamp: rms and t are taken as they are", () => {
    expect(parseLevelFrame({ rms: 7, t: -5 })).toStrictEqual({ rms: 7, t: -5 });
  });

  it("an empty bands array stays", () => {
    expect(parseLevelFrame({ rms: 0.1, bands: [] })).toStrictEqual({ rms: 0.1, bands: [] });
  });

  it("up to 32 bands, then it throws", () => {
    expect(parseLevelFrame({ rms: 0.1, bands: new Array(32).fill(0.5) })).toHaveProperty(
      "bands.length",
      32,
    );
    expect(() => parseLevelFrame({ rms: 0.1, bands: new Array(33).fill(0.5) })).toThrow(ZodError);
  });

  it("a null t or null bands throws (they are optional, not nullable)", () => {
    expect(() => parseLevelFrame({ rms: 0.1, t: null })).toThrow(ZodError);
    expect(() => parseLevelFrame({ rms: 0.1, bands: null })).toThrow(ZodError);
  });

  it("a missing or non-numeric rms throws", () => {
    expect(() => parseLevelFrame({})).toThrow(ZodError);
    expect(() => parseLevelFrame({ rms: "0.5" })).toThrow(ZodError);
    expect(() => parseLevelFrame(null)).toThrow(ZodError);
  });

  it("strips unknown keys, a type included", () => {
    expect(parseLevelFrame({ type: "levels", rms: 0.2, extra: 1 })).toStrictEqual({ rms: 0.2 });
  });
});
