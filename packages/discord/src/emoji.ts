// Server emoji (docs/design/server-emoji.md): the custom emoji of each guild she is in, what
// each one means, and how she uses them.
//
// - The table comes from the gateway (guild create / ready, then emoji create, update, delete).
// - Each emoji's meaning: the owner's line in `[modules."platform.discord.bot".emoji]
//   descriptions` wins; otherwise a line the image model wrote once (`describeMissing`, kept in
//   the settings store); otherwise just the name.
// - She sees the list as a prompt block (`emojiContributor`), so `:fanfan:` in someone's message
//   means something to her too.
// - She writes `:name:`; on the way out it becomes `<:name:id>` (`<a:…>` when animated). Names
//   not in the table stay as written. Over the limits (one per message, at most one of her last
//   few messages in a channel, never the same one twice in a row) they are taken out.

import type { PromptContributor, PromptRequest, PromptSection } from "@miyoria/types";

/** One custom emoji of a guild. */
export interface ServerEmoji {
  id: string;
  name: string;
  animated: boolean;
  /** `false` when the guild lost the boost level it needs; such emoji cannot be used. */
  available: boolean;
}

/** An emoji as discord.js hands it out (`GuildEmoji`). */
export interface EmojiLike {
  id: string | null;
  name: string | null;
  animated?: boolean | null;
  available?: boolean | null;
}

/** `ServerEmoji` from a discord.js emoji; `null` when it has no id or name. */
export function serverEmoji(e: EmojiLike): ServerEmoji | null {
  if (!e.id || !e.name) return null;
  return {
    id: e.id,
    name: e.name,
    animated: e.animated === true,
    available: e.available !== false,
  };
}

/** `<:name:id>` / `<a:name:id>`. */
export function emojiMarkup(e: ServerEmoji): string {
  return `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
}

/** The emoji's picture on the CDN (a still frame for animated ones). */
export function emojiImageUrl(e: ServerEmoji): string {
  return `https://cdn.discordapp.com/emojis/${e.id}.png?size=96`;
}

/** The custom emoji of every guild, by guild id. */
export class EmojiTable {
  readonly #guilds = new Map<string, Map<string, ServerEmoji>>();
  readonly #listeners = new Set<(guild: string) => void>();

  /** Replaces a guild's whole table. */
  setGuild(guild: string, emoji: Iterable<ServerEmoji>): void {
    const byId = new Map<string, ServerEmoji>();
    for (const e of emoji) byId.set(e.id, e);
    this.#guilds.set(guild, byId);
    this.#changed(guild);
  }

  upsert(guild: string, emoji: ServerEmoji): void {
    let byId = this.#guilds.get(guild);
    if (!byId) {
      byId = new Map();
      this.#guilds.set(guild, byId);
    }
    byId.set(emoji.id, emoji);
    this.#changed(guild);
  }

