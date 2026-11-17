// From V2 bus events to log lines: keys, salience and silence by rule, the buckets they fill, the
// lines of hers and the `cause` chains stitched from what V2 events share.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type ActivitySnapshot,
  type ActivityTaskEvent,
  type AnyEventDefinition,
  type BusEnvelope,
  type ContextKey,
  type EventPayload,
  Events,
  eventEnvelope,
  type IncomingMessage,
  type InputCheck,
  type InputVerdict,
  type JsonValue,
  type LogEvent,
  ModerationKey,
  type ModerationService,
  type Notice,
  type Observation,
  type PublishMetaArgs,
  type TaskEvent,
  type TurnFocus,
  type TurnOutcomeRecord,
  taskTopic,
  toTimestamp,
  type VoiceUtterance,
} from "@miyoria/types";
import { beforeEach, describe, expect, it } from "vitest";
import { BusFacts } from "../src/bus.js";
import { defaultFactsConfig } from "../src/config.js";
import { observationBody, WorkingContextView } from "../src/context.js";
import { DeliveryLedgerView } from "../src/delivery.js";
import { EventLogService } from "../src/log.js";
import { RevisionBook } from "../src/revisions.js";

const T0 = Date.UTC(2026, 10, 7, 12);
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const OWEN = { platform: "discord", id: "100" };
const HER = { platform: "discord", id: "999" };

let now = T0;
let log: EventLogService;
let ledger: DeliveryLedgerView;
let context: WorkingContextView;
let bus: BusFacts;

beforeEach(async () => {
  now = T0;
  const clock = { now: () => now };
  log = new EventLogService({ profile: "p", store: null, clock, hotEvents: 10_000 });
  ledger = new DeliveryLedgerView(log, { clock });
  context = new WorkingContextView();
  const revisions = new RevisionBook();
  for (const p of [revisions, context, ledger]) await log.project(p);
  bus = new BusFacts({
    log,
    revisions,
    config: defaultFactsConfig(),
    names: ["Miyoria", "米優"],
  });
  send("voice.link", Events.PlatformReady, { platform: "discord", self_account: HER });
});

/** Hands the facts one event of `definition` from `source`, published now. */
function send<D extends AnyEventDefinition>(
  source: string,
  definition: D,
  data: EventPayload<D>,
  meta: { turn?: string | null; type?: string } = {},
): BusEnvelope {
  const env = eventEnvelope(
    source,
    definition,
    data,
    ...([{ now, ...meta }] as PublishMetaArgs<D>),
  );
  bus.handle(env);
  return env;
}

const observations = (): Observation[] =>
  log.recent(10_000).flatMap((e) => {
    const o = observationBody(e)?.observation;
    return o ? [o] : [];
  });

const last = (): Observation => observations().at(-1) as Observation;

function lines(kind: LogEvent["kind"]): LogEvent[] {
  return log.recent(10_000).filter((e) => e.kind === kind);
}

function utterance(text: string, id = "u1"): VoiceUtterance {
  return {
    id,
    context: VOICE,
    speaker: { account: OWEN, display_name: "Owen", is_bot: false },
    text,
    language: null,
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(now),
    ended_at: toTimestamp(now),
    asr_ms: 100,
  };
}

function message(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: { context: TEXT, id: "m1" },
    author: { account: OWEN, display_name: "Owen", is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(now),
    ...over,
  };
}

function focus(turn: string, ids: string[], context_ = VOICE): TurnFocus {
  return {
    turn,
    context: context_,
    reason: "addressed",
    phase: "generating",
    addressed_by: ["Owen"],
    addressed_accounts: [OWEN],
    focus: ids.map((id) => ({ context: context_, id })),
    background: [],
    restarts: 0,
    started_at: toTimestamp(now),
    updated_at: toTimestamp(now),
  };
}

function gameEvent(kind: string, data: object | null, important = false) {
  return send(
    "ext.minecraft",
    Events.GameAdapterEvent,
    { type: kind, data: data as JsonValue, important },
    { type: `game.minecraft.${kind}` },
  );
}

