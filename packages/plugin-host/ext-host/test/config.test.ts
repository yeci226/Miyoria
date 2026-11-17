import { join } from "node:path";
import { Config, ConfigError } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  extensionSettings,
  grantedPermissions,
  hostConfigFromConfig,
  type Permissions,
  resolvedDirs,
  runtimeCommand,
} from "../src/index.js";

describe("config", () => {
  it("host_defaults_and_overrides", () => {
    const cfg = Config.fromToml(`
      [modules.extensions]
      dirs = ["a", "/abs"]
      dev = true
    `);
    const host = hostConfigFromConfig(cfg);
    expect(host.dev).toBe(true);
    expect(host.init_timeout_ms).toBe(10_000);
    expect(host.call_timeout_ms).toBe(30_000);
    expect(host.prompt_timeout_ms).toBe(3_000);
    expect(host.shutdown_grace_ms).toBe(2_000);
    expect(host.watch_poll_ms).toBe(1_000);
    const dirs = resolvedDirs(host, "/base");
    expect(dirs[0]).toBe(join("/base", "a"));
    expect(runtimeCommand(host, "node")).toBe("node");
    expect(hostConfigFromConfig(Config.fromValue({})).dirs).toEqual(["extensions"]);
  });

  it("settings_split_and_grants", () => {
    const cfg = Config.fromToml(`
      [extensions."x.y"]
      enabled = false
      greeting = "hi"
      [extensions."x.y".permissions]
      events = ["game.*"]
      tools = false
      input = ["mouse"]
    `);
    const s = extensionSettings(cfg, "x.y");
    expect(s.enabled).toBe(false);
    expect(s.config).toEqual({ greeting: "hi" });
    const declared: Permissions = {
      events: ["game.*", "agent.*"],
      tools: true,
      commands: true,
      network: ["localhost:1"],
      input: ["mouse", "keyboard"],
    };
    let g = grantedPermissions(s, declared);
    expect(g.events).toEqual(["game.*"]);
    expect(!g.tools && g.commands).toBe(true);
    expect(g.network).toEqual(["localhost:1"]);
    expect(g.input).toEqual(["mouse"]);

    const none = extensionSettings(cfg, "other");
    expect(none.enabled).toBeNull();
    g = grantedPermissions(none, declared);
    expect(g.input).toEqual([]);
    expect(g.events).toHaveLength(2);
  });

  it("bad_permission_override_is_a_config_error", () => {
    const cfg = Config.fromToml(`
      [extensions.x.permissions]
      tools = "yes"
    `);
    expect(() => extensionSettings(cfg, "x")).toThrow(ConfigError);
  });
});
