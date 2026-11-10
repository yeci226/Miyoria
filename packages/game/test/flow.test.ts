// "去玩 Minecraft" end to end with a fake task executor: the start checks that the game runs
// (starting it with the `launch` task and waiting for that task's end), starts the session
// (published for the stage's scene director), sets the first goal, goes live through the gate
// when asked, and the director acts as `director`. In-game chat lines are sanitized on the way
// to the adapter.

import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  defineCapability,
  type GateDecision,
} from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  type Event,
  type JsonObject,
  type JsonValue,
  type Principal,
  Principals,
  v2Payload,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GameChatKey,
  GameControlKey,
  GameHandleKey,
  GameModule,
  GOAL_TOPIC,
  SESSION_TOPIC,
  safeActCall,
} from "../src/index.js";
import { FakeExecutor, FakeExecutors, MINECRAFT_GOALS } from "./fake-executor.js";

const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "voice1", kind: "voice" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

const READY: JsonObject = { connected: true, in_game: true };
const MENU: JsonObject = { connected: true, in_game: false };
const DOWN: JsonObject = { connected: false };

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

class Flow {
  readonly sup = new Supervisor();
  readonly tools = new ToolRegistry();
  readonly registry: ActuatorRegistry;
  readonly gate: GateDecision[] = [];
  readonly events: Event[] = [];
  readonly streams: { principal: Principal; args: JsonValue }[] = [];
  readonly exec: FakeExecutor;

  private constructor() {
    this.registry = new ActuatorRegistry({
      services: this.sup.services,
      tools: this.tools,
      builtins: false,
      publish: (e) => {
        if (e.type === "custom" && e.data.topic === "gate.decision") {
          this.gate.push(e.data.payload as unknown as GateDecision);
        }
      },
    });
    this.exec = new FakeExecutor(
      (e) => this.sup.bus.publish("ext.miyoria.minecraft", e),
      Date.now,
      {
        goals: [
          ...MINECRAFT_GOALS,
          { name: "launch", description: "開遊戲", parameters: null, budget_s: null },
          { name: "quit", description: "關遊戲", parameters: null, budget_s: 10 },
        ],
      },
    );
    this.exec.state = READY;
    // Go Live, faked: the real one is the voice module's.
    this.registry.register(
      defineCapability({
        name: "stream.start",
        summary: "開始 Go Live 直播",
        risk: "medium",
        args: z.object({ guild: z.string().nullish() }),
        permission: "voice.golive",
        scope: (args: { guild?: string | null }) => args.guild ?? null,
        execute: async (args, ctx) => {
          this.streams.push({ principal: ctx.principal, args: args as JsonValue });
          return "Go Live started";
        },
      }),
    );
    const sub = this.sup.bus.subscribe("*");
    void (async () => {
      for await (const env of sub) this.events.push(env.event);
    })();
  }

  static async create(): Promise<Flow> {
    const f = new Flow();
    const llm = new MockProvider("mock");
    for (let i = 0; i < 10; i++) {
      llm.reply(
        JSON.stringify({
          goal: "挖鐵礦",
          goal_status: "working",
          action: { name: "mine", args: { block: "iron_ore" } },
          commentary: null,
        }),
      );
    }
    const router = new LlmRouter(
      new Map([[llm.name, llm]]),
      new Map([["game", [parseModelRef("mock:m")]]]),
    );
    const services = f.sup.services;
    services.provide("app", ActuatorRegistryKey, f.registry);
    services.provide("app", ToolRegistryKey, f.tools);
    new FakeExecutors(f.exec).provide(services);
    services.provide("app", LlmRouterKey, router);
    await f.sup.register(new GameModule("DeepSeek醬", "傲嬌"), null, true);
    await f.sup.startAll();
    return f;
  }

  async publish(event: Event): Promise<void> {
    this.sup.bus.publish("test", event);
    await settle();
  }