/** `send` with a payload that holds only what the writer reads, not all its schema asks for. */
function loose(
  source: string,
  definition: AnyEventDefinition,
  data: unknown,
  meta: { turn?: string | null; type?: string } = {},
): BusEnvelope {
  return send(source, definition, data, meta);
}

const TASK_EVENTS = {
  started: Events.TaskStarted,
  progress: Events.TaskProgress,
  done: Events.TaskDone,
  failed: Events.TaskFailed,
  steered: Events.TaskSteered,
} as const;

/** One of the minecraft executor's task events, on `topic`. */
function task(topic: string, event: TaskEvent): BusEnvelope {
  return send("ext.minecraft", TASK_EVENTS[event.type], event as never, { type: topic });
}

describe("what people say", () => {
  it("a voice transcript nobody addressed to her stays silent", () => {
    send("voice.link", Events.VoiceUtteranceEvent, utterance("今天好冷"));
    expect(last()).toMatchObject({
      source: "voice.asr",
      silent: true,
      salience: "ambient",
      attention_key: "voice:utterance:u1",
      revision: 1,
      addressed_to_her: false,
      from: "Owen",
      context: VOICE,
    });
    expect(context.bucket("voice.asr")?.entries[0]).toMatchObject({
      text: "Owen:今天好冷",
      untrusted: true,
    });
  });

  it("saying her name addresses her", () => {
    send("voice.link", Events.VoiceUtteranceEvent, utterance("米優你在嗎"));
    expect(last()).toMatchObject({ silent: false, salience: "notable", addressed_to_her: true });
  });

  it("a mention, a reply and a DM address her", () => {
    send("discord", Events.PlatformMessageCreated, message("嗨", { mentions_self: true }));
    expect(last().addressed_to_her).toBe(true);
    send("discord", Events.PlatformMessageCreated, message("嗨", { reply_to_self: true }));
    expect(last().addressed_to_her).toBe(true);
    const dm: ContextKey = { platform: "discord", scope: null, channel: "d", kind: "dm" };
    send(
      "discord",
      Events.PlatformMessageCreated,
      message("嗨", { id: { context: dm, id: "m2" } }),
    );
    expect(last().addressed_to_her).toBe(true);
    send("discord", Events.PlatformMessageCreated, message("大家好"));
    expect(last()).toMatchObject({
      addressed_to_her: false,
      silent: true,
      source: "platform.discord",
      attention_key: "msg:discord:m1",
    });
  });

  it("her own messages and empty transcripts are not perceived", () => {
    send(
      "discord",
      Events.PlatformMessageCreated,
      message("我說的", { author: { account: HER, display_name: "M", is_bot: true } }),
    );
    send("voice.link", Events.VoiceUtteranceEvent, utterance("   "));
    expect(observations()).toEqual([]);
  });

  it("keeps the bus event, for the replay", () => {
    const env = send("discord", Events.PlatformMessageCreated, message("嗨"));
    const event = log.recent().at(-1) as LogEvent;
    expect(event.id).toBe(env.id);
    expect(event.at).toBe(env.at);
    expect(observationBody(event)?.origin).toEqual({
      module: "discord",
      topic: "platform.message.created",
      event: { type: "platform.message.created", v: 1, data: env.data },
      turn: null,
    });
  });
});

