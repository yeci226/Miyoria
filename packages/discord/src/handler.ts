// Gateway event handling: messages, typing, readiness, interactions, and presence / voice state /
// member changes for the `world` module (presence.ts).

import {
  type CommandRegistry,
  PanelSessions,
  ReplySinkKey,
  UserResolverKey,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/kernel";
import {
  type AccountRef,
  type ContextKind,
  customEvent,
  type JsonValue,
  ModerationKey,
  type PlatformHistories,
  type PlatformSinks,
  PresencePrivacyKey,
  type QuotedMessage,
  REACTION_TOPIC,
  type ReactionEvent,
  toTimestamp,
} from "@miyoria/types";
import {
  type ChannelType,
  type Client,
  Events,
  type Interaction,
  type Message,
  MessageType,
  Routes,
} from "discord.js";
import type { DiscordConfig } from "./config.js";
import { type EmojiLike, EmojiTable, EmojiUsage, serverEmoji } from "./emoji.js";
import { ambientChannel, messageAllowed } from "./gate.js";
import { DiscordHistory, type HistoryClientLike } from "./history.js";
import {
  type ContextMenuInteractionLike,
  handleAutocomplete,
  handleCommandInteraction,
  handleComponentInteraction,
  handleContextMenuInteraction,
  type InteractionEnv,
} from "./interaction.js";
import {
  account,
  componentsText,
  contextKey,
  displayName,
  hasContent,
  incomingMessage,
  kindOf,
  type MentionsLike,
  type MessageLike,
  mentionNames,
  PLATFORM,
  quotedMessage,
  type UserLike,
  type UserNames,
  unnamedUsers,
} from "./mapping.js";
import {
  type GuildMemberLike,
  memberEvent,
  memberUpdate,
  type PresenceLike,
  presenceEvent,
  presenceUpdate,
  type VoiceStateLike,
  voiceStateEvent,
  voiceStateUpdate,
} from "./presence.js";
import { DiscordUserResolver, type ResolverClientLike } from "./resolver.js";
import { DiscordSink } from "./sink.js";
import { runSyncLoop, syncRunner } from "./sync.js";

const log = getLogger("discord.handler");

const MAX_KIND_CACHE = 10_000;

/** The parts of a discord.js `Guild` the presence snapshot reads. */
export interface GuildLike {
  id: string;
  members: {
    fetch(): Promise<unknown>;
    cache: { values(): Iterable<GuildMemberLike> };
  };
  presences: { cache: { values(): Iterable<PresenceLike> } };
  voiceStates: { cache: { values(): Iterable<VoiceStateLike> } };
  /** Custom emoji (the server emoji table). */
  emojis?: { cache: { values(): Iterable<EmojiLike> } };
}

/** The parts of a discord.js `MessageReaction` the bridge reads. */
export interface ReactionLike {
  emoji: { name: string | null; id: string | null };
  message: { id: string; channelId: string; guildId: string | null };
}

/** State shared by the gateway handler and the module. */
export class Shared {
  /** The bot account plus every configured self account. */
  readonly selfIds: Set<string>;
  ready = false;
  #syncStarted = false;
  readonly #kinds = new Map<string, ContextKind>();
  /** Custom emoji of every guild she is in, and what she used per channel. */
  readonly emoji = new EmojiTable();
  readonly emojiUsage = new EmojiUsage();
  /** Messages with live controls (panels). */
  readonly sessions = new PanelSessions({
    onError: (error) => log.debug({ error: errorMessage(error) }, "cannot disable a panel"),
  });

  constructor(
    readonly config: DiscordConfig,
    selfIds: Iterable<string>,
    readonly registry: CommandRegistry,
    readonly sinks: PlatformSinks | null,
    /** Where the message history reader is registered once connected. */
    readonly histories: PlatformHistories | null = null,
  ) {
    this.selfIds = new Set(selfIds);
  }

  /** `true` the first time, so the sync task starts once per module run. */
  claimSync(): boolean {
    if (this.#syncStarted) return false;
    this.#syncStarted = true;
    return true;
  }

  kind(channel: string): ContextKind | undefined {
    return this.#kinds.get(channel);
  }

  rememberKind(channel: string, kind: ContextKind): void {
    if (this.#kinds.size >= MAX_KIND_CACHE) this.#kinds.clear();
    this.#kinds.set(channel, kind);
  }
}

/** Connects a discord.js `Client` to the event bus and the command registry. */
export class GatewayBridge {
  constructor(
    private readonly ctx: ModuleContext,
    private readonly shared: Shared,
  ) {}

  /** Registers all gateway listeners. Listener errors are logged, never thrown. */
  attach(client: Client): void {
    client.on(Events.ClientReady, (ready) => this.guard("ready", () => this.onReady(ready)));
    client.on(Events.MessageCreate, (msg) =>
      this.guard("message", () => this.onMessage(client, msg)),
    );
    client.on(Events.TypingStart, (typing) =>
      this.guard("typing", async () => {
        const parent = (typing.channel as { parentId?: string | null }).parentId ?? null;
        // Typing in a channel she may not follow is not published either.
        if (
          typing.guild &&
          !ambientChannel(this.shared.config, { channel: typing.channel.id, parent })
        ) {
          return;
        }
        const kind = await this.channelKind(
          client,
          typing.guild?.id ?? null,
          typing.channel.id,
          typing.channel.type,
        );
        this.ctx.publish({
          type: "platform_typing",
          data: {
            context: contextKey(typing.guild?.id ?? null, typing.channel.id, kind),
            account: account(typing.user.id),
          },
        });
      }),
    );
    client.on(Events.MessageReactionAdd, (reaction, user) =>
      this.guard("reaction", () => this.onReaction(client, reaction, user, true)),
    );
    client.on(Events.MessageReactionRemove, (reaction, user) =>
      this.guard("reaction", () => this.onReaction(client, reaction, user, false)),
    );
    client.on(Events.ThreadCreate, (thread) => {
      this.shared.rememberKind(thread.id, kindOf(thread.type));
    });
    client.on(Events.InteractionCreate, (interaction) => {
      this.guard("interaction", () => this.onInteraction(client, interaction));
    });
    client.on(Events.PresenceUpdate, (_old, presence) =>
      this.guard("presence", () => this.onPresence(presence, false)),
    );
    client.on(Events.VoiceStateUpdate, (_old, state) =>
      this.guard("voice state", () => this.onVoiceState(state, false)),
    );
    client.on(Events.GuildMemberAdd, (member) =>
      this.guard("member", () => this.onMember(member, false)),
    );
    client.on(Events.GuildMemberUpdate, (_old, member) =>
      this.guard("member", () => this.onMember(member, false)),
    );
    client.on(Events.GuildMemberRemove, (member) =>
      this.guard("member", () => this.onMember(member, true)),
    );
    client.on(Events.GuildCreate, (guild) =>
      this.guard("guild snapshot", () => this.snapshotGuild(guild as unknown as GuildLike)),
    );
    client.on(Events.GuildDelete, (guild) => this.shared.emoji.dropGuild(guild.id));
    client.on(Events.GuildEmojiCreate, (emoji) => this.onEmoji(emoji.guild.id, emoji, false));
    client.on(Events.GuildEmojiUpdate, (_old, emoji) => this.onEmoji(emoji.guild.id, emoji, false));
    client.on(Events.GuildEmojiDelete, (emoji) => this.onEmoji(emoji.guild.id, emoji, true));
  }

  /** A custom emoji added, changed or removed. */
  onEmoji(guild: string, emoji: EmojiLike, removed: boolean): void {
    if (removed) {
      if (emoji.id) this.shared.emoji.remove(guild, emoji.id);
      return;
    }
    const e = serverEmoji(emoji);
    if (e) this.shared.emoji.upsert(guild, e);
  }

  /**
   * Publishes everyone the gateway cache knows in `guild` (members, presences, voice states) as
   * `initial` updates, after fetching the member list when the members intent is on.
   */
  async snapshotGuild(guild: GuildLike): Promise<void> {
    if (guild.emojis) {
      const list = [...guild.emojis.cache.values()].map(serverEmoji).filter((e) => e !== null);
      this.shared.emoji.setGuild(guild.id, list);
    }
    if (this.shared.config.presence_intents) {
      try {
        await guild.members.fetch();
      } catch (error) {
        log.debug({ guild: guild.id, error: errorMessage(error) }, "cannot fetch guild members");
      }
      for (const member of guild.members.cache.values()) this.onMember(member, false);
      for (const presence of guild.presences.cache.values()) this.onPresence(presence, true);
    }
    for (const state of guild.voiceStates.cache.values()) this.onVoiceState(state, true);
  }

  /** Presence is only published for people who did not opt out (fails closed without `world`). */
  presenceAllowed(who: AccountRef): boolean {
    if (this.shared.selfIds.has(who.id)) return false;
    return this.ctx.services.get(PresencePrivacyKey)?.presenceAllowed(who) ?? false;
  }

  onPresence(presence: PresenceLike, initial: boolean): void {
    const update = presenceUpdate(presence, initial);
    if (update === null || !this.presenceAllowed(update.account)) return;
    this.ctx.publish(presenceEvent(update));
  }

  /** A reaction added or removed (`platform.reaction`; feedback on her messages). */
  async onReaction(
    client: Client,
    reaction: ReactionLike,
    user: { id: string; bot?: boolean | null; username?: string | null },
    added: boolean,
  ): Promise<void> {
    if (this.shared.selfIds.has(user.id) || user.bot) return;
    const message = reaction.message;
    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? "";
    if (emoji === "") return;
    const kind = await this.channelKind(client, message.guildId ?? null, message.channelId);
    const event: ReactionEvent = {
      message: {
        context: contextKey(message.guildId ?? null, message.channelId, kind),
        id: message.id,
      },
      account: account(user.id),
      display_name: user.username ?? null,
      emoji,
      added,
      at: toTimestamp(Date.now()),
    };
    this.ctx.publish(customEvent(REACTION_TOPIC, event as unknown as JsonValue));
  }

  onVoiceState(state: VoiceStateLike, initial: boolean): void {
    this.ctx.publish(voiceStateEvent(voiceStateUpdate(state, initial)));
  }

  onMember(member: GuildMemberLike, left: boolean): void {
    this.ctx.publish(memberEvent(memberUpdate(member, left)));
  }

  /** The handlers' shared environment. */
  env(client: Client): InteractionEnv {
    return {
      registry: this.shared.registry,
      sessions: this.shared.sessions,
      editChannelMessage: async (channel, message, payload) => {
        await client.rest.patch(Routes.channelMessage(channel, message), {
          body: {
            components: payload.components,
            flags: payload.flags,
            allowed_mentions: { parse: [] },
          },
        });
      },
    };
  }

  /** Slash commands, autocomplete, buttons, select menus and modal submissions. */
  private async onInteraction(client: Client, interaction: Interaction): Promise<void> {
    const kindOfInteraction = async (): Promise<ContextKind> => {
      if (interaction.guildId === null) return "dm";
      if (interaction.channel) return kindOf(interaction.channel.type);
      return this.channelKind(client, interaction.guildId, interaction.channelId ?? "");
    };
    if (interaction.isChatInputCommand()) {
      const kind = await kindOfInteraction();
      await handleCommandInteraction(this.env(client), interaction, kind);
    } else if (interaction.isContextMenuCommand()) {
      const kind = await kindOfInteraction();
      await handleContextMenuInteraction(
        this.env(client),
        interaction as unknown as ContextMenuInteractionLike,
        kind,
      );
    } else if (interaction.isAutocomplete()) {
      const kind = await kindOfInteraction();
      await handleAutocomplete(this.env(client), interaction, kind);
    } else if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit()
    ) {
      const kind = await kindOfInteraction();
      await handleComponentInteraction(this.env(client), interaction, kind);
    }
  }

  /** Runs a listener body; failures are logged and never escape into discord.js. */
  private guard(what: string, body: () => void | Promise<void>): void {
    // Fire and forget: discord.js does not await listeners, and an escaping rejection would
    // crash the process.
    void Promise.resolve()
      .then(body)
      .catch((error: unknown) => {
        log.warn({ handler: what, error: errorMessage(error) }, "gateway handler failed");
      });
  }

  private onReady(client: Client<true>): void {
    const bot = client.user.id;
    log.info(
      { user: client.user.username, id: bot, guilds: client.guilds.cache.size },
      "discord bot ready",
    );
    // The bot account first, then her other accounts in id order.
    this.shared.selfIds.add(bot);
    const others = [...this.shared.selfIds]
      .filter((id) => id !== bot)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    for (const id of [bot, ...others]) {
      this.ctx.publish({
        type: "platform_ready",
        data: { platform: PLATFORM, self_account: account(id) },
      });
    }
    const emojiConfig = this.shared.config.emoji;
    const sink = new DiscordSink(client.rest, () => this.ctx.services.get(ModerationKey), {
      table: this.shared.emoji,
      usage: this.shared.emojiUsage,
      enabled: () => emojiConfig.enabled,
      limits: () => emojiConfig,
    });
    this.shared.sinks?.register(sink);
    this.shared.histories?.register(
      new DiscordHistory(client as unknown as HistoryClientLike, this.shared.selfIds),
    );
    // Cards outside interactions (the gate's approval requests to the owners).
    this.ctx.provide(ReplySinkKey, sink);
    // Roles of people named in panel controls (see `resolver.ts`).
    this.ctx.provide(
      UserResolverKey,
      new DiscordUserResolver(client as unknown as ResolverClientLike),
    );
    this.shared.ready = true;
    for (const guild of client.guilds.cache.values()) {
      this.guard("guild snapshot", () => this.snapshotGuild(guild as unknown as GuildLike));
    }

    if (this.shared.claimSync()) {
      const { registry, config } = this.shared;
      this.ctx.spawn("command-sync", (signal) =>
        runSyncLoop({
          registry,
          signal,
          sync: syncRunner({
            rest: client.rest,
            applicationId: client.application.id,
            registry,
            commandGuilds: config.command_guilds,
            // Once per run the sync clears the scope not in use (stale duplicates).
            guilds: () => [...client.guilds.cache.keys()],
            signal,
          }),
        }),
      );
    }
  }

  private async onMessage(client: Client, msg: Message): Promise<void> {
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;
    // Sticker-, embed- and forward-only messages count too.
    if (!hasContent(msg as unknown as MessageLike)) return;
    const kind = await this.channelKind(client, msg.guildId, msg.channelId, msg.channel?.type);
    const parent = await repliedMessage(msg);
    const names = await userNamesOf(client, msg, this.shared.selfIds.has(msg.author.id));
    const data = incomingMessage(
      msg as unknown as MessageLike,
      kind,
      this.shared.selfIds,
      parent?.author?.id ?? null,
      quoted(parent),
      names,
    );
    const ids = {
      channel: msg.channelId,
      parent: (msg.channel as { parentId?: string | null } | null)?.parentId ?? null,
    };
    // Ambient chat in channels she was not given never reaches her (see `gate.ts`).
    if (!messageAllowed(this.shared.config, data, msg.guildId, ids, this.shared.selfIds)) return;
    this.ctx.publish({ type: "platform_message_created", data });
  }

  /** Channel / thread / DM, from the event itself, a memo, the gateway cache or REST. */
  private async channelKind(
    client: Client,
    guild: string | null,
    channel: string,
    known?: ChannelType,
  ): Promise<ContextKind> {
    if (guild === null) return "dm";
    const remembered = this.shared.kind(channel);
    if (remembered) return remembered;
    let type = known ?? client.channels.cache.get(channel)?.type;
    if (type === undefined) {
      try {
        type = (await client.channels.fetch(channel))?.type;
      } catch (error) {
        log.debug({ channel, error: errorMessage(error) }, "cannot resolve channel kind");
        return "channel";
      }
    }
    const kind = type === undefined ? "channel" : kindOf(type);
    this.shared.rememberKind(channel, kind);
    return kind;
  }
}

/** The parts of the replied-to message the handler reads (it may come back partial). */
type ParentLike = Partial<MessageLike> & { author?: { id: string } | null };

/** The message `msg` replies to (cache first, then one REST call). */
async function repliedMessage(msg: Message): Promise<ParentLike | null> {
  const ref = msg.reference?.messageId;
  if (msg.type !== MessageType.Reply || !ref) return null;
  const cached = msg.channel.messages.cache.get(ref);
  if (cached) return cached as unknown as ParentLike;
  try {
    return (await msg.fetchReference()) as unknown as ParentLike;
  } catch (error) {
    log.debug({ message: msg.id, error: errorMessage(error) }, "cannot fetch replied message");
    return null;
  }
}

/** At most this many people's names are looked up for one message. */
const MAX_NAME_LOOKUPS = 5;

/**
 * Names of the people `msg` mentions that its mention data lacks. Her cards are sent without
 * pings (`allowed_mentions: { parse: [] }`), so Discord lists nobody: a receipt read 「@某人」
 * (2026-11-11). The member and user caches first; for her own messages one member fetch each,
 * as a receipt names one or two people. `null`: nothing is missing.
 */
async function userNamesOf(client: Client, msg: Message, self: boolean): Promise<UserNames | null> {
  const text = msg.content.trim() === "" ? componentsText(msg.components) : msg.content;
  const missing = unnamedUsers(text, mentionNames(msg.mentions as unknown as MentionsLike));
  if (missing.length === 0) return null;
  const names = new Map<string, string>();
  for (const id of missing.slice(0, MAX_NAME_LOOKUPS)) {
    let member = msg.guild?.members.cache.get(id) ?? null;
    if (member === null && self && msg.guild) {
      try {
        member = await msg.guild.members.fetch(id);
      } catch (error) {
        log.debug({ user: id, error: errorMessage(error) }, "cannot fetch a mentioned member");
      }
    }
    const user = member?.user ?? client.users.cache.get(id) ?? null;
    if (user !== null) {
      names.set(id, displayName(user as unknown as UserLike, member?.nickname ?? null));
    }
  }
  return (id) => names.get(id) ?? null;
}

/** The replied-to message as a quote, if it came with enough to read. */
function quoted(parent: ParentLike | null): QuotedMessage | null {
  if (parent === null || typeof parent.content !== "string" || !parent.author) return null;
  try {
    return quotedMessage(parent as MessageLike);
  } catch (error) {
    log.debug({ error: errorMessage(error) }, "cannot read replied message");
    return null;
  }
}
