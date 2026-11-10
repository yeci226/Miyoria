// Pure conversions between discord.js models and Miyoria types. The inputs are structural
// subsets of the discord.js classes (and of the raw API shapes), so tests can build plain
// objects and no live Discord is needed.

import type { ResolvedUser } from "@miyoria/commands";
import {
  type AccountRef,
  type Attachment,
  type ContextKey,
  type ContextKind,
  type Embed,
  type ForwardedMessage,
  type IncomingMessage,
  incomingText,
  type MentionedAccount,
  type MessageRef,
  type PlatformId,
  type QuotedMessage,
  type Sticker,
  toTimestamp,
} from "@miyoria/types";
import { ApplicationCommandOptionType, ChannelType } from "discord.js";

export const PLATFORM: PlatformId = "discord";

/** Discord permission bits that make a member a guild admin. */
export const ADMINISTRATOR = 1n << 3n;
export const MANAGE_GUILD = 1n << 5n;

export function platform(): PlatformId {
  return PLATFORM;
}

export function account(userId: string): AccountRef {
  return { platform: PLATFORM, id: userId };
}

export function contextKey(guild: string | null, channel: string, kind: ContextKind): ContextKey {
  return { platform: PLATFORM, scope: guild, channel, kind };
}

/**
 * Context kind of a channel type. Text chat in voice channels counts as a normal channel; voice
 * contexts belong to the voice node (while she is in the voice channel, the agent routes its
 * text chat to the voice context).
 */
export function kindOf(channel: ChannelType): ContextKind {
  switch (channel) {
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    case ChannelType.DM:
    case ChannelType.GroupDM:
      return "dm";
    default:
      return "channel";
  }
}

export interface UserLike {
  id: string;
  username: string;
  globalName?: string | null;
  bot?: boolean;
}

/** Guild nickname > global display name > username. */
export function displayName(user: UserLike, nick?: string | null): string {
  const first = nick ?? user.globalName;
  return first !== undefined && first !== null && first.trim() !== "" ? first : user.username;
}

export interface AttachmentLike {
  id?: string;
  url: string;
  name: string;
  contentType?: string | null;
  size?: number | null;
  /** Alt text. */
  description?: string | null;
}

export interface StickerLike {
  id: string;
  name: string;
}

export interface EmbedLike {
  title?: string | null;
  description?: string | null;
  url?: string | null;
}

/** Map-like collections as discord.js hands them out (`Collection`) or tests build them. */
interface Values<T> {
  values(): Iterable<T>;
}

interface Entries<T> {
  entries(): Iterable<[string, T]>;
}

/** What a message mentions, with names (`MessageMentions`). */
export interface MentionsLike {
  users: { keys(): Iterable<string> } & Partial<Entries<UserLike>>;
  /** Guild members of mentioned users (their nicknames). */
  members?: Entries<{ nickname?: string | null; user?: UserLike }> | null;
  channels?: Entries<{ name?: string | null }> | null;
  roles?: Entries<{ name: string }> | null;
}

/** A forwarded message's snapshot (`MessageSnapshot`). */
export interface SnapshotLike {
  content?: string | null;
  attachments?: Values<AttachmentLike> | null;
  stickers?: Values<StickerLike> | null;
  embeds?: readonly EmbedLike[] | null;
  mentions?: MentionsLike | null;
}

/** `MessageReference`: `type` 0 = reply, 1 = forward. */
export interface ReferenceLike {
  messageId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  type?: number | null;
}

/** The parts of a discord.js `Message` that `incomingMessage` reads. */
export interface MessageLike {
  id: string;
  channelId: string;
  guildId: string | null;
  author: UserLike;
  /** Guild member (nickname), when the message came from a guild. */
  member?: { nickname?: string | null } | null;
  content: string;
  createdTimestamp: number;
  mentions: MentionsLike;
  attachments: Values<AttachmentLike>;
  stickers?: Values<StickerLike> | null;
  embeds?: readonly EmbedLike[] | null;
  reference?: ReferenceLike | null;
  messageSnapshots?: Values<SnapshotLike> | null;
  /** Components V2 (her cards): their text displays are read when there is no content. */
  components?: readonly unknown[] | null;
}

/** Longest text read from a message's components. */
export const MAX_COMPONENT_CHARS = 600;

/**
 * The text of a message's components (Components V2 text displays, in order), as her cards carry
 * it: a reply to a card is a reply to what the card says. discord.js component objects are read
 * through `toJSON()`; raw API objects as they are.
 */
