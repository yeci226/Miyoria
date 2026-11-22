// `DiscordSink`: executes output actions through the bot account's REST client.
//
// A message may carry attachments, named by artifact id (`OutgoingMessage.attachments`). The sink
// never sees a path: it asks the app's `AttachmentSource` for each one at send time, which checks
// again that the channel may see the artifact, and uploads the bytes it gets back with the first
// chunk of the text. Nothing is posted when one of them is refused.

import type { CommandReply, ReplySink } from "@miyoria/commands";
import {
  type AccountRef,
  AttachmentError,
  type AttachmentFile,
  type AttachmentSource,
  type ContextKey,
  contextKeyString,
  type MessageRef,
  type ModerationService,
  type OutgoingMessage,
  type PlatformId,
  type PlatformSink,
  type SentMessage,
  safeOutgoing,
} from "@miyoria/types";
import { MessageFlags, Routes } from "discord.js";
import {
  type EmojiLimits,
  type EmojiTable,
  type EmojiUsage,
  reactionEmoji,
  renderEmoji,
  uncodeEmoji,
} from "./emoji.js";
import { PLATFORM, snowflake } from "./mapping.js";
import { renderReply } from "./render.js";
import { MAX_MESSAGE_LEN, splitMessage } from "./split.js";
import {
  renderStickers,
  type ServerSticker,
  type StickerLimits,
  type StickerTable,
  type StickerUsage,
} from "./stickers.js";

/** The slice of discord.js's `REST` the sink uses (so tests can fake it). */
export interface RestLike {
  post(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  put(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  /** Only `describe` reads; without it contexts have no names. */
  get?(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  /** Only `editCard` edits; without it cards stay as they were sent. */
  patch?(route: `/${string}`, options?: RestRequest): Promise<unknown>;
}

/** Discord's longest voice channel status. */
const MAX_VOICE_STATUS = 500;

function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("name" in value)) return null;
  return typeof value.name === "string" && value.name.trim() !== "" ? value.name : null;
}

/** A file of a multipart request (discord.js's `RawFile`). */
export interface RestFile {
  name: string;
  data: Uint8Array;
  contentType?: string;
}

export interface RestRequest {
  body?: unknown;
  files?: RestFile[];
  signal?: AbortSignal;
}

/** Discord's default upload limit for a bot without a boosted guild, in bytes (10 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Files one Discord message takes. */
export const MAX_MESSAGE_FILES = 10;

/** Discord JSON error codes that mean the upload itself was refused. */
const ENTITY_TOO_LARGE = 40005;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
/** Discord's code for a sticker it will not send ("Invalid sticker sent"). */
const INVALID_STICKER = 50081;
const STICKER_REFUSED: ReadonlySet<number> = new Set([
  INVALID_STICKER,
  MISSING_PERMISSIONS,
  MISSING_ACCESS,
]);

function discordCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

/** Outgoing attachments: where their bytes come from and how large one message's may be. */
export interface SinkAttachments {
  /** Looked up per message: the artifact store may be absent. */
  source(): AttachmentSource | undefined;
  /** Bytes of all files of one message together (`max_upload_bytes`). */
  maxBytes(): number;
}

export class DiscordSendError extends Error {
  override readonly name = "DiscordSendError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

function channelOf(context: ContextKey): string {
  if (context.platform !== PLATFORM) {
    throw new DiscordSendError(`context \`${contextKeyString(context)}\` is not a Discord context`);
  }
  return snowflake(context.channel, "channel");
}

/** Wraps a failure with where it happened, like anyhow's `.with_context`. */
async function inContext<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DiscordSendError(what, { cause: error });
  }
}

/**
 * An outgoing message the sender marks as unprompted (nobody addressed her). Such messages are
 * posted without a notification (`SUPPRESS_NOTIFICATIONS`), so she never pings people by
 * starting a conversation. The flag is optional so existing senders keep working.
 */
export type DiscordOutgoing = OutgoingMessage & { proactive?: boolean };

/** Server emoji in her messages and reactions (emoji.ts). */
export interface SinkEmoji {
  table: EmojiTable;
  usage: EmojiUsage;
  /** Read per message, so a config change applies at once; per server. */
  enabled(guild: string): boolean;
  limits(): EmojiLimits;
}

/** Server stickers in her messages (stickers.ts). */
export interface SinkStickers {
  table: StickerTable;
  usage: StickerUsage;
  /** Read per message, so a config change applies at once; per server. */
  enabled(guild: string): boolean;
  limits(): StickerLimits;
  /** Clock ms, for the cap per hour. */
  now(): number;
}

