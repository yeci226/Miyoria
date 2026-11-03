// `DiscordSink`: executes output actions through the bot account's REST client.

import type { CommandReply, ReplySink } from "@miyoria/commands";
import {
  type AccountRef,
  type ContextKey,
  contextKeyString,
  filterOutgoing,
  type MessageRef,
  type OutgoingMessage,
  type PlatformId,
  type PlatformSink,
} from "@miyoria/types";
import { Routes } from "discord.js";
import { PLATFORM, snowflake } from "./mapping.js";
import { renderReply } from "./render.js";
import { MAX_MESSAGE_LEN, splitMessage } from "./split.js";

/** The slice of discord.js's `REST` the sink uses (so tests can fake it). */
export interface RestLike {
  post(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  put(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  /** Only `describe` reads; without it contexts have no names. */
  get?(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  /** Only `edit` uses it; without it messages cannot be edited. */
  patch?(route: `/${string}`, options?: RestRequest): Promise<unknown>;
  /** Only `delete` uses it; without it messages cannot be deleted. */
  delete?(route: `/${string}`, options?: RestRequest): Promise<unknown>;
}

/** Discord's longest voice channel status. */
const MAX_VOICE_STATUS = 500;

function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("name" in value)) return null;
  return typeof value.name === "string" && value.name.trim() !== "" ? value.name : null;
}

export interface RestRequest {
  body?: unknown;
  signal?: AbortSignal;
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

export class DiscordSink implements PlatformSink, ReplySink {
  readonly platform: PlatformId = PLATFORM;
  readonly #rest: RestLike;

  constructor(rest: RestLike) {
    this.#rest = rest;
  }

  /**
   * Sends the text split into Discord-sized chunks. Only the first chunk replies to `reply_to`
   * (without pinging its author); its ref is returned.
   */
  async send(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<MessageRef> {
    const channel = channelOf(context);
    // Last line of defence: no role / everyone / here mentions, no secrets.
    const chunks = splitMessage(filterOutgoing(message.text), MAX_MESSAGE_LEN);
    if (chunks.length === 0) throw new DiscordSendError("cannot send an empty message");
    let reference: Record<string, unknown> | null = null;
    if (message.reply_to) {
      reference = {
        message_id: snowflake(message.reply_to.id, "message"),
        channel_id: channelOf(message.reply_to.context),
        fail_if_not_exists: false,
      };
    }
    let first: string | null = null;
    for (const chunk of chunks) {
      const body: Record<string, unknown> = {
        content: chunk,
        // Users may be pinged by name; never roles, @everyone or @here. Replying must not ping
        // the replied-to author.
        allowed_mentions: { parse: ["users"], roles: [], replied_user: false },
      };
      if (reference) {
        body.message_reference = reference;
        reference = null;
      }
      const sent = await inContext(`sending message to ${contextKeyString(context)}`, () =>
        this.#rest.post(Routes.channelMessages(channel), { body, signal }),
      );
      first ??= messageId(sent);
    }
    return { context, id: first as string };
  }

  async react(message: MessageRef, emoji: string, signal?: AbortSignal): Promise<void> {
    const channel = channelOf(message.context);
    const id = snowflake(message.id, "message");
    await inContext(
      `reacting to message ${message.id} in ${contextKeyString(message.context)}`,
      async () => {
        await this.#rest.put(
          Routes.channelMessageOwnReaction(channel, id, encodeURIComponent(emoji)),
          { signal },
        );
      },
    );
  }

  /** New text for one of her messages: filtered like `send`, one message long, no pings at all. */
  async edit(message: MessageRef, text: string, signal?: AbortSignal): Promise<void> {
    const patch = this.#rest.patch?.bind(this.#rest);
    if (!patch) throw new DiscordSendError("this REST client cannot edit messages");
    const channel = channelOf(message.context);
    const id = snowflake(message.id, "message");
    const content = filterOutgoing(text).slice(0, MAX_MESSAGE_LEN);
    await inContext(
      `editing message ${message.id} in ${contextKeyString(message.context)}`,
      async () => {
        await patch(Routes.channelMessage(channel, id), {
          body: { content, allowed_mentions: { parse: [] } },
          signal,
        });
      },
    );
  }

  async delete(message: MessageRef, signal?: AbortSignal): Promise<void> {
    const del = this.#rest.delete?.bind(this.#rest);
    if (!del) throw new DiscordSendError("this REST client cannot delete messages");
    const channel = channelOf(message.context);
    const id = snowflake(message.id, "message");
    await inContext(
      `deleting message ${message.id} in ${contextKeyString(message.context)}`,
      async () => {
        await del(Routes.channelMessage(channel, id), { signal });
      },
    );
  }

  /** The voice channel's status line: filtered like `send`, at most 500 characters. */
  async setVoiceStatus(context: ContextKey, status: string, signal?: AbortSignal): Promise<void> {
    const channel = channelOf(context);
    const text = [...filterOutgoing(status).trim()].slice(0, MAX_VOICE_STATUS).join("");
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
