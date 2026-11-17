import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { directiveTables } from "@miyoria/brain/directive";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  ConfigError,
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  Supervisor,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import { openStore, type Store, StoreKey } from "@miyoria/store";
import {
  DirectivesKey,
  type Envelope,
  Events,
  HandleDirectoryKey,
  is,
  PlatformSinksKey,
  Principals,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCoreWith,
  type Core,
  type ModuleCatalog,
  type ModuleDeps,
  ProfileIdKey,
  runUntilSignal,
} from "../src/boot.js";
import { CLI_PLATFORM, CliPlatform } from "../src/cli-platform.js";
import {
  configuredModules,
  MODULE_IDS,
  moduleEnabled,
  REQUIRED_MODULES,
} from "../src/module-ids.js";
import { defaultCatalog } from "../src/modules.js";
import {
  DEFAULT_DATABASE_URL,
  databaseUrl,
  loadProfile,
  logLevel,
  resolveDatabaseUrl,
} from "../src/settings.js";

const PROFILES = join(fileURLToPath(new URL("../../..", import.meta.url)), "profiles");

class Fake implements Module {
  readonly manifest;
  started = 0;
  constructor(id: string) {
    this.manifest = defineManifest(id, id);
  }
  async start(_ctx: ModuleContext): Promise<void> {
    this.started++;
  }
}

const CORE_IDS = MODULE_IDS.filter(
  (id) => !["extensions", "platform.discord.bot", "replay", "api"].includes(id),
);

function catalog(seen: { deps?: ModuleDeps } = {}): ModuleCatalog {
  return {
    openStore: () => openStore("memory://"),
    coreModules: async (deps) => {
      seen.deps = deps;
      return CORE_IDS.map((id) => new Fake(id));
    },
    discord: () => new Fake("platform.discord.bot"),
    api: () => new Fake("api"),
    discoverExtensions: async () => ({
      skipped: [{ dir: "x", reason: "bad manifest" }],
      modules: [
        { module: new Fake("extensions"), config: null, enabled: true },
        { module: new Fake("ext.hello"), config: { a: 1 }, enabled: true },
      ],
    }),
  };
}

function config(extra = ""): Config {
  return Config.fromToml(
    `[core]\nprofiles_dir = '${PROFILES}'\nprofile = "deepseek-chan"\n[modules.api]\ntoken = "t"\n[modules."platform.discord.bot"]\ntoken = ""\n${extra}`,
  );
}

let core: Core | undefined;
afterEach(async () => {
  await core?.stop();
  core = undefined;
});

describe("going down", () => {
  it("says so on the bus before any module stops", async () => {
    const seen: string[] = [];
    class Listening extends Fake {
      override async start(ctx: ModuleContext): Promise<void> {
        const sub = ctx.subscribe(Events.SystemShutdown.type);
        ctx.spawn("listen", async () => {
          for await (const _ of sub) seen.push("shutdown");
        });
      }
      async stop(): Promise<void> {
        await Promise.resolve();
        seen.push("module stopped");
      }
    }
    const built = await buildCoreWith(
      { ...catalog(), coreModules: async () => [new Listening("listening")] },
      config(),
      { discord: false, api: false },
    );
    await built.start();
    await built.stop();
    expect(seen).toEqual(["shutdown", "module stopped"]);
  });
});

describe("the rules", () => {
  const stopGames = {
    by: { type: "console", actor: "api" },
    text: "不要玩遊戲",
    effect: "deny",
    scope: { activity: "game" },
    minutes: null,
    source_event: "panel:api",
  } as const;
  const asked = {
    capability: "game.start",
    principal: Principals.self(null),
  };

  it("are provided before any module runs, and stay with the module off", async () => {
    const store = await openStore("memory://");
    core = await buildCoreWith(catalog(), config("[modules.directive]\nenabled = false\n"), {
      store,
    });
    const rules = core.services.get(DirectivesKey);
    expect(rules?.healthy).toBe(true);
    expect((await rules?.add(stopGames))?.status).toBe("added");
    expect(await rules?.check(asked)).toMatchObject({ outcome: "deny" });
  });

  it("what the store holds is in force from the first moment of a boot", async () => {
    const store = await openStore("memory://");
    await store.plugin(directiveTables).insert("deepseek-chan", {
      id: "r1",
      issuer: { platform: "discord", id: "1" },
      authority: "owner",
      scope: stopGames.scope,
      effect: "deny",
      text: stopGames.text,
      expires: "until_revoked",
      source_event: "msg:m1",
      created_at: toTimestamp(Date.now()),
    });
    core = await buildCoreWith(catalog(), config(), { store });
    const rules = core.services.get(DirectivesKey);
    expect(rules?.inject(null).join("")).toContain("不要玩遊戲");
    expect(await rules?.check(asked)).toMatchObject({ outcome: "deny", directive: "r1" });
  });
});

