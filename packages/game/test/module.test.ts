import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import {
  type ArgValue,
  CommandRegistry,
  CommandRegistryKey,
  Invocation,
  Permissions,
} from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  LlmRouterKey,
  MockProvider,
  parseModelRef,
} from "@miyoria/llm";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import {
  type AccountRef,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  type Event,
  GameResumeKey,
  type Impulse,
  impulseReason,
  type JsonValue,
  type NewProposal,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  ProposalBoardKey,
  type RestoredGame,
  v2Payload,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF_GOAL_BY } from "../src/decision.js";
import {
  DECISION_TOPIC,
  GameControl,
  GameControlKey,
  GameError,
  GameHandle,
  GameHandleKey,
  GameModule,
  type GameStatus,
  GOAL_TOPIC,
  SESSION_TOPIC,
} from "../src/index.js";
import { FakeExecutor, FakeExecutors } from "./fake-executor.js";

// ----- fakes -----

/** Replies computed from the request's user message. */
class FnProvider implements ChatProvider {
  readonly name = "fn";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly reply: (user: string) => string) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = this.reply(contentText(request.messages.at(-1)?.content ?? ""));
    return (async function* () {
      yield { type: "text_delta" as const, text };
      yield { type: "done" as const, finish_reason: "stop", usage: null };
    })();
  }
}

function decision(goal: string, action: JsonValue, commentary: string | null = null): string {
  return JSON.stringify({ goal, goal_status: "working", action, commentary });
}

function textCtx(): ContextKey {
  return { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };
}

function voiceCtx(): ContextKey {
  return { platform: "discord", scope: "g1", channel: "voice1", kind: "voice" };
}

function owner(): AccountRef {
  return { platform: "discord", id: "1" };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

async function secs(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * 1000);
  await settle();
}

type Log<T> = { items: T[]; take(): T[] };

function collect<T>(sub: AsyncIterable<unknown>, pick: (event: Event) => T | null): Log<T> {
  const items: T[] = [];
  void (async () => {
    for await (const env of sub as AsyncIterable<{ event: Event }>) {
      const v = pick(env.event);
      if (v !== null) items.push(v);
    }
  })();
  return { items, take: () => items.splice(0, items.length) };
}

class Harness {
  readonly sup = new Supervisor();
  readonly exec: FakeExecutor;
  readonly executors: FakeExecutors;
  readonly commands = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  readonly prompts = new PromptContributors();
  readonly queue: RequestQueue;
  readonly hintLog: Log<string>;
  readonly lineLog: Log<Impulse>;
  readonly hintContexts: Log<ContextKey>;
  readonly nudgeLog: Log<Record<string, JsonValue>>;
  readonly traceLog: Log<Record<string, JsonValue>>;
  readonly goalLog: Log<Record<string, JsonValue>>;