describe("games", () => {
  it("uses the narration's keys", () => {
    gameEvent("craft_finished", { item: "stone_pickaxe", crafted: 1 });
    expect(last().attention_key).toBe("game:craft:stone_pickaxe");
    gameEvent("hostile_near", { new_types: ["zombie", "creeper"] });
    expect(last().attention_key).toBe("game:hostile_near:creeper+zombie");
    gameEvent("night_started", {});
    expect(last().attention_key).toBe("game:night_started");
    expect(last().source).toBe("game.minecraft");
  });

  it("the first time is notable, the same thing again is not", () => {
    gameEvent("craft_finished", { item: "stone_pickaxe", text: "做好石鎬" });
    expect(last()).toMatchObject({ salience: "notable", silent: false, revision: 1 });
    now += 60_000;
    gameEvent("craft_finished", { item: "stone_pickaxe", text: "又做好石鎬" });
    expect(last()).toMatchObject({ salience: "ambient", silent: true, revision: 1 });
    now += 45 * 60_000;
    gameEvent("craft_finished", { item: "stone_pickaxe", text: "再一把" });
    expect(last()).toMatchObject({ salience: "notable", silent: false, revision: 2 });
  });

  it("hazards come back sooner", () => {
    gameEvent("damage", { attacker: "zombie", amount: 8 });
    expect(last()).toMatchObject({ salience: "notable", revision: 1 });
    now += 60_000;
    gameEvent("damage", { attacker: "zombie", amount: 8 });
    expect(last()).toMatchObject({ salience: "ambient", revision: 1 });
    now += 120_000;
    gameEvent("damage", { attacker: "zombie", amount: 8 });
    expect(last()).toMatchObject({ salience: "notable", revision: 2 });
  });

  it("small damage and progress are never notable", () => {
    gameEvent("damage", { attacker: "zombie", amount: 1 });
    expect(last().salience).toBe("ambient");
    gameEvent("item_picked", { items: { oak_log: 1 } });
    expect(last().salience).toBe("ambient");
    gameEvent("goal_reached", { goal: "x" });
    expect(last().salience).toBe("ambient");
    expect(context.bucket("game.minecraft")).toBeNull();
  });

  it("death and low health are urgent, and each death is a new one", () => {
    gameEvent("death", { last_attacker: "zombie" });
    expect(last()).toMatchObject({ salience: "urgent", silent: false, revision: 1 });
    gameEvent("death", { last_attacker: "zombie" });
    expect(last()).toMatchObject({ salience: "urgent", revision: 2 });
    gameEvent("low_health", { health: 3 });
    expect(last().salience).toBe("urgent");
  });

  it("an event the adapter marks important is notable", () => {
    gameEvent("strange_thing", { source: "x" }, true);
    expect(last().salience).toBe("notable");
  });

  it("notable events go into the game's bucket, and the session's end empties it", () => {
    send("game", Events.GameDirectorSession, {
      state: "started",
      game: "minecraft",
      game_name: "Minecraft",
      context: VOICE,
    });
    expect(last()).toMatchObject({ source: "game.session", salience: "notable" });
    gameEvent("advancement", { title: "石器時代", text: "達成石器時代" });
    expect(context.bucket("game.minecraft")?.entries[0]?.text).toBe("達成石器時代");
    expect(context.bucket("game.session")?.entries[0]?.text).toBe("正在玩 Minecraft");
    send("game", Events.GameDirectorSession, {
      state: "stopped",
      game: "minecraft",
      game_name: "Minecraft",
      context: VOICE,
      code: "disconnected",
    });
    expect(last().salience).toBe("notable");
    expect(context.buckets()).toEqual([]);
  });

  it("a reached goal is notable under the key the director gives it", () => {
    loose("game", Events.GameDirectorGoal, {
      game: "minecraft",
      goal: "做一把石鎬",
      status: "done",
      attention_key: "game:craft:stone_pickaxe",
      task: null,
    });
    expect(last()).toMatchObject({
      attention_key: "game:craft:stone_pickaxe",
      salience: "notable",
      source: "game.director",
    });
  });

  it("the director's decisions are thoughts", () => {
    loose("game", Events.GameDirectorDecision, { game: "minecraft", commentary: "去挖礦" });
    expect(lines("thought").at(-1)).toMatchObject({ source: "game.director" });
  });

  it("a module that goes away takes its buckets along", () => {
    gameEvent("advancement", { title: "x" });
    send("kernel", Events.SystemModuleState, {
      module: "ext.minecraft",
      state: "failed",
      reason: "crashed",
    });
    expect(context.bucket("game.minecraft")).toBeNull();
  });
});

