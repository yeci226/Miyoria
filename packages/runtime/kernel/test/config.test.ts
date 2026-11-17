/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${VAR}` interpolation is what these tests check. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Config, ConfigError, expandEnv, loadDotenv } from "../src/index.js";

describe("Config", () => {
  it("expands_env_references", () => {
    const env = (name: string) => (name === "KEY" ? "secret" : name === "EMPTY" ? "" : undefined);
    expect(expandEnv("a-${KEY}-b", env)).toBe("a-secret-b");
    expect(expandEnv("${NOPE:-fallback}", env)).toBe("fallback");
    expect(expandEnv("${EMPTY:-fallback}", env)).toBe("fallback");
    expect(expandEnv("[${EMPTY}]", env)).toBe("[]");
    expect(expandEnv("${KEY:-}", env)).toBe("secret");
    expect(expandEnv("keep ${unterminated", env)).toBe("keep ${unterminated");
    expect(() => expandEnv("${NOPE}", env)).toThrow(ConfigError);
    try {
      expandEnv("${NOPE}", env);
    } catch (error) {
      expect((error as ConfigError).code).toBe("missing_env");
      expect((error as ConfigError).path).toBe("NOPE");
    }
  });

  it("module_sections", () => {
    const cfg = Config.fromToml(`
      [modules.agent]
      enabled = false
      debounce_ms = 1500

      [modules."platform.discord.bot"]
      token = "\${TOKEN:-t}"
    `);
    const agent = cfg.module("agent");
    expect(agent.enabled).toBe(false);
    expect(agent.config).toEqual({ debounce_ms: 1500 });
    expect(cfg.module("other")).toEqual({ enabled: true, config: null });
    expect(cfg.module("platform.discord.bot")).toEqual({ enabled: true, config: { token: "t" } });
  });

  it("sections and schema validation", () => {
    const cfg = Config.fromToml(`
      [core]
      profile = "deepseek-chan"
      [llm.budget]
      daily_usd = 2.5
    `);
    expect(cfg.section("core.profile")).toBe("deepseek-chan");
    expect(cfg.section("core.nope.deeper")).toBeUndefined();
    const Budget = z.object({
      daily_usd: z.number().nullable().default(null),
      degrade_at: z.number().default(0.8),
    });
    expect(cfg.get("llm.budget", Budget)).toEqual({ daily_usd: 2.5, degrade_at: 0.8 });
    // A missing section validates as `{}`.
    expect(cfg.get("missing", Budget)).toEqual({ daily_usd: null, degrade_at: 0.8 });
    expect(() => cfg.get("core", z.object({ profile: z.number() }))).toThrow(
      /invalid config at `core`/,
    );
    expect(() => Config.fromToml("a = ")).toThrow(/invalid TOML/);
  });

  it("loads .env next to the config without overriding the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-config-"));
    try {
      writeFileSync(join(dir, ".env"), "A=from-file\nB=from-file\n# comment\n");
      writeFileSync(join(dir, "miyoria.toml"), 'a = "${A}"\nb = "${B}"\n');
      const env: Record<string, string | undefined> = { B: "from-env" };
      expect(loadDotenv(join(dir, "miyoria.toml"), env)).toEqual(["A"]);
      const cfg = await Config.load(join(dir, "miyoria.toml"), (n) => env[n]);
      expect(cfg.raw).toEqual({ a: "from-file", b: "from-env" });
      expect(loadDotenv(join(dir, "nested", "x.toml"), env)).toEqual([]);
      await expect(Config.load(join(dir, "nope.toml"))).rejects.toMatchObject({ code: "read" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
