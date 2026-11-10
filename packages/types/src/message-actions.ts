// What a person can ask of one message through the platform's context menu ("make her answer
// this", "do not remember this"), as a service the agent provides. The platform adapters and the
// command framework only carry the request; whether she answers, and what stays out of her
// memory, is decided where those things live. Without a provider the menus say they are not
// available.

import type { AccountRef, MessageRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** The message a menu entry was used on, and who used it. */
export interface MessageActionRequest {
  message: MessageRef;
  /** Who wrote the message, when the platform said. */
  author: AccountRef | null;
  /** Who used the menu. Already allowed to by the command framework; blocked people are not. */
  requested_by: AccountRef;
}

export type MessageActionOutcome =
  /** Done (or queued); `note` is a short neutral line for the person. */
  | { ok: true; note?: string }
  /** Refused or failed; `reason` is a short neutral line for the person. */
  | { ok: false; reason: string };

export interface MessageActions {
  /**
   * Asks her to answer this message as if it had been said to her. She still decides: the gate,
   * her activeness and the speaking budget apply and she may stay silent.
   */
  replyTo(request: MessageActionRequest): Promise<MessageActionOutcome>;
  /**
   * Keeps this message out of what she remembers (memory writes, reflection, person notes).
   * The author and people with the `memory.message.exclude` node may ask; the provider checks
   * nothing about permissions, the menu does.
   */
  dontRemember(request: MessageActionRequest): Promise<MessageActionOutcome>;
}

export const MessageActionsKey = serviceKey<MessageActions>("MessageActions");
