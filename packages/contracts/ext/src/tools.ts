// Tools: what an extension declares (`tools.register`, `contributions.tools`) and what the host
// sends when the agent calls one (`tools.call`).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonObjectSchema,
  JsonValueSchema,
  MessageRefSchema,
} from "../../wire/src/index.js";

/** A tool, as `tools.register` and `contributions.tools` carry it. */
export const ExtToolDeclSchema = z
  .object({
    /**
     * Wire name, e.g. `"weather.now"`. Dots become `_` in the agent's tool registry
     * (`weather_now`) because model APIs reject them.
     */
    name: z.string(),
    description: z.string(),
    /** JSON Schema of the arguments object. Missing means an object with no properties. */
    parameters: JsonValueSchema.default(() => ({ type: "object", properties: {} })),
    /** Permission node the triggering user needs; `null`: none. */
    permission: z.string().nullable().default(null),
    /**
     * It only looks (a lookup, a status): several such calls in one step run at the same time.
     */
    read_only: z.boolean().default(false),
  })
  .meta({ id: "ExtToolDecl" });
export type ExtToolDecl = z.output<typeof ExtToolDeclSchema>;
export type ExtToolDeclIn = z.input<typeof ExtToolDeclSchema>;

/** Why the agent is running a turn, which decides what it may do. */
export const ExtPrioritySchema = z
  .enum(["system", "direct", "request", "initiative", "idle"])
  .meta({ id: "ExtPriority" });
export type ExtPriority = z.output<typeof ExtPrioritySchema>;

/** `context` of `tools.call`: the turn, where it runs and who triggered it. */
export const ExtToolCallContextSchema = z
  .object({
    turn: z.string(),
    context: ContextKeySchema,
    /** Author of the message that triggered the turn: the permission is checked for them. */
    account: AccountRefSchema,
    message: MessageRefSchema,
    priority: ExtPrioritySchema,
  })
  .meta({ id: "ExtToolCallContext" });
export type ExtToolCallContext = z.output<typeof ExtToolCallContextSchema>;

/** `tools.call` params (host to extension). `name` is the one the extension registered. */
export const ExtToolCallParamsSchema = z
  .object({
    name: z.string(),
    args: JsonObjectSchema.default(() => ({})),
    context: ExtToolCallContextSchema,
  })
  .meta({ id: "ExtToolCallParams" });
export type ExtToolCallParams = z.output<typeof ExtToolCallParamsSchema>;
export type ExtToolCallParamsIn = z.input<typeof ExtToolCallParamsSchema>;

/**
 * `tools.call` result as the SDK writes it. The host also accepts a bare string, and turns any
 * other JSON into text for the model.
 */
export const ExtToolCallResultSchema = z
  .object({ content: z.string() })
  .meta({ id: "ExtToolCallResult" });
export type ExtToolCallResult = z.output<typeof ExtToolCallResultSchema>;