describe("buildCore", () => {
  it("moderation is up before anything that can say a word", async () => {
    const order = MODULE_IDS.indexOf("moderation");
    expect(order).toBe(MODULE_IDS.indexOf("facts") + 1);
    expect(order).toBeLessThan(MODULE_IDS.indexOf("agent"));
    expect(order).toBeLessThan(MODULE_IDS.indexOf("voice"));
  });

  it("module_ids_name_every_module_of_the_real_catalog_in_its_order", async () => {
    const cfg = config();
    const profile = await loadProfile(cfg);
    const store = await openStore("memory://");
    const modules = await defaultCatalog.coreModules({
      config: cfg,
      profile,
      profileId: profile.id,
      store,
      baseDir: PROFILES,
    });
    expect(modules.map((m) => m.manifest.id)).toEqual(CORE_IDS);
  });

  it("registers_services_and_modules_in_legacy_order", async () => {
    const seen: { deps?: ModuleDeps } = {};
    const register = vi.spyOn(Supervisor.prototype, "register");
    core = await buildCoreWith(catalog(seen), config(), {
      cliChatName: "Owen",
      cli: { input: new PassThrough(), output: new PassThrough() },
    });
    expect(core.profileDisplayName).toBe("DeepSeek-chan");
    expect(seen.deps?.profileId).toBe("deepseek-chan");
    const ids = register.mock.calls.map(([m]) => m.manifest.id);
    expect(register.mock.calls.find(([m]) => m.manifest.id === "ext.hello")?.[1]).toEqual({ a: 1 });
    expect(ids).toEqual([
      ...CORE_IDS,
      "replay",
      "platform.discord.bot",
      "api",
      "platform.cli",
      "extensions",
      "ext.hello",
    ]);
    const s = core.services;
    expect(s.get(ProfileIdKey)).toBe("deepseek-chan");
    expect(s.get(StoreKey)).toBe(core.store);
    expect(s.get(SupervisorKey)).toBe(core.supervisor);
    expect(s.has(ToolRegistryKey)).toBe(true);
    expect(s.has(PlatformSinksKey)).toBe(true);
  });

  it("provides_the_handle_table_before_any_module_starts", async () => {
    const store = await openStore("memory://");
    await store.people.upsertAccount({ platform: "discord", id: "1" }, "Owen");
    const order: string[] = [];
    const base = catalog();
    core = await buildCoreWith(
      {
        ...base,
        provideServices: (services, deps) => {
          const handles = services.get(HandleDirectoryKey);
          order.push(
            `services:${handles
              ?.list()
              .map((e) => e.handle)
              .join(",")}`,
          );
          base.provideServices?.(services, deps);
        },
        coreModules: async (deps) => {
          order.push("modules");
          return base.coreModules(deps);
        },
      },
      config(),
      { store },
    );
    expect(order).toEqual(["services:Owen", "modules"]);
    const handles = core.services.get(HandleDirectoryKey);
    expect(handles?.list().map((e) => e.handle)).toEqual(["Owen"]);
    expect(handles?.ofAccount({ platform: "discord", id: "1" }, "Renamed")).toBe("Owen");
  });

  it("disables_token_modules_without_a_token_and_remembers_runtime_toggles", async () => {
    const store = await openStore("memory://");
    await store.moduleState.set("speech", false);
    core = await buildCoreWith(catalog(), config("[modules.mcp]\nenabled = false\n"), { store });
    const state = new Map(core.supervisor.list().map((m) => [m.id, m.state]));
    expect(state.get("platform.discord.bot")).toBe("disabled"); // empty token
    expect(state.get("api")).toBe("stopped"); // has a token
    expect(state.get("speech")).toBe("disabled"); // disabled at runtime earlier
    expect(state.get("mcp")).toBe("disabled"); // enabled = false
    expect(state.get("sandbox")).toBe("disabled"); // opt-in, no section
    await core.start();
    expect(core.supervisor.list().find((m) => m.id === "llm")?.state).toBe("running");
    await core.supervisor.disable("llm");
    await waitFor(async () => (await store.moduleState.get("llm")) === false);
    await core.supervisor.enable("speech");
    await waitFor(async () => (await store.moduleState.get("speech")) === true);
  });

  it("does_not_remember_a_module_the_config_leaves_off_as_disabled", async () => {
    const store = await openStore("memory://");
    core = await buildCoreWith(catalog(), config("[modules.mcp]\nenabled = false\n"), { store });
    await core.start();
    await core.supervisor.disable("llm");
    await waitFor(async () => (await store.moduleState.get("llm")) === false);
    // Off only because of the config: turning it on there must be enough.
    expect(await store.moduleState.get("mcp")).toBeNull();
    expect(await store.moduleState.get("sandbox")).toBeNull();
    // A module that simply started has nothing remembered about it either: only `llm` is listed.
    expect(await store.moduleState.list()).toEqual(new Map([["llm", false]]));
  });

  it("applies_persona_overrides_from_the_store", async () => {
    const store = await openStore("memory://");
    await store.personaOverrides.set("deepseek-chan", "identity", "改過的身分", "test");
    const seen: { deps?: ModuleDeps } = {};
    core = await buildCoreWith(catalog(seen), config(), { store });
    expect(seen.deps?.profile.sections.find((s) => s.key === "identity")?.body).toBe("改過的身分");
  });
  it("runs_until_the_signal_then_stops_and_closes_the_store", async () => {
    const store = await openStore("memory://");
    const node = await buildCoreWith(catalog(), config(), { store });
    const controller = new AbortController();
    const done = runUntilSignal(node, controller.signal);
    await waitFor(() =>
      node.supervisor.list().some((m) => m.id === "llm" && m.state === "running"),
    );
    controller.abort();
    await done;
    expect(node.supervisor.list().every((m) => m.state !== "running")).toBe(true);
    await expect(store.moduleState.get("llm")).rejects.toThrow();
  });

  it("names_the_database_and_profile_on_errors", async () => {
    const failing: ModuleCatalog = {
      ...catalog(),
      openStore: async () => Promise.reject(new Error("boom")),
    };
    await expect(buildCoreWith(failing, config())).rejects.toThrow(
      "connecting to the database: boom",
    );
    await expect(
      buildCoreWith(
        catalog(),
        Config.fromToml(`[core]\nprofiles_dir = '${PROFILES}'\nprofile = "nobody"\n`),
      ),
    ).rejects.toThrow(/loading profile `nobody`/);
  });
});

