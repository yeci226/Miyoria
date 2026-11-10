// What a server emoji means, written once by the image model and kept in the settings store
// (`discord.emoji.desc.<id>`), so `:fanfan:` reads as "a bowl of rice, for begging food" even
// when the name says nothing. Emoji the owner described in the config are never sent.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { ServerEmoji } from "./emoji.js";
import { emojiImageUrl } from "./emoji.js";

const log = getLogger("discord.emoji");

/** Settings store key prefix of the written meanings. */
export const DESCRIPTION_PREFIX = "discord.emoji.desc.";

/** How long one description may take. */
const DESCRIBE_TIMEOUT_MS = 20_000;
/** Largest emoji picture downloaded. */
const MAX_IMAGE_BYTES = 512 * 1024;

/** The model call: a data URL of the picture and the emoji's name → one line, or `null`. */
export type Describe = (
  dataUrl: string,
  name: string,
  signal: AbortSignal,
) => Promise<string | null>;

/** Where the lines are kept. */
export interface DescriptionStore {
  load(): Promise<Map<string, string>>;
  save(id: string, line: string): Promise<void>;
}

/** `fetch` as the describer uses it (tests pass a fake). */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export const DESCRIBE_PROMPT = (name: string): string =>
  `這是 Discord 伺服器的一個自訂表情,名字叫 :${name}:。用一句繁體中文(20 字內)說它畫的是什麼、大家通常拿它表達什麼,例如「一碗白飯,討飯用」。只回這一句,不要引號。`;

/** Meanings by emoji id, filled from the store and by describing new emoji in the background. */
export class EmojiDescriber {
  readonly #lines = new Map<string, string>();
  readonly #tried = new Set<string>();
  #running: Promise<void> | null = null;
  #loaded = false;

  constructor(
    private readonly store: DescriptionStore | null,
    private readonly describe: Describe | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /** The written line for `id`, if any. */
  get(id: string): string | undefined {
    return this.#lines.get(id);
  }

  async load(): Promise<void> {
    if (this.#loaded || !this.store) return;
    this.#loaded = true;
    try {
      for (const [id, line] of await this.store.load()) this.#lines.set(id, line);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot load emoji meanings");
    }
  }

  /**
   * Describes, one at a time, the emoji in `emoji` that have no line yet and are not `skip`ped
   * (the owner's). Each emoji is tried once per run. Resolves when this pass is done.
   */
  describeMissing(
    emoji: readonly ServerEmoji[],
    skip: (e: ServerEmoji) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.describe) return Promise.resolve();
    const previous = this.#running ?? Promise.resolve();
    const next = previous.then(() => this.#pass(emoji, skip, signal));
    this.#running = next.finally(() => {
      if (this.#running === next) this.#running = null;
    });
    return next;
  }

  async #pass(
    emoji: readonly ServerEmoji[],
    skip: (e: ServerEmoji) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await this.load();
    for (const e of emoji) {
      if (signal.aborted) return;
      if (this.#lines.has(e.id) || this.#tried.has(e.id) || skip(e)) continue;
      this.#tried.add(e.id);
      try {
        const line = await this.#describeOne(e, signal);
        if (line === null) continue;
        this.#lines.set(e.id, line);
        await this.store?.save(e.id, line);
      } catch (error) {
        if (signal.aborted) return;
        log.debug({ emoji: e.name, error: errorMessage(error) }, "cannot describe emoji");
      }
    }
  }

  async #describeOne(e: ServerEmoji, outer: AbortSignal): Promise<string | null> {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)]);
    const response = await this.fetchImpl(emojiImageUrl(e), { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_IMAGE_BYTES) return null;
    const dataUrl = `data:image/png;base64,${body.toString("base64")}`;
    const line = await this.describe?.(dataUrl, e.name, signal);
    const clean = cleanLine(line ?? "");
    return clean === "" ? null : clean;
  }
}

/** One short line: no quotes, no line breaks, at most 40 characters. */
export function cleanLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const bare = first.replace(/^[\s「『"'“]+|[\s」』"'”]+$/g, "").trim();
  const chars = [...bare];
  return chars.length > 40 ? chars.slice(0, 40).join("") : bare;
}
