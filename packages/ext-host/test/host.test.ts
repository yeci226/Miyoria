// End-to-end tests against real Node extension processes.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatedToolsKey } from "@miyoria/actions";
import { CommandRegistry, CommandRegistryKey, Invocation, Permissions } from "@miyoria/commands";
import {
  Config,
  EventBus,
  ServiceRegistry,
  type Subscription,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  customEvent,
  type Envelope,
  type JsonObject,
  type JsonValue,
  type ModuleStateKind,
  newId,
  PromptContributors,
  PromptContributorsKey,
  TaskExecutorsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { discover } from "../src/index.js";

const EXT = "ext.test.fixture";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HELLO = join(dirname(fileURLToPath(import.meta.url)), "../../../extensions/examples/hello");

interface Harness {
  sup: Supervisor;
  bus: EventBus;
  tools: ToolRegistry;
  commands: CommandRegistry;
  prompts: PromptContributors;
  /** Subscription to `subscribe`, opened before the modules start. */
  sub: Subscription | null;
}

const running: Harness[] = [];

afterEach(async () => {
  for (const h of running.splice(0)) await h.sup.stopAll();
});

async function harness(dirs: string[], extra = "", subscribe?: string): Promise<Harness> {
  const init = extra.includes("init_timeout_ms") ? "" : "init_timeout_ms = 5000\n";
  const config = Config.fromToml(
    `[modules.extensions]\ndirs = [${dirs.map((d) => JSON.stringify(d)).join(", ")}]\n${init}call_timeout_ms = 400\nshutdown_grace_ms = 500\n${extra}`,
  );
  const bus = new EventBus();
  const sub = subscribe === undefined ? null : bus.subscribe(subscribe);
  const services = new ServiceRegistry();
  const sup = new Supervisor({ bus, services });
  const tools = new ToolRegistry();
  const commands = new CommandRegistry(new Permissions());
  const prompts = new PromptContributors();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", CommandRegistryKey, commands);
  services.provide("app", PromptContributorsKey, prompts);
  services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  services.provide("app", SupervisorKey, sup);
  const discovery = discover(config, FIXTURES);
  for (const m of discovery.modules) await sup.register(m.module, m.config, m.enabled);
  await sup.startAll();
  const h = { sup, bus, tools, commands, prompts, sub };
  running.push(h);
  return h;
}

function status(h: Harness, id: string): { state: ModuleStateKind; reason: string | null } {
  const s = h.sup.list().find((m) => m.id === id);
  if (!s) throw new Error(`module ${id} not registered`);
  return s;
}

async function waitState(
  h: Harness,
  id: string,
  want: ModuleStateKind,
  withinMs: number,
): Promise<string | null> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const s = status(h, id);
    if (s.state === want) return s.reason;
    if (Date.now() > deadline) {
      throw new Error(`${id} is ${s.state} (${s.reason}), wanted ${want}`);
    }
    await sleep(25);
  }
}

const context: ContextKey = { platform: "discord", scope: null, channel: "c1", kind: "dm" };
const account: AccountRef = { platform: "discord", id: "42" };

function toolCtx(): ToolContext {
  return {
    turn: newId(),
    context,
    account,
    principal: { kind: "user", requester: account, context, override: false, actor: null },
    message: { context, id: "m1" },
    priority: "direct",
    signal: new AbortController().signal,
  };
}