export class DiscordSink implements PlatformSink, ReplySink {
  readonly platform: PlatformId = PLATFORM;
  readonly #rest: RestLike;
  readonly #moderation: () => ModerationService | undefined;
  readonly #emoji: SinkEmoji | null;
  readonly #attachments: SinkAttachments | null;
  readonly #stickers: SinkStickers | null;

  /** `moderation`: looked up per message, it may come and go. */
  constructor(
    rest: RestLike,
    moderation: () => ModerationService | undefined = () => undefined,
    emoji: SinkEmoji | null = null,
    attachments: SinkAttachments | null = null,
    stickers: SinkStickers | null = null,
  ) {
    this.#rest = rest;
    this.#moderation = moderation;
    this.#emoji = emoji;
    this.#attachments = attachments;
    this.#stickers = stickers;
  }

  /**
   * `[貼圖: 名字]` taken out of the text; the one sticker that goes with the message, in guild
   * channels with stickers on and within the limits. Recorded per channel. A token that cannot
   * go is only taken out: it is never text for people.
   */
  #withStickers(
    context: ContextKey,
    text: string,
  ): { text: string; sticker: ServerSticker | null } {
    const stickers = this.#stickers;
    const guild = context.scope;
    const on = stickers !== null && guild !== null && stickers.enabled(guild);
    const now = stickers?.now() ?? 0;
    const rendered = renderStickers(
      text,
      on ? (name) => stickers.table.get(guild, name) : null,
      stickers?.usage.recent(context.channel) ?? [],
      on ? stickers.usage.sentInHour(context.channel, now) : 0,
      stickers?.limits() ?? { window_messages: 1, max_in_window: 0, per_hour: 0 },
    );
    if (on) stickers.usage.record(context.channel, rendered.sticker?.id ?? null, now);
    return rendered;
  }

  /** What one message's files may weigh together; `null` while nothing can resolve them. */
  attachmentLimit(context: ContextKey): number | null {
    if (context.platform !== PLATFORM) return null;
    const attachments = this.#attachments;
    if (attachments === null || attachments.source() === undefined) return null;
    const max = attachments.maxBytes();
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
  }

  /**
   * The files of a message, resolved now for `context`. Throws an `AttachmentError` when one may
   * not go there, or when together they are more than a message takes.
   */
  async #resolve(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<AttachmentFile[]> {
    const wanted = message.attachments ?? [];
    if (wanted.length === 0) return [];
    const limit = this.attachmentLimit(context);
    const source = this.#attachments?.source();
    if (limit === null || source === undefined) {
      throw new AttachmentError("unavailable", "attachments cannot be sent from here");
    }
    if (wanted.length > MAX_MESSAGE_FILES) {
      throw new AttachmentError(
        "too_many",
        `a Discord message takes at most ${MAX_MESSAGE_FILES} files`,
      );
    }
    const files: AttachmentFile[] = [];
    let left = limit;
    for (const { artifact_id } of wanted) {
      const file = await source.open(artifact_id, context, { maxBytes: left, signal });
      if (file.data.length > left) {
        throw new AttachmentError(
          "too_large",
          `the files are over the ${limit} bytes one message can carry there`,
        );
      }
      left -= file.data.length;
      files.push(file);
    }
    return files;
  }

  /** `:name:` → server emoji in guild channels, within the limits; recorded per channel. */
  #withEmoji(context: ContextKey, text: string): string {
    const emoji = this.#emoji;
    if (emoji === null || context.scope === null || !emoji.enabled(context.scope)) {
      return uncodeEmoji(text);
    }
    const guild = context.scope;
    const rendered = renderEmoji(
      text,
      (name) => emoji.table.get(guild, name),
      emoji.usage.recent(context.channel),
      emoji.limits(),
    );
    emoji.usage.record(context.channel, rendered.used);
    return rendered.text;
  }

  /**
   * Sends the text split into Discord-sized chunks. Only the first chunk replies to `reply_to`
   * (without pinging its author); its ref is returned.
   */
  async send(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<SentMessage> {
    const channel = channelOf(context);
    // Before anything is posted: a refused file stops the whole message.
    const files = await this.#resolve(context, message, signal);
    // Last line of defence: nothing moderation stops, no role / everyone / here mentions, no
    // secrets, whoever got this far.
    const safe = safeOutgoing(this.#moderation(), { path: "reply", text: message.text, context });
    const { text, sticker } = this.#withStickers(context, safe.text);
    const chunks = splitMessage(this.#withEmoji(context, text), MAX_MESSAGE_LEN);
    // Files alone make a message, and so does a sticker.
    if (chunks.length === 0 && (files.length > 0 || sticker !== null)) chunks.push("");
    if (chunks.length === 0) throw new DiscordSendError("cannot send an empty message");
    const last = chunks.length - 1;
    let reference: Record<string, unknown> | null = null;
    if (message.reply_to) {
      reference = {
        message_id: snowflake(message.reply_to.id, "message"),
        channel_id: channelOf(message.reply_to.context),
        fail_if_not_exists: false,
      };
    }
    const quiet = (message as DiscordOutgoing).proactive === true;
    let first: string | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const upload = index === 0 ? files : [];
      const body: Record<string, unknown> = {
        ...(chunk === "" ? {} : { content: chunk }),
        // Users may be pinged by name; never roles, @everyone or @here. Replying must not ping
        // the replied-to author.
        allowed_mentions: { parse: ["users"], roles: [], replied_user: false },
        ...(quiet ? { flags: MessageFlags.SuppressNotifications } : {}),
      };
      if (reference) {
        body.message_reference = reference;
        reference = null;
      }
      if (upload.length > 0) {
        body.attachments = upload.map((f, id) => ({ id, filename: f.filename }));
      }
      // The sticker comes under the words, as people send one.
      if (sticker !== null && index === last) body.sticker_ids = [sticker.id];
      const request: RestRequest = { body, signal };
      if (upload.length > 0) {
        request.files = upload.map((f) => ({
          name: f.filename,
          data: f.data,
          contentType: f.content_type,
        }));
      }
      const sent = await inContext(`sending message to ${contextKeyString(context)}`, async () => {
        const post = () => this.#rest.post(Routes.channelMessages(channel), request);
        try {
          try {
            return await post();
          } catch (error) {
            // Discord refused the sticker (gone since, or not allowed there): the words still go.
            const refused = STICKER_REFUSED.has(discordCode(error) ?? 0);
            if (body.sticker_ids === undefined || !refused) throw error;
            delete body.sticker_ids;
            if (chunk === "" && upload.length === 0) throw error;
            return await post();
          }
        } catch (error) {
          const code = discordCode(error);
          if (upload.length === 0) throw error;
          if (code === ENTITY_TOO_LARGE) {
            throw new AttachmentError("too_large", "Discord says the upload is too large", {
              cause: error,
            });
          }
          if (code === MISSING_PERMISSIONS || code === MISSING_ACCESS) {
            throw new AttachmentError("platform", "she may not attach files in that channel", {
              cause: error,
            });
          }
          throw error;
        }
      });
      first ??= messageId(sent);
    }
    const id = first as string;
    return safe.blocked === null ? { context, id } : { context, id, blocked: safe.blocked };
  }

  async react(message: MessageRef, emoji: string, signal?: AbortSignal): Promise<void> {
    const channel = channelOf(message.context);
    const id = snowflake(message.id, "message");
    const guild = message.context.scope;
    const table = this.#emoji?.table ?? null;
    const resolved = reactionEmoji(emoji, (name) =>
      table !== null && guild !== null ? table.get(guild, name) : undefined,
    );
    await inContext(
      `reacting to message ${message.id} in ${contextKeyString(message.context)}`,
      async () => {
        await this.#rest.put(
          Routes.channelMessageOwnReaction(channel, id, encodeURIComponent(resolved)),
          { signal },
        );
      },
    );
  }

  /** The voice channel's status line: filtered like `send`, at most 500 characters. */
  async setVoiceStatus(context: ContextKey, status: string, signal?: AbortSignal): Promise<void> {
    const channel = channelOf(context);
    const safe = safeOutgoing(this.#moderation(), { path: "aside", text: status, context });
    const text = [...safe.text.trim()].slice(0, MAX_VOICE_STATUS).join("");
    await inContext(`setting the voice status of ${contextKeyString(context)}`, async () => {
      await this.#rest.put(`/channels/${channel}/voice-status`, {
        body: { status: text },
        signal,
      });
    });
  }

  async typing(context: ContextKey, signal?: AbortSignal): Promise<void> {
    const channel = channelOf(context);
    await inContext(`typing in ${contextKeyString(context)}`, async () => {
      await this.#rest.post(Routes.channelTyping(channel), { signal });
    });
  }

  /** The DM channel with `account` (Discord creates it on first use and returns it after). */
  /** `<@id>` for Discord users (pinged: `allowed_mentions` lets users through). */
  mention(account: AccountRef): string | null {
    return account.platform === PLATFORM && /^[0-9]{1,20}$/.test(account.id)
      ? `<@${account.id}>`
      : null;
  }

  async openDm(account: AccountRef, signal?: AbortSignal): Promise<ContextKey> {
    if (account.platform !== PLATFORM) {
      throw new DiscordSendError(`account \`${account.platform}:${account.id}\` is not on Discord`);
    }
    const recipient = snowflake(account.id, "user");
    const channel = await inContext(`opening a DM with ${recipient}`, () =>
      this.#rest.post(Routes.userChannels(), { body: { recipient_id: recipient }, signal }),
    );
    return { platform: PLATFORM, scope: null, channel: messageId(channel), kind: "dm" };
  }

  /** `ReplySink`: a command-style card (Components V2, no pings) as a DM to `account`. */
  async sendDirect(
    account: AccountRef,
    reply: CommandReply,
    signal?: AbortSignal,
  ): Promise<MessageRef> {
    const context = await this.openDm(account, signal);
    const channel = channelOf(context);
    let first: string | null = null;
    for (const payload of renderReply(reply, false)) {
      const sent = await inContext(`sending a card to ${contextKeyString(context)}`, () =>
        this.#rest.post(Routes.channelMessages(channel), {
          body: {
            components: payload.components,
            flags: payload.flags,
            allowed_mentions: { parse: [] },
          },
          signal,
        }),
      );
      first ??= messageId(sent);
    }
    return { context, id: first as string };
  }

  /**
   * `ReplySink`: a command-style card (Components V2, no pings) into `context`, with the reply's
   * files (a picture the card shows) uploaded with it.
   */
  async sendCard(
    context: ContextKey,
    reply: CommandReply,
    signal?: AbortSignal,
  ): Promise<MessageRef> {
    if (context.platform !== PLATFORM) {
      throw new DiscordSendError(`context \`${contextKeyString(context)}\` is not on Discord`);
    }
    const channel = channelOf(context);
    let first: string | null = null;
    for (const payload of renderReply(reply, false)) {
      const files = payload.files ?? [];
      const body: Record<string, unknown> = {
        components: payload.components,
        flags: payload.flags,
        allowed_mentions: { parse: [] },
      };
      const request: RestRequest = { body, signal };
      if (files.length > 0) {
        body.attachments = files.map((f, id) => ({ id, filename: f.name }));
        request.files = files.map((f) => ({
          name: f.name,
          data: f.attachment,
          ...(f.contentType ? { contentType: f.contentType } : {}),
        }));
      }
      const sent = await inContext(`sending a card to ${contextKeyString(context)}`, () =>
        this.#rest.post(Routes.channelMessages(channel), request),
      );
      first ??= messageId(sent);
    }
    return { context, id: first as string };
  }

  /**
   * `ReplySink`: replaces a card sent with `sendCard` (the first message of it) with `reply`'s
   * first part, no pings. Without `patch` on the REST client it throws.
   */
  async editCard(message: MessageRef, reply: CommandReply, signal?: AbortSignal): Promise<void> {
    const patch = this.#rest.patch?.bind(this.#rest);
    if (message.context.platform !== PLATFORM) {
      throw new DiscordSendError(
        `context \`${contextKeyString(message.context)}\` is not on Discord`,
      );
    }
    if (!patch) throw new DiscordSendError("this client cannot edit messages");
    const [payload] = renderReply(reply, false);
    if (payload === undefined) return;
    const channel = channelOf(message.context);
    await inContext(`editing a card in ${contextKeyString(message.context)}`, () =>
      patch(Routes.channelMessage(channel, snowflake(message.id, "message")), {
        body: {
          components: payload.components,
          flags: payload.flags,
          allowed_mentions: { parse: [] },
        },
        signal,
      }),
    );
  }

  /** `"<server> / <channel>"` (just the channel name in DMs); `null` when Discord won't say. */
  async describe(context: ContextKey, signal?: AbortSignal): Promise<string | null> {
    const get = this.#rest.get?.bind(this.#rest);
    if (!get || context.platform !== PLATFORM) return null;
    try {
      const channel = nameOf(
        await get(Routes.channel(snowflake(context.channel, "channel")), { signal }),
      );
      if (context.scope === null) return channel;
      const guild = nameOf(await get(Routes.guild(snowflake(context.scope, "guild")), { signal }));
      if (guild === null) return channel;
      return channel === null ? guild : `${guild} / ${channel}`;
    } catch {
      return null;
    }
  }
}

function messageId(sent: unknown): string {
  if (typeof sent === "object" && sent !== null && "id" in sent && typeof sent.id === "string") {
    return sent.id;
  }
  throw new DiscordSendError("Discord returned a message without an id");
}
