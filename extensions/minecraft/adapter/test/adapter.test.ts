import type { GameEvent, TaskEvent, TaskSpec } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HIDDEN_ACTIONS, failureCode, toRequests } from "../src/actions.js";
import { MinecraftAdapter, modFailureCode } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { mapEvent } from "../src/events.js";
import { compactState, summarize } from "../src/summary.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let bridge: BridgeClient | undefined;

afterEach(async () => {
  bridge?.close();
  bridge = undefined;
  await mod?.stop();
  mod = undefined;
});

async function setup(opts: ConstructorParameters<typeof MinecraftAdapter>[1] = {}) {
  mod = await FakeMod.start();
  const m = mod;
  bridge = new BridgeClient({
    endpoint: () => ({ url: m.url, token: m.token }),
    reconnectMinMs: 20,
    requestTimeoutMs: 500,
  });
  const adapter = new MinecraftAdapter(bridge, opts);
  bridge.start();
  const b = bridge;
  await waitFor(() => b.ready);
  return { mod: m, adapter };
}

/** Collects events from the adapter's stream in the background. */
function collect(adapter: MinecraftAdapter): GameEvent[] {
  const out: GameEvent[] = [];
  void (async () => {
    for await (const e of adapter.events()) out.push(e);
  })();
  return out;
}

describe("summary", () => {
  it("summarizes a snapshot in Traditional Chinese", () => {
    const text = summarize(SNAPSHOT);
    expect(text).toContain("血量 17.5/20、飢餓 18/20");
    expect(text).toContain("位置 (100, 64, -21)・主世界・平原");
    expect(text).toContain("白天(約 5 分鐘後天黑)、晴天");
    expect(text).toContain("手上:鐵鎬(耐久 88%)");
    expect(text).toContain("背包:鵝卵石×84、蘋果×3、鐵鎬×1(空格 32)");
    expect(text).toContain("看著:橡木原木(2.4 格)");
    expect(text).toContain("附近:殭屍 3 格(敵對)、玩家 Steve 8 格、牛 12 格");
    expect(text).toContain("看得到的方塊:鑽石礦×2 40 格、箱子×1 5 格");
    expect(text).toContain("最好的鎬:鐵鎬");
    expect(text).toContain("食物:蘋果×3");
    expect(text).toContain("Baritone 執行中(Mine)");
  });

  it("keeps a compact structured state with ids", () => {
    const state = compactState(SNAPSHOT);
    expect(state).toMatchObject({
      connected: true,
      in_game: true,
      busy: true,
      health: 17.5,
      position: { x: 100, y: 64, z: -21 },
      held: "iron_pickaxe",
      inventory: { cobblestone: 84, apple: 3, iron_pickaxe: 1 },
      entities: [{ type: "zombie", d: 3, hostile: true }, { type: "player", name: "Steve", d: 8 }, { type: "cow", d: 12 }],
      blocks: [{ block: "diamond_ore", count: 2, at: { x: 30, y: 12, z: 30 } }, { block: "chest", count: 1 }],
      baritone: { busy: true, process: "Mine" },
    });
    expect(state).not.toHaveProperty("hotbar");
    expect(state).not.toHaveProperty("altoclef");
    expect(JSON.stringify(state).length).toBeLessThan(JSON.stringify(SNAPSHOT).length);
  });
});