export function componentsText(components: readonly unknown[] | null | undefined): string {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || typeof node !== "object" || node === null) return;
    const raw =
      typeof (node as { toJSON?: unknown }).toJSON === "function"
        ? (node as { toJSON(): unknown }).toJSON()
        : node;
    if (typeof raw !== "object" || raw === null) return;
    const r = raw as { content?: unknown; components?: unknown; accessory?: unknown };
    if (typeof r.content === "string" && r.content.trim() !== "") out.push(r.content.trim());
    if (Array.isArray(r.components)) for (const child of r.components) walk(child, depth + 1);
  };
  for (const c of components ?? []) walk(c, 0);
  return clip(out.join("\n"), MAX_COMPONENT_CHARS);
}

/** Reference type of a forward (`MessageReferenceType.Forward`). */
export const REFERENCE_FORWARD = 1;

/** Longest quoted parent text kept with a reply. */
export const MAX_QUOTE_CHARS = 300;

/** Names to replace `<@id>`, `<#id>` and `<@&id>` with. */
export interface MentionNames {
  users: ReadonlyMap<string, string>;
  channels: ReadonlyMap<string, string>;
  roles: ReadonlyMap<string, string>;
}

/** The names a message's mention data knows (members' nicknames over user names). */
export function mentionNames(mentions: MentionsLike | null | undefined): MentionNames {
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  const roles = new Map<string, string>();
  for (const [id, user] of mentions?.users.entries?.() ?? []) users.set(id, displayName(user));
  for (const [id, member] of mentions?.members?.entries() ?? []) {
    const nick = member.nickname?.trim();
    if (nick) users.set(id, nick);
    else if (member.user && !users.has(id)) users.set(id, displayName(member.user));
  }
  for (const [id, channel] of mentions?.channels?.entries() ?? []) {
    if (channel.name) channels.set(id, channel.name);
  }
  for (const [id, role] of mentions?.roles?.entries() ?? []) roles.set(id, role.name);
  return { users, channels, roles };
}

/**
 * Replaces raw mention markup with readable names: `<@id>` / `<@!id>` → `@name`, `<#id>` →
 * `#name`, `<@&id>` → `@name`, custom emoji `<:name:id>` / `<a:name:id>` → `:name:`. Unknown
 * ids get a generic name, never the raw id. Timestamps (`<t:…>`) are left alone.
 */
export function resolveMentions(text: string, names: MentionNames): string {
  return text
    .replace(/<@!?(\d{1,20})>/g, (_m, id: string) => `@${names.users.get(id) ?? "某人"}`)
    .replace(/<@&(\d{1,20})>/g, (_m, id: string) => `@${names.roles.get(id) ?? "某個身分組"}`)
    .replace(/<#(\d{1,20})>/g, (_m, id: string) => `#${names.channels.get(id) ?? "某個頻道"}`)
    .replace(/<a?:(\w{1,32}):\d{1,20}>/g, (_m, name: string) => `:${name}:`);
}

const LEADING_MENTION = /^\s*<@!?(\d{1,20})>/;
const USER_MENTION = /<@!?(\d{1,20})>/g;

/**
 * Who a message talks to besides her. Only mentions written in the text count: a reply ping
 * (Discord adds the replied-to author to `mentions.users` without any markup) says whom the
 * message answers, not whom it addresses. Roles are never included.
 */
export function otherMentions(
  content: string,
  mentions: MentionsLike | null | undefined,
  selfIds: ReadonlySet<string>,
): { mentions_others: MentionedAccount[]; opens_with_other_mention: boolean } {
  const known = new Map<string, UserLike>();
  for (const [id, user] of mentions?.users.entries?.() ?? []) known.set(id, user);
  const nicks = new Map<string, string>();
  for (const [id, member] of mentions?.members?.entries() ?? []) {
    const nick = member.nickname?.trim();
    if (nick) nicks.set(id, nick);
  }
  const out: MentionedAccount[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(USER_MENTION)) {
    const id = match[1] as string;
    const user = known.get(id);
    if (!user || selfIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      account: account(id),
      display_name: displayName(user, nicks.get(id) ?? null),
      is_bot: user.bot ?? false,
    });
  }
  const lead = LEADING_MENTION.exec(content)?.[1];
  return {
    mentions_others: out,
    opens_with_other_mention: lead !== undefined && !selfIds.has(lead) && known.has(lead),
  };
}

function attachments(list: Values<AttachmentLike> | null | undefined): Attachment[] {
  const out: Attachment[] = [];
  for (const a of list?.values() ?? []) {
    out.push({
      url: a.url,
      filename: a.name,
      content_type: a.contentType ?? null,
      id: a.id ?? null,
      size: a.size ?? null,
      description: a.description?.trim() || null,
    });
  }
  return out;
}

