// The main line end to end (docs/design/v3-architecture.md §10): the real agent, Floor and fact
// layer, a fake scheduler and a scripted model. What she says and does come from one call, a line
// that says something is done waits for `result: done`, a failed call still answers, and what the
// background wants only happens through a turn.

import { ActuatorRegistry, defineCapability } from "@miyoria/actions";
import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import { ServiceRegistry } from "@miyoria/kernel";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import { ToolRegistry } from "@miyoria/tools";
import {
  ACTION_SETTLED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  type Action,
  type ActionSettled,
  type ActivityManager,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  ArbiterKey,
  type ContextKey,
  customEvent,
  type Delivery,
  DeliveryLedgerKey,
  type Directives,
  DirectivesKey,
  EventLogKey,
  FloorKey,
  type JsonValue,
  type LogEvent,
  ModerationKey,
  type ModerationService,
  MouthKey,
  newId,
  type OutputCheck,
  PipelineKey,
  type PlaybackState,
  type Proposal,
  ProposalBoardKey,
  type SteerRequest,
  TaskSteerKey,
  TurnSilencerKey,
  toTimestamp,
  VoiceFloorKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MainLineConfigSchema } from "../src/config.js";
import { STARTED_LINE } from "../src/mainline/gate.js";
import { Hands, type Job } from "../src/mainline/hands.js";
import { FALLBACK_LINES, heardPart, sentences } from "../src/mainline/main.js";
import { resultData } from "../src/mainline/prompt.js";
import {
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  textDelta,
  toolCall,
  wait,
} from "./harness.js";

const VOICE: ContextKey = { platform: "test", scope: "guild", channel: "v1", kind: "voice" };

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 7, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** Plays `script` call by call (the last one repeats); a call may also fail or hang. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];

  constructor(readonly script: (StreamEvent[] | "fail" | "hang")[]) {}

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const step = (this.script.length > 1 ? this.script.shift() : this.script[0]) ?? [];
    if (step === "fail") throw new Error("the model is down");
    return (async function* (): ChatStream {
      if (step === "hang") {
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return;
      }
      for (const event of step) yield event;
    })();
  }
}

/** Text then calls, as a model writes them. */
function reply(text: string, ...calls: [string, string][]): StreamEvent[] {
  return [
    textDelta(text),
    ...calls.map(([name, args], i) => toolCall(i, `c${i}`, name, args)),
    done(),
  ];
}

/** The ActivityManager as far as the gate and the hands read it. */
class Body implements Partial<ActivityManager> {
  presence: ActivitySnapshot["presence"]["type"] = "none";
  list: ActivityTask[] = [];

  snapshot(): ActivitySnapshot {
    const at = toTimestamp(Date.now());
    const presence =
      this.presence === "in"
        ? ({ type: "in", channel: VOICE, since: at } as const)
        : ({ type: "none" } as const);
    return {
      version: 1,
      at,
      presence,
      broadcast: { type: "off" },
      activity: { type: "idle", since: at },
      override: null,
      scene: null,
    };
  }

  task(id: string): ActivityTask | null {
    return this.list.find((t) => t.id === id) ?? null;
  }

  tasks(): ActivityTask[] {
    return this.list;
  }

  started(turn: string): ActivityTask {
    const task: ActivityTask = {
      id: newId(),
      resource: "presence",
      request: { type: "leave_voice" },
      by: "self",
      turn,
      context: null,
      status: "running",
      created_at: toTimestamp(Date.now()),
      ended_at: null,
      failure: null,
      detail: null,
    };
    this.list.push(task);
    return task;
  }
}

interface RigOptions {
  tools?: Probe[];
  body?: Body;
  config?: JsonValue;
  arbiter?: JsonValue;
  provide?: (services: ServiceRegistry) => void;
  actuators?: ActuatorRegistry;
}

async function rig(chat: ChatProvider, options: RigOptions = {}): Promise<Harness> {
  return Harness.build(
    "normal",
    { ...(noCheck() as object), ...((options.config as object) ?? {}) },
    chat,
    null,
    {
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.actuators ? { actuators: options.actuators } : {}),
      provide: (services) => {
        services.provide("app", PipelineKey, { pipeline: "v3" as const });
        if (options.body) {
          services.provide("app", ActivityManagerKey, options.body as unknown as ActivityManager);
        }
        options.provide?.(services as unknown as ServiceRegistry);
      },
      before: [[new FactsModule(null, "p"), null]],
      modules: [
        [new ArbiterModule("p"), options.arbiter ?? { quiet_start_hour: 0, quiet_end_hour: 0 }],
      ],
    },
  );
}

/** The fake scheduler's answer to a line of text. */
function settle(h: Harness, action: Action, ok = true, error: string | null = null): void {
  const p = action.payload;
  if (p.type !== "send_message" && p.type !== "speak") throw new Error("not a line");
  const settled: ActionSettled = {
    action: action.id,
    turn: action.turn,
    type: p.type,
    context: p.context,
    text: p.type === "speak" ? p.text : p.message.text,
    ok,
    error,
    message: null,
  };
  h.sup.bus.publish(
    "scheduler",
    customEvent(ACTION_SETTLED_TOPIC, settled as unknown as JsonValue),
  );
}

function playback(h: Harness, action: Action, state: PlaybackState): void {
  const p = action.payload;
  if (p.type !== "speak") throw new Error("not speech");
  h.publish({
    type: "voice_playback",
    data: { context: p.context, turn: action.turn, state, text: p.text },
  });
}

function joinVoice(h: Harness, others = 1): void {
  const participants = Array.from({ length: others }, (_, i) => ({
    account: { platform: "test", id: `p${i}` },
    display_name: `P${i}`,
    is_self: false,
    muted: false,
    deafened: false,
  }));
  h.publish({ type: "voice_joined", data: { context: VOICE, participants } });
}

function utter(h: Harness, text: string): void {
  const at = toTimestamp(Date.now());
  h.publish({
    type: "voice_utterance",
    data: {
      id: newId(),
      context: VOICE,
      speaker: {
        account: { platform: "test", id: "p0" },
        display_name: "P0",
        is_bot: false,
      },
      text,
      language: null,
      emotion: null,
      audio_events: [],
      started_at: at,
      ended_at: at,
      asr_ms: 10,
    },
  });
}

function log(h: Harness): LogEvent[] {
  return h.sup.services.require(EventLogKey).recent(500);
}

const results = (h: Harness) =>
  log(h).flatMap((e) =>
    e.kind === "result" && e.source === "mainline.hands"
      ? [e.body as { tool: string; state: string }]
      : [],
  );

