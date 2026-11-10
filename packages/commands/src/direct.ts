// Cards sent outside a command interaction: a `CommandReply` posted as a new direct message,
// e.g. the approval card the gate sends to the owners. Its controls are routed like any other
// (`mi:<route>:...` → the command that declared the route, under that command's permission).

import {
  type AccountRef,
  type ContextKey,
  type MessageRef,
  type PlatformId,
  serviceKey,
} from "@miyoria/types";
import type { CommandReply } from "./reply.js";
import type { ResolvedUser } from "./spec.js";

/** Provided by a platform module (the Discord bot) as `ReplySinkKey`. */
export interface ReplySink {
  readonly platform: PlatformId;
  /** Sends `reply` (rendered like a command reply, never pinging anyone) as a DM to `account`. */
  sendDirect(account: AccountRef, reply: CommandReply, signal?: AbortSignal): Promise<MessageRef>;
  /**
   * Sends `reply` (rendered like a command reply, never pinging anyone) into `context` (a channel,
   * a thread, a voice channel's text chat): the receipt cards of her actions.
   */
  sendCard?(context: ContextKey, reply: CommandReply, signal?: AbortSignal): Promise<MessageRef>;
}

export const ReplySinkKey = serviceKey<ReplySink>("ReplySink");

/**
 * Provided by a platform module as `UserResolverKey`. Panels run commands from buttons and
 * modals, which (unlike a slash command's user option) carry no guild details of the people
 * they name. Commands that rank their target (`admin role assign`, ...) need those, so panels
 * ask the platform and refuse when it cannot answer.
 */
export interface UserResolver {
  readonly platform: PlatformId;
  /**
   * Roles and admin status of `ids` in the guild of `context`. An id the platform cannot find
   * is left out of the result.
   */
  resolveUsers(
    context: ContextKey,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, ResolvedUser>>;
}

export const UserResolverKey = serviceKey<UserResolver>("UserResolver");