describe("actions", () => {
  it("maps high-level actions onto mod requests", () => {
    expect(toRequests({ name: "goto", args: { x: 1.4, z: -3 } })).toEqual([
      { type: "baritone", params: { command: "goto", x: 1, z: -3 } },
    ]);
    expect(toRequests({ name: "goto", args: { block: "Crafting Table" } })).toEqual([
      { type: "baritone", params: { command: "goto", block: "crafting_table" } },
    ]);
    expect(toRequests({ name: "mine", args: { blocks: ["iron_ore"], block: "deepslate_iron_ore", count: "12" } })).toEqual([
      { type: "baritone", params: { command: "mine", blocks: ["iron_ore", "deepslate_iron_ore"], count: 12 } },
    ]);
    expect(toRequests({ name: "follow", args: { player: "Owen" } })[0]?.params).toEqual({ command: "follow", player: "Owen" });
    expect(toRequests({ name: "explore" })[0]?.params).toEqual({ command: "explore" });
    expect(toRequests({ name: "farm", args: { range: 10 } })[0]?.params).toEqual({ command: "farm", range: 10 });
    expect(toRequests({ name: "build", args: { schematic: "house.schem" } })[0]?.params).toEqual({
      command: "build",
      schematic: "house.schem",
    });
    expect(toRequests({ name: "get", args: { item: "iron_pickaxe" } })).toEqual([
      { type: "altoclef", params: { command: "get iron_pickaxe 1" } },
    ]);
    expect(toRequests({ name: "chat", args: { message: "大家好" } })).toEqual([{ type: "chat", params: { message: "大家好" } }]);
    expect(toRequests({ name: "look", args: { at: { x: 1, y: 2, z: 3 } } })).toEqual([
      { type: "look", params: { at: { x: 1, y: 2, z: 3 } } },
    ]);
    expect(toRequests({ name: "look", args: { pitch: 200 } })[0]?.params).toEqual({ pitch: 90 });
    expect(toRequests({ name: "use", args: { hold_ticks: 32 } })).toEqual([{ type: "use", params: { hold_ticks: 32 } }]);
    expect(toRequests({ name: "attack" })).toEqual([{ type: "attack", params: {} }]);
    expect(toRequests({ name: "select", args: { item: "bread" } })).toEqual([{ type: "select_slot", params: { item: "bread" } }]);
    expect(toRequests({ name: "respawn" })).toEqual([{ type: "respawn", params: {} }]);
    expect(toRequests({ name: "stop" })).toEqual([{ type: "stop", params: {} }]);
    expect(toRequests({ name: "drop", args: { item: "dirt", all: true } })).toEqual([
      { type: "drop", params: { item: "dirt", all: true } },
    ]);
  });

  it("rejects bad arguments with a message for the model", () => {
    expect(() => toRequests({ name: "goto", args: {} })).toThrow("goto 要給");
    expect(() => toRequests({ name: "mine", args: {} })).toThrow("mine 要給");
    expect(() => toRequests({ name: "chat", args: { message: "/op me" } })).toThrow("不能下指令");
    expect(toRequests({ name: "chat", args: { message: "/time set day" } }, { allowCommands: true })).toHaveLength(1);
    expect(() => toRequests({ name: "select", args: { slot: 9 } })).toThrow("0–8");
    expect(() => toRequests({ name: "fly" })).toThrow("沒有「fly」");
  });
});

describe("events", () => {
  it("maps mod events with text and importance", () => {
    expect(mapEvent({ name: "death", data: { last_damage_source: "mob", last_attacker: "creeper" } })).toEqual({
      type: "death",
      data: { last_damage_source: "mob", last_attacker: "creeper", text: "死掉了(苦力怕)" },
      important: true,
    });
    expect(mapEvent({ name: "damage", data: { amount: 1, source: "fall", health: 19 } })).toMatchObject({
      important: false,
      data: { text: "受傷 -1(摔落),剩 19 血" },
    });
    expect(mapEvent({ name: "damage", data: { amount: 6, source: "explosion" } })?.important).toBe(true);
    expect(mapEvent({ name: "damage", data: { amount: 2 } }, { damageImportant: 2 })?.important).toBe(true);
    expect(mapEvent({ name: "hostile_near", data: { new_types: ["zombie"] } })?.important).toBe(false);
    expect(mapEvent({ name: "hostile_near", data: { new_types: ["creeper"] } })).toMatchObject({
      important: true,
      data: { text: "附近出現 苦力怕" },
    });
    expect(mapEvent({ name: "item_picked", data: { items: { diamond: 1 } } })?.important).toBe(true);
    expect(mapEvent({ name: "chat", data: { sender: "Me", message: "hi", system: false, self: true } })).toBeNull();
    expect(mapEvent({ name: "chat", data: { sender: "Steve", message: "你好", system: false, self: false } })).toMatchObject({
      important: true,
      data: { text: "Steve 在遊戲裡說:你好" },
    });
    expect(mapEvent({ name: "advancement", data: { kind: "task", title: "Stone Age" } })?.data).toMatchObject({
      text: "達成成就「Stone Age」",
    });
    expect(mapEvent({ name: "baritone_idle", data: { cancelled: true } })?.important).toBe(false);
    expect(mapEvent({ name: "Weird Name", data: {} })).toBeNull();
    expect(mapEvent({ name: "something_new", data: { a: 1 } })).toEqual({ type: "something_new", data: { a: 1 } });
  });
});

