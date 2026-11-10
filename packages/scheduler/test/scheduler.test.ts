import { EventBus, ServiceRegistry, type Subscription, Supervisor } from "@miyoria/kernel";
import {
  ACTION_SETTLED_TOPIC,
  type Action,
  type ActionSettled,
  type ActionSink,
  ActionSinkKey,
  type ActuatorExecutor,
  ActuatorExecutorKey,
  actLane,
  type ContextKey,
  customEvent,
  type JsonObject,
  type JsonValue,
  type MessageRef,
  MouthKey,
  MUTED,
  NOT_MAIN_LINE,
  newAction,
  newId,
  type OutgoingMessage,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  type Priority,
  type SpeakOutcome,
  type TurnId,
  textLane,
  type VoiceSink,
  VoiceSinkKey,
  voiceLane,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler, SchedulerModule } from "../src/index.js";

/** Like tokio's `Notify`: `notifyOne` before `notified` is remembered. */
class Gate {
  #permit = false;
  #waiter: (() => void) | null = null;

  notifyOne(): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter();
    } else {
      this.#permit = true;
    }
  }

  notified(): Promise<void> {
    if (this.#permit) {
      this.#permit = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }
}

class FakeSink implements PlatformSink {
  readonly platform = "fake";
  readonly ops: string[] = [];
  /** `typing` blocks until notified, to hold a lane busy. */
  readonly gate = new Gate();

  async send(context: ContextKey, message: OutgoingMessage): Promise<MessageRef> {
    this.ops.push(`send:${message.text}`);
    return { context, id: "m" };
  }

  async react(_message: MessageRef, emoji: string): Promise<void> {
    this.ops.push(`react:${emoji}`);
  }

  async typing(): Promise<void> {
    this.ops.push("typing");
    await this.gate.notified();
  }
}

interface Harness {
  sup: Supervisor;
  module: SchedulerModule;
  sink: FakeSink;
  actions: ActionSink;
  completed: Subscription;
}

async function harness(config: JsonObject | null = null): Promise<Harness> {
  const services = new ServiceRegistry();
  const sinks = new PlatformSinks();
  const sink = new FakeSink();
  sinks.register(sink);
  services.provide("app", PlatformSinksKey, sinks);
  const sup = new Supervisor({ bus: new EventBus(), services });
  const completed = sup.bus.subscribe("action.completed");
  const module = new SchedulerModule();
  await sup.register(module, config, true);
  await sup.startAll();
  const actions = services.require(ActionSinkKey);
  return { sup, module, sink, actions, completed };
}

function context(platform: string): ContextKey {
  return { platform, scope: "g", channel: "c", kind: "channel" };
}

function send(text: string, priority: Priority, options: Parameters<typeof newAction>[3] = {}) {
  const ctx = context("fake");
  return newAction(
    textLane(ctx),
    priority,
    { type: "send_message", context: ctx, message: { text, reply_to: null } },
    options,
  );
}

function blocker(): Action {
  const ctx = context("fake");
  return newAction(textLane(ctx), "system", { type: "typing", context: ctx });
}

interface Done {
  action: string;
  ok: boolean;
  error: string | null;
}

async function nextDone(sub: Subscription): Promise<Done> {
  const env = await sub.recv();
  if (env === null) throw new Error("subscription closed");
  if (env.event.type !== "action_completed") {
    throw new Error(`unexpected event ${env.event.type}`);
  }
  const { action, ok, error } = env.event.data;
  return { action, ok, error };
}

/** Submits a blocking action and waits until the lane is busy with it. */
async function holdLane(h: Harness): Promise<void> {
  await h.actions.submit(blocker());
  while (!h.sink.ops.includes("typing")) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("runs_in_priority_then_creation_order", async () => {
    const h = await harness();
    await holdLane(h);
    for (const [text, prio] of [
      ["a", "initiative"],
      ["b", "direct"],
      ["c", "system"],
      ["d", "direct"],
      ["e", "idle"],
    ] as const) {
      await h.actions.submit(send(text, prio));
    }
    h.sink.gate.notifyOne();
    for (let i = 0; i < 6; i++) expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops).toEqual(["typing", "send:c", "send:b", "send:d", "send:a", "send:e"]);
    await h.sup.stopAll();
  });

  it("coalesces_queued_actions_with_same_key", async () => {
    const h = await harness();
    await holdLane(h);
    const first = send("x1", "direct", { coalesce_key: "emo" });
    await h.actions.submit(first);
    await h.actions.submit(send("y", "direct"));
    await h.actions.submit(send("x2", "direct", { coalesce_key: "emo" }));
    const dropped = await nextDone(h.completed);
    expect(dropped.action).toBe(first.id);
    expect(dropped.error).toBe("coalesced");
    h.sink.gate.notifyOne();
    for (let i = 0; i < 3; i++) expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops).toEqual(["typing", "send:y", "send:x2"]);
    await h.sup.stopAll();
  });

  it("drops_expired_actions_before_execution", async () => {
    const h = await harness();
    await holdLane(h);
    await h.actions.submit(send("stale", "direct", { ttl: 1000, now: Date.now() - 10_000 }));
    await h.actions.submit(send("fresh", "direct"));
    h.sink.gate.notifyOne();
    expect((await nextDone(h.completed)).ok).toBe(true);
    const dropped = await nextDone(h.completed);
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toBe("expired");
    expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops).toEqual(["typing", "send:fresh"]);
    await h.sup.stopAll();
  });

  it("cancel_turn_removes_queued_actions_of_that_turn", async () => {
    const h = await harness();
    await holdLane(h);
    const [t1, t2] = [newId(), newId()];
    await h.actions.submit(send("t1a", "direct", { turn: t1 }));
    await h.actions.submit(send("t2", "direct", { turn: t2 }));
    await h.actions.submit(send("t1b", "direct", { turn: t1 }));
    await h.actions.cancelTurn(t1);
    for (let i = 0; i < 2; i++) expect((await nextDone(h.completed)).error).toBe("cancelled");
    h.sink.gate.notifyOne();
    for (let i = 0; i < 2; i++) expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops).toEqual(["typing", "send:t2"]);
    await h.sup.stopAll();
  });

  it("missing_platform_sink_fails_the_action", async () => {
    const h = await harness();
    const ctx = context("nowhere");
    await h.actions.submit(newAction(textLane(ctx), "direct", { type: "typing", context: ctx }));
    const done = await nextDone(h.completed);
    expect(done.ok).toBe(false);
    expect(done.error).toBe("no sink for platform nowhere");
    await h.sup.stopAll();
  });

  it("lanes_run_independently_and_idle_workers_exit", async () => {
    const h = await harness({ lane_idle_ms: 1000 });
    await holdLane(h);
    // A different lane is not blocked by the busy one.
    const other: ContextKey = { ...context("fake"), channel: "other" };
    await h.actions.submit(
      newAction(textLane(other), "direct", {
        type: "send_message",
        context: other,
        message: { text: "", reply_to: null },
      }),
    );
    expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.module.activeLanes()).toHaveLength(2);

    h.sink.gate.notifyOne();
    expect((await nextDone(h.completed)).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.module.activeLanes()).toEqual([]);

    // A new submission revives the lane.
    await h.actions.submit(send("again", "direct"));
    expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops.at(-1)).toBe("send:again");
    await h.sup.stopAll();
  });

  it("stops_cleanly_with_work_in_flight", async () => {
    const h = await harness();
    await holdLane(h);
    await h.actions.submit(send("queued", "direct"));
    await h.sup.stopAll();
    for (let i = 0; i < 2; i++) expect((await nextDone(h.completed)).error).toBe("cancelled");
    await expect(h.actions.submit(send("late", "direct"))).rejects.toThrow("scheduler is stopped");
    expect(h.sink.ops).toEqual(["typing"]);
    expect(h.module.scheduler()).toBeNull();
  });
});

