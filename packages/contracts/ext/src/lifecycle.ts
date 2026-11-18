// The handshake: `initialize` (host to extension) and what the extension answers with, every
// registration it made while activating.

import { z } from "zod";
import { JsonObjectSchema } from "../../wire/src/index.js";
import { ExtCommandSpecSchema } from "./commands.js";
import { ExtExecutorDeclSchema } from "./tasks.js";
import { ExtToolDeclSchema } from "./tools.js";

export const ExtHostInfoSchema = z
  .object({ name: z.string(), version: z.string() })
  .meta({ id: "ExtHostInfo" });
export type ExtHostInfo = z.output<typeof ExtHostInfoSchema>;

export const ExtExtensionInfoSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    /** The extension's directory. */
    dir: z.string(),
    /** The game a declared game adapter owns (manifest `game`), else `null`. */
    game: z.string().nullable().default(null),
  })
  .meta({ id: "ExtExtensionInfo" });
export type ExtExtensionInfo = z.output<typeof ExtExtensionInfoSchema>;
export type ExtExtensionInfoIn = z.input<typeof ExtExtensionInfoSchema>;

/** What the host grants: what the manifest declared, narrowed by the config. */
export const ExtPermissionsSchema = z
  .object({
    /** Topic patterns the extension may subscribe to and publish on (`"game.*"`, `"*"`). */
    events: z.array(z.string()),
    /** May register tools. */
    tools: z.boolean(),
    /** May register commands. */
    commands: z.boolean(),
    /** Hosts the extension talks to (informational; not a sandbox). */
    network: z.array(z.string()),
    /** High-risk input simulation (keyboard, mouse, ...), granted only when the config lists it. */
    input: z.array(z.string()),
  })
  .meta({ id: "ExtPermissions" });
export type ExtPermissions = z.output<typeof ExtPermissionsSchema>;

/** `initialize` params (host to extension). */
export const ExtInitializeParamsSchema = z
  .object({
    /** `EXT_PROTOCOL_VERSION`. */
    protocol: z.number().int(),
    host: ExtHostInfoSchema,
    extension: ExtExtensionInfoSchema,
    /** `[extensions."<id>"]` without `enabled` and `permissions`. */
    config: JsonObjectSchema,
    permissions: ExtPermissionsSchema,
  })
  .meta({ id: "ExtInitializeParams" });
export type ExtInitializeParams = z.output<typeof ExtInitializeParamsSchema>;
export type ExtInitializeParamsIn = z.input<typeof ExtInitializeParamsSchema>;

/** Everything registered during activation, applied by the host at once. Every part may be left out. */
export const ExtContributionsSchema = z
  .object({
    tools: z.array(ExtToolDeclSchema).default([]),
    commands: z.array(ExtCommandSpecSchema).default([]),
    /** Prompt contributor keys. */
    prompts: z.array(z.string()).default([]),
    /** Topic patterns to receive as `event` notifications. */
    subscriptions: z.array(z.string()).default([]),
    /** The extension's task executor, if it has one. */
    executor: ExtExecutorDeclSchema.nullable().default(null),
    /**
     * It answers the host's `status` request (`ExtStatusResult`): its card on the panel's system
     * page. An extension without it shows only its state. Optional, so no protocol bump.
     */
    status: z.boolean().default(false),
  })
  .meta({ id: "ExtContributions" });
export type ExtContributions = z.output<typeof ExtContributionsSchema>;
export type ExtContributionsIn = z.input<typeof ExtContributionsSchema>;

/**
 * The result of the host's `status` request (params `{}`), asked while the panel draws the
 * system page, with a 500 ms deadline: at most four facts (a label over a short value), the next
 * scheduled thing, the last error. Labels are the words the owner reads (zh-TW for her panel).
 */
export const ExtStatusResultSchema = z
  .object({
    facts: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          value: z.union([z.string().max(80), z.number()]),
          unit: z.string().max(16).optional(),
        }),
      )
      .max(4)
      .default([]),
    next: z.object({ label: z.string().max(40), at: z.string() }).optional(),
    last_error: z.object({ at: z.string(), message: z.string().max(400) }).optional(),
  })
  .meta({ id: "ExtStatusResult" });
export type ExtStatusResult = z.output<typeof ExtStatusResultSchema>;
export type ExtStatusResultIn = z.input<typeof ExtStatusResultSchema>;

/** `initialize` result (extension to host). */
export const ExtInitializeResultSchema = z
  .object({
    /**
     * The protocol version the extension speaks (`EXT_PROTOCOL_VERSION`). Protocol 1 had no such
     * field, so a result without it is from an extension that speaks 1.
     */
    protocol: z.number().int().default(1),
    contributions: ExtContributionsSchema.prefault({}),
  })
  .meta({ id: "ExtInitializeResult" });
export type ExtInitializeResult = z.output<typeof ExtInitializeResultSchema>;
export type ExtInitializeResultIn = z.input<typeof ExtInitializeResultSchema>;
