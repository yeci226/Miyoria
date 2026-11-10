// Extension runtime: `defineExtension`, the `ctx` API and the client side of
// the extension protocol (docs/protocols/extension-rpc.md).

import type { Readable, Writable } from "node:stream";
import { type GameAdapter, type RegisteredAdapter, registerGameAdapter } from "./game.js";
import { RpcError, RpcPeer } from "./rpc.js";
import { type TaskExecutor, type TaskExecutorInfoInput, TaskFailure, type TaskSteer } from "./task.js";
import { topicMatches } from "./topics.js";
import {
  type ArgKind,
  type ExecutorDecl,
  type CommandReply,
  type CommandSpec,
  type Contributions,
  type Envelope,
  ErrorCode,
  type InitializeParams,
  type InitializeResult,
  type Invocation,
  type JsonSchema,
  type Permissions,
  type PromptRequest,
  type PromptSection,
  type ToolCallContext,
  type ToolDecl,
} from "./types.js";

// ---- definitions ------------------------------------------------------------

export interface ToolDefinition {
  /** Wire name, may contain dots, e.g. `"weather.now"`. */
  name: string;
  description: string;
  /**
   * Shorthand: JSON Schema of each argument. Every argument is required
   * unless listed in `optional`.
   */
  params?: Record<string, JsonSchema>;
  optional?: string[];
  /** Full JSON Schema of the arguments object (wins over `params`). */
  parameters?: JsonSchema;
  /** Permission node the triggering user needs. */
  permission?: string;
  /** Returns the text the model sees; non-strings are JSON encoded. */
  run(args: Record<string, any>, ctx: ToolCallContext): unknown;
}

export interface CommandArg {
  name: string;
  description: string;
  /** Default `"string"`; `choices` makes it a choice. */
  type?: "string" | "integer" | "boolean" | "user" | "role";
  choices?: string[];
  /** Default `true`. */
  required?: boolean;
}

export interface CommandDefinition {
  /** `"hello"` or `"dice roll"` (one to three lowercase words). */
  path: string | string[];
  description: string;
  args?: CommandArg[];
  /** Permission node; empty = everyone. */
  permission?: string;
  ephemeral?: boolean;
  run(invocation: Invocation): string | CommandReply | Promise<string | CommandReply>;
}

/** A prompt section; `key` defaults to the contributor key, `order` to 100. */
export interface PromptSectionInput {
  title: string;
  body: string;
  key?: string;
  order?: number;
}

export type PromptContributor = (
  request: PromptRequest,
) => PromptSectionInput[] | Promise<PromptSectionInput[]>;

export type EventHandler = (envelope: Envelope) => void | Promise<void>;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface ExtensionContext {
  readonly id: string;
  readonly version: string;
  /** Absolute extension directory. */
  readonly dir: string;
  /** `[extensions."<id>"]` without `enabled` / `permissions`. */
  readonly config: Record<string, unknown>;
  /** What the host granted. */
  readonly permissions: Permissions;
  readonly host: { name: string; version: string };
  readonly tools: {
    register(tool: ToolDefinition): Promise<void>;
    unregister(name: string): Promise<void>;
  };
  readonly commands: {
    register(command: CommandDefinition): Promise<void>;
    unregister(path: string | string[]): Promise<void>;
  };
  readonly events: {
    /** Subscribes to a topic pattern; returns an unsubscribe function. */
    on(pattern: string, handler: EventHandler): () => void;
    /** Publishes a custom event (needs a granted pattern, or `ext.<id>.*`). */
    publish(topic: string, payload?: unknown, options?: { correlation?: string }): Promise<void>;
  };
  readonly prompt: {
    register(key: string, contribute: PromptContributor): Promise<void>;
    unregister(key: string): Promise<void>;
  };
  /** Per-extension key-value storage kept by the host. */
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  readonly log: Logger;
  readonly game: {
    /**
     * Game id this extension owns (manifest `game` with kind `game-adapter`);
     * `undefined` when it is not a declared game adapter.
     */
    readonly id: string | undefined;
    /**
     * Exposes a game adapter as the task executor of `game.<id>` (its `tasks`, or its `act`
     * wrapped as one-step tasks) and events `game.<id>.*`. `describe().id` must equal
     * `ctx.game.id`.
     */
    registerAdapter(adapter: GameAdapter): Promise<RegisteredAdapter>;
  };
  /** The task contract (docs/design/v2-architecture.md §3.8). */
  readonly tasks: {
    /**
     * Makes `executor` this extension's task executor (one per extension; a second call
     * replaces it). The core starts, cancels and observes through it; its events are sent to
     * the host, which publishes them on `<owner>.task.<type>` (`game.<id>` for a game adapter,
     * `ext.<id>` otherwise).
     */
    register(executor: TaskExecutor, info: TaskExecutorInfoInput): Promise<void>;
  };
  /** Runs before the process exits on `shutdown`. */
  onShutdown(hook: () => void | Promise<void>): void;
}