  remove(guild: string, id: string): void {
    if (this.#guilds.get(guild)?.delete(id)) this.#changed(guild);
  }

  dropGuild(guild: string): void {
    if (this.#guilds.delete(guild)) this.#changed(guild);
  }

  /** Usable emoji of `guild`, by name. */
  list(guild: string | null): ServerEmoji[] {
    if (guild === null) return [];
    return [...(this.#guilds.get(guild)?.values() ?? [])]
      .filter((e) => e.available)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The usable emoji called `name` in `guild` (exact name first, then ignoring case). */
  get(guild: string | null, name: string): ServerEmoji | undefined {
    const all = this.list(guild);
    return (
      all.find((e) => e.name === name) ??
      all.find((e) => e.name.toLowerCase() === name.toLowerCase())
    );
  }

  /** Every emoji of every guild (for describing). */
  all(): ServerEmoji[] {
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

/** How often she may use server emoji. */
export interface EmojiLimits {
  /** Server emoji in one message, at most. */
  per_message: number;
  /** Of her last `window_messages` messages in a channel ... */
  window_messages: number;
  /** ... at most this many may carry a server emoji. */
  max_in_window: number;
}

/** What she used recently, per channel (newest last). */
export class EmojiUsage {
  readonly #channels = new Map<string, string[][]>();

  constructor(readonly keep = 20) {}

  recent(channel: string): readonly string[][] {
    return this.#channels.get(channel) ?? [];
  }

  record(channel: string, used: readonly string[]): void {
    const list = this.#channels.get(channel) ?? [];
    list.push([...used]);
    while (list.length > this.keep) list.shift();
    this.#channels.set(channel, list);
  }
}

/** `:name:` not part of `<:name:id>` / `<a:name:id>` and not followed by an id. */
const SHORTCODE = /(?<![<\w]):(\w{2,32}):(?!\d)/g;
/** Raw custom emoji markup, `<:name:id>` / `<a:name:id>`. */
const MARKUP = /<a?:(\w{2,32}):\d{1,20}>/g;
/** An emoji alone in inline code: `` `<:name:id>` `` or `` `:name:` ``. */
const CODED = /`\s*(<a?:\w{2,32}:\d{1,20}>|:\w{2,32}:)\s*`/g;

/**
 * Raw emoji markup she copied (from a message she saw, a tool result) back to `:name:`, and an
 * emoji she put in inline code out of it: inside backticks Discord shows the markup as text
 * instead of the emoji. `renderEmoji` then turns the names it knows back into markup.
 */
export function loosenEmoji(text: string): string {
  return uncodeEmoji(text).replace(MARKUP, (_m, name: string) => `:${name}:`);
}

/** Only takes emoji out of inline code (when server emoji are off). */
export function uncodeEmoji(text: string): string {
  return text.replace(CODED, "$1");
}

/**
 * Her text with `:name:` turned into server emoji markup, within `limits` given what she used
 * recently in this channel (`recent`, newest last). Names that are not server emoji stay as
 * written; server emoji over the limits are taken out. Returns the text and the names used.
 */
export function renderEmoji(
  text: string,
  lookup: (name: string) => ServerEmoji | undefined,
  recent: readonly (readonly string[])[],
  limits: EmojiLimits,
): { text: string; used: string[] } {
  const source = loosenEmoji(text);
  // Her previous messages that share the window with this one.
  const lately = limits.window_messages <= 1 ? [] : recent.slice(-(limits.window_messages - 1));
  const withEmoji = lately.filter((u) => u.length > 0).length;
  const lastUsed = [...recent].reverse().find((u) => u.length > 0) ?? [];
  let allowed = withEmoji >= limits.max_in_window ? 0 : limits.per_message;
  const used: string[] = [];
  let removed = false;
  const out = source.replace(SHORTCODE, (whole, name: string) => {
    const emoji = lookup(name);
    if (!emoji) return whole;
    if (allowed <= 0 || lastUsed.includes(emoji.name) || used.includes(emoji.name)) {
      removed = true;
      return "";
    }
    allowed--;
    used.push(emoji.name);
    return emojiMarkup(emoji);
  });
  if (!removed) return { text: out, used };
  // Taking one out can leave doubled spaces or a space before punctuation.
  const tidy = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]+([,.!?，。！？、])/g, "$1")
    .trim();
  if (tidy !== "") return { text: tidy, used };
  // A message that was nothing but emoji keeps its first one: an empty message cannot be sent.
  for (const m of source.matchAll(SHORTCODE)) {
    const emoji = lookup(m[1] as string);
    if (emoji) return { text: emojiMarkup(emoji), used: [emoji.name] };
  }
  return { text: tidy, used };
}

/**
 * A reaction as Discord's API takes it: a server emoji written `:name:`, `name` or as markup
 * `<:name:id>` becomes `name:id`; anything else is passed on unchanged.
 */
export function reactionEmoji(
  emoji: string,
  lookup: (name: string) => ServerEmoji | undefined,
): string {
  const markup = /^<a?:(\w{2,32}):(\d{1,20})>$/.exec(emoji.trim());
  if (markup) {
    const found = lookup(markup[1] as string);
    return found ? `${found.name}:${found.id}` : `${markup[1]}:${markup[2]}`;
  }
  const m = /^:?(\w{2,32}):?$/.exec(emoji.trim());
  if (!m) return emoji;
  const found = lookup(m[1] as string);
  return found ? `${found.name}:${found.id}` : emoji;
}

/** Where the meaning of each emoji comes from. */
export interface EmojiMeanings {
  /** The owner's line for an emoji name, if any. */
  owner(name: string): string | undefined;
  /** A line the image model wrote for an emoji id, if any. */
  described(id: string): string | undefined;
}

/** The longest meaning shown per emoji (characters). */
const MAX_MEANING = 40;

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** The block's lines: `:name: — meaning`, described ones first, at most `max`. */
export function emojiLines(
  emoji: readonly ServerEmoji[],
  meanings: EmojiMeanings,
  max: number,
): string[] {
  const rows = emoji.map((e) => {
    const meaning = meanings.owner(e.name) ?? meanings.described(e.id);
    return { name: e.name, meaning: meaning ? cut(meaning, MAX_MEANING) : null };
  });
  // Ones with a meaning first, so a long table keeps the ones she can use well.
  rows.sort((a, b) => Number(b.meaning !== null) - Number(a.meaning !== null));
  return rows
    .slice(0, Math.max(max, 0))
    .map((r) => (r.meaning ? `:${r.name}: — ${r.meaning}` : `:${r.name}:`));
}

export const EMOJI_CONTRIBUTOR = "server_emoji";

/**
 * The `伺服器表情` block for text turns in a guild: the emoji she can use, and the same list
 * explains `:name:` in other people's messages. Nothing in DMs or voice.
 */
export function emojiContributor(
  table: EmojiTable,
  meanings: EmojiMeanings,
  options: { max_listed: number; enabled: () => boolean },
): PromptContributor {
  return {
    key: EMOJI_CONTRIBUTOR,
    async contribute(request: PromptRequest): Promise<PromptSection[]> {
      if (!options.enabled() || request.voice) return [];
      const context = request.context;
      if (context.platform !== "discord" || context.scope === null) return [];
      const lines = emojiLines(table.list(context.scope), meanings, options.max_listed);
      if (lines.length === 0) return [];
      return [
        {
          key: EMOJI_CONTRIBUTOR,
          title: "伺服器表情",
          body: [
            "這個伺服器的自訂表情和意思。別人訊息裡的 :名字: 就是這些;你想用時寫 :名字:,偶爾、適時用就好,一則最多一個。用 react 按表情時也可以填 :名字:。",
            ...lines,
          ].join("\n"),
          order: 70,
        },
      ];
    },
  };
}
