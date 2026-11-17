// Pins what Core's side of the voice link does with every message, as literal values: what
// `NodeMessageSchema` makes of each node message (and of each edge: an older node's hello, bounds,
// unknown keys and types), the JSON Core sends for each of its messages, the binary frames, the
// close codes, and what a connection does with a bad hello or a message it does not know. Written
// against the hand-written protocol before the link moved to the contract
// (`@miyoria/contracts/voice-link`); a change to any expectation here is a change in behaviour.

import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE,
  type CoreMessage,
  coreMessageJson,
  decodeAudio,
  encodeAudio,
  NodeMessageSchema,
  TAG_CAPTURE,
  TAG_LEVELS,
  TAG_PLAYBACK,
  VERSION,
} from "../src/index.js";
import { Harness, SELF_ID, TOKEN } from "./harness.js";

const U32_MAX = 0xffff_ffff;

function parsed(value: unknown): unknown {
  const r = NodeMessageSchema.safeParse(value);
  return r.success ? r.data : "refused";
}

describe("constants", () => {
  it("are the protocol's numbers", () => {
    expect(VERSION).toBe(1);
    expect(CLOSE).toStrictEqual({
      BAD_HELLO: 4400,
      UNAUTHORIZED: 4401,
      REPLACED: 4409,
      TIMEOUT: 4408,
      GOING_AWAY: 1001,
    });
    expect([TAG_CAPTURE, TAG_PLAYBACK, TAG_LEVELS]).toEqual([0x01, 0x02, 0x03]);
  });
});

