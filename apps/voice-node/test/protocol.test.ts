import { describe, expect, it } from "vitest";
import {
  decodeBinaryFrame,
  encodeCaptureFrame,
  encodeNodeMessage,
  encodePlaybackFrame,
  FRAME_CAPTURE,
  FRAME_PLAYBACK,
  MAX_FADE_MS,
  parseCoreMessage,
  PROTOCOL_VERSION,
  U32_MAX,
} from "../src/protocol.js";

describe("binary frames", () => {
  it("encodes a capture frame as [0x01][u32 LE][pcm]", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const f = encodeCaptureFrame(0x01020304, pcm);
    expect([...f]).toEqual([0x01, 0x04, 0x03, 0x02, 0x01, 1, 2, 3, 4]);
  });

  it("round-trips capture and playback frames", () => {
    const pcm = Buffer.alloc(640, 7);
    const cap = decodeBinaryFrame(encodeCaptureFrame(42, pcm));
    expect(cap.ok && cap.value.kind).toBe(FRAME_CAPTURE);
    expect(cap.ok && cap.value.id).toBe(42);
    expect(cap.ok && cap.value.pcm.equals(pcm)).toBe(true);

    const play = decodeBinaryFrame(encodePlaybackFrame(U32_MAX, pcm));
    expect(play.ok && play.value.kind).toBe(FRAME_PLAYBACK);
    expect(play.ok && play.value.id).toBe(U32_MAX);
    expect(play.ok && play.value.pcm.length).toBe(640);
  });

  it("decodes a header-only frame as an empty payload", () => {
    const f = decodeBinaryFrame(Buffer.from([0x02, 9, 0, 0, 0]));
    expect(f.ok && f.value.pcm.length).toBe(0);
    expect(f.ok && f.value.id).toBe(9);
  });

  it("respects the byte offset of the input view", () => {
    const backing = Buffer.concat([Buffer.from([0xaa, 0xbb]), encodePlaybackFrame(5, Buffer.from([9, 9]))]);
    const f = decodeBinaryFrame(backing.subarray(2));
    expect(f.ok && f.value.id).toBe(5);
    expect(f.ok && [...f.value.pcm]).toEqual([9, 9]);
  });

  it("rejects short and unknown frames", () => {
    expect(decodeBinaryFrame(Buffer.from([0x01, 0, 0])).ok).toBe(false);
    const unknown = decodeBinaryFrame(Buffer.from([0x7f, 0, 0, 0, 0]));
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.ignorable).toBe(true);
  });

  it("rejects ids that do not fit a u32", () => {
    expect(() => encodeCaptureFrame(-1, Buffer.alloc(0))).toThrow(RangeError);
    expect(() => encodeCaptureFrame(U32_MAX + 1, Buffer.alloc(0))).toThrow(RangeError);
    expect(() => encodePlaybackFrame(1.5, Buffer.alloc(0))).toThrow(RangeError);
  });
});