describe("scheduler (TS specifics)", () => {
  it("actions_that_exceed_the_execute_timeout_fail", async () => {
    const h = await harness({ execute_timeout_ms: 500 });
    await h.actions.submit(blocker());
    while (!h.sink.ops.includes("typing")) await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(500);
    const done = await nextDone(h.completed);
    expect(done).toMatchObject({ ok: false, error: "timed out" });
    await h.sup.stopAll();
  });

  it("sink_errors_become_failed_completions", async () => {
    const h = await harness();
    h.sink.send = async () => {
      throw new Error("discord is down");
    };
    await h.actions.submit(send("hi", "direct"));
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: "discord is down" });
    await h.sup.stopAll();
  });

  it("successful_send_reports_the_message_ref", async () => {
    const h = await harness();
    await h.actions.submit(send("hi", "direct"));
    const env = await h.completed.recv();
    expect(env?.source).toBe("scheduler");
    expect(env?.event).toEqual({
      type: "action_completed",
      data: {
        action: expect.any(String),
        turn: null,
        ok: true,
        error: null,
        message: { context: context("fake"), id: "m" },
      },
    });
    await h.sup.stopAll();
  });

  it("completion_events_carry_the_turn_as_correlation", async () => {
    const h = await harness();
    const turn = newId();
    await h.actions.submit(send("hi", "direct", { turn }));
    const env = await h.completed.recv();
    expect(env?.correlation).toBe(turn);
    await h.sup.stopAll();
  });

  it("says which line of hers an action was once it settled", async () => {
    const h = await harness();
    const settled = h.sup.bus.subscribe(ACTION_SETTLED_TOPIC);
    const turn = newId();
    const action = send("hi", "direct", { turn });
    await h.actions.submit(action);
    const env = await settled.recv();
    expect(env?.correlation).toBe(turn);
    const payload: ActionSettled = {
      action: action.id,
      turn,
      type: "send_message",
      context: context("fake"),
      text: "hi",
      ok: true,
      error: null,
      message: { context: context("fake"), id: "m" },
    };
    expect(env?.event).toEqual(customEvent(ACTION_SETTLED_TOPIC, payload as unknown as JsonValue));
    await h.sup.stopAll();
  });

  it("says when a line never went out, and nothing about what is no line", async () => {
    const h = await harness();
    const settled = h.sup.bus.subscribe(ACTION_SETTLED_TOPIC);
    const ctx = context("fake");
    const speak = newAction("voice:fake:g", "direct", {
      type: "speak",
      context: ctx,
      text: "沒有聲音",
      emotion: null,
    });
    const message: MessageRef = { context: ctx, id: "42" };
    await h.actions.submit(newAction("text:x", "direct", { type: "react", message, emoji: "👍" }));
    await h.actions.submit(speak);
    const env = await settled.recv();
    expect(env?.event).toMatchObject({
      data: {
        payload: { type: "speak", text: "沒有聲音", ok: false, error: "no voice sink" },
      },
    });
    expect(settled.tryRecv()).toBeNull();
    await h.sup.stopAll();
  });

  it("reacts_are_executed_on_the_platform_of_the_message", async () => {
    const h = await harness();
    const message: MessageRef = { context: context("fake"), id: "42" };
    await h.actions.submit(newAction("text:x", "direct", { type: "react", message, emoji: "👍" }));
    expect((await nextDone(h.completed)).ok).toBe(true);
    expect(h.sink.ops).toEqual(["react:👍"]);
    await h.sup.stopAll();
  });

  it("speak_without_a_voice_sink_fails", async () => {
    const h = await harness();
    const ctx: ContextKey = { ...context("fake"), kind: "voice" };
    await h.actions.submit(
      newAction(voiceLane("fake", "g"), "direct", {
        type: "speak",
        context: ctx,
        text: "hi",
        emotion: null,
      }),
    );
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: "no voice sink" });
    await h.sup.stopAll();
  });

  it("actuate_actions_run_through_the_executor_or_are_dropped", async () => {
    const h = await harness();
    const ran: string[] = [];
    const dropped: [string, string][] = [];
    const executor: ActuatorExecutor = {
      run: async (ticket) => {
        ran.push(ticket);
        return "ok";
      },
      dropped: (ticket, reason) => dropped.push([ticket, reason]),
    };
    const actuate = (ticket: string, options: Parameters<typeof newAction>[3] = {}) =>
      newAction(
        actLane("voice:fake:g"),
        "direct",
        { type: "actuate", capability: "voice.join", ticket, context: context("fake") },
        options,
      );
    await h.actions.submit(actuate("t0"));
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: "no actuator executor" });
    expect(dropped).toEqual([]);

    h.sup.services.provide("app", ActuatorExecutorKey, executor);
    await h.actions.submit(actuate("t1"));
    expect(await nextDone(h.completed)).toMatchObject({ ok: true });
    await h.actions.submit(actuate("t2", { ttl: 1000, now: Date.now() - 10_000 }));
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: "expired" });
    expect(ran).toEqual(["t1"]);
    expect(dropped).toEqual([["t2", "expired"]]);
    await h.sup.stopAll();
  });

  it("config_defaults_match_legacy", async () => {
    const { SchedulerConfigSchema } = await import("../src/index.js");
    expect(SchedulerConfigSchema.parse({})).toEqual({
      lane_idle_ms: 60_000,
      execute_timeout_ms: 30_000,
      speak_timeout_ms: 120_000,
    });
  });

  it("scheduler_class_is_the_provided_sink", async () => {
    const h = await harness();
    expect(h.actions).toBeInstanceOf(Scheduler);
    expect(h.module.scheduler()).toBe(h.actions);
    await h.sup.stopAll();
  });
});

