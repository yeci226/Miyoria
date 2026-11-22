// Where her voice is now, for the speech-host rule of job dispatch (docs/design/v5-hostd.md §15.5):
// whether she is in a voice call (from `voice.joined` and `voice.left`), whether she is live (the
// `live` guard state), and when someone last spoke in voice (people's speech and utterances, and
// her own playback).

import { Events } from "@miyoria/types";
import type { ClusterActivity } from "./registry.js";

/** The bus events the tracker reads. */
export const ACTIVITY_EVENTS: readonly string[] = [
  Events.VoiceJoined.type,
  Events.VoiceLeft.type,
  Events.VoiceSpeaking.type,
  Events.VoiceUtteranceEvent.type,
  Events.VoicePlaybackEvent.type,
];

/** Folds the voice events into `ClusterActivity`. */
export class ActivityTracker {
  /** The voice rooms she is in, by their context as JSON. */
  readonly #rooms = new Set<string>();
  #lastSpoke: number | null = null;
  #live = false;

  /** One bus event; anything else is ignored. */
  onEvent(env: { type: string; data: unknown }, now: number): void {
    const data = (typeof env.data === "object" && env.data !== null ? env.data : {}) as {
      context?: unknown;
      speaking?: unknown;
    };
    const room = JSON.stringify(data.context ?? null);
    switch (env.type) {
      case Events.VoiceJoined.type:
        this.#rooms.add(room);
        return;
      case Events.VoiceLeft.type:
        this.#rooms.delete(room);
        return;
      case Events.VoiceSpeaking.type:
        if (data.speaking === true) this.#lastSpoke = now;
        return;
      case Events.VoiceUtteranceEvent.type:
      case Events.VoicePlaybackEvent.type:
        this.#lastSpoke = now;
        return;
    }
  }

  /** Whether her broadcast is live (the `live` guard state, read every few seconds). */
  setLive(live: boolean): void {
    this.#live = live;
  }

  snapshot(): ClusterActivity {
    return { in_voice: this.#rooms.size > 0, live: this.#live, last_spoke_at: this.#lastSpoke };
  }
}
