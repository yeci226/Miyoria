// The director on the work lane (docs/design/v4-plan.md §11.2 items 1, 5 and 8): its decisions are
// steps of one task per session that remembers what it tried and what came of it; a method that
// failed and was held comes back only once something changed; what she learned is kept across
// restarts.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  LlmRouterKey,
  parseModelRef,
} from "@miyoria/llm";
import { ToolRegistry } from "@miyoria/tools";
import {
  type ContextKey,
  type DrivenStep,
  type DrivenWork,
  type DrivenWorkSpec,
  type JsonObject,
  type JsonValue,
  WorkEndedError,
  type WorkLane,
  WorkLaneKey,
  type WorkMessage,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DECISION_TOPIC, GameControlKey, GameModule } from "../src/index.js";
import { parseSkillPage, skillName, skillPage } from "../src/skill-store.js";
import { FakeExecutor, FakeExecutors, MINECRAFT_GOALS } from "./fake-executor.js";

const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };

function decide(goal: string, action: JsonValue, want: JsonValue = null): string {
  return JSON.stringify({ goal, goal_status: "working", want, action, commentary: null });
}

function outcome(progressed: boolean, inventory: JsonObject | null = null): JsonValue {
  return { outcome: { progressed, gained: {}, lost: {}, inventory, note: "" } };
}

/** One step the director took, as the lane saw it. */
interface Seen {
  input: DrivenStep;
  /** What came of what it tried, delivered with this step. */
  results: string[];
  /** The transcript it built on. */
  before: WorkMessage[];
}

/** A task the director drives: keeps its steps like the agent's lane does, answers from a script. */
class FakeWork implements DrivenWork {
  readonly id = "work-1";
  readonly seen: Seen[] = [];
  #pending: string[] = [];
  #steps: WorkMessage[] = [];
  ended = false;
  end_: { state: string; detail: string } | null = null;

  constructor(
    readonly spec: DrivenWorkSpec,
    readonly answers: string[],
    public budget = Number.POSITIVE_INFINITY,
  ) {}

  async step(input: DrivenStep): Promise<string> {
    if (this.ended) throw new WorkEndedError("stopped", "ended");
    if (this.budget <= 0) {
      this.ended = true;
      throw new WorkEndedError("out_of_budget", "spent");
    }
    this.budget -= 1;
    this.seen.push({ input, results: [...this.#pending], before: [...this.#steps] });
    const kept = [...this.#pending.map((r) => `- ${r}`), input.kept ?? input.user].join("\n");
    this.#pending = [];
    const answer = (this.answers.length > 1 ? this.answers.shift() : this.answers[0]) ?? "{}";
    this.#steps = [
      ...this.#steps,
      { role: "user" as const, content: kept },
      { role: "assistant" as const, content: answer },
    ].slice(-2 * this.spec.keep_steps);
    return answer;
  }

  result(text: string): void {
    this.#pending.push(text);
  }

  transcript(): WorkMessage[] {
    return [...this.#steps];
  }

  end(state: "done" | "stopped" | "gave_up", detail: string): void {
    this.ended = true;
    this.end_ = { state, detail };
  }
}

class FakeLane implements WorkLane {
  readonly opened: FakeWork[] = [];
  readonly store = new Map<string, JsonValue>();

  constructor(
    readonly answers: string[],
    readonly budget = Number.POSITIVE_INFINITY,
  ) {}

  tasks() {
    return [];
  }

  open(spec: DrivenWorkSpec): DrivenWork {
    const work = new FakeWork(spec, this.answers, this.budget);
    this.opened.push(work);
    return work;
  }

  async keep(owner: string, key: string, value: JsonValue | null): Promise<void> {
    if (value === null) this.store.delete(`${owner}:${key}`);
    else this.store.set(`${owner}:${key}`, value);
  }

  async kept(owner: string, key: string): Promise<JsonValue | null> {
    return this.store.get(`${owner}:${key}`) ?? null;
  }
}

/** The one-shot path's model (used when the lane is off or spent). */
class Script implements ChatProvider {
  readonly name = "script";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly replies: string[]) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = (this.replies.length > 1 ? this.replies.shift() : this.replies[0]) ?? "{}";
    return (async function* () {
      yield { type: "text_delta" as const, text };
      yield { type: "done" as const, finish_reason: "stop", usage: null };
    })();
  }
}

async function secs(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * 1000);
  await vi.advanceTimersByTimeAsync(5);
}

class H {
  readonly sup = new Supervisor();
  readonly exec: FakeExecutor;
  readonly payloads: { topic: string; payload: JsonValue }[] = [];