/** Interrupts the first utterance (after `gate` is notified), completes the rest. */
class FakeVoice implements VoiceSink {
  readonly spoken: string[] = [];
  readonly gate = new Gate();

  async speak(
    _context: ContextKey,
    text: string,
    _emotion: string | null,
    _turn: TurnId | null,
  ): Promise<SpeakOutcome> {
    this.spoken.push(text);
    if (this.spoken.length === 1) {
      await this.gate.notified();
      return "interrupted";
    }
    return "completed";
  }
}

describe("scheduler voice", () => {
  it("interrupted_speech_drops_rest_of_turn", async () => {
    const h = await harness();
    const voice = new FakeVoice();
    h.sup.services.provide("app", VoiceSinkKey, voice);
    const ctx: ContextKey = { ...context("fake"), kind: "voice" };
    const lane = voiceLane("fake", "g");
    const speak = (text: string, turn: TurnId) =>
      newAction(lane, "direct", { type: "speak", context: ctx, text, emotion: null }, { turn });
    const [t1, t2] = [newId(), newId()];
    // "a1" holds the lane until notified, so the rest are queued behind it.
    for (const action of [speak("a1", t1), speak("a2", t1), speak("a3", t1), speak("b1", t2)]) {
      await h.actions.submit(action);
    }
    await vi.advanceTimersByTimeAsync(50);
    voice.gate.notifyOne();
    for (let i = 0; i < 4; i++) await nextDone(h.completed);
    expect(voice.spoken).toEqual(["a1", "b1"]);
    await h.sup.stopAll();
  });

  it("speech_uses_the_longer_timeout", async () => {
    const h = await harness({ execute_timeout_ms: 1000, speak_timeout_ms: 5000 });
    const voice = new FakeVoice();
    h.sup.services.provide("app", VoiceSinkKey, voice);
    const ctx: ContextKey = { ...context("fake"), kind: "voice" };
    await h.actions.submit(
      newAction(voiceLane("fake", "g"), "direct", {
        type: "speak",
        context: ctx,
        text: "long",
        emotion: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.completed.tryRecv()).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: "timed out" });
    await h.sup.stopAll();
  });
});

