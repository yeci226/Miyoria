// The work lane (docs/design/v4-plan.md §4.3): a task is its own loop of model calls with tools and
// its own transcript, off the Floor, bounded by steps, time and tokens, steered and stopped from
// the main line, and reported back to it once. Nothing in it speaks.

import { ActuatorRegistry } from "@miyoria/actions";
import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import { type Tool, type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type ContextKey,
  type Directives,
  DirectivesKey,
  EventLogKey,
  isJsonObject,
  type JsonValue,
  PipelineKey,
  ProposalBoardKey,
  type TaskEvent,
  toTimestamp,
  WORK_PURPOSE,
  WorkEndedError,
  WorkLaneKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkConfigSchema } from "../src/config.js";
import { allowance, talks } from "../src/worklane/allow.js";
import { asWork } from "../src/worklane/initiative.js";
import { RESTART_REASON, shortId, TASK_PREFIX, WorkLaneService } from "../src/worklane/lane.js";
import { NOT_ALLOWED } from "../src/worklane/prompt.js";
import {
  account,
  channel,
  done,
  Harness,
  mention,
  noCheck,
  stopHarnesses,
  textDelta,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 10, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

type Step = StreamEvent[] | "hang";

/** A model call of a work task (it alone is offered `give_up`). */
function isWork(request: ChatRequest): boolean {
  return request.tools?.some((t) => t.name === "give_up") ?? false;
}

/** One provider for both lanes: the main line's calls and the tasks' calls each play their script. */
class Lanes implements ChatProvider {
  readonly name = "lanes";
  readonly chat: ChatRequest[] = [];
  readonly work: ChatRequest[] = [];

  constructor(
    readonly chatScript: Step[],
    readonly workScript: Step[],
  ) {}

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    const work = isWork(request);
    (work ? this.work : this.chat).push(structuredClone(request));
    const script = work ? this.workScript : this.chatScript;
    const step = (script.length > 1 ? script.shift() : script[0]) ?? [done()];
    return (async function* (): ChatStream {
      if (step === "hang") {
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return;
      }
      for (const event of step) yield event;
    })();
  }
}

function reply(text: string, ...calls: [string, string][]): StreamEvent[] {
  return [
    ...(text === "" ? [] : [textDelta(text)]),
    ...calls.map(([name, args], i) => toolCall(i, `c${i}-${Math.random()}`, name, args)),
    done(),
  ];
}

/** A step that costs `tokens`. */
function costly(tokens: number, ...calls: [string, string][]): StreamEvent[] {
  return [
    ...calls.map(([name, args], i) => toolCall(i, `c${i}`, name, args)),
    {
      type: "done",
      finish_reason: null,
      usage: { prompt_tokens: tokens, completion_tokens: 0, cached_prompt_tokens: null },
    },
  ];
}

/** A tool that answers with `answer(args)` and records its calls. */
class Fake implements Tool {
  readonly spec;
  readonly calls: [ToolContext, JsonValue][] = [];

  constructor(
    name: string,
    readonly answer: (args: JsonValue) => string = () => "ok",
  ) {
    this.spec = { name, description: name, parameters: { type: "object" } };
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    this.calls.push([ctx, args]);
    return this.answer(args);
  }
}

const PAGES: Record<string, string> = {
  "https://a.example/news": "A 站:1.22 加了新的生物「螢火蟲」。",
  "https://b.example/wiki": "B 站:螢火蟲只在沼澤晚上出現。",
};

function webTools(): { search: Fake; read: Fake } {
  return {
    search: new Fake("web_search", () => "1. https://a.example/news\n2. https://b.example/wiki"),
    read: new Fake("web_read", (args) =>
      isJsonObject(args) && typeof args.url === "string" ? (PAGES[args.url] ?? "404") : "404",
    ),
  };
}

const C = channel("c");

interface LaneRig {
  lane: WorkLaneService;
  provider: Lanes;
  events: TaskEvent[];
  retold: { context: ContextKey | null; detail: string }[];
  registry: ToolRegistry;
  store: MemorySettingsStore;
  services: ServiceRegistry;
}

