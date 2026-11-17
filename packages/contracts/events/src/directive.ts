// The owner's rules (docs/design/v5-contracts.md §3, K12a): a rule was added, removed or refused,
// or a proposal was dropped by the rules: `directive.changed`, whose payload is the bus event's
// data (the `body` of a `directive` log line).
//
// Small, and the "why" of later behaviour: kept forever (`keep`), like settings. Who set which rule
// is for the owner (`owner`); her prompts read the rules through the Directives service.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

export const DirectiveEffectSchema = z
  .enum(["deny", "require_approval", "prefer", "avoid"])
  .meta({ id: "EventsDirectiveEffect" });

export const DirectiveAuthoritySchema = z
  .enum(["owner", "moderator", "system", "viewer"])
  .meta({ id: "EventsDirectiveAuthority" });

/** What a rule applies to; every field narrows it. */
export const DirectiveScopeSchema = z
  .object({
    /** A capability or tool name, or a pattern (`game.*`, `*`). */
    capability: z.string().optional(),
    /** A word of what is being done (`minecraft`, `diamond`). */
    activity: z.string().optional(),
    context: ContextKeySchema.optional(),
    /** A person's handle. */
    person: z.string().optional(),
  })
  .meta({ id: "EventsDirectiveScope" });

/** One rule. */
export const DirectiveSchema = z
  .object({
    id: z.string(),
    issuer: AccountRefSchema,
    authority: DirectiveAuthoritySchema,
    scope: DirectiveScopeSchema,
    effect: DirectiveEffectSchema,
    /** In the issuer's words. */
    text: z.string(),
    /** `until_revoked` never expires. */
    expires: z.union([TimestampSchema, z.literal("until_revoked")]),
    /** What it came from: an event id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
    source_event: z.string(),
    created_at: TimestampSchema,
  })
  .meta({ id: "EventsDirective" });

/** A rule was added, removed or refused, or a proposal dropped: `directive.changed`. */
export const DirectiveChangedSchema = z
  .object({
    op: z.enum(["add", "remove", "refused", "proposal_dropped"]),
    /** What the panel shows. */
    text: z.string(),
    directive: DirectiveSchema.nullable(),
    /** Who did it (`discord:1`, a panel actor, `directive` for the rules themselves). */
    by: z.string(),
    /** `proposal_dropped`: which one. */
    proposal: z.string().optional(),
  })
  .meta({ id: "EventsDirectiveChanged" });
export type DirectiveChangedData = z.output<typeof DirectiveChangedSchema>;

export const DirectiveChanged = defineEvent({
  type: "directive.changed",
  v: 1,
  data: DirectiveChangedSchema,
  scope: "owner",
  tier: "keep",
});

/** Every directive type. */
export const DIRECTIVE_EVENTS = [DirectiveChanged] as const;
