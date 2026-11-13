// `PlatformHistory` for Discord: earlier messages of a channel (`channel.messages.fetch`), for
// sessions that start cold and for reply parents she never saw. The bot needs Read Message
// History in the channel; without it the fetch fails and the agent goes on without.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type {
  ContextKey,
  HistoryQuery,
  IncomingMessage,
  MessageRef,
  PlatformHistory,
  PlatformId,
  QuotedMessage,
} from "@miyoria/types";
import { MessageType } from "discord.js";
import {
  displayName,
  hasContent,
  incomingMessage,
  type MentionsLike,
  type MessageLike,
  PLATFORM,
  quotedMessage,
  type UserLike,
} from "./mapping.js";

const log = getLogger("discord.history");

/** Discord returns at most this many messages per request. */
export const MAX_FETCH = 100;

/** A fetched message: a `MessageLike` with its type and the replied-to author. */
export interface FetchedLike extends MessageLike {
  type: number;
  mentions: MentionsLike & { repliedUser?: { id: string } | null };
}

/** `Collection`-like result of a list fetch. */
interface FetchedList {
  values(): Iterable<FetchedLike>;
}

/** The parts of a text-based channel's `MessageManager` used here. */
export interface MessageManagerLike {
  /** A message id fetches one message; options fetch a list (newest first). */
  fetch(
    options: string | { limit: number; before?: string; after?: string },
  ): Promise<FetchedLike | FetchedList>;
  cache: { get(id: string): FetchedLike | undefined };
}

/** The parts of a discord.js `Client` used here. */
export interface HistoryClientLike {
  channels: { fetch(id: string): Promise<unknown> };
  /** Names for mentions a message's own data lacks (her cards are sent without pings). */
  users?: { cache: { get(id: string): UserLike | undefined } };
}

function isList(value: FetchedLike | FetchedList): value is FetchedList {
  return typeof (value as Partial<FetchedList>).values === "function";
}

/** Messages a person wrote (not joins, pins, boosts...). */
function readable(m: FetchedLike): boolean {
  return (m.type === MessageType.Default || m.type === MessageType.Reply) && hasContent(m);
}

/**
 * A message someone replied to: also the answer to a slash command (her cards, a receipt), which
 * people reply to like any message.
 */
function readableParent(m: FetchedLike): boolean {
  return (
    readable(m) ||
    ((m.type === MessageType.ChatInputCommand || m.type === MessageType.ContextMenuCommand) &&
      hasContent(m))
  );
}

export class DiscordHistory implements PlatformHistory {
  readonly platform: PlatformId = PLATFORM;

  constructor(
    private readonly client: HistoryClientLike,
    private readonly selfIds: ReadonlySet<string>,
  ) {}

  async recent(
    context: ContextKey,
    query: HistoryQuery,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    const limit = Math.min(Math.max(Math.trunc(query.limit), 0), MAX_FETCH);
    if (limit === 0) return [];
    const manager = await this.#manager(context.channel);
    signal?.throwIfAborted();
    if (manager === null) return [];
    const result = await manager.fetch(
      query.after != null
        ? { limit, after: query.after }
        : query.before === null
          ? { limit }
          : { limit, before: query.before },
    );
    signal?.throwIfAborted();
    if (!isList(result)) return [];
    return [...result.values()]
      .filter(readable)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => this.#map(m, context, manager));
  }

  async fetch(ref: MessageRef, signal?: AbortSignal): Promise<IncomingMessage | null> {
    const manager = await this.#manager(ref.context.channel);
    signal?.throwIfAborted();
    if (manager === null) return null;
    let found: FetchedLike | FetchedList;
    try {
      found = manager.cache.get(ref.id) ?? (await manager.fetch(ref.id));
    } catch (error) {
      // Why a reply came without the line it answers (docs/design/backlog.md): say it.
      log.warn(
        { channel: ref.context.channel, message: ref.id, error: errorMessage(error) },
        "cannot fetch the replied-to message",
      );
      return null;
    }
    signal?.throwIfAborted();
    if (isList(found)) return null;
    if (!readableParent(found)) {
      log.info({ message: ref.id, type: found.type }, "the replied-to message has nothing to read");
      return null;
    }
    return this.#map(found, ref.context, manager);
  }

  /** The channel's message manager; `null` if it is not a text channel or unreadable. */
  async #manager(channel: string): Promise<MessageManagerLike | null> {
    let fetched: unknown;
    try {
      fetched = await this.client.channels.fetch(channel);
    } catch (error) {
      log.debug({ channel, error: errorMessage(error) }, "cannot fetch channel for history");
      return null;
    }
    const messages = (fetched as { messages?: MessageManagerLike } | null)?.messages;
    return messages && typeof messages.fetch === "function" ? messages : null;
  }

  #map(m: FetchedLike, context: ContextKey, manager: MessageManagerLike): IncomingMessage {
    const parentId = m.reference?.messageId ?? null;
    const parent = parentId === null ? undefined : manager.cache.get(parentId);
    let referenced: QuotedMessage | null = null;
    if (parent) {
      try {
        referenced = quotedMessage(parent);
      } catch {
        referenced = null;
      }
    }
    const repliedAuthor = m.mentions.repliedUser?.id ?? parent?.author.id ?? null;
    const users = this.client.users?.cache;
    const names =
      users === undefined
        ? null
        : (id: string) => {
            const user = users.get(id);
            return user === undefined ? null : displayName(user);
          };
    return incomingMessage(m, context.kind, this.selfIds, repliedAuthor, referenced, names);
  }
}
