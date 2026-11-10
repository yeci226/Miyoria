// Steer of an obtain plan (docs/design/v3-architecture.md §10.6): the target changes between two
// steps, never in the middle of a job, and what the plan already got is kept.

import type { GameEvent, TaskSpec, TaskWorker } from "@miyoria/sdk";
import { describe, expect, it } from "vitest";
import { BridgeError, type BridgeEvent } from "../src/bridge.js";
import { ObtainRunner, parsePlanPatch, type RunnerHost } from "../src/obtain.js";
import { type SteerHandler, SteerableTasks } from "../src/steer.js";
import type { Snapshot } from "../src/summary.js";

const RECIPES: Record<string, { needs: Record<string, number>; out: number }> = {
  oak_planks: { needs: { oak_log: 1 }, out: 4 },
  stick: { needs: { oak_planks: 2 }, out: 4 },
};

class World implements RunnerHost {
  inv: Record<string, number> = {};
  readonly requests: Array<{ type: string; params: Record<string, unknown> }> = [];
  readonly emitted: GameEvent[] = [];
  readonly steers: Array<{ steer: string; outcome: string; detail: string }> = [];
  runner!: ObtainRunner;
  /** Called on every `mine` before it ends. */
  onMine: () => void = () => undefined;

  #later(name: string, data: Record<string, unknown> = {}): void {
    setTimeout(() => this.runner.feed({ name, data } satisfies BridgeEvent), 1);
  }

  async request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ type, params });
    if (type === "baritone" && params.command === "mine") {
      this.onMine();
      this.inv.oak_log = Math.max(this.inv.oak_log ?? 0, params.count as number);
      this.#later("baritone_idle", { process: "Mine" });
      return {};
    }
    if (type === "craft") {
      const item = params.item as string;
      const r = RECIPES[item];
      if (!r) throw new BridgeError("invalid_args", "no recipe");
      const times = Math.ceil((params.count as number) / r.out);
      for (const [need, n] of Object.entries(r.needs)) {
        if ((this.inv[need] ?? 0) < n * times) throw new BridgeError("missing_items", `missing ${need}`);
      }
      for (const [need, n] of Object.entries(r.needs)) this.inv[need] = (this.inv[need] ?? 0) - n * times;
      this.inv[item] = (this.inv[item] ?? 0) + r.out * times;
      this.#later("craft_finished", { item, crafted: r.out * times, requested: params.count });
      return {};
    }
    return {};
  }

  async observe(): Promise<Snapshot> {
    return {
      inventory: Object.fromEntries(Object.entries(this.inv).filter(([, n]) => n > 0)),
      nearby_blocks: [{ block: "oak_log", count: 1, distance: 3 }],
    };
  }

  steered(steer: string, outcome: "applied" | "too_late", detail: string): void {
    this.steers.push({ steer, outcome, detail });
  }

  emit(e: GameEvent): void {
    this.emitted.push(e);
  }
}

const fast = { exploreMs: 60, explorePollMs: 10, jobTimeoutMs: 500, mineTimeoutMs: 500, reflexWaitMs: 500 };

function runner(world: World, item: string, count = 1): ObtainRunner {
  world.runner = new ObtainRunner(world, item, count, fast);
  return world.runner;
}

const mines = (w: World) => w.requests.filter((r) => r.type === "baritone").length;