describe("MinecraftAdapter", () => {
  it("describes the game: one entry for getting items, a budget per goal", async () => {
    const { adapter } = await setup();
    const info = adapter.describe();
    expect(info.id).toBe("minecraft");
    expect(info.actions.map((a) => a.name)).toEqual([
      "goto",
      "mine",
      "follow",
      "explore",
      "farm",
      "build",
      "obtain",
      "hunt",
      "shelter",
      "recover",
      "place",
      "chat",
      "stop",
      "look",
      "attack",
      "use",
      "select",
      "respawn",
      "drop",
      "launch",
      "quit",
    ]);
    // `get`, `craft` and `smelt` are still understood, just not offered.
    expect(HIDDEN_ACTIONS.map((a) => a.name)).toEqual(["get", "craft", "smelt"]);
    for (const a of info.actions) expect(a.budget_s, a.name).toBeGreaterThan(0);
  });

  it("observes through the mod", async () => {
    const { mod, adapter } = await setup();
    mod.respond = (req) => (req.type === "observe" ? { ok: true, data: SNAPSHOT } : { ok: true });
    const obs = await adapter.observe();
    expect(obs.summary).toContain("血量 17.5/20");
    expect(obs.state).toMatchObject({ busy: true, capabilities: { baritone: true, altoclef: true } });

    mod.respond = () => ({ ok: false, code: "not_in_game", message: "no world" });
    const menu = await adapter.observe();
    expect(menu.summary).toContain("主選單");
    expect(menu.state).toMatchObject({ connected: true, in_game: false });
    // The executor's observe is the same state, structured, with the running task.
    expect(await adapter.tasks.observe()).toMatchObject({ state: { in_game: false }, task: null });
  });

  it("reports a missing connection instead of throwing", async () => {
    const b = new BridgeClient({ endpoint: () => ({ url: "ws://127.0.0.1:1", token: "x" }) });
    const adapter = new MinecraftAdapter(b);
    const obs = await adapter.observe();
    expect(obs.state).toMatchObject({ connected: false, launch: { available: false } });
    expect(obs.summary).toContain("沒有連上 Minecraft");
    expect(await adapter.act({ name: "stop" })).toMatchObject({
      ok: false,
      code: "disconnected",
      message: expect.stringContaining("沒有連上"),
    });
  });

  it("acts and maps mod errors onto codes", async () => {
    const { mod, adapter } = await setup();
    mod.respond = (req) =>
      req.type === "baritone" ? { ok: true, data: { command: req.command } } : { ok: false, code: "invalid_args", message: "slot must be 0-8" };
    expect(await adapter.act({ name: "mine", args: { block: "iron_ore", count: 3 } })).toEqual({
      ok: true,
      message: "開始挖 iron_ore ×3",
      data: { command: "mine" },
    });
    expect(mod.requests.at(-1)).toMatchObject({ type: "baritone", command: "mine", blocks: ["iron_ore"], count: 3 });
    expect(await adapter.act({ name: "select", args: { item: "x" } })).toEqual({
      ok: false,
      code: "invalid",
      message: "參數不對:slot must be 0-8",
    });
    expect(await adapter.act({ name: "goto", args: {} })).toMatchObject({ ok: false, code: "invalid" });
    // observe (her pickaxe, for the mine check), mine, select_slot
    expect(mod.requests.map((r) => r.type)).toEqual(["observe", "baritone", "select_slot"]);
    expect(failureCode("not_visible")).toBe("not_found");
    expect(failureCode("too_far")).toBe("unreachable");
    expect(failureCode("missing_items")).toBe("precondition");
    expect(failureCode("reflex_active")).toBe("busy");
  });

  it("checks capabilities before sending", async () => {
    mod = await FakeMod.start();
    mod.capabilities = { baritone: true, altoclef: false, screenshot: false };
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }) });
    const adapter = new MinecraftAdapter(bridge);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    expect(await adapter.act({ name: "get", args: { item: "iron_pickaxe" } })).toMatchObject({
      ok: false,
      code: "precondition",
      message: expect.stringContaining("AltoClef"),
    });
    expect(m.requests).toHaveLength(0);
  });

  it("streams mapped events, connection changes included; job events stay with the tasks", async () => {
    mod = await FakeMod.start();
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20 });
    const adapter = new MinecraftAdapter(bridge);
    const events = collect(adapter);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    m.emit("death", { last_damage_source: "lava" });
    m.emit("chat", { sender: "Me", message: "x", system: false, self: true });
    m.emit("goal_reached", { goal: "GoalBlock{x=1,y=2,z=3}" });
    m.emit("task_done", { task: "x", kind: "goto" });
    m.emit("night_started", { time_of_day: 13000 });
    await waitFor(() => events.length === 3);
    expect(events.map((e) => e.type)).toEqual(["connected", "death", "night_started"]);
    expect(events[0]?.data).toMatchObject({ text: "連上 Minecraft 1.21.1(Baritone、AltoClef)" });
    expect(events[1]).toMatchObject({ important: true, data: { text: "死掉了(岩漿)" } });
    m.kick();
    await waitFor(() => events.some((e) => e.type === "disconnected"));
    await waitFor(() => events.filter((e) => e.type === "connected").length === 2);
    adapter.close();
  });
});

