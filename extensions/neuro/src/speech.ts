// `speech_finished` (server -> game): tells the game she stopped talking. The voice module reports
// playback per sentence, not per answer, so a finished sentence is sent as `isFinal: false` and the
// answer counts as final once no new sentence started for `quietMs`. An approximation of the spec's
// "utterance": the game should wait for `isFinal: true`, which this sends at the end of her speech.

import type { PlaybackState } from "@miyoria/types";
import { type ServerMessage, speechFinished } from "./protocol.js";

export class SpeechRelay {
  readonly #send: (message: ServerMessage) => void;
  readonly #quietMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (message: ServerMessage) => void, quietMs = 1500) {
    this.#send = send;
    this.#quietMs = quietMs;
  }

  playback(state: PlaybackState): void {
    if (state === "started") {
      this.#clear();
      return;
    }
    if (state === "finished") {
      this.#send(speechFinished(false));
      this.#clear();
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#send(speechFinished(true));
      }, this.#quietMs);
      this.#timer.unref?.();
      return;
    }
    // Interrupted or failed: the utterance is over and was cut short.
    this.#clear();
    this.#send(speechFinished(true, true, state === "interrupted" ? "interrupted" : "failed"));
  }

  close(): void {
    this.#clear();
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
