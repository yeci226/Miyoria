// One example of every voice link message in each direction: it parses, and written out as JSON
// and read again it is the same. Then what lets the two sides drift apart safely (an older peer,
// unknown keys and types), the constants and the binary frame header.

import { describe, expect, it } from "vitest";
import {
  readFrameHeader,
  VOICE_LINK_CAPABILITIES,
  VOICE_LINK_CLOSE,
  VOICE_LINK_FRAME,
  VOICE_LINK_FRAME_HEADER_BYTES,
  VOICE_LINK_LIMITS,
  VOICE_LINK_U32_MAX,
  VOICE_LINK_VERSION,
  type VoiceLinkCoreMessageIn,
  VoiceLinkCoreMessageSchema,
  type VoiceLinkNodeMessageIn,
  VoiceLinkNodeMessageSchema,
  writeFrameHeader,
} from "../src/index.js";

const nodeExamples: VoiceLinkNodeMessageIn[] = [
  {
    type: "hello",
    version: 1,
    token: "t",
    node: "voice-node",
    self_account: { platform: "discord", id: "42" },
    capabilities: ["play_duck", "play_pause"],
  },
  { type: "joined", guild: "1", channel: "2" },
  { type: "left", guild: "1", reason: "leave" },
  {
    type: "voice_state",
    guild: "1",
    channel: "2",
    participants: [
      { user_id: "3", display_name: "A", is_self: false, muted: true, deafened: false },
    ],
  },
  { type: "speaking", guild: "1", user_id: "3", speaking: true },
  {
    type: "stream_open",
    stream: 5,
    guild: "1",
    channel: "2",
    user_id: "3",
    display_name: "A",
    sample_rate: 16_000,
  },
  { type: "stream_close", stream: 5 },
  { type: "playback", play: 7, state: "failed", error: "x" },
  { type: "golive", guild: "1", state: "stopped", error: null, reason: "source ended" },
  { type: "watch", guild: "1", user_id: "3", state: "failed", error: "no stream", reason: null },
  { type: "watch_snapshot_failed", id: 9, error: "no frame yet" },
  { type: "error", message: "m" },
  { type: "ping" },
  { type: "pong" },
];

const coreExamples: VoiceLinkCoreMessageIn[] = [
  { type: "welcome", session: "01J" },
  { type: "join", guild: "1", channel: "2" },
  { type: "join", guild: "1", user_id: "3" },
  { type: "leave", guild: "1" },
  { type: "play_start", play: 7, guild: "1", sample_rate: 24_000, levels: true },
  { type: "play_end", play: 7 },
  { type: "play_stop", play: 7, fade_ms: 80 },
  { type: "play_duck", play: 7, gain: 0.25, fade_ms: 150 },
  { type: "play_pause", play: 7, fade_ms: 80 },
  { type: "play_resume", play: 7, fade_ms: 80 },
  {
    type: "golive_start",
    guild: "1",
    channel: "2",
    source: "rtmp://127.0.0.1:1935/live/miyoria",
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate_kbps: 6000,
    encoder: "nvenc",
    audio: false,
    listen: true,
  },
  { type: "golive_stop", guild: "1" },
  { type: "watch_start", guild: "1", user_id: "3" },
  { type: "watch_stop", guild: "1" },
  { type: "watch_snapshot", id: 9 },
  { type: "ping" },
  { type: "pong" },
];

const tags = (schema: { options: ReadonlyArray<{ shape: { type: { value: string } } }> }) =>
  schema.options.map((option) => option.shape.type.value);

describe("every message", () => {
  it("node → Core: each type has an example that parses and round-trips", () => {
    expect(nodeExamples.map((m) => m.type).sort()).toEqual(tags(VoiceLinkNodeMessageSchema).sort());
    for (const example of nodeExamples) {
      const parsed = VoiceLinkNodeMessageSchema.parse(example);
      expect(parsed).toStrictEqual(example);
      expect(VoiceLinkNodeMessageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
        parsed,
      );
    }
  });

  it("Core → node: each type has an example that parses and round-trips", () => {
    expect([...new Set(coreExamples.map((m) => m.type))].sort()).toEqual(
      tags(VoiceLinkCoreMessageSchema).sort(),
    );
    for (const example of coreExamples) {
      const parsed = VoiceLinkCoreMessageSchema.parse(example);
      expect(parsed).toStrictEqual(example);
      expect(VoiceLinkCoreMessageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
        parsed,
      );
    }
  });
});