async function call(h: Harness, name: string, args: JsonValue): Promise<string> {
  const tool = h.tools.get(name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool.call(toolCtx(), args);
}

function invocation(path: string, args: Record<string, string> = {}): Invocation {
  const inv = Invocation.create(path, account, context);
  inv.invoker_display_name = "Owen";
  for (const [k, v] of Object.entries(args)) inv.withArg(k, v);
  return inv;
}

async function recvWithin(sub: Subscription, ms: number): Promise<Envelope | null> {
  return Promise.race([sub.recv(), sleep(ms).then(() => null)]);
}

function payload(env: Envelope): JsonObject {
  if (env.event.type !== "custom") throw new Error("unexpected event");
  return env.event.data.payload as JsonObject;
}

describe("ext host end to end", { timeout: 30_000 }, () => {
  it("handshake_and_round_trips", async () => {
    const h = await harness([join(FIXTURES, "test-ext")]);
    await waitState(h, EXT, "running", 5000);
    expect(h.tools.names()).toEqual([
      "crash_now",
      "echo_say",
      "env_get",
      "slow_wait",
      "store_roundtrip",
      "try_publish",
    ]);
    expect((h.tools.get("echo_say")?.spec.parameters as JsonObject | undefined)?.type).toBe(
      "object",
    );

    // Tool call round trip, with the tool context forwarded.
    expect(await call(h, "echo_say", { text: "hi" })).toBe("echo: hi from 42");

    // Command invoke.
    const reply = await h.commands.dispatch(invocation("fixture echo", { text: "yo" }));
    expect(reply.text).toBe("fixture: yo by Owen");
    expect(reply.ephemeral).toBe(true);

    // Prompt contribution, namespaced by extension id.
    const contributor = h.prompts.all().find((c) => c.key === "ext.test.fixture.facts");
    expect(contributor).toBeDefined();
    const sections = await contributor?.contribute({
      profile: "p",
      turn: newId(),
      context,
      participants: [],
      speakers: [],
      query: "你好",
      recent: [],
      voice: false,
      now: new Date().toISOString(),
    });
    expect(sections?.[0]?.body).toBe("query=你好");
    expect(sections?.[0]?.key).toBe("facts");

    // Per-extension storage.
    expect(await call(h, "store_roundtrip", { key: "k", value: { n: 1 } })).toBe('{"n":1}');

    // Disabling the module removes every proxy.
    await h.sup.disable(EXT);
    expect(h.tools.isEmpty).toBe(true);
    expect(h.commands.specs()).toEqual([]);
    expect(h.prompts.all()).toEqual([]);
  });

  it("extensions_get_an_allowlisted_environment_not_the_cores_secrets", async () => {
    const saved = { ...process.env };
    process.env.MIYORIA_TEST_SECRET = "s3cret";
    process.env.LLM_API_KEY = "sk-should-never-leak";
    process.env.MIYORIA_TEST_PASSED = "yes";
    try {
      const h = await harness(
        [join(FIXTURES, "test-ext")],
        '[extensions."test.fixture"]\nenv = { MIYORIA_TEST_SET = "configured" }\n',
      );
      await waitState(h, EXT, "running", 5000);
      const seen = JSON.parse(await call(h, "env_get", {})) as {
        names: string[];
        secret: string | null;
        passed: string | null;
        set: string | null;
        rpc: string | null;
        path: boolean;
      };
      expect(seen.secret).toBeNull();
      expect(seen.names).not.toContain("LLM_API_KEY");
      expect(seen.passed).toBe("yes");
      expect(seen.set).toBe("configured");
      expect(seen.rpc).toBe("stdio");
      expect(seen.path).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("events_are_filtered_by_permissions", async () => {
    const h = await harness([join(FIXTURES, "test-ext")]);
    await waitState(h, EXT, "running", 5000);
    const seen = h.bus.subscribe(["ext.test.fixture.seen"]);
    // Granted: custom.ok.*, ext.other.*
    for (const topic of [
      "custom.ok.a",
      "custom.no.b",
      "ext.other.x",
      "ext.otherx.y",
      "custom.ok.c",
    ]) {
      h.bus.publish("test", customEvent(topic, {}));
    }
    const topics: string[] = [];
    while (topics.length < 3) {
      const env = await recvWithin(seen, 3000);
      if (!env) throw new Error("extension did not echo the event");
      expect(env.source).toBe(EXT);
      topics.push(payload(env).topic as string);
    }
    expect(topics.sort()).toEqual(["custom.ok.a", "custom.ok.c", "ext.other.x"]);
    expect(await recvWithin(seen, 200)).toBeNull();

    // Publishing permissions.
    const publish = (topic: string) => call(h, "try_publish", { topic });
    expect(await publish("custom.ok.z")).toBe("ok");
    expect(await publish("ext.test.fixture.mine")).toBe("ok");
    expect(await publish("custom.no.z")).toBe("denied: -32001");
    expect(await publish("platform.message.created")).toBe("denied: -32001");
    // `game.*` is granted, but only a declared adapter may publish game events.
    expect(await publish("game.fake.death")).toBe("denied: -32001");
  });

  it("game_adapter_owns_its_namespace", async () => {
    const GAME = "ext.test.game";
    let h = await harness([join(FIXTURES, "game-ext")]);
    await waitState(h, GAME, "running", 5000);
    // The declared game id reaches the extension in `initialize`. The adapter's `game_*` tools
    // are gated: never in the chat turns' tool registry, only in the one capabilities use.
    expect(h.tools.names()).not.toContain("game_fake_id");
    const gated = h.sup.services.get(GatedToolsKey);
    expect(gated?.names()).toContain("game_fake_id");
    const tool = gated?.get("game_fake_id");
    expect(await tool?.call(toolCtx(), {})).toBe("fake");

    const publish = (topic: string) => call(h, "try_publish", { topic });
    expect(await publish("game.fake.death")).toBe("ok");
    expect(await publish("game.fake.goal.reached")).toBe("ok");
    expect(await publish("ext.test.game.status")).toBe("ok");
    expect(await publish("game.other.death")).toBe("denied: -32001");
    expect(await publish("game.fake")).toBe("denied: -32001");
    expect(await publish("custom.ok.x")).toBe("denied: -32001");
    await h.sup.stopAll();

    // Tools in another game's namespace are refused.
    const extra = '[extensions."test.game"]\ndynamic = true\ndynamic_name = "game.other.act"';
    h = await harness([join(FIXTURES, "game-ext")], extra, "ext.test.game.register_result");
    await waitState(h, GAME, "running", 5000);
    const env = await recvWithin(h.sub as Subscription, 3000);
    if (!env) throw new Error("no register result");
    expect(payload(env).ok).toBe(false);
    expect(payload(env).code).toBe(-32001);
    expect(h.tools.isEmpty).toBe(true);
  });

  it("task_executor_round_trips_and_every_task_ends_with_a_code", async () => {
    const GAME = "ext.test.game";
    const extra = 'task_grace_ms = 100\n[extensions."test.game"]\nexecutor = true';
    const h = await harness([join(FIXTURES, "game-ext")], extra, "game.fake.task.*");
    await waitState(h, GAME, "running", 5000);
    const exec = h.sup.services.get(TaskExecutorsKey)?.get("game.fake");
    if (!exec) throw new Error("no executor registered for game.fake");
    expect(exec.info).toMatchObject({
      owner: "game.fake",
      name: "Fixture",
      guide: "just a fixture",
    });
    expect(exec.info.goals).toEqual([
      { name: "echo", description: "Ends at once", parameters: null, budget_s: 5 },
      { name: "hang", description: "Never ends", parameters: null, budget_s: null },
      { name: "crash", description: "Exits the process", parameters: null, budget_s: null },
    ]);
    expect(await exec.observe()).toMatchObject({ state: { fixture: true }, task: null });
    const sub = h.sub as Subscription;
    const next = async (): Promise<{ topic: string; payload: JsonObject }> => {
      const env = await recvWithin(sub, 3000);
      if (env?.event.type !== "custom") throw new Error("no task event");
      return { topic: env.event.data.topic, payload: env.event.data.payload as JsonObject };
    };

    // Done, published on `game.fake.task.*`; the extension's late `failed` is dropped.
    await exec.start({ id: "t1", goal: "echo", args: { n: 1 }, budget_s: 5 });
    expect((await next()).topic).toBe("game.fake.task.started");
    expect(await next()).toMatchObject({
      topic: "game.fake.task.progress",
      payload: { progress: 0.5 },
    });
    expect(await next()).toMatchObject({
      topic: "game.fake.task.done",
      payload: { type: "done", task: "t1", detail: 'echo {"n":1}', data: { n: 1 } },
    });

    // Never reported: the host fails it at budget + grace, with `timeout`.
    await exec.start({ id: "t2", goal: "hang", args: {}, budget_s: 0.2 });
    expect((await next()).payload).toMatchObject({ type: "started", task: "t2" });
    expect(await next()).toMatchObject({
      topic: "game.fake.task.failed",
      payload: { task: "t2", code: "timeout" },
    });

    // Cancelled: the extension says so (the late cancel of t2 is dropped).
    await exec.start({ id: "t3", goal: "hang", args: {}, budget_s: 30 });
    expect((await next()).payload).toMatchObject({ type: "started", task: "t3" });
    await exec.cancel("t3");
    expect((await next()).payload).toMatchObject({ type: "failed", task: "t3", code: "cancelled" });

    // The process dies mid-task: `crashed`, and the executor is gone with it.
    await exec.start({ id: "t4", goal: "crash", args: {}, budget_s: 30 });
    expect((await next()).payload).toMatchObject({ type: "started", task: "t4" });
    expect((await next()).payload).toMatchObject({ type: "failed", task: "t4", code: "crashed" });
    await waitState(h, GAME, "failed", 5000);
    expect(h.sup.services.get(TaskExecutorsKey)?.get("game.fake")).toBeUndefined();
    await expect(
      exec.start({ id: "t5", goal: "echo", args: {}, budget_s: 5 }),
    ).rejects.toMatchObject({ code: "disconnected" });
  });

  it("crash_fails_module_then_restarts", async () => {
    const h = await harness([join(FIXTURES, "test-ext")]);
    await waitState(h, EXT, "running", 5000);
    expect(await call(h, "crash_now", {})).toBe("bye");
    const reason = await waitState(h, EXT, "failed", 5000);
    expect(reason).toContain("exited");
    expect(h.tools.get("echo_say"), "proxies removed on crash").toBeUndefined();

    // Supervisor backoff (2 s for the first failure) brings it back.
    await waitState(h, EXT, "running", 8000);
    expect(await call(h, "echo_say", { text: "again" })).toBe("echo: again from 42");
  });

  it("requests_time_out", async () => {
    const h = await harness([join(FIXTURES, "test-ext")]);
    await waitState(h, EXT, "running", 5000);
    const started = Date.now();
    await expect(call(h, "slow_wait", {})).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
    // The connection is still usable afterwards.
    await expect(call(h, "echo_say", { text: "x" })).resolves.toBe("echo: x from 42");
  });

  it("initialize_times_out", async () => {
    const extra = 'init_timeout_ms = 300\n[extensions."test.fixture"]\nhang_init = true';
    const h = await harness([join(FIXTURES, "test-ext")], extra);
    const reason = (await waitState(h, EXT, "failed", 5000)) ?? "";
    expect(reason).toContain("initialize");
    expect(reason).toContain("timed out");
    expect(h.tools.isEmpty).toBe(true);
  });

  it("undeclared_permissions_are_rejected", async () => {
    // Static contributions with tools but no `tools` permission: start fails.
    let h = await harness([join(FIXTURES, "no-perms")]);
    const reason = (await waitState(h, "ext.test.noperms", "failed", 5000)) ?? "";
    expect(reason).toContain("`tools` permission");
    expect(h.tools.isEmpty).toBe(true);
    expect(h.commands.specs()).toEqual([]);
    await h.sup.stopAll();

    // Dynamic registration is refused with PERMISSION_DENIED.
    h = await harness(
      [join(FIXTURES, "no-perms")],
      '[extensions."test.noperms"]\ndynamic = true',
      "ext.test.noperms.register_result",
    );
    await waitState(h, "ext.test.noperms", "running", 5000);
    const env = await recvWithin(h.sub as Subscription, 3000);
    if (!env) throw new Error("no register result");
    expect(payload(env).ok).toBe(false);
    expect(payload(env).code).toBe(-32001);
    expect(h.tools.isEmpty).toBe(true);
  });

  it("discovery_skips_stage_extensions_and_honours_enabled", () => {
    const config = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(FIXTURES)}]\n[extensions."test.noperms"]\nenabled = false`,
    );
    const d = discover(config, ".");
    expect(d.modules.map((m) => [m.module.manifest.id, m.enabled])).toEqual([
      ["extensions", true],
      ["ext.test.game", true],
      ["ext.test.noperms", false],
      ["ext.test.fixture", true],
    ]);
    expect(d.skipped).toHaveLength(1);
    expect(d.skipped[0]?.reason).toContain("stage");
    expect(d.modules[3]?.module.manifest.requires).toEqual(["extensions"]);
  });

  it("dev_mode_restarts_on_file_change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-dev-"));
    try {
      const extDir = join(dir, "test-ext");
      mkdirSync(extDir, { recursive: true });
      for (const f of ["index.mjs", "miyoria.extension.toml"]) {
        copyFileSync(join(FIXTURES, "test-ext", f), join(extDir, f));
      }
      const h = await harness([dir], "dev = true\nwatch_poll_ms = 100");
      await waitState(h, EXT, "running", 5000);
      const states = h.bus.subscribe("system.module.state");
      const script = join(extDir, "index.mjs");
      writeFileSync(script, `${readFileSync(script, "utf8")}\n// touched\n`);

      let sawStopping = false;
      const deadline = Date.now() + 8000;
      for (;;) {
        const env = await recvWithin(states, Math.max(deadline - Date.now(), 1));
        if (!env) throw new Error("no restart after file change");
        if (env.event.type !== "module_state_changed" || env.event.data.module !== EXT) continue;
        if (env.event.data.state === "stopping") sawStopping = true;
        else if (env.event.data.state === "running" && sawStopping) break;
      }
      await expect(call(h, "echo_say", { text: "dev" })).resolves.toBe("echo: dev from 42");
      await h.sup.stopAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Runs the SDK example when it has been built (`pnpm build` in packages/sdk and the example). */
  it.skipIf(!existsSync(join(HELLO, "dist/index.js")))("sdk_hello_example", async () => {
    const h = await harness([HELLO]);
    await waitState(h, "ext.miyoria.hello", "running", 10_000);
    const out = await call(h, "dice", { sides: 6, count: 3 });
    expect(out).toContain("骰");
    const reply = await h.commands.dispatch(invocation("hello"));
    expect(reply.text).toContain("Owen");
  });
});