/** Collects the executor's task events in the background. */
function taskEvents(adapter: MinecraftAdapter): TaskEvent[] {
  const out: TaskEvent[] = [];
  void (async () => {
    for await (const e of adapter.tasks.events()) out.push(e);
  })();
  return out;
}

const spec = (id: string, goal: string, args: Record<string, unknown> = {}, budget_s = 30): TaskSpec => ({
  id,
  goal,
  args,
  budget_s,
});

const ends = (events: TaskEvent[]) =>
  events.filter((e) => e.type === "done" || e.type === "failed").map((e) => [e.task, e.type === "failed" ? e.code : "done"]);

describe("tasks with an older mod (no task ids)", () => {
  /** Emits a marker and waits for it, so everything sent before it has been handled. */
  async function flush(m: FakeMod, events: GameEvent[]): Promise<void> {
    const n = events.filter((e) => e.type === "night_started").length;
    m.emit("night_started", { time_of_day: 13000 });
    await waitFor(() => events.filter((e) => e.type === "night_started").length === n + 1);
  }

  it("a goto ends on goal_reached; mining ignores path segments and ends on baritone_idle", async () => {
    const { mod: m, adapter } = await setup();
    const events = collect(adapter);
    const tasks = taskEvents(adapter);
    await waitFor(() => events.length === 1); // connected

    await adapter.tasks.start(spec("m1", "mine", { block: "iron_ore", count: 5 }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    // The work request carries the task id (an older mod just ignores it).
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "mine", task: "m1" });
    // Baritone reaches (or fails to path to) one ore after another while mining.
    m.emit("goal_reached", { goal: "GoalComposite" });
    m.emit("goal_failed", { reason: "no_path", goal: "GoalComposite" });
    await flush(m, events);
    expect(ends(tasks)).toEqual([]);
    m.emit("baritone_idle", { process: "Mine", goal: null, cancelled: false });
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["m1", "done"]]);

    await adapter.tasks.start(spec("g1", "goto", { x: 10, y: 64, z: 10 }));
    await waitFor(() => m.requests.filter((r) => r.type === "baritone").length === 2);
    m.emit("goal_reached", { goal: "GoalBlock{x=10,y=64,z=10}" });
    await waitFor(() => ends(tasks).length === 2);
    expect(tasks.find((e) => e.task === "g1" && e.type === "done")).toMatchObject({ detail: "抵達目標了" });
    // No path: `unreachable`.
    await adapter.tasks.start(spec("g2", "goto", { x: 99, z: 99 }));
    await waitFor(() => m.requests.filter((r) => r.type === "baritone").length === 3);
    m.emit("goal_failed", { reason: "no_path", goal: "GoalXZ" });
    await waitFor(() => ends(tasks).length === 3);
    expect(ends(tasks).at(-1)).toEqual(["g2", "unreachable"]);
    // None of the job events reached the commentary stream.
    expect(events.map((e) => e.type).filter((t) => t !== "night_started")).toEqual(["connected"]);
  });

  it("chat runs alongside; a new body task supersedes the old one without a stop", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("f1", "follow", { player: "Owen" }));
    await adapter.tasks.start(spec("c1", "chat", { message: "我跟著你" }));
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["c1", "done"]]);
    await adapter.tasks.start(spec("e1", "explore"));
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks)).toContainEqual(["f1", "superseded"]);
    await waitFor(() => m.requests.filter((r) => r.type === "baritone").length === 2);
    expect(m.requests.some((r) => r.type === "stop")).toBe(false);
  });

  it("drop is an instant goal: one request, done when the mod accepts it", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("d1", "drop", { item: "rotten_flesh" }));
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["d1", "done"]]);
    expect(m.requests.find((r) => r.type === "drop")).toMatchObject({ item: "rotten_flesh", all: true });
  });

  it("cancel and timeout stop the mod's work and end the task with the code", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    await adapter.tasks.cancel("m1");
    await waitFor(() => m.requests.some((r) => r.type === "stop"));
    expect(ends(tasks)).toEqual([["m1", "cancelled"]]);

    await adapter.tasks.start(spec("m2", "mine", { block: "oak_log" }, 0.2));
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks).at(-1)).toEqual(["m2", "timeout"]);
    await waitFor(() => m.requests.filter((r) => r.type === "stop").length === 2);
  });

  it("an open-ended goal is done at the end of its budget", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("f1", "follow", { entity: "cow" }, 1));
    await waitFor(() => ends(tasks).length === 1, 3000);
    expect(ends(tasks)).toEqual([["f1", "done"]]);
    await waitFor(() => m.requests.some((r) => r.type === "stop"));
    // An explore that only ran out its time is done too, but says it saw nothing new.
    await adapter.tasks.start(spec("x1", "explore", {}, 1));
    await waitFor(() => ends(tasks).length === 2, 3000);
    expect(ends(tasks).at(-1)).toEqual(["x1", "done"]);
    expect(tasks.find((e) => e.task === "x1" && e.type === "done")).toMatchObject({
      data: { outcome: { progressed: false } },
    });
    expect(m.requests.some((r) => r.type === "stop")).toBe(true);
  });

  it("an interrupting reflex or a death ends the job with busy / died", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("m1", "mine", { block: "oak_log" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    m.emit("reflex", { kind: "flee", target: "creeper", interrupted: "Mine" });
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["m1", "busy"]]);
    await adapter.tasks.start(spec("c1", "craft", { item: "stick" }));
    await waitFor(() => m.requests.some((r) => r.type === "craft"));
    expect(m.requests.find((r) => r.type === "craft")).toMatchObject({ task: "c1" });
    m.emit("death", { last_damage_source: "lava" });
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks).at(-1)).toEqual(["c1", "died"]);
  });

  it("waits for AltoClef itself to be idle before ending a get", async () => {
    const { mod: m, adapter } = await setup();
    let altoBusy: boolean | null = true;
    m.respond = (req) =>
      req.type === "observe"
        ? { ok: true, data: { ...SNAPSHOT, altoclef: { available: true, busy: altoBusy } } }
        : { ok: true, data: {} };
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("a1", "obtain", { item: "iron_pickaxe", strategy: "altoclef" }));
    await waitFor(() => m.requests.some((r) => r.type === "altoclef"));
    expect(m.requests.find((r) => r.type === "altoclef")).toMatchObject({ command: "get iron_pickaxe 1", task: "a1" });

    // Baritone finishes one leg of the AltoClef task (walk to a tree), AltoClef keeps going.
    m.emit("goal_reached", { goal: "GoalGetToBlock" });
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: false });
    await waitFor(() => m.requests.filter((r) => r.type === "observe").length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(ends(tasks)).toEqual([]);

    // The last leg: AltoClef is idle now.
    altoBusy = false;
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: false });
    await waitFor(() => ends(tasks).length === 1);
    expect(tasks.find((e) => e.type === "done")).toMatchObject({ task: "a1", detail: "AltoClef 任務做完了" });
  });

  it("an idle we caused during an AltoClef task is a cancel, without asking AltoClef", async () => {
    const { mod: m, adapter } = await setup();
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("a1", "get", { item: "bread" }));
    await waitFor(() => m.requests.some((r) => r.type === "altoclef"));
    m.emit("baritone_idle", { process: "Custom Goal", goal: null, cancelled: true });
    await waitFor(() => ends(tasks).length === 1);
    expect(ends(tasks)).toEqual([["a1", "cancelled"]]);
    // One look measured the inventory before it started; none asked AltoClef.
    expect(m.requests.filter((r) => r.type === "observe")).toHaveLength(1);
  });
});

