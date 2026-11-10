// Highlights: while she streams, moments worth keeping are saved from OBS's replay buffer (the
// last seconds of the stream) by the Stage node, with a note of why next to the file. The owner
// picks clips to post from OBS's replay folder.
//
// A moment is: a song she sang to the end, a strong feeling of hers (`emotions` at least
// `emotion_intensity`), or the chat suddenly busy (`chat_burst_messages` within
// `chat_burst_secs`). At most one per `cooldown_secs`; each is saved `delay_ms` after the moment,
// so the reaction is in the clip too.

import { type Event, isJsonObject, parseSongCue, SONG_TOPIC } from "@miyoria/types";
import { z } from "zod";
import { EMOTION_TOPIC } from "./forward.js";

/** `[modules."stage.link".highlights]`. */
export const HighlightsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Least time between two highlights. */
  cooldown_secs: z.number().int().nonnegative().default(90),
  /** How long after the moment the buffer is saved. */
  delay_ms: z.number().int().nonnegative().max(60_000).default(4_000),
  /** A song she sang to the end. */
  song_finished: z.boolean().default(true),
  /** Her feelings that count, and how strong. */
  emotions: z.array(z.string()).default(["laugh", "surprised", "excited"]),
  emotion_intensity: z.number().min(0).max(1).default(0.85),
  /** Chat lines within `chat_burst_secs` that count as the chat taking off (0 = off). */
  chat_burst_messages: z.number().int().nonnegative().default(8),
  chat_burst_secs: z.number().int().positive().default(20),
});
export type HighlightsConfig = z.output<typeof HighlightsConfigSchema>;

/** Decides which moments are highlights (it does not save them). */
export class Highlights {
  readonly #cfg: HighlightsConfig;
  #last = Number.NEGATIVE_INFINITY;
  readonly #titles = new Map<string, string>();
  #chat: number[] = [];

  constructor(config: HighlightsConfig) {
    this.#cfg = config;
  }

  /** A chat line at `nowMs`; the reason when the chat just took off. */
  message(nowMs: number): string | null {
    const { chat_burst_messages: n, chat_burst_secs: secs } = this.#cfg;
    if (!this.#cfg.enabled || n === 0) return null;
    const since = nowMs - secs * 1000;
    this.#chat = [...this.#chat.filter((t) => t > since), nowMs];
    if (this.#chat.length < n) return null;
    const reason = this.#take(nowMs, "聊天室突然熱起來");
    if (reason !== null) this.#chat = [];
    return reason;
  }

  /** The reason when `event` is a highlight now. */
  onEvent(event: Event, nowMs: number): string | null {
    if (!this.#cfg.enabled || event.type !== "custom") return null;
    const { topic, payload } = event.data;
    if (topic === SONG_TOPIC) {
      const cue = parseSongCue(payload);
      if (cue?.state === "started") {
        this.#titles.set(cue.song, cue.title);
        if (this.#titles.size > 32) this.#titles.delete(this.#titles.keys().next().value as string);
      }
      if (cue?.state !== "ended") return null;
      const title = this.#titles.get(cue.song) ?? "";
      this.#titles.delete(cue.song);
      if (!this.#cfg.song_finished || cue.outcome !== "finished") return null;
      return this.#take(nowMs, title === "" ? "唱完一首歌" : `唱完《${title}》`);
    }
    if (topic === EMOTION_TOPIC && isJsonObject(payload)) {
      const raw = payload.emotion ?? payload.name;
      const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      const intensity = typeof payload.intensity === "number" ? payload.intensity : 0;
      const wanted = this.#cfg.emotions.map((e) => e.toLowerCase());
      if (name === "" || !wanted.includes(name) || intensity < this.#cfg.emotion_intensity) {
        return null;
      }
      return this.#take(nowMs, `她的情緒很強烈(${name})`);
    }
    return null;
  }

  #take(nowMs: number, reason: string): string | null {
    if (nowMs - this.#last < this.#cfg.cooldown_secs * 1000) return null;
    this.#last = nowMs;
    return reason;
  }
}