  private constructor(
    readonly llm: Script,
    readonly lane: FakeLane | null,
  ) {
    this.exec = new FakeExecutor(
      (e) => this.sup.bus.publish("ext.miyoria.minecraft", e),
      Date.now,
      {
        goals: [
          ...MINECRAFT_GOALS,
          { name: "farm", description: "收成", parameters: null, budget_s: 120 },
          { name: "hunt", description: "打獵", parameters: null, budget_s: 120 },
        ],
      },
    );
    const sub = this.sup.bus.subscribe("*");
    void (async () => {
      for await (const env of sub as AsyncIterable<{ event: { type: string; data: unknown } }>) {
        const e = env.event;
        if (e.type === "custom") {
          const data = e.data as { topic: string; payload: JsonValue };
          this.payloads.push({ topic: data.topic, payload: data.payload });
        }
      }
    })();
  }

  static async create(
    lane: FakeLane | null,
    replies: string[] = ["{}"],
    config: JsonValue = null,
    skillCapabilities: ((registry: ActuatorRegistry) => void) | null = null,
  ): Promise<H> {
    const h = new H(new Script(replies), lane);
    const router = new LlmRouter(
      new Map([[h.llm.name, h.llm]]),
      new Map([["game", [parseModelRef(`${h.llm.name}:m`)]]]),
    );
    new FakeExecutors(h.exec).provide(h.sup.services);
    h.sup.services.provide("app", LlmRouterKey, router);
    if (lane !== null) h.sup.services.provide("app", WorkLaneKey, lane);
    if (skillCapabilities !== null) {
      const actuators = new ActuatorRegistry({
        services: h.sup.services,
        tools: new ToolRegistry(),
        publish: () => undefined,
      });
      skillCapabilities(actuators);
      h.sup.services.provide("app", ActuatorRegistryKey, actuators);
    }
    await h.sup.register(new GameModule("DeepSeek醬", ""), config, true);
    await h.sup.startAll();
    return h;
  }

  async start(): Promise<void> {
    await this.sup.services
      .require(GameControlKey)
      .start("minecraft", TEXT, { platform: "discord", id: "1" }, "here");
    await vi.advanceTimersByTimeAsync(5);
  }

  work(): FakeWork {
    const w = this.lane?.opened.at(-1);
    if (!w) throw new Error("no work task");
    return w;
  }

