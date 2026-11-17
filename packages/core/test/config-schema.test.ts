import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MindConfigSchema } from "@miyoria/heart/mind";
import { LlmConfigSchema } from "@miyoria/llm/llm";
import { ExtensionsModule } from "@miyoria/plugin-host/ext-host";
import { Config, ConfigError, parseSection } from "@miyoria/runtime/kernel";
import { ReplayRecorderModule } from "@miyoria/runtime/replay-log";
import { openStore, SqliteStore } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { CliPlatform } from "../src/cli-platform.js";
import {
  assertStartConfig,
  checkStartConfig,
  MODULE_CONFIG_SCHEMAS,
  validateRevision,
} from "../src/config-schema.js";
import { MODULE_IDS } from "../src/module-ids.js";
import { buildCore, defaultCatalog, openStore as openCoreStore } from "../src/modules.js";
import { loadProfile } from "../src/settings.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PROFILES = join(ROOT, "profiles");

/** Every `${NAME}` expands to `x`, as if the whole `.env` were filled in. */
const filled = () => "x";

function file(name: string): Config {
  return Config.fromToml(readFileSync(join(ROOT, name), "utf8"), filled);
}

function toml(text: string): Config {
  return Config.fromToml(text, filled);
}

/** `path → severity` of every problem the start check finds. */
function outcomes(config: Config): Record<string, string> {
  const { errors, warnings, ignored } = checkStartConfig(config);
  return Object.fromEntries(
    [...errors, ...warnings, ...ignored].map((p) => [p.path, p.severity] as const),
  );
}

describe("the root schema", () => {
  it("holds each module's own configSchema, for every module Core builds", async () => {
    const config = toml(`[core]\nprofiles_dir = '${PROFILES}'\nprofile = "deepseek-chan"\n`);
    const profile = await loadProfile(config);
    const store = await openStore("memory://");
    const deps = { config, profile, profileId: profile.id, store, baseDir: PROFILES };
    const modules = [
      ...(await defaultCatalog.coreModules(deps)),
      defaultCatalog.discord(deps),
      defaultCatalog.api(deps),
      new ReplayRecorderModule({ baseDir: PROFILES }),
      new CliPlatform("Owen", profile.displayName),
    ];
    const host = defaultCatalog.discoverExtensions(config, PROFILES);
    const hostModule = (await host).modules[0]?.module;
    expect(hostModule?.manifest.id).toBe(ExtensionsModule.ID);
    if (hostModule !== undefined) modules.push(hostModule);
    for (const m of modules) {
      expect(MODULE_CONFIG_SCHEMAS.get(m.manifest.id), m.manifest.id).toBe(
        m.manifest.configSchema ?? null,
      );
    }
    expect([...MODULE_CONFIG_SCHEMAS.keys()].sort()).toEqual(
      [...MODULE_IDS, CliPlatform.ID].sort(),
    );
    await store.close();
  });

  it("orders modules only after modules that exist (a gone id orders nothing)", async () => {
    const config = toml(`[core]\nprofiles_dir = '${PROFILES}'\nprofile = "deepseek-chan"\n`);
    const profile = await loadProfile(config);
    const store = await openStore("memory://");
    const deps = { config, profile, profileId: profile.id, store, baseDir: PROFILES };
    const modules = [
      ...(await defaultCatalog.coreModules(deps)),
      defaultCatalog.discord(deps),
      defaultCatalog.api(deps),
    ];
    const known = new Set([...MODULE_IDS, CliPlatform.ID]);
    for (const m of modules) {
      const named = [...(m.manifest.requires ?? []), ...(m.manifest.optional ?? [])];
      expect(
        named.filter((id) => !known.has(id)),
        m.manifest.id,
      ).toEqual([]);
    }
    await store.close();
  });

  it("finds nothing at all in the example files", () => {
    expect(outcomes(file("miyoria.example.toml"))).toEqual({});
    expect(outcomes(file("deploy/miyoria.docker.toml"))).toEqual({});
  });

  it("lets unknown sections and keys through everywhere, as the readers do", () => {
    const config = toml(`
nope = 1
[elsewhere]
a = 1
[core]
extra = 1
[llm]
extra = 1
[llm.budget]
extra = 2
[speech]
extra = true
[memory]
other = 1
[memory.embedding]
extra = 1
[mcp]
extra = 1
[mcp.servers.files]
command = "npx"
extra = 1
[extensions."some.ext"]
own_key = 1
[stage]
extra = 1
[stage.obs]
extra = 1
[modules]
extra = 1
[modules.agent]
extra = 1
[modules.mind]
extra = 1
[modules.not_a_module]
x = 1
`);
    expect(outcomes(config)).toEqual({});
    expect(() => assertStartConfig(config)).not.toThrow();
  });

  it("leaves the shimmed and still-read keys as they load today", () => {
    // `core.pipeline` is no longer read (`removed-config.ts` names it); `[modules.auth] owners`
    // is still read.
    const config = toml(`
[core]
pipeline = "v2"
[modules.auth]
owners = ["discord:123456789012345678"]
`);
    expect(outcomes(config)).toEqual({});
  });
});

