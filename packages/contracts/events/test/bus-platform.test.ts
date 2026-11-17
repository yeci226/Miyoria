// The typed bus variants and the platform, voice and kernel topics: their tiers and scopes, and
// payloads as their publishers build them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();
const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const voice = { ...ctx, kind: "voice" } as const;
const account = { platform: "discord", id: "1" };

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["platform.ready", "self", "short"],
    ["platform.message.created", null, "long"],
    ["platform.typing", null, "ambient"],
    ["platform.reaction", null, "long"],
    ["platform.presence", "space", "ambient"],
    ["platform.voice_state", "space", "ambient"],
    ["platform.member", "space", "ambient"],
    ["voice.joined", null, "short"],
    ["voice.left", null, "short"],
    ["voice.participants", null, "ambient"],
    ["voice.speaking", null, "ambient"],
    ["voice.utterance", null, "long"],
    ["voice.playback", null, "long"],
    ["voice.golive", "space", "short"],
    ["voice.barge_in", null, "short"],
    ["voice.upcoming", null, "short"],
    ["voice.synthesis", null, "short"],
    ["voice.latency", "owner", "short"],
    ["speech.pause", "self", "short"],
    ["system.module.state", "owner", "short"],
    ["system.shutdown", "self", "short"],
    ["action.completed", null, "short"],
    ["action.settled", null, "short"],
    ["agent.turn.started", null, "short"],
    ["agent.turn.completed", null, "short"],
    ["agent.initiative", null, "short"],
    ["agent.decision", null, "short"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("a module state, a shutdown, an action that ended with a moderated message", () => {
    expect(
      problems("system.module.state", { module: "voice", state: "failed", reason: "boom" }),
    ).toEqual([]);
    expect(problems("system.shutdown", {})).toEqual([]);
    expect(
      problems("action.completed", {
        action: "a1",
        turn: null,
        ok: true,
        error: null,
        message: { context: ctx, id: "m1", blocked: "slur" },
      }),
    ).toEqual([]);
  });

  it("every voice.latency stage", () => {
    const stages = [
      {
        stage: "asr",
        context: voice,
        speaker: account,
        provider: "qwen",
        audio_ms: 1200,
        transcribe_ms: 180,
        asr_ms: 210,
      },
      { stage: "turn", context: voice, verdict: "complete", probability: 0.9, judge_ms: 12 },
      { stage: "turn_resumed", context: voice, after_ms: 300, at: 1000, probability: null },
      { stage: "llm", context: voice, turn: "t1", model: "x:y", first_token_ms: 400 },
      { stage: "speculation", context: voice, turn: "t1", result: "dropped", ms: 50, model: true },
      {
        stage: "tts",
        context: voice,
        turn: "t1",
        provider: null,
        chars: 12,
        first_audio_ms: 300,
        prefetched: false,
      },
      { stage: "filler", context: voice, turn: null, text: "嗯", ms: 400 },
      {
        stage: "e2e",
        context: voice,
        turn: "t1",
        utterance: "u1",
        complete: true,
        reason: null,
        total_ms: 1500,
        segments: {
          endpoint: 300,
          asr: 200,
          prepare: 100,
          llm_first: 500,
          tts_queue: 0,
          tts_first: 300,
          playback: null,
        },
        unattributed_ms: 100,
        prefetched: false,
        provider: "x",
        turn_end: { ended_by: "turn", probability: 0.8 },
        parts: {
          prepare: { wait: 1, decide: 2, context: 3, prompt: 4 },
          llm_first: { first_token: 5, held: null, first_sentence: 6 },
        },
        speculative: false,
        filler_ms: 200,
      },
    ];
    for (const payload of stages)
      expect(problems("voice.latency", payload), payload.stage).toEqual([]);
    expect(problems("voice.latency", { stage: "asr", context: voice, asr_ms: 210 })).toEqual([
      { kind: "invalid", path: "speaker", message: expect.any(String) },
    ]);
  });

  it("a presence with its activities", () => {
    expect(
      problems("platform.presence", {
        platform: "discord",
        guild: "g1",
        account,
        display_name: "Mika",
        is_bot: false,
        status: "online",
        activities: [
          {
            type: "listening",
            name: "Spotify",
            details: "song",
            state: "artist",
            started_at: "2026-11-15T00:00:00.000Z",
            url: null,
          },
        ],
        initial: false,
      }),
    ).toEqual([]);
  });

  it("a playback line without the fields older publishers leave out", () => {
    expect(
      problems("voice.playback", { context: voice, turn: null, state: "started", text: "嗨" }),
    ).toEqual([]);
  });
});
