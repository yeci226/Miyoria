// A message someone asked her not to remember ("不要記住這個", `MessageActions.dontRemember`).
//
// The agent hides it from her prompts at once (its text in the conversation she sees becomes a
// placeholder) and publishes this event, so whatever else keeps what people said (memory
// consolidation, reflection, person notes) can leave it out as well. The event names the message;
// it never repeats its text.

import { AgentMessageExcluded, type MessageExcludedData } from "@miyoria/contracts/events";

/** `Events.AgentMessageExcluded.type`, for the memory module that still names it this way. */
export const MESSAGE_EXCLUDED_TOPIC = AgentMessageExcluded.type;

/** The payload of `Events.AgentMessageExcluded` (contract: `MessageExcludedSchema`). */
export type MessageExcluded = MessageExcludedData;
