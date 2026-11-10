// Speaking in another language: each line is translated right before TTS, the subtitles and the
// chat log keep the original. A voice reply usually writes the spoken line itself
// (`<voice>…</voice>`, see the agent's `Speech`); only lines without one take a translation call.

import { errorMessage, type Logger } from "@miyoria/kernel";
import { type LlmRouter, systemMessage, userMessage, withLlmTag } from "@miyoria/llm";

/** Translations kept for lines that were prepared but not spoken yet (or spoken twice). */
const MAX_CACHED = 32;

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/u;

/**
 * Whether `text` is in `language`, where that can be told from the script alone: Japanese has
 * kana (Chinese never does). `null` for languages it cannot tell.
 */
export function isIn(language: string, text: string): boolean | null {
  if (/japanese|日本|日文|日語/i.test(language)) return KANA.test(text);
  return null;
}

/** The prompt for one line. */
export function translatePrompt(language: string): string {
  return [
    `Translate the line the user gives you into natural spoken ${language}.`,
    "It is something a streamer says out loud: keep her tone, attitude, interjections and stammers,",
    "and keep names, usernames and game terms as they are.",
    "Reply with the translation only: no quotes, notes, romanization or explanations.",
  ].join(" ");
}

/**
 * Translates lines for TTS. `prepare` starts a translation early (when the sentence is queued), so
 * by the time it is spoken the translation is usually done; `translate` awaits it. A failed
 * translation falls back to the original text: she still speaks, just untranslated.
 */
export class SpeechTranslator {
  readonly #pending = new Map<string, Promise<string>>();

  constructor(
    private readonly router: LlmRouter,
    private readonly purpose: string,
    readonly language: string,
    private readonly log: Logger,
  ) {}

  prepare(text: string, session?: string): void {
    if (text.trim() === "" || this.#pending.has(text)) return;
    // Already in the target language (she slipped into it): said as it is.
    this.#keep(
      text,
      isIn(this.language, text) === true ? Promise.resolve(text) : this.#run(text, session),
    );
  }

  /**
   * The reply already said `text` in the target language: no translation call for it. A line
   * that is not in that language after all (she wrote it in Chinese) is ignored.
   */
  provide(text: string, translation: string, session?: string): void {
    if (text.trim() === "" || translation.trim() === "") return;
    if (isIn(this.language, translation) === false) {
      this.log.debug({ text, translation }, "spoken line is not in the target language");
      this.prepare(text, session);
      return;
    }
    this.#pending.delete(text);
    this.#keep(text, Promise.resolve(translation.trim()));
  }

  #keep(text: string, translation: Promise<string>): void {
    if (this.#pending.size >= MAX_CACHED) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(text, translation);
  }

  async translate(text: string, signal?: AbortSignal, session?: string): Promise<string> {
    this.prepare(text, session);
    const pending = this.#pending.get(text) ?? this.#run(text, session);
    this.#pending.delete(text);
    if (!signal) return pending;
    signal.throwIfAborted();
    return Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  }

  /**
   * `session`: the conversation's id. OpenCode often answers 429 for sessions it has not seen
   * much of (like the provider's fallback), and the voice channel's session is well used.
   */
  async #run(text: string, session?: string): Promise<string> {
    try {
      const response = await withLlmTag({ module: "voice", label: "translate" }, () =>
        this.router.complete(this.purpose, {
          messages: [systemMessage(translatePrompt(this.language)), userMessage(text)],
          temperature: 0.3,
          max_tokens: 400,
          thinking: false,
          ...(session !== undefined ? { session } : {}),
        }),
      );
      const out = response.text.trim();
      if (out === "") throw new Error("empty translation");
      return out;
    } catch (error) {
      this.log.warn(
        { err: errorMessage(error), text },
        "translation for speech failed, speaking the original",
      );
      return text;
    }
  }
}