describe("the main line (pipeline v3)", () => {
  function mouthOf(h: Harness, owned: Set<string>): void {
    h.sup.services.provide("app", MouthKey, {
      owns: (turn) => turn !== null && owned.has(turn),
      say: async () => undefined,
    });
  }

  it("a line the main line does not own never goes out", async () => {
    vi.useRealTimers();
    const h = await harness();
    mouthOf(h, new Set(["mine"]));
    const stray = send("繞過主線", "direct", { turn: "other" });
    await h.actions.submit(stray);
    const done = await nextDone(h.completed);
    expect(done).toMatchObject({ action: stray.id, ok: false, error: NOT_MAIN_LINE });
    await h.actions.submit(send("沒有回合的", "direct"));
    expect(await nextDone(h.completed)).toMatchObject({ ok: false, error: NOT_MAIN_LINE });
    await h.actions.submit(send("她說的", "direct", { turn: "mine" }));
    expect(await nextDone(h.completed)).toMatchObject({ ok: true });
    await h.sup.stopAll();
  });

  it("what is not a line passes: typing, reactions, the gate's actions", async () => {
    vi.useRealTimers();
    const h = await harness();
    mouthOf(h, new Set());
    const ctx = context("fake");
    await h.actions.submit(
      newAction(textLane(ctx), "direct", {
        type: "react",
        message: { context: ctx, id: "m" },
        emoji: "ok",
      }),
    );
    expect(await nextDone(h.completed)).toMatchObject({ ok: true });
    await h.sup.stopAll();
  });

  it("without a mouth (v2) nothing changes", async () => {
    vi.useRealTimers();
    const h = await harness();
    await h.actions.submit(send("v2", "direct"));
    expect(await nextDone(h.completed)).toMatchObject({ ok: true });
    await h.sup.stopAll();
  });

  it("interruptTurn stops what is playing, not only what is queued", async () => {
    vi.useRealTimers();
    const h = await harness();
    let stopped = false;
    const voice: VoiceSink = {
      speak: (_c, _t, _e, _turn, signal) =>
        new Promise<SpeakOutcome>((resolve) => {
          signal?.addEventListener("abort", () => {
            stopped = true;
            resolve("interrupted");
          });
        }),
    };
    h.sup.services.provide("app", VoiceSinkKey, voice);
    const context: ContextKey = { platform: "fake", scope: "g", channel: "v", kind: "voice" };
    const speak = newAction(
      voiceLane("fake", "g"),
      "direct",
      { type: "speak", context, text: "一句很長的話", emotion: null },
      { turn: "t1" },
    );
    await h.actions.submit(speak);
    await new Promise((r) => setTimeout(r, 5));
    const scheduler = h.actions as Scheduler;
    await scheduler.interruptTurn("t1");
    const done = await nextDone(h.completed);
    expect(stopped).toBe(true);
    expect(done).toMatchObject({ action: speak.id, ok: false, error: "cancelled" });
    await h.sup.stopAll();
  });
});

