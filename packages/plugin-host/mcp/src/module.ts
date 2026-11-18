import type { Server } from "node:http";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  type Config,
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
} from "@miyoria/runtime/kernel";
import { Registrar, ServerRunner } from "./client.js";
import { type McpConfig, parseMcpConfig, reconnectInitialMs, reconnectMaxMs } from "./config.js";
import { bind, exposeHandler, localAddress, McpServeError, serveUntil } from "./server.js";
import { McpStatus, McpStatusKey, newServerStatus } from "./status.js";

export class McpStartError extends Error {
  override readonly name = "McpStartError";
}

interface Running {
  status: McpStatus;
  registrar: Registrar;
}

/**
 * Module `mcp`: connects to configured MCP servers and mirrors their tools into the shared
 * `ToolRegistry`; optionally serves a read-only MCP endpoint. Provides `McpStatusKey`; requires
 * the `ToolRegistryKey` service to exist.
 *
 * Its config is the top-level `[mcp]` section (not `[modules.mcp]`), passed to the constructor.
 */
export class McpModule implements Module {
  static readonly ID = "mcp";
  readonly manifest: ModuleManifest = defineManifest(McpModule.ID, "MCP", {
    icon: "plug",
    category: "system",
    description: "MCP client for external tools, optional read-only MCP server",
  });
  readonly config: McpConfig;
  #running: Running | null = null;

  constructor(config: McpConfig = parseMcpConfig(null)) {
    this.config = config;
  }

  /** Builds the module from the app config's top-level `[mcp]` section. */
  static fromAppConfig(config: Config): McpModule {
    return new McpModule(parseMcpConfig(config.section("mcp")));
  }

  /** Status of the current run, if the module is running. */
  status(): McpStatus | null {
    return this.#running?.status ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const registry = ctx.services.get(ToolRegistryKey);
    if (!registry) throw new McpStartError("the tool registry service is not available");
    const status = new McpStatus();
    const registrar = new Registrar(registry);

    for (const [name, server] of this.config.servers) {
      status.insert(
        newServerStatus(
          name,
          server.effectiveTransport(),
          server.permissionNode(name),
          server.displayTarget(),
        ),
      );
      if (!server.enabled) {
        status.update(name, (s) => {
          s.state = "disabled";
        });
        continue;
      }
      try {
        server.validate(name);
      } catch (error) {
        ctx.log.warn({ server: name, error: errorMessage(error) }, "invalid MCP server config");
        status.update(name, (s) => {
          s.state = "failed";
          s.last_error = `invalid config: ${errorMessage(error)}`;
        });
        continue;
      }
      const runner = new ServerRunner({
        name,
        config: server,
        status,
        registrar,
        backoffInitialMs: reconnectInitialMs(this.config),
        backoffMaxMs: reconnectMaxMs(this.config),
        clock: ctx.clock,
      });
      ctx.spawn("mcp-client", (signal) => runner.run(signal));
    }

    const expose = this.config.server;
    if (expose.enabled) {
      let listener: Server | null = null;
      let failure: string | null = null;
      if (expose.token.trim() === "") {
        failure = "`mcp.server.token` must be set when the MCP server is enabled";
      } else {
        try {
          listener = await bind(
            expose.bind,
            exposeHandler({ ctx, token: expose.token, extraHosts: expose.allowed_hosts }),
          );
        } catch (error) {
          failure = error instanceof McpServeError ? error.message : errorMessage(error);
        }
      }
      if (listener !== null) {
        const local = localAddress(listener);
        ctx.log.info({ addr: local }, "MCP server listening");
        status.setExpose({ enabled: true, listening: local, error: null });
        const server = listener;
        ctx.spawn("mcp-expose", (signal) => serveUntil(server, signal));
      } else {
        ctx.log.warn({ error: failure }, "MCP server not started");
        status.setExpose({ enabled: true, listening: null, error: failure });
      }
    }

    ctx.provide(McpStatusKey, status);
    this.#running = { status, registrar };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    running?.registrar.close();
  }

  async health(): Promise<Health> {
    const status = this.status();
    if (!status) return { status: "unhealthy", reason: "not running" };
    const expose = status.expose();
    if (expose.error !== null) return { status: "degraded", reason: `MCP server: ${expose.error}` };
    const down = status.unavailable();
    if (down.length === 0) return HEALTHY;
    return { status: "degraded", reason: `MCP servers not connected: ${down.join(", ")}` };
  }
}
