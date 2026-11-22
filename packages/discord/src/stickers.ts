// Server stickers (docs/design/server-emoji.md, "貼圖"): the stickers of each guild she is in,
// what each one means, and how she sends one.
//
// - The table comes from the gateway (guild create / ready, then sticker create, update, delete).
// - Each sticker's meaning: the owner's line in `[modules."platform.discord.bot".stickers]
//   descriptions` wins; otherwise a line the image model wrote once (`StickerDescriber`, kept in
//   the settings store); otherwise the description the server gave it. Animated Lottie stickers
//   cannot be looked at and keep their name and tags only.
// - She sees the list as a prompt block (`stickerContributor`), in the same `[貼圖: 名字]` form
//   other people's stickers reach her in (`incomingText`), so she knows what they sent.
// - She writes `[貼圖: 名字]` in a line; on the way out the sink takes it out of the text and sends
//   the sticker with that message (`sticker_ids`). Over the limits (one per message, at most a
//   few of her last messages in a channel, never the same one twice in a row, a cap per hour per
//   channel) it is taken out. A token that names no sticker of that guild is taken out too: it is
//   never text for people.
//
// Names, descriptions and tags are the server's data, not instructions: every one is flattened
// to one inert line (`safeName`) before it is shown, and the block goes into her prompt as data.

import {
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  safeName,
} from "@miyoria/types";
import {
  type Describe,
  type DescribeQueue,
  type DescriptionStore,
  type FetchLike,
  PictureDescriber,
} from "./emoji-describe.js";

/** Discord's sticker file formats (`StickerFormatType`). */
export const STICKER_FORMAT = { png: 1, apng: 2, lottie: 3, gif: 4 } as const;

/** One sticker of a guild. */
export interface ServerSticker {
  id: string;
  name: string;
  /** The server's own description of it; `null`: none. */
  description: string | null;
  /** The emoji or words Discord suggests it for (`tags`); `null`: none. */
  tags: string | null;
  /** `STICKER_FORMAT`. */
  format: number;
  /** `false` when the guild lost the boost level it needs; such stickers cannot be sent. */
  available: boolean;
}

/** A sticker as discord.js hands it out (`Sticker`). */
export interface StickerSourceLike {
  id: string | null;
  name: string | null;
  description?: string | null;
  tags?: string | null;
  format?: number | null;
  available?: boolean | null;
}

/** `ServerSticker` from a discord.js sticker; `null` when it has no id or name. */
export function serverSticker(s: StickerSourceLike): ServerSticker | null {
  if (!s.id || !s.name) return null;
  return {
    id: s.id,
    name: s.name,
    description: s.description?.trim() || null,
    tags: s.tags?.trim() || null,
    format: s.format ?? STICKER_FORMAT.png,
    available: s.available !== false,
  };
}

/**
 * The picture of a sticker the image model can look at, or `null` (a Lottie sticker is vector
 * animation data, no picture). APNG comes as its PNG; GIF stickers are served from the media host.
 */
export function stickerImage(s: ServerSticker): { url: string; type: string } | null {
  if (s.format === STICKER_FORMAT.lottie) return null;
  if (s.format === STICKER_FORMAT.gif) {
    return { url: `https://media.discordapp.net/stickers/${s.id}.gif?size=160`, type: "image/gif" };
  }
  return { url: `https://media.discordapp.net/stickers/${s.id}.png?size=160`, type: "image/png" };
}

/** Settings store key prefix of the written sticker meanings. */
export const STICKER_DESCRIPTION_PREFIX = "discord.sticker.desc.";

export const STICKER_DESCRIBE_PROMPT = (name: string): string =>
  `這是 Discord 伺服器的一張貼圖,名字叫「${stickerName(name)}」。用一句繁體中文(20 字內)說它畫的是什麼、大家通常拿它表達什麼,例如「貓咪鞠躬,道謝用」。只回這一句,不要引號。`;

/**
 * Meanings of stickers, kept by sticker id: Discord gives a sticker no asset hash and never
 * changes its file (editing a sticker changes only its name, description and tags), so the id
 * names the picture.
 */
export class StickerDescriber extends PictureDescriber<ServerSticker> {
  constructor(
    store: DescriptionStore | null,
    describe: Describe | null,
    fetchImpl?: FetchLike,
    queue?: DescribeQueue,
  ) {
    super({ image: stickerImage }, store, describe, fetchImpl, queue);
  }
}

/**
 * How a sticker's name is shown and written: one inert line without square brackets (they would
 * end the `[貼圖: …]` token), at most 30 characters.
 */
export function stickerName(name: string): string {
  return (
    safeName(name, 30)
      .replace(/[[\]［］]/g, "")
      .trim() || "(無名)"
  );
}