describe("one call", () => {
  it("what she says and does come from the same response, and she says it first", async () => {
    const tool = new Probe("thing");
    const llm = new Scripted([reply("好,等我一下", ["thing", "{}"]), reply("<silence/>")]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "幫我弄一下"));
    await wait(2000);
    expect(h.sink.texts()).toEqual(["好,等我一下"]);
    expect(tool.calls).toHaveLength(1);
    const decision = log(h).find((e) => e.kind === "decision" && e.source === "mainline");
    expect(decision?.body).toMatchObject({ claim: "addressed", actions: ["thing"], say: 1 });
  });

  it("a text answer alone is a whole output: nothing needs to parse", async () => {
    const h = await rig(new Scripted([reply("哈囉")]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    expect(h.sink.texts()).toEqual(["哈囉"]);
  });

  it("the mouth does not wait for the hands; the result comes back in a turn of its own", async () => {
    const slow = new Probe("slow", null, 5000);
    const llm = new Scripted([reply("我查一下", ["slow", "{}"]), reply("查到了")]);
    const h = await rig(llm, { tools: [slow], config: { tool_timeout_ms: 20_000 } });
    h.say(mention(channel("c"), "Alice", "查一下"));
    await wait(1500);
    expect(h.sink.texts()).toEqual(["我查一下"]);
    expect(llm.requests).toHaveLength(1);
    await wait(10_000);
    expect(h.sink.texts()).toEqual(["我查一下", "查到了"]);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("slow 完成");
  });

  it("a result someone asked for in text is told there, even while she is in voice", async () => {
    // 2026-11-08 14:46: 「我有多少魚幣」 got 「等我一下」; the wallet came back, but the turn that
    // tells it opened in the voice channel (keep_in_voice), found no result there and talked
    // about the song.
    const wallet = new Probe("check_coins", null, 5000);
    const llm = new Scripted([reply("等我一下", ["check_coins", "{}"]), reply("你有 10 魚幣")]);
    const h = await rig(llm, { tools: [wallet], config: { tool_timeout_ms: 20_000 } });
    joinVoice(h);
    await wait(50);
    h.say(mention(channel("c"), "Alice", "我有多少魚幣"));
    await wait(1500);
    expect(h.sink.texts()).toEqual(["等我一下"]);
    await wait(10_000);
    expect(h.sink.texts()).toEqual(["等我一下", "你有 10 魚幣"]);
    expect(h.sink.speeches()).toEqual([]);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("check_coins 完成");
  });

  it("an output that only acts still tells someone waiting that she heard them", async () => {
    const tool = new Probe("slow", null, 5000);
    const llm = new Scripted([reply("", ["slow", "{}"]), reply("<silence/>")]);
    const h = await rig(llm, { tools: [tool], config: { tool_timeout_ms: 20_000 } });
    h.say(mention(channel("c"), "Alice", "查一下"));
    await wait(1500);
    expect(h.sink.texts()).toEqual(["等我一下。"]);
  });

  it("the prompt has the layout of §10.4", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm);
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const messages = llm.requests[0]?.messages ?? [];
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content)).toContain("# 規則");
    expect(messages.at(-1)?.role).toBe("system");
    expect(String(messages.at(-1)?.content)).toContain("# 現在");
    expect(llm.requests[0]?.tools?.map((t) => t.name)).toContain("commit");
  });
});

