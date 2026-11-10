// §11.2 of docs/design/v4-plan.md, each cause of 2026-11-08 against the director: `stop` is no
// goal and no success, a `done` without progress is a failed attempt, a goal has a success
// condition and survives a failure, the same method failing the same way twice is held (by
// item), enemies and reflexes do not wake her, night and death start survival goals, and what
// she managed becomes a skill.

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
import type { ContextKey, Event, JsonObject, JsonValue } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_TOPIC,
  GameControlKey,
  GameHandleKey,
  GameModule,
  type GameStatus,
  GOAL_TOPIC,
} from "../src/index.js";
import { SKILL_TOPIC } from "../src/skills.js";
import { FakeExecutor, FakeExecutors, MINECRAFT_GOALS } from "./fake-executor.js";

const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };

/** Replies from a script (the last one repeats); records every request. */
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

  /** The user message of the last request. */
  lastPrompt(): string {
    return contentText(this.requests.at(-1)?.messages.at(-1)?.content ?? "");
  }
}

function decide(goal: string, action: JsonValue, want: JsonValue = null): string {
  return JSON.stringify({ goal, goal_status: "working", want, action, commentary: null });
}

function outcome(progressed: boolean, inventory: JsonObject | null = null, note = ""): JsonValue {
  return { outcome: { progressed, gained: {}, lost: {}, inventory, note } };
}

async function secs(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * 1000);
  await vi.advanceTimersByTimeAsync(5);
}

class H {
  readonly sup = new Supervisor();
  readonly exec: FakeExecutor;
  readonly payloads: { topic: string; payload: JsonValue }[] = [];

  private constructor(readonly llm: Script) {
    this.exec = new FakeExecutor(
      (e) => this.sup.bus.publish("ext.miyoria.minecraft", e),
      Date.now,
      {
        goals: [
          ...MINECRAFT_GOALS,
          { name: "hunt", description: "打獵", parameters: null, budget_s: 120 },
          { name: "shelter", description: "躲起來過夜", parameters: null, budget_s: 540 },
          { name: "recover", description: "回去撿東西", parameters: null, budget_s: 120 },
        ],
      },
    );
    const sub = this.sup.bus.subscribe("*");
    void (async () => {
      for await (const env of sub as AsyncIterable<{ event: Event }>) {
        const e = env.event;
        if (e.type === "custom")
          this.payloads.push({ topic: e.data.topic, payload: e.data.payload });
      }
    })();
  }

