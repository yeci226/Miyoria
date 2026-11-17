// Commands: what an extension declares (`commands.register`, `contributions.commands`) and what
// the host sends when someone runs one (`commands.invoke`).

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema } from "../../wire/src/index.js";

/** What an argument is: a plain kind, or `choice` with the choices it accepts. */
export const ExtArgKindSchema = z
  .union([
    z.object({ type: z.enum(["string", "integer", "boolean", "user", "role"]) }),
    z.object({ type: z.literal("choice"), choices: z.array(z.string()) }),
  ])
  .meta({ id: "ExtArgKind" });
export type ExtArgKind = z.output<typeof ExtArgKindSchema>;

export const ExtArgSpecSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    kind: ExtArgKindSchema,
    required: z.boolean(),
  })
  .meta({ id: "ExtArgSpec" });
export type ExtArgSpec = z.output<typeof ExtArgSpecSchema>;

/** A command, as `commands.register` and `contributions.commands` carry it. Every field is given. */
export const ExtCommandSpecSchema = z
  .object({
    /** One to three lowercase words (`["dice", "roll"]` is `/dice roll`). */
    path: z.array(z.string()),
    description: z.string(),
    args: z.array(ExtArgSpecSchema),
    /** Permission node; `""` is everyone. */
    permission: z.string(),
    ephemeral: z.boolean(),
  })
  .meta({ id: "ExtCommandSpec" });
export type ExtCommandSpec = z.output<typeof ExtCommandSpecSchema>;

/** The value of one argument. */
export const ExtArgValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .meta({ id: "ExtArgValue" });
export type ExtArgValue = z.output<typeof ExtArgValueSchema>;

/** What the platform knows about an account given in a `user` argument. */
export const ExtResolvedUserSchema = z
  .object({
    display_name: z.string(),
    platform_roles: z.array(z.string()),
    is_guild_admin: z.boolean(),
  })
  .meta({ id: "ExtResolvedUser" });
export type ExtResolvedUser = z.output<typeof ExtResolvedUserSchema>;

/** `commands.invoke` params (host to extension). The host has checked permission and types. */
export const ExtInvocationSchema = z
  .object({
    path: z.array(z.string()),
    args: z.record(z.string(), ExtArgValueSchema),
    invoker: AccountRefSchema,
    invoker_display_name: z.string(),
    context: ContextKeySchema,
    invoker_is_guild_admin: z.boolean(),
    /** Platform role ids of the invoker in that guild. Missing means none. */
    platform_roles: z.array(z.string()).optional(),
    /** By account id. Missing means none. */
    resolved_users: z.record(z.string(), ExtResolvedUserSchema).optional(),
  })
  .meta({ id: "ExtInvocation" });
export type ExtInvocation = z.output<typeof ExtInvocationSchema>;

/** `commands.invoke` result. The host also accepts a bare string. */
export const ExtCommandReplySchema = z
  .object({
    text: z.string(),
    /** Missing or `null` means the command spec's `ephemeral`. */
    ephemeral: z.boolean().nullable().optional(),
  })
  .meta({ id: "ExtCommandReply" });
export type ExtCommandReply = z.output<typeof ExtCommandReplySchema>;
