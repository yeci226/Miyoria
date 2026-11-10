// Configuration: `[mcp.servers.<name>]` and `[mcp.server]`.
//
// The app reads the top-level `mcp` section and hands it to `new McpModule(...)` (or uses
// `McpModule.fromAppConfig`).
//
// ```toml
// [mcp.servers.files]
// transport = "stdio"
// command = "npx"
// args = ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"]
// tools_allow = ["read_*", "list_*"]
// tools_deny = ["*delete*"]
// permission = "tools.mcp.files"
// timeout_ms = 30000
// max_result_chars = 8000
//
// [mcp.servers.search]
// transport = "http"
// url = "https://example.com/mcp"
// headers = { Authorization = "Bearer ${SEARCH_TOKEN}" }
//
// [mcp.server]
// enabled = false
// bind = "127.0.0.1:7881"
// token = "${MIYORIA_MCP_TOKEN}"
// ```

import { inspect } from "node:util";
import { ConfigError } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";

const REDACTED = "<redacted>";

export type Transport = "stdio" | "http";

export class McpConfigError extends Error {
  override readonly name = "McpConfigError";
}

const ServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** `"stdio"` or `"http"`. Inferred from `url` / `command` when omitted. */
  transport: z.enum(["stdio", "http"]).nullable().default(null),
  /** stdio: program to run (resolved through `PATH`, so `npx` works on Windows). */
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  /** Extra environment variables for the child process. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Host environment variables to pass on besides the safe basics (`PATH`, `HOME`, `TEMP`, ...):
   * exact names, or a prefix ending in `*` (`GITHUB_*`). The server does not inherit the host's
   * environment, which holds the bot's tokens.
   */
  env_pass: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  /** http: Streamable HTTP endpoint. */
  url: z.string().nullable().default(null),
  /**
   * http: extra request headers. `Authorization = "Bearer <token>"` is supported; other
   * authorization schemes are not.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * Only tools matching one of these patterns are offered (`*` and `?` wildcards, matched
   * against the server's own tool name). Empty = all.
   */
  tools_allow: z.array(z.string()).default([]),
  /** Tools matching any of these patterns are never offered; wins over allow. */
  tools_deny: z.array(z.string()).default([]),
  /**
   * Permission node the triggering user needs to use this server's tools. Default
   * `tools.mcp.<server>`; an empty string disables the check.
   */
  permission: z.string().nullable().default(null),
  /** Per-call timeout. */
  timeout_ms: z.number().int().nonnegative().default(30_000),
  /** Timeout for connecting and listing tools. */
  connect_timeout_ms: z.number().int().nonnegative().default(20_000),
  /** Tool results longer than this many characters are cut (0 = no limit). */
  max_result_chars: z.number().int().nonnegative().default(8_000),
});

export type ServerConfigData = z.output<typeof ServerConfigSchema>;

/** One `[mcp.servers.<name>]` table. Env values and headers are hidden from `toJSON` / inspect. */
export class ServerConfig implements ServerConfigData {
  enabled = true;
  transport: Transport | null = null;
  command: string | null = null;
  args: string[] = [];
  env: Record<string, string> = {};
  env_pass: string[] = [];
  cwd: string | null = null;
  url: string | null = null;
  headers: Record<string, string> = {};
  tools_allow: string[] = [];
  tools_deny: string[] = [];
  permission: string | null = null;
  timeout_ms = 30_000;
  connect_timeout_ms = 20_000;
  max_result_chars = 8_000;

  constructor(data: Partial<ServerConfigData> = {}) {
    Object.assign(this, ServerConfigSchema.parse(data));
  }

  /** The transport, inferred when not set explicitly. */
  effectiveTransport(): Transport {
    if (this.transport !== null) return this.transport;
    return this.url !== null && this.command === null ? "http" : "stdio";
  }