describe("parseCoreMessage", () => {
  const ok = (o: unknown) => parseCoreMessage(JSON.stringify(o));

  it("parses welcome and ping", () => {
    expect(ok({ type: "welcome", session: "01J" })).toEqual({ ok: true, value: { type: "welcome", session: "01J" } });
    expect(ok({ type: "ping" })).toEqual({ ok: true, value: { type: "ping" } });
  });

  it("parses join by channel and by user", () => {
    expect(ok({ type: "join", guild: "1", channel: "2" })).toEqual({
      ok: true,
      value: { type: "join", guild: "1", channel: "2" },
    });
    expect(ok({ type: "join", guild: "1", user_id: "3" })).toEqual({
      ok: true,
      value: { type: "join", guild: "1", user_id: "3" },
    });
  });

  it("rejects join without a target or with wrong types", () => {
    expect(ok({ type: "join", guild: "1" }).ok).toBe(false);
    expect(ok({ type: "join", channel: "2" }).ok).toBe(false);
    expect(ok({ type: "join", guild: 1, channel: "2" }).ok).toBe(false);
    expect(ok({ type: "join", guild: "1", channel: 2 }).ok).toBe(false);
  });

  it("parses leave", () => {
    expect(ok({ type: "leave", guild: "9" })).toEqual({ ok: true, value: { type: "leave", guild: "9" } });
    expect(ok({ type: "leave" }).ok).toBe(false);
  });

  it("validates play_start", () => {
    expect(ok({ type: "play_start", play: 7, guild: "1", sample_rate: 24000 })).toEqual({
      ok: true,
      value: { type: "play_start", play: 7, guild: "1", sample_rate: 24000 },
    });
    expect(ok({ type: "play_start", play: -1, guild: "1", sample_rate: 24000 }).ok).toBe(false);
    expect(ok({ type: "play_start", play: U32_MAX + 1, guild: "1", sample_rate: 24000 }).ok).toBe(false);
    expect(ok({ type: "play_start", play: 1.5, guild: "1", sample_rate: 24000 }).ok).toBe(false);
    expect(ok({ type: "play_start", play: 1, guild: "1", sample_rate: 0 }).ok).toBe(false);
    expect(ok({ type: "play_start", play: 1, guild: "1", sample_rate: "24000" }).ok).toBe(false);
    expect(ok({ type: "play_start", play: 1, sample_rate: 24000 }).ok).toBe(false);
  });

  it("parses play_end and play_stop (fade defaults to 0, is clamped)", () => {
    expect(ok({ type: "play_end", play: 3 })).toEqual({ ok: true, value: { type: "play_end", play: 3 } });
    expect(ok({ type: "play_stop", play: 3, fade_ms: 120 })).toEqual({
      ok: true,
      value: { type: "play_stop", play: 3, fade_ms: 120 },
    });
    expect(ok({ type: "play_stop", play: 3 })).toEqual({ ok: true, value: { type: "play_stop", play: 3, fade_ms: 0 } });
    const big = ok({ type: "play_stop", play: 3, fade_ms: 1e9 });
    expect(big.ok && big.value).toEqual({ type: "play_stop", play: 3, fade_ms: MAX_FADE_MS });
    expect(ok({ type: "play_stop", play: 3, fade_ms: -5 }).ok).toBe(false);
    expect(ok({ type: "play_stop", play: 3, fade_ms: "x" }).ok).toBe(false);
  });

  it("parses play_duck, play_pause and play_resume", () => {
    expect(ok({ type: "play_duck", play: 3, gain: 0.3, fade_ms: 120 })).toEqual({
      ok: true,
      value: { type: "play_duck", play: 3, gain: 0.3, fade_ms: 120 },
    });
    expect(ok({ type: "play_duck", play: 3, gain: 1 })).toEqual({
      ok: true,
      value: { type: "play_duck", play: 3, gain: 1, fade_ms: 0 },
    });
    expect(ok({ type: "play_duck", play: 3, gain: 1.5 }).ok).toBe(false);
    expect(ok({ type: "play_duck", play: 3, gain: -0.1 }).ok).toBe(false);
    expect(ok({ type: "play_duck", play: 3 }).ok).toBe(false);
    expect(ok({ type: "play_duck", play: 3, gain: 0.5, fade_ms: -1 }).ok).toBe(false);
    expect(ok({ type: "play_pause", play: 3, fade_ms: 80 })).toEqual({
      ok: true,
      value: { type: "play_pause", play: 3, fade_ms: 80 },
    });
    expect(ok({ type: "play_resume", play: 3 })).toEqual({
      ok: true,
      value: { type: "play_resume", play: 3, fade_ms: 0 },
    });
    expect(ok({ type: "play_pause", play: 1.5 }).ok).toBe(false);
    const big = ok({ type: "play_resume", play: 3, fade_ms: 1e9 });
    expect(big.ok && big.value).toEqual({ type: "play_resume", play: 3, fade_ms: MAX_FADE_MS });
  });

  it("reports malformed input", () => {
    expect(parseCoreMessage("not json").ok).toBe(false);
    expect(parseCoreMessage("[]").ok).toBe(false);
    expect(parseCoreMessage("null").ok).toBe(false);
    expect(parseCoreMessage("{}").ok).toBe(false);
    expect(parseCoreMessage('{"type":5}').ok).toBe(false);
  });

  it("flags unknown types as ignorable", () => {
    const r = ok({ type: "future_thing" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.ignorable).toBe(true);
    const bad = ok({ type: "join" });
    expect(!bad.ok && bad.ignorable).toBe(false);
  });
});

describe("encodeNodeMessage", () => {
  it("serialises hello with the documented shape", () => {
    const json = JSON.parse(
      encodeNodeMessage({
        type: "hello",
        version: PROTOCOL_VERSION,
        token: "t",
        node: "voice-node",
        self_account: { platform: "discord", id: "123" },
      }),
    );
    expect(json).toEqual({
      type: "hello",
      version: 1,
      token: "t",
      node: "voice-node",
      self_account: { platform: "discord", id: "123" },
    });
  });
});
