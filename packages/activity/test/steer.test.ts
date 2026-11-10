// Steer (v3 §10.6) in the ActivityManager: only the main line, a live task, the same rules as any
// other action, the budget and the clock untouched, and one outcome for every steer.

import { ServiceRegistry } from "@miyoria/kernel";
import {
  type Arbiter,
  ArbiterKey,
  type ContextKey,
  customEvent,
  type DirectiveQuery,
  type Directives,
  DirectivesKey,
  type DirectiveVerdict,
  type Event,
  type EventLog,
  EventLogKey,
  type JsonObject,
  type NewLogEvent,
  newEnvelope,
  newId,
  type Principal,
  Principals,
  type RegisteredTaskExecutor,
  type SteerReceipt,
  type TaskEvent,
  TaskExecutorsKey,
  type TaskSteer,
  taskTopic,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { defaultActivityConfig } from "../src/config.js";
import { ActivityService } from "../src/manager.js";
import type { ActivityPort, StepCall } from "../src/port.js";
import { StepError } from "../src/port.js";
import { CHAT, OWEN, tick } from "./fake.js";

const OWNER = "game.minecraft";
const NOW = Date.UTC(2026, 10, 7, 12);
const at = () => toTimestamp(NOW);
const SELF: Principal = Principals.self(CHAT);

interface Harness {
  service: ActivityService;
  events: Event[];
  /** Calls the gate (the port) saw. */
  runs: StepCall[];
  /** `steer` calls the executor got. */
  steers: TaskSteer[];
  logged: NewLogEvent[];
  holds: Map<string, string>;
  /** What the gate does with a steer. */
  gate: { deny: string | null };
  executor: Executor;
  steered: () => Extract<TaskEvent, { type: "steered" }>[];
  /** An executor's task event on the bus. */
  bus: (event: TaskEvent, owner?: string) => void;
}

class Executor {
  readonly info = { owner: OWNER, name: "Minecraft", goals: [], guide: null };
  started = 0;
  cancelled = 0;
  /** `undefined`: the executor has no `steer`. */
  steer: ((steer: TaskSteer) => Promise<void>) | undefined;
  async observe() {
    return { at: at(), state: {}, task: null, summary: "" };
  }
  async start() {
    this.started += 1;
  }
  async cancel() {
    this.cancelled += 1;
  }
  events(): AsyncIterable<TaskEvent> {
    return (async function* () {})();
  }
}

function harness(
  options: {
    executorSteers?: boolean;
    check?: (query: DirectiveQuery) => Promise<DirectiveVerdict>;
  } = {},
): Harness {
  const services = new ServiceRegistry();
  const { check } = options;
  if (check) services.provide("core", DirectivesKey, { check } as unknown as Directives);
  const executor = new Executor();
  const events: Event[] = [];
  const runs: StepCall[] = [];
  const steers: TaskSteer[] = [];
  const logged: NewLogEvent[] = [];
  const holds = new Map<string, string>();
  const gate = { deny: null as string | null };
  let service!: ActivityService;
  const bus = (event: TaskEvent, owner = OWNER) =>
    service.observe(
      newEnvelope(
        "fake",
        customEvent(taskTopic(owner, event.type), event as unknown as JsonObject),
      ),
    );
  if (options.executorSteers !== false) {
    executor.steer = async (steer) => {
      steers.push(steer);
    };
  }
  services.provide("ext", TaskExecutorsKey, {
    get: (owner) => (owner === OWNER ? (executor as unknown as RegisteredTaskExecutor) : undefined),
    list: () => [executor as unknown as RegisteredTaskExecutor],
  });
  services.provide("arbiter", ArbiterKey, {
    held: (capability: string) => holds.get(capability) ?? null,
  } as unknown as Arbiter);
  services.provide("facts", EventLogKey, {
    append: (e: NewLogEvent) => {
      logged.push(e);
      return e;
    },
  } as unknown as EventLog);
  // The gate and `game.act`: a steer reaches the executor only if the gate lets it.
  const port: ActivityPort = {
    has: (capability) => capability === "game.act",
    async run(call) {
      runs.push(call);
      if (gate.deny !== null) throw new StepError("denied", gate.deny);
      const steer = (call.args.steer ?? null) as TaskSteer | null;
      if (steer !== null) await executor.steer?.(steer);
      return { text: "ok", data: { task: steer?.task ?? null } };
    },
  };
  service = new ActivityService({
    port,
    services,
    clock: { now: () => NOW },
    config: { ...defaultActivityConfig() },
    // What the module does: the bus brings the manager its own events back.
    publish: (e) => {
      events.push(e);
      queueMicrotask(() => service.observe(newEnvelope("activity", e)));
    },
  });
  return {
    service,
    events,
    runs,
    steers,
    logged,
    holds,
    gate,
    executor,
    steered: () =>
      events.flatMap((e) =>
        e.type === "custom" && e.data.topic === taskTopic(OWNER, "steered")
          ? [e.data.payload as unknown as Extract<TaskEvent, { type: "steered" }>]
          : [],
      ),
    bus,
  };
}

/** A running task of the game: the spec is tracked (as `game.act` does) and `started` is on the bus. */
function running(h: Harness, id = "t1", args: JsonObject = { item: "iron_pickaxe", count: 1 }) {
  h.service.track(OWNER, { id, goal: "obtain", args, budget_s: 240 });
  h.bus({ type: "started", task: id, goal: "obtain", at: at() });
}

function steerOf(task = "t1", patch: JsonObject = { item: "stone_pickaxe" }): TaskSteer {
  return { id: newId(), task, patch, why: "有人說先做石鎬", cause: newId() };
}

const ask = (h: Harness, steer: TaskSteer, principal: Principal = SELF, owner = OWNER) =>
  h.service.steer({ steer, owner, principal });

describe("steer: accepted, then applied at the executor's safe point", () => {
  it("goes through the gate as game.act with the patched goal, keeps the budget and the clock", async () => {
    const h = harness();
    running(h);
    const steer = steerOf("t1", { item: "stone_pickaxe" });
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({
      status: "accepted",
      task: "t1",
      budget_s: 240,
      started_at: at(),
    });
    // One gate call, as the main line, for the goal as it is after the patch.
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      capability: "game.act",
      principal: { kind: "self" },
      primary: null,
    });
    expect(h.runs[0]?.args).toMatchObject({
      game: "minecraft",
      call: { action: "obtain", args: { item: "stone_pickaxe", count: 1 } },
      steer: { id: steer.id, task: "t1", patch: { item: "stone_pickaxe" } },
    });
    expect(h.steers).toEqual([steer]);
    // Nothing was restarted or cancelled: the task goes on.
    expect(h.executor.started).toBe(0);
    expect(h.executor.cancelled).toBe(0);
    // `accepted` is not `applied`: no outcome yet.
    expect(h.steered()).toEqual([]);
  });

  it("learns the new goal from the executor's `applied` and steers on top of it", async () => {
    const h = harness();
    running(h);
    const first = steerOf("t1", { item: "stone_pickaxe" });
    await ask(h, first);
    h.bus({
      type: "steered",
      task: "t1",
      steer: first.id,
      outcome: "applied",
      detail: "改了",
      at: at(),
    });
    const second = steerOf("t1", { count: 2 });
    const receipt = await ask(h, second);
    expect(receipt.status).toBe("accepted");
    expect(h.runs[1]?.args).toMatchObject({
      call: { args: { item: "stone_pickaxe", count: 2 } },
    });
    // Same budget, same start, however often she steers.
    expect(receipt).toMatchObject({ budget_s: 240, started_at: at() });
  });

  it("is idempotent: the same steer id gets the same receipt and reaches the gate once", async () => {
    const h = harness();
    running(h);
    const steer = steerOf();
    const a = await ask(h, steer);
    const b = await ask(h, steer);
    expect(b).toEqual(a);
    expect(h.runs).toHaveLength(1);
  });
});