  private constructor() {
    this.exec = new FakeExecutor((event) => this.sup.bus.publish("ext.miyoria.minecraft", event));
    this.executors = new FakeExecutors(this.exec);
    this.queue = new RequestQueue(undefined, {
      publisher: (event) => this.sup.bus.publish("queue", event),
    });
    // Her commentary: impulses of source `game` for the Arbiter.
    this.hintLog = collect(this.sup.bus.subscribe(ARBITER_IMPULSE_TOPIC), (e) => {
      const impulse = v2Payload(e, ARBITER_IMPULSE_TOPIC);
      if (!impulse) return null;
      expect(impulse.source).toBe("game");
      expect(impulseReason(impulse)).toBe("game");
      return impulse.hint;
    });
    this.lineLog = collect(this.sup.bus.subscribe(ARBITER_IMPULSE_TOPIC), (e) =>
      v2Payload(e, ARBITER_IMPULSE_TOPIC),
    );
    this.hintContexts = collect(
      this.sup.bus.subscribe(ARBITER_IMPULSE_TOPIC),
      (e) => v2Payload(e, ARBITER_IMPULSE_TOPIC)?.target.context ?? null,
    );
    this.nudgeLog = collect(this.sup.bus.subscribe("mood.nudge"), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
    this.traceLog = collect(this.sup.bus.subscribe(DECISION_TOPIC), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
    this.goalLog = collect(this.sup.bus.subscribe(GOAL_TOPIC), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
  }

  static async create(
    provider: ChatProvider,
    config: JsonValue | null = null,
    actuators: ((h: Harness) => ActuatorRegistry) | null = null,
  ): Promise<Harness> {
    const h = new Harness();
    const router = new LlmRouter(
      new Map([[provider.name, provider]]),
      new Map([["game", [parseModelRef(`${provider.name}:m`)]]]),
    );
    const services = h.sup.services;
    if (actuators) services.provide("app", ActuatorRegistryKey, actuators(h));
    h.executors.provide(services);
    services.provide("app", CommandRegistryKey, h.commands);
    services.provide("app", RequestQueueKey, h.queue);
    services.provide("app", PromptContributorsKey, h.prompts);
    services.provide("app", LlmRouterKey, router);
    await h.sup.register(new GameModule("DeepSeek醬", "傲嬌的鯨魚女孩,嘴硬心軟。"), config, true);
    await h.sup.startAll();
    return h;
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }

  async command(
    path: string,
    args: Record<string, ArgValue> = {},
    context: ContextKey = textCtx(),
  ): Promise<string> {
    const inv = Invocation.create(path, owner(), context);
    inv.invoker_display_name = "Owen";
    for (const [k, v] of Object.entries(args)) inv.withArg(k, v);
    const reply = await this.commands.dispatch(inv);
    await settle();
    return reply.text;
  }

  start(): Promise<string> {
    return this.command("game start", { where: "here" });
  }

  async publish(event: Event): Promise<void> {
    this.sup.bus.publish("test", event);
    await settle();
  }

  async gameEvent(
    kind: string,
    text: string,
    important: boolean,
    extra: Record<string, JsonValue> = {},
  ): Promise<void> {
    await this.publish({
      type: "custom",
      data: {
        topic: `game.minecraft.${kind}`,
        payload: { type: kind, data: { text, ...extra }, important },
      },
    });
  }

  acts(): Array<Record<string, JsonValue>> {
    return this.exec.acts();
  }

  actNames(): JsonValue[] {
    return this.exec.names();
  }

  /** Ends the last started task with `done` (and lets the director see it). */
  async taskDone(detail = "好了"): Promise<void> {
    this.exec.done(detail);
    await settle();
  }

  async taskFailed(code: Parameters<FakeExecutor["fail"]>[0], detail: string): Promise<void> {
    this.exec.fail(code, detail);
    await settle();
  }

  status(): GameStatus | null {
    return this.sup.services.require(GameHandleKey).status();
  }

  hints(): string[] {
    return this.hintLog.take();
  }

  nudges(): Array<Record<string, JsonValue>> {
    return this.nudgeLog.take();
  }

  submit(text: string, who: string, kind = "game_goal"): number {
    return this.queue.submit({
      requester: { platform: "discord", id: who },
      requesterName: who,
      kind,
      text,
    }).item.id;
  }
}

function promptRequest(): PromptRequest {
  return {
    profile: "p",
    turn: "t",
    context: textCtx(),
    participants: [],
    speakers: [],
    query: "你在幹嘛",
    recent: [],
    voice: false,
    now: new Date().toISOString(),
  } as unknown as PromptRequest;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2025, 2, 10, 4, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- tests -----

describe("picking a session back up after a restart", () => {
  const left = (context: ContextKey | null = voiceCtx()): RestoredGame => ({
    game: "minecraft",
    name: "Minecraft",
    context,
    since: "2026-11-07T10:00:00.000Z",
  });

  async function rig() {
    const h = await Harness.create(new MockProvider("mock").reply(decision("閒晃", null)));
    return { h, resume: h.sup.services.require(GameResumeKey) };
  }

  it("resumes when the game is there, and says so on the bus", async () => {
    const { h, resume } = await rig();
    const sessions = h.sup.bus.subscribe(SESSION_TOPIC);
    expect(await resume.resume(left())).toBe("resumed");
    expect(h.status()).toMatchObject({ game: "minecraft", game_name: "Minecraft" });
    expect(h.status()?.context).toEqual(voiceCtx());
    expect(sessions.tryRecv()?.event).toMatchObject({
      data: { payload: { state: "started", game: "minecraft" } },
    });
    await h.stop();
  });

  it("never launches a game that is closed", async () => {
    const { h, resume } = await rig();
    h.exec.state = { connected: false, launch: { available: true } };
    expect(await resume.resume(left())).toBe("waiting");
    expect(h.status()).toBeNull();
    expect(h.actNames()).toEqual([]);
    await h.stop();
  });

  it("waits for an adapter that is not there yet", async () => {
    const { h, resume } = await rig();
    expect(await resume.resume({ ...left(), game: "terraria" })).toBe("waiting");
    await h.stop();
  });

  it("does not guess where a session without a place goes", async () => {
    const { h, resume } = await rig();
    expect(await resume.resume(left(null))).toBe("waiting");
    await h.stop();
  });

  it("leaves a session that already runs alone", async () => {
    const { h, resume } = await rig();
    await h.start();
    const context = h.status()?.context;
    expect(await resume.resume(left())).toBe("resumed");
    expect(h.status()?.context).toEqual(context);
    await h.stop();
  });

  it("can be stopped like any session", async () => {
    const { h, resume } = await rig();
    await resume.resume(left());
    expect(await h.command("game stop")).toContain("她已停止玩");
    await h.stop();
  });
});

describe("game director", () => {
  it("decide_loop_keeps_the_goal_while_the_bot_works", async () => {
    const llm = new MockProvider("mock")
      .reply(decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }))
      .reply(decision("砍樹", { name: "mine", args: { block: "oak_log" } }));
    const h = await Harness.create(llm);
    const reply = await h.start();
    expect(reply).toContain("開始玩 Minecraft");

    // First decision right away: the goal action runs.
    expect(h.acts()).toEqual([{ action: "mine", args: { block: "iron_ore" } }]);
    const req = llm.requests()[0] as ChatRequest;
    expect(req.json_mode).toBe(true);
    const session = req.session ?? "";
    expect(session.startsWith("miyoria-") && session.endsWith("-game-minecraft")).toBe(true);
    expect(req.messages[0]?.content).toContain("傲嬌的鯨魚女孩");
    expect(req.messages[0]?.content).toContain("- mine:挖");
    expect(req.messages[1]?.content).toContain("剛開始玩");
    expect(h.status()?.goal?.text).toBe("挖鐵礦");

    // The goal's task runs: switching to another goal is refused until the goal is old enough.
    const first = h.exec.last();
    expect(first.budget_s).toBe(300); // the executor's suggestion for `mine`
    await secs(20);
    expect(llm.requests()).toHaveLength(2);
    expect(llm.requests()[1]?.messages[1]?.content).toContain("目前目標:挖鐵礦");
    await secs(20);
    expect(llm.requests()).toHaveLength(3);
    expect(h.acts()).toHaveLength(1);
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await secs(20);
    expect(llm.requests()).toHaveLength(4);
    expect(h.acts()).toHaveLength(2);
    expect((h.acts()[1]?.args as { block: string } | undefined)?.block).toBe("oak_log");
    expect(h.status()?.goal?.text).toBe("砍樹");
    // The replaced goal's task is cancelled; each task has its own id.
    expect(h.exec.cancels).toContain(first.id);
    expect(h.exec.last().id).not.toBe(first.id);

    // Same action again while its task runs: not re-issued; once it ended it is.
    await secs(20);
    expect(h.acts()).toHaveLength(2);
    await h.taskDone("挖到了");
    expect(h.goalLog.take()).toEqual([
      expect.objectContaining({
        goal: "砍樹",
        status: "done",
        code: "done",
        task: h.exec.last().id,
      }),
    ]);
    await secs(20);
    expect(h.acts()).toHaveLength(3);
    await h.stop();
  });

  it("director_actions_and_commands_go_through_the_gate", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const gate: Record<string, JsonValue>[] = [];
    let registry: ActuatorRegistry | null = null;
    const h = await Harness.create(llm, null, (harness) => {
      registry = new ActuatorRegistry({
        services: harness.sup.services,
        builtins: false,
        publish: (e) => {
          if (e.type === "custom" && e.data.topic === "gate.decision") {
            gate.push(e.data.payload as Record<string, JsonValue>);
          }
        },
      });
      return registry;
    });
    await h.start();
    expect(h.acts()).toHaveLength(1);
    const who = (d: Record<string, JsonValue>) => [
      d.capability,
      (d.principal as Record<string, JsonValue>).kind,
      d.allowed,
    ];
    expect(gate.map(who)).toEqual([
      ["game.start", "command", true],
      ["game.act", "director", true],
    ]);

    // Paused: the director may not act any more; commands still go through.
    await (registry as unknown as ActuatorRegistry).setPaused(true);
    expect(await h.command("game goal", { text: "砍樹" })).toContain("已設定新目標");
    await secs(20);
    expect(h.acts(), "no act while paused").toHaveLength(1);
    const paused = gate.filter((d) => d.capability === "game.act").at(-1);
    expect(paused).toMatchObject({ allowed: false, stage: "pause" });
    expect(gate.some((d) => d.capability === "game.goal" && d.allowed === true)).toBe(true);
    await h.stop();
  });

  it("publishes the decision trace", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }, "開工囉"),
    );
    const h = await Harness.create(llm);
    await h.start();
    const trace = h.traceLog.take();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual({
      game: "minecraft",
      trigger: ["剛開始玩"],
      goal: "挖鐵礦",
      action: 'mine {"block":"iron_ore"}',
      verdict: "Replace",
      commentary: "開工囉",
      busy: false,
      // What she saw is in the record with the thought (§11.2 item 9).
      observation: "血量 20/20\n位置 (0, 64, 0)",
      want: null,
      held: [],
    });
    await h.stop();
  });

  it("queue_goals_are_consumed_and_finished", async () => {
    const llm = new FnProvider((user) => {
      if (user.includes("這一步做完了")) {
        return JSON.stringify({ goal: "挖鑽石", goal_status: "done", action: null });
      }
      if (user.includes("目前目標:沒有")) return decision("閒晃", null);
      if (user.includes("蓋房子") && user.includes("目前目標:蓋房子")) {
        return decision("蓋房子", { name: "goto", args: { x: 1, z: 2 } });
      }
      return decision("挖鑽石", { name: "goto", args: { block: "diamond_ore" } });
    });
    const h = await Harness.create(llm, { max_attempts: 1 });
    await h.start();
    h.hints();
    expect(h.acts()).toEqual([]);

    const first = h.submit("挖鑽石", "Amy");
    const second = h.submit("蓋房子", "Bob");
    const song = h.submit("唱歌", "Owen", "song");
    expect(h.queue.next()?.id).toBe(first);
    await settle();
    expect(h.queue.next()?.id).toBe(second);
    await settle();
    expect(h.queue.next()?.id).toBe(song);
    await settle();

    // The viewer goal is announced at once and becomes the current goal; the second one waits.
    const hints = h.hints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("觀眾 Amy 想要你:挖鑽石");
    const status = h.status();
    expect([status?.goal?.text, status?.goal?.queue_item]).toEqual(["挖鑽石", first]);
    expect(status?.backlog).toEqual([`#${second} 蓋房子(Bob)`]);

    // An early decision (min_decide_secs after the first) acts on it.
    await secs(4);
    expect(h.actNames()).toEqual(["goto"]);
    expect(llm.requests.at(-1)?.messages[1]?.content).toContain("觀眾 Amy 的請求");

    // Event names mean nothing any more; a stale task's end neither.
    await h.gameEvent("goal_reached", "抵達目標了", false);
    h.exec.stray("01OLDTASK0000000000000000");
    await settle();
    expect(h.queue.get(first)?.state).toBe("active");
    // Her step is done: a requested goal is done when she says so.
    await h.taskDone("走到鑽石旁邊了");
    expect(h.queue.get(first)?.state).toBe("active");
    await secs(4);
    expect(h.queue.get(first)?.state).toBe("done");
    expect(h.hints().some((x) => x.includes("完成了觀眾 Amy 的請求"))).toBe(true);

    // The next viewer goal took over; failing it skips the queue item.
    expect(h.status()?.goal?.queue_item).toBe(second);
    await secs(4);
    expect(h.acts()).toHaveLength(2);
    expect(h.acts()[1]?.args).toEqual({ x: 1, z: 2 });
    await h.taskFailed("unreachable", "找不到路");
    expect(h.queue.get(second)?.state).toBe("skipped");
    expect(h.status()?.goal).toBeNull();
    // Other kinds are left alone.
    expect(h.queue.get(song)?.state).toBe("active");
    // Every goal that ended carries a code.
    expect(h.goalLog.take()).toEqual([
      expect.objectContaining({
        goal: "挖鑽石",
        source: "queue",
        status: "done",
        code: "reported",
      }),
      expect.objectContaining({
        goal: "蓋房子",
        source: "queue",
        status: "failed",
        code: "unreachable",
        detail: "找不到路",
      }),
    ]);
    await h.stop();
  });

  it("auto_commentary_is_spoken_in_voice_and_quiet_elsewhere", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "看看四周"));
    const h = await Harness.create(llm, { decide_secs: 5 });
    // Started from a text channel while she is not in voice: she plays quietly (no running
    // commentary in a text channel)...
    await h.command("game start");
    await secs(5);
    expect(h.hintContexts.take()).toEqual([]);
    // ...until she joins a voice channel; then she comments there.
    await h.publish({ type: "voice_joined", data: { context: voiceCtx(), participants: [] } });
    await secs(20);
    expect(h.hintContexts.take().at(-1)).toEqual(voiceCtx());
    await h.stop();
  });

  it("under_v3_a_free_line_is_a_proposal_not_an_impulse", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "看看四周"));
    const h = await Harness.create(llm, { decide_secs: 5 });
    const proposed: NewProposal[] = [];
    h.sup.services.provide("app", ProposalBoardKey, {
      propose: async (p) => {
        proposed.push(p);
        return { id: "x", state: "open", detail: "", turn: null };
      },
      open: () => [],
    });
    await h.command("game start");
    await h.publish({ type: "voice_joined", data: { context: voiceCtx(), participants: [] } });
    await secs(20);
    expect(h.hintContexts.take()).toEqual([]);
    expect(proposed.at(-1)).toMatchObject({ source: "game.director", context: voiceCtx() });
    await h.stop();
  });

  it("commentary_is_rate_limited_but_deaths_get_through", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "吐槽一下天氣"));
    const h = await Harness.create(llm, { decide_secs: 5 });
    await h.start();
    for (let i = 0; i < 6; i++) await secs(5);
    // Decisions at 0, 5, ..., 30; commentary at most every 15 s.
    expect(llm.requests()).toHaveLength(7);
    const hints = h.hints();
    expect(hints).toHaveLength(3);
    expect(hints[0]).toContain("實況:吐槽一下天氣");
    expect(hints[0]).toContain("你正在直播玩 Minecraft");

    // A death is never rate-limited: not even right after a line.
    await secs(1);
    await h.gameEvent("death", "死掉了(苦力怕)", true);
    const urgent = h.hints();
    expect(urgent).toHaveLength(1);
    expect(urgent[0]).toBe("(你正在直播玩 Minecraft)剛剛死掉了(苦力怕)!馬上用一兩句話反應。");

    // An important event that is still narration has only the short urgent limit.
    await h.gameEvent("advancement", "達成成就「石器時代」", true, { title: "石器時代" });
    expect(h.hints()).toEqual([]);
    await secs(3);
    await h.gameEvent("advancement", "達成成就「石器時代」", true, { title: "石器時代" });
    expect(h.hints()).toHaveLength(1);
    await h.stop();
  });

  it("death_nudges_mood_and_resets_goals", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    h.nudges();

    // Her own goal is dropped on death...
    await secs(1);
    await h.gameEvent("death", "死掉了(岩漿)", true);
    expect(h.status()?.goal).toBeNull();
    const nudges = h.nudges();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.reason).toBe("game: death");
    expect(Number(nudges[0]?.valence)).toBeLessThan(0);
    // ...and the next (early) decision picks one again.
    await secs(4);
    expect(h.acts()).toHaveLength(2);
    expect(llm.requests().at(-1)?.messages[1]?.content).toContain("死掉了(岩漿)");

    // A commanded goal survives the death and is re-issued.
    const reply = await h.command("game goal", { text: "去挖鐵礦" });
    expect(reply).toContain("已設定新目標");
    await secs(4);
    expect(h.acts()).toHaveLength(3);
    const goal = h.status()?.goal;
    expect(goal?.text).toBe("去挖鐵礦");
    expect(goal?.note).toContain("Owen");
    // While its task runs the same action is not repeated...
    await secs(20);
    expect(h.acts()).toHaveLength(3);
    // ...but after a death the goal starts over, so it is issued again.
    await h.gameEvent("death", "死掉了", true);
    const reset = h.status()?.goal;
    expect([reset?.text, reset?.action]).toEqual(["去挖鐵礦", null]);
    await secs(4);
    expect(h.acts()).toHaveLength(4);
    const again = h.status()?.goal;
    expect(again?.text).toBe("去挖鐵礦");
    expect(again?.action).not.toBeNull();

    // Achievements cheer her up.
    await h.gameEvent("advancement", "達成成就「石器時代」", true);
    expect(h.nudges().some((n) => n.reason === "game: advancement" && Number(n.valence) > 0)).toBe(
      true,
    );
    await h.stop();
  });

  it("stop_ends_the_session", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    expect(await h.command("game stop")).toContain("她目前沒有在玩遊戲");
    expect(await h.command("game status")).toContain("她目前沒有在玩遊戲");
    await h.start();
    expect(await h.start()).toContain("她已經在玩");
    const status = await h.command("game status");
    expect(status).toContain("正在玩：Minecraft");

    // While playing the chat prompt knows about the game.
    const section = await h.prompts.all()[0]?.contribute(promptRequest());
    expect(section?.[0]?.key).toBe("game");
    expect(section?.[0]?.title).toBe("你正在玩的遊戲");
    expect(section?.[0]?.order).toBe(45);
    expect(section?.[0]?.body).toContain("你正在直播玩 Minecraft");
    expect(section?.[0]?.body).toContain("目前沒有特定目標。");
    expect(section?.[0]?.body).toContain("血量 20/20");

    const reply = await h.command("game stop");
    expect(reply).toContain("她已停止玩");
    expect(h.actNames()).toEqual(["stop"]);
    expect(h.status()).toBeNull();
    expect(await h.prompts.all()[0]?.contribute(promptRequest())).toEqual([]);
    const asked = llm.requests().length;
    await secs(60);
    expect(llm.requests()).toHaveLength(asked);

    // Stopping the module removes its commands and prompt.
    await h.stop();
    expect(h.commands.specs()).toEqual([]);
    expect(h.prompts.all()).toEqual([]);
  });

  it("start_checks_the_adapter_and_picks_the_context", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm, {
      stream_context: { platform: "discord", scope: "g2", channel: "stream", kind: "voice" },
    });
    const missing = await h.command("game start", { game: "terraria" });
    expect(missing).toContain("找不到 terraria");

    // Without a voice channel, `auto` falls back to the stream context.
    await h.command("game start");
    expect(h.status()?.context.channel).toBe("stream");
    await h.command("game stop");

    // In a voice channel, `auto` uses it.
    await h.publish({ type: "voice_joined", data: { context: voiceCtx(), participants: [] } });
    await h.command("game start");
    expect(h.status()?.context).toEqual(voiceCtx());
    await h.command("game stop");

    await h.publish({ type: "voice_left", data: { context: voiceCtx(), reason: null } });
    const reply = await h.command("game start", { where: "voice" });
    expect(reply).toContain("不在語音頻道中");
    await h.stop();
  });

  it("no_llm_while_the_game_is_unreachable", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    // Without the start check, a session can run while the game is unreachable.
    const h = await Harness.create(llm, { require_connected: false });
    h.exec.state = { connected: false };
    h.exec.summary = "沒有連上 Minecraft。";
    await h.start();
    await secs(40);
    expect(h.exec.observeCalls).toBe(3);
    expect(llm.requests()).toEqual([]);
    expect(h.status()?.summary).toContain("沒有連上");

    // Losing the adapter's executor (its extension crashed) ends the session: the scene goes
    // back and the ActivityManager shows `failed(crashed)`, instead of a session that plays
    // nothing.
    h.executors.byOwner.clear();
    await secs(20);
    expect(h.status()).toBeNull();
    await h.stop();
  });

  it("failed_actions_count_against_requested_goals", async () => {
    const llm = new MockProvider("mock").reply(
      decision("蓋房子", { name: "get", args: { item: "oak_planks" } }),
    );
    // The method guard is off here: this is about counting attempts.
    const h = await Harness.create(llm, { max_attempts: 2, method_repeat_limit: 0 });
    h.exec.autoEnd = () => ({ type: "failed", code: "precondition", detail: "沒有安裝 AltoClef" });
    await h.start();
    // Her own goal survives one failure: the next decision can try another way.
    expect(h.status()?.goal?.text).toBe("蓋房子");
    expect(h.status()?.last_action).toBe(
      'get {"item":"oak_planks"} → 失敗(precondition):沒有安裝 AltoClef',
    );
    expect(h.goalLog.take()).toEqual([]);
    // The second failure ends it with the task's code.
    await secs(4);
    expect(h.status()?.goal).toBeNull();
    expect(h.goalLog.take()).toEqual([
      expect.objectContaining({ goal: "蓋房子", status: "failed", code: "precondition" }),
    ]);

    await h.command("game goal", { text: "蓋房子" });
    await secs(4);
    expect(h.status()?.goal).not.toBeNull();
    await secs(4);
    expect(h.status()?.goal).toBeNull();
    expect(h.goalLog.take()).toEqual([
      expect.objectContaining({ goal: "蓋房子", source: "command", code: "precondition" }),
    ]);
    // A start the executor refuses counts the same way.
    h.exec.refuse = () => Object.assign(new Error("busy with a reflex"), { code: "busy" });
    await h.command("game goal", { text: "蓋房子" });
    await secs(4);
    expect(h.status()?.last_action).toContain("失敗(busy)");
    await h.stop();
  });

  it("withholds low-level actions after a failure until she changes method", async () => {
    const replies = [
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
      decision("找鐵礦", { name: "explore", args: {} }),
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    ];
    const llm = new FnProvider(() => replies.shift() ?? decision("挖鐵礦", null));
    const h = await Harness.create(llm);
    h.exec.autoEnd = (spec) =>
      spec.goal === "mine" && h.exec.starts.length === 1
        ? { type: "failed", code: "not_found", detail: "附近看不到鐵礦" }
        : { type: "done", detail: "好了" };
    await h.start();
    expect(h.actNames()).toEqual(["mine"]);

    // The same kind of retry right away is not sent; she is told why in the next prompt.
    await secs(5);
    expect(h.actNames()).toEqual(["mine"]);
    const prompt = contentText(llm.requests[1]?.messages.at(-1)?.content ?? "");
    expect(prompt).toContain("暫時不能用 goto、mine、look、attack");
    expect(prompt).toContain("附近看不到鐵礦");
    expect(h.traceLog.items.at(-1)?.verdict).toBe(
      'Keep("withheld after a failure: 附近看不到鐵礦")',
    );
    expect(h.status()?.last_action).toContain("暫時不行");

    // Another method works: the guard is off again.
    await secs(5);
    expect(h.actNames()).toEqual(["mine", "explore"]);
    await secs(60);
    expect(h.actNames()).toContain("mine");
    expect(h.actNames().length).toBeGreaterThan(2);
    await h.stop();
  });

  it("a failed obtain task also starts the guard", async () => {
    const replies = [decision("拿鐵鎬", { name: "obtain", args: { item: "iron_pickaxe" } })];
    const llm = new FnProvider(() => replies.shift() ?? decision("拿鐵鎬", null));
    const h = await Harness.create(llm);
    await h.start();
    expect(h.actNames()).toEqual(["obtain"]);
    expect(h.exec.last().budget_s).toBe(600);
    await secs(4);
    // The old event name alone does nothing; the task's own end does.
    await h.gameEvent("plan_failed", "取得鐵鎬失敗", true);
    expect(h.status()?.goal?.text).toBe("拿鐵鎬");
    await h.taskFailed("not_found", "取得鐵鎬失敗,卡在「挖粗鐵×3」:附近看不到鐵礦");
    // The goal stays (one failed attempt of three) ...
    expect(h.status()?.goal?.text).toBe("拿鐵鎬");
    // ... and the failure triggers the next decision, which is told what is withheld and sees
    // the failure with its code in her record.
    await secs(1);
    expect(llm.requests).toHaveLength(2);
    const prompt = contentText(llm.requests.at(-1)?.messages.at(-1)?.content ?? "");
    expect(prompt).toContain("暫時不能用");
    expect(prompt).toContain('obtain {"item":"iron_pickaxe"} → 失敗(not_found)');
    expect(prompt).toContain("要:iron_pickaxe");
    await h.stop();
  });
});

