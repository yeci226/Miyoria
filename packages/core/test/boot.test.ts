import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  Config,
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { openStore, type Store, StoreKey } from "@miyoria/store";
import { ToolRegistryKey } from "@miyoria/tools";
import { type ContextKey, type Envelope, PlatformSinksKey, toTimestamp } from "@miyoria/types";
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
import { configuredModules, MODULE_IDS, moduleEnabled } from "../src/module-ids.js";
import { RecorderModule } from "../src/recorder.js";
import {
  DEFAULT_DATABASE_URL,
  databaseUrl,
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
  (id) => !["extensions", "platform.discord.bot", "recorder", "api"].includes(id),
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

describe("buildCore", () => {
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
      "recorder",
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

  it("disables_token_modules_without_a_token_and_remembers_runtime_toggles", async () => {
    const store = await openStore("memory://");
    await store.moduleState.set("speech", false);
    core = await buildCoreWith(catalog(), config("[modules.mood]\nenabled = false\n"), { store });
    const state = new Map(core.supervisor.list().map((m) => [m.id, m.state]));
    expect(state.get("platform.discord.bot")).toBe("disabled"); // empty token
    expect(state.get("api")).toBe("stopped"); // has a token
    expect(state.get("speech")).toBe("disabled"); // disabled at runtime earlier
    expect(state.get("mood")).toBe("disabled"); // enabled = false
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
    core = await buildCoreWith(catalog(), config("[modules.mood]\nenabled = false\n"), { store });
    await core.start();
    await core.supervisor.disable("llm");
    await waitFor(async () => (await store.moduleState.get("llm")) === false);
    // Off only because of the config: turning it on there must be enough.
    expect(await store.moduleState.get("mood")).toBeNull();
    expect(await store.moduleState.get("sandbox")).toBeNull();
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
    expect(moduleEnabled(Config.fromToml(""), "share")).toBe(false);
    expect(moduleEnabled(Config.fromToml("[modules.share]\nenabled = true"), "share")).toBe(true);
  });
});

// ---- recorder and terminal chat ------------------------------------------------------------

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const discord: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

async function running(modules: Module[], store?: Store) {
  const supervisor = new Supervisor({ bus: new EventBus() });
  const { PlatformSinks } = await import("@miyoria/types");
  supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
  for (const m of modules) await supervisor.register(m, null, true);
  await supervisor.startAll();
  return { supervisor, store };
}

describe("recorder", () => {
  it("records_messages_people_spoken_lines_and_decisions", async () => {
    const store = await openStore("memory://");
    const { supervisor } = await running([new RecorderModule(store, "p")], store);
    const bus = supervisor.bus;
    const ts = toTimestamp(Date.parse("2026-01-01T00:00:00Z"));
    const her = { platform: "discord", id: "her" };
    const owen = { platform: "discord", id: "owen" };
    const msg = (account: typeof her, text: string) => ({
      id: { context: discord, id: text },
      author: { account, display_name: account.id, is_bot: false },
      text,
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts,
    });
    bus.publish("platform.discord.bot", {
      type: "platform_ready",
      data: { platform: "discord", self_account: her },
    });
    bus.publish(
      "platform.discord.bot",
      { type: "platform_message_created", data: msg(owen, "hi") },
      { correlation: "T1" },
    );
    bus.publish("platform.discord.bot", {
      type: "platform_message_created",
      data: msg(her, "hello"),
    });
    bus.publish("voice", {
      type: "voice_playback",
      data: { context: discord, turn: "T2", state: "started", text: "說出口的話" },
    });
    bus.publish("agent", {
      type: "agent_decision",
      data: { turn: "T1", context: discord, respond: true, score: 0.9, reasons: ["mention"] },
    });
    await waitFor(async () => (await store.messages.recent("p", discord, 10)).length === 3);
    const log = await store.messages.recent("p", discord, 10);
    expect(log.map((e) => [e.text, e.is_self, e.turn])).toEqual([
      ["hi", false, "T1"],
      ["hello", true, null],
      ["說出口的話", true, "T2"],
    ]);
    await waitFor(async () => (await store.decisions.recent("p", null, 5)).length === 1);
    expect((await store.people.personByAccount(owen)) !== null).toBe(true);
    expect(await store.people.personByAccount(her)).toBeNull();
    await supervisor.stopAll();
  });
});

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
      return events.some((e) => e.event.type === "platform_message_created");
    });
    const created = events.find((e) => e.event.type === "platform_message_created")?.event;
    expect(created?.type === "platform_message_created" && created.data.text).toBe("你好");
    expect(created?.type === "platform_message_created" && created.data.author.display_name).toBe(
      "Owen",
    );
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
