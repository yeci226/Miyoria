// The stage link: every message round-trips through JSON, the unions tell the types apart, and the
// schemas accept what a peer may send (a `null` where a field is optional, a field left out where
// it was added after v1) and reject what is out of bounds.

import { describe, expect, it } from "vitest";
import {
  type CoreMessageIn,
  STAGE_LINK_VERSION,
  StageLinkCoreMessageSchema,
  StageLinkLevelFrameSchema,
  StageLinkStageMessageSchema,
  type StageMessageIn,
} from "../src/index.js";

const stageMessages: StageMessageIn[] = [
  { type: "hello", version: STAGE_LINK_VERSION, token: "t", node: "pc", capabilities: ["obs"] },
  {
    type: "status",
    id: 3,
    vts: true,
    obs: true,
    scene: "Talk",
    streaming: false,
    scenes: ["Talk", "Sing"],
    hotkeys: ["wave"],
    overlay_url: "http://pc:7884/overlay/",
    obs_collection: "我的場景",
    obs_warning: "OBS 不在「Miyoria」這份場景集合上(現在是「我的場景」)",
  },
  { type: "error", message: "no obs", id: 3 },
  { type: "clip_saved", reason: "laugh", path: "C:\\clips\\a.mkv" },
  { type: "danmaku_done", id: "01J", outcome: "shown" },
  { type: "ping" },
  { type: "pong" },
];

const coreMessages: CoreMessageIn[] = [
  { type: "welcome", session: "s1" },
  { type: "emotion", name: "joy", intensity: 0.5, resting: true },
  { type: "subtitle", turn: "t1", text: "嗨", final: false },
  { type: "speaking", state: "started" },
  { type: "scene", name: "Sing", transition: "Fade", transition_ms: 300, id: 9 },
  { type: "stream", action: "start", id: 1 },
  { type: "avatar_hotkey", name: "wave", id: 2 },
  { type: "gaze", target: "chat" },
  { type: "avatar_expression", expression: "heart", seconds: 5, id: 4 },
  { type: "gift", name: "Mia", item: "bowl", count: 3, label: "a bowl" },
  { type: "screen", name: "Mia", text: "hi" },
  {
    type: "danmaku",
    id: "01J",
    name: null,
    text: "好可愛",
    max_on_screen: 12,
    queue_max: 20,
    max_wait_ms: 30_000,
  },
  { type: "danmaku_clear" },
  { type: "touch", x: 0.25, y: 0.75, part: "head" },
  {
    type: "song_video",
    action: "play",
    song: "Song",
    path: "C:\\cache\\a.mp4",
    offset_ms: 1500,
    scene: "Sing",
  },
  { type: "beat", song: "Song", bpm: 120, times_ms: [0, 500], offset_ms: 250 },
  { type: "clip", reason: "laugh", id: 5 },
  { type: "notice", text: "準備歌曲中…" },
  {
    type: "activity",
    kind: "singing",
    label: "唱歌中",
    detail: "Song",
    progress: 0.25,
    elapsed_ms: 5000,
    duration_ms: 200_000,
  },
  {
    type: "karaoke",
    room: "ABC234",
    state: "singing",
    round: 1,
    rounds_left: 3,
    song: { id: "k1", title: "紙船", artist: null, duration_ms: 200_000 },
    shift: 0,
    queue: [{ title: "Lemon", artist: "米津玄師", by: "小華", state: "preparing" }],
    join_url: "https://karaoke.example.com/karaoke/room/ABC234",
    qr_while_singing: false,
    members: [{ name: "小明", color: 0, role: "singer", ready: true, opener: true }],
    position_ms: -1_500,
    board: [
      {
        name: "小明",
        color: 0,
        rank: 1,
        total: 81.5,
        source: "voice",
        move: "same",
        winner: false,
        coins: 0,
        finished: false,
        on_air: true,
        parts: null,
        pitch: { from: 100, track: "PD0+" },
        cheers: 2,
      },
    ],
    note: null,
    currency: "魚幣",
    air: {
      backing: true,
      relay: "小明",
      delay_ms: 2_000,
      backing_gain: 0.8,
      voice_gain: 1.5,
      duck_gain: 0.35,
    },
    settling: null,
    cheers: [
      { id: "c1-1", kind: "wow", to: { name: "小明", color: 0 }, by: { name: "小華", color: 2 } },
    ],
  },
  {
    type: "karaoke_lyrics",
    room: "ABC234",
    round: 1,
    song: "k1",
    lyrics: null,
    video: null,
    backing: { path: "C:/k/k1/play_karaoke.pcm", format: "pcm", rate: 48_000 },
    notes: [{ start: 1.5, end: 2, midi: 62 }],
  },
  { type: "karaoke_voice", room: "ABC234", round: 1, at_ms: 1_250, audio: "/////w==" },
  { type: "status_request", id: 8 },
  { type: "ping" },
  { type: "pong" },
];