describe("activity and tasks", () => {
  function snapshot(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
    return {
      version: 1,
      at: toTimestamp(now),
      presence: { type: "none" },
      broadcast: { type: "off" },
      activity: { type: "idle", since: toTimestamp(now) },
      override: null,
      scene: null,
      ...over,
    };
  }

  function activityTask(type: "started" | "done" | "failed", turn: string | null = null) {
    const base = {
      task: "k1",
      resource: "activity" as const,
      request: { type: "stop" as const, activity: null },
      turn,
      at: toTimestamp(now),
    };
    const event: ActivityTaskEvent =
      type === "started"
        ? { ...base, type }
        : type === "done"
          ? { ...base, type, detail: "好了", data: null }
          : { ...base, type, code: "timeout", detail: "太久了" };
    return event;
  }

  it("the snapshot replaces, and an unchanged one is not a fact", () => {
    send("activity", Events.ActivityChanged, snapshot());
    const count = observations().length;
    send("activity", Events.ActivityChanged, snapshot({ version: 2 }));
    expect(observations()).toHaveLength(count);
    send(
      "activity",
      Events.ActivityChanged,
      snapshot({ presence: { type: "in", channel: VOICE, since: toTimestamp(now) } }),
    );
    expect(last()).toMatchObject({ attention_key: "activity:state", revision: 2, silent: true });
    expect(context.bucket("activity")?.entries).toHaveLength(1);
  });

  it("a task's lines follow each other", async () => {
    loose("activity", Events.ActivityStarted, activityTask("started"));
    expect(last()).toMatchObject({ salience: "ambient", attention_key: "task:k1", revision: 1 });
    const done = loose("activity", Events.ActivityDone, activityTask("done"));
    expect(last()).toMatchObject({ salience: "ambient", revision: 2 });
    expect((await log.chain(done.id)).events).toHaveLength(2);
  });

  it("a failure, and a result someone waits for, are notable", () => {
    loose("activity", Events.ActivityFailed, activityTask("failed"));
    expect(last()).toMatchObject({ salience: "notable", silent: false });
    loose("activity", Events.ActivityDone, activityTask("done", "t1"));
    expect(last().salience).toBe("notable");
  });

  it("an executor's task keeps one state bucket until it ends", () => {
    const owner = "game.minecraft";
    const at = toTimestamp(now);
    const topic = (t: "started" | "progress" | "done" | "failed") => taskTopic(owner, t);
    task(topic("started"), { type: "started", task: "k", goal: "mine", at });
    task(topic("progress"), {
      type: "progress",
      task: "k",
      progress: 0.5,
      detail: "走到礦脈",
      at,
    });
    expect(last()).toMatchObject({ source: owner, attention_key: "task:k", revision: 2 });
    expect(context.bucket(`${owner}.task`)?.entries.map((e) => e.text)).toEqual(["走到礦脈"]);
    task(topic("failed"), {
      type: "failed",
      task: "k",
      code: "unreachable",
      detail: "沒路",
      at,
    });
    expect(last().salience).toBe("notable");
    expect(context.bucket(`${owner}.task`)).toBeNull();
  });

  it("a steered event is a steer line on the steer's cause chain, not the end of the task", async () => {
    const owner = "game.minecraft";
    const at = toTimestamp(now);
    task(taskTopic(owner, "started"), {
      type: "started",
      task: "k",
      goal: "mine",
      at,
    });
    task(taskTopic(owner, "progress"), {
      type: "progress",
      task: "k",
      progress: 0.5,
      detail: "走到礦脈",
      at,
    });
    task(taskTopic(owner, "steered"), {
      type: "steered",
      task: "k",
      steer: "s1",
      outcome: "applied",
      detail: "目標改成木棒",
      at,
    });
    const steer = lines("steer").at(-1) as LogEvent;
    expect(steer).toMatchObject({
      source: owner,
      cause: "s1",
      body: { phase: "outcome", task: "k", steer: "s1", outcome: "applied" },
    });
    expect(last()).toMatchObject({ attention_key: "steer:s1", salience: "ambient" });
    // The task is still running: its bucket stays and nothing says it ended.
    expect(context.bucket(`${owner}.task`)?.entries.map((e) => e.text)).toEqual(["走到礦脈"]);
    expect(observations().some((o) => o.summary.startsWith("任務完成"))).toBe(false);
    task(taskTopic(owner, "steered"), {
      type: "steered",
      task: "k",
      steer: "s2",
      outcome: "too_late",
      detail: "",
      at,
    });
    expect(last()).toMatchObject({ attention_key: "steer:s2", salience: "notable" });
  });

  it("a notice is notable and hangs on its task", async () => {
    const started = loose("activity", Events.ActivityStarted, activityTask("started"));
    const notice: Notice = {
      id: "n1",
      at: toTimestamp(now),
      source: "activity",
      task: "k1",
      turn: null,
      context: TEXT,
      ok: true,
      code: null,
      text: "Minecraft 開好了",
      expires_at: toTimestamp(now + 1000),
    };
    const env = send("activity", Events.AgentNotice, notice);
    expect(last()).toMatchObject({ source: "notice.activity", salience: "notable" });
    expect((await log.chain(env.id)).events[0]?.id).toBe(started.id);
  });
});

