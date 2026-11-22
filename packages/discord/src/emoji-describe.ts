// What a server emoji or sticker means, written once by the image model and kept in the settings
// store (`discord.emoji.desc.<id>`, `discord.sticker.desc.<id>`), so `:fanfan:` reads as "a bowl
// of rice, for begging food" even when the name says nothing. Ones the owner described in the
// config are never sent. Emoji and stickers share one queue: one picture is looked at at a time,
// each tried once per run, with the same time limit and size cap.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { ServerEmoji } from "./emoji.js";
import { emojiImageUrl } from "./emoji.js";

const log = getLogger("discord.emoji");

/** Settings store key prefix of the written emoji meanings. */
export const DESCRIPTION_PREFIX = "discord.emoji.desc.";

/** How long one description may take. */
const DESCRIBE_TIMEOUT_MS = 20_000;
/** Largest picture downloaded (Discord's own cap for a sticker file is 512 KiB too). */
const MAX_IMAGE_BYTES = 512 * 1024;

/** The model call: a data URL of the picture and the item's name → one line, or `null`. */
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

/** The one queue every describer of a module runs on: one picture at a time. */
export class DescribeQueue {
  #tail: Promise<void> = Promise.resolve();

  /** Runs `work` after everything queued before it; resolves when it is done. */
  run(work: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** What a describer needs of one kind of item. */
export interface PictureKind<T extends { id: string; name: string }> {
  /** The picture to look at and its type; `null`: it cannot be looked at (never tried). */
  image(item: T): { url: string; type: string } | null;
}

/** Meanings by id, filled from the store and by describing new items in the background. */
export class PictureDescriber<T extends { id: string; name: string }> {
  readonly #lines = new Map<string, string>();
  readonly #tried = new Set<string>();
  #loaded = false;

  constructor(
    private readonly kind: PictureKind<T>,
    private readonly store: DescriptionStore | null,
    private readonly describe: Describe | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly queue: DescribeQueue = new DescribeQueue(),
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
      log.warn({ error: errorMessage(error) }, "cannot load picture meanings");
    }
  }

  /**
   * Describes, one at a time, the items in `items` that have no line yet, can be looked at and
   * are not `skip`ped (the owner's). Each is tried once per run. Resolves when this pass is done.
   */
  describeMissing(
    items: readonly T[],
    skip: (item: T) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.describe) return Promise.resolve();
    return this.queue.run(() => this.#pass(items, skip, signal));
  }

  async #pass(items: readonly T[], skip: (item: T) => boolean, signal: AbortSignal): Promise<void> {
    await this.load();
    for (const item of items) {
      if (signal.aborted) return;
      if (this.#lines.has(item.id) || this.#tried.has(item.id) || skip(item)) continue;
      const image = this.kind.image(item);
      if (image === null) continue;
      this.#tried.add(item.id);
      try {
        const line = await this.#describeOne(item, image, signal);
        if (line === null) continue;
        this.#lines.set(item.id, line);
        await this.store?.save(item.id, line);
      } catch (error) {
        if (signal.aborted) return;
        log.debug({ name: item.name, error: errorMessage(error) }, "cannot describe a picture");
      }
    }
  }

  async #describeOne(
    item: T,
    image: { url: string; type: string },
    outer: AbortSignal,
  ): Promise<string | null> {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)]);
    const response = await this.fetchImpl(image.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_IMAGE_BYTES) return null;
    const dataUrl = `data:${image.type};base64,${body.toString("base64")}`;
    const line = await this.describe?.(dataUrl, item.name, signal);
    const clean = cleanLine(line ?? "");
    return clean === "" ? null : clean;
  }
}

const EMOJI: PictureKind<ServerEmoji> = {
  image: (e) => ({ url: emojiImageUrl(e), type: "image/png" }),
};

/** Meanings of server emoji. */
export class EmojiDescriber extends PictureDescriber<ServerEmoji> {
  constructor(
    store: DescriptionStore | null,
    describe: Describe | null,
    fetchImpl?: FetchLike,
    queue?: DescribeQueue,
  ) {
    super(EMOJI, store, describe, fetchImpl, queue);
  }
}

/** One short line: no quotes, no line breaks, at most 40 characters. */
export function cleanLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const bare = first.replace(/^[\s「『"'“]+|[\s」』"'”]+$/g, "").trim();
  const chars = [...bare];
  return chars.length > 40 ? chars.slice(0, 40).join("") : bare;
}
