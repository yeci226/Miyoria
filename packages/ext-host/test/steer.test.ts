// Steer across the real RPC layer (docs/design/v3-architecture.md §10.6): `ProxyExecutor` over a
// `Peer`, a fake extension on the SDK runtime on the other side. The extension's executor says
// `applied`, `rejected` or `too_late`; one without `steer` must look like an executor with none.

import { PassThrough } from "node:stream";
import { sleep } from "@miyoria/kernel";
import {
  runExtension,
  type TaskEvent as SdkTaskEvent,
  type TaskSpec as SdkTaskSpec,
  type TaskSteer as SdkTaskSteer,
  type StructuredState,
  type TaskExecutor,
} from "@miyoria/sdk";
import type { JsonValue, TaskEvent, TaskSteer } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { Peer, ProxyExecutor, type RpcError, TaskCallError } from "../src/index.js";

const iso = () => new Date().toISOString();

/** An executor the test drives by hand: events go out through `emit`. */
class FakeExecutor implements TaskExecutor {
  readonly started: string[] = [];
  readonly steers: SdkTaskSteer[] = [];
  readonly #queue: SdkTaskEvent[] = [];
  #wake: (() => void) | null = null;
  steer?: (steer: SdkTaskSteer) => Promise<void>;

  async observe(): Promise<StructuredState> {
    return { at: iso(), state: {}, task: null, summary: "" };
  }
  async start(spec: SdkTaskSpec): Promise<void> {
    this.started.push(spec.id);
    this.emit({ type: "started", task: spec.id, goal: spec.goal, at: iso() });
  }
  async cancel(): Promise<void> {}
  emit(event: SdkTaskEvent): void {
    this.#queue.push(event);
    this.#wake?.();
  }
  events(): AsyncIterable<SdkTaskEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          for (;;) {
            const value = this.#queue.shift();
            if (value) return { value, done: false };
            await new Promise<void>((resolve) => {
              this.#wake = resolve;
            });
          }
        },
      }),
    };
  }
}

interface Wired {
  proxy: ProxyExecutor;
  ext: FakeExecutor;
  published: TaskEvent[];
}

const open: Array<() => void> = [];

afterEach(() => {
  for (const close of open.splice(0)) close();
});

const INIT = {
  protocol: 1,
  host: { name: "miyoria", version: "0" },
  extension: { id: "t", version: "0", dir: "/", game: null },
  config: {},
  permissions: { events: [], tools: false, commands: false, network: [], input: [] },
};

/** Starts a real SDK runtime that registers `ext`, and a host-side peer connected to it. */
async function connect(ext: TaskExecutor): Promise<{
  peer: Peer;
  declared: boolean;
  onEvent: (fn: (params: JsonValue) => void) => void;
}> {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  runExtension(
    {
      async activate(ctx) {
        await ctx.tasks.register(ext, {
          name: "Fake",
          goals: [{ name: "obtain", description: "o" }],
        });
      },
    },
    { input: hostToExt, output: extToHost, timeoutMs: 1000 },
  );
  open.push(() => {
    hostToExt.end();
    extToHost.end();
  });
  const peer = new Peer(hostToExt);
  let sink: (params: JsonValue) => void = () => undefined;
  peer
    .serve(extToHost, {
      request: async () => ({}),
      notification: (method, params) => {
        if (method === "task.event") sink(params);
      },
    })
    .catch(() => undefined);
  const init = (await peer.request("initialize", INIT, 1000)) as {
    contributions: { executor: { steer?: boolean } };
  };
  return {
    peer,
    declared: init.contributions.executor.steer === true,
    onEvent: (fn) => {
      sink = fn;
    },
  };
}

/** The proxy the host builds from the extension's declaration (a missing field: no steer). */
async function wire(ext: FakeExecutor, steerOverride?: boolean): Promise<Wired> {
  const { peer, declared, onEvent } = await connect(ext);
  const published: TaskEvent[] = [];
  const proxy = new ProxyExecutor(
    peer,
    { owner: "game.fake", name: "Fake", goals: [], guide: null },
    {
      callTimeoutMs: 500,
      graceMs: 50,
      steer: steerOverride ?? declared,
      publish: (e) => published.push(e),
    },
  );
  onEvent((params) => proxy.onEvent(params));
  return { proxy, ext, published };
}

const spec = (id: string) => ({ id, goal: "obtain", args: {}, budget_s: 30 });
const steerOf = (id: string, task: string): TaskSteer => ({
  id,
  task,
  patch: { item: "iron_pickaxe" },
  why: "改目標",
  cause: "evt-1",
});

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(5);
  }
}

const steered = (w: Wired) =>
  w.published.filter((e): e is Extract<TaskEvent, { type: "steered" }> => e.type === "steered");

