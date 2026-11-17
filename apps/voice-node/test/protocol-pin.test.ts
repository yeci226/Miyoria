// Pins what the node's side of the voice link does with every message, as literal values: what
// `parseCoreMessage` makes of each Core message (and of each edge: bounds just inside and just
// outside, `null`, unknown keys and types), the JSON the node sends, its binary frames and what
// the link does on each close code. Written against the hand parser before the link moved to the
// contract (`@miyoria/contracts/voice-link`); a change to any expectation here is a change in
// behaviour.

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { CoreLink } from "../src/link.js";
import {
  CAPTURE_SAMPLE_RATE,
  CLOSE_BAD_TOKEN,
  CLOSE_REPLACED,
  CLOSE_VERSION_MISMATCH,
  decodeBinaryFrame,
  encodeCaptureFrame,
  encodeNodeMessage,
  encodePlaybackFrame,
  FRAME_CAPTURE,
  FRAME_LEVELS,
  FRAME_PLAYBACK,
  isU32,
  MAX_FADE_MS,
  MAX_SOURCE_LEN,
  NODE_CAPABILITIES,
  type NodeMessage,
  PROTOCOL_VERSION,
  parseCoreMessage,
  U32_MAX,
} from "../src/protocol.js";

const parse = (o: unknown) => parseCoreMessage(JSON.stringify(o));
const accepted = (value: unknown) => ({ ok: true, value });
const refused = (error: string) => ({ ok: false, error, ignorable: false });
const ignored = (error: string) => ({ ok: false, error, ignorable: true });

