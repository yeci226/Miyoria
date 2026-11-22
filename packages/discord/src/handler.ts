// Gateway event handling: messages, typing, readiness, interactions, and presence / voice state /
// member changes for the `world` module (presence.ts).

import {
  type CommandRegistry,
  PanelSessions,
  ReplySinkKey,
  UserResolverKey,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  AttachmentSourceKey,
  Events as BusEvents,
  type ContextKind,
  ModerationKey,
  PlacesKey,
  type PlatformHistories,
  type PlatformSinks,
  PresencePrivacyKey,
  type QuotedMessage,
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
import { allGuilds, type DiscordConfig } from "./config.js";
import { type EmojiLike, EmojiTable, EmojiUsage, serverEmoji } from "./emoji.js";
import {
  type Ambient,
  type AmbientPlaces,
  ambientChannel,
  ambientFor,
  type ChannelIds,
  messageAllowed,
  perGuild,
} from "./gate.js";
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
  memberNick,
  mentionNames,
  PLATFORM,
  quotedMessage,
  type UserLike,
  type UserNames,
  unnamedUsers,
} from "./mapping.js";
import {
  type GuildMemberLike,
  memberUpdate,
  type PresenceLike,
  presenceUpdate,
  type VoiceStateLike,
  voiceStateUpdate,
} from "./presence.js";
import { DiscordUserResolver, type ResolverClientLike } from "./resolver.js";
import { DiscordSink } from "./sink.js";
import {
  type ServerSticker,
  type StickerSourceLike,
  StickerTable,
  StickerUsage,
  serverSticker,
} from "./stickers.js";
import { runSyncLoop, syncRunner } from "./sync.js";

const log = getLogger("discord.handler");

const MAX_KIND_CACHE = 10_000;

/** The parts of a discord.js `Guild` the presence snapshot reads. */
export interface GuildLike {
  id: string;
  /** The server's name, when the gateway gave it. */
  name?: string | null;
  members: {
    fetch(): Promise<unknown>;
    cache: { values(): Iterable<GuildMemberLike> };
  };
  presences: { cache: { values(): Iterable<PresenceLike> } };
  voiceStates: { cache: { values(): Iterable<VoiceStateLike> } };
  /** Custom emoji (the server emoji table). */
  emojis?: { cache: { values(): Iterable<EmojiLike> } };
  /** Stickers (the server sticker table). */
  stickers?: { cache: { values(): Iterable<StickerSourceLike> } };
}

/** What `GuildDelete` says beyond the id: `available: false` is an outage, not a leave. */
export interface LeftLike {
  available?: boolean;
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
  /** Stickers of every guild she is in, and what she sent per channel. */
  readonly stickers = new StickerTable();
  readonly stickerUsage = new StickerUsage();
  /** Messages with live controls (panels). */
  readonly sessions = new PanelSessions({
    onError: (error) => log.debug({ error: errorMessage(error) }, "cannot disable a panel"),
  });

  /**
   * Syncs the slash commands once more (`command_guilds = ["*"]`: a guild she joined gets them);
   * set when the sync task starts.
   */
  syncAgain: (() => void) | null = null;

  constructor(
    readonly config: DiscordConfig,
    selfIds: Iterable<string>,
    readonly registry: CommandRegistry,
    readonly sinks: PlatformSinks | null,
    /** Where the message history reader is registered once connected. */
    readonly histories: PlatformHistories | null = null,
    /** The module's config per server and room; `null`: the cluster's everywhere. */
    readonly places: AmbientPlaces | null = null,
  ) {
    this.selfIds = new Set(selfIds);
  }