describe("narration and the lines she has to say", () => {
  const MIN45 = 45 * 60_000;

  it("every way of bringing up the same thing has the same key", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "石鎬做好了,木鎬太慢了"));
    const h = await Harness.create(llm, { decide_secs: 20 });
    await h.start();
    await h.gameEvent("craft_finished", "做好了 石鎬×1", false, { item: "stone_pickaxe" });
    h.lineLog.take();
    for (let i = 0; i < 6; i++) await secs(20);
    const lines = h.lineLog.take();
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      expect(l.attention).toEqual({ key: "game:craft:stone_pickaxe", repeat_after_ms: MIN45 });
    }
    await h.stop();
  });

  it("something new to say has its own key", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "這裡的風景好漂亮喔"));
    const h = await Harness.create(llm, { decide_secs: 20 });
    await h.start();
    await h.gameEvent("craft_finished", "做好了 石鎬×1", false, { item: "stone_pickaxe" });
    h.lineLog.take();
    await secs(20);
    expect(h.lineLog.take().at(-1)?.attention?.key).toMatch(/^game:remark:/);
    await h.stop();
  });

  it("repeat windows and keys are configurable", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm, { narration_repeat_mins: 10, hazard_repeat_secs: 30 });
    await h.start();
    h.lineLog.take();
    await h.gameEvent("advancement", "達成成就「石器時代」", true, { title: "石器時代" });
    expect(h.lineLog.take().at(-1)?.attention).toEqual({
      key: "game:advancement:石器時代",
      repeat_after_ms: 600_000,
    });
    await secs(4);
    await h.gameEvent("damage", "受傷 -5(殭屍),剩 11 血", true, { attacker: "zombie" });
    expect(h.lineLog.take().at(-1)?.attention).toEqual({
      key: "game:damage:zombie",
      repeat_after_ms: 30_000,
    });
    await h.stop();
  });

  it("urgent events are not narration: no key, no rate limit, and they can wait for a turn", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    h.lineLog.take();
    await h.gameEvent("low_health", "血量很低(3)", true);
    await h.gameEvent("death", "死掉了(苦力怕)", true);
    await h.gameEvent("reflex", "掉進岩漿 / 著火了,身體自己逃開", true, { kind: "lava" });
    const lines = h.lineLog.take();
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l.attention ?? null).toBeNull();
      // Merged away by nothing, and it outlives the Arbiter's retry while she is talking.
      expect(l.coalesce_key).toBeNull();
      expect(Date.parse(l.expires_at) - Date.parse(l.created_at)).toBe(30_000);
    }
    await h.stop();
  });

  it("a fight is narration, a short one", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    h.lineLog.take();
    await h.gameEvent("reflex", "被攻擊,自己反擊", true, { kind: "fight" });
    expect(h.lineLog.take().at(-1)?.attention).toEqual({
      key: "game:reflex:fight",
      repeat_after_ms: 120_000,
    });
    await h.stop();
  });

  it("what a viewer asked for is owed to them: announced and reported without a key", async () => {
    const llm = new FnProvider((user) =>
      user.includes("這一步做完了")
        ? JSON.stringify({ goal: "挖鑽石", goal_status: "done", action: null })
        : decision("挖鑽石", { name: "goto", args: { block: "diamond_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    h.lineLog.take();
    h.submit("挖鑽石", "Amy");
    h.queue.next();
    await settle();
    await secs(25);
    await h.taskDone();
    await secs(25);
    const lines = h.lineLog.take().filter((l) => (l.hint ?? "").includes("Amy"));
    expect(lines.map((l) => l.hint)).toEqual([
      expect.stringContaining("觀眾 Amy 想要你:挖鑽石"),
      expect.stringContaining("完成了觀眾 Amy 的請求"),
    ]);
    for (const l of lines) {
      expect(l.attention ?? null).toBeNull();
      expect(Date.parse(l.expires_at) - Date.parse(l.created_at)).toBe(300_000);
    }
    await h.stop();
  });

  it("a goal someone set is reported without a key; one she set herself is narration", async () => {
    const llm = new FnProvider((user) =>
      user.includes("這一步做完了")
        ? JSON.stringify({ goal: "蓋房子", goal_status: "done", action: null })
        : decision("蓋房子", { name: "obtain", args: { item: "stone_pickaxe" } }),
    );
    const finished = async (by: string): Promise<Impulse | undefined> => {
      const h = await Harness.create(llm);
      await h.start();
      await h.sup.services.require(GameControlKey).goal("蓋房子", by);
      await secs(25);
      await h.taskDone();
      await secs(25);
      const line = h.lineLog.take().find((l) => (l.hint ?? "").includes("剛完成"));
      await h.stop();
      return line;
    };
    expect((await finished("聊天室"))?.attention ?? null).toBeNull();
    expect((await finished(SELF_GOAL_BY))?.attention?.key).toBe("game:craft:stone_pickaxe");
  });

  it("someone talking in game chat without game.chat is an answer, not narration", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    h.lineLog.take();
    await h.gameEvent("chat", "Steve 在遊戲裡說:你好", true, { sender: "Steve" });
    expect(h.lineLog.take().at(-1)?.attention ?? null).toBeNull();
    await h.stop();
  });

  it("she keeps knowing what happened, and the decision model sees what she already said", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null, "石鎬做好了,木鎬太慢了"));
    const h = await Harness.create(llm, { decide_secs: 20 });
    await h.start();
    await h.gameEvent("craft_finished", "做好了 石鎬×1", false, { item: "stone_pickaxe" });
    for (let i = 0; i < 3; i++) await secs(20);
    const section = (await h.prompts.all()[0]?.contribute(promptRequest())) ?? [];
    expect(section.find((s) => s.key === "game")?.body).toContain("做好了 石鎬×1");
    const user = llm.requests().at(-1)?.messages.at(-1)?.content ?? "";
    expect(user).toContain("最近實況提過");
    expect(user).toContain("石鎬做好了,木鎬太慢了");
    await h.stop();
  });

  it("what she said is remembered without the instructions around it", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm, { decide_secs: 20 });
    await h.start();
    await h.gameEvent("advancement", "達成成就「石器時代」", true, { title: "石器時代" });
    await secs(20);
    const user = contentText(llm.requests().at(-1)?.messages.at(-1)?.content ?? "");
    expect(user).toContain("- 達成成就「石器時代」");
    expect(user.split("最近實況提過")[1]).not.toContain("馬上用一兩句話反應");
    await h.stop();
  });
});

