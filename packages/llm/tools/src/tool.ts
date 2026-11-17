// What a tool is: its spec for the model, what it does to the world, and how it is called.

import type {
  AccountRef,
  ContextKey,
  JsonValue,
  MessageRef,
  Principal,
  Priority,
  TurnId,
} from "@miyoria/types";
import { z } from "zod";
import type { ImagePart, ToolSpec } from "../../llm/src/index.js";

/** What a tool call is running on behalf of. */
export interface ToolContext {
  turn: TurnId;
  context: ContextKey;
  /** Author of the message that triggered the turn. */
  account: AccountRef;
  /**
   * On whose behalf the call runs: `user` (the author asked) in reactive turns, `director` for
   * the game director. Capability tools pass it to the gate.
   */
  principal: Principal;
  /**
   * Everyone the turn speaks for, when more than one person's messages are in it. `account` is
   * only the one she answers: a tool whose result depends on who asked takes the weakest of them.
   */
  askers?: readonly AccountRef[];
  /** The message that triggered the turn (the latest one). */
  message: MessageRef;
  /** Priority for actions the tool submits (same as her reply). */
  priority: Priority;
  /** Aborted when the turn is cancelled. */
  signal: AbortSignal;
  /** Takes what a capability answered besides its text (`{task}`: it only got accepted). */
  report?: (data: JsonValue) => void;
}

/**
 * What a call does to the world: `read` only looks, `say` puts her words in front of people,
 * `act` changes her own state or what she is doing, `spend` moves coins, `external` reaches
 * outside the app (the web, a sandbox, another program).
 */
export type ToolEffect = "read" | "say" | "act" | "spend" | "external";
export const TOOL_EFFECTS: readonly ToolEffect[] = ["read", "say", "act", "spend", "external"];

/** `long`: the call only starts something that finishes later (a song, a game, a broadcast). */
export type ToolSpeed = "instant" | "long";
export const TOOL_SPEEDS: readonly ToolSpeed[] = ["instant", "long"];

/** The gate's tiers; a capability tool carries its capability's. */
export type ToolRisk = "low" | "medium" | "high";
export const TOOL_RISKS: readonly ToolRisk[] = ["low", "medium", "high"];

/** What the registry knows about a tool besides its spec. */
export interface ToolMeta {
  effect: ToolEffect;
  speed: ToolSpeed;
  risk: ToolRisk;
  /** Topic key `find_tools` searches by (`economy`, `party`, `memory`, `web`, ...). */
  group: string;
  /** One of the tools the new turn runner always offers; the rest are found with `find_tools`. */
  core?: boolean;
  /**
   * Only for the new turn runner: `ToolRegistry.names`, `specs` and `get`, which the current
   * turn reads, leave it out. `entries`, `entry` and `run` have it.
   */
  next?: boolean;
}

/** What a tool that says nothing about itself is taken for (an MCP or extension tool). */
export const DEFAULT_TOOL_META: ToolMeta = {
  effect: "external",
  speed: "instant",
  risk: "medium",
  group: "other",
};

/** Why a call gave no result: the gate refused it, it was dropped before running, or it failed. */
export type ToolRefusalCode = "denied" | "dropped" | "failed" | "unknown_tool";

/** A call's outcome as a value. `text` is what goes back to the model either way. */
export type ToolResult =
  | {
      ok: true;
      text: string;
      /**
       * Pictures the call fetched for the model to look at. The chat format has images in `user`
       * messages only, so the runner offers them in one after the step's results; `text` says
       * what they are.
       */
      images?: readonly ImagePart[];
    }
  | {
      ok: false;
      code: ToolRefusalCode;
      /** `denied`: where the gate decided (`rate`, `review`, `directive`, ...). */
      stage: string | null;
      text: string;
    };

export interface Tool {
  /** Name, description and JSON Schema of the arguments shown to the model. */
  readonly spec: ToolSpec;
  /** Effect, speed, risk and group. Unset: `DEFAULT_TOOL_META`. */
  readonly meta?: ToolMeta;
  /** The zod schema `spec.parameters` was derived from; unset when the JSON Schema is written by hand. */
  readonly parameters?: z.ZodType;
  /** Permission node the triggering user needs, if any. */
  readonly permission?: string | null;
  /**
   * It acts for the person who asked (their wallet, their request, their limits). In a turn where
   * several people called her at once, the call must say whom it is for: the agent offers it a
   * `for_whom` argument then, takes it off before `call`, and refuses a call that does not say.
   */
  readonly actsFor?: boolean;
  /**
   * It only looks (a search, a balance, a file): it changes nothing anyone else reads, so when
   * the model asks for several in one step they run at the same time. Unset: one at a time.
   */
  readonly readOnly?: boolean;
  /**
   * Its answer already holds whatever came from outside in data blocks (`dataBlock`), with only
   * its own words around them. The agent passes such an answer on as it is instead of wrapping it
   * in one more block, which would only break the inner tags. Only for a tool whose own code
   * writes the whole answer, never one that relays another program's.
   */
  readonly framed?: boolean;
  /**
   * Runs the tool. The returned text (or the error message) goes back to the model, so keep it
   * short.
   */
  call(ctx: ToolContext, args: JsonValue): Promise<string>;
  /**
   * Runs the tool like `call`, with a refusal as a value instead of a thrown error. Unset:
   * `ToolRegistry.run` wraps `call`.
   */
  result?(ctx: ToolContext, args: JsonValue): Promise<ToolResult>;
}

/**
 * The JSON Schema of a tool's arguments from its zod schema, in the form the hand-written ones
 * have: no `$schema`, no `additionalProperties: false`, no bounds on an integer that only say it
 * is a safe one.
 */
export function toolParameters(schema: z.ZodType): JsonValue {
  const json = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
    },
  });
  delete json.$schema;
  return json as JsonValue;
}

/** A tool's spec with its arguments written as a zod object. */
export function toolSpec(name: string, description: string, parameters: z.ZodType): ToolSpec {
  return { name, description, parameters: toolParameters(parameters) };
}

/** A tool written as one object: zod arguments, what it does, and the call. */
export interface ToolDefinition extends ToolMeta {
  name: string;
  description: string;
  parameters: z.ZodType;
  permission?: string | null;
  actsFor?: boolean;
  readOnly?: boolean;
  framed?: boolean;
  call(ctx: ToolContext, args: JsonValue): Promise<string>;
}

export function defineTool(definition: ToolDefinition): Tool {
  const { name, description, parameters, permission, actsFor, readOnly, framed, call, ...meta } =
    definition;
  return {
    spec: toolSpec(name, description, parameters),
    meta,
    parameters,
    ...(permission === undefined ? {} : { permission }),
    ...(actsFor === undefined ? {} : { actsFor }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(framed === undefined ? {} : { framed }),
    call,
  };
}
