// Prompt contributors: what the host sends when the agent builds a prompt (`prompt.contribute`)
// and what comes back.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema } from "../../wire/src/index.js";

export const ExtParticipantSchema = z
  .object({ account: AccountRefSchema, display_name: z.string(), person: z.string().nullable() })
  .meta({ id: "ExtParticipant" });
export type ExtParticipant = z.output<typeof ExtParticipantSchema>;

/** The prompt being built: what a contributor may read to decide what to add. */
export const ExtPromptRequestSchema = z
  .object({
    profile: z.string(),
    turn: z.string(),
    context: ContextKeySchema,
    participants: z.array(ExtParticipantSchema),
    speakers: z.array(AccountRefSchema),
    query: z.string(),
    recent: z.array(z.string()),
    voice: z.boolean(),
    now: z.string(),
  })
  .meta({ id: "ExtPromptRequest" });
export type ExtPromptRequest = z.output<typeof ExtPromptRequestSchema>;

/** `prompt.contribute` params. `key` is the one the extension registered. */
export const ExtPromptContributeParamsSchema = z
  .object({ key: z.string(), request: ExtPromptRequestSchema })
  .meta({ id: "ExtPromptContributeParams" });
export type ExtPromptContributeParams = z.output<typeof ExtPromptContributeParamsSchema>;

export const ExtPromptSectionSchema = z
  .object({
    key: z.string(),
    /** Heading shown to the model. */
    title: z.string(),
    body: z.string(),
    /** Lower comes first. */
    order: z.number().int(),
  })
  .meta({ id: "ExtPromptSection" });
export type ExtPromptSection = z.output<typeof ExtPromptSectionSchema>;

/** `prompt.contribute` result. Nothing to add is `{ "sections": [] }`. */
export const ExtPromptContributeResultSchema = z
  .object({ sections: z.array(ExtPromptSectionSchema).default([]) })
  .meta({ id: "ExtPromptContributeResult" });
export type ExtPromptContributeResult = z.output<typeof ExtPromptContributeResultSchema>;
