// `DiscordUserResolver`: roles and admin status of guild members, for panel buttons.
//
// A slash command's user option arrives with the member's roles; a button or modal does not.
// Commands that rank their target (`admin role assign`, ...) need those, so the panels ask here
// (through the `UserResolver` service) before running them.

import type { ResolvedUser, UserResolver } from "@miyoria/commands";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { ContextKey, PlatformId } from "@miyoria/types";
import {
  displayName,
  isAdminPermissions,
  type MemberLike,
  memberNick,
  memberRoleIds,
  PLATFORM,
  type UserLike,
} from "./mapping.js";

const log = getLogger("discord.resolver");

/** A guild member as `guild.members.fetch(id)` returns it. */
export interface FetchedMember extends MemberLike {
  user: UserLike;
}

/** The slice of the discord.js `Client` the resolver uses. */
export interface ResolverClientLike {
  guilds: {
    cache: { get(id: string): GuildLike | undefined };
    fetch(id: string): Promise<GuildLike>;
  };
}

export interface GuildLike {
  members: { fetch(id: string): Promise<FetchedMember> };
}

export class DiscordUserResolver implements UserResolver {
  readonly platform: PlatformId = PLATFORM;

  constructor(private readonly client: ResolverClientLike) {}

  async resolveUsers(
    context: ContextKey,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, ResolvedUser>> {
    const out: Record<string, ResolvedUser> = {};
    if (context.platform !== PLATFORM || context.scope === null) return out;
    const guild =
      this.client.guilds.cache.get(context.scope) ??
      (await this.client.guilds.fetch(context.scope));
    for (const id of ids) {
      if (signal?.aborted) break;
      if (!/^[0-9]{1,20}$/.test(id)) continue;
      try {
        const member = await guild.members.fetch(id);
        out[id] = {
          display_name: displayName(member.user, memberNick(member)),
          platform_roles: memberRoleIds(member),
          is_guild_admin: isAdminPermissions(member.permissions),
        };
      } catch (error) {
        // Not a member of this guild (or Discord refused): left out, so the caller refuses.
        log.debug({ id, error: errorMessage(error) }, "cannot fetch guild member");
      }
    }
    return out;
  }
}
