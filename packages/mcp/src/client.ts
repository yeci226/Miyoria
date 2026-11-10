// The MCP client side: one supervised connection per configured server whose tools are
// mirrored into the `ToolRegistry`.

import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Stream } from "node:stream";
import { errorMessage, getLogger, sleep, withTimeout } from "@miyoria/kernel";
import { MIYORIA_VERSION } from "@miyoria/llm";
import type { Tool, ToolContext, ToolRegistry, ToolSpec } from "@miyoria/tools";
import { type Clock, isJsonObject, type JsonValue } from "@miyoria/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool as McpToolInfo,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import {
  flattenResult,
  frameResult,
  registryName,
  stdioEnv,
  ToolFilter,
  truncateChars,
} from "./policy.js";
import type { McpStatus } from "./status.js";

const log = getLogger("mcp.client");

/** How long a closing connection gets before we stop waiting. */
const CLOSE_GRACE_MS = 5_000;

/** Thrown by MCP tools; the message goes back to the model. */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
}

/** A connection attempt or session failure. */
export class McpConnectionError extends Error {
  override readonly name = "McpConnectionError";
}

/**
 * Registers tools in the shared registry and remembers what it added, so everything can be
 * removed on stop. After `close` nothing more can be registered.
 */
export class Registrar {
  readonly #registry: ToolRegistry;
  readonly #names = new Set<string>();
  #closed = false;

  constructor(registry: ToolRegistry) {
    this.#registry = registry;
  }

  register(tool: Tool): void {
    if (this.#closed) throw new McpConnectionError("MCP module is stopping");
    this.#registry.register(tool);
    this.#names.add(tool.spec.name);
  }

  unregister(name: string): void {
    if (this.#names.delete(name)) this.#registry.unregister(name);
  }

  /** Removes every tool this registrar added and refuses new ones. */
  close(): void {
    this.#closed = true;
    for (const name of this.#names) this.#registry.unregister(name);
    this.#names.clear();
  }
}

/** A tool of an MCP server, as the model sees it. */
class McpTool implements Tool {
  constructor(
    readonly spec: ToolSpec,
    readonly server: string,
    readonly remoteName: string,
    readonly permission: string | null,
    readonly client: Client,
    readonly timeoutMs: number,
    readonly maxResultChars: number,
  ) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    let params: { name: string; arguments?: Record<string, unknown> };
    if (isJsonObject(args)) params = { name: this.remoteName, arguments: args };
    else if (args === null) params = { name: this.remoteName };
    else {
      throw new McpToolError(`tool arguments must be a JSON object, got ${JSON.stringify(args)}`);
    }
    let result: CallToolResult;
    try {
      result = (await this.client.callTool(params, undefined, {
        timeout: this.timeoutMs,
        signal: ctx.signal,
      })) as CallToolResult;
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpToolError(
          `MCP tool \`${this.remoteName}\` on server \`${this.server}\` timed out after ${this.timeoutMs} ms`,
          { cause: error },
        );
      }
      throw new McpToolError(
        `MCP tool \`${this.remoteName}\` on server \`${this.server}\` failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const text = frameResult(
      this.server,
      this.remoteName,
      truncateChars(flattenResult(result), this.maxResultChars),
    );
    if (result.isError === true) throw new McpToolError(text);
    return text;
  }
}

/** Why one connection attempt / session ended. */
type SessionEnd =
  | { kind: "cancelled" }
  /** Never got as far as `connected`. */
  | { kind: "connect_failed"; error: unknown }
  /** Was connected, then lost or broke. */
  | { kind: "lost"; error: unknown; livedMs: number };

/** Message of an error with its cause chain (like anyhow's `{:#}`). */
function chain(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  while (cur !== undefined && cur !== null && parts.length < 8) {
    const msg = errorMessage(cur);
    // Skip causes whose text is already part of the message they were wrapped in.
    if (!parts.some((p) => p.includes(msg))) parts.push(msg);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(": ");
}

/** A one-shot-at-a-time wake-up (like `tokio::sync::Notify::notify_one`). */
class Notify {
  #pending = false;
  #waiter: (() => void) | null = null;

  notify(): void {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w();
    } else this.#pending = true;
  }

  wait(): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }
}

export interface ServerRunnerOptions {
  name: string;
  config: ServerConfig;
  status: McpStatus;
  registrar: Registrar;
  backoffInitialMs: number;
  backoffMaxMs: number;
  clock: Clock;
}

/** Keeps one server connected for as long as the module runs. */
export class ServerRunner {
  readonly name: string;
  readonly config: ServerConfig;
  readonly #status: McpStatus;
  readonly #registrar: Registrar;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #clock: Clock;
  #connects = 0;

  constructor(options: ServerRunnerOptions) {
    this.name = options.name;
    this.config = options.config;
    this.#status = options.status;
    this.#registrar = options.registrar;
    this.#backoffInitialMs = options.backoffInitialMs;
    this.#backoffMaxMs = options.backoffMaxMs;
    this.#clock = options.clock;
  }

  /** Connects, mirrors tools and reconnects with backoff until `signal` aborts. Never rejects. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.#backoffInitialMs;
    for (;;) {
      this.#status.update(this.name, (s) => {
        s.state = "connecting";
      });
      const end = await this.#session(signal);
      this.#clear();
      if (end.kind === "cancelled") break;
      if (end.kind === "lost" && end.livedMs >= this.#backoffMaxMs) {
        backoff = this.#backoffInitialMs;
      }
      const message = chain(end.error);
      log.warn(
        { server: this.name, error: message, retry_in_ms: backoff },
        "MCP server unavailable",
      );
      this.#status.update(this.name, (s) => {
        s.state = "failed";
        s.tools = [];
        s.last_error = message;
      });
      try {
        await sleep(backoff, signal);
      } catch {
        break;
      }
      backoff = Math.min(backoff * 2, this.#backoffMaxMs);
    }
    this.#clear();
    log.debug({ server: this.name }, "MCP server runner stopped");
  }

  /** Unregisters this server's tools. */
  #clear(): void {
    for (const name of this.#status.server(this.name)?.tools ?? []) {
      this.#registrar.unregister(name);
    }
    this.#status.update(this.name, (s) => {
      s.tools = [];
    });
  }

  async #session(signal: AbortSignal): Promise<SessionEnd> {
    if (signal.aborted) return { kind: "cancelled" };
    const toolsChanged = new Notify();
    let closed = false;
    let onClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      onClosed = resolve;
    });
    let client: Client;
    try {
      client = await connect(this.name, this.config, {
        signal,
        onToolsChanged: () => toolsChanged.notify(),
        onClose: () => {
          closed = true;
          onClosed();
        },
      });
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      return { kind: "connect_failed", error };
    }

