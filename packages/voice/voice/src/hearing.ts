// Hearing a watched stream: audio → ASR → text. It is not someone talking to her, so nothing is
// published; humans keep the ASR slots (a stream only takes a free one and is dropped otherwise).

import { errorMessage, getLogger, type Logger } from "@miyoria/runtime/kernel";
import { type AccountRef, serviceKey } from "@miyoria/types";
import type { AsrHint, SpeechService } from "../../speech/src/index.js";
import type { VoiceConfig } from "./config.js";
import type { Consent } from "./consent.js";
import { cleanTranscript } from "./text.js";
import type { Semaphore } from "./util.js";

/** Sample rate of `0x05` watch audio frames. */
const WATCH_SAMPLE_RATE = 16_000;
const HINT: AsrHint = { language: null, prompt: null };

export interface StreamHearing {
  /** This person's voice consent; a read failure counts as not allowed. */
  allowed(account: AccountRef): Promise<boolean>;
  /** The text, or `null` (blank, hallucination, ASR busy or failed). Publishes no event. */
  transcribe(samples: Int16Array, signal: AbortSignal): Promise<string | null>;
}

export const StreamHearingKey = serviceKey<StreamHearing>("StreamHearing");

export interface HearingDeps {
  speech: SpeechService;
  consent: Consent;
  /** Shared with the listener. */
  asrSlots: Semaphore;
  config: Pick<VoiceConfig, "to_traditional" | "hallucinations">;
  log?: Logger;
}

/** It has no way to publish, so stream speech never becomes a `voice_utterance`. */
export class Hearing implements StreamHearing {
  readonly #d: HearingDeps;
  readonly #log: Logger;

  constructor(deps: HearingDeps) {
    this.#d = deps;
    this.#log = deps.log ?? getLogger("voice.hearing");
  }

  allowed(account: AccountRef): Promise<boolean> {
    return this.#d.consent.allowed(account).catch(() => false);
  }

  async transcribe(samples: Int16Array, signal: AbortSignal): Promise<string | null> {
    const release = this.#d.asrSlots.tryAcquire();
    if (release === null) {
      this.#log.debug("ASR is busy; dropping stream speech");
      return null;
    }
    try {
      const [, transcript] = await this.#d.speech.transcribe(
        { sampleRate: WATCH_SAMPLE_RATE, samples },
        HINT,
        signal,
      );
      const { to_traditional, hallucinations } = this.#d.config;
      return cleanTranscript(transcript.text, to_traditional, hallucinations);
    } catch (error) {
      if (!signal.aborted) this.#log.warn({ err: errorMessage(error) }, "stream ASR failed");
      return null;
    } finally {
      release();
    }
  }
}
