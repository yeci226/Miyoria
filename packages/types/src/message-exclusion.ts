// A message someone asked her not to remember ("不要記住這個", `MessageActions.dontRemember`).
//
// The agent hides it from her prompts at once (its text in the conversation she sees becomes a
// placeholder) and publishes this event, so whatever else keeps what people said (memory
// consolidation, reflection, person notes) can leave it out as well. The event names the message;
// it never repeats its text.

import type { AccountRef, ContextKey, MessageRef } from "./platform.js";

/** Topic of `MessageExcluded` (a `custom` event). */
export const MESSAGE_EXCLUDED_TOPIC = "agent.message.excluded";

export interface MessageExcluded {
  /** The context she knows the message in (a voice channel's text chat is the voice context). */
  context: ContextKey;
  message: MessageRef;
  /** Who wrote it, when known. */
  author: AccountRef | null;
  /** Who asked (the author, or someone with `memory.message.exclude`). */
  requested_by: AccountRef;
  /** ISO time it was asked. */
  at: string;
}
