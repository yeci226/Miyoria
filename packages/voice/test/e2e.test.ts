// End-to-end voice latency (`speech_end → first_audio_played`), driven by a fake clock.

import type { ContextKey, MessageRef } from "@miyoria/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  E2E_SEGMENTS,
  E2eLatency,
  type E2eMeasure,
  type E2eRecord,
  e2eJson,
} from "../src/index.js";

const ctxKey: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };

class Clock {
  t = 10_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function ref(id: string): MessageRef {
  return { context: ctxKey, id };
}

let clock: Clock;
let out: E2eRecord[];
let e2e: E2eLatency;

beforeEach(() => {
  clock = new Clock();
  out = [];
  e2e = new E2eLatency({ now: clock.now, emit: (r) => out.push(r), ttlMs: 60_000, maxPending: 4 });
});

/** The person stopped 700 ms before the utterance was closed; the ASR request left right then. */
function hear(utterance = "u1"): void {
  const sentAt = clock.t;
  clock.advance(450); // ASR
  e2e.heard({
    context: ctxKey,
    utterance,
    speechEndAt: sentAt - 700,
    sentAt,
    transcriptAt: clock.t,
  });
}

/** Drives a reply to the point where the first audio is audible. */
function reply(utterance = "u1", turn = "t1"): E2eMeasure {
  clock.advance(500); // LLM
  e2e.textReady([ref(utterance)]);
  clock.advance(80); // translation, scheduler, waiting for a TTS slot
  const requestAt = clock.t;
  clock.advance(300); // TTS first chunk
  const firstAudioAt = clock.t;
  const m = e2e.begin(ctxKey, turn, [ref(utterance)]);
  if (m === null) throw new Error("expected a measurement");
  m.tts({ requestAt, firstAudioAt }, false, "fake-tts");
  clock.advance(120); // sent to the node, audible
  return m;
}

describe("e2e latency", () => {
  it("measures the six segments of a reply to speech", () => {
    hear();
    const m = reply();
    m.played();
    expect(out).toHaveLength(1);
    const r = out[0] as E2eRecord;
    expect(r.complete).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.turn).toBe("t1");
    expect(r.utterance).toBe("u1");
    expect(r.provider).toBe("fake-tts");
    expect(r.prefetched).toBe(false);
    expect(r.segments).toEqual({
      endpoint: 700,
      asr: 450,
      llm_first: 500,
      tts_queue: 80,
      tts_first: 300,
      playback: 120,
    });
    expect(r.total_ms).toBe(2150);
    expect(r.unattributed_ms).toBe(0);
    expect(e2e.size).toBe(0);
  });

  it("makes the segments add up to the total", () => {
    hear();
    reply().played();
    const r = out[0] as E2eRecord;
    const sum = E2E_SEGMENTS.reduce((s, name) => s + (r.segments[name] ?? 0), 0);
    expect(sum).toBe(r.total_ms);
  });

  it("keeps the sum exact when a prefetched line started before the first text was seen", () => {
    hear();
    clock.advance(500);
    const early = clock.t - 50; // a prefetch of the same line was already under way
    e2e.textReady([ref("u1")]);
    clock.advance(200);
    const m = e2e.begin(ctxKey, "t1", [ref("u1")]) as E2eMeasure;
    m.tts({ requestAt: early, firstAudioAt: clock.t - 10 }, true, "fake-tts");
    clock.advance(60);
    m.played();
    const r = out[0] as E2eRecord;
    expect(r.prefetched).toBe(true);
    for (const name of E2E_SEGMENTS) expect(r.segments[name]).toBeGreaterThanOrEqual(0);
    const sum = E2E_SEGMENTS.reduce((s, name) => s + (r.segments[name] ?? 0), 0);
    expect(sum).toBe(r.total_ms);
    expect(r.segments.tts_queue).toBe(0);
  });

  it("measures only the first line of a reply", () => {
    hear();
    reply().played();
    expect(e2e.begin(ctxKey, "t1", [ref("u1")])).toBeNull();
    expect(out).toHaveLength(1);
  });

  it("answers the newest utterance of the focus", () => {
    hear("u1");
    clock.advance(1000);
    hear("u2");
    reply("u2").played();
    const r = out[0] as E2eRecord;
    expect(r.utterance).toBe("u2");
    expect(r.segments.endpoint).toBe(700);
    expect(e2e.size).toBe(1); // u1 was never answered: it waits, and will expire silently
  });

  it("records a barge-in before the first audio as incomplete, with its reason", () => {
    hear();
    const m = reply();
    m.fail("barge_in");
    m.played(); // the node reports late: the first result stands
    m.fail("cancelled");
    expect(out).toHaveLength(1);
    const r = out[0] as E2eRecord;
    expect(r.complete).toBe(false);
    expect(r.reason).toBe("barge_in");
    expect(r.total_ms).toBeNull();
    expect(r.unattributed_ms).toBeNull();
    // What was measured before it stopped is kept; what was not stays null.
    expect(r.segments.endpoint).toBe(700);
    expect(r.segments.asr).toBe(450);
    expect(r.segments.llm_first).toBe(500);
    expect(r.segments.tts_first).toBe(300);
    expect(r.segments.playback).toBeNull();
    expect(e2e.size).toBe(0);
  });

  it("records a TTS failure as incomplete without TTS segments", () => {
    hear();
    clock.advance(500);
    e2e.textReady([ref("u1")]);
    clock.advance(40);
    const m = e2e.begin(ctxKey, "t1", [ref("u1")]) as E2eMeasure;
    clock.advance(200);
    m.fail("tts_failed");
    const r = out[0] as E2eRecord;
    expect(r.complete).toBe(false);
    expect(r.reason).toBe("tts_failed");
    expect(r.total_ms).toBeNull();
    expect(r.segments).toEqual({
      endpoint: 700,
      asr: 450,
      llm_first: 500,
      tts_queue: null,
      tts_first: null,
      playback: null,
    });
    expect(e2e.size).toBe(0);
  });

  it("ignores a turn that answers nobody's speech", () => {
    hear("u1");
    // A self-started turn has no focus; a text turn focuses messages that are not utterances.
    expect(e2e.begin(ctxKey, "self", [])).toBeNull();
    expect(e2e.begin(ctxKey, "text", [ref("m-99")])).toBeNull();
    expect(e2e.begin(ctxKey, null, [ref("u1")])).toBeNull();
    e2e.textReady([]);
    expect(out).toHaveLength(0);
    expect(e2e.size).toBe(1); // u1 still waits for its own reply
  });

  it("records played audio without a known speech end as incomplete", () => {
    e2e.heard({
      context: ctxKey,
      utterance: "u1",
      speechEndAt: null,
      sentAt: clock.t,
      transcriptAt: clock.t + 400,
    });
    clock.advance(400);
    reply().played();
    const r = out[0] as E2eRecord;
    expect(r.complete).toBe(false);
    expect(r.reason).toBe("speech_end_unknown");
    expect(r.total_ms).toBeNull();
    expect(r.segments.endpoint).toBeNull();
    expect(r.segments.asr).toBe(400);
    expect(r.segments.playback).toBe(120);
  });

  it("does not leak: unanswered utterances expire silently, begun ones are reported", () => {
    hear("quiet"); // nobody answers
    hear("begun");
    e2e.textReady([ref("begun")]); // a reply started, then its turn was dropped
    expect(e2e.size).toBe(2);
    clock.advance(61_000);
    hear("fresh"); // any call sweeps
    expect(e2e.size).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe("expired");
    expect(out[0]?.utterance).toBe("begun");
    expect(out[0]?.complete).toBe(false);
  });

  it("caps the utterances that wait", () => {
    for (let i = 0; i < 20; i++) hear(`u${i}`);
    expect(e2e.size).toBe(4);
    e2e.clear();
    expect(e2e.size).toBe(0);
  });

  it("serializes a record to JSON", () => {
    hear();
    reply().played();
    const json = e2eJson(out[0] as E2eRecord);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.total_ms).toBe(2150);
  });
});