describe("required modules", () => {
  it("refuses_a_config_that_turns_a_required_module_off", async () => {
    for (const id of REQUIRED_MODULES) {
      const off = config(`[modules.${id}]\nenabled = false\n`);
      const error: unknown = await buildCoreWith(catalog(), off).catch((e: unknown) => e);
      expect(error, id).toBeInstanceOf(ConfigError);
      expect(error, id).toMatchObject({ code: "invalid", path: `modules.${id}.enabled` });
      expect((error as Error).message, id).toContain(`\`${id}\` module cannot be disabled`);
    }
  });

  it("does_not_follow_a_remembered_runtime_disable_and_refuses_a_new_one", async () => {
    const store = await openStore("memory://");
    for (const id of REQUIRED_MODULES) await store.moduleState.set(id, false);
    core = await buildCoreWith(catalog(), config(), { store });
    const before = new Map(core.supervisor.list().map((m) => [m.id, m.enabled]));
    for (const id of REQUIRED_MODULES) expect(before.get(id), id).toBe(true);
    for (const id of REQUIRED_MODULES) {
      await expect(core.supervisor.disable(id), id).rejects.toThrow(/is required/);
    }
    const after = new Map(core.supervisor.list().map((m) => [m.id, m.enabled]));
    for (const id of REQUIRED_MODULES) expect(after.get(id), id).toBe(true);
  });

  it("starts_with_all_of_them_on_by_default_or_by_name", async () => {
    expect(REQUIRED_MODULES).toEqual(["agent", "arbiter", "heart"]);
    core = await buildCoreWith(
      catalog(),
      config(
        "[modules.agent]\nenabled = true\n[modules.arbiter]\nenabled = true\n[modules.heart]\nenabled = true\n",
      ),
      { store: await openStore("memory://") },
    );
    expect(core).toBeDefined();
  });
});