  /**
   * What the server connects to, safe to show: the command line for `stdio`, the URL without
   * user info, query or fragment for `http`. `null` when not configured.
   */
  displayTarget(): string | null {
    if (this.effectiveTransport() === "stdio") {
      const command = this.command?.trim() ?? "";
      return command === "" ? null : [command, ...this.args].join(" ");
    }
    const raw = this.url?.trim() ?? "";
    if (raw === "") return null;
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  /** The permission node required from the triggering user, if any. */
  permissionNode(server: string): string | null {
    if (this.permission === null) return `tools.mcp.${server}`;
    const node = this.permission.trim();
    return node === "" ? null : node;
  }

  get callTimeoutMs(): number {
    return Math.max(this.timeout_ms, 1);
  }

  get connectTimeoutMs(): number {
    return Math.max(this.connect_timeout_ms, 1);
  }

  /** Checks that the server's name and transport fields are usable. Throws `McpConfigError`. */
  validate(name: string): void {
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
      throw new McpConfigError(
        `server name \`${name}\` must be ASCII letters, digits, \`_\` or \`-\``,
      );
    }
    if (this.effectiveTransport() === "stdio") {
      if (this.command === null || this.command.trim() === "") {
        throw new McpConfigError("stdio transport needs `command`");
      }
    } else {
      const url = this.url ?? "";
      if (!(url.startsWith("http://") || url.startsWith("https://"))) {
        throw new McpConfigError("http transport needs `url` starting with http:// or https://");
      }
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      transport: this.transport,
      command: this.command,
      args: this.args,
      env: Object.keys(this.env),
      env_pass: this.env_pass,
      cwd: this.cwd,
      url: this.url,
      headers: Object.keys(this.headers),
      tools_allow: this.tools_allow,
      tools_deny: this.tools_deny,
      permission: this.permission,
      timeout_ms: this.timeout_ms,
      max_result_chars: this.max_result_chars,
    };
  }

  [inspect.custom](): string {
    return `ServerConfig ${inspect(this.toJSON())}`;
  }
}

const ExposeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bind: z.string().default("127.0.0.1:7881"),
  /** Bearer token clients must send. Required when enabled. */
  token: z.string().default(""),
  /**
   * Extra `Host` header values to accept besides loopback names (needed when binding a
   * non-loopback address).
   */
  allowed_hosts: z.array(z.string()).default([]),
});

export type ExposeConfigData = z.output<typeof ExposeConfigSchema>;

/** `[mcp.server]`: the MCP server Miyoria itself exposes (read-only tools). */
export class ExposeConfig implements ExposeConfigData {
  enabled = false;
  bind = "127.0.0.1:7881";
  token = "";
  allowed_hosts: string[] = [];

  constructor(data: Partial<ExposeConfigData> = {}) {
    Object.assign(this, ExposeConfigSchema.parse(data));
  }

  toJSON(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      bind: this.bind,
      token: REDACTED,
      allowed_hosts: this.allowed_hosts,
    };
  }

  [inspect.custom](): string {
    return `ExposeConfig ${inspect(this.toJSON())}`;
  }
}

/** The whole `[mcp]` section. */
export const McpConfigSchema = z.object({
  /** MCP servers Miyoria connects to, by name. */
  servers: z
    .record(z.string(), ServerConfigSchema)
    .default({})
    .transform(
      (servers) =>
        new Map(
          Object.entries(servers)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([name, s]) => [name, new ServerConfig(s)] as const),
        ),
    ),
  /** The optional MCP server Miyoria exposes to external agents. */
  server: ExposeConfigSchema.prefault({}).transform((s) => new ExposeConfig(s)),
  /** First delay before reconnecting to a failed server; doubles up to `reconnect_max_ms`. */
  reconnect_initial_ms: z.number().int().nonnegative().default(1_000),
  reconnect_max_ms: z.number().int().nonnegative().default(60_000),
});

export type McpConfig = z.output<typeof McpConfigSchema>;

/** Parses the `mcp` section (`config.section("mcp")`); `null` / missing means defaults. */
export function parseMcpConfig(value: JsonValue | null | undefined): McpConfig {
  const result = McpConfigSchema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ConfigError(
    "invalid",
    `invalid \`mcp\` config section: ${z.prettifyError(result.error)}`,
    "mcp",
    { cause: result.error },
  );
}

export function reconnectInitialMs(config: McpConfig): number {
  return Math.max(config.reconnect_initial_ms, 1);
}

export function reconnectMaxMs(config: McpConfig): number {
  return Math.max(config.reconnect_max_ms, config.reconnect_initial_ms, 1);
}