function laneRig(
  work: Step[],
  options: {
    config?: Record<string, unknown>;
    tools?: Tool[];
    store?: MemorySettingsStore;
    directives?: Partial<Directives>;
  } = {},
): LaneRig {
  const provider = new Lanes([...work], work);
  const router = new LlmRouter(
    new Map([["chat", provider]]),
    new Map([["chat", [parseModelRef("chat:m")]]]),
  );
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const services = new ServiceRegistry();
  if (options.directives) {
    services.provide("app", DirectivesKey, options.directives as Directives);
  }
  const events: TaskEvent[] = [];
  const retold: { context: ContextKey | null; detail: string }[] = [];
  const store = options.store ?? new MemorySettingsStore();
  const lane = new WorkLaneService({
    config: WorkConfigSchema.parse(options.config ?? {}),
    now: () => Date.now(),
    router: () => router,
    tools: () => registry,
    services,
    publish: () => undefined,
    follow: (_topic, payload) => events.push(payload as unknown as TaskEvent),
    store: () => store,
    profile: () => "p",
    self: (platform) => ({ platform, id: "her" }),
    persona: () => ({ name: "小鯨魚", text: "你是住在深海的鯨魚娘。" }),
    rules: () => [],
    retell: (input) => retold.push({ context: input.context, detail: input.detail }),
    log: getLogger("worklane-test"),
  });
  return { lane, provider, events, retold, registry, store, services };
}

function startOwn(r: LaneRig, goal: string, tools: string[], extra: object = {}) {
  return r.lane.start({
    goal,
    why: "好奇",
    for: null,
    principal: { kind: "self", requester: null, context: C, override: false, actor: null },
    context: C,
    tools,
    turn: null,
    activity: "browse",
    ...extra,
  });
}

const ended = (r: LaneRig) => r.events.filter((e) => e.type === "done" || e.type === "failed");

describe("a task runs as its own loop", () => {
  it("three sources: search, then two pages, each result in its transcript, then her conclusion", async () => {
    const { search, read } = webTools();
    const r = laneRig(
      [
        reply("先搜尋", ["web_search", '{"query":"Minecraft 1.22 新生物"}']),
        reply("", ["web_read", '{"url":"https://a.example/news"}']),
        reply("", ["web_read", '{"url":"https://b.example/wiki"}']),
        reply("1.22 有螢火蟲,只在沼澤晚上出現。"),
      ],
      { tools: [search, read] },
    );
    const out = startOwn(r, "查 Minecraft 1.22 的新生物", ["web_read", "web_search"]);
    expect(out).toMatchObject({ ok: true, state: "running" });
    await wait(100);
    expect(search.calls).toHaveLength(1);
    expect(read.calls.map(([, a]) => (a as { url: string }).url)).toEqual([
      "https://a.example/news",
      "https://b.example/wiki",
    ]);
    // Each step sees everything before it: the transcript only grows.
    const last = JSON.stringify(r.provider.work.at(-1)?.messages);
    expect(last).toContain("螢火蟲」");
    expect(last).toContain("只在沼澤晚上出現");
    expect(r.provider.work.every((q) => q.reasoning_purpose === WORK_PURPOSE)).toBe(true);
    // Results are data, never instructions.
    expect(last).toContain('<data source=\\"tool\\"');
    const end = ended(r);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: "done" });
    const detail = (end[0] as { detail: string }).detail;
    expect(detail).toContain("結論:1.22 有螢火蟲");
    expect(detail).toContain(
      "做了:查了「Minecraft 1.22 新生物」;讀了 a.example 的網頁;讀了 b.example 的網頁",
    );
    expect(r.lane.tasks()[0]).toMatchObject({ state: "done", steps: 4, calls: 3 });
  });

  it("one or two at a time: the rest wait in the queue and start when one ends", async () => {
    const r = laneRig([reply("好了")], { config: { max_running: 1, max_queued: 1 } });
    expect(startOwn(r, "一", [])).toMatchObject({ ok: true, state: "running" });
    expect(startOwn(r, "二", [])).toMatchObject({ ok: true, state: "queued", ahead: 0 });
    const third = startOwn(r, "三", []);
    expect(third.ok).toBe(false);
    await wait(100);
    expect(ended(r)).toHaveLength(2);
  });

  it("a task the owner's rules forbid never starts", () => {
    const r = laneRig([reply("好了")], {
      directives: {
        forbids: (goal) =>
          goal.what.includes("Minecraft") ? ({ text: "不要碰 Minecraft" } as never) : null,
        filterTools: (t) => [...t],
      },
    });
    expect(startOwn(r, "查 Minecraft 攻略", [])).toEqual({
      ok: false,
      why: "主人的規則不准:不要碰 Minecraft",
    });
  });
});

