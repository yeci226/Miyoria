// Wire types of the extension protocol (`docs/protocols/extension-rpc.md`).

import type { CommandSpec } from "@miyoria/commands";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { Permissions } from "./manifest.js";

/** Protocol version sent in `initialize`. */
export const PROTOCOL_VERSION = 1;

/** `initialize` params (host → extension). */
export interface InitializeParams {
  protocol: number;
  host: HostInfo;
  extension: ExtensionInfo;
  /** `[extensions."<id>"]` without `enabled` / `permissions`. */
  config: JsonValue;
  /** What the host actually grants (declared ∩ config override). */
  permissions: Permissions;
}

export interface HostInfo {
  name: string;
  version: string;
}

export interface ExtensionInfo {
  id: string;
  version: string;
  dir: string;
  /** Game id owned by a declared game adapter (manifest `game`), else `null`. */
  game: string | null;
}

/** `tools.register` params and `contributions.tools` entries. */
export interface ToolDecl {
  /**
   * Wire name, e.g. `"weather.now"`. Dots become `_` in the agent's tool registry
   * (`weather_now`) because model APIs reject them.
   */
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: JsonValue;
  /** Permission node the triggering user needs. */
  permission: string | null;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.json() as z.ZodType<JsonValue>;

export const ToolDeclSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: JsonValueSchema.default(() => ({ type: "object", properties: {} })),
  permission: z.string().nullable().default(null),
});

const ArgKindSchema = z.union([
  z.object({ type: z.enum(["string", "integer", "boolean", "user", "role"]) }),
  z.object({ type: z.literal("choice"), choices: z.array(z.string()) }),
]);

/** `CommandSpec` as serde reads it (every field required, like the Rust struct). */
export const CommandSpecSchema = z.object({
  path: z.array(z.string()),
  description: z.string(),
  args: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      kind: ArgKindSchema,
      required: z.boolean(),
    }),
  ),
  permission: z.string(),
  ephemeral: z.boolean(),
}) satisfies z.ZodType<CommandSpec>;

/** `tasks.register` params and `contributions.executor`: the extension's task executor. */
export const ExecutorDeclSchema = z.object({
  /** Display name (`Minecraft`). */
  name: z.string().min(1).max(64),
  goals: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        description: z.string().max(2000),
        parameters: JsonValueSchema.nullable().default(null),
        budget_s: z.number().positive().max(86_400).nullable().default(null),
      }),
    )
    .max(64)
    .default([]),
  guide: z.string().max(8000).nullable().default(null),
  /** The executor implements `task.steer`. Absent (an older extension) means it does not. */
  steer: z.boolean().default(false),
});

export type ExecutorDecl = z.output<typeof ExecutorDeclSchema>;

/** Everything registered during activation, applied by the host at once. */
export const ContributionsSchema = z.object({
  tools: z.array(ToolDeclSchema).default([]),
  commands: z.array(CommandSpecSchema).default([]),
  /** Prompt contributor keys. */
  prompts: z.array(z.string()).default([]),
  /** Topic patterns to receive as `event` notifications. */
  subscriptions: z.array(z.string()).default([]),
  /** The extension's task executor, if it has one (`tasks.register`). */
  executor: ExecutorDeclSchema.nullable().default(null),
});

export type Contributions = z.output<typeof ContributionsSchema>;

/** `initialize` result (extension → host). */
export const InitializeResultSchema = z.object({
  contributions: ContributionsSchema.prefault({}),
});

export type InitializeResult = z.output<typeof InitializeResultSchema>;

/** Registry name of a tool's wire name. */
export function registryToolName(wire: string): string {
  return wire.replaceAll(".", "_");
}

/** Wire names: 1–64 chars of ASCII letters, digits, `_`, `-`, `.`. */
export function validToolName(wire: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(wire);
}