function stickers(list: Values<StickerLike> | null | undefined): Sticker[] {
  return [...(list?.values() ?? [])].map((s) => ({ id: s.id, name: s.name }));
}

function embeds(list: readonly EmbedLike[] | null | undefined): Embed[] {
  const out: Embed[] = [];
  for (const e of list ?? []) {
    const embed: Embed = {
      title: e.title?.trim() || null,
      description: e.description?.trim() || null,
      url: e.url?.trim() || null,
    };
    if (embed.title !== null || embed.description !== null || embed.url !== null) out.push(embed);
  }
  return out;
}

function forwarded(list: Values<SnapshotLike> | null | undefined): ForwardedMessage[] {
  const out: ForwardedMessage[] = [];
  for (const snap of list?.values() ?? []) {
    out.push({
      text: resolveMentions(snap.content ?? "", mentionNames(snap.mentions)),
      attachments: attachments(snap.attachments),
      stickers: stickers(snap.stickers),
      embeds: embeds(snap.embeds),
    });
  }
  return out;
}

/** Cuts `text` to `max` characters (plus `…`). */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** The replied-to message as a reply carries it: author and a clipped, resolved text. */
export function quotedMessage(msg: MessageLike): QuotedMessage {
  const own = incomingMessage(msg, "channel", new Set());
  return {
    author: own.author.account,
    author_name: own.author.display_name,
    text: clip(incomingText(own), MAX_QUOTE_CHARS),
  };
}

/**
 * Maps a gateway message. `selfIds` are all of her accounts (bot and self account);
 * `repliedAuthorId` is the author of the message this one replies to, if it is a reply, and
 * `referenced` that message itself when it was at hand.
 */
export function incomingMessage(
  msg: MessageLike,
  kind: ContextKind,
  selfIds: ReadonlySet<string>,
  repliedAuthorId: string | null = null,
  referenced: QuotedMessage | null = null,
): IncomingMessage {
  const effectiveKind: ContextKind = msg.guildId === null ? "dm" : kind;
  let mentionsSelf = false;
  for (const id of msg.mentions.users.keys()) {
    if (selfIds.has(id)) {
      mentionsSelf = true;
      break;
    }
  }
  const context = contextKey(msg.guildId, msg.channelId, effectiveKind);
  return {
    id: { context, id: msg.id },
    author: {
      account: account(msg.author.id),
      display_name: displayName(msg.author, msg.member?.nickname ?? null),
      is_bot: msg.author.bot ?? false,
    },
    text: resolveMentions(
      msg.content.trim() === "" ? componentsText(msg.components) : msg.content,
      mentionNames(msg.mentions),
    ),
    mentions_self: mentionsSelf,
    reply_to_self: repliedAuthorId !== null && selfIds.has(repliedAuthorId),
    attachments: attachments(msg.attachments),
    ts: toTimestamp(msg.createdTimestamp),
    reply_to: replyRef(msg, context),
    referenced: replyRef(msg, context) === null ? null : referenced,
    stickers: stickers(msg.stickers),
    embeds: embeds(msg.embeds),
    forwarded: forwarded(msg.messageSnapshots),
    ...otherMentions(msg.content, msg.mentions, selfIds),
  };
}

/** The message `msg` replies to (not a forward). A reply across channels keeps its channel. */
export function replyRef(msg: MessageLike, context: ContextKey): MessageRef | null {
  const ref = msg.reference;
  if (!ref || (ref.type ?? 0) === REFERENCE_FORWARD || !ref.messageId) return null;
  const elsewhere = ref.channelId && ref.channelId !== msg.channelId;
  return {
    context: elsewhere
      ? contextKey(ref.guildId ?? msg.guildId, ref.channelId as string, context.kind)
      : context,
    id: ref.messageId,
  };
}

/**
 * Whether a message carries anything to read: text, attachments, stickers, embeds or a
 * forwarded message.
 */
export function hasContent(msg: MessageLike): boolean {
  const any = (v: Values<unknown> | null | undefined): boolean => {
    for (const _ of v?.values() ?? []) return true;
    return false;
  };
  return (
    msg.content.trim() !== "" ||
    componentsText(msg.components) !== "" ||
    any(msg.attachments) ||
    any(msg.stickers) ||
    (msg.embeds?.length ?? 0) > 0 ||
    any(msg.messageSnapshots)
  );
}

/** Permissions as discord.js or the raw API hands them out. */
export type PermissionsLike = string | bigint | { bitfield: bigint } | null | undefined;

function permissionBits(p: PermissionsLike): bigint {
  if (p === null || p === undefined) return 0n;
  if (typeof p === "bigint") return p;
  if (typeof p === "string") return p === "" ? 0n : BigInt(p);
  return p.bitfield;
}