describe("finished-tense lines (§10.1)", () => {
  const voiceJoin = () => new Probe("voice_join");

  it("a done line waits; accepted is not done; result: done lets it out", async () => {
    const body = new Body();
    const tool = voiceJoin();
    const llm = new Scripted([reply("我進語音了", ["voice_join", "{}"])]);
    const h = await rig(llm, { tools: [tool], body });
    // The tool only got a task started, as `voice.join` does.
    let task: ActivityTask | null = null;
    const call = tool.call.bind(tool);
    tool.call = async (ctx, args) => {
      task = body.started(ctx.turn);
      return call(ctx, args);
    };
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(2000);
    expect(h.sink.texts()).toEqual([STARTED_LINE]);
    expect(results(h).at(-1)).toMatchObject({ tool: "voice_join", state: "accepted" });

    const t = task as unknown as ActivityTask;
    t.status = "done";
    t.ended_at = toTimestamp(Date.now());
    h.sup.bus.publish(
      "activity",
      customEvent(ACTIVITY_DONE_TOPIC, {
        type: "done",
        task: t.id,
        request: t.request,
        turn: t.turn,
        detail: "進去了",
        at: toTimestamp(Date.now()),
      } as unknown as JsonValue),
    );
    await wait(100);
    expect(h.sink.texts()).toEqual([STARTED_LINE, "我進語音了"]);
    expect(results(h).at(-1)).toMatchObject({ tool: "voice_join", state: "done" });
  });

  it("when the result is failed the line is never said, and she hears why", async () => {
    const body = new Body();
    const tool = voiceJoin();
    const llm = new Scripted([reply("我進語音了", ["voice_join", "{}"]), reply("進不去,抱歉")]);
    const h = await rig(llm, { tools: [tool], body });
    tool.call = async () => {
      throw new Error("頻道滿了");
    };
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(5000);
    expect(h.sink.texts()).not.toContain("我進語音了");
    expect(h.sink.texts()).toContain("進不去,抱歉");
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("頻道滿了");
  });

  it("with no action behind it she is reminded once and may do it", async () => {
    const tool = voiceJoin();
    const llm = new Scripted([
      reply("我進語音了"),
      reply("好,我去", ["voice_join", "{}"]),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, { tools: [tool], body: new Body() });
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(3000);
    expect(tool.calls).toHaveLength(1);
    expect(h.sink.texts()).toEqual(["好,我去"]);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("voice_join");
  });

  it("the false claim never goes out when she will not do it either", async () => {
    const llm = new Scripted([reply("我進語音了"), reply("我進語音了")]);
    const h = await rig(llm, { tools: [voiceJoin()], body: new Body() });
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(3000);
    expect(h.sink.texts()).not.toContain("我進語音了");
    expect(llm.requests).toHaveLength(2);
  });

  it("coins only move by a tool: 「扣吧」 without accept_food is asked again", async () => {
    // 2026-11-08 15:23: 「從我錢包扣」 got 「好,扣吧扣吧」 and nothing was paid.
    const food = new Probe("accept_food");
    const llm = new Scripted([
      reply("好,扣吧扣吧,這碗我吃得心安理得。"),
      reply("好,扣吧扣吧,這碗我吃得心安理得。", ["accept_food", '{"item":"big_bowl"}']),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, { tools: [food] });
    h.say(mention(channel("c"), "Alice", "從我錢包扣"));
    await wait(3000);
    expect(food.calls).toHaveLength(1);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("accept_food");
  });

  it("a balance she was not told is a claim too; a refusal is not", async () => {
    const { ALL_CLAIMS } = await import("../src/claims.js");
    const said = (text: string) =>
      ALL_CLAIMS.filter((c) => c.finished.test(text)).map((c) => c.tool);
    expect(said("你只有 10 魚幣啦")).toEqual(["check_coins"]);
    expect(said("喂,你居然比我少這麼多?")).toEqual(["check_coins"]);
    expect(said("(收下)")).toEqual(["accept_food"]);
    expect(said("好啦,白飯收了")).toEqual(["accept_food"]);
    expect(said("一言為定,不准賴帳")).toEqual(["make_deal"]);
    expect(said("不收,我不吃這套")).toEqual([]);
    expect(said("自己查錢包啦")).toEqual([]);
  });

  it("「我在語音」 needs the state to be in", async () => {
    const body = new Body();
    const llm = new Scripted([reply("我在語音裡啊")]);
    const h = await rig(llm, { body });
    h.say(mention(channel("c"), "Alice", "你在哪"));
    await wait(2000);
    expect(h.sink.texts()).not.toContain("我在語音裡啊");

    body.presence = "in";
    const ok = await rig(new Scripted([reply("我在語音裡啊")]), { body });
    ok.say(mention(channel("c2"), "Alice", "你在哪"));
    await wait(2000);
    expect(ok.sink.texts()).toEqual(["我在語音裡啊"]);
  });

  it("the emergency stop: a line waiting for its result is gone, however the task ends", async () => {
    const body = new Body();
    const tool = voiceJoin();
    const llm = new Scripted([reply("我進語音了", ["voice_join", "{}"]), reply("<silence/>")]);
    const h = await rig(llm, { tools: [tool], body });
    let task: ActivityTask | null = null;
    const call = tool.call.bind(tool);
    tool.call = async (ctx, args) => {
      task = body.started(ctx.turn);
      return call(ctx, args);
    };
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(2000);
    expect(h.sink.texts()).toEqual([STARTED_LINE]);
    h.sup.services.require(TurnSilencerKey).silence("test");
    const t = task as unknown as ActivityTask;
    t.status = "done";
    h.sup.bus.publish(
      "activity",
      customEvent(ACTIVITY_DONE_TOPIC, {
        type: "done",
        task: t.id,
        request: t.request,
        turn: t.turn,
        detail: "進去了",
        at: toTimestamp(Date.now()),
      } as unknown as JsonValue),
    );
    await wait(100);
    expect(h.sink.texts()).toEqual([STARTED_LINE]);
  });

  it("works in voice: the sentence waits and the rest keep their order", async () => {
    const tool = new Probe("thing");
    const llm = new Scripted([
      reply("好喔。做好了。還有別的嗎?", ["thing", "{}"]),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, { tools: [tool], body: new Body() });
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 幫我弄");
    await wait(3000);
    const said = h.sink.speeches().map(([t]) => t);
    expect(said[0]).toBe("好喔。");
    // Everything after it waited, and the done line came with `result: done`.
    expect(said.slice(1)).toEqual([STARTED_LINE, "還有別的嗎?", "做好了。"]);
  });

  it("works for a steer too: not until `applied`", async () => {
    const steers: SteerRequest[] = [];
    const llm = new Scripted([
      reply("改好了", ["steer_task", '{"task":"t1","patch":{"item":"oak"},"why":"換目標"}']),
    ]);
    const h = await rig(llm, {
      provide: (services) => {
        services.provide("app", TaskSteerKey, {
          steer: async (request) => {
            steers.push(request);
            return {
              status: "accepted",
              steer: request.steer.id,
              task: "t1",
              budget_s: null,
              started_at: null,
            };
          },
          track: () => undefined,
          registerRoute: () => () => undefined,
        });
      },
    });
    h.sup.services.require(EventLogKey).observe(
      {
        source: "game.minecraft",
        silent: true,
        salience: "ambient",
        attention_key: "task:t1",
        revision: 1,
        summary: "任務開始:挖礦",
        addressed_to_her: false,
        from: null,
        context: null,
      },
      {
        buckets: [
          { op: "replace-self", writer: "game.minecraft.task", owner: null, untrusted: true },
        ],
      },
    );
    h.say(mention(channel("c"), "Alice", "換橡木"));
    await wait(2000);
    expect(steers[0]?.owner).toBe("game.minecraft");
    expect(steers[0]?.principal.kind).toBe("self");
    expect(h.sink.texts()).toEqual([STARTED_LINE]);

    h.sup.bus.publish(
      "game",
      customEvent("game.minecraft.task.steered", {
        type: "steered",
        task: "t1",
        steer: steers[0]?.steer.id ?? "",
        outcome: "applied",
        detail: "換了",
        at: toTimestamp(Date.now()),
      } as unknown as JsonValue),
    );
    await wait(100);
    expect(h.sink.texts()).toEqual([STARTED_LINE, "改好了"]);
  });

  it("a steer that came too late goes back to her context", async () => {
    const llm = new Scripted([
      reply("好", ["steer_task", '{"task":"t1","patch":{"item":"oak"},"why":"換"}']),
      reply("來不及了耶"),
    ]);
    const h = await rig(llm, {
      provide: (services) => {
        services.provide("app", TaskSteerKey, {
          steer: async (request) => ({
            status: "too_late",
            steer: request.steer.id,
            task: "t1",
            detail: "任務已經結束",
          }),
          track: () => undefined,
          registerRoute: () => () => undefined,
        });
      },
    });
    h.sup.services.require(EventLogKey).observe(
      {
        source: "game.minecraft",
        silent: true,
        salience: "ambient",
        attention_key: "task:t1",
        revision: 1,
        summary: "任務開始",
        addressed_to_her: false,
        from: null,
        context: null,
      },
      {
        buckets: [
          { op: "replace-self", writer: "game.minecraft.task", owner: null, untrusted: true },
        ],
      },
    );
    h.say(mention(channel("c"), "Alice", "換"));
    await wait(5000);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("任務已經結束");
    expect(h.sink.texts()).toContain("來不及了耶");
  });
});

describe("commitments (§10.2)", () => {
  it("a promise written as `commit` is kept in the log and shown to her", async () => {
    const llm = new Scripted([
      reply("晚點幫你", ["commit", '{"what":"幫 Alice 查資料","due_secs":600}']),
      reply("嗯"),
    ]);
    const h = await rig(llm);
    h.say(mention(channel("c"), "Alice", "幫我查"));
    await wait(2000);
    h.say(mention(channel("c"), "Alice", "還在嗎"));
    await wait(2000);
    const pinned = llm.requests[1]?.messages.filter((m) => m.role === "system") ?? [];
    expect(JSON.stringify(pinned)).toContain("幫 Alice 查資料");
  });

  it("a promise with nothing behind it becomes one by itself", async () => {
    const llm = new Scripted([reply("我去進語音"), reply("嗯")]);
    const h = await rig(llm, { tools: [new Probe("voice_join")], body: new Body() });
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(2000);
    const made = log(h).find((e) => e.source === "mainline.commitment");
    expect(made?.body).toMatchObject({
      commitment: { capability: "voice_join", status: "open" },
    });
  });

  it("overdue, it comes back: in the prompt and as a turn of its own", async () => {
    const llm = new Scripted([
      reply("晚點幫你", ["commit", '{"what":"進語音","due_secs":30}']),
      reply("抱歉我還沒做"),
    ]);
    const h = await rig(llm);
    h.say(mention(channel("c"), "Alice", "進語音"));
    await wait(2000);
    settle(h, h.sink.actions.find((a) => a.payload.type === "send_message") as Action);
    await wait(40_000);
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("逾期");
    expect(h.sink.texts()).toContain("抱歉我還沒做");
    const last = log(h).findLast((e) => e.source === "mainline.commitment");
    expect(last?.body).toMatchObject({ commitment: { status: "broken" } });
  });

  it("doing it keeps it", async () => {
    const tool = new Probe("thing");
    const llm = new Scripted([
      reply("晚點弄", ["commit", '{"what":"弄東西","tool":"thing","due_secs":600}']),
      reply("好", ["thing", "{}"]),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "弄"));
    await wait(2000);
    h.say(mention(channel("c"), "Alice", "現在弄"));
    await wait(3000);
    const last = log(h).findLast((e) => e.source === "mainline.commitment");
    expect(last?.body).toMatchObject({ commitment: { status: "kept" } });
  });
});

describe("the fixed line (§21)", () => {
  it("a failed call answers someone waiting instead of going silent", async () => {
    const h = await rig(new Scripted(["fail"]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    expect(FALLBACK_LINES).toContain(h.sink.texts()[0]);
    expect(h.sink.texts()).toHaveLength(1);
  });

  it("a model that never starts counts as failed", async () => {
    const h = await rig(new Scripted(["hang"]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(14_000);
    expect(h.sink.texts()).toEqual([]);
    await wait(3000);
    expect(FALLBACK_LINES).toContain(h.sink.texts()[0]);
  });

  it("an empty answer is no decision to be quiet; <silence/> is", async () => {
    const empty = await rig(new Scripted([[done()]]));
    empty.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    expect(empty.sink.texts()).toHaveLength(1);

    const quiet = await rig(new Scripted([reply("<silence/>")]));
    quiet.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    expect(quiet.sink.texts()).toEqual([]);
  });

  it("works in voice, goes through the ledger and frees the mic", async () => {
    const h = await rig(new Scripted(["fail"]));
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 你好嗎");
    await wait(2000);
    const speech = h.sink.speakActions()[0] as Action;
    expect(FALLBACK_LINES).toContain(h.sink.speeches()[0]?.[0]);
    const floor = h.sup.services.require(FloorKey);
    expect(floor.holder(VOICE)?.turn).toBe(speech.turn);
    playback(h, speech, "started");
    playback(h, speech, "finished");
    await wait(10);
    expect(floor.holder(VOICE)).toBeNull();
  });

  it("does not parrot itself: one per context per fallback_gap_ms", async () => {
    const h = await rig(new Scripted(["fail"]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    h.say(mention(channel("c"), "Alice", "嗨嗨"));
    await wait(2000);
    expect(h.sink.texts()).toHaveLength(1);
    await wait(20_000);
    h.say(mention(channel("c"), "Alice", "嗨嗨嗨"));
    await wait(2000);
    expect(h.sink.texts()).toHaveLength(2);
  });

  it("nobody waits for a line of her own: it just does not happen", async () => {
    const h = await rig(new Scripted(["fail"]));
    joinVoice(h);
    await wait(10);
    const board = h.sup.services.require(ProposalBoardKey);
    await board.propose({
      what: "聊聊天氣",
      why: "無聊",
      capability: "chat.start",
      expires: toTimestamp(Date.now() + 60_000),
      source: "plan",
      context: VOICE,
      about: null,
      person: null,
      goal: null,
    });
    await wait(3000);
    expect(h.sink.speeches()).toEqual([]);
    expect(h.sup.services.require(FloorKey).holder(VOICE)).toBeNull();
  });
});

describe("lines belong to the main line", () => {
  it("a voice line is delivered when playback finished, not when it was queued", async () => {
    const h = await rig(new Scripted([reply("你好。")]));
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 你好");
    await wait(2000);
    const ledger = h.sup.services.require(DeliveryLedgerKey);
    const speech = h.sink.speakActions()[0] as Action;
    expect(ledger.recent()).toEqual([]);
    playback(h, speech, "started");
    await wait(10);
    expect(ledger.recent()).toEqual([]);
    playback(h, speech, "finished");
    await wait(10);
    expect(ledger.recent().map((d: Delivery) => d.said)).toEqual(["你好。"]);
    const line = log(h).find((e) => e.kind === "utterance");
    expect(line?.source).toBe("mainline");
  });

  it("the facts bus does not open a line next to it", async () => {
    const h = await rig(new Scripted([reply("你好。")]));
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 你好");
    await wait(2000);
    const speech = h.sink.speakActions()[0] as Action;
    playback(h, speech, "started");
    playback(h, speech, "finished");
    await wait(10);
    expect(log(h).filter((e) => e.kind === "utterance")).toHaveLength(1);
  });

  it("a text line is delivered when the platform answered", async () => {
    const h = await rig(new Scripted([reply("嗨")]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const ledger = h.sup.services.require(DeliveryLedgerKey);
    expect(ledger.recent()).toEqual([]);
    settle(h, h.sink.actions.find((a) => a.payload.type === "send_message") as Action);
    await wait(10);
    expect(ledger.recent().map((d: Delivery) => d.said)).toEqual(["嗨"]);
  });

  it("every failure of a line frees the mic", async () => {
    const h = await rig(new Scripted([reply("你好。")]));
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 你好");
    await wait(2000);
    const speech = h.sink.speakActions()[0] as Action;
    const floor = h.sup.services.require(FloorKey);
    expect(floor.holder(VOICE)).not.toBeNull();
    settle(h, speech, false, "expired");
    await wait(10);
    expect(floor.holder(VOICE)).toBeNull();
    expect(h.sup.services.require(DeliveryLedgerKey).recent()).toEqual([]);
  });

  it("leaving the channel frees the mic with lines in flight", async () => {
    const h = await rig(new Scripted([reply("你好。")]));
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 你好");
    await wait(2000);
    h.publish({ type: "voice_left", data: { context: VOICE, reason: null } });
    await wait(10);
    expect(h.sup.services.require(FloorKey).holder(VOICE)).toBeNull();
  });

  it("history keeps only what was heard", async () => {
    const llm = new Scripted([
      reply("第一句說完了。第二句很長很長很長很長很長很長。"),
      reply("嗯"),
    ]);
    const h = await rig(llm);
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 說話");
    await wait(2000);
    const [first, second] = h.sink.speakActions() as [Action, Action];
    playback(h, first, "started");
    playback(h, first, "finished");
    playback(h, second, "started");
    await wait(540);
    playback(h, second, "interrupted");
    await wait(10);
    utter(h, "DeepSeek 再說");
    await wait(2000);
    const text = JSON.stringify(llm.requests[1]?.messages);
    expect(text).toContain("第一句說完了");
    expect(text).toContain("第二句");
    expect(text).toContain("(被打斷)");
    expect(text).not.toContain("很長很長很長");
  });

  it("voice's measure of what was heard beats the guess: the share of the audio", async () => {
    const llm = new Scripted([reply("一二三四五六七八九十。"), reply("嗯")]);
    const h = await rig(llm);
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 說話");
    await wait(2000);
    const [line] = h.sink.speakActions() as [Action];
    playback(h, line, "started");
    await wait(10);
    const p = line.payload as Extract<Action["payload"], { type: "speak" }>;
    // Long after it started by the clock, but only 30% of the audio was audible.
    await wait(9000);
    h.publish({
      type: "voice_playback",
      data: {
        context: p.context,
        turn: line.turn,
        state: "interrupted",
        text: p.text,
        heard_ms: 660,
        total_ms: 2200,
      },
    });
    await wait(10);
    utter(h, "DeepSeek 再說");
    await wait(2000);
    const text = JSON.stringify(llm.requests[1]?.messages);
    expect(text).toContain("一二三(被打斷)");
    expect(text).not.toContain("一二三四");
  });

  it("a sentence that failed to play is not in her history", async () => {
    const llm = new Scripted([reply("沒人聽到這句。"), reply("嗯")]);
    const h = await rig(llm);
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 說話");
    await wait(2000);
    const speech = h.sink.speakActions()[0] as Action;
    playback(h, speech, "started");
    playback(h, speech, "failed");
    await wait(10);
    utter(h, "DeepSeek 再說");
    await wait(2000);
    expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain("沒人聽到這句");
  });

  it("the mouth says what the panel typed, as a line like any other", async () => {
    const h = await rig(new Scripted([reply("嗯")]));
    joinVoice(h);
    await wait(10);
    const mouth = h.sup.services.require(MouthKey);
    await mouth.say({ context: VOICE, text: "大家好", source: "panel" });
    const action = h.sink.speakActions()[0] as Action;
    expect(mouth.owns(action.turn)).toBe(true);
    expect(mouth.owns(newId())).toBe(false);
    expect(log(h).find((e) => e.kind === "utterance")?.source).toBe("mainline");
  });
});

describe("a line moderation stopped", () => {
  const blocked = (h: Harness) => {
    const ledger = h.sup.services.require(DeliveryLedgerKey);
    return {
      delivered: ledger.recent({ limit: 10 }),
      retryable: ledger.retryable({ limit: 10 }),
      lines: log(h).filter((e) => e.kind === "result" && e.source.startsWith("delivery.")),
    };
  };
  const provide = (services: ServiceRegistry) => {
    services.provide("app", ModerationKey, {
      filteredLine: "Filtered.",
      filteredVoiceLine: "Filtered.",
      inspect: () => ({ action: "pass", flags: [], note: null }),
      screen: ({ visible, voice }: OutputCheck) => {
        const hit = [visible, voice].some((t) => t?.includes("禁語"));
        const blocked = hit
          ? [{ field: "visible", category: "custom", rule: "test.word", layer: "rules" }]
          : [];
        return { ok: !hit, visible: visible ?? null, voice: voice ?? null, blocked };
      },
    } as unknown as ModerationService);
  };

  it("written: not delivered, not retryable, and the mic is free", async () => {
    const h = await rig(new Scripted([reply("那個禁語")]), { provide });
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const [action] = h.sink.actions.filter((a) => a.payload.type === "send_message") as [Action];
    expect(action.blocked).toBe("test.word");
    settle(h, action);
    await wait(10);
    const { delivered, retryable, lines } = blocked(h);
    expect(delivered).toEqual([]);
    expect(retryable).toEqual([]);
    expect(lines.map((e) => e.body)).toMatchObject([{ delivery: "blocked", reason: "test.word" }]);
    expect(h.sup.services.require(FloorKey).holder(channel("c"))).toBeNull();
  });

  it("spoken: the same, once the filtered line played", async () => {
    const h = await rig(new Scripted([reply("那個禁語。")]), { provide });
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 說話");
    await wait(2000);
    const [line] = h.sink.speakActions() as [Action];
    expect(h.sup.services.require(FloorKey).holder(VOICE)).not.toBeNull();
    playback(h, line, "started");
    playback(h, line, "finished");
    settle(h, line);
    await wait(10);
    const { delivered, retryable, lines } = blocked(h);
    expect(delivered).toEqual([]);
    expect(retryable).toEqual([]);
    expect(lines.map((e) => e.body)).toMatchObject([{ delivery: "blocked" }]);
    expect(h.sup.services.require(FloorKey).holder(VOICE)).toBeNull();
  });

  it("the sink replaced it: the ledger hears that from the scheduler", async () => {
    const h = await rig(new Scripted([reply("沒問題的話")]));
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const [action] = h.sink.actions.filter((a) => a.payload.type === "send_message") as [Action];
    h.sup.bus.publish(
      "scheduler",
      customEvent(ACTION_SETTLED_TOPIC, {
        action: action.id,
        turn: action.turn,
        type: "send_message",
        context: { ...channel("c") },
        text: "沒問題的話",
        ok: true,
        error: null,
        message: null,
        blocked: "sink.rule",
      }),
    );
    await wait(10);
    expect(blocked(h).delivered).toEqual([]);
    expect(blocked(h).lines.map((e) => e.body)).toMatchObject([{ delivery: "blocked" }]);
  });

  it("the same thing can not be claimed again until it is something new", async () => {
    const h = await rig(new Scripted([reply("那個禁語。")]), { provide });
    const ledger = h.sup.services.require(DeliveryLedgerKey);
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const [action] = h.sink.actions.filter((a) => a.payload.type === "send_message") as [Action];
    settle(h, action);
    await wait(10);
    const body = log(h).find((e) => e.kind === "utterance")?.body as { attention_key: string };
    const same = { attention_key: body.attention_key, salience: "notable" as const };
    expect(ledger.mayClaim({ ...same, revision: 1 })).toBe(false);
    expect(ledger.mayClaim({ ...same, revision: 2 })).toBe(true);
  });
});

describe("interrupts", () => {
  it("someone calling her wraps up what she says on her own", async () => {
    const llm = new Scripted([reply("今天天氣真好。我們來聊聊吧。"), reply("怎麼了?")]);
    const h = await rig(llm);
    joinVoice(h);
    await wait(10);
    await h.sup.services.require(ProposalBoardKey).propose({
      what: "聊天氣",
      why: "想聊",
      capability: "chat.start",
      expires: toTimestamp(Date.now() + 60_000),
      source: "plan",
      context: VOICE,
      about: null,
      person: null,
      goal: null,
    });
    await wait(2000);
    const speech = h.sink.speakActions();
    expect(speech).toHaveLength(2);
    playback(h, speech[0] as Action, "started");
    await wait(10);
    utter(h, "DeepSeek 等一下");
    await wait(10);
    expect(h.sink.cancelled).toContain(speech[0]?.turn);
    const floor = h.sup.services.require(FloorKey);
    expect(floor.holder(VOICE)?.lines).toBe(1);
    playback(h, speech[0] as Action, "finished");
    await wait(2000);
    expect(h.sink.speeches().map(([t]) => t)).toContain("怎麼了?");
  });
});

describe("autonomy (§21 失去主動)", () => {
  function registry(ran: string[]): ActuatorRegistry {
    const tools = new ToolRegistry();
    const actuators = new ActuatorRegistry({
      services: new ServiceRegistry(),
      tools,
      publish: () => undefined,
    });
    actuators.register(
      defineCapability({
        name: "chess.play",
        summary: "下棋",
        risk: "low",
        args: z.object({}),
        permission: null,
        async execute() {
          ran.push("chess.play");
          return { text: "開始了", data: null };
        },
      }),
    );
    return actuators;
  }

  const proposal = {
    what: "想玩一下麥塊",
    why: "好久沒玩了",
    capability: "chess.play",
    args: {},
    source: "plan",
    about: null,
    person: null,
    goal: null,
  };

  it("what her Plan wants, the main line carries out, by her own decision", async () => {
    const tool = new Probe("chess_play");
    const llm = new Scripted([reply("我去開麥塊!", ["chess_play", "{}"]), reply("<silence/>")]);
    const ran: string[] = [];
    const h = await rig(llm, { tools: [tool], actuators: registry(ran) });
    h.say(incoming(channel("c"), "Alice", "嗨"));
    await wait(2000);
    const c = channel("c");
    const outcome = await h.sup.services.require(ProposalBoardKey).propose({
      ...proposal,
      context: c,
      expires: toTimestamp(Date.now() + 120_000),
    });
    expect(outcome.state).toBe("taken");
    await wait(3000);
    // The capability only ran through the turn's own action.
    expect(ran).toEqual([]);
    expect(tool.calls).toHaveLength(1);
    expect(JSON.stringify(llm.requests.at(-2)?.messages)).toContain("好久沒玩了");
    const board = h.sup.services.require(ProposalBoardKey);
    expect(board.open()).toEqual([]);
    expect(h.sink.texts()).toContain("我去開麥塊!");
  });

  it("she can decline: nothing runs, and the turn says so", async () => {
    const tool = new Probe("chess_play");
    const llm = new Scripted([reply("<silence/>")]);
    const h = await rig(llm, { tools: [tool], actuators: registry([]) });
    h.say(incoming(channel("c"), "Alice", "嗨"));
    await wait(2000);
    await h.sup.services.require(ProposalBoardKey).propose({
      ...proposal,
      context: channel("c"),
      expires: toTimestamp(Date.now() + 120_000),
    });
    await wait(3000);
    expect(tool.calls).toEqual([]);
    const ended = log(h).findLast((e) => e.kind === "result" && e.source === "mainline");
    expect(ended?.body).toMatchObject({ state: "declined" });
  });

  it("with nobody there she still acts, and says nothing", async () => {
    const tool = new Probe("chess_play");
    const llm = new Scripted([reply("開麥塊!", ["chess_play", "{}"])]);
    const h = await rig(llm, { tools: [tool], actuators: registry([]) });
    await h.sup.services.require(ProposalBoardKey).propose({
      ...proposal,
      context: null,
      expires: toTimestamp(Date.now() + 120_000),
    });
    await wait(3000);
    expect(tool.calls).toHaveLength(1);
    expect(h.sink.actions).toEqual([]);
    expect(llm.requests).toHaveLength(1);
  });

  it("a wish that may not talk now stays on the board and she sees it next time", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm);
    joinVoice(h, 0);
    await wait(10);
    const board = h.sup.services.require(ProposalBoardKey);
    const outcome = await board.propose({
      what: "想問大家晚餐吃什麼",
      why: "好奇",
      capability: "chat.start",
      expires: toTimestamp(Date.now() + 600_000),
      source: "plan",
      context: VOICE,
      about: null,
      person: null,
      goal: null,
    });
    expect(outcome.state).not.toBe("taken");
    expect(board.open(VOICE)).toHaveLength(1);
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(2000);
    expect(JSON.stringify(llm.requests[0]?.messages)).not.toContain("想問大家晚餐吃什麼");
    utter(h, "DeepSeek 在嗎");
    await wait(2000);
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain("想問大家晚餐吃什麼");
  });

  it("a rule on her game drops the proposal, in the log", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, { tools: [new Probe("chess_play")], actuators: registry([]) });
    const arbiter = h.sup.services.require(ArbiterKey) as unknown as {
      hold(capability: string, reason: string, ms: number): void;
    };
    arbiter.hold("chess.play", "主人叫你先別玩", 60_000);
    const outcome = await h.sup.services.require(ProposalBoardKey).propose({
      ...proposal,
      context: channel("c"),
      expires: toTimestamp(Date.now() + 120_000),
    });
    expect(outcome.state).toBe("dropped");
    expect(llm.requests).toEqual([]);
  });
});

describe("mute (§21 她變啞巴)", () => {
  it("being called always gets an answer: budget spent, room unanswered", async () => {
    const llm = new Scripted([reply("嗯?")]);
    const h = await rig(llm, {
      arbiter: { max_unanswered: 1, quiet_start_hour: 0, quiet_end_hour: 0 },
    });
    joinVoice(h);
    await wait(10);
    await h.sup.services.require(ProposalBoardKey).propose({
      what: "聊聊",
      why: "想",
      capability: "chat.start",
      expires: toTimestamp(Date.now() + 60_000),
      source: "plan",
      context: VOICE,
      about: null,
      person: null,
      goal: null,
    });
    await wait(2000);
    const first = h.sink.speakActions()[0] as Action;
    playback(h, first, "started");
    playback(h, first, "finished");
    await wait(10);
    const floor = h.sup.services.require(FloorKey);
    expect(floor.budget(VOICE).waiting_for_response).toBe(true);
    expect(floor.refuses("notable", VOICE)).not.toBeNull();
    utter(h, "DeepSeek 你在嗎");
    await wait(2000);
    expect(h.sink.speakActions().length).toBeGreaterThanOrEqual(2);
  });

  it("she keeps joining in when the room is alive: ambient talk is not shut out", async () => {
    const h = await rig(new Scripted([reply("真的嗎")]), { config: { default_mode: "lively" } });
    h.say(incoming(channel("c"), "Alice", "今天天氣真好,大家覺得呢?"));
    await wait(3000);
    const floor = h.sup.services.require(FloorKey);
    expect(floor.refuses("ambient", channel("c"))).toBeNull();
  });
});

describe("the owner's rules (§9, §10.4)", () => {
  function rules(deny: string[]) {
    return {
      inject: () => ["不要玩 Minecraft"],
      wishes: () => ["觀眾想看唱歌"],
      filterTools: <T extends { name: string }>(tools: readonly T[]) =>
        tools.filter((t) => !deny.includes(t.name)),
      screen: (p: Proposal) =>
        p.capability === "chess.play"
          ? ({ outcome: "deny", directive: "d1", reason: "主人說不要" } as const)
          : ({ outcome: "allow" } as const),
    } as unknown as Directives;
  }

  it("are in the fixed block on every turn, and a forbidden tool is not on the list", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, {
      tools: [new Probe("chess_play"), new Probe("thing")],
      provide: (services) => services.provide("app", DirectivesKey, rules(["chess_play"])),
    });
    h.say(mention(channel("c"), "Alice", "下棋"));
    await wait(2000);
    const request = llm.requests[0];
    expect(String(request?.messages[1]?.content)).toContain("不要玩 Minecraft");
    expect(request?.tools?.map((t) => t.name)).toEqual([
      "drop_note",
      "keep_note",
      "react",
      "thing",
      "commit",
    ]);
    const viewers = request?.messages.filter((m) => String(m.content).includes("觀眾想看唱歌"));
    expect(viewers?.map((m) => m.role)).toEqual(["user"]);
  });

  it("a proposal that breaks one stops at the board", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, {
      provide: (services) => services.provide("app", DirectivesKey, rules([])),
    });
    const outcome = await h.sup.services.require(ProposalBoardKey).propose({
      what: "下棋",
      why: "想",
      capability: "chess.play",
      expires: toTimestamp(Date.now() + 60_000),
      source: "plan",
      context: channel("c"),
      about: null,
      person: null,
      goal: null,
    });
    expect(outcome).toMatchObject({ state: "dropped", detail: "主人說不要" });
    expect(llm.requests).toEqual([]);
  });
});

describe("helpers", () => {
  it("heardPart keeps what fits in the time", () => {
    expect(heardPart("一二三四五", 360, 180)).toBe("一二");
    expect(heardPart("一二", 10_000, 180)).toBe("一二");
    expect(heardPart("一二", 0, 180)).toBe("");
  });

  it("sentences keeps punctuation", () => {
    expect(sentences("好喔。做好了!\n還有嗎")).toEqual(["好喔。", "做好了!\n", "還有嗎"]);
  });

  it("the prompt has no token cap unless the owner sets one", () => {
    expect(MainLineConfigSchema.parse({}).prompt_tokens).toBeNull();
    expect(MainLineConfigSchema.parse({ prompt_tokens: 4000 }).prompt_tokens).toBe(4000);
  });
});

describe("a tool written as text (11-08: `<sing_request>` in her reply)", () => {
  const commitments = (h: Harness) =>
    log(h).flatMap((e) =>
      e.source === "mainline.commitment"
        ? [
            (e.body as { commitment: { capability: string | null; what: string; status: string } })
              .commitment,
          ]
        : [],
    );

  it("she is asked once, in the same turn, and the native call is what runs", async () => {
    const tool = new Probe("sing_request");
    const llm = new Scripted([
      reply("好,我幫你點<sing_request>"),
      reply("", ["sing_request", '{"query":"夜に駆ける"}']),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "點夜に駆ける"));
    await wait(3000);
    expect(tool.calls).toHaveLength(1);
    expect(String(llm.requests[1]?.messages.at(-1)?.content)).toContain("寫成文字");
    expect(String(llm.requests[1]?.messages.at(-1)?.content)).toContain("sing_request");
    expect(h.sink.texts()).toEqual(["好,我幫你點"]);
    expect(commitments(h)).toEqual([]);
  });

  it("a tag someone else wrote, or a tool not on offer, never asks for anything", async () => {
    const tool = new Probe("sing_request");
    const llm = new Scripted([reply("<sing_request> 是什麼?<sing_start>")]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "你打 <sing_request> 看看"));
    await wait(3000);
    expect(llm.requests).toHaveLength(1);
    expect(tool.calls).toEqual([]);
    expect(commitments(h)).toEqual([]);
  });

  it("not called after all, it is a promise she has to keep or take back", async () => {
    const tool = new Probe("sing_request");
    const llm = new Scripted([reply("好,我幫你點<sing_request>"), reply("嗯嗯"), reply("抱歉")]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "點一首"));
    await wait(3000);
    expect(llm.requests).toHaveLength(2);
    expect(tool.calls).toEqual([]);
    expect(commitments(h).at(-1)).toMatchObject({
      capability: "sing_request",
      status: "open",
      what: expect.stringContaining("我幫你點"),
    });
    for (const a of h.sink.actions) if (a.payload.type === "send_message") settle(h, a);
    await wait(130_000);
    const overdue = llm.requests.slice(2).map((r) => JSON.stringify(r.messages));
    expect(overdue.some((m) => m.includes("逾期") && m.includes("sing_request"))).toBe(true);
  });

  it("in voice a correction that does not start soon is given up; what she said stands", async () => {
    const tool = new Probe("sing_start");
    const llm = new Scripted([reply("好喔,我來唱。<sing_start>"), "hang", reply("<silence/>")]);
    const h = await rig(llm, { tools: [tool], body: new Body() });
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 唱首歌");
    await wait(8000);
    expect(llm.requests).toHaveLength(2);
    expect(tool.calls).toEqual([]);
    const said = h.sink.speeches().map(([t]) => t);
    expect(said).toEqual(["好喔,我來唱。"]);
    expect(said.some((t) => FALLBACK_LINES.includes(t))).toBe(false);
    expect(commitments(h).at(-1)).toMatchObject({ capability: "sing_start", status: "open" });
  });

  it("with no tool step left (max_tool_steps) she is not asked again", async () => {
    const tool = new Probe("sing_request");
    const llm = new Scripted([reply("好,我幫你點<sing_request>")]);
    const h = await rig(llm, { tools: [tool], config: { max_tool_steps: 0 } });
    h.say(mention(channel("c"), "Alice", "點一首"));
    await wait(3000);
    expect(llm.requests).toHaveLength(1);
    expect(commitments(h).at(-1)).toMatchObject({ capability: "sing_request" });
  });
});

describe("what she started and did not get done (§10.1)", () => {
  it("a failure comes back with its reason for her to explain in her own words", async () => {
    const tool = new Probe("sing_request");
    tool.call = async () => {
      throw new Error("already 2 songs requested by this person");
    };
    const llm = new Scripted([
      reply("好,我幫你點", ["sing_request", '{"query":"x"}']),
      reply("啊,你已經點兩首了,等唱完再點喔"),
    ]);
    const h = await rig(llm, { tools: [tool] });
    h.say(mention(channel("c"), "Alice", "點 x"));
    await wait(5000);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain(
      "already 2 songs requested by this person",
    );
    expect(h.sink.texts()).toEqual(["好,我幫你點", "啊,你已經點兩首了,等唱完再點喔"]);
  });

  it("what failed while nobody was there is in her next prompt, with why", async () => {
    const tool = new Probe("chess_play");
    tool.call = async () => {
      throw new Error("stage node did not answer in time");
    };
    const llm = new Scripted([reply("", ["chess_play", "{}"]), reply("嗯")]);
    const actuators = new ActuatorRegistry({
      services: new ServiceRegistry(),
      tools: new ToolRegistry(),
      publish: () => undefined,
    });
    actuators.register(
      defineCapability({
        name: "chess.play",
        summary: "下棋",
        risk: "low",
        args: z.object({}),
        permission: null,
        async execute() {
          return { text: "開始了", data: null };
        },
      }),
    );
    const h = await rig(llm, { tools: [tool], actuators });
    await h.sup.services.require(ProposalBoardKey).propose({
      what: "想下棋",
      why: "無聊",
      capability: "chess.play",
      args: {},
      source: "plan",
      about: null,
      person: null,
      goal: null,
      context: null,
      expires: toTimestamp(Date.now() + 120_000),
    });
    await wait(3000);
    expect(results(h).at(-1)).toMatchObject({ tool: "chess_play", state: "failed" });
    // Nobody was there: no turn of its own.
    expect(llm.requests).toHaveLength(1);
    h.say(mention(channel("c"), "Alice", "嗨"));
    await wait(3000);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain(
      "stage node did not answer in time",
    );
  });

  it("a song holds the voice channel: the result waits for it, then she hears why", async () => {
    let song: string | null = "song";
    const tool = new Probe("sing_request");
    tool.call = async () => {
      throw new Error("already 2 songs requested by this person");
    };
    const llm = new Scripted([
      reply("好喔,點了。", ["sing_request", '{"query":"x"}']),
      reply("剛剛那首沒點成,你已經點兩首了。"),
    ]);
    const h = await rig(llm, {
      tools: [tool],
      body: new Body(),
      provide: (services) => {
        services.provide("app", VoiceFloorKey, { holder: () => song });
      },
    });
    joinVoice(h);
    await wait(10);
    utter(h, "DeepSeek 幫我點 x");
    await wait(2000);
    // Her line is over (the mic is free): only the song is in the way now.
    for (const a of h.sink.actions) {
      if (a.payload.type !== "speak") continue;
      playback(h, a, "started");
      playback(h, a, "finished");
    }
    await wait(20_000);
    // No turn while she sings: it would wait behind the song and be dropped.
    expect(llm.requests).toHaveLength(1);
    song = null;
    await wait(12_000);
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("already 2 songs");
  });
});

describe("the hands merge repeats", () => {
  const where = channel("c");

  function hands(): { hands: Hands; told: Job[] } {
    const told: Job[] = [];
    const h = new Hands({
      log: () => null,
      now: () => Date.now(),
      activity: () => null,
      told: (_, job) => told.push(job),
      release: () => undefined,
      finished: () => undefined,
    });
    return { hands: h, told };
  }

  function fail(h: Hands, requester: unknown, detail = "stage node did not answer in time"): void {
    const job = h.begin({
      turn: newId(),
      context: where,
      tool: "stream_start",
      args: {},
      report: "turn",
      depth: 0,
      requester,
      cause: null,
    });
    h.answered(job, { ok: false, text: detail, data: null });
  }

  it("her own attempt failing the same way again is no new turn, and one line", () => {
    const { hands: h, told } = hands();
    fail(h, undefined);
    vi.advanceTimersByTime(60_000);
    fail(h, undefined);
    expect(told).toHaveLength(1);
    expect(resultData(h.takeResults(where))).toContain(
      "stream_start 失敗:stage node did not answer in time(2 次)",
    );
    // Another reason is news.
    fail(h, undefined, "OBS 沒開");
    expect(told).toHaveLength(2);
  });

  it("someone who asked always hears back", () => {
    const { hands: h, told } = hands();
    fail(h, { who: "Alice" });
    fail(h, { who: "Alice" });
    expect(told).toHaveLength(2);
  });

  it("a result says whose it is: the name and words of the message it answered", () => {
    const { hands: h } = hands();
    const asked = {
      author: { account: { platform: "test", id: "b" }, display_name: "b.netanyahu" },
      text: "@Miyoria 我有多少魚幣",
    };
    const job = h.begin({
      turn: newId(),
      context: where,
      tool: "check_coins",
      args: {},
      report: "turn",
      depth: 0,
      requester: asked,
      cause: null,
    });
    h.answered(job, { ok: true, text: "對方自己的錢包:有 10 魚幣", data: null });
    expect(resultData(h.takeResults(where))).toContain(
      "check_coins 完成(b.netanyahu 問的「@Miyoria 我有多少魚幣」):對方自己的錢包:有 10 魚幣",
    );
    // Her own doing names nobody.
    fail(h, undefined);
    expect(resultData(h.takeResults(where))).toContain("stream_start 失敗:stage");
  });

  it("a result stays unsaid until a turn that showed it concludes", () => {
    const { hands: h } = hands();
    fail(h, { who: "Alice" }, "她吃飽了,吃不下");
    // A turn showed it and was cancelled: the next one still gets it.
    expect(h.peekResults(where)).toHaveLength(1);
    expect(h.peekResults(where)).toHaveLength(1);
    h.toldOf(h.peekResults(where));
    expect(h.peekResults(where)).toEqual([]);
  });

  it("long after, the same failure is news again", () => {
    const { hands: h, told } = hands();
    fail(h, undefined);
    vi.advanceTimersByTime(6 * 60_000);
    fail(h, undefined);
    expect(told).toHaveLength(2);
  });
});
