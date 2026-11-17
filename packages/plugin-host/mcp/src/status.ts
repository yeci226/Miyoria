// Live status of the MCP client connections, for the API / panel.

import { serviceKey } from "@miyoria/types";

export type ServerState =
  /** `enabled = false` in config. */
  | "disabled"
  /** Connecting for the first time or reconnecting. */
  | "connecting"
  | "connected"
  /** The last attempt failed or the connection dropped; retrying with backoff. */
  | "failed";

/** Status of one configured server (JSON shape). */
export interface ServerStatus {
  name: string;
  /** `"stdio"` or `"http"`. */
  transport: string;
  /**
   * What it connects to: the command line (`stdio`) or the URL without credentials and query
   * (`http`). Never env values or headers.
   */
  target: string | null;
  state: ServerState;
  connected: boolean;
  /** Registry names of the tools currently registered from this server. */
  tools: string[];
  /** Tools the server offers, before allow / deny filtering. */
  remote_tool_count: number;
  /** Permission node required to use the tools, if any. */
  permission: string | null;
  last_error: string | null;
  /** How many times the connection was (re)established after the first. */
  reconnects: number;
}

export function newServerStatus(
  name: string,
  transport: string,
  permission: string | null,
  target: string | null = null,
): ServerStatus {
  return {
    name,
    transport,
    target,
    state: "connecting",
    connected: false,
    tools: [],
    remote_tool_count: 0,
    permission,
    last_error: null,
    reconnects: 0,
  };
}

/** State of the optional MCP server Miyoria exposes. */
export interface ExposeStatus {
  enabled: boolean;
  /** Address actually listened on. */
  listening: string | null;
  error: string | null;
}

function clone(s: ServerStatus): ServerStatus {
  return { ...s, tools: [...s.tools] };
}

/** Service `McpStatusKey`: what the MCP module is connected to. Getters return copies. */
export class McpStatus {
  readonly #servers = new Map<string, ServerStatus>();
  #expose: ExposeStatus = { enabled: false, listening: null, error: null };

  /** All configured servers, ordered by name. */
  servers(): ServerStatus[] {
    return [...this.#servers.keys()]
      .sort()
      .map((name) => clone(this.#servers.get(name) as ServerStatus));
  }

  server(name: string): ServerStatus | undefined {
    const s = this.#servers.get(name);
    return s ? clone(s) : undefined;
  }

  connectedCount(): number {
    return [...this.#servers.values()].filter((s) => s.connected).length;
  }

  /** All registered tool names across servers. */
  toolNames(): string[] {
    return this.servers().flatMap((s) => s.tools);
  }

  /** The exposed MCP server's state. */
  expose(): ExposeStatus {
    return { ...this.#expose };
  }

  /** @internal */
  insert(status: ServerStatus): void {
    this.#servers.set(status.name, clone(status));
  }

  /** @internal */
  update(name: string, f: (s: ServerStatus) => void): void {
    const s = this.#servers.get(name);
    if (!s) return;
    f(s);
    s.connected = s.state === "connected";
  }

  /** @internal */
  setExpose(status: ExposeStatus): void {
    this.#expose = { ...status };
  }

  /** Servers that are enabled but not connected. */
  unavailable(): string[] {
    return this.servers()
      .filter((s) => s.state !== "disabled" && !s.connected)
      .map((s) => s.name);
  }
}

export const McpStatusKey = serviceKey<McpStatus>("McpStatus");