describe("game director details", () => {
  it("clamps and prefixes the model's mood nudges", async () => {
    const llm = new MockProvider("mock").reply(
      JSON.stringify({
        goal: "x",
        action: null,
        mood_nudge: { valence: 0.9, arousal: -0.5, energy: 0, reason: "賺到了" },
      }),
    );
    const h = await Harness.create(llm);
    await h.start();
    expect(h.nudges()).toEqual([
      { valence: 0.1, arousal: -0.1, energy: 0, reason: "game: 賺到了" },
    ]);
    await h.stop();
  });

  it("an unreadable reply is logged and the loop continues", async () => {
    const llm = new MockProvider("mock").reply("我不知道").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    expect(llm.requests()).toHaveLength(1);
    expect(h.acts()).toEqual([]);
    await secs(20);
    expect(llm.requests()).toHaveLength(2);
    await h.stop();
  });

  it("gives up a goal that ran too long", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm, { max_goal_secs: 30 });
    await h.start();
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    // The task's budget is capped at the goal limit.
    const task = h.exec.last();
    expect(task.budget_s).toBe(30);
    await secs(20);
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await secs(20);
    // The old goal failed ("太久了,放棄", code `timeout`), its task was cancelled, and the
    // next decision adopted a new one.
    expect(h.status()?.recent).toContain("目標失敗:挖鐵礦(太久了,放棄)");
    expect(h.exec.cancels).toContain(task.id);
    expect(h.goalLog.take()[0]).toMatchObject({ status: "failed", code: "timeout", task: task.id });
    await h.stop();
  });

  it("module stop cancels everything in flight", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    const acted = h.acts().length;
    const running = h.exec.last().id;
    await h.stop();
    await secs(120);
    expect(h.acts()).toHaveLength(acted);
    expect(llm.requests()).toHaveLength(1);
    // The goal's task is cancelled with the module.
    expect(h.exec.cancels).toEqual([running]);
  });

  it("restarting the module drops the old session and keeps services consistent", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    expect(h.status()).not.toBeNull();
    const restart = h.sup.restart("game");
    await vi.advanceTimersByTimeAsync(10);
    await restart;
    expect(h.status()).toBeNull();
    expect(await h.command("game status")).toContain("她目前沒有在玩遊戲。");
    await h.stop();
  });
});

