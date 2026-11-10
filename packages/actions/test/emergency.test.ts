// The emergency stop (§16): the steps run in order, one that fails or hangs does not stop the ones
// after it, each answers for itself, and resume lifts the flag. The ActivityManager is a fake here:
// the real one, with the gate between them, is in packages/core/test/emergency.test.ts.

import { ServiceRegistry } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  ActionSinkKey,
  type ActivityManager,
  ActivityManagerKey,
  type ActivityRequest,
  type ActivitySnapshot,
  type ActivityTask,
  type ActivityTransition,
  EMERGENCY_TOPIC,
  type Event,
  type TransitionResult,
  TurnSilencerKey,
  toTimestamp,
  VoiceSinkKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/index.js";
import { ActuatorRegistry } from "../src/registry.js";

const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;

/** Her body: a request ends the thing `after` ms later, unless told otherwise. */
class Body {
  readonly requests: { type: string; principal: string }[] = [];
  readonly tasks = new Map<string, ActivityTask>();
  broadcast: ActivitySnapshot["broadcast"]["type"] = "live";
  presence: ActivitySnapshot["presence"]["type"] = "in";
  game = true;
  /** These requests are refused, hang or end `failed`. */
  refuse = new Set<string>();
  hang = new Set<string>();
  fail = new Set<string>();
  /** The task says done and nothing changed. */
  lie = new Set<string>();
  cancelled: string[] = [];

  snapshot(): ActivitySnapshot {
    const at = toTimestamp(Date.now());
    return {
      version: 1,
      at,
      presence:
        this.presence === "in" ? { type: "in", channel: VOICE, since: at } : { type: "none" },
      broadcast:
        this.broadcast === "live"
          ? { type: "live", guild: "g", golive: true, obs: true, task: null, since: at }
          : { type: "off" },
      activity: this.game
        ? {
            type: "game",
            target: "minecraft",
            phase: "running",
            task: null,
            failure: null,
            since: at,
          }
        : { type: "idle", since: at },
      override: null,
      scene: null,
    };
  }

  #end(request: ActivityRequest): void {
    if (this.lie.has(request.type)) return;
    if (request.type === "stop_live") this.broadcast = "off";
    if (request.type === "leave_voice") this.presence = "none";
    if (request.type === "stop") this.game = false;
  }

  async request(transition: ActivityTransition): Promise<TransitionResult> {
    const { request, principal } = transition;
    this.requests.push({ type: request.type, principal: principal.kind });
    const resource = "activity" as const;
    if (this.refuse.has(request.type)) {
      return { status: "refused", resource, code: "precondition", detail: "不行" };
    }
    const id = `task-${this.requests.length}`;
    const failed = this.fail.has(request.type);
    const task = {
      id,
      status: this.hang.has(request.type) ? "running" : failed ? "failed" : "done",
      failure: failed ? { code: "internal", detail: "壞了", at: toTimestamp(0) } : null,
    } as ActivityTask;
    this.tasks.set(id, task);
    if (!failed && !this.hang.has(request.type)) this.#end(request);
    return { status: "started", task: id, resource };
  }

  task(id: string): ActivityTask | null {
    return this.tasks.get(id) ?? null;
  }

  cancel(id: string): boolean {
    this.cancelled.push(id);
    return true;
  }
}

function rig(options: { silence?: boolean } = {}) {
  const services = new ServiceRegistry();
  const order: string[] = [];
  const events: Event[] = [];
  const body = new Body();
  const settings = new MemorySettingsStore();
  services.provide("app", SettingsStoreKey, settings);
  services.provide("app", ActivityManagerKey, body as unknown as ActivityManager);
  services.provide("app", TurnSilencerKey, {
    silence: () => {
      order.push("turns");
      if (options.silence === false) throw new Error("turns are stuck");
    },
  });
  services.provide("app", ActionSinkKey, {
    submit: async () => undefined,
    cancelTurn: async () => undefined,
    silence: async () => {
      order.push("queue");
      return 2;
    },
  });
  services.provide("app", VoiceSinkKey, {
    speak: async () => "completed" as const,
    silence: () => {
      order.push("speech");
    },
  });
  const registry = new ActuatorRegistry({
    services,
    builtins: false,
    publish: (e) => events.push(e),
  });
  registry.configure({ ...registry.config, emergency_step_ms: 200 });
  const stop = () => registry.emergency.stop("panel:test", "test");
  return { registry, body, order, events, settings, stop };
}

const named = (steps: { step: string; ok: boolean }[]) => steps.map((s) => [s.step, s.ok]);

