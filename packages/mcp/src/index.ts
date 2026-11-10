// @miyoria/mcp: MCP integration (module `mcp`).
//
// Client. Every server in `[mcp.servers.<name>]` is connected over stdio or Streamable HTTP
// (concurrently, in the background; a server that fails to start never fails the module). Its
// allowed tools are registered in the shared `ToolRegistry` as `mcp_<server>_<tool>`,
// requiring the server's permission node (default `tools.mcp.<server>`) from the user who
// triggered the turn. The tool list follows `notifications/tools/list_changed`, dead servers
// are reconnected with backoff and their tools unregistered meanwhile, and everything is
// unregistered on stop. `McpStatus` (service `McpStatusKey`) reports each server's state.
//
// Server (optional). With `[mcp.server] enabled = true` a bearer-token protected Streamable
// HTTP endpoint at `http://<bind>/mcp` exposes read-only inspection tools (`status`,
// `list_modules`, `list_tools`, `recent_decisions`) to external agents. It cannot send
// messages or change anything.

export { McpConnectionError, McpToolError, Registrar, ServerRunner } from "./client.js";
export {
  ExposeConfig,
  type ExposeConfigData,
  type McpConfig,
  McpConfigError,
  McpConfigSchema,
  parseMcpConfig,
  reconnectInitialMs,
  reconnectMaxMs,
  ServerConfig,
  type ServerConfigData,
  type Transport,
} from "./config.js";
export { McpModule, McpStartError } from "./module.js";
export {
  flattenResult,
  frameResult,
  globMatch,
  MAX_TOOL_NAME,
  registryName,
  stdioEnv,
  ToolFilter,
  truncateChars,
} from "./policy.js";
export {
  EXPOSED_TOOL_LIST,
  ExposedTools,
  exposedServer,
  McpServeError,
  parseBind,
  tokenMatches,
} from "./server.js";
export { ProfileIdKey } from "./services.js";
export {
  type ExposeStatus,
  McpStatus,
  McpStatusKey,
  newServerStatus,
  type ServerState,
  type ServerStatus,
} from "./status.js";