describe("voice, stage and songs", () => {
  const participant = (name: string, id: string, is_self = false) => ({
    account: { platform: "discord", id },
    display_name: name,
    is_self,
    muted: false,
    deafened: false,
  });

  it("who is in voice is state; leaving removes it", () => {
    const people = [participant("Owen", "100"), participant("Miyoria", "999", true)];
    send("voice.link", Events.VoiceJoined, { context: VOICE, participants: people });
    expect(context.bucket("voice.members")?.entries[0]?.text).toBe("語音頻道裡有:Owen");
    const count = observations().length;
    send("voice.link", Events.VoiceParticipants, {
      context: VOICE,
      participants: [...people].reverse(),
    });
    expect(observations()).toHaveLength(count);
    send("voice.link", Events.VoiceLeft, { context: VOICE, reason: null });
    expect(context.bucket("voice.members")).toBeNull();
  });

  it("the stage is state", () => {
    const status = { connected: true, obs: true, streaming: true, scene: "game" };
    loose("stage.link", Events.StageStatus, status);
    expect(last()).toMatchObject({ source: "stage", attention_key: "stage:status" });
    const count = observations().length;
    loose("stage.link", Events.StageStatus, { ...status, hotkeys: ["a"] });
    expect(observations()).toHaveLength(count);
    send("stage.link", Events.StageStatus, { connected: false });
    expect(context.bucket("stage")).toBeNull();
  });

  it("Go Live is state, a failure notable", () => {
    loose("voice.link", Events.VoiceGoLive, { state: "live", guild: "g" });
    expect(context.bucket("stream")).not.toBeNull();
    loose("voice.link", Events.VoiceGoLive, { state: "failed", guild: "g", error: "x" });
    expect(last().salience).toBe("notable");
    expect(context.bucket("stream")).toBeNull();
  });

  it("a song is state while it plays; its lines are not news", () => {
    send("sing", Events.SingCue, { state: "started", song: "s1", title: "夜に駆ける" });
    expect(last()).toMatchObject({ source: "sing", attention_key: "song:s1" });
    expect(context.bucket("song")?.entries[0]?.text).toBe("正在唱:夜に駆ける");
    const count = observations().length;
    send("sing", Events.SingCue, { state: "line", song: "s1", index: 1, text: "la" });
    expect(observations()).toHaveLength(count);
    send("sing", Events.SingCue, { state: "ended", song: "s1", outcome: "finished" });
    expect(context.bucket("song")).toBeNull();
  });

  it("preparing a song follows its stages, not its progress", () => {
    const prepare = { no: 1, title: "x", stage: "download", progress: 0.1, exclusive: null };
    send("sing", Events.SingPrepare, prepare);
    const count = observations().length;
    send("sing", Events.SingPrepare, { ...prepare, progress: 0.2 });
    expect(observations()).toHaveLength(count);
    send("sing", Events.SingPrepare, {
      no: null,
      title: "",
      stage: "",
      progress: 0,
      exclusive: null,
    });
    expect(context.bucket("song.prepare")).toBeNull();
  });

  it("the shutdown line is written", () => {
    send("kernel", Events.SystemShutdown, {});
    expect(last()).toMatchObject({ source: "core.lifecycle", attention_key: "system:shutdown" });
  });

  it("leaves out what is noise", () => {
    const before = log.recent(10_000).length;
    send("voice.link", Events.VoiceSpeaking, { context: VOICE, account: OWEN, speaking: true });
    send("discord", Events.PlatformTyping, { context: TEXT, account: OWEN });
    loose("llm", Events.LlmBudget, { state: "ok" });
    loose("agent", Events.AgentPrompt, { text: "很長" });
    expect(log.recent(10_000)).toHaveLength(before);
  });
});