describe("game status command", () => {
  it("formats the status", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    h.exec.summary = "血量 20/20\n位置 (5, 64, 5)\nBaritone 執行中(Mine)";
    h.exec.reportTask = "01RUNNING0000000000000000";
    await h.start();
    const out = await h.command("game status");
    expect(out).toBe(
      [
        "遊戲狀態",
        "正在玩：Minecraft（實況送到 discord:g1:text1）",
        "目標：挖鐵礦（已進行 0 秒）",
        '動作：mine {"block":"iron_ore"}',
        "遊戲 bot：忙碌中",
        "狀況：血量 20/20／位置 (5, 64, 5)／Baritone 執行中(Mine)",
      ].join("\n"),
    );
    await h.stop();
  });
});

describe("GameModule", () => {
  it("provides the handle and control services", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    const handle = h.sup.services.require(GameHandleKey);
    const control = h.sup.services.require(GameControlKey);
    expect(handle).toBeInstanceOf(GameHandle);
    expect(control).toBeInstanceOf(GameControl);
    expect(handle.status()).toBeNull();

    await expect(control.stop()).rejects.toBeInstanceOf(GameError);
    await expect(control.stop()).rejects.toThrow("她目前沒有在玩遊戲。");
    await expect(control.start("terraria", textCtx(), owner())).rejects.toThrow("找不到 terraria");
    expect(await control.start("minecraft", textCtx(), owner())).toContain("實況會在這個頻道進行");
    expect(handle.status()?.context).toEqual(textCtx());
    expect(await control.goal(" 去蓋房子 ", "Panel")).toBe("已設定新目標：去蓋房子。");
    await expect(control.goal("  ", "Panel")).rejects.toThrow("請輸入目標。");
    await settle();
    expect(handle.status()?.goal?.note).toBe("(Panel 指定的)");
    expect(await control.stop()).toContain("她已停止玩 Minecraft。");
    await h.stop();
  });

  it("status JSON keeps the Rust shape", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    const status = h.status() as GameStatus;
    expect(Object.keys(status).sort()).toEqual(
      [
        "backlog",
        "busy",
        "context",
        "game",
        "game_name",
        "goal",
        "last_action",
        "recent",
        "started_at",
        "summary",
      ].sort(),
    );
    expect(status.game).toBe("minecraft");
    expect(status.game_name).toBe("Minecraft");
    expect(typeof status.started_at).toBe("string");
    await h.stop();
  });

  it("stop lists open viewer requests", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    await h.start();
    const a = h.submit("挖鑽石", "Amy");
    const b = h.submit("蓋房子", "Bob");
    h.queue.next();
    h.queue.next();
    await settle();
    expect(await h.command("game stop")).toBe(
      `她已停止玩 Minecraft。觀眾請求 #${a}、#${b} 尚未完成，已保留在佇列中。`,
    );
    await h.stop();
  });

  it("works without any optional service and manifest matches Rust", async () => {
    const m = new GameModule("A", "B").manifest;
    expect(m.id).toBe("game");
    expect(m.requires).toEqual([]);
    expect(m.optional).toEqual(["llm", "commands", "queue", "extensions"]);

    const sup = new Supervisor();
    await sup.register(new GameModule("A", "B"), null, true);
    await sup.startAll();
    const control = sup.services.require(GameControlKey);
    await expect(control.start("minecraft", textCtx(), owner())).rejects.toThrow(
      "擴充套件系統沒有啟用，無法玩遊戲。",
    );
    const stopping = sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
  });

  it("fromProfile uses the display name, persona and profile id", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const profile = {
      id: "deepseek",
      displayName: "DeepSeek醬",
      personaPrompt: () => "傲嬌的鯨魚女孩",
    };
    const sup = new Supervisor();
    new FakeExecutors(new FakeExecutor((e) => sup.bus.publish("ext", e))).provide(sup.services);
    sup.services.provide(
      "app",
      LlmRouterKey,
      new LlmRouter(new Map([["mock", llm]]), new Map([["game", [parseModelRef("mock:m")]]])),
    );
    await sup.register(GameModule.fromProfile(profile as never), null, true);
    await sup.startAll();
    await sup.services.require(GameControlKey).start("minecraft", textCtx(), owner());
    await settle();
    const request = llm.requests()[0];
    expect(request?.messages[0]?.content).toContain("你是 DeepSeek醬,正在直播玩 Minecraft");
    expect(request?.messages[0]?.content).toContain("傲嬌的鯨魚女孩");
    expect(request?.session).toBe("miyoria-deepseek-game-minecraft");
    const stopping = sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
  });
});

