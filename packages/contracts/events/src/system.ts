// The kernel and the scheduler (docs/design/v5-contracts.md §3, K12a): a module's state changed,
// Core is shutting down, and an action of hers left the scheduler. Each type is the bus topic it is
// published on, and its payload is that event's data.
//
// Tiers (v5-data §2.5): all kept 90 days (`short`), `action.*` as the data doc says. Module states
// name modules and their failures: for the owner (`owner`). The shutdown is her own state with no
// outside source (`self`). An action belongs to the session it was done in (no default scope).

import { z } from "zod";
import {
  ActionIdSchema,
  ContextKeySchema,
  MessageRefSchema,
  ModuleIdSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

export const ModuleStateKindSchema = z
  .enum(["disabled", "starting", "running", "degraded", "stopping", "stopped", "failed"])
  .meta({ id: "EventsModuleStateKind" });

/** A module's state changed: `system.module.state`. */
export const ModuleStateSchema = z
  .object({
    module: ModuleIdSchema,
    state: ModuleStateKindSchema,
    reason: z.string().nullable(),
  })
  .meta({ id: "EventsModuleState" });
export type ModuleStateData = z.output<typeof ModuleStateSchema>;

/** Core is shutting down: `system.shutdown`. Nothing in it. */
export const SystemShutdownSchema = z.object({}).meta({ id: "EventsSystemShutdown" });
export type SystemShutdownData = z.output<typeof SystemShutdownSchema>;

/**
 * A message she sent, as the platform created it. `blocked`: moderation replaced what she meant
 * (the rule), so this is not her line reaching anyone.
 */
export const SentMessageSchema = MessageRefSchema.extend({
  blocked: z.string().optional(),
}).meta({ id: "EventsSentMessage" });

/** An action ended: `action.completed`. */
export const ActionCompletedSchema = z
  .object({
    action: ActionIdSchema,
    turn: TurnIdSchema.nullable(),
    ok: z.boolean(),
    error: z.string().nullable(),
    /** The message a successful `send_message` created. */
    message: SentMessageSchema.nullable(),
  })
  .meta({ id: "EventsActionCompleted" });
export type ActionCompletedData = z.output<typeof ActionCompletedSchema>;

/**
 * How a line of hers left the scheduler: `action.settled`, next to `action.completed` for every
 * `send_message` and `speak`. `error` `expired`, `cancelled` or `coalesced`: it never went out.
 */
export const ActionSettledSchema = z
  .object({
    action: ActionIdSchema,
    turn: TurnIdSchema.nullable(),
    type: z.enum(["send_message", "speak"]),
    context: ContextKeySchema,
    text: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
    message: SentMessageSchema.nullable(),
    /** Moderation replaced the line (the rule): what she meant did not reach anyone. */
    blocked: z.string().nullable().optional(),
  })
  .meta({ id: "EventsActionSettled" });
export type ActionSettledData = z.output<typeof ActionSettledSchema>;

export const SystemModuleState = defineEvent({
  type: "system.module.state",
  v: 1,
  data: ModuleStateSchema,
  scope: "owner",
  tier: "short",
});

export const SystemShutdown = defineEvent({
  type: "system.shutdown",
  v: 1,
  data: SystemShutdownSchema,
  scope: "self",
  tier: "short",
});

export const ActionCompleted = defineEvent({
  type: "action.completed",
  v: 1,
  data: ActionCompletedSchema,
  tier: "short",
});

export const ActionSettled = defineEvent({
  type: "action.settled",
  v: 1,
  data: ActionSettledSchema,
  tier: "short",
});

/** Every kernel and scheduler type. */
export const SYSTEM_EVENTS = [
  SystemModuleState,
  SystemShutdown,
  ActionCompleted,
  ActionSettled,
] as const;