describe("steer over the extension RPC", () => {
  it("applied: the call returns on accept and `steered` follows", async () => {
    const ext = new FakeExecutor();
    ext.steer = async (s) => {
      ext.steers.push(s);
      // The outcome comes later, at the next safe point.
      setTimeout(
        () =>
          ext.emit({
            type: "steered",
            task: s.task,
            steer: s.id,
            outcome: "applied",
            detail: "ok",
            at: iso(),
          }),
        20,
      );
    };
    const w = await wire(ext);
    await w.proxy.start(spec("t1"));
    expect(typeof w.proxy.steer).toBe("function");
    await w.proxy.steer?.(steerOf("s1", "t1"));
    expect(ext.steers).toEqual([steerOf("s1", "t1")]);
    expect(steered(w)).toEqual([]); // accepted is not applied
    await until(() => steered(w).length === 1);
    expect(steered(w)[0]).toMatchObject({
      task: "t1",
      steer: "s1",
      outcome: "applied",
      detail: "ok",
    });
    expect(w.proxy.running).toEqual(["t1"]); // steering is not an end
  });

  it("rejected: also for a task the proxy never saw", async () => {
    const ext = new FakeExecutor();
    ext.steer = async (s) => {
      ext.emit({
        type: "steered",
        task: s.task,
        steer: s.id,
        outcome: "rejected",
        detail: "沒有這個任務",
        at: iso(),
      });
    };
    const w = await wire(ext);
    await w.proxy.steer?.(steerOf("s2", "nope"));
    await until(() => steered(w).length === 1);
    expect(steered(w)[0]).toMatchObject({ task: "nope", steer: "s2", outcome: "rejected" });
  });

  it("too_late: reaches the core although the task already ended", async () => {
    const ext = new FakeExecutor();
    ext.steer = async (s) => {
      ext.emit({
        type: "steered",
        task: s.task,
        steer: s.id,
        outcome: "too_late",
        detail: "已結束",
        at: iso(),
      });
    };
    const w = await wire(ext);
    await w.proxy.start(spec("t3"));
    ext.emit({ type: "done", task: "t3", detail: "d", data: null, at: iso() });
    await until(() => w.proxy.running.length === 0);
    await w.proxy.steer?.(steerOf("s3", "t3"));
    await until(() => steered(w).length === 1);
    expect(steered(w)[0]).toMatchObject({ task: "t3", outcome: "too_late" });
    // Late words of the ended task are still dropped.
    ext.emit({ type: "progress", task: "t3", progress: 0.5, detail: "x", at: iso() });
    await sleep(30);
    expect(w.published.filter((e) => e.type === "progress")).toEqual([]);
  });

  it("an answer nobody asked for is dropped, and each steer is answered once", async () => {
    const ext = new FakeExecutor();
    ext.steer = async (s) => {
      ext.emit({
        type: "steered",
        task: s.task,
        steer: s.id,
        outcome: "applied",
        detail: "",
        at: iso(),
      });
      ext.emit({
        type: "steered",
        task: s.task,
        steer: s.id,
        outcome: "applied",
        detail: "again",
        at: iso(),
      });
    };
    const w = await wire(ext);
    await w.proxy.start(spec("t4"));
    ext.emit({
      type: "steered",
      task: "t4",
      steer: "unsolicited",
      outcome: "applied",
      detail: "",
      at: iso(),
    });
    await w.proxy.steer?.(steerOf("s4", "t4"));
    await sleep(60);
    expect(steered(w).map((e) => e.steer)).toEqual(["s4"]);
  });

  it("an extension that throws in steer is a refused call, not an outcome", async () => {
    const ext = new FakeExecutor();
    ext.steer = async () => {
      throw new Error("boom");
    };
    const w = await wire(ext);
    await w.proxy.start(spec("t5"));
    const error = await w.proxy.steer?.(steerOf("s5", "t5")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskCallError);
    expect((error as TaskCallError).code).toBe("internal");
    await sleep(30);
    expect(steered(w)).toEqual([]);
  });

  it("an extension without steer looks like an executor with none", async () => {
    const w = await wire(new FakeExecutor()); // no `steer`
    expect(w.proxy.steer).toBeUndefined();
    expect("steer" in w.proxy && typeof w.proxy.steer === "function").toBe(false);
    await w.proxy.start(spec("t6")); // the rest works as before
    expect(w.proxy.running).toEqual(["t6"]);
  });

  it("an older extension that declares nothing gets no steer either", async () => {
    const ext = new FakeExecutor();
    ext.steer = async () => undefined;
    // The host reads a missing `steer` as false.
    const w = await wire(ext, false);
    expect(w.proxy.steer).toBeUndefined();
  });

  it("the extension side refuses a steer it cannot take", async () => {
    const { peer } = await connect(new FakeExecutor());
    const error = (await peer
      .request("task.steer", { steer: steerOf("s", "t") as unknown as JsonValue }, 500)
      .catch((e: unknown) => e)) as RpcError;
    expect(error.code).toBe(-32601); // MethodNotFound
    const bad = (await peer.request("task.steer", {}, 500).catch((e: unknown) => e)) as RpcError;
    expect(bad.code).toBe(-32602); // InvalidParams
  });
});