    const filter = new ToolFilter(this.config.tools_allow, this.config.tools_deny);
    let livedFrom: number | null = null;
    let failure: unknown = null;
    const aborted = new Promise<"abort">((resolve) => {
      if (signal.aborted) resolve("abort");
      signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });
    try {
      await this.#syncTools(client, filter);
      this.#connects += 1;
      livedFrom = this.#clock.now();
      const reconnects = Math.max(this.#connects - 1, 0);
      this.#status.update(this.name, (s) => {
        s.state = "connected";
        s.reconnects = reconnects;
      });
      log.info({ server: this.name }, "MCP server connected");
      for (;;) {
        const what = await Promise.race([
          aborted,
          closedPromise.then(() => "closed" as const),
          toolsChanged.wait().then(() => "changed" as const),
        ]);
        if (what === "abort") break;
        if (what === "closed") throw new McpConnectionError("connection closed");
        log.debug({ server: this.name }, "MCP tool list changed");
        await this.#syncTools(client, filter);
      }
    } catch (error) {
      failure = error;
    }

    // Closing the client also ends the child process.
    if (!closed) {
      const done = await withTimeout(
        client.close().then(
          () => true,
          () => true,
        ),
        CLOSE_GRACE_MS,
      );
      if (done === undefined)
        log.warn({ server: this.name }, "MCP connection did not close in time");
    }
    if (signal.aborted || failure === null) return { kind: "cancelled" };
    if (livedFrom === null) return { kind: "connect_failed", error: failure };
    return { kind: "lost", error: failure, livedMs: this.#clock.now() - livedFrom };
  }

  /** Lists the server's tools and makes the registry match the allowed ones. */
  async #syncTools(client: Client, filter: ToolFilter): Promise<void> {
    const listed = await listAllTools(client, this.config.connectTimeoutMs);
    const remoteCount = listed.length;
    const allowed = listed
      .filter((t) => filter.allows(t.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const permission = this.config.permissionNode(this.name);
    const wanted = new Map<string, Tool>();
    const taken = new Set<string>();
    for (const tool of allowed) {
      const name = registryName(this.name, tool.name, taken);
      if (name === null) {
        log.warn(
          { server: this.name, tool: tool.name },
          "cannot derive a unique tool name, skipping",
        );
        continue;
      }
      taken.add(name);
      const schema: Record<string, unknown> = { ...(tool.inputSchema ?? {}) };
      if (Object.keys(schema).length === 0) schema.type = "object";
      const description = tool.description ?? tool.title ?? tool.name;
      wanted.set(
        name,
        new McpTool(
          { name, description, parameters: schema as JsonValue },
          this.name,
          tool.name,
          permission,
          client,
          this.config.callTimeoutMs,
          this.config.max_result_chars,
        ),
      );
    }

    const previous = this.#status.server(this.name)?.tools ?? [];
    for (const old of previous) if (!wanted.has(old)) this.#registrar.unregister(old);
    const registered: string[] = [];
    for (const name of [...wanted.keys()].sort()) {
      try {
        this.#registrar.register(wanted.get(name) as Tool);
        registered.push(name);
      } catch (error) {
        log.warn(
          { server: this.name, tool: name, error: errorMessage(error) },
          "cannot register MCP tool",
        );
      }
    }
    this.#status.update(this.name, (s) => {
      s.tools = registered;
      s.remote_tool_count = remoteCount;
    });
  }
}