describe("cause chains", () => {
  async function kinds(event: LogEvent) {
    const chain = await log.chain(event.id);
    expect(chain.complete).toBe(true);
    return chain.events.map((e) => `${e.kind}:${e.source}`);
  }

  it("an action hangs on its turn, and the task on the action", async () => {
    send("discord", Events.PlatformMessageCreated, message("米優開麥塊"));
    send("agent", Events.AgentTurnFocus, focus("t1", ["m1"], TEXT), { turn: "t1" });
    loose("actions", Events.GateDecision, {
      capability: "game.start",
      allowed: true,
      stage: "allowed",
      reason: "ok",
      why: "他叫我開",
      turn: "t1",
    });
    const task = send("activity", Events.ActivityStarted, {
      type: "started",
      task: "k",
      resource: "activity",
      request: { type: "start", activity: "game", target: "minecraft", goal: null },
      turn: "t1",
      at: toTimestamp(now),
    });
    const chain = await log.chain(task.id);
    expect(chain.events.map((e) => e.kind)).toEqual([
      "observation",
      "decision",
      "action",
      "observation",
    ]);
  });

  it("a refused action is a result", () => {
    loose("actions", Events.GateDecision, { capability: "x", allowed: false, turn: null });
    expect(lines("result").at(-1)).toMatchObject({
      source: "gate",
      body: { capability: "x", allowed: false },
    });
  });

  it("the turn's outcome is a result of its last decision", async () => {
    send("agent", Events.AgentDecision, {
      turn: "t1",
      context: VOICE,
      respond: false,
      score: 0,
      reasons: [],
    });
    const record: TurnOutcomeRecord = {
      turn: "t1",
      context: VOICE,
      reason: "ambient",
      outcome: { type: "silence" },
      addressed_by: [],
      focus: [],
      restarts: 0,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(now),
    };
    send("agent", Events.AgentTurnOutcome, record, { turn: "t1" });
    const result = lines("result").at(-1) as LogEvent;
    expect(result.body).toMatchObject({ turn_outcome: { outcome: { type: "silence" } } });
    expect(await kinds(result)).toEqual(["decision:agent", "result:agent"]);
  });

  it("a focus event that only changes the phase is not a new decision", () => {
    send("voice.link", Events.VoiceUtteranceEvent, utterance("米優"));
    send("agent", Events.AgentTurnFocus, focus("t1", ["u1"]), { turn: "t1" });
    send(
      "agent",
      Events.AgentTurnFocus,
      { ...focus("t1", ["u1"]), phase: "speaking" },
      { turn: "t1" },
    );
    expect(lines("decision")).toHaveLength(1);
  });

  it("keeps the end-to-end latency of a reply with its turn, and no other measurement", () => {
    send("voice.link", Events.VoiceUtteranceEvent, utterance("米優"));
    send("agent", Events.AgentTurnFocus, focus("t1", ["u1"]), { turn: "t1" });
    const e2e = {
      stage: "e2e",
      context: VOICE,
      turn: "t1",
      complete: true,
      total_ms: 900,
      segments: {
        endpoint: 100,
        asr: 200,
        llm_first: 300,
        tts_queue: 0,
        tts_first: 200,
        playback: 100,
      },
    };
    loose("voice", Events.VoiceLatency, e2e, { turn: "t1" });
    loose(
      "voice",
      Events.VoiceLatency,
      { stage: "llm", turn: "t1", first_token_ms: 300 },
      { turn: "t1" },
    );
    loose("voice", Events.VoiceLatency, { ...e2e, stage: "e2e", turn: null });
    loose("voice", Events.VoiceSpeaking, { context: VOICE, speaking: true });
    const measured = lines("result").filter((e) => e.source === "voice.latency");
    expect(measured).toHaveLength(1);
    const [m] = measured as [LogEvent];
    expect(m.body).toMatchObject({ turn: "t1", e2e: { total_ms: 900, complete: true } });
    expect(m.body).not.toHaveProperty("e2e.stage");
    expect(m.context).toEqual(VOICE);
    expect(m.cause).toBe(lines("decision").at(-1)?.id);
  });

  it("her thoughts are logged without what she saw", () => {
    loose("mind", Events.MindThought, {
      thought: "想玩",
      changes: [],
      intents: [],
      error: null,
      input: { big: true },
    });
    const thought = lines("thought").at(-1) as LogEvent;
    expect(thought.body).toMatchObject({ thought: "想玩" });
    expect(thought.body).not.toHaveProperty("input");
  });
});