describe("steer: refused", () => {
  const outcomes = (h: Harness) => h.steered().map((e) => e.outcome);

  it("only the main line may steer, whoever else asks", async () => {
    const h = harness();
    running(h);
    const chat = Principals.user(OWEN, CHAT);
    const panel = Principals.panel("admin");
    const director = Principals.director(CHAT);
    for (const principal of [chat, panel, director]) {
      const receipt = await ask(h, steerOf(), principal);
      expect(receipt).toMatchObject({ status: "rejected", reason: "not_main_line" });
    }
    expect(h.runs).toHaveLength(0);
    expect(h.steers).toHaveLength(0);
    expect(outcomes(h)).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("an unknown task is rejected, and it says so with an event", async () => {
    const h = harness();
    const steer = steerOf("nope");
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "rejected", reason: "unknown_task" });
    expect(h.steered()).toMatchObject([{ steer: steer.id, task: "nope", outcome: "rejected" }]);
  });

  it("a task of another executor is not this one's", async () => {
    const h = harness();
    h.bus({ type: "started", task: "x1", goal: "mine", at: at() }, "game.other");
    const receipt = await ask(h, steerOf("x1"));
    expect(receipt).toMatchObject({ status: "rejected", reason: "unknown_task" });
  });

  it("the executor's own `rejected` arrives as an event, the task goes on", async () => {
    const h = harness();
    running(h);
    const steer = steerOf("t1", { item: "diamond_pickaxe" });
    const receipt = await ask(h, steer);
    expect(receipt.status).toBe("accepted");
    h.bus({
      type: "steered",
      task: "t1",
      steer: steer.id,
      outcome: "rejected",
      detail: "不知道怎麼取得",
      at: at(),
    });
    await tick();
    expect(outcomes(h)).toEqual([]);
    expect(h.executor.cancelled).toBe(0);
    // The failed steer did not change what the manager thinks the goal is.
    const next = await ask(h, steerOf("t1", { count: 3 }));
    expect(next.status).toBe("accepted");
    expect(h.runs[1]?.args).toMatchObject({ call: { args: { item: "iron_pickaxe", count: 3 } } });
  });

  it("an executor that fails to accept the steer is a rejection", async () => {
    const h = harness();
    running(h);
    h.executor.steer = async () => {
      throw new Error("RPC timed out");
    };
    const steer = steerOf();
    // The fake gate lets the executor's error through as the capability's failure.
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "rejected", reason: "failed" });
    expect(h.steered()).toMatchObject([{ steer: steer.id, outcome: "rejected" }]);
  });
});

