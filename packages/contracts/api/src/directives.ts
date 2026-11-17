// The owner's rules: what is in force, a new one, and ending one. The panel only says who is
// asking: a session is its account, and the bearer token has every right. What that person may do
// is the directive service's decision, so a moderator on the panel can do what one on Discord can;
// the handler answers a refusal with `403` (authority), `404` (nothing matches), `503` (the store
// did not answer) or `400` (the request itself is wrong, or too many short rules are open).

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { ContextKeyInSchema } from "./shared.js";

/** `deny` and `require_approval` are enforced; `prefer` and `avoid` are only said to her. */
export const DirectiveEffectSchema = z
  .enum(["deny", "require_approval", "prefer", "avoid"])
  .meta({ id: "ApiDirectiveEffect" });
export type DirectiveEffect = z.output<typeof DirectiveEffectSchema>;

/** Highest first. `viewer` is everyone else: their rule can only ever be a short `prefer`. */
export const DirectiveAuthoritySchema = z
  .enum(["owner", "moderator", "system", "viewer"])
  .meta({ id: "ApiDirectiveAuthority" });
export type DirectiveAuthority = z.output<typeof DirectiveAuthoritySchema>;

/** What a rule applies to. Every field narrows it; a field left out does not. */
export const DirectiveScopeSchema = z
  .object({
    /** A capability or tool name, or a pattern (`game.*`, `*`). */
    capability: z.string().optional(),
    /** A word of what is being done: the game (`minecraft`), a goal, a target (`diamond`). */
    activity: z.string().optional(),
    context: ContextKeySchema.optional(),
    /** A person's stable handle. */
    person: z.string().optional(),
  })
  .meta({ id: "ApiDirectiveScope" });
export type DirectiveScope = z.output<typeof DirectiveScopeSchema>;

/** A stored rule and how it ended, if someone ended it. */
export const DirectiveRecordSchema = z
  .object({
    id: z.string(),
    issuer: AccountRefSchema,
    authority: DirectiveAuthoritySchema,
    scope: DirectiveScopeSchema,
    effect: DirectiveEffectSchema,
    /** In the issuer's words: 「不要玩 Minecraft」. */
    text: z.string(),
    /** `until_revoked` never expires. */
    expires: z.union([TimestampSchema, z.literal("until_revoked")]),
    /** An EventLog id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
    source_event: z.string(),
    created_at: TimestampSchema,
    revoked_at: TimestampSchema.nullable(),
    /** The account (`discord:1`) or panel actor that removed it. */
    revoked_by: z.string().nullable(),
  })
  .meta({ id: "ApiDirectiveRecord" });
export type DirectiveRecord = z.output<typeof DirectiveRecordSchema>;

/** A rule as an added one is reported (a removed one may also say how it ended). */
export const DirectiveSchema = z
  .object({
    id: z.string(),
    issuer: AccountRefSchema,
    authority: DirectiveAuthoritySchema,
    scope: DirectiveScopeSchema,
    effect: DirectiveEffectSchema,
    text: z.string(),
    expires: z.union([TimestampSchema, z.literal("until_revoked")]),
    source_event: z.string(),
    created_at: TimestampSchema,
  })
  .meta({ id: "ApiDirective" });
export type Directive = z.output<typeof DirectiveSchema>;

/** `healthy` is false while the store cannot be read (everything fails closed). */
export const DirectivesViewSchema = z
  .object({ healthy: z.boolean(), directives: z.array(DirectiveRecordSchema) })
  .meta({ id: "ApiDirectivesView" });
export type DirectivesView = z.output<typeof DirectivesViewSchema>;

/** Body of `POST /api/directives`. `minutes` left out: until revoked (a moderator has to say). */
export const AddDirectiveRequestSchema = z
  .object({
    text: z.string().min(1),
    effect: DirectiveEffectSchema,
    scope: z
      .object({
        capability: z.string().optional(),
        activity: z.string().optional(),
        context: ContextKeyInSchema.optional(),
        person: z.string().optional(),
      })
      .prefault({}),
    minutes: z.number().int().positive().nullable().default(null),
  })
  .meta({ id: "ApiAddDirectiveRequest" });
export type AddDirectiveRequest = z.input<typeof AddDirectiveRequestSchema>;

/**
 * The answer of a change: a `question` means nothing happened and the Core needs more (`200`);
 * a rule added is `201`; a rule ended is `200`.
 */
export const DirectiveChangeSchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("added"),
      directive: DirectiveSchema,
      note: z.string().nullable(),
    }),
    z.object({
      status: z.literal("removed"),
      directive: DirectiveSchema.extend({
        /** The rule as the store kept it, with how it ended (the service reports it so). */
        revoked_at: TimestampSchema.nullable().optional(),
        revoked_by: z.string().nullable().optional(),
      }),
    }),
    z.object({ status: z.literal("question"), question: z.string() }),
  ])
  .meta({ id: "ApiDirectiveChange" });
export type DirectiveChange = z.output<typeof DirectiveChangeSchema>;

export const directives = {
  /** `history` adds the ended ones; the handler reads exactly `"1"` as on. */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/directives" })
    .input(z.object({ query: z.object({ history: z.string().optional() }) }))
    .output(DirectivesViewSchema),
  add: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/directives", successStatus: 201 })
    .input(z.object({ body: AddDirectiveRequestSchema }))
    .output(DirectiveChangeSchema),
  remove: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/directives/{id}" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(DirectiveChangeSchema),
};
