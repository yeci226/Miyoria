// The chat line types: their names are today's bus topics, their payloads the bus events' data,
// kept 365 days with the scope left to the session.

import { describe, expect, it } from "vitest";
import {
  CHAT_EVENT_TYPES,
  CHAT_EVENTS,
  EventRegistry,
  PlatformMessageCreated,
  readEventData,
  VoicePlaybackEvent,
  VoiceUtteranceEvent,
} from "../src/index.js";

const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const voice = { ...ctx, kind: "voice" } as const;
const owen = { account: { platform: "discord", id: "100" }, display_name: "Owen", is_bot: false };

describe("chat line types", () => {
  it("are named after their bus topics, long-lived, scoped by the session", () => {
    expect(CHAT_EVENT_TYPES).toEqual([
      "platform.message.created",
      "voice.utterance",
      "voice.playback",
    ]);
    const registry = new EventRegistry().register(...CHAT_EVENTS);
    for (const type of CHAT_EVENT_TYPES) {
      expect(registry.defaults(type)).toEqual({ scope: null, tier: "long" });
    }
  });

  it("read a stored payload back, and nothing of a redacted one", () => {
    const message = {
      id: { context: ctx, id: "m1" },
      author: owen,
      text: "嗨",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: "2026-11-01T12:00:00Z",
    };
    const stored = { type: PlatformMessageCreated.type, v: 1, redacted_at: null };
    expect(readEventData(PlatformMessageCreated, { ...stored, data: message })).toEqual(message);
    expect(
      readEventData(PlatformMessageCreated, { ...stored, data: { ...message, self: true } })?.self,
    ).toBe(true);
    expect(
      readEventData(PlatformMessageCreated, {
        ...stored,
        data: { redacted: true },
        redacted_at: "2026-11-02T00:00:00Z",
      }),
    ).toBeNull();

    const utterance = {
      id: "u1",
      context: voice,
      speaker: owen,
      text: "聽得到嗎",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: "2026-11-01T12:00:00Z",
      ended_at: "2026-11-01T12:00:02Z",
      asr_ms: 120,
    };
    expect(
      readEventData(VoiceUtteranceEvent, { type: "voice.utterance", v: 1, data: utterance }),
    ).toEqual(utterance);

    const playback = { context: voice, turn: "t1", state: "started", text: "聽得到" };
    expect(
      readEventData(VoicePlaybackEvent, { type: "voice.playback", v: 1, data: playback }),
    ).toEqual(playback);
    expect(() =>
      readEventData(VoicePlaybackEvent, {
        type: "voice.playback",
        v: 1,
        data: { ...playback, state: "loud" },
      }),
    ).toThrow();
  });
});
