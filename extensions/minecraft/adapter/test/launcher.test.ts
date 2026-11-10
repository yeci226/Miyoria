// The Prism launcher with a fake process, and `launch` / `quit` through the adapter.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MinecraftAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { LaunchError, Launcher, type LauncherConfig, prismCandidates, prismInstanceOf } from "../src/launcher.js";
import { FakeMod, waitFor } from "./fake-mod.js";

const ROOT = join("C:", "Users", "me", "AppData", "Roaming", "PrismLauncher");
const GAME_DIR = join(ROOT, "instances", "Miyoria-1.21.1", ".minecraft");
const EXE = join("C:", "Users", "me", "AppData", "Local", "Programs", "PrismLauncher", "prismlauncher.exe");
const ENV = { LOCALAPPDATA: join("C:", "Users", "me", "AppData", "Local"), APPDATA: join("C:", "Users", "me", "AppData", "Roaming") };

class FakeProcess extends EventEmitter {
  unrefed = false;
  unref(): void {
    this.unrefed = true;
  }
}

function setup(config: LauncherConfig = {}, opts: { exists?: (p: string) => boolean; now?: () => number } = {}) {
  const spawned: Array<{ command: string; args: string[]; process: FakeProcess }> = [];
  const launcher = new Launcher({
    config,
    minecraftDir: GAME_DIR,
    env: ENV,
    platform: "win32",
    exists: opts.exists ?? ((p) => p === EXE),
    saves: () => [
      { name: "New World", playedAt: 1 },
      { name: "Survival", playedAt: 5 },
    ],
    now: opts.now,
    spawn: (command, args) => {
      const process = new FakeProcess();
      spawned.push({ command, args, process });
      return process;
    },
  });
  return { launcher, spawned };
}