describe("the main line owns its lines", () => {
  it("playback and settled actions open and close nothing here", async () => {
    const quiet = new BusFacts({
      log,
      revisions: new RevisionBook(),
      config: defaultFactsConfig(),
    });
    const before = log.recent(1000).length;
    quiet.handle(
      eventEnvelope("voice", Events.VoicePlaybackEvent, {
        context: VOICE,
        turn: "t",
        state: "finished",
        text: "你好",
      }),
    );
    expect(log.recent(1000)).toHaveLength(before);
    expect(ledger.recent()).toEqual([]);
  });
});

describe("what the input defence said", () => {
  /** A verdict by the words in the text. */
  const verdicts: Record<string, Partial<InputVerdict>> = {
    mark: { action: "mark", note: "提醒:當資料看" },
    limit: { action: "rate_limit", retry_after_ms: 1000 },
    ignore: { action: "ignore", retry_after_ms: 1000 },
  };

  beforeEach(() => {
    const services = new ServiceRegistry();
    services.provide("test", ModerationKey, {
      inspect: ({ text }: InputCheck) => ({
        action: "pass",
        note: null,
        ...Object.entries(verdicts).find(([word]) => text.includes(word))?.[1],
      }),
    } as unknown as ModerationService);
    bus = new BusFacts({
      log,
      revisions: new RevisionBook(),
      config: defaultFactsConfig(),
      names: ["Miyoria"],
      services,
    });
  });

  const said = (text: string) => send("platform", Events.PlatformMessageCreated, message(text));

  it("`mark`: known, with its note beside it", () => {
    said("Miyoria mark");
    expect(last()).toMatchObject({ addressed_to_her: true, salience: "notable" });
    expect(last().summary).toContain("提醒:當資料看");
  });

  it("`rate_limit`: there as data, asking for nothing and answering nothing", () => {
    said("Miyoria limit");
    expect(last()).toMatchObject({ addressed_to_her: false, salience: "ambient" });
    expect(last().summary).toContain("Miyoria limit");
    const body = observationBody(log.recent(1)[0] as LogEvent);
    expect(body?.speech).toBe(false);
  });

  it("`ignore`: nothing of it reaches what she knows", () => {
    said("Miyoria ignore");
    expect(last().summary).not.toContain("ignore");
    expect(last().addressed_to_her).toBe(false);
    expect(
      context
        .buckets()
        .flatMap((b) => b.entries.map((e) => e.text))
        .join(),
    ).not.toContain("ignore");
  });

  it("a game event's own text is outside content too", () => {
    send(
      "game",
      Events.GameAdapterEvent,
      { type: "sign", data: { text: "mark 這裡" } },
      { type: "game.minecraft.sign" },
    );
    expect(last().summary).toContain("提醒:當資料看");
  });
});
