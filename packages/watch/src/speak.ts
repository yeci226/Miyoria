import type { WatchConfig } from "./config.js";

export interface SpeakFacts {
  worth: boolean;
  topic: string;
  /** Epoch milliseconds. */
  now: number;
  lastSpokeAt: number | null;
  lastVoiceAt: number | null;
  /** She is talking or singing. */
  busy: boolean;
  /** Keys or raw topics of what she said lately. */
  recentTopics: readonly string[];
}

/** A topic without whitespace, lowercased, for comparing. */
export function topicKey(topic: string): string {
  return topic.replace(/\s+/gu, "").toLowerCase();
}

/** Whether she may speak up now; anything that fails means the moment is dropped. */
export function speakGate(
  facts: SpeakFacts,
  cfg: Pick<WatchConfig, "speak_min_secs" | "quiet_secs">,
): boolean {
  if (!facts.worth || facts.busy) return false;
  if (facts.lastSpokeAt !== null && facts.now - facts.lastSpokeAt < cfg.speak_min_secs * 1000) {
    return false;
  }
  if (facts.lastVoiceAt !== null && facts.now - facts.lastVoiceAt < cfg.quiet_secs * 1000) {
    return false;
  }
  const key = topicKey(facts.topic);
  if (key !== "" && facts.recentTopics.some((t) => topicKey(t) === key)) return false;
  return true;
}
