// The work lane as far as it is left (docs/design/v4-plan.md §4.3): tasks an owner drives one step
// at a time (the game director), the lane's daily tokens, what owners keep across restarts, and the
// rows tasks of the old main line left when a restart cut them.

import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { getLogger } from "@miyoria/runtime/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import { type Publish, type TaskEvent, WorkEndedError } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WorkConfigSchema } from "../src/config.js";
import { RESTART_REASON, TASK_PREFIX, WorkLaneService } from "../src/worklane/lane.js";
import { done, textDelta } from "./harness.js";

/** Answers each call with the next step of its script; the last one repeats. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];

  constructor(readonly script: StreamEvent[][]) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const step = (this.script.length > 1 ? this.script.shift() : this.script[0]) ?? [done()];
    return (async function* (): ChatStream {
      for (const event of step) yield event;
    })();
  }
}

function reply(text: string): StreamEvent[] {
  return [textDelta(text), done()];
}

/** A step that costs `tokens`. */
function costly(tokens: number): StreamEvent[] {
  return [
    {
      type: "done",
      finish_reason: null,
      usage: { prompt_tokens: tokens, completion_tokens: 0, cached_prompt_tokens: null },
    },
  ];
}

interface LaneRig {
  lane: WorkLaneService;
  provider: Scripted;
  events: TaskEvent[];
  store: MemorySettingsStore;
}

function laneRig(
  script: StreamEvent[][],
  options: { config?: Record<string, unknown>; store?: MemorySettingsStore } = {},
): LaneRig {
  const provider = new Scripted([...script]);
  const router = new LlmRouter(
    new Map([["chat", provider]]),
    new Map([["game", [parseModelRef("chat:m")]]]),
  );
  const events: TaskEvent[] = [];
  const store = options.store ?? new MemorySettingsStore();
  const lane = new WorkLaneService({
    config: WorkConfigSchema.parse(options.config ?? {}),
    now: () => Date.now(),
    router: () => router,
    publish: ((_definition: unknown, data: unknown) => {
      events.push(data as TaskEvent);
    }) as Publish,
    store: () => store,
    profile: () => "p",
    log: getLogger("worklane-test"),
  });
  return { lane, provider, events, store };
}

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
    const messages = r.provider.requests.at(-1)?.messages ?? [];
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
    expect(r.events.map((e) => e.type)).toEqual(["started", "done"]);
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

describe("a restart", () => {
  it("a row a task of the old main line left ends as stopped, once", async () => {
    const store = new MemorySettingsStore();
    await store.set("p", `${TASK_PREFIX}t1`, { id: "t1", goal: "整理筆記", for: null });
    const first = laneRig([reply("x")], { store });
    expect(await first.lane.recover()).toBe(1);
    expect(first.events).toEqual([
      expect.objectContaining({ type: "failed", task: "t1", code: "cancelled" }),
    ]);
    expect((first.events[0] as { detail: string }).detail).toContain(RESTART_REASON);
    const second = laneRig([reply("x")], { store });
    expect(await second.lane.recover()).toBe(0);
    expect(second.events).toEqual([]);
  });
});
