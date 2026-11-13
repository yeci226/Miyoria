import { type Envelope, type ModuleStateKind, serviceKey } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  manifestJson,
  Supervisor,
} from "../src/index.js";

class TestModule implements Module {
  starts = 0;
  stops = 0;

  constructor(
    readonly manifest: ModuleManifest,
    private readonly failFirstStart = false,
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const n = this.starts++;
    if (this.failFirstStart && n === 0) {
      ctx.spawn("boom", async () => {
        throw new Error("boom");
      });
    } else {
      ctx.spawn(
        "idle",
        (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
      );
    }
  }

  async stop(): Promise<void> {
    this.stops++;
  }
}

function state(sup: Supervisor, id: string): ModuleStateKind | undefined {
  return sup.list().find((s) => s.id === id)?.state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Supervisor", () => {
  it("starts_in_order_and_cascades_disable", async () => {
    const sup = new Supervisor();
    const base = new TestModule(defineManifest("base", "Base"));
    const top = new TestModule(defineManifest("top", "Top", { requires: ["base"] }));
    await sup.register(top, null, true);
    await sup.register(base, null, true);
    await sup.startAll();
    expect(state(sup, "base")).toBe("running");
    expect(state(sup, "top")).toBe("running");

    await sup.disable("base");
    expect(state(sup, "base")).toBe("disabled");
    expect(state(sup, "top")).toBe("stopped");
    expect(sup.list().find((s) => s.id === "top")?.reason).toBe("dependency `base` disabled");

    await sup.enable("base");
    expect(state(sup, "top")).toBe("running");
    expect(top.starts).toBe(2);
    await sup.stopAll();
    expect(state(sup, "top")).toBe("stopped");
  });

  it("pause stops modules around a change and starts them again", async () => {
    const sup = new Supervisor();
    const base = new TestModule(defineManifest("base", "Base"));
    const top = new TestModule(defineManifest("top", "Top", { requires: ["base"] }));
    const off = new TestModule(defineManifest("off", "Off"));
    await sup.register(base, null, true);
    await sup.register(top, null, true);
    await sup.register(off, null, false);
    await sup.startAll();

    const seen: (string | undefined)[] = [];
    const result = await sup.pause(["base", "off", "nope"], async () => {
      seen.push(state(sup, "base"), state(sup, "top"));
      return 42;
    });
    expect(result).toEqual({ value: 42, failed: [] });
    expect(seen).toEqual(["stopped", "stopped"]);
    expect(base.stops).toBe(1);
    expect(state(sup, "base")).toBe("running");
    expect(state(sup, "top")).toBe("running");
    expect(state(sup, "off")).toBe("disabled");
    expect(sup.list().find((s) => s.id === "base")?.enabled).toBe(true);

    // A failing change still brings them back.
    await expect(
      sup.pause(["base"], async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(state(sup, "base")).toBe("running");
    expect(base.starts).toBe(3);
    await sup.stopAll();
  });

  it("missing_requirement_keeps_module_stopped", async () => {
    const sup = new Supervisor();
    await sup.register(
      new TestModule(defineManifest("top", "Top", { requires: ["base"] })),
      null,
      true,
    );
    await sup.register(new TestModule(defineManifest("base", "Base")), null, false);
    await sup.startAll();
    expect(state(sup, "top")).toBe("stopped");
    expect(state(sup, "base")).toBe("disabled");
    expect(sup.list()[1]).toEqual({
      id: "top",
      name: "Top",
      description: "",
      enabled: true,
      state: "stopped",
      reason: "required module `base` is not running",
      recent_restarts: 0,
    });
    await expect(sup.enable("nope")).rejects.toThrow("unknown module `nope`");
  });

  it("failed_task_restarts_with_backoff", async () => {
    vi.useFakeTimers();
    const sup = new Supervisor();
    const m = new TestModule(defineManifest("flaky", "Flaky"), true);
    await sup.register(m, null, true);
    await sup.startAll();
    // Let the failing task report, then advance past the backoff (2 s for the first failure).
    await vi.advanceTimersByTimeAsync(0);
    expect(state(sup, "flaky")).toBe("failed");
    expect(sup.list()[0]?.reason).toBe("task `boom` failed: boom");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state(sup, "flaky")).toBe("running");
    expect(m.starts).toBe(2);
    expect(sup.list()[0]?.recent_restarts).toBe(1);
    await sup.stopAll();
  });

  it("gives up after too many failures in the window", async () => {
    vi.useFakeTimers();
    const sup = new Supervisor();
    let starts = 0;
    const always: Module = {
      manifest: defineManifest("broken", "Broken"),
      async start() {
        starts++;
        throw new Error("nope");
      },
    };
    await sup.register(always, null, true);
    await sup.startAll();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // 1 start + 5 restarts, then it stays failed.
    expect(starts).toBe(6);
    expect(state(sup, "broken")).toBe("failed");
    expect(sup.list()[0]?.reason).toBe("start failed: nope");
    // A manual restart clears the history.
    await expect(sup.restart("broken")).rejects.toThrow(/did not start/);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(7);
    await sup.stopAll();
  });

  it("enable and restart reject with the reason the start failed", async () => {
    vi.useFakeTimers();
    const sup = new Supervisor();
    let starts = 0;
    let failing = true;
    const listener: Module = {
      manifest: defineManifest("listener", "Listener"),
      async start() {
        starts++;
        if (failing) throw new Error("listen EADDRINUSE: address already in use :::8080");
      },
    };
    const web = new TestModule(defineManifest("web", "Web", { requires: ["listener"] }));
    await sup.register(listener, null, false);
    await sup.register(web, null, true);
    await sup.startAll();
    expect(state(sup, "web")).toBe("stopped");

    await expect(sup.enable("listener")).rejects.toThrow(
      "module `listener` did not start: start failed: listen EADDRINUSE: address already in use :::8080",
    );
    expect(state(sup, "listener")).toBe("failed");
    expect(sup.list().find((m) => m.id === "listener")?.reason).toMatch(/EADDRINUSE/);
    expect(state(sup, "web")).toBe("stopped");

    await expect(sup.restart("listener")).rejects.toThrow(
      /did not start: start failed: listen EADDRINUSE/,
    );
    expect(starts).toBe(2);

    // The backoff restart still comes, and the dependent starts with it.
    failing = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(starts).toBe(3);
    expect(state(sup, "listener")).toBe("running");
    expect(state(sup, "web")).toBe("running");
    await sup.stopAll();
  });

  it("failure of a requirement stops dependents and both come back", async () => {
    vi.useFakeTimers();
    const sup = new Supervisor();
    const base = new TestModule(defineManifest("base", "Base"), true);
    const top = new TestModule(defineManifest("top", "Top", { requires: ["base"] }));
    await sup.register(base, null, true);
    await sup.register(top, null, true);
    await sup.startAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(state(sup, "base")).toBe("failed");
    expect(state(sup, "top")).toBe("stopped");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state(sup, "base")).toBe("running");
    expect(state(sup, "top")).toBe("running");
    await sup.stopAll();
  });

  it("context: config, services, events and cancellation", async () => {
    const Key = serviceKey<{ value: number }>("Thing");
    const ConfigSchema = z.object({ value: z.number().default(7) });
    const seen: Envelope[] = [];
    let taskSignal: AbortSignal | undefined;
    const provider: Module = {
      manifest: defineManifest("provider", "Provider", { configSchema: ConfigSchema }),
      async start(ctx) {
        const cfg = ctx.config(ConfigSchema);
        ctx.provide(Key, { value: cfg.value });
        const sub = ctx.subscribe("custom.*");
        ctx.spawn("listen", async (signal) => {
          taskSignal = signal;
          for await (const env of sub) seen.push(env);
        });
        ctx.publish(
          { type: "custom", data: { topic: "custom.hello", payload: cfg.value } },
          { turn: "01JC0000000000000000000000" },
        );
      },
    };
    const consumer: Module = {
      manifest: defineManifest("consumer", "Consumer", { requires: ["provider"] }),
      async start(ctx) {
        expect(ctx.services.require(Key).value).toBe(3);
        expect(ctx.rawConfig).toBeNull();
      },
    };
    const sup = new Supervisor();
    await sup.register(consumer, null, true);
    await sup.register(provider, { value: 3 }, true);
    await sup.startAll();
    expect(state(sup, "consumer")).toBe("running");
    expect(seen[0]?.source).toBe("provider");
    expect(seen[0]?.correlation).toBe("01JC0000000000000000000000");

    await sup.disable("provider");
    expect(taskSignal?.aborted).toBe(true);
    expect(sup.services.get(Key)).toBeUndefined();
    expect(sup.bus.subscriberCount).toBe(0);
    expect(manifestJson(provider.manifest).config_schema).toMatchObject({
      type: "object",
      properties: { value: { type: "number", default: 7 } },
    });
  });

  it("invalid config fails the start", async () => {
    vi.useFakeTimers();
    const Schema = z.object({ port: z.number() });
    const m: Module = {
      manifest: defineManifest("api", "API"),
      async start(ctx) {
        ctx.config(Schema);
      },
    };
    const sup = new Supervisor();
    await sup.register(m, { port: "x" }, true);
    await sup.startAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(state(sup, "api")).toBe("failed");
    expect(sup.list()[0]?.reason).toMatch(/^start failed: invalid config at `modules.api`/);
    await sup.stopAll();
  });

  it("rejects dependency cycles", async () => {
    const sup = new Supervisor();
    await sup.register(new TestModule(defineManifest("a", "A", { requires: ["b"] })), null, true);
    await sup.register(new TestModule(defineManifest("b", "B", { optional: ["a"] })), null, true);
    await expect(sup.startAll()).rejects.toThrow(/cycle/);
  });

  it("publishes state changes", async () => {
    const sup = new Supervisor();
    const sub = sup.bus.subscribe("system.module.state");
    await sup.register(new TestModule(defineManifest("m", "M")), null, true);
    await sup.startAll();
    await sup.restart("m");
    await sup.stopAll();
    const states: string[] = [];
    for (let env = sub.tryRecv(); env; env = sub.tryRecv()) {
      if (env.event.type === "module_state_changed") {
        expect(env.source).toBe("kernel");
        states.push(env.event.data.state);
      }
    }
    expect(states).toEqual([
      "starting",
      "running",
      "stopping",
      "stopped",
      "starting",
      "running",
      "stopping",
      "stopped",
    ]);
  });
});
