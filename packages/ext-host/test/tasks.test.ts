// The host's task plumbing against the real SDK runtime, in memory: `ProxyExecutor` over a
// `Peer`, the SDK's `TaskRunner` on the other side. Also checks that the SDK's copy of the task
// contract has the same shapes as `@miyoria/types`.

import { PassThrough } from "node:stream";
import { sleep } from "@miyoria/kernel";
import {
  runExtension,
  TASK_FAILURE_CODES as SDK_CODES,
  taskTopic as sdkTaskTopic,
  type TaskContext,
  TaskRunner,
} from "@miyoria/sdk";
import {
  isTaskSpec,
  type JsonValue,
  parseTaskEvent,
  TASK_FAILURE_CODES,
  type TaskEvent,
  type TaskSpec,
  taskTopic,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  callFailureCode,
  Peer,
  ProxyExecutor,
  RpcError,
  TaskCallError,
  TaskExecutorRegistry,
  TIMEOUT,
} from "../src/index.js";

interface Wired {
  proxy: ProxyExecutor;
  published: TaskEvent[];
  runs: Map<string, TaskContext>;
  aborted: string[];
  close(): void;
}

const open: Wired[] = [];

afterEach(() => {
  for (const w of open.splice(0)) w.close();
});

/** An SDK extension with a TaskRunner, connected to a host-side ProxyExecutor. */
async function wire(graceMs = 50): Promise<Wired> {
  const runs = new Map<string, TaskContext>();
  const aborted: string[] = [];
  const runner = new TaskRunner({
    observe: async () => ({ state: { hp: 20 }, summary: "fine" }),
    resource: (s) => (s.goal === "chat" ? null : "body"),
    run: (spec, task) =>
      new Promise((resolve) => {
        runs.set(spec.id, task);
        task.signal.addEventListener("abort", () => aborted.push(spec.id));
        if (spec.goal === "quick") resolve({ detail: "quick done" });
        if (spec.goal === "ignore_abort") {
          // Ignores its signal and never resolves: the runner still ends it.
        }
      }),
  });
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  runExtension(
    {
      async activate(ctx) {
        await ctx.tasks.register(runner, {
          name: "Fake",
          goals: [{ name: "quick", description: "q" }],
        });
      },
    },
    { input: hostToExt, output: extToHost, timeoutMs: 1000 },
  );
  const peer = new Peer(hostToExt);
  const published: TaskEvent[] = [];
  let proxy: ProxyExecutor | null = null;
  const serving = peer.serve(extToHost, {
    request: async () => ({}),
    notification: (method, params) => {
      if (method === "task.event") proxy?.onEvent(params);
    },
  });
  serving.catch(() => undefined);
  const init = (await peer.request(
    "initialize",
    {
      protocol: 1,
      host: { name: "miyoria", version: "0" },
      extension: { id: "t", version: "0", dir: "/", game: null },
      config: {},
      permissions: { events: [], tools: false, commands: false, network: [], input: [] },
    },
    1000,
  )) as { contributions: { executor: { name: string } } };
  expect(init.contributions.executor.name).toBe("Fake");
  proxy = new ProxyExecutor(
    peer,
    { owner: "game.fake", name: "Fake", goals: [], guide: null },
    { callTimeoutMs: 500, graceMs, publish: (e) => published.push(e) },
  );
  const w: Wired = {
    proxy,
    published,
    runs,
    aborted,
    close: () => {
      runner.close();
      hostToExt.end();
      extToHost.end();
    },
  };
  open.push(w);
  return w;
}

const spec = (id: string, goal = "mine", budget_s = 30): TaskSpec => ({
  id,
  goal,
  args: {},
  budget_s,
});

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(5);
  }
}