describe("tasks with a mod that reports task ids", () => {
  async function setupTasks() {
    mod = await FakeMod.start();
    mod.capabilities = { baritone: true, altoclef: true, screenshot: true, tasks: true };
    const m = mod;
    bridge = new BridgeClient({ endpoint: () => ({ url: m.url, token: m.token }), reconnectMinMs: 20, requestTimeoutMs: 500 });
    const adapter = new MinecraftAdapter(bridge);
    bridge.start();
    const b = bridge;
    await waitFor(() => b.ready);
    return { mod: m, adapter };
  }

  it("ends exactly when the mod says, for that id, with the mod's code", async () => {
    const { mod: m, adapter } = await setupTasks();
    expect(adapter.modTasks).toBe(true);
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("m1", "mine", { block: "iron_ore" }));
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    expect(m.requests.find((r) => r.type === "baritone")).toMatchObject({ command: "mine", task: "m1" });
    // Nothing is guessed from Baritone's own events any more.
    m.emit("goal_reached", { goal: "GoalComposite", task: "m1" });
    m.emit("baritone_idle", { process: "Mine", goal: null, cancelled: false, task: "m1" });
    m.emit("task_done", { task: "other", kind: "mine" });
    await new Promise((r) => setTimeout(r, 30));
    expect(ends(tasks)).toEqual([]);
    m.emit("task_done", { task: "m1", kind: "mine", detail: "挖完了" });
    await waitFor(() => ends(tasks).length === 1);
    expect(tasks.find((e) => e.type === "done")).toMatchObject({ task: "m1", detail: "挖完了" });

    await adapter.tasks.start(spec("g1", "goto", { x: 1, z: 2 }));
    await waitFor(() => m.requests.filter((r) => r.type === "baritone").length === 2);
    m.emit("task_failed", { task: "g1", kind: "goto", code: "unreachable", message: "no path" });
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks).at(-1)).toEqual(["g1", "unreachable"]);

    await adapter.tasks.start(spec("c1", "craft", { item: "stick" }));
    await waitFor(() => m.requests.some((r) => r.type === "craft"));
    m.emit("task_failed", { task: "c1", kind: "craft", code: "interrupted", message: "reflex: fight" });
    await waitFor(() => ends(tasks).length === 3);
    expect(ends(tasks).at(-1)).toEqual(["c1", "busy"]);
    expect(modFailureCode("died")).toBe("died");
    expect(modFailureCode("whatever")).toBe("internal");
  });
});