describe("obtain runner steer", () => {
  it("changes the target at the next step and keeps what the plan already got", async () => {
    const world = new World();
    const r = runner(world, "oak_planks", 8);
    // The change arrives while the first step (mining logs) runs.
    world.onMine = () => {
      expect(r.steer("s1", { item: "stick" })).toBe("queued");
    };
    const result = await r.run();
    expect(result).toMatchObject({ ok: true });
    // The new target is made from the logs already mined: no second mine, no planks made for the old one.
    expect(world.inv.stick).toBeGreaterThanOrEqual(1);
    expect(mines(world)).toBe(1);
    expect(world.steers).toEqual([{ steer: "s1", outcome: "applied", detail: expect.any(String) }]);
    expect(r.item).toBe("stick");
    // Nothing was stopped in the middle of a job.
    expect(world.requests.some((q) => q.type === "baritone" && q.params.command === "stop")).toBe(false);
    expect(world.emitted.some((e) => e.type === "plan_steered")).toBe(true);
  });

  it("changes the count", async () => {
    const world = new World();
    const r = runner(world, "oak_planks");
    expect(r.steer("s2", { count: 8 })).toBe("queued");
    await r.run();
    expect(r.count).toBe(8);
    expect(world.inv.oak_planks).toBeGreaterThanOrEqual(8);
    expect(world.steers[0]).toMatchObject({ steer: "s2", outcome: "applied" });
  });

  it("is too late once the plan ended", async () => {
    const world = new World();
    const r = runner(world, "oak_planks");
    await r.run();
    expect(r.steer("late", { count: 2 })).toBe("too_late");
  });

  it("answers too_late for a change that never reached a step boundary", async () => {
    const world = new World();
    const r = runner(world, "oak_planks", 8);
    world.onMine = () => {
      // Cancelled in the same step: the queued change never gets its boundary.
      r.steer("s3", { item: "stick" });
      r.cancel();
    };
    await r.run();
    expect(world.steers).toEqual([{ steer: "s3", outcome: "too_late", detail: expect.any(String) }]);
  });

  it("refuses patches the planner cannot do", () => {
    expect(parsePlanPatch({ item: "bedrock_sword_of_doom" })).toEqual(expect.any(String));
    expect(parsePlanPatch({ speed: 3 })).toEqual(expect.any(String));
    expect(parsePlanPatch({})).toEqual(expect.any(String));
    expect(parsePlanPatch({ count: "many" })).toEqual(expect.any(String));
    expect(parsePlanPatch({ item: "stick", count: 500 })).toEqual({ item: "stick", count: 64 });
  });
});

describe("SteerableTasks", () => {
  const worker: TaskWorker = {
    observe: async () => ({ state: {}, summary: "ok" }),
    run: (_spec, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const spec: TaskSpec = { id: "t1", goal: "mine", args: {}, budget_s: 60 };
  const req = (task: string, id = "s1") => ({ id, task, patch: { count: 2 }, why: "w", cause: "c" });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function setup(handler: SteerHandler) {
    const tasks = new SteerableTasks(worker, handler);
    const seen: unknown[] = [];
    void (async () => {
      for await (const e of tasks.events()) seen.push(e);
    })();
    await tasks.start(spec);
    await flush();
    return { tasks, seen: () => seen.filter((e) => (e as { type: string }).type === "steered") };
  }

  it("reports what the handler decides at once", async () => {
    const { tasks, seen } = await setup(() => ({ outcome: "rejected", detail: "不行" }));
    await tasks.steer(req("t1"));
    await flush();
    expect(seen()).toEqual([expect.objectContaining({ task: "t1", steer: "s1", outcome: "rejected", detail: "不行" })]);
  });

  it("reports nothing yet for a queued steer, and what the runner reports later", async () => {
    const { tasks, seen } = await setup(() => null);
    await tasks.steer(req("t1"));
    await flush();
    expect(seen()).toEqual([]);
    tasks.reportSteer("t1", "s1", "applied", "好了");
    await flush();
    expect(seen()).toEqual([expect.objectContaining({ outcome: "applied" })]);
  });

  it("tells a task that ended (too_late) from one nobody started (rejected)", async () => {
    const { tasks, seen } = await setup(() => null);
    await tasks.cancel("t1");
    await flush();
    await tasks.steer(req("t1", "a"));
    await tasks.steer(req("nope", "b"));
    await flush();
    expect(seen()).toEqual([
      expect.objectContaining({ steer: "a", outcome: "too_late" }),
      expect.objectContaining({ steer: "b", outcome: "rejected" }),
    ]);
  });

  it("a handler that throws is a rejection", async () => {
    const { tasks, seen } = await setup(() => {
      throw new Error("壞了");
    });
    await tasks.steer(req("t1"));
    await flush();
    expect(seen()).toEqual([expect.objectContaining({ outcome: "rejected", detail: "壞了" })]);
  });
});