describe("budgets end a task, and it hands back what it has", () => {
  it("steps", async () => {
    const { search } = webTools();
    const r = laneRig([reply("還在找", ["web_search", '{"query":"x"}'])], {
      tools: [search],
    });
    startOwn(r, "找 x", ["web_search"], { maxSteps: 2 });
    await wait(100);
    expect(search.calls).toHaveLength(2);
    expect(r.lane.tasks()[0]?.state).toBe("out_of_budget");
    // What it had is a result: the main line hears it as one.
    const end = ended(r)[0] as { type: string; detail: string };
    expect(end.type).toBe("done");
    expect(end.detail).toContain("預算用完了");
    expect(end.detail).toContain("目前的成果:2 步用完了;還在找");
  });

  it("tokens of the task, and the lane's day", async () => {
    const { search } = webTools();
    const r = laneRig([costly(30_000, ["web_search", "{}"])], {
      tools: [search],
      config: { max_tokens: 50_000, daily_tokens: 70_000 },
    });
    startOwn(r, "一", ["web_search"]);
    await wait(100);
    expect(r.lane.tasks()[0]).toMatchObject({ state: "out_of_budget", tokens: 60_000 });
    // 60,000 of 70,000 spent today: the next one stops after a step, the one after never starts.
    startOwn(r, "二", ["web_search"]);
    await wait(100);
    expect(r.lane.tasks().find((t) => t.goal === "二")?.state).toBe("out_of_budget");
    expect(startOwn(r, "三", [])).toEqual({ ok: false, why: "今天工作的額度用完了" });
  });

  it("time: a call that does not answer in time ends it", async () => {
    const r = laneRig(["hang"], { config: { max_minutes: 1 } });
    startOwn(r, "慢慢想", []);
    await wait(61_000);
    expect(r.lane.tasks()[0]?.state).toBe("out_of_budget");
    expect(ended(r)[0]).toMatchObject({ type: "failed", code: "timeout" });
  });
});

describe("steering", () => {
  it("a hint and a new goal reach its next step; the budget stays", async () => {
    // The search answers only once the steer is in: it lands between two steps (a safe point).
    let answer: (text: string) => void = () => undefined;
    const search = new Fake("web_search");
    search.call = async (ctx, args) => {
      search.calls.push([ctx, args]);
      return await new Promise<string>((resolve) => {
        answer = resolve;
      });
    };
    const r = laneRig([reply("", ["web_search", '{"query":"a"}']), "hang"], { tools: [search] });
    const out = startOwn(r, "查 a", ["web_search"], { maxSteps: 5 });
    if (!out.ok) throw new Error("not started");
    await wait(10);
    expect(search.calls).toHaveLength(1);
    const id = shortId(out.id);
    expect(r.lane.steer(id, { hint: "只看官方的" })).toMatchObject({ ok: true });
    expect(r.lane.steer(id, { goal: "查 b" })).toMatchObject({ ok: true });
    answer("1. https://a.example/news");
    await wait(10);
    expect(JSON.stringify(r.provider.work[0]?.messages)).not.toContain("只看官方的");
    const second = JSON.stringify(r.provider.work[1]?.messages);
    expect(second).toContain("只看官方的");
    expect(second).toContain("新的目標:查 b");
    expect(r.lane.tasks()[0]).toMatchObject({ goal: "查 b", state: "running" });
    // Stop: the call in flight is aborted, it ends as stopped.
    expect(r.lane.steer(id, { stop: true, why: "不用了" })).toEqual({
      ok: true,
      text: `任務 ${id} 停掉了`,
    });
    await wait(10);
    expect(r.lane.tasks()[0]).toMatchObject({ state: "stopped", result: "不用了" });
    expect(ended(r)[0]).toMatchObject({ type: "failed", code: "cancelled" });
    expect(r.lane.steer(id, { hint: "再試" })).toMatchObject({ ok: false });
  });

  it("a waiting task stops without ever running", async () => {
    const r = laneRig(["hang"], { config: { max_running: 1 } });
    startOwn(r, "一", []);
    const second = startOwn(r, "二", []);
    if (!second.ok) throw new Error("not queued");
    expect(r.lane.steer(second.id, { stop: true })).toMatchObject({ ok: true });
    expect(r.lane.tasks().find((t) => t.goal === "二")).toMatchObject({
      state: "stopped",
      steps: 0,
    });
  });
});