  of(topic: string): JsonObject[] {
    return this.payloads.filter((p) => p.topic === topic).map((p) => p.payload as JsonObject);
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 8, 16, 8, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

const BREAD = decide("做麵包", { name: "obtain", args: { item: "bread" } });
const MISSING = "材料不夠:還缺 小麥 wheat×3,而且要站在工作台旁邊做";

describe("the director's decisions are steps of one work-lane task", () => {
  it("remembers a failed method: what it tried and what came of it are in its next step", async () => {
    const lane = new FakeLane([BREAD, BREAD, decide("去收小麥", { name: "farm", args: {} })]);
    const h = await H.create(lane);
    h.exec.autoEnd = (spec) =>
      spec.goal === "obtain" ? { type: "failed", code: "precondition", detail: MISSING } : null;
    await h.start();
    // One task for the session, opened at its first decision; the one-shot model is not asked.
    expect(lane.opened).toHaveLength(1);
    expect(h.work().spec).toMatchObject({ owner: "game.minecraft", goal: "玩 Minecraft" });
    expect(h.llm.requests).toEqual([]);
    await secs(4);
    // The second step gets what came of the first, and builds on the first step's answer.
    const second = h.work().seen[1];
    expect(second?.results.join("\n")).toContain('obtain {"item":"bread"} → 失敗(precondition)');
    expect(second?.results.join("\n")).toContain("wheat");
    expect(second?.before.map((m) => m.content)).toContain(BREAD);
    // What it saw is kept short: the record and the holds are in every prompt anew.
    expect(second?.before[0]?.content).toContain("那時看到的");
    expect(second?.input.json).toBe(true);
    expect(second?.input.reasoning).toBe("low");
    await secs(4);
    // Twice the same failure: the third bread is held, and the task hears that too.
    expect(h.exec.names()).toEqual(["obtain", "obtain", "farm"]);
    const third = h.work().seen[2];
    expect(third?.results.join("\n")).toContain("失敗(precondition)");
    await h.stop();
    expect(h.work().end_).toMatchObject({ state: "stopped" });
  });

  it("a held method comes back once what was missing is there, not after ten minutes", async () => {
    const lane = new FakeLane([BREAD]);
    const h = await H.create(lane);
    h.exec.state = { connected: true, in_game: true, inventory: { dirt: 2 } };
    let fails = true;
    h.exec.autoEnd = (spec) =>
      spec.goal === "obtain" && fails
        ? { type: "failed", code: "precondition", detail: MISSING }
        : null;
    await h.start();
    await secs(4);
    expect(h.exec.names()).toEqual(["obtain", "obtain"]);
    // Twenty minutes of asking for bread with nothing changed: never started again.
    await secs(20 * 60);
    expect(h.exec.names()).toEqual(["obtain", "obtain"]);
    const held = h.of(DECISION_TOPIC).at(-1)?.held as string[];
    expect(held).toContainEqual(expect.stringContaining("obtain:bread(等拿到 wheat 再試)"));
    // Something new that is not wheat: still held.
    h.exec.state = { connected: true, in_game: true, inventory: { dirt: 2, oak_log: 3 } };
    await secs(25);
    expect(h.exec.names()).toEqual(["obtain", "obtain"]);
    // The wheat is there: bread may be tried again, and now it works.
    fails = false;
    h.exec.state = { connected: true, in_game: true, inventory: { dirt: 2, oak_log: 3, wheat: 3 } };
    await secs(25);
    expect(h.exec.names()).toEqual(["obtain", "obtain", "obtain"]);
    await h.stop();
  });

  it("director_lane = false: every decision is its own call again", async () => {
    const lane = new FakeLane([BREAD]);
    const h = await H.create(lane, [BREAD], { director_lane: false });
    await h.start();
    expect(lane.opened).toEqual([]);
    expect(h.llm.requests).toHaveLength(1);
    await h.stop();
  });

  it("the lane's day spent: the session goes on with one-shot decisions", async () => {
    const lane = new FakeLane([decide("挖礦", null)], 1);
    const h = await H.create(lane, [decide("挖礦", null)]);
    await h.start();
    expect(h.work().seen).toHaveLength(1);
    expect(h.llm.requests).toHaveLength(0);
    await secs(20);
    // The step was refused: this decision and the next are one-shot calls; no second task.
    expect(h.llm.requests).toHaveLength(1);
    await secs(20);
    expect(h.llm.requests).toHaveLength(2);
    expect(lane.opened).toHaveLength(1);
    expect(contentText(h.llm.requests[0]?.messages.at(-1)?.content ?? "")).toContain("遊戲狀態");
    await h.stop();
  });
});

describe("what she learned is kept across restarts", () => {
  const HUNT = decide("弄吃的", { name: "hunt", args: { entity: "cow" } }, { item: "cooked_beef" });

  async function learn(h: H): Promise<void> {
    await h.start();
    h.exec.done("打到牛又烤好了", h.exec.last().id, outcome(true, { cooked_beef: 1 }));
    await secs(3);
  }

  it("without her skill store: in the settings store, through the lane", async () => {
    const lane = new FakeLane([HUNT]);
    const first = await H.create(lane);
    await learn(first);
    expect(lane.store.get("game.minecraft:skills")).toEqual([
      expect.objectContaining({ target: "cooked_beef", steps: ['hunt {"entity":"cow"}'] }),
    ]);
    await first.stop();
    // A new run: the next decision for cooked beef sees how she got it.
    const again = new FakeLane([HUNT]);
    for (const [k, v] of lane.store) again.store.set(k, v);
    const second = await H.create(again);
    await second.start();
    await secs(25);
    const prompt = second.work().seen.at(-1)?.input.user ?? "";
    expect(prompt).toContain('cooked_beef:hunt {"entity":"cow"}');
    await second.stop();
  });

  it("with her skill store: one skill page per game, through the gate", async () => {
    const pages = new Map<string, string>();
    const skills = (actuators: ActuatorRegistry) => {
      actuators.register(
        defineCapability({
          name: "skill.read",
          summary: "讀技能",
          risk: "low",
          args: z.object({ name: z.string() }),
          permission: null,
          async execute(a) {
            const page = pages.get(a.name);
            return { text: page === undefined ? "沒有這個技能" : `技能:\n${page}`, data: null };
          },
        }),
      );
      actuators.register(
        defineCapability({
          name: "skill.write",
          summary: "寫技能",
          risk: "low",
          args: z.object({ name: z.string(), description: z.string(), body: z.string() }),
          permission: null,
          async execute(a) {
            pages.set(a.name, a.body);
            return { text: "存好了", data: { name: a.name } };
          },
        }),
      );
    };
    const lane = new FakeLane([HUNT]);
    const first = await H.create(lane, ["{}"], null, skills);
    await learn(first);
    expect(pages.get(skillName("minecraft"))).toContain('- cooked_beef ← hunt {"entity":"cow"}');
    expect(lane.store.size).toBe(0);
    await first.stop();
    const second = await H.create(new FakeLane([HUNT]), ["{}"], null, skills);
    await second.start();
    await secs(25);
    expect(second.work().seen.at(-1)?.input.user).toContain('cooked_beef:hunt {"entity":"cow"}');
    await second.stop();
  });

  it("the page reads back what it wrote", () => {
    const skills = [
      {
        game: "minecraft",
        target: "bread",
        goal: "bread",
        steps: ["farm", 'obtain {"item":"bread"}'],
        at: 1,
      },
    ];
    expect(parseSkillPage("minecraft", skillPage("minecraft", skills), 1)).toEqual(skills);
  });
});