export interface ExtensionDefinition {
  activate(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---- conversion helpers -----------------------------------------------------

/** Wire declaration of a tool definition. */
export function toolDecl(tool: ToolDefinition): ToolDecl {
  let parameters = tool.parameters;
  if (!parameters) {
    const properties = tool.params ?? {};
    const optional = new Set(tool.optional ?? []);
    parameters = {
      type: "object",
      properties,
      required: Object.keys(properties).filter((k) => !optional.has(k)),
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    permission: tool.permission ?? null,
  };
}

export function commandPath(path: string | string[]): string[] {
  return Array.isArray(path) ? path : path.split(/\s+/).filter(Boolean);
}

/** Wire spec of a command definition. */
export function commandSpec(command: CommandDefinition): CommandSpec {
  return {
    path: commandPath(command.path),
    description: command.description,
    args: (command.args ?? []).map((a) => {
      const kind: ArgKind = a.choices
        ? { type: "choice", choices: a.choices }
        : { type: a.type ?? "string" };
      return { name: a.name, description: a.description, kind, required: a.required ?? true };
    }),
    permission: command.permission ?? "",
    ephemeral: command.ephemeral ?? false,
  };
}

/** A refused `task.start` / failed `task.observe`: the failure code travels in `data.code`. */
function taskError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof TaskFailure) {
    const code = error.code === "invalid" ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    return new RpcError(code, error.message, { code: error.code });
  }
  return new RpcError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error), {
    code: "internal",
  });
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

// ---- runtime ----------------------------------------------------------------

export interface RunOptions {
  input: Readable;
  output: Writable;
  /** Called after `shutdown` hooks ran, or when the host goes away. */
  exit?: (code: number) => void;
  /** Timeout of requests to the host (ms). */
  timeoutMs?: number;
}

type Phase = "waiting" | "activating" | "active" | "stopping";

/** One running extension: answers host requests and implements `ctx`. */
export class ExtensionRuntime {
  readonly peer: RpcPeer;
  readonly #def: ExtensionDefinition;
  readonly #exit: (code: number) => void;
  #phase: Phase = "waiting";
  #pending: Contributions = { tools: [], commands: [], prompts: [], subscriptions: [] };
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #commands = new Map<string, CommandDefinition>();
  readonly #prompts = new Map<string, PromptContributor>();
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #shutdownHooks: Array<() => void | Promise<void>> = [];
  #executor: TaskExecutor | null = null;