  /** Her `game_start` tool, as she decided on her own in `context`. */
  async startTool(args: JsonValue, context: ContextKey = TEXT): Promise<string> {
    const tool = this.tools.get("game_start");
    if (!tool) throw new Error("no game_start tool");
    const principal = Principals.self(context, OWEN);
    const out = await tool.call(
      {
        turn: "01JC0000000000000000000000",
        context,
        account: OWEN,
        principal,
        message: { context, id: "m" },
        priority: "direct",
        signal: new AbortController().signal,
      },
      { ...(args as object), on_own: true },
    );
    await settle();
    return out;
  }

  /** Goals started on the executor, in order. */
  get acts(): { goal: string; args: JsonObject }[] {
    return this.exec.starts.map((t) => ({ goal: t.goal, args: t.args }));
  }

  /** Who ran `game.act` through the gate, in order. */
  actors(): string[] {
    return this.gate.filter((d) => d.capability === "game.act").map((d) => d.principal.kind);
  }

  sessions(): JsonValue[] {
    return this.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === SESSION_TOPIC ? [e.data.payload] : [],
    );
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 2, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("去玩 Minecraft", () => {
  it("refuses when the game is not running, so she can tell the owner", async () => {
    const f = await Flow.create();
    f.exec.state = DOWN;
    await expect(f.startTool({})).rejects.toThrow(/還沒開.*請擁有者先在直播機開遊戲/);
    expect(f.sup.services.require(GameControlKey)).toBeDefined();
    expect(f.sessions()).toEqual([]);
    expect(f.acts).toEqual([]);
    await f.stop();
  });

  it("starts from the main menu with a note", async () => {
    const f = await Flow.create();
    f.exec.state = MENU;
    const text = await f.startTool({});
    expect(text).toContain("她開始玩 Minecraft 了");
    expect(text).toContain("還在主選單");
    expect(text).toContain("現在沒有在直播");
    await f.stop();
  });

  it("starts, sets the goal, goes live through the gate and plays as the director", async () => {
    const f = await Flow.create();
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    const text = await f.startTool({ goal: "去挖鐵礦", stream: true });
    expect(text).toContain("她開始玩 Minecraft 了，實況會在語音頻道進行。");
    expect(text).toContain("已設定新目標：去挖鐵礦");
    expect(text).toContain("也開台了");

    // The session is published (the stage's scene director switches to the game scene).
    expect(f.sessions()).toEqual([
      { state: "started", game: "minecraft", game_name: "Minecraft", context: VOICE },
    ]);
    // Go Live ran for the same principal, in the guild of her voice channel.
    expect(f.streams).toHaveLength(1);
    expect(f.streams[0]?.principal.kind).toBe("self");
    expect(f.streams[0]?.args).toEqual({ guild: "g1" });

    // The director's first action goes through the gate as `director`.
    await vi.advanceTimersByTimeAsync(100);
    expect(f.acts.length).toBeGreaterThan(0);
    expect(f.actors()[0]).toBe("director");
    const kinds = f.gate.map((d) => [d.capability, d.principal.kind, d.allowed]);
    expect(kinds).toContainEqual(["game.start", "self", true]);
    expect(kinds).toContainEqual(["stream.start", "self", true]);
    expect(kinds).toContainEqual(["game.act", "director", true]);

    // Stopping publishes the end of the session.
    expect(await f.sup.services.require(GameControlKey).stop()).toContain("已停止");
    await settle();
    expect(f.sessions().at(-1)).toMatchObject({ state: "stopped", game: "minecraft" });
    await f.stop();
  });

  it("a steered event is not the end of the goal's task", async () => {
    const f = await Flow.create();
    await f.startTool({ goal: "去挖鐵礦" });
    await vi.advanceTimersByTimeAsync(100);
    const task = f.exec.last();
    expect(f.sup.services.require(GameHandleKey).status()?.last_action).toContain("開始了");
    expect(f.exec.running.has(task.id)).toBe(true);
    const ends = () =>
      f.events.filter((e) => e.type === "custom" && e.data.topic === GOAL_TOPIC).length;
    const before = ends();
    f.exec.emit({
      type: "steered",
      task: task.id,
      steer: "01S1",
      outcome: "applied",
      detail: "目標改成石鎬",
      at: new Date().toISOString(),
    });
    await settle();
    f.exec.emit({
      type: "steered",
      task: task.id,
      steer: "01S2",
      outcome: "too_late",
      detail: "來不及",
      at: new Date().toISOString(),
    });
    await settle();
    // The task still runs, nothing was cancelled and the goal did not end or fail.
    expect(f.exec.running.has(task.id)).toBe(true);
    expect(f.exec.cancels).toEqual([]);
    expect(ends()).toBe(before);
    const status = f.sup.services.require(GameHandleKey).status();
    expect(status?.goal?.text).toBe("去挖鐵礦");
    expect(status?.last_action).not.toContain("失敗");
    expect(status?.last_action).not.toContain("undefined");
    await f.stop();
  });

  it("does not go live when the gate refuses it", async () => {
    const f = await Flow.create();
    f.registry.configure({ ...f.registry.config, forbidden: ["stream.*"] });
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    const text = await f.startTool({ stream: true });
    expect(text).toContain("她開始玩 Minecraft 了");
    expect(text).toContain("沒有開台");
    expect(f.streams).toEqual([]);
    await f.stop();
  });

  it("leaves player chat to the game chat conversation", async () => {
    const f = await Flow.create();
    let handled = true;
    f.sup.services.provide("chat", GameChatKey, { handles: () => handled });
    // In voice, where her commentary goes.
    await f.publish({ type: "voice_joined", data: { context: VOICE, participants: [] } });
    await f.startTool({});
    await vi.advanceTimersByTimeAsync(100);
    const hints = () =>
      f.events.flatMap((e) => {
        const hint = v2Payload(e, ARBITER_IMPULSE_TOPIC)?.hint;
        return hint ? [hint] : [];
      });
    const before = hints().length;
    const chat = (message: string, system = false) =>
      f.publish({
        type: "custom",
        data: {
          topic: "game.minecraft.chat",
          payload: {
            type: "chat",
            data: { sender: "Steve", message, system, text: `Steve 在遊戲裡說:${message}` },
            important: true,
          },
        },
      });
    await chat("妳好");
    expect(hints().length, "no commentary on player chat").toBe(before);
    // Without `game.chat` the director reacts to it as before.
    handled = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await chat("哈囉");
    expect(hints().at(-1)).toContain("Steve 在遊戲裡說:哈囉");
    await f.stop();
  });

  it("chat lines reach the adapter as one short line without a command prefix", async () => {
    expect(safeActCall({ action: "chat", args: { message: "/kill @a\n第二行" } })).toEqual({
      action: "chat",
      args: { message: "kill @a 第二行" },
    });
    expect(() => safeActCall({ action: "chat", args: { message: "///" } })).toThrow(/nothing/);
    // Other actions pass unchanged.
    const mine = { action: "mine", args: { block: "iron_ore" } };
    expect(safeActCall(mine)).toBe(mine);

    const f = await Flow.create();
    const out = await f.registry.invoke({
      principal: Principals.director(TEXT),
      capability: "game.act",
      args: { game: "minecraft", call: { action: "chat", args: { message: "#goto 0 0 §c好" } } },
      why: null,
      turn: null,
    });
    expect(out.status).toBe("done");
    expect(f.acts.at(-1)).toEqual({ goal: "chat", args: { message: "goto 0 0 好" } });
    await f.stop();
  });
});

const LAUNCHABLE: JsonObject = { connected: false, launch: { available: true, state: "idle" } };
const actions = (f: Flow) => f.acts.map((a) => a.goal);

describe("她自己開遊戲", () => {
  it("runs the launch task through the gate, waits for its end, then plays", async () => {
    const f = await Flow.create();
    f.exec.state = LAUNCHABLE;
    const started = f.startTool({});
    await vi.advanceTimersByTimeAsync(4_000);
    // The launch is a task with the launch budget; nothing is polled meanwhile.
    expect(f.exec.starts[0]).toMatchObject({ goal: "launch", budget_s: 240 });
    const polls = f.exec.observeCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.exec.observeCalls).toBe(polls);
    expect(f.sessions()).toEqual([]);
    // The adapter says it is up (connected, the world loaded).
    f.exec.state = READY;
    f.exec.done("連上了");
    await settle();
    const text = await started;
    expect(text).toContain("她開始玩 Minecraft 了");
    expect(text).not.toContain("主選單");
    expect(actions(f)[0]).toBe("launch");
    expect(f.actors()[0]).toBe("director");

    // Stopping also asks the adapter to close the game (it decides whether it does).
    await f.sup.services.require(GameControlKey).stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(actions(f).slice(-2)).toEqual(["stop", "quit"]);
    await f.stop();
  });

  it("a launch that fails is a failed start with the reason and its code", async () => {
    const f = await Flow.create();
    f.exec.state = LAUNCHABLE;
    const control = f.sup.services.require(GameControlKey);
    const started = control.start("minecraft", TEXT, OWEN, "here");
    const outcome = expect(started).rejects.toMatchObject({
      code: "crashed",
      message: expect.stringMatching(/Minecraft 開不起來.*代碼 1/),
    });
    await settle();
    f.exec.fail("crashed", "Prism Launcher 結束了(代碼 1),遊戲沒有開起來");
    await settle();
    await outcome;
    expect(f.sessions()).toEqual([]);
    await f.stop();
  });

  it("a launch that runs out of its budget says so", async () => {
    const f = await Flow.create();
    f.exec.state = LAUNCHABLE;
    const started = f.startTool({});
    const outcome = expect(started).rejects.toThrow(/等了 240 秒.*還是沒有連上/);
    await settle();
    f.exec.fail("timeout", "took longer than 240 s");
    await settle();
    await outcome;
    await f.stop();
  });

  it("a refused launch fails the start with what the adapter said", async () => {
    const f = await Flow.create();
    f.exec.state = LAUNCHABLE;
    f.exec.refuse = (spec) =>
      spec.goal === "launch"
        ? Object.assign(new Error("沒辦法開遊戲:找不到 Prism Launcher"), { code: "precondition" })
        : null;
    await expect(f.startTool({})).rejects.toThrow(/開不起來.*找不到 Prism Launcher/);
    await f.stop();
  });

  it("cancelling the start cancels the launch task, which has the caller's task id", async () => {
    const f = await Flow.create();
    f.exec.state = LAUNCHABLE;
    const controller = new AbortController();
    const control = f.sup.services.require(GameControlKey);
    const task = "01JMANAGERTASK000000000000";
    const started = control.start("minecraft", TEXT, OWEN, "here", controller.signal, task);
    const outcome = expect(started).rejects.toMatchObject({ code: "cancelled" });
    await settle();
    expect(f.exec.starts[0]).toMatchObject({ id: task, goal: "launch" });
    controller.abort(new Error("game.stop"));
    await settle();
    await outcome;
    expect(f.exec.cancels).toEqual([task]);
    expect(f.sessions()).toEqual([]);
    await f.stop();
  });

  it("says why it cannot start the game itself", async () => {
    const f = await Flow.create();
    f.exec.state = {
      connected: false,
      launch: { available: false, problem: "找不到 Prism Launcher(prismlauncher)" },
    };
    await expect(f.startTool({})).rejects.toThrow(/還沒開.*沒辦法自己開：找不到 Prism Launcher/);
    expect(f.acts).toEqual([]);
    await f.stop();
  });
});