describe("steer: too late", () => {
  it("a task that ended is too_late, with an event", async () => {
    const h = harness();
    running(h);
    h.bus({ type: "done", task: "t1", detail: "做好了", data: null, at: at() });
    const steer = steerOf();
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "too_late", task: "t1" });
    expect(h.steered()).toMatchObject([{ steer: steer.id, outcome: "too_late" }]);
    expect(h.runs).toHaveLength(0);
  });

  it("a task that ends while the executor is taking the steer is too_late, once", async () => {
    const h = harness();
    running(h);
    // The task ends at the same moment: after the gate let the steer through, before it was applied.
    h.executor.steer = async (steer) => {
      h.steers.push(steer);
      h.bus({ type: "failed", task: "t1", code: "died", detail: "死掉了", at: at() });
    };
    const steer = steerOf();
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "too_late", task: "t1" });
    await tick();
    expect(h.steered()).toHaveLength(1);
    expect(h.steered()[0]).toMatchObject({ steer: steer.id, outcome: "too_late" });
  });

  it("an accepted steer the executor never answered is too_late when the task ends", async () => {
    const h = harness();
    running(h);
    const steer = steerOf();
    expect((await ask(h, steer)).status).toBe("accepted");
    expect(h.steered()).toEqual([]);
    h.bus({ type: "done", task: "t1", detail: "做好了", data: null, at: at() });
    await tick();
    expect(h.steered()).toMatchObject([{ steer: steer.id, task: "t1", outcome: "too_late" }]);
  });

  it("an executor's own too_late is not repeated by the manager", async () => {
    const h = harness();
    running(h);
    const steer = steerOf();
    await ask(h, steer);
    h.bus({
      type: "steered",
      task: "t1",
      steer: steer.id,
      outcome: "too_late",
      detail: "結束了",
      at: at(),
    });
    h.bus({ type: "done", task: "t1", detail: "", data: null, at: at() });
    await tick();
    expect(h.steered()).toEqual([]);
  });
});