async function listAllTools(client: Client, timeoutMs: number): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    let page: Awaited<ReturnType<Client["listTools"]>>;
    try {
      page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: timeoutMs,
      });
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpConnectionError("timed out listing tools", { cause: error });
      }
      throw new McpConnectionError(`cannot list tools: ${errorMessage(error)}`, { cause: error });
    }
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor !== "");
  return out;
}

interface ConnectOptions {
  signal: AbortSignal;
  onToolsChanged: () => void;
  onClose: () => void;
}

function newClient(options: ConnectOptions): Client {
  const client = new Client({ name: "miyoria", version: MIYORIA_VERSION }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    options.onToolsChanged();
  });
  client.onclose = options.onClose;
  client.onerror = (err) => log.debug({ err }, "MCP transport error");
  return client;
}

function isSpawnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves `command` through `PATH` (and `PATHEXT` on Windows, so shims like `npx.cmd` work),
 * like rmcp's `which_command`. Returns `null` when nothing matches.
 */
export function whichCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === "win32";
  const exts = windows
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")]
    : [""];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const ext of exts) if (isFile(command + ext)) return command + ext;
    return null;
  }
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Opens the transport and runs the MCP handshake, within the connect timeout. */
async function connect(
  name: string,
  config: ServerConfig,
  options: ConnectOptions,
): Promise<Client> {
  const timeoutMs = config.connectTimeoutMs;
  const client = newClient(options);
  if (config.effectiveTransport() === "stdio") {
    const command = config.command ?? "";
    if (whichCommand(command) === null) {
      throw new McpConnectionError(`cannot start \`${command}\`: program not found`);
    }
    // Not the whole host environment: it holds the Discord and LLM tokens.
    const env = stdioEnv(process.env, config.env_pass, config.env);
    const transport = new StdioClientTransport({
      command,
      args: config.args,
      env,
      stderr: "pipe",
      ...(config.cwd !== null ? { cwd: config.cwd } : {}),
    });
    const tail: string[] = [];
    collectStderr(transport.stderr, name, tail);
    try {
      await withConnectTimeout(
        client.connect(transport, { timeout: timeoutMs, signal: options.signal }),
        timeoutMs,
        transport,
      );
    } catch (error) {
      if (isSpawnError(error)) {
        throw new McpConnectionError(`cannot start \`${command}\`: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      // Let the stderr reader catch up so the cause is included.
      await sleep(20);
      const lines = tail.join(" | ");
      throw new McpConnectionError(
        lines === ""
          ? `MCP handshake failed: ${errorMessage(error)}`
          : `MCP handshake failed: ${errorMessage(error)} (stderr: ${lines})`,
        { cause: error },
      );
    }
    return client;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(config.headers)) {
    if (key.toLowerCase() === "authorization") {
      const token = value.startsWith("Bearer ")
        ? value.slice(7)
        : value.startsWith("bearer ")
          ? value.slice(7)
          : null;
      if (token === null) {
        throw new McpConnectionError('only `Authorization = "Bearer <token>"` is supported');
      }
      headers.set("authorization", `Bearer ${token.trim()}`);
      continue;
    }
    try {
      headers.set(key, value);
    } catch (error) {
      throw new McpConnectionError(`invalid header \`${key}\`: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ""), {
    requestInit: { headers },
  });
  try {
    await withConnectTimeout(
      client.connect(transport, { timeout: timeoutMs, signal: options.signal }),
      timeoutMs,
      transport,
    );
  } catch (error) {
    throw new McpConnectionError(`MCP handshake failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return client;
}

async function withConnectTimeout(
  connecting: Promise<void>,
  timeoutMs: number,
  transport: { close(): Promise<void> },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpConnectionError(`timed out connecting after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([connecting, timeout]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    void connecting.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function collectStderr(stream: Stream | null, server: string, tail: string[]): void {
  if (!stream) return;
  let partial = "";
  stream.on("data", (chunk: Buffer | string) => {
    const text = partial + chunk.toString();
    const lines = text.split(/\r?\n/u);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      log.debug({ server }, `stderr: ${line}`);
      if (tail.length >= 5) tail.shift();
      tail.push(line);
    }
  });
  stream.on("end", () => {
    if (partial !== "") {
      if (tail.length >= 5) tail.shift();
      tail.push(partial);
      partial = "";
    }
  });
  stream.on("error", () => undefined);
}