describe("ProxyExecutor", () => {
  it("start → events published and streamed; observe is structured", async () => {
    const w = await wire();
    const stream = w.proxy.events()[Symbol.asyncIterator]();
    await w.proxy.start(spec("a", "quick"));
    await until(() => w.published.length === 2);
    expect(w.published.map((e) => [e.type, e.task])).toEqual([
      ["started", "a"],
      ["done", "a"],
    ]);
    expect((await stream.next()).value).toMatchObject({ type: "started", task: "a" });
    expect((await stream.next()).value).toMatchObject({ type: "done", detail: "quick done" });
    expect(await w.proxy.observe()).toMatchObject({
      state: { hp: 20 },
      summary: "fine",
      task: null,
    });
    expect(w.proxy.running).toEqual([]);
  });

  it("cancel reaches the extension's signal; superseding keeps one task per resource", async () => {
    const w = await wire();
    await w.proxy.start(spec("a"));
    await w.proxy.start(spec("c", "chat"));
    await w.proxy.start(spec("b"));
    await until(() => w.aborted.includes("a"));
    await w.proxy.cancel("b");
    await until(() => w.aborted.includes("b"));
    await until(() => w.published.filter((e) => e.type === "failed").length === 2);
    const failed = w.published.filter((e) => e.type === "failed");
    expect(failed).toMatchObject([
      { task: "a", code: "superseded" },
      { task: "b", code: "cancelled" },
    ]);
    expect(w.proxy.running).toEqual(["c"]);
  });

  it("aborting the caller's start cancels the task too", async () => {
    const w = await wire();
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    await expect(w.proxy.start(spec("a"), controller.signal)).rejects.toBeInstanceOf(TaskCallError);
    expect(w.proxy.running).toEqual([]);
  });

  it("the extension's budget wins; the host's watchdog backs it up", async () => {
    const w = await wire(50);
    await w.proxy.start(spec("a", "ignore_abort", 0.1));
    await until(() => w.published.some((e) => e.type === "failed"));
    expect(w.published.find((e) => e.type === "failed")).toMatchObject({
      task: "a",
      code: "timeout",
    });
  });

  it("a task the extension never ends fails at budget + grace, and is cancelled there", async () => {
    // A bare peer that accepts every start and never reports anything.
    const a = new PassThrough();
    const b = new PassThrough();
    const host = new Peer(a);
    const ext = new Peer(b);
    const calls: string[] = [];
    ext
      .serve(a, {
        request: async (method) => {
          calls.push(method);
          return {};
        },
        notification: () => undefined,
      })
      .catch(() => undefined);
    host
      .serve(b, { request: async () => ({}), notification: () => undefined })
      .catch(() => undefined);
    const published: TaskEvent[] = [];
    const proxy = new ProxyExecutor(
      host,
      { owner: "game.fake", name: "Fake", goals: [], guide: null },
      { callTimeoutMs: 500, graceMs: 30, publish: (e) => published.push(e) },
    );
    const started = Date.now();
    await proxy.start(spec("q", "mine", 0.05));
    await until(() => published.length === 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(published[0]).toMatchObject({ type: "failed", task: "q", code: "timeout" });
    await until(() => calls.includes("task.cancel"));
    expect(calls).toEqual(["task.start", "task.cancel"]);
    a.end();
    b.end();
  });

  it("close fails what runs and drops late words", async () => {
    const w = await wire();
    await w.proxy.start(spec("a"));
    await until(() => w.published.length === 1);
    w.proxy.close("crashed", "gone");
    expect(w.published.at(-1)).toMatchObject({ type: "failed", task: "a", code: "crashed" });
    w.proxy.onEvent({
      event: { type: "done", task: "a", detail: "", data: null, at: new Date().toISOString() },
    });
    expect(w.published.filter((e) => e.task === "a" && e.type === "done")).toEqual([]);
    await expect(w.proxy.start(spec("b"))).rejects.toMatchObject({ code: "disconnected" });
  });

  it("malformed events and specs are refused", async () => {
    const w = await wire();
    w.proxy.onEvent({ event: { type: "failed", task: "x", code: "nope", detail: "", at: "x" } });
    w.proxy.onEvent({ event: "junk" } as JsonValue);
    expect(w.published).toEqual([]);
    await expect(w.proxy.start({ ...spec("a"), budget_s: 0 })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("maps RPC failures onto codes", () => {
    expect(callFailureCode(new RpcError(TIMEOUT, "slow"))).toBe("timeout");
    expect(callFailureCode(new RpcError(-32603, "x", { code: "busy" }))).toBe("busy");
    expect(callFailureCode(new RpcError(-32603, "x"))).toBe("internal");
  });

  it("registry: one executor per owner", () => {
    const registry = new TaskExecutorRegistry();
    const a = { info: { owner: "game.x" } } as unknown as ProxyExecutor;
    const b = { info: { owner: "game.x" } } as unknown as ProxyExecutor;
    registry.register(a);
    expect(() => registry.register(b)).toThrow(/already registered/);
    registry.unregister(b);
    expect(registry.get("game.x")).toBe(a);
    registry.unregister(a);
    expect(registry.list()).toEqual([]);
  });
});

describe("the SDK's copy of the task contract", () => {
  it("has the same failure codes, topics and JSON shapes", async () => {
    expect([...SDK_CODES]).toEqual([...TASK_FAILURE_CODES]);
    expect(sdkTaskTopic("game.minecraft", "failed")).toBe(taskTopic("game.minecraft", "failed"));
    expect(isTaskSpec(spec("a"))).toBe(true);
    // Events produced by the SDK runner parse as core `TaskEvent`s unchanged.
    const events: unknown[] = [];
    const runner = new TaskRunner({
      observe: async () => ({ state: {}, summary: "" }),
      run: async (_s, t) => {
        t.progress("half", 0.5);
        return { detail: "ok", data: { n: 1 } };
      },
    });
    const pump = (async () => {
      for await (const e of runner.events()) events.push(JSON.parse(JSON.stringify(e)));
    })();
    await runner.start(spec("s"));
    await runner.start(spec("f", "x", 0.01));
    await sleep(30);
    runner.close();
    await pump;
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) expect(parseTaskEvent(e)).toEqual(e);
  });
});