describe("what a task can never do", () => {
  it("speak, or call a tool outside its allowance: refused, never run", async () => {
    const dm = new Fake("message_dm");
    const code = new Fake("code_run");
    const { search } = webTools();
    const r = laneRig(
      [
        reply("我私訊跟他說", ["message_dm", '{"to":"1","text":"嗨"}'], ["code_run", "{}"]),
        reply("好吧,只寫結論"),
      ],
      { tools: [dm, code, search] },
    );
    startOwn(r, "查東西", ["web_search"]);
    await wait(100);
    expect(dm.calls).toEqual([]);
    expect(code.calls).toEqual([]);
    const results = (r.provider.work[1]?.messages ?? []).filter((m) => m.role === "tool");
    expect(results.map((m) => m.content)).toEqual([NOT_ALLOWED, NOT_ALLOWED]);
    // It was never offered either: only its allowance and `give_up` are.
    expect(r.provider.work[0]?.tools?.map((t) => t.name)).toEqual(["web_search", "give_up"]);
    expect(r.lane.tasks()[0]?.state).toBe("done");
  });

  it("the allowance: configured, registered, offered here, wanted, and never a talking tool", () => {
    const registry = new Map<string, Tool>(
      ["web_search", "web_read", "code_run", "message_dm", "react", "party_start"].map((n) => [
        n,
        new Fake(n),
      ]),
    );
    const forbidCode: Partial<Directives> = {
      filterTools: (tools) => tools.filter((t) => t.name !== "code_run"),
    };
    const got = allowance({
      configured: [
        "web_search",
        "web_read",
        "code_run",
        "message_dm",
        "react",
        "party_start",
        "nope",
      ],
      tool: (n) => registry.get(n),
      directives: forbidCode as Directives,
      context: C,
      wanted: null,
    });
    expect(got).toEqual(["web_read", "web_search"]);
    expect(
      allowance({
        configured: ["web_search", "web_read"],
        tool: (n) => registry.get(n),
        directives: null,
        context: C,
        wanted: ["web_read", "message_dm"],
      }),
    ).toEqual(["web_read"]);
    for (const n of [
      "react",
      "message_dm",
      "voice_join",
      "sing_request",
      "work_start",
      "keep_note",
    ]) {
      expect(talks(n), n).toBe(true);
    }
    expect(talks("web_search")).toBe(false);
  });
});

describe("a restart", () => {
  it("a task running when she stopped ends as stopped by the restart, and she is told once", async () => {
    const store = new MemorySettingsStore();
    const first = laneRig(["hang"], { store });
    const out = startOwn(first, "整理筆記", []);
    if (!out.ok) throw new Error("not started");
    await wait(10);
    await first.lane.flush();
    expect([...(await store.list("p", TASK_PREFIX)).keys()]).toEqual([`${TASK_PREFIX}${out.id}`]);
    // The process goes away without ending it; the next run finds the row.
    const second = laneRig([reply("x")], { store });
    expect(await second.lane.recover()).toBe(1);
    expect(second.retold).toHaveLength(1);
    expect(second.retold[0]?.detail).toContain(RESTART_REASON);
    expect(second.retold[0]?.context).toEqual(C);
    // Her state stops showing it as running.
    expect(second.events).toEqual([expect.objectContaining({ type: "failed", task: out.id })]);
    const third = laneRig([reply("x")], { store });
    expect(await third.lane.recover()).toBe(0);
    expect(third.retold).toEqual([]);
    first.lane.close();
  });
});

