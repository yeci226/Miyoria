import { describe, expect, it } from "vitest";
import type { GameAdapter, GameEvent } from "../src/game.js";
import { TaskRunner } from "../src/task.js";
import { ErrorCode, type InitializeParams } from "../src/types.js";
import { fakeHost, initParams, waitFor } from "./helpers.js";

function adapter(events: GameEvent[]): GameAdapter & { acted: unknown[] } {
  const acted: unknown[] = [];
  return {
    acted,
    describe: () => ({
      id: "mc",
      name: "Minecraft",
      actions: [
        { name: "goto", description: "走到某處", parameters: { type: "object" } },
        { name: "chat", description: "說話" },
      ],
      prompt: "你正在玩 Minecraft。",
    }),
    observe: async () => ({ state: { hp: 20 }, summary: "白天,血量全滿" }),
    act: async (action: { name: string; args?: Record<string, unknown> }) => {
      acted.push(action);
      return { ok: true, message: `did ${action.name}` };
    },
    async *events() {
      for (const e of events) yield e;
    },
  };
}

describe("game adapter helper", () => {
  it("maps an adapter onto a task executor, a prompt and events", async () => {
    const game = adapter([
      { type: "death", data: { cause: "creeper" }, important: true },
      { type: "Bad Type" },
      { type: "task.done", data: {} },
      { type: "player.joined", data: { name: "Owen" } },
    ]);
    const h = fakeHost({
      async activate(ctx) {
        const reg = await ctx.game.registerAdapter(game);
        expect(reg.info.id).toBe("mc");
      },
    });
    const result = await h.initialize(gameInit("mc"));
    // No raw observe / act tools: the executor is the only way in.
    expect(result.contributions.tools).toEqual([]);
    expect(result.contributions.executor).toEqual({
      name: "Minecraft",
      goals: [
        { name: "goto", description: "走到某處", parameters: { type: "object" }, budget_s: null },
        { name: "chat", description: "說話", parameters: null, budget_s: null },
      ],
      guide: null,
    });
    expect(result.contributions.prompts).toEqual(["game.mc"]);

    const observed = await h.host.request<Record<string, unknown>>("task.observe", {});
    expect(observed).toMatchObject({ state: { hp: 20 }, summary: "白天,血量全滿", task: null });
    expect(typeof observed.at).toBe("string");

    // `act` wrapped as one-step tasks: done when it returns ok.
    await h.host.request("task.start", { task: { id: "t1", goal: "goto", args: { x: 1 }, budget_s: 30 } });
    await waitFor(() => h.notifications.filter((n) => n.method === "task.event").length >= 2);
    expect(game.acted).toEqual([{ name: "goto", args: { x: 1 } }]);
    const events = () =>
      h.notifications.filter((n) => n.method === "task.event").map((n) => (n.params as { event: { type: string; task: string } }).event);
    expect(events().map((e) => [e.type, e.task])).toEqual([
      ["started", "t1"],
      ["done", "t1"],
    ]);
    // An unknown goal is accepted and fails with `invalid`.
    await h.host.request("task.start", { task: { id: "t2", goal: "fly", args: {}, budget_s: 30 } });
    await waitFor(() => events().length >= 4);
    expect(events()[3]).toMatchObject({ type: "failed", task: "t2", code: "invalid" });
    // A malformed spec is refused with the code in `data`.
    await expect(h.host.request("task.start", { task: { id: "t3", goal: "goto", args: {}, budget_s: -1 } })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { code: "invalid" },
    });

    const prompt = await h.host.request("prompt.contribute", { key: "game.mc", request: {} });
    expect(prompt).toEqual({
      sections: [{ key: "game.mc", title: "Minecraft", body: "你正在玩 Minecraft。", order: 50 }],
    });

    await waitFor(() => h.requests.filter((r) => r.method === "events.publish").length === 2);
    const published = h.requests.filter((r) => r.method === "events.publish").map((r) => r.params);
    expect(published).toEqual([
      { topic: "game.mc.death", payload: { type: "death", data: { cause: "creeper" }, important: true } },
      { topic: "game.mc.player.joined", payload: { type: "player.joined", data: { name: "Owen" } } },
    ]);
    expect(h.notifications.some((n) => n.method === "log")).toBe(true);
  });

  it("a failed act carries its code; the adapter's own executor wins", async () => {
    const game = adapter([]);
    game.act = async () => ({ ok: false, message: "看不到", code: "not_found" });
    const h = fakeHost({
      async activate(ctx) {
        await ctx.game.registerAdapter(game);
      },
    });
    await h.initialize(gameInit("mc"));
    await h.host.request("task.start", { task: { id: "t1", goal: "goto", args: {}, budget_s: 30 } });
    await waitFor(() => h.notifications.filter((n) => n.method === "task.event").length >= 2);
    const last = h.notifications.filter((n) => n.method === "task.event").at(-1)?.params as { event: unknown };
    expect(last.event).toMatchObject({ type: "failed", task: "t1", code: "not_found", detail: "看不到" });

    const own = new TaskRunner({
      observe: async () => ({ state: { own: true }, summary: "own" }),
      run: async () => ({ detail: "ok" }),
    });
    const withOwn = Object.assign(adapter([]), { tasks: own });
    const h2 = fakeHost({
      async activate(ctx) {
        const reg = await ctx.game.registerAdapter(withOwn);
        expect(reg.executor).toBe(own);
      },
    });
    await h2.initialize(gameInit("mc"));
    expect(await h2.host.request("task.observe", {})).toMatchObject({ state: { own: true } });
  });

  it("rejects invalid game ids", async () => {
    const bad = adapter([]);
    bad.describe = () => ({ id: "Not Valid", name: "x", actions: [] });
    const h = fakeHost({
      async activate(ctx) {
        await ctx.game.registerAdapter(bad);
      },
    });
    await expect(h.initialize(gameInit("Not Valid"))).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it("requires the manifest to declare the same game", async () => {
    let seen: string | undefined = "unset";
    const register = (game: GameAdapter) =>
      fakeHost({
        async activate(ctx) {
          seen = ctx.game.id;
          await ctx.game.registerAdapter(game);
        },
      });
    const undeclared = register(adapter([]));
    await expect(undeclared.initialize()).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('game = "mc"'),
    });
    expect(seen).toBeUndefined();

    const other = register(adapter([]));
    await expect(other.initialize(gameInit("terraria"))).rejects.toMatchObject({
      message: expect.stringContaining('manifest game "terraria"'),
    });
    expect(seen).toBe("terraria");
  });
});

function gameInit(game: string): Partial<InitializeParams> {
  const base = initParams();
  return { extension: { ...base.extension, game } };
}