describe("a value of the wrong type", () => {
  it("stops the start where its reader stops it today, naming every one", () => {
    const config = toml(`
[llm.budget]
daily_usd = "two"
[speech]
asr_chain = "local"
[mcp]
reconnect_max_ms = -1
[memory.embedding]
threads = "two"
`);
    // Today the first of these stops `buildCore` on its own.
    expect(() => config.get("llm", LlmConfigSchema)).toThrow(ConfigError);
    let thrown: unknown;
    try {
      assertStartConfig(config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.code).toBe("invalid");
    expect(error.path).toBe("llm.budget.daily_usd");
    expect(error.message).toContain("invalid config (4 problems):");
    for (const path of [
      "llm.budget.daily_usd",
      "speech.asr_chain",
      "mcp.reconnect_max_ms",
      "memory.embedding.threads",
    ]) {
      expect(error.message).toContain(`at \`${path}\`:`);
    }
    expect(error.message).toContain("expected number, received string");
  });

  it("says one problem the way a section's own check says it", () => {
    let thrown: unknown;
    try {
      assertStartConfig(toml(`[llm.budget]\ndaily_usd = "two"\n`));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      "invalid config at `llm.budget.daily_usd`: Invalid input: expected number, received string",
    );
  });

  it("is a warning in the section of a module that runs: that module fails, the rest starts", () => {
    const config = toml(`[modules.mind]\njournal_keep = "many"\n`);
    // Today: the module's start throws this.
    expect(() =>
      parseSection(MindConfigSchema, config.module("mind").config ?? undefined, "modules.mind"),
    ).toThrow(ConfigError);
    expect(outcomes(config)).toEqual({ "modules.mind.journal_keep": "warning" });
    expect(() => assertStartConfig(config)).not.toThrow();
  });

  it("is ignored where nothing reads it today", () => {
    const config = toml(`
memory = 5
[core]
profile = 5
[stage]
peer_timeout_ms = "soon"
[stack]
core = "yes"
[modules.mind]
enabled = false
journal_keep = "many"
[modules.sandbox]
timeout_s = "long"
[modules.agent]
enabled = "yes"
[modules."platform.discord.bot"]
token = ""
command_guilds = 5
[extensions."some.ext"]
enabled = "yes"
`);
    const found = outcomes(config);
    expect(Object.values(found).every((s) => s === "ignore")).toBe(true);
    expect(found).toMatchObject({
      memory: "ignore",
      "core.profile": "ignore",
      "stage.peer_timeout_ms": "ignore",
      "modules.mind.journal_keep": "ignore",
      "modules.agent.enabled": "ignore",
      'modules."platform.discord.bot".command_guilds': "ignore",
      'extensions."some.ext".enabled': "ignore",
    });
    expect(() => assertStartConfig(config)).not.toThrow();
  });

  it("is a warning in an extension's settings, where discovery fails today", () => {
    const config = toml(`[extensions."some.ext"]\nenv = 5\n`);
    expect(outcomes(config)).toEqual({ 'extensions."some.ext".env': "warning" });
  });

  it("stops buildCore before anything is opened", async () => {
    const config = toml(
      `[core]\ndatabase_url = "sqlite:/nonexistent/dir/x.db"\n[llm.budget]\ndaily_usd = "two"\n`,
    );
    await expect(buildCore(config)).rejects.toThrow(/llm\.budget\.daily_usd/);
  });
});

describe("a config revision", () => {
  it("is refused when Core would not start with it, with the same message", () => {
    const doc = { llm: { budget: { daily_usd: "two" } } };
    expect(() => validateRevision(doc)).toThrow(
      "invalid config at `llm.budget.daily_usd`: Invalid input: expected number, received string",
    );
  });

  it("is written when Core would start with it", () => {
    // A module toggle on an empty document, a section without its token, env references.
    const docs: JsonObject[] = [
      { modules: { mind: { enabled: false } } },
      { modules: { "platform.discord.bot": { enabled: true } } },
      { modules: { mind: { journal_keep: "many" } } },
      { llm: { budget: { daily_usd: `\${BUDGET}` } } },
    ];
    for (const doc of docs) {
      expect(validateRevision(doc)).toBe(doc);
    }
  });
});

describe("the store Core opens", () => {
  it("refuses a revision Core would not start with, and takes the rest", async () => {
    const store = await openCoreStore("memory://");
    try {
      if (!(store instanceof SqliteStore)) throw new Error("not the SQLite store");
      const revisions = store.config.revisions;
      expect(() => revisions.write({ llm: { budget: { daily_usd: "two" } } }, "cli")).toThrow(
        "invalid config at `llm.budget.daily_usd`: Invalid input: expected number, received string",
      );
      expect(revisions.current()).toBeNull();
      // A runtime toggle writes a revision of module flags only.
      await store.moduleState.set("mind", false);
      expect(revisions.current()?.doc).toEqual({ modules: { mind: { enabled: false } } });
    } finally {
      await store.close();
    }
  });
});
