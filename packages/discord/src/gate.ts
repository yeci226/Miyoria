// Which guild messages reach her (docs/design/v3-architecture.md §14.3, §14.4 item 13, §19
// item 4): event driven, with an allowlist of channels where she may listen to ambient chat.
//
// A message always gets through when it is a DM, comes from one of her own accounts, mentions
// her or replies to her; everything else in a guild only when the channel is listed in
// `ambient_channels`. `ambient_text = "tiers"` turns the gate off and leaves the decision to the
// agent's per-channel level (the behaviour before the gate existed).

import type { IncomingMessage } from "@miyoria/types";
import type { DiscordConfig } from "./config.js";

/** The two ids a thread's messages are matched by: the thread and the channel it hangs from. */
export interface ChannelIds {
  channel: string;
  parent?: string | null;
}

/** Is the channel (or the channel a thread belongs to) on the ambient allowlist? */
export function ambientChannel(config: DiscordConfig, ids: ChannelIds): boolean {
  if (config.ambient_text === "tiers") return true;
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
  config: DiscordConfig,
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