describe("steer: the same rules as any other action", () => {
  it("the rules see the goal as it would be after the patch, as the main line", async () => {
    const asked: DirectiveQuery[] = [];
    const h = harness({
      check: async (query) => {
        asked.push(query);
        return { outcome: "allow" };
      },
    });
    running(h);
    await ask(h, steerOf("t1", { item: "diamond" }));
    expect(asked.map((q) => q.capability)).toEqual(["game.start", "game.act"]);
    expect(asked[0]?.args).toMatchObject({
      game: "minecraft",
      args: { item: "diamond" },
    });
    expect(asked[0]?.principal.kind).toBe("self");
    expect(h.steers).toHaveLength(1);
  });

  it("a rule refuses a steer before the gate and the executor", async () => {
    const h = harness({
      check: async ({ args }) =>
        JSON.stringify(args).includes("diamond")
          ? { outcome: "deny", directive: "r1", reason: "主人定的規則:不要挖鑽石" }
          : { outcome: "allow" },
    });
    running(h);
    const steer = steerOf("t1", { item: "diamond" });
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "rejected", reason: "rule" });
    expect((receipt as { detail: string }).detail).toContain("不要挖鑽石");
    expect(h.runs).toHaveLength(0);
    expect(h.steers).toHaveLength(0);
    expect(h.steered()).toMatchObject([{ steer: steer.id, outcome: "rejected" }]);
  });

  it("anything short of an allow refuses, and so does a check that fails", async () => {
    const approval = harness({
      check: async () => ({ outcome: "approval", directive: "r1", reason: "要先問" }),
    });
    running(approval);
    expect(await ask(approval, steerOf())).toMatchObject({ status: "rejected", reason: "rule" });
    expect(approval.runs).toHaveLength(0);
    const broken = harness({
      check: async () => {
        throw new Error("no store");
      },
    });
    running(broken);
    expect(await ask(broken, steerOf())).toMatchObject({ status: "rejected", reason: "rule" });
    expect(broken.runs).toHaveLength(0);
  });

  it("a hold still stops a steer the rules allow", async () => {
    const h = harness({ check: async () => ({ outcome: "allow" }) });
    running(h);
    h.holds.set("game.start", "有人不想你玩");
    const receipt = await ask(h, steerOf());
    expect((receipt as { detail: string }).detail).toContain("有人不想你玩");
    expect(h.runs).toHaveLength(0);
  });

  it("a hold on game.start stops a steer of a game task", async () => {
    const h = harness();
    running(h);
    h.holds.set("game.start", "有人不想你玩");
    const steer = steerOf("t1", { item: "stone_pickaxe" });
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "rejected", reason: "rule" });
    expect((receipt as { detail: string }).detail).toContain("有人不想你玩");
    expect(h.runs).toHaveLength(0);
    expect(h.steers).toHaveLength(0);
    expect(h.steered()).toMatchObject([{ steer: steer.id, outcome: "rejected" }]);
  });

  it("a hold on game.act does too, and a rule that cannot be read fails closed", async () => {
    const h = harness();
    running(h);
    h.holds.set("game.act", "暫停");
    expect(await ask(h, steerOf())).toMatchObject({ status: "rejected", reason: "rule" });
    h.holds.clear();
    // A rule that cannot be read is a rule that holds.
    const broken = harness();
    running(broken);
    (broken.holds as unknown as { get: () => string }).get = () => {
      throw new Error("broken");
    };
    expect(await ask(broken, steerOf())).toMatchObject({ status: "rejected", reason: "rule" });
    expect(broken.runs).toHaveLength(0);
  });

  it("the gate decides too: pause, a prohibition or the budget refuse it", async () => {
    const h = harness();
    running(h);
    h.gate.deny = "autonomy is paused";
    const steer = steerOf();
    const receipt = await ask(h, steer);
    expect(receipt).toMatchObject({ status: "rejected", reason: "denied" });
    expect(h.steers).toHaveLength(0);
    expect(h.steered()).toMatchObject([{ steer: steer.id, outcome: "rejected" }]);
  });
});

describe("steer: the budget and the clock stay", () => {
  it.each(["budget_s", "budget", "timeout", "timeout_s", "deadline", "started_at", "id", "task"])(
    "a patch that touches %s is invalid",
    async (key) => {
      const h = harness();
      running(h);
      const receipt = await ask(h, steerOf("t1", { item: "stone_pickaxe", [key]: 99_999 }));
      expect(receipt).toMatchObject({ status: "rejected", reason: "invalid" });
      expect(h.runs).toHaveLength(0);
      expect(h.steers).toHaveLength(0);
    },
  );

  it("a steer does not touch the spec: the next one still sees the first budget and start", async () => {
    const h = harness();
    running(h);
    for (let i = 0; i < 3; i++) {
      const receipt = await ask(h, steerOf("t1", { count: i + 2 }));
      expect(receipt).toMatchObject({ status: "accepted", budget_s: 240, started_at: at() });
    }
    expect(h.executor.started).toBe(0);
  });

  it("a malformed request is invalid without touching anything", async () => {
    const h = harness();
    running(h);
    const bad = { ...steerOf(), patch: [] as unknown as JsonObject };
    expect(await ask(h, bad)).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(await ask(h, steerOf(), SELF, "")).toMatchObject({ status: "rejected" });
    expect(h.runs).toHaveLength(0);
  });
});