describe("obtain: one entry, the old paths as strategies", () => {
  it("plans from the inventory, runs the steps as progress and ends with the plan", async () => {
    const { mod: m, adapter } = await setup();
    let inventory: Record<string, number> = { oak_planks: 2 };
    m.respond = (req) =>
      req.type === "observe"
        ? { ok: true, data: { ...SNAPSHOT, inventory, nearby_blocks: [], baritone: { available: true, busy: false } } }
        : { ok: true, data: {} };
    const events = collect(adapter);
    const tasks = taskEvents(adapter);
    await waitFor(() => events.length === 1);

    await adapter.tasks.start(spec("o1", "obtain", { item: "stick" }, 60));
    await waitFor(() => m.requests.some((r) => r.type === "craft"));
    expect(m.requests.find((r) => r.type === "craft")).toMatchObject({ item: "stick", count: 4 });
    const busy = await adapter.observe();
    expect(busy.state).toMatchObject({ busy: true, plan: { target: "stick", step: 1, total: 1, doing: "做木棒×4" } });
    expect(busy.summary).toContain("正在取得 木棒(第 1/1 步:做木棒×4)");

    inventory = { stick: 4 };
    m.emit("craft_finished", { item: "stick", crafted: 4, requested: 4 });
    await waitFor(() => ends(tasks).length === 1);
    expect(tasks.map((e) => e.type)).toEqual(["started", "progress", "progress", "done"]);
    expect(tasks.find((e) => e.type === "progress")).toMatchObject({ detail: "開始取得木棒:做木棒×4(共 1 步)" });
    expect(tasks.at(-1)).toMatchObject({ type: "done", detail: "拿到木棒了" });
    // The steps are not commentary events any more.
    expect(events.map((e) => e.type)).toEqual(["connected"]);
    expect(adapter.plan).toBeNull();
  });

  it("picks the strategy: done at once, AltoClef for what the planner does not know, else one craft", async () => {
    const { mod: m, adapter } = await setup();
    m.respond = (req) => (req.type === "observe" ? { ok: true, data: SNAPSHOT } : { ok: true, data: {} });
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("o1", "obtain", { item: "iron_pickaxe" }));
    await waitFor(() => ends(tasks).length === 1);
    expect(tasks.find((e) => e.type === "done")).toMatchObject({ task: "o1", detail: "背包裡已經有鐵鎬了" });
    // Unknown to the planner, AltoClef installed: `get`.
    await adapter.tasks.start(spec("o2", "obtain", { item: "golden_apple" }));
    await waitFor(() => m.requests.some((r) => r.type === "altoclef"));
    expect(m.requests.find((r) => r.type === "altoclef")).toMatchObject({ command: "get golden_apple 1" });
    await adapter.tasks.cancel("o2");
    // Forced to the planner: it says it does not know the item.
    await adapter.tasks.start(spec("o3", "obtain", { item: "golden_apple", strategy: "plan" }));
    await waitFor(() => ends(tasks).length === 3);
    expect(ends(tasks).at(-1)).toEqual(["o3", "invalid"]);
    // `craft`: one craft of the item itself (the old craft action).
    await adapter.tasks.start(spec("o4", "obtain", { item: "golden_apple", strategy: "craft" }));
    await waitFor(() => m.requests.some((r) => r.type === "craft"));
    expect(m.requests.find((r) => r.type === "craft")).toMatchObject({ item: "golden_apple", count: 1, task: "o4" });
    m.emit("craft_failed", { item: "golden_apple", crafted: 0, requested: 1, error: "ran out of gold_ingot" });
    await waitFor(() => ends(tasks).length === 4);
    expect(ends(tasks).at(-1)).toEqual(["o4", "precondition"]);
    expect(adapter.plan).toBeNull();
  });

  it("another body task replaces the plan", async () => {
    const { mod: m, adapter } = await setup();
    m.respond = (req) =>
      req.type === "observe" ? { ok: true, data: { ...SNAPSHOT, inventory: {}, nearby_blocks: [] } } : { ok: true, data: {} };
    const tasks = taskEvents(adapter);
    await adapter.tasks.start(spec("o1", "obtain", { item: "crafting_table" }, 60));
    await waitFor(() => adapter.plan !== null);
    const runner = adapter.plan;
    await adapter.tasks.start(spec("s1", "stop"));
    await waitFor(() => ends(tasks).length === 2);
    expect(ends(tasks)).toEqual([
      ["o1", "superseded"],
      ["s1", "done"],
    ]);
    expect(adapter.plan).toBeNull();
    expect(runner?.cancelled).toBe(true);
  });
});