/** The stickers of every guild, by guild id. */
export class StickerTable {
  readonly #guilds = new Map<string, Map<string, ServerSticker>>();
  readonly #listeners = new Set<(guild: string) => void>();

  /** Replaces a guild's whole table. */
  setGuild(guild: string, stickers: Iterable<ServerSticker>): void {
    const byId = new Map<string, ServerSticker>();
    for (const s of stickers) byId.set(s.id, s);
    this.#guilds.set(guild, byId);
    this.#changed(guild);
  }

  upsert(guild: string, sticker: ServerSticker): void {
    let byId = this.#guilds.get(guild);
    if (!byId) {
      byId = new Map();
      this.#guilds.set(guild, byId);
    }
    byId.set(sticker.id, sticker);
    this.#changed(guild);
  }

  remove(guild: string, id: string): void {
    if (this.#guilds.get(guild)?.delete(id)) this.#changed(guild);
  }

  dropGuild(guild: string): void {
    if (this.#guilds.delete(guild)) this.#changed(guild);
  }

  /** Sendable stickers of `guild`, by name. */
  list(guild: string | null): ServerSticker[] {
    if (guild === null) return [];
    return [...(this.#guilds.get(guild)?.values() ?? [])]
      .filter((s) => s.available)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * The sendable sticker of `guild` she means by `name`: the name as shown to her first, then
   * the raw name, then either ignoring case.
   */
  get(guild: string | null, name: string): ServerSticker | undefined {
    const wanted = name.trim();
    if (wanted === "") return undefined;
    const all = this.list(guild);
    const lower = wanted.toLowerCase();
    return (
      all.find((s) => stickerName(s.name) === wanted) ??
      all.find((s) => s.name === wanted) ??
      all.find((s) => stickerName(s.name).toLowerCase() === lower) ??
      all.find((s) => s.name.toLowerCase() === lower)
    );
  }

  /** Every sticker of every guild (for describing). */
  all(): ServerSticker[] {
    return [...this.#guilds.values()].flatMap((m) => [...m.values()]);
  }

  /** Called with the guild id whenever a guild's table changes; returns an unsubscribe. */
  onChange(listener: (guild: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(guild: string): void {
    for (const listener of this.#listeners) listener(guild);
  }
}

/** How often she may send stickers. */
export interface StickerLimits {
  /** Of her last `window_messages` messages in a channel ... */
  window_messages: number;
  /** ... at most this many may carry a sticker. */
  max_in_window: number;
  /** Stickers per channel per rolling hour, at most. */
  per_hour: number;
}

const HOUR_MS = 3_600_000;

/** What she sent recently, per channel: the sticker of each message (newest last) and when. */
export class StickerUsage {
  readonly #messages = new Map<string, (string | null)[]>();
  readonly #sent = new Map<string, number[]>();

  constructor(readonly keep = 20) {}

  /** The sticker id of each of her recent messages in `channel` (`null`: none), newest last. */
  recent(channel: string): readonly (string | null)[] {
    return this.#messages.get(channel) ?? [];
  }

  /** Stickers sent in `channel` in the hour before `now`. */
  sentInHour(channel: string, now: number): number {
    const kept = (this.#sent.get(channel) ?? []).filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) this.#sent.delete(channel);
    else this.#sent.set(channel, kept);
    return kept.length;
  }

  record(channel: string, sticker: string | null, now: number): void {
    const list = this.#messages.get(channel) ?? [];
    list.push(sticker);
    while (list.length > this.keep) list.shift();
    this.#messages.set(channel, list);
    if (sticker !== null) {
      this.sentInHour(channel, now);
      this.#sent.set(channel, [...(this.#sent.get(channel) ?? []), now]);
    }
  }
}

/** `[貼圖: 名字]` (also `[貼圖:名字]`, the full-width colon, and `[sticker: name]`). */
const TOKEN = /\[\s*(?:貼圖|sticker)\s*[:：]\s*([^[\]\n]{1,60}?)\s*\]/gi;

/** Whether `text` holds a sticker token at all. */
export function hasStickerToken(text: string): boolean {
  TOKEN.lastIndex = 0;
  const found = TOKEN.test(text);
  TOKEN.lastIndex = 0;
  return found;
}

/** Why the sticker she wrote did not go (for the log and tests). */
export type StickerDropped = "unknown" | "extra" | "window" | "repeat" | "hourly" | "off";

/**
 * Her text with every `[貼圖: 名字]` taken out, and the one sticker that goes with the message:
 * the first token naming a sendable sticker of the guild (`lookup`), within `limits` given what
 * she sent recently in this channel. `lookup` `null`: stickers are off or there is no guild here,
 * so every token is only taken out.
 */
export function renderStickers(
  text: string,
  lookup: ((name: string) => ServerSticker | undefined) | null,
  recent: readonly (string | null)[],
  sentInHour: number,
  limits: StickerLimits,
): { text: string; sticker: ServerSticker | null; dropped: StickerDropped[] } {
  if (!hasStickerToken(text)) return { text, sticker: null, dropped: [] };
  const lately = limits.window_messages <= 1 ? [] : recent.slice(-(limits.window_messages - 1));
  const inWindow = lately.filter((s) => s !== null).length;
  const last = [...recent].reverse().find((s) => s !== null) ?? null;
  let sticker: ServerSticker | null = null;
  const dropped: StickerDropped[] = [];
  const out = text.replace(TOKEN, (_whole, name: string) => {
    if (lookup === null) {
      dropped.push("off");
      return "";
    }
    const found = lookup(name);
    if (found === undefined) dropped.push("unknown");
    else if (sticker !== null) dropped.push("extra");
    else if (found.id === last) dropped.push("repeat");
    else if (inWindow >= limits.max_in_window) dropped.push("window");
    else if (sentInHour >= limits.per_hour) dropped.push("hourly");
    else sticker = found;
    return "";
  });
  // Taking a token out can leave doubled spaces or a space before punctuation.
  const tidy = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]+([,.!?，。！？、])/g, "$1")
    .trim();
  return { text: tidy, sticker, dropped };
}

/** Where the meaning of each sticker comes from. */
export interface StickerMeanings {
  /** The owner's line for a sticker name in a server (its own lines, docs/design/v5-places.md). */
  owner(name: string, guild: string | null): string | undefined;
  /** A line the image model wrote for a sticker id, if any. */
  described(id: string): string | undefined;
}

/** The longest meaning and tag list shown per sticker (characters). */
const MAX_MEANING = 40;
const MAX_TAGS = 20;

/**
 * The block's lines: `[貼圖: 名字] — 意思(標籤:…)`, ones with a meaning first, at most `max`.
 * Every piece is the server's data and is flattened to one inert line.
 */
export function stickerLines(
  stickers: readonly ServerSticker[],
  meanings: StickerMeanings,
  max: number,
  guild: string | null = null,
): string[] {
  const rows = stickers.map((s) => {
    const meaning = meanings.owner(s.name, guild) ?? meanings.described(s.id) ?? s.description;
    return {
      name: stickerName(s.name),
      meaning: meaning ? safeName(meaning, MAX_MEANING) : null,
      tags: s.tags ? safeName(s.tags, MAX_TAGS) : null,
    };
  });
  rows.sort((a, b) => Number(b.meaning !== null) - Number(a.meaning !== null));
  return rows.slice(0, Math.max(max, 0)).map((r) => {
    let line = `[貼圖: ${r.name}]`;
    if (r.meaning !== null) line += ` — ${r.meaning}`;
    if (r.tags !== null) line += `(標籤:${r.tags})`;
    return line;
  });
}

export const STICKER_CONTRIBUTOR = "server_stickers";

export const STICKER_BLOCK = {
  title: "伺服器貼圖",
  head:
    "這個伺服器的貼圖和意思。別人訊息裡的 [貼圖: 名字] 就是這些。你想傳一張時,在那則訊息裡寫 [貼圖: 名字](名字照下面寫)," +
    "貼圖會跟著那則訊息送出,這幾個字不會出現。很少用、適時用就好,一則最多一張,不要連著用;語音裡不能用。",
} as const;

/**
 * The `伺服器貼圖` block for text turns in a guild: the stickers she can send there, and the
 * same list explains the stickers in other people's messages. Nothing in DMs or voice.
 */
export function stickerContributor(
  table: StickerTable,
  meanings: StickerMeanings,
  options: { max_listed: number; enabled: (guild: string) => boolean },
): PromptContributor {
  return {
    key: STICKER_CONTRIBUTOR,
    async contribute(request: PromptRequest): Promise<PromptSection[]> {
      const context = request.context;
      if (request.voice || context.platform !== "discord" || context.scope === null) return [];
      if (!options.enabled(context.scope)) return [];
      const lines = stickerLines(
        table.list(context.scope),
        meanings,
        options.max_listed,
        context.scope,
      );
      if (lines.length === 0) return [];
      return [
        {
          key: STICKER_CONTRIBUTOR,
          title: STICKER_BLOCK.title,
          body: [STICKER_BLOCK.head, ...lines].join("\n"),
          order: 71,
        },
      ];
    },
  };
}