describe("NodeMessageSchema: one of every message", () => {
  it.each([
    [
      {
        type: "hello",
        version: 1,
        token: "t",
        node: "voice-node",
        self_account: { platform: "discord", id: "42" },
        capabilities: ["play_duck", "play_pause"],
      },
      {
        type: "hello",
        version: 1,
        token: "t",
        node: "voice-node",
        self_account: { platform: "discord", id: "42" },
        capabilities: ["play_duck", "play_pause"],
      },
    ],
    [
      { type: "joined", guild: "1", channel: "2" },
      { type: "joined", guild: "1", channel: "2" },
    ],
    [
      { type: "left", guild: "1", reason: "leave" },
      { type: "left", guild: "1", reason: "leave" },
    ],
    [
      {
        type: "voice_state",
        guild: "1",
        channel: "2",
        participants: [
          { user_id: "3", display_name: "A", is_self: true, muted: true, deafened: true },
        ],
      },
      {
        type: "voice_state",
        guild: "1",
        channel: "2",
        participants: [
          { user_id: "3", display_name: "A", is_self: true, muted: true, deafened: true },
        ],
      },
    ],
    [
      { type: "speaking", guild: "1", user_id: "3", speaking: false },
      { type: "speaking", guild: "1", user_id: "3", speaking: false },
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
      {
        type: "stream_open",
        stream: 5,
        guild: "1",
        channel: "2",
        user_id: "3",
        display_name: "A",
        sample_rate: 16_000,
      },
    ],
    [
      { type: "stream_close", stream: 5 },
      { type: "stream_close", stream: 5 },
    ],
    [
      { type: "playback", play: 7, state: "failed", error: "x" },
      { type: "playback", play: 7, state: "failed", error: "x" },
    ],
    [
      { type: "golive", guild: "1", state: "stopped", error: "e", reason: "r" },
      { type: "golive", guild: "1", state: "stopped", error: "e", reason: "r" },
    ],
    [
      { type: "error", message: "m" },
      { type: "error", message: "m" },
    ],
    [{ type: "ping" }, { type: "ping" }],
    [{ type: "pong" }, { type: "pong" }],
  ])("%j", (input, output) => {
    expect(parsed(input)).toStrictEqual(output);
  });

  it("fills what a node may leave out", () => {
    // An older node: no `capabilities` (added later), no `node`.
    expect(
      parsed({
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
    expect(parsed({ type: "left", guild: "1" })).toStrictEqual({
      type: "left",
      guild: "1",
      reason: null,
    });
    expect(parsed({ type: "left", guild: "1", reason: null })).toStrictEqual({
      type: "left",
      guild: "1",
      reason: null,
    });
    expect(
      parsed({ type: "voice_state", guild: "1", channel: "2", participants: [{ user_id: "3" }] }),
    ).toStrictEqual({
      type: "voice_state",
      guild: "1",
      channel: "2",
      participants: [
        { user_id: "3", display_name: "", is_self: false, muted: false, deafened: false },
      ],
    });
    expect(
      parsed({
        type: "stream_open",
        stream: 5,
        guild: "1",
        channel: "2",
        user_id: "3",
        sample_rate: 16_000,
      }),
    ).toStrictEqual({
      type: "stream_open",
      stream: 5,
      guild: "1",
      channel: "2",
      user_id: "3",
      display_name: "",
      sample_rate: 16_000,
    });
    expect(parsed({ type: "playback", play: 7, state: "started" })).toStrictEqual({
      type: "playback",
      play: 7,
      state: "started",
      error: null,
    });
    expect(parsed({ type: "golive", guild: "1", state: "live" })).toStrictEqual({
      type: "golive",
      guild: "1",
      state: "live",
      error: null,
      reason: null,
    });
  });
});

describe("NodeMessageSchema: edges", () => {
  it("drops keys it does not know", () => {
    expect(parsed({ type: "joined", guild: "1", channel: "2", extra: 1 })).toStrictEqual({
      type: "joined",
      guild: "1",
      channel: "2",
    });
    expect(
      parsed({
        type: "hello",
        version: 1,
        token: "t",
        self_account: { platform: "discord", id: "42", extra: true },
        capabilities: ["play_duck", "future"],
        future: { a: 1 },
      }),
    ).toStrictEqual({
      type: "hello",
      version: 1,
      token: "t",
      node: "",
      self_account: { platform: "discord", id: "42" },
      capabilities: ["play_duck", "future"],
    });
    expect(parsed({ type: "pong", extra: 1 })).toStrictEqual({ type: "pong" });
  });

  it("refuses unknown types and missing or wrong types", () => {
    expect(parsed({ type: "future_thing" })).toBe("refused");
    expect(parsed({ type: "welcome", session: "s" })).toBe("refused");
    expect(parsed({})).toBe("refused");
    expect(parsed(null)).toBe("refused");
    expect(parsed([])).toBe("refused");
    expect(parsed({ type: 5 })).toBe("refused");
  });

  it("takes any platform string and any version (the version is checked after parsing)", () => {
    const hello = (o: Record<string, unknown>) =>
      parsed({
        type: "hello",
        version: 1,
        token: "t",
        self_account: { platform: "discord", id: "42" },
        ...o,
      });
    expect(hello({ self_account: { platform: "twitch", id: "1" } })).toMatchObject({
      self_account: { platform: "twitch", id: "1" },
    });
    expect(hello({ self_account: { platform: "", id: "" } })).toMatchObject({
      self_account: { platform: "", id: "" },
    });
    expect(hello({ version: 0 })).toMatchObject({ version: 0 });
    expect(hello({ version: 2 })).toMatchObject({ version: 2 });
    expect(hello({ version: U32_MAX })).toMatchObject({ version: U32_MAX });
    for (const version of [-1, U32_MAX + 1, 1.5, "1", null])
      expect(hello({ version })).toBe("refused");
    expect(hello({ token: 1 })).toBe("refused");
    expect(hello({ self_account: { platform: "discord" } })).toBe("refused");
    expect(hello({ capabilities: "play_duck" })).toBe("refused");
    expect(hello({ capabilities: [1] })).toBe("refused");
  });

  it("ids and rates are u32 and nothing more", () => {
    expect(parsed({ type: "stream_close", stream: 0 })).toStrictEqual({
      type: "stream_close",
      stream: 0,
    });
    expect(parsed({ type: "stream_close", stream: U32_MAX })).toStrictEqual({
      type: "stream_close",
      stream: U32_MAX,
    });
    for (const stream of [-1, U32_MAX + 1, 1.5, "5"]) {
      expect(parsed({ type: "stream_close", stream })).toBe("refused");
    }
    const open = (sample_rate: unknown) =>
      parsed({
        type: "stream_open",
        stream: 1,
        guild: "1",
        channel: "2",
        user_id: "3",
        sample_rate,
      });
    expect(open(0)).toMatchObject({ sample_rate: 0 });
    expect(open(U32_MAX)).toMatchObject({ sample_rate: U32_MAX });
    expect(open(U32_MAX + 1)).toBe("refused");
    expect(open(16_000.5)).toBe("refused");
    expect(parsed({ type: "playback", play: U32_MAX, state: "finished" })).toMatchObject({
      play: U32_MAX,
    });
    expect(parsed({ type: "playback", play: U32_MAX + 1, state: "finished" })).toBe("refused");
    // Strings are not checked for length or emptiness.
    expect(parsed({ type: "joined", guild: "", channel: "x".repeat(1000) })).toStrictEqual({
      type: "joined",
      guild: "",
      channel: "x".repeat(1000),
    });
  });

  it("states are the four of each enum", () => {
    for (const state of ["started", "finished", "interrupted", "failed"]) {
      expect(parsed({ type: "playback", play: 1, state })).toMatchObject({ state });
    }
    expect(parsed({ type: "playback", play: 1, state: "live" })).toBe("refused");
    for (const state of ["starting", "live", "stopped", "failed"]) {
      expect(parsed({ type: "golive", guild: "1", state })).toMatchObject({ state });
    }
    expect(parsed({ type: "golive", guild: "1", state: "finished" })).toBe("refused");
  });

  it("optional strings take null and refuse other types", () => {
    expect(parsed({ type: "playback", play: 1, state: "failed", error: null })).toMatchObject({
      error: null,
    });
    expect(parsed({ type: "playback", play: 1, state: "failed", error: 5 })).toBe("refused");
    expect(parsed({ type: "golive", guild: "1", state: "failed", reason: false })).toBe("refused");
    expect(parsed({ type: "left", guild: "1", reason: 1 })).toBe("refused");
    expect(parsed({ type: "speaking", guild: "1", user_id: "3", speaking: "yes" })).toBe("refused");
  });
});

describe("coreMessageJson: one of every message Core sends", () => {
  it.each<[CoreMessage, string]>([
    [{ type: "welcome", session: "01J" }, '{"type":"welcome","session":"01J"}'],
    [{ type: "join", guild: "1", channel: "2" }, '{"type":"join","guild":"1","channel":"2"}'],
    [{ type: "join", guild: "1", user_id: "3" }, '{"type":"join","guild":"1","user_id":"3"}'],
    [{ type: "leave", guild: "1" }, '{"type":"leave","guild":"1"}'],
    [
      { type: "play_start", play: 7, guild: "1", sample_rate: 24_000 },
      '{"type":"play_start","play":7,"guild":"1","sample_rate":24000}',
    ],
    [
      { type: "play_start", play: 7, guild: "1", sample_rate: 48_000, levels: true },
      '{"type":"play_start","play":7,"guild":"1","sample_rate":48000,"levels":true}',
    ],
    [{ type: "play_end", play: 7 }, '{"type":"play_end","play":7}'],
    [{ type: "play_stop", play: 7, fade_ms: 0 }, '{"type":"play_stop","play":7,"fade_ms":0}'],
    [
      { type: "play_duck", play: 7, gain: 0.25, fade_ms: 150 },
      '{"type":"play_duck","play":7,"gain":0.25,"fade_ms":150}',
    ],
    [{ type: "play_pause", play: 7, fade_ms: 80 }, '{"type":"play_pause","play":7,"fade_ms":80}'],
    [{ type: "play_resume", play: 7, fade_ms: 80 }, '{"type":"play_resume","play":7,"fade_ms":80}'],
    [
      {
        type: "golive_start",
        guild: "1",
        channel: "2",
        source: "rtmp://x",
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate_kbps: 6000,
        encoder: "auto",
        audio: false,
        listen: true,
      },
      '{"type":"golive_start","guild":"1","channel":"2","source":"rtmp://x","width":1920,"height":1080,"fps":60,"bitrate_kbps":6000,"encoder":"auto","audio":false,"listen":true}',
    ],
    [
      {
        type: "golive_start",
        guild: "1",
        channel: undefined,
        source: "rtmp://x",
        width: undefined,
        height: undefined,
        fps: undefined,
        bitrate_kbps: undefined,
        encoder: undefined,
        audio: undefined,
        listen: undefined,
      },
      '{"type":"golive_start","guild":"1","source":"rtmp://x"}',
    ],
    [{ type: "golive_stop", guild: "1" }, '{"type":"golive_stop","guild":"1"}'],
    [{ type: "ping" }, '{"type":"ping"}'],
    [{ type: "pong" }, '{"type":"pong"}'],
  ])("%j", (msg, json) => {
    expect(coreMessageJson(msg)).toBe(json);
  });
});

describe("binary frames", () => {
  it("encodes byte for byte, little endian", () => {
    expect([...encodeAudio(TAG_PLAYBACK, 258, Int16Array.of(1, -1))]).toEqual([
      0x02, 2, 1, 0, 0, 1, 0, 0xff, 0xff,
    ]);
    expect([...encodeAudio(TAG_LEVELS, U32_MAX, new Int16Array(0))]).toEqual([
      0x03, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("decodes any tag, ignores a trailing odd byte, refuses a short frame", () => {
    const d = decodeAudio(Uint8Array.of(0x7f, 1, 0, 0, 0, 1, 0, 0xff, 0xff, 9));
    expect(d && { tag: d.tag, id: d.id, samples: [...d.samples] }).toEqual({
      tag: 0x7f,
      id: 1,
      samples: [1, -1],
    });
    const empty = decodeAudio(Uint8Array.of(0x01, 0, 0, 0, 0));
    expect(empty && { tag: empty.tag, id: empty.id, samples: [...empty.samples] }).toEqual({
      tag: 0x01,
      id: 0,
      samples: [],
    });
    expect(decodeAudio(Uint8Array.of(0x01, 0, 0, 0))).toBeNull();
    const backing = Uint8Array.of(0xee, 0x01, 2, 0, 0, 0, 3, 0);
    const offset = decodeAudio(backing.subarray(1));
    expect(offset && { tag: offset.tag, id: offset.id, samples: [...offset.samples] }).toEqual({
      tag: 0x01,
      id: 2,
      samples: [3],
    });
  });
});

describe("a connection", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  const hello = (o: Record<string, unknown> = {}) => ({
    type: "hello",
    version: 1,
    token: TOKEN,
    self_account: { platform: "discord", id: SELF_ID },
    ...o,
  });

  it("welcomes an older node's hello (no node name, no capabilities) and one with unknown keys", async () => {
    harness = await Harness.start({});
    for (const msg of [hello(), hello({ node: "n", capabilities: ["future"], extra: { a: 1 } })]) {
      const node = await harness.connect();
      node.sendJson(msg as never);
      const welcome = await node.recvJson();
      expect(welcome.type).toBe("welcome");
      expect(Object.keys(welcome)).toEqual(["type", "session"]);
      node.close();
    }
  });

  it.each([
    ["not JSON", "hello", 4400],
    ["another type", { type: "joined", guild: "g", channel: "c" }, 4400],
    [
      "a wrong token, before anything else is checked",
      hello({ token: "nope", version: "x" }),
      4401,
    ],
    ["a token that is not a string", hello({ token: 5 }), 4401],
    ["a malformed hello", hello({ self_account: { platform: "discord" } }), 4400],
    ["another version", hello({ version: 2 }), 4400],
    ["an empty platform", hello({ self_account: { platform: "", id: SELF_ID } }), 4400],
    ["an empty id", hello({ self_account: { platform: "discord", id: "" } }), 4400],
  ])("closes on %s with %i", async (_what, msg, code) => {
    harness = await Harness.start({});
    const node = await harness.connect();
    if (typeof msg === "string") node.ws.send(msg);
    else node.sendJson(msg as never);
    expect(await node.expectClose()).toBe(code);
  });

  it("closes on a binary hello with 4400", async () => {
    harness = await Harness.start({});
    const node = await harness.connect();
    node.ws.send(Buffer.from([1, 0, 0, 0, 0]), { binary: true });
    expect(await node.expectClose()).toBe(4400);
  });

  it("drops what it does not understand and stays open", async () => {
    harness = await Harness.start({});
    const node = await harness.node(SELF_ID);
    node.ws.send("not json");
    node.sendJson({ type: "future_thing", x: 1 });
    node.sendJson({ type: "joined", guild: "g" }); // malformed
    node.sendJson(hello() as never); // a second hello
    node.ws.send(Buffer.from([0x7f, 0, 0, 0, 0, 1, 2]), { binary: true }); // unknown tag
    node.ws.send(Buffer.from([0x01, 0]), { binary: true }); // short frame
    node.sendJson({ type: "pong" });
    node.sendJson({ type: "ping" });
    expect(await node.recvJson()).toEqual({ type: "pong" });
    expect(harness.link().isConnected()).toBe(true);
  });
});
