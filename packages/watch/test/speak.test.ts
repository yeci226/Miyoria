import { describe, expect, it } from "vitest";
import { type SpeakFacts, speakGate, topicKey } from "../src/speak.js";

const cfg = { speak_min_secs: 60, quiet_secs: 10 };
const ok: SpeakFacts = {
  worth: true,
  topic: "貓咪",
  now: 1_000_000,
  lastSpokeAt: 1_000_000 - 120_000,
  lastVoiceAt: 1_000_000 - 20_000,
  busy: false,
  recentTopics: ["遊戲"],
};

describe("speakGate", () => {
  it("passes when every condition holds", () => {
    expect(speakGate(ok, cfg)).toBe(true);
  });
  it("blocks each violated condition", () => {
    expect(speakGate({ ...ok, worth: false }, cfg)).toBe(false);
    expect(speakGate({ ...ok, lastSpokeAt: ok.now - 59_999 }, cfg)).toBe(false);
    expect(speakGate({ ...ok, lastVoiceAt: ok.now - 9_999 }, cfg)).toBe(false);
    expect(speakGate({ ...ok, busy: true }, cfg)).toBe(false);
    expect(speakGate({ ...ok, recentTopics: ["貓 咪"] }, cfg)).toBe(false);
  });
  it("allows exactly speak_min_secs and quiet_secs", () => {
    expect(
      speakGate({ ...ok, lastSpokeAt: ok.now - 60_000, lastVoiceAt: ok.now - 10_000 }, cfg),
    ).toBe(true);
  });
  it("does not block on null timestamps", () => {
    expect(speakGate({ ...ok, lastSpokeAt: null, lastVoiceAt: null }, cfg)).toBe(true);
  });
  it("an empty topic never blocks", () => {
    expect(speakGate({ ...ok, topic: "  ", recentTopics: ["", " "] }, cfg)).toBe(true);
  });
});

describe("topicKey", () => {
  it("ignores whitespace and case", () => {
    expect(topicKey("  貓 咪 ")).toBe(topicKey("貓咪"));
    expect(topicKey("Elden Ring")).toBe(topicKey("eldenring"));
  });
});
