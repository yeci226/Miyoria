// The facts writer on the store's event log: what each kind of line written today becomes as an
// envelope (type, tier, scope, session and place, person, turn, key, parent), how the buffered
// writer hands it over, and how a stored envelope reads back as a line.

import type { EventEnvelope } from "@miyoria/contracts/events";
import { SqliteStore } from "@miyoria/store";
import {
  type AnyEventDefinition,
  type BusEnvelope,
  type ContextKey,
  type EventPayload,
  Events,
  eventEnvelope,
  type IncomingMessage,
  LOG_EVENT_KINDS,
  type LogEvent,
  type PublishMetaArgs,
  type TurnFocus,
  type TurnOutcomeRecord,
  taskTopic,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusFacts } from "../src/bus.js";
import { defaultFactsConfig } from "../src/config.js";
import { DeliveryLedgerView } from "../src/delivery.js";
import { FACTS_TYPES, fromLogged, lineKind, lineType, typesOf } from "../src/envelope.js";
import { EventLogService } from "../src/log.js";
import { RevisionBook } from "../src/revisions.js";

const T0 = Date.UTC(2026, 10, 14, 6);
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d", kind: "dm" };
const OWEN = { platform: "discord", id: "100" };
const HER = { platform: "discord", id: "999" };

let now = T0;
const clock = { now: () => now };
let store: SqliteStore;
let log: EventLogService;
let ledger: DeliveryLedgerView;
let bus: BusFacts;

beforeEach(async () => {
  now = T0;
  store = await SqliteStore.open(":memory:", { clock });
  log = new EventLogService({ store: store.events, clock, hotEvents: 10_000 });
  ledger = new DeliveryLedgerView(log, { clock });
  const revisions = new RevisionBook();
  for (const p of [revisions, ledger]) await log.project(p);
  bus = new BusFacts({ log, revisions, config: defaultFactsConfig(), names: ["米優"] });
  send("discord", Events.PlatformReady, { platform: "discord", self_account: HER });
});