describe("settings", () => {
  it("defaults_to_sqlite_relative_to_the_config", () => {
    expect(databaseUrl(Config.fromToml(""))).toBe(DEFAULT_DATABASE_URL);
    expect(databaseUrl(Config.fromToml('[core]\ndatabase_url = ""'))).toBe(DEFAULT_DATABASE_URL);
    expect(resolveDatabaseUrl("sqlite:data/x.db", "/srv/m")).toBe(
      `sqlite:${resolve("/srv/m", "data/x.db")}`,
    );
    expect(resolveDatabaseUrl("memory://", "/srv")).toBe("memory://");
    expect(resolveDatabaseUrl("postgres://a@b/c", "/srv")).toBe("postgres://a@b/c");
    expect(logLevel("info,miyoria=debug")).toBe("info");
    expect(logLevel("miyoria=debug")).toBe("info");
    expect(logLevel("warn")).toBe("warn");
    const mods = configuredModules(Config.fromToml("[modules.agent]\nenabled = false"));
    expect(mods.find(([id]) => id === "agent")).toEqual(["agent", false]);
    expect(mods).toHaveLength(MODULE_IDS.length);
    expect(mods.find(([id]) => id === "sandbox")).toEqual(["sandbox", false]);
    for (const [toml, on] of [
      ["[modules.sandbox]\nroot = 'x'", false],
      ["[modules.sandbox]\nenabled = false", false],
      ["[modules.sandbox]\nenabled = true", true],
    ] as const) {
      expect(moduleEnabled(Config.fromToml(toml), "sandbox"), toml).toBe(on);
    }
    expect(moduleEnabled(Config.fromToml(""), "agent")).toBe(true);
  });
});

// ---- terminal chat ---------------------------------------------------------------------------

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function running(modules: Module[], store?: Store) {
  const supervisor = new Supervisor({ bus: new EventBus() });
  const { PlatformSinks } = await import("@miyoria/types");
  supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
  for (const m of modules) await supervisor.register(m, null, true);
  await supervisor.startAll();
  return { supervisor, store };
}

describe("terminal chat", () => {
  it("publishes_typed_lines_and_prints_replies", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (c: Buffer) => {
      printed += c.toString();
    });
    const { supervisor } = await running([
      new CliPlatform("Owen", "DeepSeek-chan", { input, output }),
    ]);
    const sub = supervisor.bus.subscribe("platform.*");
    input.write("\n  你好  \n");
    const events: Envelope[] = [];
    await waitFor(() => {
      for (let e = sub.tryRecv(); e; e = sub.tryRecv()) events.push(e);
      return events.some((e) => e.type === "platform.message.created");
    });
    const created = events.find((e) => is(Events.PlatformMessageCreated, e));
    expect(created && is(Events.PlatformMessageCreated, created) && created.data.text).toBe("你好");
    expect(
      created && is(Events.PlatformMessageCreated, created) && created.data.author.display_name,
    ).toBe("Owen");
    const sink = supervisor.services.require(PlatformSinksKey).get(CLI_PLATFORM);
    await sink?.send(
      { platform: CLI_PLATFORM, scope: null, channel: "repl", kind: "dm" },
      { text: "哼", reply_to: null },
    );
    expect(printed).toContain("DeepSeek-chan\x1b[0m: 哼");
    await supervisor.stopAll();
    expect(supervisor.services.require(PlatformSinksKey).get(CLI_PLATFORM)).toBeUndefined();
  });
});