describe("session end and gated tools", () => {
  it("a disconnect ends the session with its code, without commentary", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    const sessions = collect(h.sup.bus.subscribe(SESSION_TOPIC), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
    await h.start();
    h.hints();
    await h.gameEvent("disconnected", "跟 Minecraft 的連線斷了", true);
    expect(h.status()).toBeNull();
    const stopped = sessions.take().filter((s) => s.state === "stopped");
    expect(stopped).toEqual([
      expect.objectContaining({
        game: "minecraft",
        code: "disconnected",
        reason: "跟 Minecraft 的連線斷了",
      }),
    ]);
    expect(h.hints()).toEqual([]);
    // No `stop` / `quit` sent to a game that is gone.
    expect(h.actNames()).not.toContain("quit");
    await h.stop();
  });

  it("only games with goals are directed; Threads stays out", async () => {
    const llm = new MockProvider("mock").reply(decision("閒晃", null));
    const h = await Harness.create(llm);
    const threads = new FakeExecutor((e) => h.sup.bus.publish("ext", e), Date.now, {
      owner: "game.threads",
      name: "Threads",
    });
    h.executors.byOwner.set("game.threads", threads);
    expect(await h.command("game start", { game: "threads" })).toContain("不是有目標的遊戲");
    expect(h.status()).toBeNull();
    expect(threads.observeCalls).toBe(0);
    await h.stop();
  });

  it("a task the extension crashed in ends the session with its code", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    const sessions = collect(h.sup.bus.subscribe(SESSION_TOPIC), (e) =>
      e.type === "custom" ? (e.data.payload as Record<string, JsonValue>) : null,
    );
    await h.start();
    await h.taskFailed("crashed", "擴充套件結束了(exit code: 1)");
    expect(h.status()).toBeNull();
    expect(sessions.take().filter((x) => x.state === "stopped")).toEqual([
      expect.objectContaining({ code: "crashed" }),
    ]);
    await h.stop();
  });

  it("an interrupted task is not a failed goal", async () => {
    const llm = new MockProvider("mock").reply(
      decision("挖鐵礦", { name: "mine", args: { block: "iron_ore" } }),
    );
    const h = await Harness.create(llm);
    await h.start();
    await h.taskFailed("busy", "被身體的本能反應打斷");
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    expect(h.goalLog.take()).toEqual([]);
    // The next decision may issue the same action again: its task ended.
    await secs(4);
    expect(h.actNames()).toEqual(["mine", "mine"]);
    await h.stop();
  });

  it("a goal set while the game is starting waits for the session", async () => {
    const llm = new MockProvider("mock").reply(decision("挖鐵礦", null));
    const h = await Harness.create(llm);
    const control = h.sup.services.require(GameControlKey);
    expect(control.pendingGoal("挖鐵礦", "Owen")).toContain("開好後");
    await h.start();
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    await h.stop();
  });
});
