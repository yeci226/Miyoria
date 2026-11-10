// Tools by what she is doing (v2 §3.4) and claims backed by structured signals (§1.8 #5).

import { ActuatorRegistry, CapabilityTool, defineCapability } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type ActivityManager,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  type HerActivity,
  type HerPresence,
  type JsonValue,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { acceptedRequests, asksForGame, CLAIMS, unbackedClaim } from "../src/claims.js";
import { offeredIn, scopeOfSnapshot } from "../src/tool-scope.js";
import {
  channel,
  Harness,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

const AT = toTimestamp(Date.UTC(2026, 10, 3));

function snapshot(
  activity: HerActivity = { type: "idle", since: AT },
  presence: HerPresence = { type: "none" },
): ActivitySnapshot {
  return {
    version: 1,
    at: AT,
    presence,
    broadcast: { type: "off" },
    activity,
    override: null,
    scene: null,
  };
}

const PLAYING: HerActivity = {
  type: "game",
  target: "minecraft",
  phase: "running",
  task: null,
  failure: null,
  since: AT,
};

/** An ActivityManager that only answers reads. */
class FakeManager implements ActivityManager {
  readonly tasksList: ActivityTask[] = [];
  constructor(public current: ActivitySnapshot) {}
  snapshot(): ActivitySnapshot {
    return this.current;
  }
  async request(): Promise<never> {
    throw new Error("not in this test");
  }
  cancel(): boolean {
    return false;
  }
  task(id: string): ActivityTask | null {
    return this.tasksList.find((t) => t.id === id) ?? null;
  }
  tasks(): ActivityTask[] {
    return [...this.tasksList];
  }
}

/** A capability tool (the gated kind a game's `game.*` capabilities are) that records calls. */
class CapProbe extends CapabilityTool {
  readonly calls: JsonValue[] = [];

  constructor(name: string) {
    super(
      new ActuatorRegistry({
        services: new ServiceRegistry(),
        tools: new ToolRegistry(),
        builtins: false,
      }),
      defineCapability({
        name: name.replace("_", "."),
        summary: name,
        risk: "low",
        args: z.object({}),
        permission: null,
        tool: { name, description: name, properties: {} },
        async execute() {
          return "done";
        },
      }),
    );
  }

  override async call(_ctx: ToolContext, args: JsonValue): Promise<string> {
    this.calls.push(args);
    return "done";
  }
}

const tools = () => ({
  goal: new CapProbe("game_goal"),
  start: new CapProbe("game_start"),
  stop: new CapProbe("game_stop"),
  raw: new Probe("game_minecraft_act"),
  join: new Probe("voice_join"),
  leave: new Probe("voice_leave"),
  status: new Probe("voice_status"),
});

describe("tool scope", () => {
  it("offers no game tools while she is just chatting, the goal tool while a game runs", () => {
    const t = tools();
    const idle = scopeOfSnapshot(snapshot());
    expect(offeredIn(t.goal, idle)).toBe(false);
    expect(offeredIn(t.stop, idle)).toBe(false);
    expect(offeredIn(t.start, idle)).toBe(true);
    const playing = scopeOfSnapshot(snapshot(PLAYING));
    expect(offeredIn(t.goal, playing)).toBe(true);
    expect(offeredIn(t.stop, playing)).toBe(true);
    // A starting game already takes a goal (applied once the session runs).
    const starting = scopeOfSnapshot(snapshot({ ...PLAYING, phase: "starting" }));
    expect(offeredIn(t.goal, starting)).toBe(true);
    // A failed game is no game to steer.
    const failed = scopeOfSnapshot(snapshot({ ...PLAYING, phase: "failed" }));
    expect(offeredIn(t.goal, failed)).toBe(false);
  });

  it("never offers a game adapter's raw tool, whatever the state (or none known)", () => {
    const t = tools();
    expect(offeredIn(t.raw, scopeOfSnapshot(snapshot(PLAYING)))).toBe(false);
    expect(offeredIn(t.raw, null)).toBe(false);
    expect(offeredIn(t.goal, null)).toBe(true);
  });

  it("a chat turn gets the tools of the ActivityManager's snapshot", async () => {
    const manager = new FakeManager(snapshot());
    const chat = new MockProvider("chat").reply("好啊").reply("好啊");
    const t = tools();
    const h = await Harness.build("always", noCheck(), chat, null, {
      tools: Object.values(t),
      provide: (s) => s.provide("app", ActivityManagerKey, manager),
    });
    h.say(mention(channel("c"), "Owen", "在嗎"));
    await wait(3000);
    const offered = (chat.requests()[0]?.tools ?? []).map((s) => s.name);
    expect(offered).toEqual(["drop_note", "game_start", "keep_note", "react", "voice_join"]);

    manager.current = snapshot(PLAYING, {
      type: "in",
      channel: { platform: "test", scope: "guild", channel: "v", kind: "voice" },
      since: AT,
    });
    h.say(mention(channel("c"), "Owen", "去挖鐵"));
    await wait(3000);
    const playing = (chat.requests()[1]?.tools ?? []).map((s) => s.name);
    expect(playing).toEqual([
      "drop_note",
      "game_goal",
      "game_start",
      "game_stop",
      "keep_note",
      "react",
      "voice_join",
      "voice_leave",
      "voice_status",
    ]);
  });

  it("refuses a call of a tool that is not offered now", async () => {
    const manager = new FakeManager(snapshot());
    const chat = new MockProvider("chat")
      .events([
        toolCall(0, "c1", "game_goal", '{"text":"挖鐵"}'),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("沒在玩啦");
    const t = tools();
    const h = await Harness.build("always", noCheck(), chat, null, {
      tools: Object.values(t),
      provide: (s) => s.provide("app", ActivityManagerKey, manager),
    });
    h.say(mention(channel("c"), "Owen", "去挖鐵"));
    await wait(3000);
    expect(t.goal.calls).toHaveLength(0);
    expect(h.sink.texts()).toEqual(["沒在玩啦"]);
  });
});

describe("claims", () => {
  const offered = new Set(CLAIMS.map((c) => c.tool));
  const none = { requests: new Set<never>(), tools: new Set<string>(), scope: null };

  it("a claim nothing backs is caught; one a task, a notice or her state backs is not", () => {
    expect(unbackedClaim("好啦,我游過去了", offered, none)?.tool).toBe("voice_join");
    expect(
      unbackedClaim("好啦,我游過去了", offered, { ...none, requests: new Set(["ensure_voice"]) }),
    ).toBeNull();
    expect(
      unbackedClaim("好啦,我游過去了", offered, {
        ...none,
        scope: scopeOfSnapshot(
          snapshot(undefined, {
            type: "in",
            channel: { platform: "test", scope: "guild", channel: "v", kind: "voice" },
            since: AT,
          }),
        ),
      }),
    ).toBeNull();
    expect(unbackedClaim("開台了!", new Set(["voice_join"]), none)).toBeNull();
    expect(unbackedClaim("今天天氣不錯", offered, none)).toBeNull();
  });

  it("saying she stopped playing needs game_stop", () => {
    const playing = {
      ...none,
      scope: { game: "minecraft", singing: false, inVoice: true, live: false },
    };
    expect(unbackedClaim("好啦好啦,麥塊收掉,不玩了。", offered, playing)?.tool).toBe("game_stop");
    expect(
      unbackedClaim("不玩了", offered, { ...playing, tools: new Set(["game_stop"]) }),
    ).toBeNull();
  });

  it("only asking for a game counts as asking for it", () => {
    expect(asksForGame("來玩麥塊")).toBe(true);
    expect(asksForGame("開 Minecraft 啦")).toBe(true);
    expect(asksForGame("你不要再玩 Minecraft 了,拜託")).toBe(false);
    expect(asksForGame("Miyo,你先不要玩 Minecraft 啦")).toBe(false);
    expect(asksForGame("語音先來嘛 然後你來直播唱歌呀")).toBe(false);
  });

  it("promises and false states count as claims too", () => {
    const tool = (text: string) => unbackedClaim(text, offered, none)?.tool ?? null;
    expect(tool("算了,我重新進一次。等我一下")).toBe("voice_join");
    expect(tool("就說我在語音了啊,你是要我進幾次?")).toBe("voice_join");
    expect(tool("我馬上進語音")).toBe("voice_join");
    expect(tool("我再試一次開台,這次真的給我起來喔")).toBe("stream_start");
    expect(tool("好啦,我去開台")).toBe("stream_start");
  });

  it("refusing, asking or talking about it is no claim", () => {
    const tool = (text: string) => unbackedClaim(text, offered, none)?.tool ?? null;
    expect(tool("我不進語音")).toBeNull();
    expect(tool("別再進語音了")).toBeNull();
    expect(tool("你要不要開台?")).toBeNull();
    expect(tool("晚點看心情,不一定開台")).toBeNull();
    expect(tool("你們在語音嗎?")).toBeNull();
  });

  it("backing comes from her turn's tasks and the notices she was told", () => {
    const manager = new FakeManager(snapshot());
    const task = (id: string, turn: string | null, status: ActivityTask["status"]) =>
      ({
        id,
        resource: "presence",
        request: { type: "leave_voice" },
        by: "self",
        turn,
        context: null,
        status,
        created_at: AT,
        ended_at: null,
        failure: null,
        detail: null,
      }) satisfies ActivityTask;
    manager.tasksList.push(task("t1", "turn-a", "running"), task("t2", "turn-b", "failed"));
    expect([...acceptedRequests(manager, "turn-a", [])]).toEqual(["leave_voice"]);
    expect([...acceptedRequests(manager, "turn-b", [])]).toEqual([]);
    manager.tasksList.push({ ...task("t3", "turn-c", "done"), request: { type: "stop_live" } });
    const notice = {
      id: "n",
      at: AT,
      source: "activity",
      task: "t3",
      turn: "turn-c",
      context: null,
      ok: true,
      code: null,
      text: "關台了",
      expires_at: AT,
    };
    expect([...acceptedRequests(manager, "turn-z", [notice])]).toEqual(["stop_live"]);
    expect([...acceptedRequests(null, "turn-a", [notice])]).toEqual([]);
  });

  it("a successful tool call of her turn backs what she says next", async () => {
    const manager = new FakeManager(snapshot());
    const chat = new MockProvider("chat")
      .events([
        toolCall(0, "c1", "voice_join", "{}"),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好啦,我游過去了。");
    const join = new Probe("voice_join");
    const h = await Harness.build("always", noCheck(), chat, null, {
      tools: [join],
      provide: (s) => s.provide("app", ActivityManagerKey, manager),
    });
    h.say(mention(channel("c"), "Owen", "進語音"));
    await wait(3000);
    expect(join.calls).toHaveLength(1);
    expect(h.sink.texts()).toEqual(["好啦,我游過去了。"]);
    // Two model calls: the tool round and the reply; no reminder.
    expect(chat.requests()).toHaveLength(2);
  });
});