  static async create(replies: string[], config: JsonValue = null): Promise<H> {
    const h = new H(new Script(replies));
    const router = new LlmRouter(
      new Map([[h.llm.name, h.llm]]),
      new Map([["game", [parseModelRef(`${h.llm.name}:m`)]]]),
    );
    new FakeExecutors(h.exec).provide(h.sup.services);
    h.sup.services.provide("app", LlmRouterKey, router);
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

  async event(
    kind: string,
    text: string,
    important = false,
    extra: JsonObject = {},
  ): Promise<void> {
    this.sup.bus.publish("test", {
      type: "custom",
      data: {
        topic: `game.minecraft.${kind}`,
        payload: { type: kind, data: { text, ...extra }, important },
      },
    });
    await vi.advanceTimersByTimeAsync(5);
  }

  status(): GameStatus | null {
    return this.sup.services.require(GameHandleKey).status();
  }

  names(): string[] {
    return this.exec.names();
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

describe("stop is no goal and no success", () => {
  it("runs as an instant step: the goal stays, nothing is reached, no hold is cleared", async () => {
    const h = await H.create([
      decide("拿木鎬", { name: "obtain", args: { item: "wooden_pickaxe" } }),
      decide("拿木鎬", { name: "stop", args: {} }),
    ]);
    await h.start();
    expect(h.names()).toEqual(["obtain"]);
    await secs(20);
    // `stop` ran (the fake ends it `done` at once) ...
    expect(h.names()).toEqual(["obtain", "stop"]);
    // ... but it did not become the goal, and no goal ended as reached.
    expect(h.status()?.goal?.text).toBe("拿木鎬");
    expect(h.of(GOAL_TOPIC)).toEqual([]);
    expect(h.status()?.last_action).toContain("stop → 好");
    await h.stop();
  });
});

describe("a done without progress", () => {
  it("an explore that only ran out its time is a failed attempt, not a reached goal", async () => {
    const h = await H.create([decide("找樹", { name: "explore", args: {} })], {
      method_repeat_limit: 0,
    });
    await h.start();
    h.exec.done("探索了 118 秒", h.exec.last().id, outcome(false, null, "沒看到新的東西"));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.of(GOAL_TOPIC)).toEqual([]);
    expect(h.status()?.goal?.text).toBe("找樹");
    expect(h.status()?.last_action).toContain("沒有進展");
    // The record shows it as no progress.
    await secs(4);
    expect(h.llm.lastPrompt()).toContain("explore → 做完了但沒有進展");
    // Attempts run out (3 by default): the goal fails with `no_progress`.
    h.exec.done("探索了 118 秒", h.exec.last().id, outcome(false));
    await secs(4);
    h.exec.done("探索了 118 秒", h.exec.last().id, outcome(false));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.of(GOAL_TOPIC)).toEqual([
      expect.objectContaining({ goal: "找樹", status: "failed", code: "no_progress" }),
    ]);
    await h.stop();
  });

  it("an empty mine is not progress either, and doing it again the same way is held", async () => {
    const h = await H.create([decide("砍樹", { name: "mine", args: { block: "oak_log" } })], {
      failure_guard_secs: 0,
    });
    await h.start();
    h.exec.done("看得到的都挖完了", h.exec.last().id, outcome(false, { dirt: 1 }, "沒挖到東西"));
    await secs(4);
    expect(h.names()).toEqual(["mine", "mine"]);
    h.exec.done("看得到的都挖完了", h.exec.last().id, outcome(false, { dirt: 1 }, "沒挖到東西"));
    await secs(4);
    // The same method ended the same way twice: the third `mine oak_log` is not started.
    expect(h.names()).toEqual(["mine", "mine"]);
    expect(h.of(DECISION_TOPIC).at(-1)?.verdict).toBe(
      'Keep("held: mine:oak_log failed the same way again (no_progress)")',
    );
    expect(h.llm.lastPrompt()).toContain("暫停的做法");
    await h.stop();
  });

  it("asking for what she already has meets the goal but is no progress for the method", async () => {
    const h = await H.create([
      decide("拿木劍", { name: "obtain", args: { item: "wooden_sword" } }),
      decide("拿木劍", { name: "obtain", args: { item: "wooden_sword" } }),
      decide("再拿木劍", { name: "obtain", args: { item: "wooden_sword" } }),
    ]);
    h.exec.autoEnd = (spec) =>
      spec.goal === "obtain"
        ? { type: "done", detail: "背包裡已經有木劍了", data: outcome(false, { wooden_sword: 1 }) }
        : null;
    await h.start();
    expect(h.of(GOAL_TOPIC)).toEqual([expect.objectContaining({ goal: "拿木劍", code: "done" })]);
    await secs(4);
    // The second time the same method did nothing: held, not asked a third time.
    await secs(4);
    expect(h.names()).toEqual(["obtain", "obtain"]);
    expect(h.of(DECISION_TOPIC).at(-1)?.verdict).toBe(
      'Keep("held: obtain:wooden_sword failed the same way again (no_progress)")',
    );
    await h.stop();
  });

  it("an executor without outcomes keeps the old meaning: done is progress", async () => {
    const h = await H.create([decide("砍樹", { name: "mine", args: { block: "oak_log" } })]);
    await h.start();
    h.exec.done("挖到了");
    await vi.advanceTimersByTimeAsync(5);
    expect(h.of(GOAL_TOPIC)).toEqual([expect.objectContaining({ code: "done" })]);
    await h.stop();
  });
});

describe("a goal has a success condition", () => {
  it("is reached when the inventory shows it, not when a step says done", async () => {
    const h = await H.create([
      decide(
        "弄吃的",
        { name: "hunt", args: { entity: "cow" } },
        { item: "cooked_beef", count: 2 },
      ),
    ]);
    await h.start();
    // A step with progress, but the inventory does not hold the want yet: the goal stays.
    h.exec.done("打到一隻牛", h.exec.last().id, outcome(true, { beef: 1 }, "+生牛肉×1"));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.status()?.goal?.text).toBe("弄吃的");
    expect(h.of(GOAL_TOPIC)).toEqual([]);
    await secs(4);
    expect(h.llm.lastPrompt()).toContain("要:cooked_beef×2");
    // The game shows it: reached at the next look, whoever got it there.
    h.exec.state = { connected: true, in_game: true, inventory: { cooked_beef: 2 } };
    await secs(20);
    expect(h.of(GOAL_TOPIC)).toEqual([
      expect.objectContaining({ goal: "弄吃的", status: "done", code: "done" }),
    ]);
    await h.stop();
  });

  it("her word is not enough while the inventory says otherwise", async () => {
    const h = await H.create([
      decide("弄吃的", { name: "hunt", args: { entity: "cow" } }, { item: "cooked_beef" }),
      JSON.stringify({ goal: "弄吃的", goal_status: "done", action: null }),
    ]);
    h.exec.state = { connected: true, in_game: true, inventory: { dirt: 3 } };
    await h.start();
    h.exec.done("打到一隻牛", h.exec.last().id, outcome(true, { beef: 1 }));
    await secs(4);
    expect(h.of(GOAL_TOPIC)).toEqual([]);
    expect(h.status()?.recent).toContain("目標還沒達成:背包裡還沒有 cooked_beef");
    await h.stop();
  });

  it("survives a failure; a goal that runs out is not proposed again right away", async () => {
    const bread = decide("做麵包", { name: "obtain", args: { item: "bread" } });
    const h = await H.create([bread], { method_repeat_limit: 0, max_attempts: 2 });
    await h.start();
    h.exec.fail("precondition", "材料不夠:還缺 小麥×3");
    await vi.advanceTimersByTimeAsync(5);
    expect(h.status()?.goal?.text).toBe("做麵包");
    await secs(4);
    expect(h.names()).toEqual(["obtain", "obtain"]);
    h.exec.fail("precondition", "材料不夠:還缺 小麥×3");
    await vi.advanceTimersByTimeAsync(5);
    expect(h.of(GOAL_TOPIC)).toEqual([
      expect.objectContaining({ goal: "做麵包", status: "failed", code: "precondition" }),
    ]);
    // Four seconds later she asks for bread again: held as a goal.
    await secs(4);
    expect(h.names()).toEqual(["obtain", "obtain"]);
    expect(h.status()?.last_action).toContain("暫時不行:這個目標一直失敗");
    expect(h.llm.lastPrompt()).toContain("目標「bread」");
    await h.stop();
  });

  it("has a step budget", async () => {
    const h = await H.create(
      [
        decide(
          "弄吃的",
          { name: "hunt", args: { entity: "cow" } },
          { item: "cooked_beef", count: 5 },
        ),
      ],
      { max_goal_steps: 2 },
    );
    await h.start();
    h.exec.done("打到一隻牛", h.exec.last().id, outcome(true, { beef: 1 }));
    await secs(4);
    h.exec.done("打到一隻牛", h.exec.last().id, outcome(true, { beef: 2 }));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.of(GOAL_TOPIC)).toEqual([
      expect.objectContaining({ goal: "弄吃的", status: "failed", code: "timeout" }),
    ]);
    await h.stop();
  });
});

