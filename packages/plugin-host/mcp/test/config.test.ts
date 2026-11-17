import { inspect } from "node:util";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { ExposeConfig, McpModule, parseMcpConfig, ServerConfig } from "../src/index.js";

describe("config", () => {
  it("parses_toml_like_json", () => {
    const cfg = parseMcpConfig({
      servers: {
        files: { transport: "stdio", command: "npx", args: ["-y", "x"], tools_deny: ["*delete*"] },
        web: { url: "https://h/mcp", headers: { Authorization: "Bearer t" } },
        off: { enabled: false, command: "x" },
      },
      server: { enabled: true, token: "s" },
    });
    expect(cfg.servers.size).toBe(3);
    expect([...cfg.servers.keys()]).toEqual(["files", "off", "web"]);
    expect(cfg.servers.get("files")?.effectiveTransport()).toBe("stdio");
    expect(cfg.servers.get("web")?.effectiveTransport()).toBe("http");
    expect(cfg.servers.get("off")?.enabled).toBe(false);
    expect(cfg.servers.get("files")?.timeout_ms).toBe(30_000);
    expect(cfg.servers.get("files")?.connect_timeout_ms).toBe(20_000);
    expect(cfg.servers.get("files")?.max_result_chars).toBe(8_000);
    expect(cfg.servers.get("files")?.trust_read_only_hint).toBe(false);
    expect(cfg.server.enabled).toBe(true);
    expect(cfg.server.bind).toBe("127.0.0.1:7881");
    expect(cfg.reconnect_initial_ms).toBe(1_000);
    expect(cfg.reconnect_max_ms).toBe(60_000);
    expect(parseMcpConfig(null).servers.size).toBe(0);
    expect(() => parseMcpConfig({ servers: { a: { timeout_ms: "x" } } })).toThrow(
      /invalid `mcp` config section/,
    );
  });

  it("reads_the_top_level_section", () => {
    const m = McpModule.fromAppConfig(
      Config.fromToml('[mcp.servers.fs]\ncommand = "npx"\n[mcp.server]\nbind = "127.0.0.1:1"'),
    );
    expect(m.config.servers.get("fs")?.command).toBe("npx");
    expect(m.config.server.bind).toBe("127.0.0.1:1");
  });

  it("permission_default_and_override", () => {
    const s = new ServerConfig();
    expect(s.permissionNode("files")).toBe("tools.mcp.files");
    s.permission = "tools.custom";
    expect(s.permissionNode("files")).toBe("tools.custom");
    s.permission = "";
    expect(s.permissionNode("files")).toBeNull();
  });

  it("validation", () => {
    const stdio = new ServerConfig({ command: "x" });
    expect(() => stdio.validate("ok-1_a")).not.toThrow();
    expect(() => stdio.validate("bad name")).toThrow();
    expect(() => stdio.validate("")).toThrow();
    expect(() => new ServerConfig().validate("a")).toThrow(/needs `command`/);
    const http = new ServerConfig({ transport: "http", url: "ftp://x" });
    expect(() => http.validate("a")).toThrow(/http:\/\//);
  });

  it("display_target_hides_credentials", () => {
    expect(
      new ServerConfig({ command: "npx", args: ["-y", "srv", "C:/data"] }).displayTarget(),
    ).toBe("npx -y srv C:/data");
    expect(
      new ServerConfig({
        url: "https://user:pw@example.com/mcp?key=sekrit#x",
        headers: { Authorization: "Bearer sekrit" },
      }).displayTarget(),
    ).toBe("https://example.com/mcp");
    expect(new ServerConfig({ transport: "http", url: "not a url" }).displayTarget()).toBeNull();
    expect(new ServerConfig().displayTarget()).toBeNull();
  });

  it("debug_hides_secrets", () => {
    const s = new ServerConfig({
      headers: { Authorization: "Bearer sekrit" },
      env: { KEY: "sekrit" },
    });
    expect(inspect(s)).not.toContain("sekrit");
    expect(JSON.stringify(s)).not.toContain("sekrit");
    expect(JSON.stringify(s)).toContain("Authorization");
    const e = new ExposeConfig({ token: "sekrit" });
    expect(inspect(e)).not.toContain("sekrit");
    expect(JSON.stringify(e)).not.toContain("sekrit");
  });
});
