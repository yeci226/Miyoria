// The optional MCP server Miyoria exposes to external agents (Claude Code and the like).
// Read-only on purpose: it can inspect Miyoria, never make her act.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MIYORIA_VERSION } from "@miyoria/llm/llm";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  errorMessage,
  getLogger,
  type ModuleContext,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import { DecisionLogKey } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ProfileIdKey } from "./services.js";
import { McpStatusKey } from "./status.js";

const log = getLogger("mcp.server");

const DEFAULT_DECISIONS = 20;
const MAX_DECISIONS = 200;

export class McpServeError extends Error {
  override readonly name = "McpServeError";
}

/** The read-only tools. Services are looked up per call: their modules may restart any time. */
export class ExposedTools {
  constructor(readonly ctx: ModuleContext) {}

  status(): JsonValue {
    const sup = this.ctx.services.require(SupervisorKey);
    const modules = sup.list();
    const notRunning = modules
      .filter((m) => m.enabled && m.state !== "running")
      .map((m) => ({ id: m.id, state: m.state, reason: m.reason }));
    const registry = this.ctx.services.get(ToolRegistryKey);
    const mcp = this.ctx.services.get(McpStatusKey);
    return {
      version: MIYORIA_VERSION,
      modules_total: modules.length,
      modules_not_running: notRunning,
      registered_tools: registry ? registry.names().length : null,
      mcp_servers: mcp ? (mcp.servers() as unknown as JsonValue) : null,
    };
  }

  listModules(): JsonValue {
    return this.ctx.services.require(SupervisorKey).list() as unknown as JsonValue;
  }

  listTools(): JsonValue {
    const registry = this.ctx.services.require(ToolRegistryKey);
    return registry.specs().map((s) => ({ name: s.name, description: s.description }));
  }

  async recentDecisions(args: Record<string, unknown>): Promise<JsonValue> {
    const raw = args.limit;
    const requested =
      typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_DECISIONS;
    const limit = Math.min(Math.max(requested, 1), MAX_DECISIONS);
    const decisions = this.ctx.services.require(DecisionLogKey);
    const profile = this.ctx.services.require(ProfileIdKey);
    return (await decisions.recent(profile, null, limit)) as unknown as JsonValue;
  }
}

const NO_ARGS = { type: "object" as const, properties: {} };

export const EXPOSED_TOOL_LIST = [
  {
    name: "status",
    description:
      "Overall health: module counts, modules that are not running, tool count, MCP client connections.",
    inputSchema: NO_ARGS,
  },
  { name: "list_modules", description: "State of every module.", inputSchema: NO_ARGS },
  {
    name: "list_tools",
    description: "Names and descriptions of every tool the model can currently call.",
    inputSchema: NO_ARGS,
  },
  {
    name: "recent_decisions",
    description: "Most recent attention decisions (why she did or did not reply), newest first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DECISIONS,
          description: "How many records to return (default 20).",
        },
      },
    },
  },
];

function textResult(value: JsonValue, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

/** One MCP server instance (stateless: one per HTTP request). */
export function exposedServer(tools: ExposedTools): McpServer {
  const server = new McpServer(
    { name: "miyoria", version: MIYORIA_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only view of a running Miyoria instance: module health, registered tools and recent attention decisions.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: EXPOSED_TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    let outcome: () => JsonValue | Promise<JsonValue>;
    switch (request.params.name) {
      case "status":
        outcome = () => tools.status();
        break;
      case "list_modules":
        outcome = () => tools.listModules();
        break;
      case "list_tools":
        outcome = () => tools.listTools();
        break;
      case "recent_decisions":
        outcome = () => tools.recentDecisions(args);
        break;
      default:
        throw new McpError(ErrorCode.InvalidParams, `unknown tool \`${request.params.name}\``);
    }
    try {
      return textResult(await outcome(), false);
    } catch (error) {
      return textResult({ error: errorMessage(error) }, true);
    }
  });
  return server;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time bearer token check. An empty configured token never matches. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ")
    ? header.slice(7)
    : header?.startsWith("bearer ")
      ? header.slice(7)
      : "";
  return timingSafeEqual(digest(presented), digest(token)) && token !== "";
}

/** Hostname of a `Host` header (without port, without IPv6 brackets). */
function hostName(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end < 0 ? host : host.slice(1, end);
  }
  const colon = host.lastIndexOf(":");
  return colon < 0 ? host : host.slice(0, colon);
}

export interface ExposeOptions {
  ctx: ModuleContext;
  token: string;
  extraHosts: readonly string[];
}

function reply(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

/** Request handler: bearer token, `Host` check, then Streamable HTTP MCP at `/mcp`. */
export function exposeHandler(options: ExposeOptions) {
  const hosts = new Set(["localhost", "127.0.0.1", "::1", ...options.extraHosts]);
  const tools = new ExposedTools(options.ctx);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokenMatches(req.headers.authorization, options.token)) {
      reply(res, 401, "missing or invalid bearer token", { "www-authenticate": "Bearer" });
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp" && !path.startsWith("/mcp/")) {
      reply(res, 404, "not found");
      return;
    }
    const host = req.headers.host;
    if (host === undefined || !(hosts.has(hostName(host)) || hosts.has(host))) {
      reply(res, 403, "Forbidden: Host header is not allowed");
      return;
    }
    const server = exposedServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "MCP request failed");
      if (!res.headersSent) reply(res, 500, "internal error");
    }
  };
}

/** Splits `host:port` / `[v6]:port`. */
export function parseBind(addr: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/u.exec(addr) ?? /^([^:]+):(\d+)$/u.exec(addr);
  if (!m) throw new McpServeError(`cannot bind MCP server to \`${addr}\`: invalid address`);
  return { host: m[1] as string, port: Number(m[2]) };
}

/** Binds the listener (so a busy port is reported at start). */
export async function bind(
  addr: string,
  handler: ReturnType<typeof exposeHandler>,
): Promise<Server> {
  const { host, port } = parseBind(addr);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => log.warn({ err }, "MCP handler failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(
        new McpServeError(`cannot bind MCP server to \`${addr}\`: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

/** `ip:port` of a listening server (IPv6 in brackets). */
export function localAddress(server: Server): string | null {
  const a = server.address() as AddressInfo | string | null;
  if (a === null || typeof a === "string") return a;
  return a.family === "IPv6" ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`;
}

/** Serves until `signal` aborts, then closes the listener and open connections. */
export async function serveUntil(server: Server, signal: AbortSignal): Promise<void> {
  server.on("error", (err) => log.warn({ err }, "MCP server error"));
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
