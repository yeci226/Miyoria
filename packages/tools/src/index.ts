// @miyoria/tools: tools the model may call during a turn.
//
// The app creates one `ToolRegistry` at boot and provides it as `ToolRegistryKey`; any module
// (memory, extensions, MCP, ...) may register and unregister tools at any time. The agent
// offers the registered tools to the model and checks permissions against the user who
// triggered the turn, never against the model.

import type { ToolSpec } from "@miyoria/llm";
import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  type MessageRef,
  type Principal,
  type Priority,
  serviceKey,
  type TurnId,
} from "@miyoria/types";

export type { ToolSpec } from "@miyoria/llm";

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
  /** The message that triggered the turn (the latest one). */
  message: MessageRef;
  /** Priority for actions the tool submits (same as her reply). */
  priority: Priority;
  /** Aborted when the turn is cancelled. */
  signal: AbortSignal;
}

export interface Tool {
  /** Name, description and JSON Schema of the arguments shown to the model. */
  readonly spec: ToolSpec;
  /** Permission node the triggering user needs, if any. */
  readonly permission?: string | null;
  /**
   * Runs the tool. The returned text (or the error message) goes back to the model, so keep it
   * short.
   */
  call(ctx: ToolContext, args: JsonValue): Promise<string>;
}

export class InvalidToolNameError extends Error {
  override readonly name = "InvalidToolNameError";

  constructor(readonly toolName: string) {
    super(`invalid tool name \`${toolName}\``);
  }
}

/** 1–64 ASCII letters, digits, `_` or `-` (what every provider accepts). */
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

/** Every tool offered to the model, by name. */
/**
 * Tools only other modules call (like `internal_threads_feed`): the registry keeps them, the
 * model is never offered them.
 */
export function isInternalTool(name: string): boolean {
  return name.startsWith("internal_");
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  /** Registers (or replaces) a tool under `spec.name`. Throws `InvalidToolNameError`. */
  register(tool: Tool): void {
    const name = tool.spec.name;
    if (!isValidToolName(name)) throw new InvalidToolNameError(name);
    this.#tools.set(name, tool);
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** Registered names, in order. */
  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** Specs of every registered tool, ordered by name. */
  specs(): ToolSpec[] {
    return this.names()
      .filter((n) => !isInternalTool(n))
      .map((n) => (this.#tools.get(n) as Tool).spec);
  }

  get isEmpty(): boolean {
    return this.#tools.size === 0;
  }
}

export const ToolRegistryKey = serviceKey<ToolRegistry>("ToolRegistry");