describe("steer: no steer, no luck", () => {
  it("an executor without `steer` answers unsupported: cancel then start, progress lost", async () => {
    const h = harness({ executorSteers: false });
    running(h);
    const steer = steerOf();
    const receipt: SteerReceipt = await ask(h, steer);
    expect(receipt).toMatchObject({
      status: "unsupported",
      fallback: "cancel_then_start",
      progress_lost: true,
      task: "t1",
    });
    // Nothing was tried: no gate call, no event, the task untouched.
    expect(h.runs).toHaveLength(0);
    expect(h.steered()).toEqual([]);
    expect(h.executor.cancelled).toBe(0);
  });

  it("an owner without a gate route is unsupported too", async () => {
    const h = harness();
    const receipt = await ask(h, steerOf("e1"), SELF, "ext.osu");
    expect(receipt).toMatchObject({ status: "unsupported", fallback: "cancel_then_start" });
  });

  it("the manager's own transitions are single steps: a scene switch cannot be steered", async () => {
    const h = harness();
    const result = await h.service.request({
      request: { type: "scene_override", scene: "ending", duration_ms: 60_000 },
      principal: Principals.panel("admin"),
      turn: null,
      context: CHAT as ContextKey | null,
      why: "test",
    });
    const task = result.status === "refused" ? "" : (result.task ?? "");
    expect(task).not.toBe("");
    const receipt = await ask(h, steerOf(task));
    expect(receipt).toMatchObject({ status: "unsupported", fallback: "cancel_then_start" });
    expect(await ask(h, steerOf("s1"), SELF, "stage.obs")).toMatchObject({
      status: "unsupported",
    });
  });
});

describe("steer: the cause chain", () => {
  it("the request is a steer line under the steer's id, caused by the trigger", async () => {
    const h = harness();
    running(h);
    const steer = steerOf();
    await ask(h, steer);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({
      id: steer.id,
      kind: "steer",
      source: "activity",
      cause: steer.cause,
      body: { phase: "request", owner: OWNER, task: "t1", patch: steer.patch, by: "self" },
    });
  });

  it("every refusal is logged and answered by an event that names the steer", async () => {
    const h = harness();
    running(h);
    h.holds.set("game.start", "規則");
    const steer = steerOf();
    await ask(h, steer);
    expect(h.logged.map((l) => l.id)).toEqual([steer.id]);
    expect(h.steered().map((e) => e.steer)).toEqual([steer.id]);
  });
});

describe("steer: in-process routes (the song list)", () => {
  it("is gated as its own capability and answers at once with the outcome", async () => {
    let seen: StepCall | null = null;
    const services = new ServiceRegistry();
    const events: Event[] = [];
    const service = new ActivityService({
      port: {
        has: (c) => c === "sing.steer",
        async run(call) {
          seen = call;
          return { text: "ok", data: { outcome: "applied", detail: "排到第 1 首" } };
        },
      },
      services,
      clock: { now: () => NOW },
      publish: (e) => events.push(e),
    });
    service.registerRoute("sing", {
      capability: "sing.steer",
      live: () => ({ goal: "sing", args: { song: 3 } }),
      args: (steer) => ({ steer: { id: steer.id, task: steer.task } }),
    });
    const steer = steerOf("song:3", { next: true });
    const receipt = await service.steer({ steer, owner: "sing", principal: SELF });
    expect(receipt).toMatchObject({ status: "accepted", task: "song:3" });
    expect((seen as StepCall | null)?.capability).toBe("sing.steer");
    const published = events.flatMap((e) =>
      e.type === "custom" && e.data.topic === "sing.task.steered" ? [e.data.payload] : [],
    );
    expect(published).toMatchObject([{ steer: steer.id, outcome: "applied", task: "song:3" }]);
  });

  it("a finished song is too_late, an unknown one is rejected", async () => {
    let state: "over" | null = "over";
    const service = new ActivityService({
      port: { has: () => true, run: async () => ({ text: "ok", data: null }) },
      clock: { now: () => NOW },
    });
    service.registerRoute("sing", {
      capability: "sing.steer",
      live: () => state,
      args: () => ({}),
    });
    const ask = (task: string) =>
      service.steer({ steer: steerOf(task), owner: "sing", principal: SELF });
    expect(await ask("song:3")).toMatchObject({ status: "too_late" });
    state = null;
    expect(await ask("song:9")).toMatchObject({ status: "rejected", reason: "unknown_task" });
  });
});