afterEach(async () => {
  await store.close();
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

/** `send` with a payload that holds only what the writer reads, not all its schema asks for. */
function loose(
  source: string,
  definition: AnyEventDefinition,
  data: unknown,
  meta: { turn?: string | null; type?: string } = {},
): BusEnvelope {
  return send(source, definition, data, meta);
}

function message(text: string, context = TEXT, id = "m1"): IncomingMessage {
  return {
    id: { context, id },
    author: { account: OWEN, display_name: "Owen", is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(now),
  };
}

function focus(turn: string, ids: string[], context: ContextKey): TurnFocus {
  return {
    turn,
    context,
    reason: "addressed",
    phase: "generating",
    addressed_by: ["Owen"],
    addressed_accounts: [OWEN],
    focus: ids.map((id) => ({ context, id })),
    background: [],
    restarts: 0,
    started_at: toTimestamp(now),
    updated_at: toTimestamp(now),
  };
}

/** The envelope the store holds for `id`, after a flush. */
async function stored(id: string): Promise<EventEnvelope> {
  await log.flush();
  const found = store.events.get(id);
  if (found === null) throw new Error(`event ${id} was not stored`);
  return found.envelope;
}

const newest = (kind: LogEvent["kind"]): LogEvent =>
  log
    .recent(10_000)
    .filter((e) => e.kind === kind)
    .at(-1) as LogEvent;

const owen = () => store.persons.personOf(OWEN);

function never(): never {
  throw new Error("not stored");
}

describe("each line written today, as an envelope", () => {
  it("a chat line: said, kept 365 days, in its room, by its author", async () => {
    const env = send("discord", Events.PlatformMessageCreated, message("今天好冷"));
    const e = await stored(env.id);
    expect(e).toMatchObject({
      type: "facts.observation.said",
      v: 1,
      source: "platform.discord",
      tier: "long",
      scope: "room",
      session: "discord:g:c",
      key: "msg:discord:m1",
      parent: null,
      turn: null,
      person_id: owen()?.id,
      account_id: store.persons.account(OWEN)?.id,
      redacted_at: null,
      data: { origin: { topic: "platform.message.created" } },
    });
    expect(e.space_id).not.toBeNull();
    expect(e.room_id).not.toBeNull();
  });

  it("a DM line: scope dm, the person's session", async () => {
    const e = await stored(send("discord", Events.PlatformMessageCreated, message("在嗎", DM)).id);
    expect(e).toMatchObject({
      type: "facts.observation.said",
      scope: "dm",
      session: `discord:dm:${owen()?.id}`,
      space_id: null,
      person_id: owen()?.id,
    });
  });

  it("a voice line: said, on the voice lane", async () => {
    const env = send("voice.link", Events.VoiceUtteranceEvent, {
      id: "u1",
      context: VOICE,
      speaker: { account: OWEN, display_name: "Owen", is_bot: false },
      text: "米優你好",
      language: null,
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(now),
      ended_at: toTimestamp(now),
      asr_ms: 1,
    });
    expect(await stored(env.id)).toMatchObject({
      type: "facts.observation.said",
      source: "voice.asr",
      tier: "long",
      scope: "room",
      session: "discord:g:voice:v",
      key: "voice:utterance:u1",
      person_id: owen()?.id,
    });
  });

  it("presence: ambient, folded after 14 days", async () => {
    const participants = [
      { account: OWEN, display_name: "Owen", is_self: false, muted: false, deafened: false },
    ];
    const env = send("voice.link", Events.VoiceJoined, { context: VOICE, participants });
    expect(await stored(env.id)).toMatchObject({
      type: "facts.observation.ambient",
      tier: "ambient",
      scope: "room",
      session: "discord:g:voice:v",
      key: "voice:members:discord:g:voice:v",
      person_id: null,
    });
  });

  it("a notable observation with no place: kept 90 days, her own", async () => {
    const env = send(
      "ext.minecraft",
      Events.GameAdapterEvent,
      { type: "death", data: null },
      { type: "game.minecraft.death" },
    );
    expect(await stored(env.id)).toMatchObject({
      type: "facts.observation",
      source: "game.minecraft",
      tier: "short",
      scope: "self",
      session: null,
      room_id: null,
    });
  });

  it("an observation written straight to the log, with no bus event", async () => {
    const line = log.observe({
      source: "economy",
      silent: true,
      salience: "notable",
      attention_key: "letter:1",
      revision: 1,
      summary: "有一封信",
      addressed_to_her: false,
      from: null,
      context: null,
    });
    expect(await stored(line.id)).toMatchObject({ type: "facts.observation", key: "letter:1" });
  });

  it("a decision, the action it allowed, and the turn's result", async () => {
    const heard = send("discord", Events.PlatformMessageCreated, message("米優開麥塊"));
    send("agent", Events.AgentTurnFocus, focus("t1", ["m1"], TEXT), { turn: "t1" });
    const decision = newest("decision");
    expect(await stored(decision.id)).toMatchObject({
      type: "facts.decision",
      source: "agent.focus",
      tier: "short",
      parent: heard.id,
      turn: "t1",
      session: "discord:g:c",
      scope: "room",
      // `addressed_by` names a handle: the store finds its person.
      person_id: owen()?.id,
    });
    loose("actions", Events.GateDecision, { capability: "game.start", allowed: true, turn: "t1" });
    const action = newest("action");
    expect(await stored(action.id)).toMatchObject({
      type: "facts.action",
      source: "gate",
      parent: decision.id,
      turn: "t1",
      scope: "self",
    });
    const record: TurnOutcomeRecord = {
      turn: "t1",
      context: TEXT,
      reason: "addressed",
      outcome: { type: "silence" },
      addressed_by: ["Owen"],
      focus: [],
      restarts: 0,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(now),
    };
    send("agent", Events.AgentTurnOutcome, record, { turn: "t1" });
    // How the turn ended is the bus event's record: its topic, its payload, at the time it names.
    const result = newest("result");
    expect(result.body).toEqual({ turn_outcome: record });
    expect(await stored(result.id)).toMatchObject({
      type: "agent.turn.outcome",
      source: "agent",
      tier: "short",
      parent: decision.id,
      // From `body.turn_outcome.turn`.
      turn: "t1",
      session: "discord:g:c",
      person_id: owen()?.id,
      at: record.at,
      data: record,
    });
    // It reads back as the line it was.
    expect(fromLogged(store.events.get(result.id) ?? never())).toEqual(result);
  });

  it("a tool call of a turn is the bus event's record, kept as long as the turn's outcome", async () => {
    send("discord", Events.PlatformMessageCreated, message("米優在嗎"));
    send("agent", Events.AgentTurnFocus, focus("t3", ["m1"], TEXT), { turn: "t3" });
    now += 1_000;
    const data = {
      turn: "t3",
      context: TEXT,
      tool: "web_search",
      ok: true,
      result: "找到三個結果",
    };
    send("agent", Events.AgentTool, data, { turn: "t3" });
    const call = newest("action");
    expect(call.source).toBe("agent.tool");
    expect(call.body).toEqual(data);
    expect(await stored(call.id)).toMatchObject({
      type: "agent.tool",
      source: "agent.tool",
      tier: "short",
      turn: "t3",
      session: "discord:g:c",
      data,
    });
    // It reads back as the line it was, and a query for the turn finds it among its lines.
    expect(fromLogged(store.events.get(call.id) ?? never())).toEqual(call);
    const found = await store.events?.query({ turn: "t3", types: typesOf(["action"]) });
    expect(found?.map((e) => e.envelope.id)).toContain(call.id);
  });

  it("her attention decision is the bus event's record, answering the turn's focus", async () => {
    const heard = send("discord", Events.PlatformMessageCreated, message("米優在嗎"));
    send("agent", Events.AgentTurnFocus, focus("t2", ["m1"], TEXT), { turn: "t2" });
    const focused = newest("decision");
    now += 1_000;
    const trace = { turn: "t2", context: TEXT, respond: true, score: 0.9, reasons: ["mention"] };
    const env = send("agent", Events.AgentDecision, trace, { turn: "t2" });
    const decision = newest("decision");
    // Under the bus event's id and time.
    expect(decision.id).toBe(env.id);
    expect(await stored(env.id)).toMatchObject({
      type: "agent.decision",
      source: "agent",
      tier: "short",
      scope: "room",
      parent: focused.id,
      turn: "t2",
      session: "discord:g:c",
      // The person the turn's focus answers.
      person_id: owen()?.id,
      at: env.at,
      data: trace,
    });
    expect(heard.id).not.toBe(decision.id);
    expect(fromLogged(store.events.get(env.id) ?? never())).toEqual(decision);
    // Read as decision lines, with the focus line beside them.
    expect((await log.query({ kinds: ["decision"], turn: "t2" })).map((e) => e.id)).toEqual([
      decision.id,
      focused.id,
    ]);
    // `DecisionLog` reads the same event.
    expect(await store.decisions.recent("p", TEXT, 5)).toEqual([
      { id: env.id, profile: "p", ts: env.at, trace },
    ]);
  });

  it("a thought and a proposal", async () => {
    loose("mind", Events.MindThought, {
      thought: "想去散步",
      changes: [],
      intents: [],
      error: null,
    });
    expect(await stored(newest("thought").id)).toMatchObject({
      type: "facts.thought",
      source: "mind",
      tier: "short",
      scope: "self",
    });
    loose("plan", Events.PlanGoal, { goal: "練歌" });
    expect(await stored(newest("proposal").id)).toMatchObject({
      type: "facts.proposal",
      source: "plan",
    });
  });

  it("her line and its delivery: kept 365 days, in the room she said it", async () => {
    const id = ledger.open({
      attention_key: "game:craft:stone_pickaxe",
      revision: 1,
      channel: "voice",
      context: VOICE,
      said: "石鎬好了",
    });
    const said = await stored(id);
    expect(said).toMatchObject({
      type: "facts.utterance",
      source: "delivery",
      tier: "long",
      scope: "room",
      session: "discord:g:voice:v",
      key: "game:craft:stone_pickaxe",
      person_id: null,
    });
    ledger.ack(id);
    expect(await stored(newest("delivered").id)).toMatchObject({
      type: "facts.delivered",
      tier: "long",
      parent: id,
    });
  });

  it("a steer line", async () => {
    send(
      "ext.minecraft",
      Events.TaskSteered,
      {
        type: "steered",
        task: "k",
        steer: "s1",
        outcome: "applied",
        detail: "",
        at: toTimestamp(now),
      },
      { type: taskTopic("game.minecraft", "steered") },
    );
    expect(await stored(newest("steer").id)).toMatchObject({
      type: "facts.steer",
      source: "game.minecraft",
      parent: "s1",
    });
  });

  it("a rule change: kept forever", async () => {
    const line = log.append({ kind: "directive", source: "directive", body: { id: "r1" } });
    expect(await stored(line.id)).toMatchObject({ type: "facts.directive", tier: "keep" });
  });
});

describe("the buffered writer", () => {
  it("touches nothing until a flush, then writes every buffered line in one append", async () => {
    expect(defaultFactsConfig().flush_ms).toBe(500);
    const append = vi.spyOn(store.events, "append");
    const lines = [1, 2, 3].map((i) =>
      log.append({ kind: "thought", source: "mind", body: { i } }),
    );
    expect(append).not.toHaveBeenCalled();
    expect(store.events.query()).toEqual([]);
    await log.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0].map((w) => w.draft.id)).toEqual(lines.map((l) => l.id));
    expect(store.events.query({ order: "asc" }).map((e) => e.envelope.seq)).toEqual([1, 2, 3]);
  });

  it("returns what the store committed, equal to what it reads back", async () => {
    const append = vi.spyOn(store.events, "append");
    const env = send("discord", Events.PlatformMessageCreated, message("嗨"));
    await log.flush();
    const committed = append.mock.results[0]?.value as EventEnvelope[];
    expect(committed.map((e) => e.id)).toEqual([env.id]);
    expect(store.events.get(env.id)?.envelope).toEqual(committed[0]);
  });
});

describe("reading back", () => {
  it("a stored line is the line that was written", async () => {
    const env = send("discord", Events.PlatformMessageCreated, message("嗨"));
    send("agent", Events.AgentTurnFocus, focus("t1", ["m1"], TEXT), { turn: "t1" });
    await log.flush();
    for (const line of log.recent(10)) {
      const found = store.events.get(line.id);
      expect(found && fromLogged(found)).toEqual(line);
    }
    // Through a log whose hot window does not have it.
    const cold = new EventLogService({ store: store.events, clock, hotEvents: 1 });
    expect(await cold.get(env.id)).toEqual(log.recent(10).find((e) => e.id === env.id));
  });

  it("kinds and types map both ways; other writers' events are not lines", async () => {
    for (const kind of LOG_EVENT_KINDS) {
      const line = log.append({ kind, source: "s", body: null });
      expect(lineKind(lineType(line))).toBe(kind);
    }
    expect(typesOf(["observation"])).toEqual([
      "facts.observation",
      "facts.observation.said",
      "facts.observation.ambient",
    ]);
    expect(typesOf(["decision", "result"])).toEqual([
      "facts.decision",
      "agent.decision",
      "facts.result",
      "agent.turn.outcome",
    ]);
    expect(lineKind("agent.decision")).toBe("decision");
    expect(lineKind("agent.turn.outcome")).toBe("result");
    expect(typesOf()).toEqual(FACTS_TYPES);
    expect(lineKind("privacy.redacted")).toBeNull();
    expect(lineKind("facts.unknown")).toBeNull();
    await log.flush();
    store.events.appendNow({
      draft: {
        id: "01JD0000000000000000000009",
        at: toTimestamp(now),
        type: "chat.message",
        data: 1,
      },
      source: "platform.discord",
    });
    const cold = new EventLogService({ store: store.events, clock, hotEvents: 1 });
    const read = await cold.query({ limit: 100 });
    expect(read).toHaveLength(LOG_EVENT_KINDS.length);
    expect(await cold.get("01JD0000000000000000000009")).toBeNull();
  });

  it("filters by context and by handle through the session and the person", async () => {
    send("discord", Events.PlatformMessageCreated, message("文字", TEXT, "m1"));
    send("discord", Events.PlatformMessageCreated, message("私訊", DM, "m2"));
    log.append({ kind: "thought", source: "mind", body: null });
    await log.flush();
    const cold = new EventLogService({ store: store.events, clock, hotEvents: 1 });
    const keys = async (filter: Parameters<EventLogService["query"]>[0]) =>
      (await cold.query(filter)).map((e) => e.kind + (e.context?.channel ?? ""));
    expect(await keys({ context: TEXT })).toEqual(["observationc"]);
    expect(await keys({ context: DM })).toEqual(["observationd"]);
    expect(await keys({ context: VOICE })).toEqual([]);
    expect(await keys({ person: "Owen", order: "asc" })).toEqual(["observationc", "observationd"]);
    expect(await keys({ kinds: ["thought"] })).toEqual(["thought"]);
  });

  it("a redacted line keeps its kind, place and person, and loses its content", async () => {
    const env = send("discord", Events.PlatformMessageCreated, message("別記得這句"));
    await log.flush();
    expect(store.events.redact(env.id, "do_not_remember", "memory")).not.toBeNull();
    const cold = new EventLogService({ store: store.events, clock, hotEvents: 1 });
    expect(await cold.get(env.id)).toMatchObject({
      kind: "observation",
      source: "platform.discord",
      context: TEXT,
      person: "Owen",
      body: { redacted: true },
    });
    // The redaction record is the store's, not a line.
    expect((await cold.query({ limit: 100 })).map((e) => e.id)).toEqual([env.id]);
  });
});