describe("the emergency stop", () => {
  const settledOf = (sub: Subscription): ActionSettled[] => {
    const out: ActionSettled[] = [];
    for (let e = sub.tryRecv(); e !== null; e = sub.tryRecv()) {
      if (e.event.type === "custom") out.push(e.event.data.payload as unknown as ActionSettled);
    }
    return out;
  };

  it("drops everything queued and stops what is going out, whoever it belongs to", async () => {
    const h = await harness();
    const stopped: string[] = [];
    const voice: VoiceSink = {
      speak: (_context, text, _emotion, _turn, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            stopped.push(text);
            resolve("interrupted");
          });
        }),
    };
    h.sup.services.provide("app", VoiceSinkKey, voice);
    const ctx: ContextKey = { ...context("fake"), kind: "voice" };
    const lane = voiceLane("fake", "g");
    const speak = (text: string) =>
      newAction(lane, "direct", { type: "speak", context: ctx, text, emotion: null });
    await h.actions.submit(speak("說到一半(沒有回合)"));
    await h.actions.submit(speak("排隊中"));
    await holdLane(h);
    await h.actions.submit(send("文字排隊中", "direct"));
    await vi.advanceTimersByTimeAsync(10);
    expect(await h.actions.silence?.()).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toEqual(["說到一半(沒有回合)"]);
    expect(h.sink.ops).not.toContain("send:文字排隊中");
    await h.sup.stopAll();
  });

  it("while she is stopped a line meets `muted`; an action of the panel still runs", async () => {
    const h = await harness();
    const ran: string[] = [];
    const executor: ActuatorExecutor = {
      paused: true,
      run: async (ticket) => {
        ran.push(ticket);
        return "";
      },
      dropped: () => undefined,
    };
    h.sup.services.provide("app", ActuatorExecutorKey, executor);
    const settled = h.sup.bus.subscribe(ACTION_SETTLED_TOPIC);
    await h.actions.submit(send("還在講", "direct"));
    await h.actions.submit(
      newAction(actLane("x"), "system", {
        type: "actuate",
        capability: "voice.leave",
        ticket: "t",
        context: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(h.sink.ops).toEqual([]);
    expect(ran).toEqual(["t"]);
    expect(settledOf(settled)).toMatchObject([{ ok: false, error: MUTED }]);
    await h.sup.stopAll();
  });

  it("says when moderation replaced a line, from the turn or from the sink", async () => {
    const h = await harness();
    const settled = h.sup.bus.subscribe(ACTION_SETTLED_TOPIC);
    await h.actions.submit(send("Filtered.", "direct", { blocked: "test.word" }));
    await vi.advanceTimersByTimeAsync(20);
    h.sink.send = async (ctx) => ({ context: ctx, id: "m", blocked: "sink.rule" });
    await h.actions.submit(send("hello", "direct"));
    await vi.advanceTimersByTimeAsync(20);
    expect(settledOf(settled).map((s) => s.blocked)).toEqual(["test.word", "sink.rule"]);
    await h.sup.stopAll();
  });
});