/** Administrator or Manage Server count as guild admin. */
export function isAdminPermissions(p: PermissionsLike): boolean {
  return (permissionBits(p) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}

/** Role ids of a guild member, as strings. */
export function roleIds(roles: readonly string[]): string[] {
  return [...roles];
}

/** A guild member as the gateway cache (`GuildMember`) or the raw API payload gives it. */
export interface MemberLike {
  nickname?: string | null;
  nick?: string | null;
  roles: readonly string[] | { cache: { keys(): Iterable<string> } };
  permissions?: PermissionsLike;
}

export function memberNick(member: MemberLike | null | undefined): string | null {
  return member?.nickname ?? member?.nick ?? null;
}

export function memberRoleIds(member: MemberLike | null | undefined): string[] {
  if (!member) return [];
  const roles = member.roles;
  return Array.isArray(roles)
    ? [...(roles as readonly string[])]
    : [...(roles as { cache: { keys(): Iterable<string> } }).cache.keys()];
}

/** Members with Administrator or Manage Server count as guild admins. */
export function isGuildAdmin(member: MemberLike | null | undefined): boolean {
  return member !== null && member !== undefined && isAdminPermissions(member.permissions);
}

/** The resolved part of an interaction (`interaction.options.resolved`). */
export interface ResolvedLike {
  users?: { entries(): Iterable<[string, UserLike]> } | null;
  members?: { get(id: string): MemberLike | null | undefined } | null;
}

/**
 * Guild details of the users passed in user options, keyed by user id. Users without member
 * data (e.g. in DMs) get no roles.
 */
export function resolvedUsers(
  resolved: ResolvedLike | null | undefined,
): Map<string, ResolvedUser> {
  const out = new Map<string, ResolvedUser>();
  if (!resolved?.users) return out;
  for (const [id, user] of resolved.users.entries()) {
    const member = resolved.members?.get(id);
    out.set(id, {
      display_name: displayName(user, memberNick(member)),
      platform_roles: memberRoleIds(member),
      is_guild_admin: member ? isAdminPermissions(member.permissions) : false,
    });
  }
  return out;
}

/** One option of an interaction (`CommandInteractionOption`). */
export interface OptionLike {
  name: string;
  type: ApplicationCommandOptionType;
  value?: string | number | boolean;
  options?: readonly OptionLike[];
}

/** An argument value: strings, integers and booleans, like the commands crate's `ArgValue`. */
export type ArgValueLike = string | number | boolean;

/** Flattens an interaction into a command path and argument values. */
export function commandPath(
  name: string,
  options: readonly OptionLike[],
): { path: string[]; args: Map<string, ArgValueLike> } {
  const path = [name];
  let level = options;
  for (;;) {
    const first = level[0];
    if (
      !first ||
      (first.type !== ApplicationCommandOptionType.Subcommand &&
        first.type !== ApplicationCommandOptionType.SubcommandGroup)
    ) {
      break;
    }
    path.push(first.name);
    level = first.options ?? [];
  }
  const args = new Map<string, ArgValueLike>();
  for (const option of level) {
    const value = argValue(option);
    if (value !== undefined) args.set(option.name, value);
  }
  return { path, args };
}

function argValue(option: OptionLike): ArgValueLike | undefined {
  const value = option.value;
  if (value === undefined) return undefined;
  switch (option.type) {
    case ApplicationCommandOptionType.Integer:
      return typeof value === "number" ? value : undefined;
    case ApplicationCommandOptionType.Boolean:
      return typeof value === "boolean" ? value : undefined;
    case ApplicationCommandOptionType.Subcommand:
    case ApplicationCommandOptionType.SubcommandGroup:
      return undefined;
    default:
      // String, Number (as text), and the id of users, channels, roles, mentionables, attachments.
      return String(value);
  }
}

/** Parses a non-zero Discord snowflake. */
export function snowflake(raw: string, what: string): string {
  if (/^[0-9]{1,20}$/.test(raw) && BigInt(raw) !== 0n) return raw;
  throw new Error(`invalid Discord ${what} id \`${raw}\``);
}

/** Parses configured account ids (`"123"` or `"discord:123"`). */
export function parseUserIds(ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of ids) {
    let raw = s.trim();
    if (raw.startsWith("discord:")) raw = raw.slice("discord:".length);
    if (!/^[0-9]{1,20}$/.test(raw) || BigInt(raw) === 0n) {
      throw new Error(`invalid Discord user id \`${s}\``);
    }
    out.add(BigInt(raw).toString());
  }
  return out;
}
