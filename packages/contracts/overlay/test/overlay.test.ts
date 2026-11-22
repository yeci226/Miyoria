// The overlay feed: every message round-trips through JSON and the union tells them apart.

import { describe, expect, it } from "vitest";
import {
  type OverlayMessage,
  OverlayMessageSchema,
  type OverlayReply,
  OverlayReplySchema,
} from "../src/index.js";

const messages: OverlayMessage[] = [
  { type: "subtitle", turn: "t1", text: "嗨", final: true },
  { type: "emotion", name: "joy", intensity: 0.5 },
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
    type: "activity",
    kind: null,
    label: "",
    detail: null,
    progress: null,
    elapsed_ms: null,
    duration_ms: null,
  },
  { type: "gift", text: "Mia 送了 3 碗飯" },
  { type: "screen", name: "Mia", text: "hi" },
  {
    type: "danmaku",
    id: "01J",
    name: "Mia",
    text: "好可愛",
    max_on_screen: 12,
    queue_max: 20,
    max_wait_ms: 30_000,
  },
  {
    type: "danmaku",
    id: "01K",
    name: null,
    text: "晚安",
    max_on_screen: 12,
    queue_max: 20,
    max_wait_ms: 30_000,
  },
  { type: "danmaku_clear" },
  { type: "touch", x: 0.25, y: 0.75, part: "face" },
  { type: "speaking", state: "stopped" },
  { type: "levels", rms: 0.3, bands: [0.1, 0.2] },
  { type: "levels", rms: 0 },
  { type: "status", core: true, vts: true, obs: false, scene: null, streaming: false },
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
        cheers: 1,
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
];

describe("OverlayMessage", () => {
  it.each(messages.map((m, i) => [`${i} ${m.type}`, m] as const))("%s round-trips", (_name, m) => {
    expect(OverlayMessageSchema.parse(JSON.parse(JSON.stringify(m)))).toStrictEqual(m);
  });

  it("covers every type of the union", () => {
    const tags = OverlayMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect([...new Set(messages.map((m) => m.type))].sort()).toEqual(tags);
  });

  it("rejects a type it does not know, and `queue`, which nothing sends", () => {
    expect(OverlayMessageSchema.safeParse({ type: "queue", items: [] }).success).toBe(false);
    expect(OverlayMessageSchema.safeParse({ type: "dance" }).success).toBe(false);
  });
});

describe("OverlayReply", () => {
  const replies: OverlayReply[] = [
    { type: "danmaku_ready" },
    { type: "danmaku_shown", id: "01J" },
    { type: "danmaku_dropped", id: "01K", reason: "queue_full" },
    { type: "danmaku_dropped", id: "01L", reason: "too_late" },
    { type: "danmaku_dropped", id: "01M", reason: "cleared" },
  ];

  it.each(replies.map((m, i) => [`${i} ${m.type}`, m] as const))("%s round-trips", (_name, m) => {
    expect(OverlayReplySchema.parse(JSON.parse(JSON.stringify(m)))).toStrictEqual(m);
  });

  it("covers every type of the union, and refuses a reason it does not know", () => {
    const tags = OverlayReplySchema.options.map((o) => o.shape.type.value).sort();
    expect([...new Set(replies.map((m) => m.type))].sort()).toEqual(tags);
    const bad = { type: "danmaku_dropped", id: "x", reason: "bored" };
    expect(OverlayReplySchema.safeParse(bad).success).toBe(false);
  });
});