describe("older and newer peers", () => {
  it("an older node's hello, without `node` or `capabilities`, still parses", () => {
    expect(
      VoiceLinkNodeMessageSchema.parse({
        type: "hello",
        version: 1,
        token: "t",
        self_account: { platform: "discord", id: "42" },
      }),
    ).toStrictEqual({
      type: "hello",
      version: 1,
      token: "t",
      node: "",
      self_account: { platform: "discord", id: "42" },
      capabilities: [],
    });
  });

  it("keys a receiver does not know are dropped, not refused", () => {
    expect(
      VoiceLinkNodeMessageSchema.parse({ type: "joined", guild: "1", channel: "2", later: 1 }),
    ).toStrictEqual({
      type: "joined",
      guild: "1",
      channel: "2",
    });
    expect(
      VoiceLinkCoreMessageSchema.parse({ type: "leave", guild: "1", later: [1] }),
    ).toStrictEqual({
      type: "leave",
      guild: "1",
    });
  });

  it("a type a receiver does not know is not one of the union's tags", () => {
    expect(tags(VoiceLinkCoreMessageSchema)).not.toContain("future_thing");
    expect(VoiceLinkCoreMessageSchema.safeParse({ type: "future_thing" }).success).toBe(false);
    expect(VoiceLinkNodeMessageSchema.safeParse({ type: "future_thing" }).success).toBe(false);
  });

  it("Core may leave out or null every optional field", () => {
    expect(VoiceLinkCoreMessageSchema.parse({ type: "play_stop", play: 1 })).toStrictEqual({
      type: "play_stop",
      play: 1,
      fade_ms: 0,
    });
    expect(
      VoiceLinkCoreMessageSchema.parse({ type: "play_stop", play: 1, fade_ms: null }),
    ).toStrictEqual({
      type: "play_stop",
      play: 1,
      fade_ms: null,
    });
    const golive = VoiceLinkCoreMessageSchema.parse({
      type: "golive_start",
      guild: "1",
      source: "x",
      channel: null,
      width: null,
      encoder: null,
      audio: null,
    });
    expect(golive).toStrictEqual({
      type: "golive_start",
      guild: "1",
      source: "x",
      channel: null,
      width: null,
      encoder: null,
      audio: null,
    });
  });

  it("`levels` is never a reason to refuse a play_start", () => {
    const base = { type: "play_start", play: 1, guild: "1", sample_rate: 48_000 } as const;
    for (const levels of [false, null, "yes", 1]) {
      const parsed = VoiceLinkCoreMessageSchema.parse({ ...base, levels });
      expect(parsed.type === "play_start" && parsed.levels).toBe(
        levels === false ? false : undefined,
      );
    }
  });
});

describe("bounds of Core's messages", () => {
  const ok = (value: unknown) => VoiceLinkCoreMessageSchema.safeParse(value).success;

  it("ids are 1 to 64 characters", () => {
    expect(ok({ type: "leave", guild: "x".repeat(VOICE_LINK_LIMITS.ID_MAX_LENGTH) })).toBe(true);
    expect(ok({ type: "leave", guild: "x".repeat(VOICE_LINK_LIMITS.ID_MAX_LENGTH + 1) })).toBe(
      false,
    );
    expect(ok({ type: "leave", guild: "" })).toBe(false);
  });

  it("play ids are u32, sample rates 8000..192000", () => {
    const start = (play: number, sample_rate: number) =>
      ok({ type: "play_start", play, guild: "1", sample_rate });
    expect(start(VOICE_LINK_U32_MAX, 8000)).toBe(true);
    expect(start(VOICE_LINK_U32_MAX + 1, 8000)).toBe(false);
    expect(start(-1, 8000)).toBe(false);
    expect(start(0, 7999)).toBe(false);
    expect(start(0, 192_000)).toBe(true);
    expect(start(0, 192_001)).toBe(false);
  });

  it("gain is 0..1, fade_ms not negative, source not blank and at most 2048", () => {
    expect(ok({ type: "play_duck", play: 1, gain: 1 })).toBe(true);
    expect(ok({ type: "play_duck", play: 1, gain: 1.01 })).toBe(false);
    expect(ok({ type: "play_duck", play: 1, gain: 0.5, fade_ms: -1 })).toBe(false);
    expect(ok({ type: "play_duck", play: 1, gain: 0.5, fade_ms: Infinity })).toBe(false);
    const golive = (source: string) => ok({ type: "golive_start", guild: "1", source });
    expect(golive("x".repeat(VOICE_LINK_LIMITS.SOURCE_MAX_LENGTH))).toBe(true);
    expect(golive("x".repeat(VOICE_LINK_LIMITS.SOURCE_MAX_LENGTH + 1))).toBe(false);
    expect(golive(" \t　")).toBe(false);
  });

  it("the encoder is one of three", () => {
    for (const encoder of ["auto", "nvenc", "software"]) {
      expect(ok({ type: "golive_start", guild: "1", source: "x", encoder })).toBe(true);
    }
    expect(ok({ type: "golive_start", guild: "1", source: "x", encoder: "x264" })).toBe(false);
  });
});

describe("constants and frames", () => {
  it("are the protocol's numbers", () => {
    expect(VOICE_LINK_VERSION).toBe(1);
    expect(VOICE_LINK_CLOSE).toStrictEqual({
      BAD_HELLO: 4400,
      UNAUTHORIZED: 4401,
      TIMEOUT: 4408,
      REPLACED: 4409,
      GOING_AWAY: 1001,
    });
    expect(VOICE_LINK_FRAME).toStrictEqual({
      CAPTURE: 1,
      PLAYBACK: 2,
      LEVELS: 3,
      SNAPSHOT: 4,
      WATCH_AUDIO: 5,
    });
    expect(VOICE_LINK_CAPABILITIES).toEqual(["play_duck", "play_pause", "watch"]);
  });

  it("has the frames of a watched stream: a snapshot by its request's id, and the stream's audio", () => {
    expect(VOICE_LINK_FRAME.SNAPSHOT).toBe(0x04);
    expect(VOICE_LINK_FRAME.WATCH_AUDIO).toBe(0x05);
  });

  it("writes and reads the frame header, little endian, at the view's offset", () => {
    const backing = new Uint8Array(3 + VOICE_LINK_FRAME_HEADER_BYTES + 2);
    const frame = backing.subarray(3);
    writeFrameHeader(frame, VOICE_LINK_FRAME.LEVELS, 0x0102_0304);
    expect([...backing]).toEqual([0, 0, 0, 3, 4, 3, 2, 1, 0, 0]);
    expect(readFrameHeader(frame)).toEqual({ tag: 3, id: 0x0102_0304 });
    writeFrameHeader(frame, VOICE_LINK_FRAME.CAPTURE, VOICE_LINK_U32_MAX);
    expect(readFrameHeader(frame)).toEqual({ tag: 1, id: VOICE_LINK_U32_MAX });
    expect(readFrameHeader(frame.subarray(0, VOICE_LINK_FRAME_HEADER_BYTES - 1))).toBeNull();
  });
});
