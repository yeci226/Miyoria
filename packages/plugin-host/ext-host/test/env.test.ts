import { Config, ConfigError } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { extensionEnv, extensionSettings } from "../src/index.js";

const HOST = {
  PATH: "/usr/bin",
  HOME: "/home/owen",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LLM_API_KEY: "sk-secret",
  DISCORD_BOT_TOKEN: "token",
  MIYORIA_API_TOKEN: "api",
  NODE_OPTIONS: "--import tsx",
  HTTPS_PROXY: "http://user:pass@proxy:8080",
  MIYORIA_MC_URL: "ws://127.0.0.1:7890",
  MIYORIA_MC_TOKEN: "mc",
  MIYORIA_MCP_SECRET: "nope",
};

describe("extensionEnv", () => {
  it("passes_the_platform_allowlist_only", () => {
    const env = extensionEnv("x", { pass: [], set: {} }, HOST, "linux");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/owen",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      MIYORIA_RPC: "stdio",
      MIYORIA_EXTENSION_ID: "x",
    });
  });

  it("adds_declared_names_and_prefixes_and_configured_values", () => {
    const env = extensionEnv(
      "miyoria.minecraft",
      { pass: ["MIYORIA_MC_*"], set: { MIYORIA_MC_TOKEN: "from-config", EXTRA: "1" } },
      HOST,
      "linux",
    );
    expect(env.MIYORIA_MC_URL).toBe("ws://127.0.0.1:7890");
    expect(env.MIYORIA_MC_TOKEN).toBe("from-config");
    expect(env.EXTRA).toBe("1");
    // `MIYORIA_MC_*` is a prefix of `MIYORIA_MC`, not of `MIYORIA_MCP_...`.
    expect(env.MIYORIA_MCP_SECRET).toBeUndefined();
    for (const secret of [
      "LLM_API_KEY",
      "DISCORD_BOT_TOKEN",
      "MIYORIA_API_TOKEN",
      "NODE_OPTIONS",
    ]) {
      expect(env[secret]).toBeUndefined();
    }
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("protocol_variables_cannot_be_overridden", () => {
    const env = extensionEnv(
      "x",
      { pass: ["MIYORIA_*"], set: { MIYORIA_RPC: "tcp", MIYORIA_EXTENSION_ID: "other" } },
      { MIYORIA_RPC: "tcp" },
      "linux",
    );
    expect(env.MIYORIA_RPC).toBe("stdio");
    expect(env.MIYORIA_EXTENSION_ID).toBe("x");
  });

  it("matches_case_insensitively_on_windows", () => {
    const host = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\T", Secret: "s" };
    const win = extensionEnv("x", { pass: [], set: { path: "D:\\bin" } }, host, "win32");
    expect(win.SystemRoot).toBe("C:\\Windows");
    expect(win.TEMP).toBe("C:\\T");
    expect(win.Secret).toBeUndefined();
    // The configured value replaces the inherited `Path` instead of adding a second one.
    expect(win.Path).toBeUndefined();
    expect(win.path).toBe("D:\\bin");
    // Exact case elsewhere.
    expect(extensionEnv("x", undefined, { Path: "/bin" }, "linux").Path).toBeUndefined();
  });
});

describe("extension env settings", () => {
  it("reads_env_and_env_pass_and_keeps_them_out_of_the_extension_config", () => {
    const cfg = Config.fromToml(`
      [extensions."x.y"]
      greeting = "hi"
      env = { TOKEN = "t" }
      env_pass = ["APP_*"]
    `);
    const s = extensionSettings(cfg, "x.y");
    expect(s.env).toEqual({ TOKEN: "t" });
    expect(s.envPass).toEqual(["APP_*"]);
    expect(s.config).toEqual({ greeting: "hi" });
    expect(extensionSettings(cfg, "other")).toMatchObject({ env: {}, envPass: null });
    const bad = Config.fromToml(`
      [extensions.x]
      env = { "BAD-NAME" = "v" }
    `);
    expect(() => extensionSettings(bad, "x")).toThrow(ConfigError);
  });
});
