// Which guild messages reach her (docs/design/v3-architecture.md §14.3, §14.4 item 13, §19
// item 4): event driven, with an allowlist of channels where she may listen to ambient chat.
//
// A message always gets through when it is a DM, comes from one of her own accounts, mentions
// her or replies to her; everything else in a guild only when the channel is listed in
// `ambient_channels` (or the room says `ambient_follow`). `ambient_text = "tiers"` turns the gate
// off and leaves the decision to the agent's per-channel level (the behaviour before the gate
// existed).
//
// Per server (docs/design/v5-places.md): `ambientFor` reads the rules for one guild and room from
// the module's `PlaceConfig`. A new server (not established: first seen after servers were told
// apart) starts quiet: until
// `ambient_text` is set for it there, it is `allowlist`, and only its own followed channels count
// (the channel rule of `PlaceConfig` already drops another server's channels).

import type { ContextKey, IncomingMessage, PlaceConfig, Places } from "@miyoria/types";
import type { DiscordConfig } from "./config.js";
import { PLATFORM } from "./mapping.js";

/** The two ids a thread's messages are matched by: the thread and the channel it hangs from. */
export interface ChannelIds {
  channel: string;
  parent?: string | null;
}

/** The rules of the gate for one place (`DiscordConfig` itself is the cluster's). */
export interface Ambient {
  ambient_text: "allowlist" | "tiers";
  ambient_channels: readonly string[];
  /** The room's own say; `null` or absent: `ambient_channels` decides. */
  ambient_follow?: boolean | null;
}

/** Is the channel (or the channel a thread belongs to) on the ambient allowlist? */
export function ambientChannel(config: Ambient, ids: ChannelIds): boolean {
  if (config.ambient_text === "tiers") return true;
  if (config.ambient_follow === true) return true;
  if (config.ambient_follow === false) return false;
  return (
    config.ambient_channels.includes(ids.channel) ||
    (ids.parent !== undefined &&
      ids.parent !== null &&
      config.ambient_channels.includes(ids.parent))
  );
}

/**
 * Whether an incoming message is published. `guild` is `null` in DMs; `selfIds` are all of her
 * accounts.
 */
export function messageAllowed(
  config: Ambient,
  message: Pick<IncomingMessage, "author" | "mentions_self" | "reply_to_self">,
  guild: string | null,
  ids: ChannelIds,
  selfIds: ReadonlySet<string>,
): boolean {
  if (guild === null || config.ambient_text === "tiers") return true;
  if (selfIds.has(message.author.account.id)) return true;
  if (message.mentions_self || message.reply_to_self) return true;
  return ambientChannel(config, ids);
}

/** What `ambientFor` reads the places from. */
export interface AmbientPlaces {
  config: PlaceConfig<DiscordConfig>;
  places: Places;
  /** Whether `key` (`ambient_text`) has a row of its own for the Space `space` (identity's id). */
  own(space: string, key: string): boolean;
}

/**
 * Whether `guild` is a new server: one she was not already in when servers were told apart (not
 * established, `SpaceRef.established`), or one she has no record of. The primary and every other
 * established server behave as they always did.
 */
export function newGuild(places: Places, guild: string): boolean {
  const space = places.ofGuild(PLATFORM, guild);
  if (space !== null) return !space.established;
  return places.spaces().length > 0;
}

/** The gate's rules in `guild` for the room `ids`: the cluster's without places. */
export function ambientFor(
  cluster: DiscordConfig,
  places: AmbientPlaces | null,
  guild: string,
  ids: ChannelIds,
): Ambient {
  if (places === null) return cluster;
  const where: ContextKey = {
    platform: PLATFORM,
    scope: guild,
    channel: ids.channel,
    kind: ids.parent ? "thread" : "channel",
  };
  const here = places.config.for(where);
  if (!newGuild(places.places, guild)) return here;
  // A new server: only what was set for it (or its rooms) counts.
  const base = places.config.base();
  const space = places.places.ofGuild(PLATFORM, guild);
  const text =
    here.ambient_text !== base.ambient_text ||
    (space !== null && places.own(space.id, "ambient_text"))
      ? here.ambient_text
      : "allowlist";
  const follow = here.ambient_follow !== base.ambient_follow ? here.ambient_follow : null;
  return { ambient_text: text, ambient_channels: here.ambient_channels, ambient_follow: follow };
}

/**
 * The emoji's or the stickers' `enabled` and `descriptions` of one server (docs/design/v5-places.md):
 * the server's own, else the file's. A new server (not established) takes the file's `enabled`
 * but not its descriptions, which are the meanings of the servers she was already in.
 */
export function perGuild(
  shared: { config: DiscordConfig; places: AmbientPlaces | null },
  section: (config: DiscordConfig) => { enabled: boolean; descriptions: Record<string, string> },
): {
  enabled(guild: string | null): boolean;
  descriptions(guild: string | null): Readonly<Record<string, string>>;
} {
  const cluster = section(shared.config);
  const at = (guild: string | null) => {
    const p = shared.places;
    if (p === null || guild === null) return { here: cluster, base: cluster, fresh: false };
    const where: ContextKey = { platform: PLATFORM, scope: guild, channel: guild, kind: "channel" };
    return {
      here: section(p.config.for(where)),
      base: section(p.config.base()),
      fresh: newGuild(p.places, guild),
    };
  };
  return {
    enabled: (guild) => at(guild).here.enabled,
    descriptions: (guild) => {
      const { here, base, fresh } = at(guild);
      const inherited = JSON.stringify(here.descriptions) === JSON.stringify(base.descriptions);
      return fresh && inherited ? {} : here.descriptions;
    },
  };
}
