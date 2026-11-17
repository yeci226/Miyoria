// What she was told, read-only: the saved, compressed prompts of recent turns (without their text,
// newest first) and one in full (the blocks with what the budget did to each, and the messages as
// sent).

import { z } from "zod";
import { ContextKeySchema, TimestampSchema, TurnIdSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { DigitsQuery } from "./shared.js";

/** How deeply the model reasoned for a purpose. */
export const ReasoningLevelSchema = z
  .enum(["off", "low", "medium", "high"])
  .meta({ id: "ApiReasoningLevel" });
export type ReasoningLevel = z.output<typeof ReasoningLevelSchema>;

/** What the compiler did with one block of the prompt. */
export const CompiledBlockSchema = z
  .object({
    key: z.string(),
    /** `self`: her own state; `data`: derived from other people or the outside. */
    authority: z.enum(["self", "data"]),
    /** Provenance shown in the data block. */
    source: z.string(),
    /** Characters before and after budgeting. */
    chars_in: z.number(),
    chars_out: z.number(),
    budget_chars: z.number(),
    fate: z.enum(["kept", "summarized", "truncated", "dropped"]),
  })
  .meta({ id: "ApiCompiledBlock" });
export type CompiledBlock = z.output<typeof CompiledBlockSchema>;

/** A compressed copy of the prompt one turn actually sent. */
export const SavedPromptSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    at: TimestampSchema,
    /** The LLM purpose (`chat`). */
    purpose: z.string(),
    reasoning: ReasoningLevelSchema,
    blocks: z.array(CompiledBlockSchema),
    /** The messages as sent, possibly compressed (long history elided). */
    messages: z.array(
      z.object({ role: z.enum(["system", "user", "assistant"]), text: z.string() }),
    ),
    /** Prompt tokens as the provider reported them (`null`: not reported). */
    prompt_tokens: z.number().nullable(),
  })
  .meta({ id: "ApiSavedPrompt" });
export type SavedPrompt = z.output<typeof SavedPromptSchema>;

/** One saved prompt without its blocks and messages. */
export const PromptSummarySchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    at: TimestampSchema,
    purpose: z.string(),
    reasoning: ReasoningLevelSchema,
    prompt_tokens: z.number().nullable(),
    blocks: z.number(),
    messages: z.number(),
    /** Characters of all kept messages. */
    chars: z.number(),
  })
  .meta({ id: "ApiPromptSummary" });
export type PromptSummary = z.output<typeof PromptSummarySchema>;

export const prompts = {
  /**
   * The saved prompts of recent turns, newest first. `context` is a JSON-encoded context key that
   * the server decodes (not JSON: 400); `limit` defaults to 30 and is held to 1..200.
   */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/prompts" })
    .input(
      z.object({
        query: z.object({ context: z.string().optional(), limit: DigitsQuery.optional() }),
      }),
    )
    .output(z.array(PromptSummarySchema)),
  /** One in full; `404` when it is too old or was not kept. */
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/prompts/{turn}" })
    .input(z.object({ params: z.object({ turn: z.string() }) }))
    .output(SavedPromptSchema),
};
