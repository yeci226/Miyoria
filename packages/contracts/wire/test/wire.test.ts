// The basic shapes: what a producer of today and one that predates the later fields both send.

import { describe, expect, it } from "vitest";
import {
  ContextKeySchema,
  type IncomingMessage,
  IncomingMessageSchema,
  JsonValueSchema,
  PlaybackStateSchema,
  type VoiceUtterance,
  VoiceUtteranceSchema,
} from "../src/index.js";

const context = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const author = {
  account: { platform: "discord", id: "u1" },
  display_name: "Owen",
  is_bot: false,
};

describe("IncomingMessage", () => {
  const early = {
    id: { context, id: "m1" },
    author,
    text: "嗨",
    mentions_self: true,
    reply_to_self: false,
    attachments: [],
    ts: "2026-11-03T06:00:00.000Z",
  };

  it("accepts a message from a producer that predates the later fields, unchanged", () => {
    expect(IncomingMessageSchema.parse(early)).toEqual(early);
  });

  it("accepts every field of today, unchanged", () => {
    const full: IncomingMessage = {
      ...early,
      attachments: [
        { url: "https://x/a.png", filename: "a.png", content_type: "image/png", id: "9", size: 12 },
        { url: "https://x/b.bin", filename: "b.bin", content_type: null, description: null },
      ],
      reply_to: { context, id: "m0" },
      referenced: { author: null, author_name: "某人", text: "之前那句" },
      stickers: [{ id: "s1", name: "wave" }],
      embeds: [{ title: "t", description: null, url: null }],
      forwarded: [{ text: "轉", attachments: [], stickers: [], embeds: [] }],
      mentions_others: [
        { account: { platform: "discord", id: "u2" }, display_name: "B", is_bot: true },
      ],
      opens_with_other_mention: false,
      turn_complete: true,
      card: false,
    };
    expect(IncomingMessageSchema.parse(full)).toEqual(full);
  });

  it("refuses a message without its author", () => {
    const { author: _author, ...rest } = early;
    expect(IncomingMessageSchema.safeParse(rest).success).toBe(false);
  });
});

describe("ContextKey", () => {
  it("has a null scope for a DM, and the key is always there", () => {
    const dm = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
    expect(ContextKeySchema.parse(dm)).toEqual(dm);
    expect(
      ContextKeySchema.safeParse({ platform: "discord", channel: "d1", kind: "dm" }).success,
    ).toBe(false);
    expect(ContextKeySchema.safeParse({ ...dm, kind: "group" }).success).toBe(false);
  });
});

describe("VoiceUtterance", () => {
  it("carries how the turn ended only when a model judged it", () => {
    const utterance: VoiceUtterance = {
      id: "u-1",
      context: { ...context, kind: "voice" },
      speaker: author,
      text: "你好",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: "2026-11-03T06:00:00.000Z",
      ended_at: "2026-11-03T06:00:01.200Z",
      asr_ms: 180,
    };
    expect(VoiceUtteranceSchema.parse(utterance)).toEqual(utterance);
    const judged = { ...utterance, turn: { ended_by: "turn", probability: 0.93 } };
    expect(VoiceUtteranceSchema.parse(judged)).toEqual(judged);
  });
});

describe("small shapes", () => {
  it("knows the four playback states", () => {
    expect(PlaybackStateSchema.options).toEqual(["started", "finished", "interrupted", "failed"]);
  });

  it("takes any JSON value and nothing else", () => {
    expect(JsonValueSchema.parse({ a: [1, "x", null, { b: true }] })).toEqual({
      a: [1, "x", null, { b: true }],
    });
    expect(JsonValueSchema.safeParse({ a: undefined }).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 1).success).toBe(false);
  });
});
