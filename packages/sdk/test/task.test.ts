import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_FAILURE_CODES,
  type TaskContext,
  type TaskEvent,
  TaskFailure,
  TaskRunner,
  type TaskSpec,
  type TaskWorker,
  taskTopic,
} from "../src/task.js";
import { fakeHost, initParams, waitFor } from "./helpers.js";

const spec = (id: string, goal = "mine", budget_s = 60): TaskSpec => ({ id, goal, args: {}, budget_s });

/** A worker whose tasks wait until the test ends them (or their signal aborts). */
function worker() {
  const runs = new Map<string, { ctx: TaskContext; resolve: (detail: string) => void; reject: (e: unknown) => void }>();
  const aborted: string[] = [];
  const w: TaskWorker = {
    observe: async () => ({ state: { hp: 20 }, summary: "ok" }),
    resource: (s) => (s.goal === "chat" ? null : "body"),
    run: (s, ctx) =>
      new Promise((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => aborted.push(s.id));
        runs.set(s.id, { ctx, resolve: (detail) => resolve({ detail, data: { n: 1 } }), reject });
      }),
  };
  return { w, runs, aborted };
}

async function collect(runner: TaskRunner, out: TaskEvent[]): Promise<void> {
  for await (const e of runner.events()) out.push(e);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TaskRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("started, progress, then exactly one done", async () => {
    const { w, runs } = worker();
    const runner = new TaskRunner(w, { now: () => 0 });
    const events: TaskEvent[] = [];
    void collect(runner, events);
    await runner.start(spec("a"));
    expect((await runner.observe()).task).toBe("a");
    runs.get("a")?.ctx.progress("走到 (1, 2, 3)", 0.5);
    runs.get("a")?.resolve("挖到了");
    runs.get("a")?.resolve("again");
    await flush();
    await runner.cancel("a"); // finished: ignored
    await flush();
    expect(events).toEqual([
      { type: "started", task: "a", goal: "mine", at: "1970-01-01T00:00:00.000Z" },
      { type: "progress", task: "a", progress: 0.5, detail: "走到 (1, 2, 3)", at: "1970-01-01T00:00:00.000Z" },
      { type: "done", task: "a", detail: "挖到了", data: { n: 1 }, at: "1970-01-01T00:00:00.000Z" },
    ]);
    expect((await runner.observe()).task).toBeNull();
    runner.close();
  });

  it("failures carry the thrown code; other errors are internal", async () => {
    const { w, runs } = worker();
    const runner = new TaskRunner(w);
    const events: TaskEvent[] = [];
    void collect(runner, events);
    await runner.start(spec("a"));
    runs.get("a")?.reject(new TaskFailure("not_found", "看不到鐵礦"));
    await runner.start(spec("b", "chat"));
    runs.get("b")?.reject(new Error("boom"));
    await flush();
    const failed = events.filter((e) => e.type === "failed");
    expect(failed).toMatchObject([
      { task: "a", code: "not_found", detail: "看不到鐵礦" },
      { task: "b", code: "internal", detail: "boom" },
    ]);
    runner.close();
  });

  it("cancel aborts the signal and ends it at once; a late result is ignored", async () => {
    const { w, runs, aborted } = worker();
    const runner = new TaskRunner(w);
    const events: TaskEvent[] = [];
    void collect(runner, events);
    await runner.start(spec("a"));
    await runner.cancel("a");
    expect(aborted).toEqual(["a"]);
    runs.get("a")?.resolve("too late");
    await flush();
    expect(events.map((e) => e.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ code: "cancelled" });
    runner.close();
  });

  it("a new task on the same resource supersedes the running one; resource null runs alongside", async () => {
    const { w, aborted } = worker();
    const runner = new TaskRunner(w);
    const events: TaskEvent[] = [];
    void collect(runner, events);
    await runner.start(spec("a"));
    await runner.start(spec("chat1", "chat"));
    await runner.start(spec("b", "goto"));
    await flush();
    expect(aborted).toEqual(["a"]);
    expect(events.find((e) => e.type === "failed")).toMatchObject({ task: "a", code: "superseded" });
    expect(runner.running.sort()).toEqual(["b", "chat1"]);
    runner.close();
  });

  it("the budget ends it with timeout", async () => {
    vi.useFakeTimers();
    const { w, aborted } = worker();
    const runner = new TaskRunner(w);
    const events: TaskEvent[] = [];
    void collect(runner, events);
    await runner.start(spec("a", "mine", 2));
    await vi.advanceTimersByTimeAsync(1999);
    expect(aborted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toEqual(["a"]);
    expect(events.at(-1)).toMatchObject({ type: "failed", task: "a", code: "timeout" });
    runner.close();
  });

  it("refuses malformed specs, ignores a repeated start, close fails what runs", async () => {
    const { w } = worker();
    const runner = new TaskRunner(w);
    const events: TaskEvent[] = [];
    const done = collect(runner, events);
    await expect(runner.start({ ...spec("x"), budget_s: 0 })).rejects.toMatchObject({ code: "invalid" });
    await expect(runner.start({ ...spec("x"), goal: "" })).rejects.toMatchObject({ code: "invalid" });
    await runner.start(spec("a"));
    await runner.start(spec("a"));
    runner.close();
    await done;
    expect(events.map((e) => e.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ code: "disconnected" });
    await expect(runner.start(spec("b"))).rejects.toMatchObject({ code: "disconnected" });
  });

  it("keeps the failure codes and topic shape of the core contract", () => {
    expect(TASK_FAILURE_CODES).toContain("superseded");
    expect(taskTopic("game.minecraft", "done")).toBe("game.minecraft.task.done");
  });
});

describe("ctx.tasks over the protocol", () => {
  it("start / cancel / observe from the host, events as task.event notifications", async () => {
    const { w, runs } = worker();
    const runner = new TaskRunner(w);
    const h = fakeHost({
      async activate(ctx) {
        await ctx.tasks.register(runner, {
          name: "Thing",
          goals: [{ name: "mine", description: "挖", budget_s: 120 }],
          guide: "  慢慢來  ",
        });
      },
    });
    const result = await h.initialize(initParams());
    expect(result.contributions.executor).toEqual({
      name: "Thing",
      goals: [{ name: "mine", description: "挖", parameters: null, budget_s: 120 }],
      guide: "慢慢來",
    });
    await h.host.request("task.start", { task: spec("a") });
    await h.host.request("task.cancel", { task: "a" });
    await waitFor(() => h.notifications.filter((n) => n.method === "task.event").length === 2);
    const events = h.notifications.filter((n) => n.method === "task.event").map((n) => (n.params as { event: TaskEvent }).event);
    expect(events.map((e) => [e.type, e.task])).toEqual([
      ["started", "a"],
      ["failed", "a"],
    ]);
    expect(runs.has("a")).toBe(true);
    expect(await h.host.request("task.observe", {})).toMatchObject({ state: { hp: 20 }, task: null, summary: "ok" });
  });

  it("an extension without an executor answers method-not-found", async () => {
    const h = fakeHost({ activate() {} });
    const result = await h.initialize(initParams());
    expect(result.contributions.executor).toBeUndefined();
    await expect(h.host.request("task.observe", {})).rejects.toMatchObject({ code: -32601 });
  });
});