describe("the method guard is keyed by item", () => {
  it("holds obtain bread after the same code twice, but not obtain cooked_beef", async () => {
    const h = await H.create([
      decide("做麵包", { name: "obtain", args: { item: "bread" } }),
      decide("做麵包", { name: "obtain", args: { item: "bread" } }),
      decide("做麵包", { name: "obtain", args: { item: "Bread" } }),
      decide("烤牛肉", { name: "obtain", args: { item: "cooked_beef" } }),
    ]);
    h.exec.autoEnd = (spec) =>
      spec.args.item === "bread"
        ? { type: "failed", code: "precondition", detail: "還缺 小麥×3" }
        : null;
    await h.start();
    await secs(4);
    expect(h.names()).toEqual(["obtain", "obtain"]);
    // Third time, in other words: held, and asked once more.
    await secs(4);
    expect(h.names()).toEqual(["obtain", "obtain"]);
    expect(h.of(DECISION_TOPIC).at(-1)?.verdict).toBe(
      'Keep("held: obtain:bread failed the same way again (precondition)")',
    );
    // Another method (another item) goes through.
    await secs(4);
    expect(h.exec.last().args).toEqual({ item: "cooked_beef" });
    // A success of another method does not clear the bread hold.
    h.exec.done("拿到了", h.exec.last().id, outcome(true, { cooked_beef: 1 }));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.llm.requests.length).toBeGreaterThan(0);
    expect(h.of(DECISION_TOPIC).at(-1)?.held).toEqual([
      expect.stringContaining("obtain:bread(等缺的東西拿到了再試):precondition"),
    ]);
    await h.stop();
  });
});