describe("reflexes", () => {
  it("maps reflex events: urgent ones are important, routine ones stay quiet", () => {
    expect(mapEvent({ name: "reflex", data: { kind: "fight", target: "zombie", interrupted: "Mine" } })).toMatchObject({
      type: "reflex",
      important: true,
      data: { text: "被攻擊,自己反擊(殭屍),打斷了挖礦" },
    });
    expect(mapEvent({ name: "reflex", data: { kind: "eat", food: "bread", interrupted: null } })).toMatchObject({
      important: false,
      data: { text: "肚子餓,自己吃東西(麵包)" },
    });
    expect(mapEvent({ name: "reflex", data: { kind: "pickup" } })).toBeNull();
    expect(mapEvent({ name: "reflex_end", data: { kind: "eat", ok: true } })).toBeNull();
    expect(mapEvent({ name: "reflex_end", data: { kind: "lava", ok: true, interrupted: "Mine" } })).toMatchObject({
      data: { text: "逃出岩漿了,可以繼續了" },
    });
    expect(mapEvent({ name: "baritone_idle", data: { cancelled: true, reason: "reflex" } })?.data).toMatchObject({
      text: "被身體的本能反應打斷,停下來",
    });
  });

  it("an action refused during a reflex waits for it to end and goes through", async () => {
    const { mod: m, adapter } = await setup();
    let refused = 0;
    m.respond = (req) => {
      if (req.type === "baritone" && refused === 0) {
        refused++;
        setTimeout(() => m.emit("reflex_end", { kind: "lava", ok: true, interrupted: null }), 10);
        return { ok: false, code: "reflex_active", message: "busy with a reflex: lava" };
      }
      return { ok: true, data: {} };
    };
    const result = await adapter.act({ name: "explore" });
    expect(result.ok).toBe(true);
    expect(m.requests.filter((r) => r.type === "baritone")).toHaveLength(2);
  });
});