const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("StageMessage", () => {
  it.each(stageMessages.map((m) => [m.type, m] as const))("%s round-trips", (_type, message) => {
    expect(StageLinkStageMessageSchema.parse(viaJson(message))).toEqual(message);
  });

  it("fills what an older node leaves out", () => {
    expect(StageLinkStageMessageSchema.parse({ type: "status" })).toEqual({
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
    expect(StageLinkStageMessageSchema.parse({ type: "hello", version: 1, token: "" })).toEqual({
      type: "hello",
      version: 1,
      token: "",
      node: "",
      capabilities: [],
    });
  });

  it("takes a null id, and keeps it null (the receiver drops it)", () => {
    expect(StageLinkStageMessageSchema.parse({ type: "error", message: "m", id: null })).toEqual({
      type: "error",
      message: "m",
      id: null,
    });
  });

  it("rejects an unknown type, a Core message and a bad id", () => {
    expect(StageLinkStageMessageSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(StageLinkStageMessageSchema.safeParse({ type: "welcome", session: "s" }).success).toBe(
      false,
    );
    expect(
      StageLinkStageMessageSchema.safeParse({ type: "error", message: "m", id: -1 }).success,
    ).toBe(false);
  });
});

describe("CoreMessage", () => {
  it.each(coreMessages.map((m) => [m.type, m] as const))("%s round-trips", (_type, message) => {
    expect(StageLinkCoreMessageSchema.parse(viaJson(message))).toEqual(message);
  });

  it("covers every type of the union once", () => {
    const tags = StageLinkCoreMessageSchema.options.map((o) => o.shape.type.value).sort();
    const sent = [...new Set(coreMessages.map((m) => m.type))].sort();
    expect(sent).toEqual(tags);
  });

  it("fills the activity fields an older Core leaves out", () => {
    expect(StageLinkCoreMessageSchema.parse({ type: "activity", kind: null })).toEqual({
      type: "activity",
      kind: null,
      label: "",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    });
  });

  it("takes a null where a field is optional and leaves a missing one missing", () => {
    expect(
      StageLinkCoreMessageSchema.parse({
        type: "scene",
        name: "Talk",
        transition: null,
        transition_ms: null,
        id: null,
      }),
    ).toEqual({ type: "scene", name: "Talk", transition: null, transition_ms: null, id: null });
    expect(StageLinkCoreMessageSchema.parse({ type: "scene", name: "Talk" })).toStrictEqual({
      type: "scene",
      name: "Talk",
    });
  });

  it("does not trim or empty-check: that is the receiver's", () => {
    expect(
      StageLinkCoreMessageSchema.parse({ type: "scene", name: "a", transition: "  Fade " }),
    ).toHaveProperty("transition", "  Fade ");
    expect(
      StageLinkCoreMessageSchema.parse({ type: "song_video", action: "play", song: "S", path: "" }),
    ).toHaveProperty("path", "");
  });

  it("strips a key it does not know and rejects a type it does not know", () => {
    expect(StageLinkCoreMessageSchema.parse({ type: "ping", later: 1 })).toStrictEqual({
      type: "ping",
    });
    expect(StageLinkCoreMessageSchema.safeParse({ type: "dance" }).success).toBe(false);
  });

  it.each([
    ["scene", { type: "scene", name: "a", transition_ms: 20_001 }],
    ["avatar_expression", { type: "avatar_expression", expression: "heart", seconds: 16 }],
    ["gift", { type: "gift", name: "n", item: "i", count: 100, label: "l" }],
    ["touch", { type: "touch", x: 1.5, y: 0, part: "head" }],
    ["beat", { type: "beat", song: "S", bpm: 401, times_ms: [], offset_ms: 0 }],
    ["activity", { type: "activity", kind: "singing", progress: 2 }],
    ["notice", { type: "notice", text: "x".repeat(201) }],
    [
      "danmaku",
      {
        type: "danmaku",
        id: "a",
        name: null,
        text: "x".repeat(101),
        max_on_screen: 12,
        queue_max: 20,
        max_wait_ms: 1,
      },
    ],
    [
      "danmaku",
      {
        type: "danmaku",
        id: "a",
        name: null,
        text: "",
        max_on_screen: 12,
        queue_max: 20,
        max_wait_ms: 1,
      },
    ],
    [
      "danmaku",
      {
        type: "danmaku",
        id: "a",
        name: "n",
        text: "t",
        max_on_screen: 0,
        queue_max: 20,
        max_wait_ms: 1,
      },
    ],
  ])("rejects an out-of-bounds %s", (_type, message) => {
    expect(StageLinkCoreMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe("LevelFrame", () => {
  it("round-trips a frame with and without the optional fields", () => {
    const full = { t: 120, rms: 0.4, bands: [0.1, 0.2] };
    expect(StageLinkLevelFrameSchema.parse(viaJson(full))).toEqual(full);
    expect(StageLinkLevelFrameSchema.parse({ rms: 0 })).toStrictEqual({ rms: 0 });
  });

  it("allows 32 bands and no more, and no null", () => {
    expect(
      StageLinkLevelFrameSchema.safeParse({ rms: 0, bands: new Array(32).fill(0) }).success,
    ).toBe(true);
    expect(
      StageLinkLevelFrameSchema.safeParse({ rms: 0, bands: new Array(33).fill(0) }).success,
    ).toBe(false);
    expect(StageLinkLevelFrameSchema.safeParse({ rms: 0, t: null }).success).toBe(false);
  });
});