describe("enemies and reflexes do not wake her", () => {
  it("hostile_near and reflex_end are noted, not decided on", async () => {
    const h = await H.create([decide("挖礦", { name: "mine", args: { block: "stone" } })]);
    await h.start();
    const asked = h.llm.requests.length;
    await secs(1);
    await h.event("hostile_near", "附近出現 殭屍");
    await h.event("reflex_end", "打完了,可以繼續了");
    await secs(5);
    expect(h.llm.requests.length).toBe(asked);
    // They are still in what she knows at the next regular decision.
    await secs(20);
    expect(h.llm.lastPrompt()).toContain("附近出現 殭屍");
    await h.stop();
  });

  it("the decision asks for low reasoning", async () => {
    const h = await H.create([decide("挖礦", null)]);
    await h.start();
    expect(h.llm.requests[0]?.reasoning).toBe("low");
    await h.stop();
  });
});

describe("night and death", () => {
  it("night starts a shelter without asking, and her goal comes back in the morning", async () => {
    const h = await H.create([
      decide("拿石鎬", { name: "obtain", args: { item: "stone_pickaxe" } }),
      decide("拿石鎬", { name: "mine", args: { block: "stone" } }),
    ]);
    await h.start();
    const pickaxe = h.exec.last();
    const asked = h.llm.requests.length;
    await secs(2);
    await h.event("night_started", "天黑了");
    await secs(1);
    expect(h.names()).toEqual(["obtain", "shelter"]);
    expect(h.exec.cancels).toContain(pickaxe.id);
    expect(h.llm.requests.length).toBe(asked);
    expect(h.status()?.goal).toMatchObject({ text: "天黑了,先躲起來過夜", note: "(求生)" });
    // While it runs, she cannot replace it.
    await secs(60);
    expect(h.names()).toEqual(["obtain", "shelter"]);
    // Morning: the shelter ends and the interrupted goal is back.
    h.exec.done("天亮了", h.exec.last().id, outcome(true));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.status()?.goal?.text).toBe("拿石鎬");
    expect(h.of(DECISION_TOPIC).some((t) => (t.trigger as string[])[0] === "求生")).toBe(true);
    await h.stop();
  });

  it("after a death she goes back for her things, then to what she was asked to do", async () => {
    const h = await H.create([decide("挖鐵礦", { name: "mine", args: { block: "iron_ore" } })]);
    await h.start();
    await h.sup.services.require(GameControlKey).goal("挖鐵礦", "Owen");
    await secs(4);
    await h.event("death", "死掉了(殭屍)", true);
    // Respawn first: nothing for a few seconds.
    await secs(3);
    expect(h.names().filter((n) => n === "recover")).toEqual([]);
    await secs(3);
    expect(h.names().at(-1)).toBe("recover");
    expect(h.status()?.goal?.note).toBe("(求生)");
    h.exec.done("撿回來了", h.exec.last().id, outcome(true, null, "+鐵鎬×1"));
    await vi.advanceTimersByTimeAsync(5);
    expect(h.status()?.goal?.text).toBe("挖鐵礦");
    expect(h.status()?.goal?.note).toContain("Owen");
    await h.stop();
  });

  it("an adapter without these goals gets no survival goal", async () => {
    const h = await H.create([decide("挖礦", null)], { night_action: "camp" });
    await h.start();
    await h.event("night_started", "天黑了");
    await secs(5);
    expect(h.names()).toEqual([]);
    await h.stop();
  });
});

describe("skills", () => {
  it("a reached goal keeps the methods that made progress and shows them next time", async () => {
    const h = await H.create([
      decide("弄吃的", { name: "hunt", args: { entity: "cow" } }, { item: "cooked_beef" }),
      decide("弄吃的", { name: "obtain", args: { item: "cooked_beef" } }),
      decide("再弄吃的", null, { item: "cooked_beef", count: 3 }),
    ]);
    await h.start();
    h.exec.done("打到一隻牛", h.exec.last().id, outcome(true, { beef: 1 }));
    await secs(4);
    h.exec.done("烤好了", h.exec.last().id, outcome(true, { cooked_beef: 1 }));
    await vi.advanceTimersByTimeAsync(5);
    const skills = h.of(SKILL_TOPIC);
    expect(skills).toEqual([
      expect.objectContaining({
        target: "cooked_beef",
        steps: ['hunt {"entity":"cow"}', 'obtain {"item":"cooked_beef"}'],
      }),
    ]);
    // With no goal, the next decision sees what she has managed.
    await secs(4);
    expect(h.llm.lastPrompt()).toContain("做成功過的做法");
    expect(h.llm.lastPrompt()).toContain('cooked_beef:hunt {"entity":"cow"} → obtain');
    await h.stop();
  });
});