describe("launcher", () => {
  it("finds the instance and the installed Prism from the game dir", () => {
    expect(prismInstanceOf(GAME_DIR)).toEqual({ root: ROOT, instance: "Miyoria-1.21.1" });
    expect(prismInstanceOf(join("C:", "games", ".minecraft"))).toBeUndefined();
    const candidates = prismCandidates(ENV, "win32", ROOT);
    expect(candidates[0]).toBe(join(ROOT, "prismlauncher.exe")); // portable first
    expect(candidates).toContain(EXE);
    const { launcher } = setup();
    expect(launcher.instance()).toBe("Miyoria-1.21.1");
    expect(launcher.executable()).toBe(EXE);
    expect(launcher.problem()).toBeNull();
  });

  it("launches the instance into the world played last, detached", () => {
    const { launcher, spawned } = setup();
    const status = launcher.launch();
    expect(status).toMatchObject({ state: "starting", world: "Survival" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe(EXE);
    expect(spawned[0]?.args).toEqual(["--launch", "Miyoria-1.21.1", "--world", "Survival"]);
    expect(spawned[0]?.process.unrefed).toBe(true);
    // a second call while it starts does not start another one
    launcher.launch();
    expect(spawned).toHaveLength(1);
    // a launcher handing over to a running Prism exits with 0: still starting
    spawned[0]?.process.emit("exit", 0);
    expect(launcher.status().state).toBe("starting");
    launcher.connected();
    expect(launcher.status()).toEqual({ state: "idle" });
    expect(launcher.launchedByUs).toBe(true);
  });

  it("uses the configured exe, instance and world (or the main menu)", () => {
    const custom = join("D:", "Prism", "prismlauncher.exe");
    const { launcher, spawned } = setup(
      { prism_path: custom, prism_instance: "Other", launch_world: "" },
      { exists: (p) => p === custom },
    );
    launcher.launch();
    expect(spawned[0]?.command).toBe(custom);
    expect(spawned[0]?.args).toEqual(["--launch", "Other"]);
  });

  it("reports a launcher that fails or never connects", () => {
    let now = 0;
    const { launcher, spawned } = setup({ launch_timeout_secs: 30 }, { now: () => now });
    launcher.launch();
    spawned[0]?.process.emit("error", new Error("spawn EACCES"));
    expect(launcher.status()).toEqual({ state: "failed", error: "Prism Launcher 啟動失敗:spawn EACCES" });
    expect(launcher.launchedByUs).toBe(false);

    launcher.launch();
    spawned[1]?.process.emit("exit", 1);
    expect(launcher.status()).toMatchObject({ state: "failed", error: expect.stringContaining("代碼 1") });

    launcher.launch();
    now = 31_000;
    expect(launcher.status()).toMatchObject({ state: "failed", error: expect.stringContaining("等了 30 秒") });
  });

  it("refuses to launch without Prism, without an instance, or when switched off", () => {
    expect(() => setup({}, { exists: () => false }).launcher.launch()).toThrow(LaunchError);
    expect(setup({}, { exists: () => false }).launcher.problem()).toContain("找不到 Prism Launcher");
    const none = new Launcher({ config: {}, env: ENV, platform: "win32", exists: (p) => p === EXE });
    expect(none.problem()).toContain("不知道要開哪個 Prism 實例");
    expect(setup({ auto_launch: false }).launcher.problem()).toContain("auto_launch");
  });

  it("closes only the game she opened, unless told otherwise", () => {
    const { launcher } = setup();
    expect(launcher.shouldQuit()).toBe(false);
    launcher.launch();
    expect(launcher.shouldQuit()).toBe(true);
    launcher.quitting();
    expect(launcher.shouldQuit()).toBe(false);
    expect(setup({ quit_on_stop: "always" }).launcher.shouldQuit()).toBe(true);
    const never = setup({ quit_on_stop: "never" }).launcher;
    never.launch();
    expect(never.shouldQuit()).toBe(false);
  });
});

describe("launch and quit actions", () => {
  let mod: FakeMod | undefined;
  let bridge: BridgeClient | undefined;

  afterEach(async () => {
    bridge?.close();
    bridge = undefined;
    await mod?.stop();
    mod = undefined;
  });

  it("launches when the game is down, reports progress in observe, and quits what it opened", async () => {
    const { launcher, spawned } = setup();
    let up = false;
    const m = await FakeMod.start();
    mod = m;
    // The "game" is only reachable once launched.
    bridge = new BridgeClient({
      endpoint: () => ({ url: up ? m.url : "ws://127.0.0.1:1", token: m.token }),
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
      requestTimeoutMs: 500,
    });
    const adapter = new MinecraftAdapter(bridge, { launcher });
    bridge.start();

    const down = await adapter.observe();
    expect(down.state).toMatchObject({ connected: false, launch: { available: true, state: "idle" } });

    const started = await adapter.act({ name: "launch" });
    expect(started.ok).toBe(true);
    expect(started.message).toContain("Miyoria-1.21.1");
    expect(started.message).toContain("Survival");
    expect(spawned[0]?.args).toContain("--launch");
    expect((await adapter.observe()).state).toMatchObject({ connected: false, launch: { state: "starting" } });

    up = true;
    const b = bridge;
    await waitFor(() => b.ready);
    expect(launcher.status().state).toBe("idle");
    expect(await adapter.act({ name: "launch" })).toMatchObject({ ok: true, message: "Minecraft 已經開著了" });

    expect(await adapter.act({ name: "quit" })).toEqual({ ok: true, message: "關掉 Minecraft 了" });
    expect(m.requests.at(-1)?.type).toBe("quit");
    // not hers any more: a second quit leaves it alone
    expect((await adapter.act({ name: "quit" })).message).toContain("沒關");
  });

  it("a launch that cannot start is a failed action with the reason", async () => {
    const { launcher } = setup({}, { exists: () => false });
    bridge = new BridgeClient({ endpoint: () => ({ url: "ws://127.0.0.1:1", token: "x" }), reconnectMinMs: 10 });
    const adapter = new MinecraftAdapter(bridge, { launcher });
    const result = await adapter.act({ name: "launch" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("找不到 Prism Launcher");
    expect((await adapter.observe()).state).toMatchObject({ launch: { available: false } });
    // As a task: refused with `precondition`.
    const events: Array<{ type: string; code?: string }> = [];
    void (async () => {
      for await (const e of adapter.tasks.events()) events.push(e as { type: string; code?: string });
    })();
    await adapter.tasks.start({ id: "l1", goal: "launch", args: {}, budget_s: 5 });
    await waitFor(() => events.some((e) => e.type === "failed"));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "precondition" });
  });

  it("the launch task ends once the game connected and the world it joins loaded", async () => {
    const { launcher } = setup();
    let up = false;
    let inWorld = false;
    const m = await FakeMod.start();
    mod = m;
    m.respond = (req) =>
      req.type === "observe" && !inWorld ? { ok: false, code: "not_in_game", message: "loading" } : { ok: true, data: {} };
    bridge = new BridgeClient({
      endpoint: () => ({ url: up ? m.url : "ws://127.0.0.1:1", token: m.token }),
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
      requestTimeoutMs: 500,
    });
    const adapter = new MinecraftAdapter(bridge, { launcher, launchPollMs: 20 });
    bridge.start();
    const events: Array<{ type: string; detail?: string }> = [];
    void (async () => {
      for await (const e of adapter.tasks.events()) events.push(e as { type: string; detail?: string });
    })();
    await adapter.tasks.start({ id: "l1", goal: "launch", args: {}, budget_s: 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.map((e) => e.type)).toEqual(["started"]);
    // Connected, still loading the world it asked for: keep waiting.
    up = true;
    const b = bridge;
    await waitFor(() => b.ready);
    await new Promise((r) => setTimeout(r, 60));
    expect(events.map((e) => e.type)).toEqual(["started"]);
    inWorld = true;
    await waitFor(() => events.some((e) => e.type === "done"));
    expect(events.at(-1)).toMatchObject({ type: "done", detail: "連上 Minecraft 了" });
  });
});