describe("constants", () => {
  it("are the protocol's numbers", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(NODE_CAPABILITIES).toEqual(["play_duck", "play_pause"]);
    expect(CAPTURE_SAMPLE_RATE).toBe(16_000);
    expect([FRAME_CAPTURE, FRAME_PLAYBACK, FRAME_LEVELS]).toEqual([0x01, 0x02, 0x03]);
    expect([CLOSE_VERSION_MISMATCH, CLOSE_BAD_TOKEN, CLOSE_REPLACED]).toEqual([4400, 4401, 4409]);
    expect(U32_MAX).toBe(4_294_967_295);
    expect(MAX_FADE_MS).toBe(10_000);
    expect(MAX_SOURCE_LEN).toBe(2048);
  });

  it("isU32 takes integers 0..2^32-1", () => {
    expect([0, 1, U32_MAX].map(isU32)).toEqual([true, true, true]);
    expect([-1, U32_MAX + 1, 1.5, "1", null, Number.NaN, Infinity].map(isU32)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("parseCoreMessage: one of every message", () => {
  it.each([
    [{ type: "welcome", session: "01J" }, { type: "welcome", session: "01J" }],
    [{ type: "ping" }, { type: "ping" }],
    [
      { type: "join", guild: "1", channel: "2", user_id: "3" },
      { type: "join", guild: "1", channel: "2", user_id: "3" },
    ],
    [{ type: "leave", guild: "9" }, { type: "leave", guild: "9" }],
    [
      { type: "play_start", play: 7, guild: "1", sample_rate: 24_000, levels: true },
      { type: "play_start", play: 7, guild: "1", sample_rate: 24_000, levels: true },
    ],
    [{ type: "play_end", play: 3 }, { type: "play_end", play: 3 }],
    [
      { type: "play_stop", play: 3, fade_ms: 120 },
      { type: "play_stop", play: 3, fade_ms: 120 },
    ],
    [
      { type: "play_duck", play: 3, gain: 0.3, fade_ms: 120 },
      { type: "play_duck", play: 3, gain: 0.3, fade_ms: 120 },
    ],
    [
      { type: "play_pause", play: 3, fade_ms: 80 },
      { type: "play_pause", play: 3, fade_ms: 80 },
    ],
    [
      { type: "play_resume", play: 3, fade_ms: 80 },
      { type: "play_resume", play: 3, fade_ms: 80 },
    ],
    [
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
    ],
    [{ type: "golive_stop", guild: "1" }, { type: "golive_stop", guild: "1" }],
  ])("%j", (input, value) => {
    expect(parse(input)).toStrictEqual(accepted(value));
  });

  it("takes only the shortest form of each optional field", () => {
    expect(parse({ type: "join", guild: "1", user_id: "3" })).toStrictEqual(
      accepted({ type: "join", guild: "1", user_id: "3" }),
    );
    expect(parse({ type: "play_start", play: 7, guild: "1", sample_rate: 24_000 })).toStrictEqual(
      accepted({ type: "play_start", play: 7, guild: "1", sample_rate: 24_000 }),
    );
    expect(parse({ type: "play_stop", play: 3 })).toStrictEqual(
      accepted({ type: "play_stop", play: 3, fade_ms: 0 }),
    );
    expect(parse({ type: "play_duck", play: 3, gain: 1 })).toStrictEqual(
      accepted({ type: "play_duck", play: 3, gain: 1, fade_ms: 0 }),
    );
    expect(parse({ type: "play_pause", play: 3 })).toStrictEqual(
      accepted({ type: "play_pause", play: 3, fade_ms: 0 }),
    );
    expect(parse({ type: "play_resume", play: 3 })).toStrictEqual(
      accepted({ type: "play_resume", play: 3, fade_ms: 0 }),
    );
    expect(parse({ type: "golive_start", guild: "1", source: "x" })).toStrictEqual(
      accepted({ type: "golive_start", guild: "1", source: "x" }),
    );
  });
});

describe("parseCoreMessage: edges", () => {
  it("drops keys it does not know", () => {
    expect(parse({ type: "leave", guild: "9", extra: 1, nested: { a: 1 } })).toStrictEqual(
      accepted({ type: "leave", guild: "9" }),
    );
    expect(parse({ type: "ping", session: "x" })).toStrictEqual(accepted({ type: "ping" }));
    expect(
      parse({ type: "play_start", play: 1, guild: "1", sample_rate: 8000, future: [1] }),
    ).toStrictEqual(accepted({ type: "play_start", play: 1, guild: "1", sample_rate: 8000 }));
  });

  it("takes null for an optional field as absent", () => {
    expect(parse({ type: "join", guild: "1", channel: null, user_id: "3" })).toStrictEqual(
      accepted({ type: "join", guild: "1", user_id: "3" }),
    );
    expect(parse({ type: "play_stop", play: 3, fade_ms: null })).toStrictEqual(
      accepted({ type: "play_stop", play: 3, fade_ms: 0 }),
    );
    expect(parse({ type: "play_duck", play: 3, gain: 0, fade_ms: null })).toStrictEqual(
      accepted({ type: "play_duck", play: 3, gain: 0, fade_ms: 0 }),
    );
    expect(
      parse({
        type: "golive_start",
        guild: "1",
        source: "x",
        channel: null,
        width: null,
        height: null,
        fps: null,
        bitrate_kbps: null,
        encoder: null,
        audio: null,
        listen: null,
      }),
    ).toStrictEqual(accepted({ type: "golive_start", guild: "1", source: "x" }));
  });

  it("keeps `levels` only when it is true, and never refuses it", () => {
    const base = { type: "play_start", play: 1, guild: "1", sample_rate: 48_000 };
    for (const levels of [false, null, "yes", 1, {}]) {
      expect(parse({ ...base, levels })).toStrictEqual(accepted(base));
    }
    expect(parse({ ...base, levels: true })).toStrictEqual(accepted({ ...base, levels: true }));
  });

  it("join needs a channel or a user, each a non-empty id of at most 64", () => {
    const id64 = "x".repeat(64);
    expect(parse({ type: "join", guild: id64, channel: id64 })).toStrictEqual(
      accepted({ type: "join", guild: id64, channel: id64 }),
    );
    expect(parse({ type: "join", guild: "1" })).toStrictEqual(
      refused("join: need `channel` or `user_id`"),
    );
    expect(parse({ type: "join", guild: "1", channel: null, user_id: null })).toStrictEqual(
      refused("join: need `channel` or `user_id`"),
    );
    expect(parse({ type: "join", guild: `${id64}x`, channel: "2" })).toStrictEqual(
      refused("join: `guild` must be a non-empty string"),
    );
    expect(parse({ type: "join", guild: "", channel: "2" })).toStrictEqual(
      refused("join: `guild` must be a non-empty string"),
    );
    expect(parse({ type: "join", guild: 1, channel: "2" })).toStrictEqual(
      refused("join: `guild` must be a non-empty string"),
    );
    expect(parse({ type: "join", guild: "1", channel: "" })).toStrictEqual(
      refused("join: `channel` must be a string"),
    );
    expect(parse({ type: "join", guild: "1", channel: `${id64}x` })).toStrictEqual(
      refused("join: `channel` must be a string"),
    );
    expect(parse({ type: "join", guild: "1", channel: 2 })).toStrictEqual(
      refused("join: `channel` must be a string"),
    );
    expect(parse({ type: "join", guild: "1", user_id: 3 })).toStrictEqual(
      refused("join: `user_id` must be a string"),
    );
    // The first field that is wrong is the one reported.
    expect(parse({ type: "join", guild: "", channel: 2, user_id: 3 })).toStrictEqual(
      refused("join: `guild` must be a non-empty string"),
    );
    expect(parse({ type: "join", guild: "1", channel: 2, user_id: 3 })).toStrictEqual(
      refused("join: `channel` must be a string"),
    );
  });

  it("welcome needs a non-empty session", () => {
    expect(parse({ type: "welcome", session: "" })).toStrictEqual(
      refused("welcome: `session` must be a string"),
    );
    expect(parse({ type: "welcome" })).toStrictEqual(refused("welcome: `session` must be a string"));
    expect(parse({ type: "welcome", session: "x".repeat(500) })).toStrictEqual(
      accepted({ type: "welcome", session: "x".repeat(500) }),
    );
  });

  it("leave and golive_stop need a guild", () => {
    expect(parse({ type: "leave" })).toStrictEqual(refused("leave: `guild` must be a non-empty string"));
    expect(parse({ type: "golive_stop", guild: "" })).toStrictEqual(
      refused("golive_stop: `guild` must be a non-empty string"),
    );
  });

  it("play ids are u32", () => {
    for (const type of ["play_end", "play_stop", "play_pause", "play_resume"]) {
      expect(parse({ type, play: 0 }).ok).toBe(true);
      expect(parse({ type, play: U32_MAX }).ok).toBe(true);
      for (const play of [-1, U32_MAX + 1, 1.5, "1", null]) {
        expect(parse({ type, play })).toStrictEqual(refused(`${type}: \`play\` must be a u32`));
      }
      expect(parse({ type })).toStrictEqual(refused(`${type}: \`play\` must be a u32`));
    }
    expect(parse({ type: "play_duck", play: -1, gain: 1 })).toStrictEqual(
      refused("play_duck: `play` must be a u32"),
    );
    expect(parse({ type: "play_start", play: U32_MAX + 1, guild: "1", sample_rate: 24_000 })).toStrictEqual(
      refused("play_start: `play` must be a u32"),
    );
  });

  it("play_start: sample_rate is an integer in 8000..192000; play, guild, rate checked in that order", () => {
    const at = (sample_rate: unknown) => parse({ type: "play_start", play: 1, guild: "1", sample_rate });
    const bad = refused("play_start: `sample_rate` must be an integer in 8000..192000");
    expect(at(8000)).toStrictEqual(accepted({ type: "play_start", play: 1, guild: "1", sample_rate: 8000 }));
    expect(at(192_000)).toStrictEqual(
      accepted({ type: "play_start", play: 1, guild: "1", sample_rate: 192_000 }),
    );
    for (const rate of [7999, 192_001, 24_000.5, "24000", null, 0]) expect(at(rate)).toStrictEqual(bad);
    expect(parse({ type: "play_start", play: 1, guild: "1" })).toStrictEqual(bad);
    expect(parse({ type: "play_start", play: 1, sample_rate: 24_000 })).toStrictEqual(
      refused("play_start: `guild` must be a non-empty string"),
    );
    expect(parse({ type: "play_start", play: -1, guild: "", sample_rate: 0 })).toStrictEqual(
      refused("play_start: `play` must be a u32"),
    );
    expect(parse({ type: "play_start", play: 1, guild: "", sample_rate: 0 })).toStrictEqual(
      refused("play_start: `guild` must be a non-empty string"),
    );
  });

  it("fade_ms is a non-negative number, rounded and capped at 10 s", () => {
    for (const type of ["play_stop", "play_pause", "play_resume"]) {
      const at = (fade_ms: unknown) => parse({ type, play: 3, fade_ms });
      expect(at(0)).toStrictEqual(accepted({ type, play: 3, fade_ms: 0 }));
      expect(at(12.4)).toStrictEqual(accepted({ type, play: 3, fade_ms: 12 }));
      expect(at(12.5)).toStrictEqual(accepted({ type, play: 3, fade_ms: 13 }));
      expect(at(10_000)).toStrictEqual(accepted({ type, play: 3, fade_ms: 10_000 }));
      expect(at(10_001)).toStrictEqual(accepted({ type, play: 3, fade_ms: 10_000 }));
      expect(at(1e9)).toStrictEqual(accepted({ type, play: 3, fade_ms: 10_000 }));
      for (const fade of [-0.0001, -5, "x", true]) {
        expect(at(fade)).toStrictEqual(refused(`${type}: \`fade_ms\` must be a non-negative number`));
      }
      // JSON can carry a number too big for a double: it parses as Infinity.
      expect(parseCoreMessage(`{"type":"${type}","play":3,"fade_ms":1e999}`)).toStrictEqual(
        refused(`${type}: \`fade_ms\` must be a non-negative number`),
      );
    }
    expect(parse({ type: "play_duck", play: 3, gain: 1, fade_ms: -1 })).toStrictEqual(
      refused("play_duck: `fade_ms` must be a non-negative number"),
    );
    expect(parse({ type: "play_duck", play: 3, gain: 1, fade_ms: 20_000.7 })).toStrictEqual(
      accepted({ type: "play_duck", play: 3, gain: 1, fade_ms: 10_000 }),
    );
  });

  it("play_duck: gain is a number in 0..1", () => {
    const at = (gain: unknown) => parse({ type: "play_duck", play: 3, gain });
    const bad = refused("play_duck: `gain` must be a number in 0..1");
    expect(at(0)).toStrictEqual(accepted({ type: "play_duck", play: 3, gain: 0, fade_ms: 0 }));
    expect(at(1)).toStrictEqual(accepted({ type: "play_duck", play: 3, gain: 1, fade_ms: 0 }));
    for (const gain of [-0.0001, 1.0001, "0.5", null]) expect(at(gain)).toStrictEqual(bad);
    expect(parse({ type: "play_duck", play: 3 })).toStrictEqual(bad);
    expect(parseCoreMessage('{"type":"play_duck","play":3,"gain":1e999}')).toStrictEqual(bad);
    expect(parse({ type: "play_duck", play: 3, gain: 2, fade_ms: -1 })).toStrictEqual(bad);
  });

  it("golive_start: source is a non-blank string of at most 2048", () => {
    const at = (source: unknown) => parse({ type: "golive_start", guild: "1", source });
    const bad = refused("golive_start: `source` must be a non-empty string (max 2048 chars)");
    const long = `rtmp://${"a".repeat(2048 - 7)}`;
    expect(at(long)).toStrictEqual(accepted({ type: "golive_start", guild: "1", source: long }));
    expect(at(" x ")).toStrictEqual(accepted({ type: "golive_start", guild: "1", source: " x " }));
    for (const source of [`${long}a`, "", "   ", "\t\n", "　", "﻿", "  ", 5, null]) {
      expect(at(source)).toStrictEqual(bad);
    }
    expect(parse({ type: "golive_start", guild: "1" })).toStrictEqual(bad);
  });

  it("golive_start: the other fields, in the order they are checked", () => {
    const base = { type: "golive_start", guild: "1", source: "x" };
    for (const key of ["width", "height", "fps", "bitrate_kbps"]) {
      const bad = refused(`golive_start: \`${key}\` must be a positive integer`);
      expect(parse({ ...base, [key]: 1 })).toStrictEqual(accepted({ ...base, [key]: 1 }));
      expect(parse({ ...base, [key]: U32_MAX })).toStrictEqual(accepted({ ...base, [key]: U32_MAX }));
      for (const v of [0, -1, 1.5, U32_MAX + 1, "720"]) expect(parse({ ...base, [key]: v })).toStrictEqual(bad);
    }
    for (const encoder of ["auto", "nvenc", "software"]) {
      expect(parse({ ...base, encoder })).toStrictEqual(accepted({ ...base, encoder }));
    }
    for (const encoder of ["x264", "", "AUTO", 1]) {
      expect(parse({ ...base, encoder })).toStrictEqual(
        refused("golive_start: `encoder` must be auto, nvenc or software"),
      );
    }
    for (const key of ["audio", "listen"]) {
      expect(parse({ ...base, [key]: true })).toStrictEqual(accepted({ ...base, [key]: true }));
      expect(parse({ ...base, [key]: false })).toStrictEqual(accepted({ ...base, [key]: false }));
      for (const v of ["true", 1, 0]) {
        expect(parse({ ...base, [key]: v })).toStrictEqual(refused(`golive_start: \`${key}\` must be a boolean`));
      }
    }
    expect(parse({ ...base, channel: "" })).toStrictEqual(refused("golive_start: `channel` must be a string"));
    expect(parse({ type: "golive_start", source: "x" })).toStrictEqual(
      refused("golive_start: `guild` must be a non-empty string"),
    );
    // guild, source, channel, width, height, fps, bitrate_kbps, encoder, audio, listen
    expect(parse({ type: "golive_start", guild: "", source: "" })).toStrictEqual(
      refused("golive_start: `guild` must be a non-empty string"),
    );
    expect(parse({ ...base, source: "", channel: "" })).toStrictEqual(
      refused("golive_start: `source` must be a non-empty string (max 2048 chars)"),
    );
    expect(parse({ ...base, channel: "", width: 0 })).toStrictEqual(
      refused("golive_start: `channel` must be a string"),
    );
    expect(parse({ ...base, width: 0, height: 0 })).toStrictEqual(
      refused("golive_start: `width` must be a positive integer"),
    );
    expect(parse({ ...base, fps: 0, bitrate_kbps: 0 })).toStrictEqual(
      refused("golive_start: `fps` must be a positive integer"),
    );
    expect(parse({ ...base, bitrate_kbps: 0, encoder: "x" })).toStrictEqual(
      refused("golive_start: `bitrate_kbps` must be a positive integer"),
    );
    expect(parse({ ...base, encoder: "x", audio: 1 })).toStrictEqual(
      refused("golive_start: `encoder` must be auto, nvenc or software"),
    );
    expect(parse({ ...base, audio: 1, listen: 1 })).toStrictEqual(
      refused("golive_start: `audio` must be a boolean"),
    );
  });

  it("unknown types are ignorable, a pong from Core among them", () => {
    expect(parse({ type: "future_thing" })).toStrictEqual(ignored("unknown message type `future_thing`"));
    expect(parse({ type: "pong" })).toStrictEqual(ignored("unknown message type `pong`"));
    expect(parse({ type: "hello" })).toStrictEqual(ignored("unknown message type `hello`"));
    expect(parse({ type: "" })).toStrictEqual(ignored("unknown message type ``"));
    expect(parse({ type: "PING" })).toStrictEqual(ignored("unknown message type `PING`"));
  });

  it("reports what is not a message at all", () => {
    expect(parseCoreMessage("not json")).toStrictEqual(refused("invalid JSON"));
    expect(parseCoreMessage("")).toStrictEqual(refused("invalid JSON"));
    expect(parseCoreMessage("[]")).toStrictEqual(refused("message is not a JSON object"));
    expect(parseCoreMessage("null")).toStrictEqual(refused("message is not a JSON object"));
    expect(parseCoreMessage('"ping"')).toStrictEqual(refused("message is not a JSON object"));
    expect(parseCoreMessage("{}")).toStrictEqual(refused("missing string field `type`"));
    expect(parseCoreMessage('{"type":5}')).toStrictEqual(refused("missing string field `type`"));
    expect(parseCoreMessage('{"type":null}')).toStrictEqual(refused("missing string field `type`"));
  });
});

describe("encodeNodeMessage: one of every message the node sends", () => {
  it.each<[NodeMessage, string]>([
    [
      {
        type: "hello",
        version: 1,
        token: "t",
        node: "voice-node",
        self_account: { platform: "discord", id: "42" },
        capabilities: ["play_duck", "play_pause"],
      },
      '{"type":"hello","version":1,"token":"t","node":"voice-node","self_account":{"platform":"discord","id":"42"},"capabilities":["play_duck","play_pause"]}',
    ],
    [{ type: "joined", guild: "1", channel: "2" }, '{"type":"joined","guild":"1","channel":"2"}'],
    [{ type: "left", guild: "1", reason: "leave" }, '{"type":"left","guild":"1","reason":"leave"}'],
    [{ type: "left", guild: "1" }, '{"type":"left","guild":"1"}'],
    [
      {
        type: "voice_state",
        guild: "1",
        channel: "2",
        participants: [{ user_id: "3", display_name: "A", is_self: false, muted: true, deafened: false }],
      },
      '{"type":"voice_state","guild":"1","channel":"2","participants":[{"user_id":"3","display_name":"A","is_self":false,"muted":true,"deafened":false}]}',
    ],
    [
      { type: "speaking", guild: "1", user_id: "3", speaking: true },
      '{"type":"speaking","guild":"1","user_id":"3","speaking":true}',
    ],
    [
      {
        type: "stream_open",
        stream: 5,
        guild: "1",
        channel: "2",
        user_id: "3",
        display_name: "A",
        sample_rate: 16_000,
      },
      '{"type":"stream_open","stream":5,"guild":"1","channel":"2","user_id":"3","display_name":"A","sample_rate":16000}',
    ],
    [{ type: "stream_close", stream: 5 }, '{"type":"stream_close","stream":5}'],
    [{ type: "playback", play: 7, state: "started" }, '{"type":"playback","play":7,"state":"started"}'],
    [
      { type: "playback", play: 7, state: "failed", error: "x" },
      '{"type":"playback","play":7,"state":"failed","error":"x"}',
    ],
    [
      { type: "golive", guild: "1", state: "stopped", reason: "source ended" },
      '{"type":"golive","guild":"1","state":"stopped","reason":"source ended"}',
    ],
    [
      { type: "golive", guild: "1", state: "failed", error: "e" },
      '{"type":"golive","guild":"1","state":"failed","error":"e"}',
    ],
    [{ type: "error", message: "m" }, '{"type":"error","message":"m"}'],
    [{ type: "pong" }, '{"type":"pong"}'],
  ])("%j", (msg, json) => {
    expect(encodeNodeMessage(msg)).toBe(json);
  });
});

describe("binary frames", () => {
  it("encodes capture and playback frames byte for byte", () => {
    expect([...encodeCaptureFrame(U32_MAX, Buffer.from([1, 2]))]).toEqual([0x01, 0xff, 0xff, 0xff, 0xff, 1, 2]);
    expect([...encodePlaybackFrame(0, Buffer.alloc(0))]).toEqual([0x02, 0, 0, 0, 0]);
    expect([...encodePlaybackFrame(258, Buffer.from([9]))]).toEqual([0x02, 2, 1, 0, 0, 9]);
  });

  it("refuses ids outside u32 when encoding", () => {
    expect(() => encodeCaptureFrame(-1, Buffer.alloc(0))).toThrow("stream id out of u32 range: -1");
    expect(() => encodePlaybackFrame(U32_MAX + 1, Buffer.alloc(0))).toThrow(
      "play id out of u32 range: 4294967296",
    );
  });

  it("decodes each tag, and reports short and unknown frames", () => {
    for (const kind of [0x01, 0x02, 0x03]) {
      const r = decodeBinaryFrame(Buffer.from([kind, 1, 0, 0, 0, 7, 8, 9]));
      expect(r.ok && { kind: r.value.kind, id: r.value.id, pcm: [...r.value.pcm] }).toEqual({
        kind,
        id: 1,
        pcm: [7, 8, 9],
      });
    }
    expect(decodeBinaryFrame(Buffer.from([0x02, 0, 0, 0]))).toStrictEqual(
      refused("binary frame shorter than its 5-byte header"),
    );
    expect(decodeBinaryFrame(new Uint8Array(0))).toStrictEqual(
      refused("binary frame shorter than its 5-byte header"),
    );
    expect(decodeBinaryFrame(Buffer.from([0x00, 0, 0, 0, 0]))).toStrictEqual(
      ignored("unknown binary frame kind 0x00"),
    );
    expect(decodeBinaryFrame(Buffer.from([0x04, 0, 0, 0, 0]))).toStrictEqual(
      ignored("unknown binary frame kind 0x04"),
    );
    expect(decodeBinaryFrame(Buffer.from([0xff, 0, 0, 0, 0]))).toStrictEqual(
      ignored("unknown binary frame kind 0xff"),
    );
  });

  it("reads a plain Uint8Array (not a Buffer) at its offset", () => {
    const backing = new Uint8Array([0xee, 0x03, 4, 0, 0, 0, 5, 6]);
    const r = decodeBinaryFrame(backing.subarray(1));
    expect(r.ok && { kind: r.value.kind, id: r.value.id, pcm: [...r.value.pcm] }).toEqual({
      kind: 0x03,
      id: 4,
      pcm: [5, 6],
    });
  });
});

describe("close codes", () => {
  let server: WebSocketServer | undefined;
  let link: CoreLink | undefined;

  afterEach(async () => {
    await link?.stop();
    link = undefined;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function serve(onConn: (ws: WebSocket, n: number) => void): Promise<string> {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server?.once("listening", () => r()));
    let n = 0;
    server.on("connection", (ws) => {
      ws.once("message", (_data: RawData) => onConn(ws, ++n));
    });
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice-link`;
  }

  // 4400, 4401 and 4409 are fatal (link.test.ts). Every other code, 4408 and 1001 from Core
  // among them, is a dropped link: the node connects again.
  it.each([4408, 1001, 1000, 4000, 4402])("reconnects after close %i", async (code) => {
    const url = await serve((ws, n) => {
      ws.send(JSON.stringify({ type: "welcome", session: `S${n}` }));
      if (n === 1) setTimeout(() => ws.close(code, "x"), 20);
    });
    link = new CoreLink({ url, token: "t", selfAccountId: "1", backoffMinMs: 10, backoffMaxMs: 20 });
    let fatal = false;
    link.on("fatal", () => {
      fatal = true;
    });
    const downs: number[] = [];
    link.on("down", (info) => downs.push(info.code));
    const sessions: string[] = [];
    const twice = new Promise<void>((resolve) => {
      link?.on("ready", (s) => {
        sessions.push(s);
        if (sessions.length === 2) resolve();
      });
    });
    link.start();
    await twice;
    expect(sessions).toEqual(["S1", "S2"]);
    expect(downs).toEqual([code]);
    expect(fatal).toBe(false);
  });
});