describe("a task its owner drives (the game director)", () => {
  it("keeps what it saw, what it answered and what came of it, for the next step", async () => {
    const r = laneRig([reply('{"action":"obtain bread"}'), reply('{"action":"farm wheat"}')]);
    const work = r.lane.open({ owner: "game.minecraft", goal: "玩 Minecraft", keep_steps: 4 });
    const step = (user: string) =>
      work.step({
        system: "你在玩。",
        user,
        kept: user.slice(0, 4),
        purpose: "game",
        timeout_ms: 5000,
      });
    expect(await step("看到:草地,背包空")).toBe('{"action":"obtain bread"}');
    work.result("obtain bread → 失敗(precondition):還缺 小麥×3");
    await step("看到:小麥田");
    const messages = r.provider.chat.at(-1)?.messages ?? [];
    const text = JSON.stringify(messages);
    expect(messages[0]?.role).toBe("system");
    expect(text).toContain("obtain bread");
    expect(text).toContain("還缺 小麥×3");
    expect(work.transcript().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(r.lane.tasks()[0]).toMatchObject({
      owner: "game.minecraft",
      state: "running",
      steps: 2,
    });
    work.end("done", "不玩了");
    expect(r.lane.tasks()[0]?.state).toBe("done");
    await expect(step("還在嗎")).rejects.toBeInstanceOf(WorkEndedError);
  });

  it("the lane's day is shared: spent, a step ends the task", async () => {
    const r = laneRig([costly(100)], { config: { daily_tokens: 100 } });
    const work = r.lane.open({ owner: "game.minecraft", goal: "玩", keep_steps: 2 });
    await work.step({ system: "s", user: "u", purpose: "game", timeout_ms: 5000 });
    await expect(
      work.step({ system: "s", user: "u", purpose: "game", timeout_ms: 5000 }),
    ).rejects.toMatchObject({ state: "out_of_budget" });
    expect(work.ended).toBe(true);
  });

  it("what an owner learned outlives the process (the director's skills)", async () => {
    const store = new MemorySettingsStore();
    const first = laneRig([reply("x")], { store });
    await first.lane.keep("game.minecraft", "skills", [{ target: "bread", steps: ["farm"] }]);
    const second = laneRig([reply("x")], { store });
    expect(await second.lane.kept("game.minecraft", "skills")).toEqual([
      { target: "bread", steps: ["farm"] },
    ]);
    expect(await second.lane.kept("game.minecraft", "other")).toBeNull();
  });
});

describe("her own initiative", () => {
  const base = {
    what: "查最近的動畫新聞",
    why: "好奇",
    expires: toTimestamp(Date.UTC(2026, 10, 10, 7)),
    context: null,
    about: null,
    person: null,
    goal: null,
  };

  it("a wish of hers to do work becomes a work-lane task; anything else stays as it is", () => {
    const work = asWork({
      ...base,
      source: "plan",
      capability: "web.search",
      args: { query: "動畫" },
    });
    expect(work.capability).toBe("work.start");
    expect(work.args).toMatchObject({
      goal: "查最近的動畫新聞(從「動畫」開始)",
      activity: "browse",
    });
    expect(asWork({ ...base, source: "plan", capability: "game.start" }).capability).toBe(
      "game.start",
    );
    // A memory followup is not her wish to work.
    expect(asWork({ ...base, source: "memory", capability: "web.search" }).capability).toBe(
      "web.search",
    );
  });
});

// ---- through the main line ----------------------------------------------------------------------

async function rig(provider: ChatProvider, tools: Tool[], store?: MemorySettingsStore) {
  // The app's registries: capabilities become tools of the registry the agent offers.
  const appTools = new ToolRegistry();
  for (const tool of tools) appTools.register(tool);
  const actuators = new ActuatorRegistry({
    services: new ServiceRegistry(),
    tools: appTools,
    publish: () => undefined,
  });
  return Harness.build("normal", noCheck(), provider, null, {
    appTools,
    actuators,
    ...(store ? { store } : {}),
    provide: (services) => {
      services.provide("app", PipelineKey, { pipeline: "v3" as const });
    },
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

describe("through the main line", () => {
  it("she starts it, the mouth does not wait, and the result is told once, in her words", async () => {
    const { search, read } = webTools();
    const provider = new Lanes(
      [
        reply("好,我去查一下,等等跟你說", [
          "work_start",
          '{"goal":"查 1.22 的新生物","for":"Alice"}',
        ]),
        reply("查到了!1.22 有螢火蟲,只在沼澤晚上出現。"),
      ],
      [
        reply("", ["web_search", '{"query":"1.22 新生物"}']),
        reply("", ["web_read", '{"url":"https://a.example/news"}']),
        reply("", ["web_read", '{"url":"https://b.example/wiki"}']),
        reply("1.22 有螢火蟲,只在沼澤晚上出現。"),
      ],
    );
    const h = await rig(provider, [search, read]);
    h.say(mention(C, "Alice", "幫我查 Minecraft 1.22 的新生物,多看幾個地方"));
    await wait(3000);
    expect(h.sink.texts()[0]).toBe("好,我去查一下,等等跟你說");
    await wait(10_000);
    expect(provider.work).toHaveLength(4);
    expect(read.calls).toHaveLength(2);
    // The task ran as the person who asked.
    expect(search.calls[0]?.[0].principal).toMatchObject({
      kind: "user",
      requester: account("Alice"),
    });
    const told = JSON.stringify(provider.chat.at(-1)?.messages);
    expect(told).toContain("work_start 完成");
    expect(told).toContain("結論:1.22 有螢火蟲");
    expect(told).toContain("讀了 b.example 的網頁");
    expect(h.sink.texts().join("")).toBe(
      "好,我去查一下,等等跟你說查到了!1.22 有螢火蟲,只在沼澤晚上出現。",
    );
    // Told once: nothing more comes of it.
    await wait(60_000);
    expect(provider.chat).toHaveLength(2);
    // It is in her state while it runs, and the lane keeps it.
    const lane = h.sup.services.require(WorkLaneKey);
    expect(lane.tasks()[0]).toMatchObject({ state: "done", for: "Alice", steps: 4 });
    const log = h.sup.services.require(EventLogKey).recent(500);
    expect(
      log.some((e) => e.source === "worklane" && JSON.stringify(e.body).includes("任務開始")),
    ).toBe(true);
  });

  it("her own wish to browse is proposed as a task, and the turn that takes it starts one", async () => {
    const provider = new Lanes(
      [
        reply("", ["work_start", '{"goal":"查最近的動畫新聞","activity":"browse"}']),
        reply("<silence/>"),
      ],
      [reply("今年秋天有三部續作。")],
    );
    const h = await rig(provider, [webTools().search]);
    const board = h.sup.services.require(ProposalBoardKey);
    await board.propose({
      what: "查最近的動畫新聞",
      why: "好奇",
      capability: "web.search",
      args: { query: "動畫" },
      expires: toTimestamp(Date.now() + 120_000),
      source: "plan",
      context: null,
      about: null,
      person: null,
      goal: null,
    });
    await wait(5000);
    expect(JSON.stringify(provider.chat[0]?.messages)).toContain("work.start");
    expect(provider.work).toHaveLength(1);
    const lane = h.sup.services.require(WorkLaneKey);
    expect(lane.tasks()[0]).toMatchObject({ state: "done", for: null });
    // Nobody waited: nothing was said, and what it found is in her next prompt.
    expect(h.sink.texts()).toEqual([]);
    h.say(mention(C, "Bob", "你剛剛在幹嘛"));
    await wait(3000);
    expect(JSON.stringify(provider.chat.at(-1)?.messages)).toContain("今年秋天有三部續作");
  });

  it("after a restart, the task someone waited for is told once, where they asked", async () => {
    const store = new MemorySettingsStore();
    await store.set("test-chan", `${TASK_PREFIX}01TASK`, {
      id: "01TASK",
      goal: "查 1.22 的新生物",
      for: "Alice",
      context: C as unknown as JsonValue,
      requester: account("Alice") as unknown as JsonValue,
    });
    const provider = new Lanes([reply("抱歉,剛剛重開機,查到一半斷掉了,我再查一次?")], []);
    const h = await rig(provider, [], store);
    await wait(10_000);
    expect(JSON.stringify(provider.chat[0]?.messages)).toContain(RESTART_REASON);
    expect(h.sink.texts()).toEqual(["抱歉,剛剛重開機,查到一半斷掉了,我再查一次?"]);
    await wait(60_000);
    expect(provider.chat).toHaveLength(1);
    expect([...(await store.list("test-chan", TASK_PREFIX)).keys()]).toEqual([]);
  });
});

describe("a page read inside a turn (v4 §4.2)", () => {
  it("is not cut at 4,000 any more; a round still adds at most loop_round_chars", async () => {
    const page = `${"字".repeat(11_990)}頁尾`;
    const read = new Fake("web_read", () => page);
    const provider = new Lanes(
      [
        reply(
          "我看一下",
          ["web_read", '{"url":"https://a.example/1"}'],
          ["web_read", '{"url":"https://a.example/2"}'],
        ),
        reply("看完了"),
      ],
      [],
    );
    const h = await rig(provider, [read]);
    h.say(mention(C, "Alice", "幫我看這兩頁"));
    await wait(3000);
    const results = (provider.chat[1]?.messages ?? []).filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    const [first, second] = results.map((m) => String(m.content));
    // The whole page, inside a whole block.
    expect(first).toContain("頁尾\n</data>");
    // The second page is what is left of the round, and says so; its block still closes.
    expect(second).not.toContain("頁尾");
    expect(second).toContain("這一輪的結果加起來太長");
    expect(second).toContain("再讀)\n</data>");
    expect((first?.length ?? 0) + (second?.length ?? 0)).toBeLessThan(16_000 + 600);
  });
});