describe("the emergency stop", () => {
  it("flag first, then silence, then stream, voice and game, each as the panel", async () => {
    const { registry, body, order, stop } = rig();
    const flagged: boolean[] = [];
    body.request = ((request) => (t: ActivityTransition) => {
      flagged.push(registry.paused);
      return request(t);
    })(body.request.bind(body));
    const report = await stop();
    expect(order).toEqual(["turns", "queue", "speech"]);
    expect(body.requests).toEqual([
      { type: "stop_live", principal: "panel" },
      { type: "leave_voice", principal: "panel" },
      { type: "stop", principal: "panel" },
    ]);
    expect(flagged).toEqual([true, true, true]);
    expect(named(report.steps)).toEqual([
      ["pause", true],
      ["silence", true],
      ["song", true],
      ["stream", true],
      ["voice", true],
      ["game", true],
    ]);
    expect(report.paused).toBe(true);
    expect(report.by).toBe("panel:test");
    expect(registry.paused).toBe(true);
  });

  it("nothing running is not a failure", async () => {
    const { body, stop } = rig();
    body.broadcast = "off";
    body.presence = "none";
    body.game = false;
    body.request = async () => ({ status: "already", task: null, resource: "activity" });
    const report = await stop();
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.steps.find((s) => s.step === "game")?.detail).toBe("沒有在玩遊戲");
  });

  it("a refused step is reported and the rest still run", async () => {
    const { body, stop } = rig();
    body.refuse.add("stop_live");
    const report = await stop();
    expect(named(report.steps).slice(3)).toEqual([
      ["stream", false],
      ["voice", true],
      ["game", true],
    ]);
    expect(report.steps[3]?.detail).toBe("不行");
    expect(body.requests.map((r) => r.type)).toEqual(["stop_live", "leave_voice", "stop"]);
  });

  it("a failed task is reported with why", async () => {
    const { body, stop } = rig();
    body.fail.add("leave_voice");
    const report = await stop();
    expect(report.steps.find((s) => s.step === "voice")).toEqual({
      step: "voice",
      ok: false,
      detail: "壞了",
    });
    expect(report.steps.find((s) => s.step === "game")?.ok).toBe(true);
  });

  it("a step that hangs runs out of time, is cancelled, and the next one runs", async () => {
    const { body, stop } = rig();
    body.hang.add("stop_live");
    const report = await stop();
    expect(report.steps.find((s) => s.step === "stream")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("逾時"),
    });
    expect(body.cancelled).toEqual(["task-1"]);
    expect(report.steps.find((s) => s.step === "game")?.ok).toBe(true);
  });

  it("done is not enough: the state has to show it", async () => {
    const { body, stop } = rig();
    body.lie.add("stop");
    const report = await stop();
    expect(report.steps.find((s) => s.step === "game")?.ok).toBe(false);
  });

  it("what fails in the silence step does not keep the others from dropping theirs", async () => {
    const { order, stop } = rig({ silence: false });
    const report = await stop();
    expect(order).toEqual(["turns", "queue", "speech"]);
    expect(report.steps[1]).toMatchObject({ step: "silence", ok: false });
    expect(report.steps[1]?.detail).toContain("turns are stuck");
    expect(report.steps.at(-1)?.ok).toBe(true);
  });

  it("a song stops through the singer, as the panel", async () => {
    const { registry, stop } = rig();
    const asked: unknown[] = [];
    registry.register(
      defineCapability<{ all?: boolean }>({
        name: "sing.stop",
        summary: "stop",
        risk: "low",
        args: z.object({ all: z.boolean().optional() }),
        permission: "song.skip",
        async execute(args) {
          asked.push(args);
          return "已停止";
        },
      }),
    );
    const report = await stop();
    expect(asked).toEqual([{ all: true }]);
    expect(report.steps.find((s) => s.step === "song")).toEqual({
      step: "song",
      ok: true,
      detail: "已停止",
    });
  });

  it("the report is published, kept, and a second press joins the first", async () => {
    const { registry, body, events, stop } = rig();
    const [first, second] = await Promise.all([stop(), stop()]);
    expect(first).toBe(second);
    expect(body.requests).toHaveLength(3);
    expect(registry.emergency.last).toBe(first);
    expect(
      events.filter((e) => e.type === "custom" && e.data.topic === EMERGENCY_TOPIC),
    ).toHaveLength(1);
  });

  it("the flag outlives a restart", async () => {
    const { settings, stop } = rig();
    await stop();
    expect(await settings.get("_global", "autonomy:paused")).toBe(true);
  });

  it("resume lifts it, says so and starts nothing", async () => {
    const { registry, body, stop } = rig();
    await stop();
    const asked = body.requests.length;
    const report = await registry.emergency.resume("panel:test");
    expect(registry.paused).toBe(false);
    expect(report.paused).toBe(false);
    expect(named(report.steps)).toEqual([["resume", true]]);
    expect(body.requests).toHaveLength(asked);
  });

  it("resume waits for a stop still running: it can not be undone halfway", async () => {
    const { registry, body, stop } = rig();
    body.hang.add("stop_live");
    const stopping = stop();
    await registry.emergency.resume("panel:test");
    expect(registry.paused).toBe(false);
    expect((await stopping).paused).toBe(true);
    expect(body.requests).toHaveLength(3);
  });
});
