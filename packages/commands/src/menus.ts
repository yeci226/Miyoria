// The built-in context menu entries (docs/design/v4-plan.md §9.3).
//
// - message "要她回這則": asks her to answer that message. She still decides (gate, activeness,
//   speaking budget); the request goes to the `MessageActions` service the agent provides.
// - message "不要記住這個": keeps that message out of her memory. The author may ask, and so may
//   people with `memory.message.exclude` (admins and owners by `memory.*`).
// - user "她對這個人的印象": the admin view of someone (`admin person show`), under that
//   command's own permission, so a member who clicks it gets the usual refusal.
//
// Every answer is a neutral system notice, private to the person who clicked (never her voice).

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { type MessageActionRequest, MessageActionsKey, sameAccount } from "@miyoria/types";
import { runCommand } from "./panel.js";
import type { CommandRegistry } from "./registry.js";
import { type CommandReply, notice } from "./reply.js";
import type { Invocation } from "./spec.js";

const log = getLogger("commands.menus");

/** Ids of the entries (the second word of their `menu` path). */
export const MENU_REPLY = "reply-here";
export const MENU_FORGET = "dont-remember";
export const MENU_PERSON = "her-view";

/** Who may keep other people's messages out of her memory. */
export const MESSAGE_EXCLUDE_NODE = "memory.message.exclude";

/** How long one person waits between two "reply to this" requests (each one can start a turn). */
export const REPLY_COOLDOWN_MS = 15_000;

export const MENU_TEXT = {
  unavailable: "這個功能現在不能用。",
  replyAsked: "已請她看這則訊息。她會自己決定要不要回。",
  replyWait: "剛剛才請過她，請稍後再試。",
  forgetDone: "已請她不要記住這則訊息。",
  forgetNotYours: "只有訊息的作者可以請她不要記住它。",
  noMessage: "找不到這則訊息。",
  failed: "沒有成功，請稍後再試。",
} as const;

export interface MenusOptions {
  services: ServiceLookup;
  now?: () => number;
}

function request(inv: Invocation): MessageActionRequest | null {
  const id = inv.str("target");
  if (id === null || id.trim() === "") return null;
  return {
    message: { context: inv.context, id: id.trim() },
    author: inv.account("author"),
    requested_by: inv.invoker,
  };
}

/** Registers the three menu entries. Safe to call again (they are replaced). */
export function registerMenus(registry: CommandRegistry, options: MenusOptions): void {
  const now = options.now ?? Date.now;
  const lastAsk = new Map<string, number>();

  registry.registerMenu(
    {
      id: MENU_REPLY,
      name: "要她回這則",
      target: "message",
      permission: "chat.talk",
      ephemeral: true,
    },
    async (inv) => {
      const actions = options.services.get(MessageActionsKey);
      const req = request(inv);
      if (!actions) return notice("info", MENU_TEXT.unavailable);
      if (req === null) return notice("warn", MENU_TEXT.noMessage);
      const key = `${inv.invoker.platform}:${inv.invoker.id}`;
      const at = now();
      const last = lastAsk.get(key);
      if (last !== undefined && at - last < REPLY_COOLDOWN_MS) {
        return notice("warn", MENU_TEXT.replyWait);
      }
      lastAsk.set(key, at);
      if (lastAsk.size > 1_000) {
        for (const [who, when] of lastAsk) if (at - when >= REPLY_COOLDOWN_MS) lastAsk.delete(who);
      }
      return outcome(await attempt(() => actions.replyTo(req)), MENU_TEXT.replyAsked);
    },
  );

  registry.registerMenu(
    {
      id: MENU_FORGET,
      name: "不要記住這個",
      target: "message",
      permission: "memory.self.forget",
      ephemeral: true,
    },
    async (inv) => {
      const actions = options.services.get(MessageActionsKey);
      const req = request(inv);
      if (!actions) return notice("info", MENU_TEXT.unavailable);
      if (req === null) return notice("warn", MENU_TEXT.noMessage);
      const own = req.author !== null && sameAccount(req.author, inv.invoker);
      if (!own && !(await inv.allowed(MESSAGE_EXCLUDE_NODE))) {
        return notice("warn", MENU_TEXT.forgetNotYours);
      }
      return outcome(await attempt(() => actions.dontRemember(req)), MENU_TEXT.forgetDone);
    },
  );

  registry.registerMenu(
    {
      id: MENU_PERSON,
      name: "她對這個人的印象",
      target: "user",
      permission: "",
      ephemeral: true,
    },
    (inv) => {
      const target = inv.str("target");
      if (target === null) return notice("warn", MENU_TEXT.noMessage);
      return runCommand(registry, options.services, inv, "admin person show", { user: target });
    },
  );
}

/** A provider that throws answers like one that refused: the person gets a neutral line. */
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "message action failed");
    return null;
  }
}

function outcome(
  result: { ok: true; note?: string } | { ok: false; reason: string } | null,
  done: string,
): CommandReply {
  if (result === null) return notice("error", MENU_TEXT.failed);
  return result.ok ? notice("success", result.note ?? done) : notice("warn", result.reason);
}

export function unregisterMenus(registry: CommandRegistry): void {
  for (const id of [MENU_REPLY, MENU_FORGET, MENU_PERSON]) registry.unregisterMenu(id);
}