  /** The gate's rules for a room of `guild` (docs/design/v5-places.md). */
  ambient(guild: string, ids: ChannelIds): Ambient {
    try {
      return ambientFor(this.config, this.places, guild, ids);
    } catch (error) {
      log.warn(
        { guild, error: errorMessage(error) },
        "cannot read the server's gate; it stays closed",
      );
      return { ambient_text: "allowlist", ambient_channels: [], ambient_follow: null };
    }
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
        const ids = { channel: typing.channel.id, parent };
        if (typing.guild && !ambientChannel(this.shared.ambient(typing.guild.id, ids), ids)) {
          return;
        }
        const kind = await this.channelKind(
          client,
          typing.guild?.id ?? null,
          typing.channel.id,
          typing.channel.type,
        );
        this.ctx.publish(BusEvents.PlatformTyping, {
          context: contextKey(typing.guild?.id ?? null, typing.channel.id, kind),
          account: account(typing.user.id),
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
    client.on(Events.VoiceStateUpdate, (old, state) =>
      this.guard("voice state", () => this.onVoiceState(state, false, old)),
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
      this.guard("guild snapshot", () => this.joined(guild as unknown as GuildLike)),
    );
    // At once, like the emoji events: what she may use there goes with the server.
    client.on(Events.GuildDelete, (guild) => this.left(guild as unknown as GuildLike & LeftLike));
    client.on(Events.GuildEmojiCreate, (emoji) => this.onEmoji(emoji.guild.id, emoji, false));
    client.on(Events.GuildEmojiUpdate, (_old, emoji) => this.onEmoji(emoji.guild.id, emoji, false));
    client.on(Events.GuildEmojiDelete, (emoji) => this.onEmoji(emoji.guild.id, emoji, true));
    client.on(Events.GuildStickerCreate, (sticker) =>
      this.onSticker(sticker.guildId, sticker, false),
    );
    client.on(Events.GuildStickerUpdate, (_old, sticker) =>
      this.onSticker(sticker.guildId, sticker, false),
    );
    client.on(Events.GuildStickerDelete, (sticker) =>
      this.onSticker(sticker.guildId, sticker, true),
    );
  }

  /** A sticker added, changed or removed (only a guild's own stickers have a guild). */
  onSticker(guild: string | null, sticker: StickerSourceLike, removed: boolean): void {
    if (guild === null) return;
    if (removed) {
      if (sticker.id) this.shared.stickers.remove(guild, sticker.id);
      return;
    }
    const s = serverSticker(sticker);
    if (s) this.shared.stickers.upsert(guild, s);
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

  /** She joined a server (or it came back after an outage): recorded, and given the commands. */
  async joined(guild: GuildLike): Promise<void> {
    await this.snapshotGuild(guild);
    if (allGuilds(this.shared.config)) this.shared.syncAgain?.();
  }

  /**
   * She left a server, or was removed: recorded as left (`Places.left`). A server that only went
   * unavailable (a Discord outage) is not left.
   */
  left(guild: GuildLike & LeftLike): void {
    this.shared.emoji.dropGuild(guild.id);
    this.shared.stickers.dropGuild(guild.id);
    if (guild.available === false) return;
    try {
      this.ctx.services.get(PlacesKey)?.left(PLATFORM, guild.id);
    } catch (error) {
      log.warn({ guild: guild.id, error: errorMessage(error) }, "cannot record a server she left");
    }
  }

  /** She is in `guild`: identity records it (`Places.seen`; the first one ever is primary). */
  seen(guild: GuildLike): void {
    try {
      this.ctx.services.get(PlacesKey)?.seen(PLATFORM, guild.id, guild.name ?? null);
    } catch (error) {
      log.warn({ guild: guild.id, error: errorMessage(error) }, "cannot record a server she is in");
    }
  }

  /**
   * Publishes everyone the gateway cache knows in `guild` (members, presences, voice states) as
   * `initial` updates, after fetching the member list when the members intent is on. The server
   * is recorded first.
   */
  async snapshotGuild(guild: GuildLike): Promise<void> {
    this.seen(guild);
    if (guild.emojis) {
      const list = [...guild.emojis.cache.values()].map(serverEmoji).filter((e) => e !== null);
      this.shared.emoji.setGuild(guild.id, list);
    }
    if (guild.stickers) {
      const list = [...guild.stickers.cache.values()]
        .map(serverSticker)
        .filter((s): s is ServerSticker => s !== null);
      this.shared.stickers.setGuild(guild.id, list);
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
    this.ctx.publish(BusEvents.PlatformPresence, update);
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
    this.ctx.publish(BusEvents.PlatformReaction, event);
  }

  /**
   * A voice state, published for `world`. Someone who is in one of the server's voice channels on
   * connecting, or who joins or moves into one, is a member of the server (`memberActed`); a mute,
   * a deafen or a stream in the same channel writes nothing.
   */
  onVoiceState(
    state: VoiceStateLike,
    initial: boolean,
    old: Pick<VoiceStateLike, "channelId"> | null = null,
  ): void {
    if (state.channelId !== null && (initial || old?.channelId !== state.channelId)) {
      const member = state.member ?? null;
      // Without the member, whether it is a bot is unknown: nobody is made a member blind.
      if (member?.user) this.memberActed(state.guild.id, member.user, member.nickname ?? null);
    }
    this.ctx.publish(BusEvents.PlatformVoiceState, voiceStateUpdate(state, initial));
  }

  /**
   * Someone acted in `guild` without writing there (a message records itself): a command, a
   * control or a modal, or being in one of its voice channels. Identity makes them a member of the
   * server (`Places.memberSeen`), the way a message would, so the server's boards, predictions and
   * bounties count them. Bots and her own accounts never become members this way. Never throws: a
   * failed write must not cost the command.
   */
  memberActed(guild: string | null, user: UserLike | null | undefined, nick: string | null): void {
    if (guild === null || !user || user.bot === true || this.shared.selfIds.has(user.id)) return;
    const places = this.ctx.services.get(PlacesKey);
    if (places === undefined) return;
    try {
      // A server not recorded yet (or marked left) is recorded, as a message there would.
      const space = places.ofGuild(PLATFORM, guild)?.id ?? places.seen(PLATFORM, guild, null);
      places.memberSeen(space, account(user.id), displayName(user, nick));
    } catch (error) {
      log.warn({ guild, error: errorMessage(error) }, "cannot record a server's member");
    }
  }

  onMember(member: GuildMemberLike, left: boolean): void {
    this.ctx.publish(BusEvents.PlatformMember, memberUpdate(member, left));
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

  /**
   * Slash commands, autocomplete, buttons, select menus and modal submissions. Whoever uses one in
   * a server is a member there from now (`memberActed`), before it is dispatched, so the command's
   * own handler already sees them as one; typing an option (autocomplete) is not acting.
   */
  private async onInteraction(client: Client, interaction: Interaction): Promise<void> {
    if (!interaction.isAutocomplete()) {
      this.memberActed(interaction.guildId, interaction.user, memberNick(interaction.member));
    }
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
      this.ctx.publish(BusEvents.PlatformReady, { platform: PLATFORM, self_account: account(id) });
    }
    const emojiConfig = this.shared.config.emoji;
    const stickerConfig = this.shared.config.stickers;
    // On or off per server (docs/design/v5-places.md).
    const emoji = perGuild(this.shared, (c) => c.emoji);
    const stickers = perGuild(this.shared, (c) => c.stickers);
    const sink = new DiscordSink(
      client.rest,
      () => this.ctx.services.get(ModerationKey),
      {
        table: this.shared.emoji,
        usage: this.shared.emojiUsage,
        enabled: (guild) => emoji.enabled(guild),
        limits: () => emojiConfig,
      },
      {
        source: () => this.ctx.services.get(AttachmentSourceKey),
        maxBytes: () => this.shared.config.max_upload_bytes,
      },
      {
        table: this.shared.stickers,
        usage: this.shared.stickerUsage,
        enabled: (guild) => stickers.enabled(guild),
        limits: () => stickerConfig,
        now: () => this.ctx.clock.now(),
      },
    );
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
      this.ctx.spawn("command-sync", (signal) => {
        const sync = syncRunner({
          rest: client.rest,
          applicationId: client.application.id,
          registry,
          commandGuilds: config.command_guilds,
          // `["*"]`: every guild she is in; once per run the sync clears the scope not in use.
          guilds: () => [...client.guilds.cache.keys()],
          signal,
        });
        this.shared.syncAgain = () => {
          void sync(false).catch((error: unknown) =>
            log.warn({ error: errorMessage(error) }, "cannot sync the commands of a new server"),
          );
        };
        return runSyncLoop({ registry, signal, sync });
      });
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
    const rules = msg.guildId === null ? this.shared.config : this.shared.ambient(msg.guildId, ids);
    if (!messageAllowed(rules, data, msg.guildId, ids, this.shared.selfIds)) return;
    this.ctx.publish(BusEvents.PlatformMessageCreated, data);
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