  constructor(def: ExtensionDefinition, opts: RunOptions) {
    this.#def = def;
    this.#exit = opts.exit ?? (() => {});
    this.peer = new RpcPeer({
      input: opts.input,
      output: opts.output,
      timeoutMs: opts.timeoutMs ?? 10_000,
      onRequest: (method, params, signal) => this.#onRequest(method, params, signal),
      onNotification: (method, params) => this.#onNotification(method, params),
      onClose: () => {
        if (this.#phase !== "stopping") this.#exit(0);
      },
    });
  }

  get phase(): Phase {
    return this.#phase;
  }

  async #onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.#initialize(params as InitializeParams);
      case "tools.call": {
        const p = params as { name: string; args?: Record<string, unknown>; context: ToolCallContext };
        const tool = this.#tools.get(p.name);
        if (!tool) throw new RpcError(ErrorCode.MethodNotFound, `unknown tool "${p.name}"`);
        // `signal` aborts when the host stops waiting (timed out, the turn was cancelled).
        return { content: toText(await tool.run(p.args ?? {}, { ...p.context, signal })) };
      }
      case "commands.invoke": {
        const inv = params as Invocation;
        const key = inv.path.join(" ");
        const command = this.#commands.get(key);
        if (!command) throw new RpcError(ErrorCode.MethodNotFound, `unknown command "${key}"`);
        const reply = await command.run(inv);
        return typeof reply === "string" ? { text: reply } : reply;
      }
      case "prompt.contribute": {
        const p = params as { key: string; request: PromptRequest };
        const contribute = this.#prompts.get(p.key);
        if (!contribute) throw new RpcError(ErrorCode.MethodNotFound, `unknown prompt "${p.key}"`);
        const sections: PromptSection[] = (await contribute(p.request)).map((s) => ({
          key: s.key ?? p.key,
          title: s.title,
          body: s.body,
          order: s.order ?? 100,
        }));
        return { sections };
      }
      case "task.start": {
        const executor = this.#taskExecutor();
        const p = params as { task?: unknown };
        try {
          await executor.start(p.task as Parameters<TaskExecutor["start"]>[0], signal);
        } catch (error) {
          throw taskError(error);
        }
        return {};
      }
      case "task.cancel": {
        const p = params as { task?: unknown };
        if (typeof p.task !== "string") throw new RpcError(ErrorCode.InvalidParams, "task.cancel needs `task`");
        await this.#taskExecutor().cancel(p.task);
        return {};
      }
      case "task.steer": {
        const executor = this.#taskExecutor();
        const steer = (params as { steer?: unknown } | null)?.steer as Record<string, unknown> | undefined;
        if (typeof steer !== "object" || steer === null || typeof steer.id !== "string" || typeof steer.task !== "string") {
          throw new RpcError(ErrorCode.InvalidParams, "task.steer needs `steer` with `id` and `task`");
        }
        if (typeof executor.steer !== "function") {
          throw new RpcError(ErrorCode.MethodNotFound, "this task executor cannot be steered");
        }
        try {
          await executor.steer(steer as unknown as TaskSteer);
        } catch (error) {
          throw taskError(error);
        }
        return {};
      }
      case "task.observe":
        try {
          return await this.#taskExecutor().observe(signal);
        } catch (error) {
          throw taskError(error);
        }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `unknown method "${method}"`);
    }
  }

  #taskExecutor(): TaskExecutor {
    if (!this.#executor) throw new RpcError(ErrorCode.MethodNotFound, "this extension has no task executor");
    return this.#executor;
  }

  /** Sends every event of `executor` to the host (`task.event`) while it is the registered one. */
  #pump(executor: TaskExecutor): void {
    const stream = executor.events()[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const next = await stream.next();
        if (next.done || this.#executor !== executor) break;
        this.peer.notify("task.event", { event: next.value });
      }
      await stream.return?.();
    })().catch((error: unknown) => this.#log("error", "task event stream failed", { error: String(error) }));
  }

  #onNotification(method: string, params: unknown): void {
    if (method === "event") {
      this.#deliver(params as Envelope);
    } else if (method === "shutdown") {
      void this.shutdown();
    }
  }

  async #initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.#phase !== "waiting") throw new RpcError(ErrorCode.InvalidRequest, "already initialized");
    this.#phase = "activating";
    await this.#def.activate(this.#context(params));
    this.#phase = "active";
    const contributions = this.#pending;
    this.#pending = { tools: [], commands: [], prompts: [], subscriptions: [] };
    if (contributions.executor === undefined) delete contributions.executor;
    return { contributions };
  }

  /** Runs shutdown hooks and `deactivate`, then exits. */
  async shutdown(): Promise<void> {
    if (this.#phase === "stopping") return;
    this.#phase = "stopping";
    for (const hook of this.#shutdownHooks) {
      try {
        await hook();
      } catch (error) {
        this.#log("error", "shutdown hook failed", { error: String(error) });
      }
    }
    try {
      await this.#def.deactivate?.();
    } catch (error) {
      this.#log("error", "deactivate failed", { error: String(error) });
    }
    this.peer.close();
    this.#exit(0);
  }

  #deliver(envelope: Envelope): void {
    for (const [pattern, handlers] of this.#handlers) {
      if (!topicMatches(pattern, envelope.topic)) continue;
      for (const handler of handlers) {
        Promise.resolve()
          .then(() => handler(envelope))
          .catch((error: unknown) =>
            this.#log("error", "event handler failed", { topic: envelope.topic, error: String(error) }),
          );
      }
    }
  }

  #log(level: string, message: string, fields?: LogFields): void {
    this.peer.notify("log", fields ? { level, message, fields } : { level, message });
  }

  /** During activation registrations are batched into the `initialize` result. */
  async #contribute(batch: () => void, method: string, params: unknown): Promise<void> {
    if (this.#phase === "activating") {
      batch();
      return;
    }
    await this.peer.request(method, params);
  }

  #context(init: InitializeParams): ExtensionContext {
    const rt = this;
    const log = (level: string) => (message: string, fields?: LogFields) =>
      rt.#log(level, message, fields);
    const ctx: ExtensionContext = {
      id: init.extension.id,
      version: init.extension.version,
      dir: init.extension.dir,
      config: init.config ?? {},
      permissions: init.permissions,
      host: init.host,
      tools: {
        async register(tool) {
          const decl = toolDecl(tool);
          rt.#tools.set(decl.name, tool);
          try {
            await rt.#contribute(() => rt.#pending.tools.push(decl), "tools.register", decl);
          } catch (error) {
            rt.#tools.delete(decl.name);
            throw error;
          }
        },
        async unregister(name) {
          rt.#tools.delete(name);
          rt.#pending.tools = rt.#pending.tools.filter((t) => t.name !== name);
          if (rt.#phase === "active") await rt.peer.request("tools.unregister", { name });
        },
      },
      commands: {
        async register(command) {
          const spec = commandSpec(command);
          const key = spec.path.join(" ");
          rt.#commands.set(key, command);
          try {
            await rt.#contribute(() => rt.#pending.commands.push(spec), "commands.register", spec);
          } catch (error) {
            rt.#commands.delete(key);
            throw error;
          }
        },
        async unregister(path) {
          const words = commandPath(path);
          const key = words.join(" ");
          rt.#commands.delete(key);
          rt.#pending.commands = rt.#pending.commands.filter((c) => c.path.join(" ") !== key);
          if (rt.#phase === "active") await rt.peer.request("commands.unregister", { path: words });
        },
      },
      events: {
        on(pattern, handler) {
          let set = rt.#handlers.get(pattern);
          if (!set) {
            set = new Set();
            rt.#handlers.set(pattern, set);
            if (rt.#phase === "activating") rt.#pending.subscriptions.push(pattern);
            else
              rt.peer.request("events.subscribe", { topics: [pattern] }).catch((error: unknown) =>
                rt.#log("error", "subscribe failed", { pattern, error: String(error) }),
              );
          }
          set.add(handler);
          return () => {
            const current = rt.#handlers.get(pattern);
            if (!current?.delete(handler) || current.size > 0) return;
            rt.#handlers.delete(pattern);
            if (rt.#phase === "activating") {
              rt.#pending.subscriptions = rt.#pending.subscriptions.filter((p) => p !== pattern);
            } else if (rt.#phase === "active") {
              rt.peer.request("events.unsubscribe", { topics: [pattern] }).catch(() => {});
            }
          };
        },
        async publish(topic, payload, options) {
          await rt.peer.request("events.publish", {
            topic,
            payload: payload ?? null,
            ...(options?.correlation ? { correlation: options.correlation } : {}),
          });
        },
      },
      prompt: {
        async register(key, contribute) {
          rt.#prompts.set(key, contribute);
          try {
            await rt.#contribute(() => rt.#pending.prompts.push(key), "prompt.register", { key });
          } catch (error) {
            rt.#prompts.delete(key);
            throw error;
          }
        },
        async unregister(key) {
          rt.#prompts.delete(key);
          rt.#pending.prompts = rt.#pending.prompts.filter((k) => k !== key);
          if (rt.#phase === "active") await rt.peer.request("prompt.unregister", { key });
        },
      },
      storage: {
        async get<T>(key: string) {
          const r = await rt.peer.request<{ value: T | null }>("storage.get", { key });
          return r.value ?? undefined;
        },
        async set(key, value) {
          await rt.peer.request("storage.set", { key, value: value ?? null });
        },
        async delete(key) {
          await rt.peer.request("storage.set", { key, value: null });
        },
      },
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
      game: {
        id: init.extension.game ?? undefined,
        registerAdapter: (adapter) => registerGameAdapter(ctx, adapter),
      },
      tasks: {
        async register(executor, info) {
          const decl: ExecutorDecl = {
            name: info.name,
            goals: info.goals.map((g) => ({
              name: g.name,
              description: g.description,
              parameters: g.parameters ?? null,
              budget_s: g.budget_s ?? null,
            })),
            guide: info.guide?.trim() ? info.guide.trim() : null,
          };
          // Only said when true: the declaration of an executor without it stays as it was.
          if (typeof executor.steer === "function") decl.steer = true;
          const previous = rt.#executor;
          rt.#executor = executor;
          try {
            await rt.#contribute(
              () => {
                rt.#pending.executor = decl;
              },
              "tasks.register",
              decl,
            );
          } catch (error) {
            rt.#executor = previous;
            throw error;
          }
          rt.#pump(executor);
        },
      },
      onShutdown(hook) {
        rt.#shutdownHooks.push(hook);
      },
    };
    return ctx;
  }
}

/** Runs an extension over the given streams (tests, custom transports). */
export function runExtension(def: ExtensionDefinition, opts: RunOptions): ExtensionRuntime {
  return new ExtensionRuntime(def, opts);
}

const STARTED = Symbol.for("miyoria.sdk.started");

/**
 * Runs an extension over stdin / stdout. stdout carries the protocol, so
 * `console.log` / `info` / `debug` are redirected to stderr (the host logs it).
 */
export function startStdio(def: ExtensionDefinition): ExtensionRuntime {
  const g = globalThis as Record<symbol, unknown>;
  if (g[STARTED]) throw new Error("an extension is already running in this process");
  g[STARTED] = true;
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return runExtension(def, {
    input: process.stdin,
    output: process.stdout,
    exit: (code) => process.exit(code),
  });
}

/**
 * Declares an extension. When launched by the Miyoria host
 * (`MIYORIA_RPC=stdio`), it starts serving the protocol on the next tick.
 */
export function defineExtension<T extends ExtensionDefinition>(def: T): T {
  if (process.env.MIYORIA_RPC === "stdio") {
    setImmediate(() => {
      if (!(globalThis as Record<symbol, unknown>)[STARTED]) startStdio(def);
    });
  }
  return def;
}
