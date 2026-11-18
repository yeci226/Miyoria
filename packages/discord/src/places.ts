// `PlaceDirectoryKey` for Discord (docs/design/v5-settings.md §2.5): the servers the bot is in and
// their channels, from the connected client's guild cache, with whether she can use each one. The
// panel's channel picker reads it. Nothing is fetched: while the bot is not connected the directory
// is empty and says it is not ready.
//
// `placeRooms` is the pure part (sorting, kinds, the reasons); `DiscordPlaces` turns discord.js's
// guilds into its input.

import type { PlaceDirectory, PlaceRoom, PlaceRoomKind, PlaceSpace } from "@miyoria/types";
import { ChannelType, type Client, PermissionFlagsBits } from "discord.js";
import { PLATFORM } from "./mapping.js";

/** A channel as the directory reads it. */
export interface ChannelView {
  id: string;
  name: string;
  /** `null` for a kind the directory does not list (a category, a forum, a DM). */
  kind: PlaceRoomKind | "category" | null;
  parent: string | null;
  position: number;
  /** She can see the channel. */
  view: boolean;
  /** She can post (text, thread) or connect (voice) there. */
  use: boolean;
}

/** A server as the directory reads it. */
export interface GuildView {
  id: string;
  name: string;
  channels: ChannelView[];
}

const REASON_HIDDEN = "她看不到這個頻道";
const REASON_TEXT = "她不能在這裡發言";
const REASON_VOICE = "她不能加入這個語音頻道";

/** The rooms of `guilds`, each server in its own order: no category first, then by category. */
export function placeRooms(
  guilds: readonly GuildView[],
  options: { space?: string; kind?: PlaceRoomKind } = {},
): PlaceRoom[] {
  const out: PlaceRoom[] = [];
  for (const guild of guilds) {
    if (options.space !== undefined && guild.id !== options.space) continue;
    const categories = new Map(
      guild.channels.filter((c) => c.kind === "category").map((c) => [c.id, c]),
    );
    const rank = (c: ChannelView) => {
      const parent = c.parent === null ? undefined : categories.get(c.parent);
      return [parent === undefined ? -1 : parent.position, c.kind === "voice" ? 1 : 0, c.position];
    };
    const rooms = guild.channels
      .filter(
        (c): c is ChannelView & { kind: PlaceRoomKind } => c.kind !== null && c.kind !== "category",
      )
      .filter((c) => options.kind === undefined || c.kind === options.kind)
      .sort((a, b) => {
        const [x, y] = [rank(a), rank(b)];
        for (let i = 0; i < x.length; i++) {
          const d = (x[i] ?? 0) - (y[i] ?? 0);
          if (d !== 0) return d;
        }
        return a.name.localeCompare(b.name);
      });
    rooms.forEach((c, position) => {
      const category = c.parent === null ? undefined : categories.get(c.parent);
      const reason = !c.view
        ? REASON_HIDDEN
        : !c.use
          ? c.kind === "voice"
            ? REASON_VOICE
            : REASON_TEXT
          : null;
      out.push({
        platform: PLATFORM,
        id: c.id,
        context: `${PLATFORM}:${guild.id}:${c.kind === "voice" ? "voice:" : ""}${c.id}`,
        name: c.name,
        kind: c.kind,
        space: { id: guild.id, name: guild.name },
        category: category === undefined ? null : { id: category.id, name: category.name },
        position,
        usable: reason === null,
        reason,
      });
    });
  }
  return out;
}

function kindOf(type: ChannelType): ChannelView["kind"] {
  switch (type) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return "text";
    case ChannelType.GuildVoice:
    case ChannelType.GuildStageVoice:
      return "voice";
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    case ChannelType.GuildCategory:
      return "category";
    default:
      return null;
  }
}

/** The connected client's guilds as the directory reads them. */
export function guildViews(client: Client): GuildView[] {
  const out: GuildView[] = [];
  for (const guild of client.guilds.cache.values()) {
    const me = guild.members.me;
    const channels: ChannelView[] = [];
    for (const channel of guild.channels.cache.values()) {
      const kind = kindOf(channel.type);
      if (kind === null) continue;
      const perms = me === null ? null : channel.permissionsFor(me);
      const view = perms?.has(PermissionFlagsBits.ViewChannel) ?? false;
      const use =
        kind === "voice"
          ? (perms?.has(PermissionFlagsBits.Connect) ?? false)
          : kind === "thread"
            ? (perms?.has(PermissionFlagsBits.SendMessagesInThreads) ?? false)
            : (perms?.has(PermissionFlagsBits.SendMessages) ?? false);
      channels.push({
        id: channel.id,
        name: channel.name,
        kind,
        parent: channel.parentId ?? null,
        position:
          "position" in channel && typeof channel.position === "number" ? channel.position : 0,
        view,
        use,
      });
    }
    out.push({ id: guild.id, name: guild.name, channels });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The directory over a client; `ready` says whether it is connected. */
export class DiscordPlaces implements PlaceDirectory {
  readonly platform = PLATFORM;

  constructor(
    readonly client: Client,
    readonly isReady: () => boolean,
  ) {}

  ready(): boolean {
    return this.isReady();
  }

  spaces(): PlaceSpace[] {
    if (!this.isReady()) return [];
    return guildViews(this.client).map((g) => ({ platform: PLATFORM, id: g.id, name: g.name }));
  }

  rooms(options: { space?: string; kind?: PlaceRoomKind } = {}): PlaceRoom[] {
    if (!this.isReady()) return [];
    return placeRooms(guildViews(this.client), options);
  }
}
