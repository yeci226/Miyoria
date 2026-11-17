// The one registry of tools. A module registers a `Tool` here (a capability's tool is registered
// by the gate's `ActuatorRegistry`, and runs through the gate); the current turn reads it
// through `names` / `specs` / `get`, the new turn runner through `entries` / `entry` / `run`.

import { errorMessage } from "@miyoria/runtime/kernel";
import { type JsonValue, serviceKey } from "@miyoria/types";
import type { z } from "zod";
import type { ToolSpec } from "../../llm/src/index.js";
import { findTools, type ToolCatalog, type ToolListing } from "./find.js";
import { LoadedTools } from "./loaded.js";
import {
  DEFAULT_TOOL_META,
  type Tool,
  type ToolContext,
  type ToolEffect,
  type ToolResult,
  type ToolRisk,
  type ToolSpeed,
} from "./tool.js";

export class InvalidToolNameError extends Error {
  override readonly name = "InvalidToolNameError";

  constructor(readonly toolName: string) {
    super(`invalid tool name \`${toolName}\``);
  }
}

/** 1–64 ASCII letters, digits, `_` or `-` (what every provider accepts). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

/** A registered tool with everything the registry knows about it. */
export interface ToolEntry extends ToolListing {
  /** JSON Schema of the arguments, as sent to the model. */
  parameters: JsonValue;
  /** The zod schema it came from; `null` when the JSON Schema is written by hand. */
  schema: z.ZodType | null;
  effect: ToolEffect;
  speed: ToolSpeed;
  risk: ToolRisk;
  /** Only for the new turn runner (`ToolMeta.next`). */
  next: boolean;
  /** The tool said what it does itself; `false`: the fields above are `DEFAULT_TOOL_META`. */
  declared: boolean;
  tool: Tool;
}

function entryOf(tool: Tool): ToolEntry {
  const meta = tool.meta ?? DEFAULT_TOOL_META;
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    schema: tool.parameters ?? null,
    effect: meta.effect,
    speed: meta.speed,
    risk: meta.risk,
    group: meta.group,
    core: meta.core === true,
    next: meta.next === true,
    declared: tool.meta !== undefined,
    tool,
  };
}

/** Every tool, by name. */
export class ToolRegistry implements ToolCatalog {
  readonly #tools = new Map<string, Tool>();
  /** Names the current turn sees, in order, kept until a tool is registered or removed. */
  #sorted: string[] | null = null;
  /** What each session found with `find_tools` or brought in with a skill. */
  readonly loaded = new LoadedTools();

  constructor() {
    this.register(findTools(this));
  }

  /** Registers (or replaces) a tool under `spec.name`. Throws `InvalidToolNameError`. */
  register(tool: Tool): void {
    const name = tool.spec.name;
    if (!isValidToolName(name)) throw new InvalidToolNameError(name);
    this.#sorted = null;
    this.#tools.set(name, tool);
  }

  unregister(name: string): boolean {
    const removed = this.#tools.delete(name);
    if (removed) this.#sorted = null;
    return removed;
  }

  /** The tool the current turn may call under `name` (not one only for the new runner). */
  get(name: string): Tool | undefined {
    const tool = this.#tools.get(name);
    return tool?.meta?.next === true ? undefined : tool;
  }

  #current(): string[] {
    this.#sorted ??= [...this.#tools]
      .filter(([, tool]) => tool.meta?.next !== true)
      .map(([name]) => name)
      .sort();
    return this.#sorted;
  }

  /** Names of the tools the current turn sees, in order. */
  names(): string[] {
    return [...this.#current()];
  }

  /** Specs of the tools the current turn sees, ordered by name. */
  specs(): ToolSpec[] {
    return this.#current().map((n) => (this.#tools.get(n) as Tool).spec);
  }

  /** No tool for the current turn. */
  get isEmpty(): boolean {
    return this.#current().length === 0;
  }

  /** Any registered tool, with what it does. */
  entry(name: string): ToolEntry | undefined {
    const tool = this.#tools.get(name);
    return tool ? entryOf(tool) : undefined;
  }

  /** Every registered tool, ordered by name. */
  entries(): ToolEntry[] {
    return [...this.#tools.keys()].sort().map((n) => entryOf(this.#tools.get(n) as Tool));
  }

  listings(): ToolListing[] {
    return this.entries();
  }

  /**
   * The tools the new turn runner offers `session`: the always-on ones by name, then what the
   * session loaded, in the order it loaded them. A loaded name that is no longer registered
   * keeps its place in the list and is skipped here.
   */
  offered(session: string): ToolEntry[] {
    const core = this.entries().filter((e) => e.core);
    const loaded = this.loaded
      .loaded(session)
      .flatMap((name) => this.entry(name) ?? [])
      .filter((e) => !e.core);
    return [...core, ...loaded];
  }

  /**
   * Calls a tool and gives the outcome as a value: a refusal by the gate, a dropped call and a
   * failure come back with a code and the text for the model. An abort of `ctx.signal` is
   * rethrown.
   */
  async run(name: string, ctx: ToolContext, args: JsonValue): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { ok: false, code: "unknown_tool", stage: null, text: `unknown tool \`${name}\`` };
    }
    try {
      if (tool.result) return await tool.result(ctx, args);
      return { ok: true, text: await tool.call(ctx, args) };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return { ok: false, code: "failed", stage: null, text: errorMessage(error) };
    }
  }
}

export const ToolRegistryKey = serviceKey<ToolRegistry>("ToolRegistry");
