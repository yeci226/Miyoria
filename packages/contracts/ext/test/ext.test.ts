// The extension protocol's schemas read the examples in docs/protocols/extension-rpc.md, fill in
// defaults, ignore keys they do not know, and refuse what the protocol refuses.

import { describe, expect, it } from "vitest";
import {
  EXT_CANCEL_METHOD,
  EXT_ERROR_CODE,
  EXT_LIMITS,
  EXT_PROTOCOL_VERSION,
  EXT_STEER_OUTCOMES,
  EXT_TASK_FAILURE_CODES,
  ExtCommandSpecSchema,
  ExtContributionsSchema,
  ExtEventNotificationSchema,
  ExtEventsPublishParamsSchema,
  ExtExecutorDeclSchema,
  ExtInitializeParamsSchema,
  ExtInitializeResultSchema,
  ExtInvocationSchema,
  ExtPromptContributeParamsSchema,
  ExtPromptContributeResultSchema,
  ExtRpcMessageSchema,
  ExtStructuredStateSchema,
  ExtTaskEventSchema,
  ExtTaskSpecSchema,
  ExtTaskSteerSchema,
  ExtToolCallParamsSchema,
  ExtToolDeclSchema,
} from "../src/index.js";

const context = { platform: "discord", scope: "123", channel: "456", kind: "channel" };
const account = { platform: "discord", id: "789" };
const at = "2026-11-14T00:00:00.000Z";

describe("constants", () => {
  it("are the protocol's", () => {
    expect(EXT_PROTOCOL_VERSION).toBe(2);
    expect(EXT_CANCEL_METHOD).toBe("$/cancelRequest");
    expect(EXT_LIMITS.MAX_FRAME_BYTES).toBe(16_777_216);
    expect(EXT_ERROR_CODE.Cancelled).toBe(-32800);
    expect(EXT_ERROR_CODE.MethodNotFound).toBe(-32601);
    expect([...EXT_TASK_FAILURE_CODES]).toEqual([
      "timeout",
      "cancelled",
      "superseded",
      "busy",
      "invalid",
      "not_found",
      "unreachable",
      "precondition",
      "disconnected",
      "crashed",
      "died",
      "denied",
      "internal",
    ]);
    expect([...EXT_STEER_OUTCOMES]).toEqual(["applied", "rejected", "too_late"]);
  });
});

describe("the handshake", () => {
  it("reads initialize params, with `game` optional on the wire", () => {
    const params = {
      protocol: 2,
      host: { name: "miyoria", version: "0.1.0" },
      extension: { id: "miyoria.hello", version: "0.1.0", dir: "/x", game: null },
      config: { greeting: "哈囉" },
      permissions: {
        events: ["agent.turn.completed"],
        tools: true,
        commands: true,
        network: [],
        input: [],
      },
    };
    expect(ExtInitializeParamsSchema.parse({ ...params, future: 1 })).toEqual(params);
    const { game: _game, ...noGame } = params.extension;
    expect(ExtInitializeParamsSchema.parse({ ...params, extension: noGame }).extension.game).toBe(
      null,
    );
    expect(ExtInitializeParamsSchema.safeParse({ ...params, config: [] }).success).toBe(false);
    expect(ExtInitializeParamsSchema.safeParse({ ...params, protocol: 1.5 }).success).toBe(false);
  });

  it("reads contributions with every part optional, and the version the extension speaks", () => {
    // No `protocol`: an extension of protocol 1, which had no such field.
    expect(ExtInitializeResultSchema.parse({})).toEqual({
      protocol: 1,
      contributions: {
        tools: [],
        commands: [],
        prompts: [],
        subscriptions: [],
        executor: null,
        status: false,
      },
    });
    expect(ExtInitializeResultSchema.parse({ protocol: 2 }).protocol).toBe(2);
    expect(ExtInitializeResultSchema.safeParse({ protocol: "2" }).success).toBe(false);
    const read = ExtContributionsSchema.parse({
      tools: [{ name: "dice", description: "roll" }],
      executor: { name: "E" },
    });
    expect(read.tools[0]).toEqual({
      name: "dice",
      description: "roll",
      parameters: { type: "object", properties: {} },
      permission: null,
      read_only: false,
    });
    expect(read.executor).toEqual({ name: "E", goals: [], guide: null, steer: false });
    expect(ExtContributionsSchema.safeParse({ tools: "no" }).success).toBe(false);
  });

  it("keeps a tool's own JSON Schema, and reads a command spec", () => {
    const parameters = { type: "object", properties: { city: { type: "string" } } };
    expect(
      ExtToolDeclSchema.parse({ name: "a.b", description: "d", parameters }).parameters,
    ).toEqual(parameters);
    const spec = {
      path: ["dice", "roll"],
      description: "擲骰子",
      args: [
        { name: "sides", description: "面數", kind: { type: "integer" }, required: false },
        {
          name: "style",
          description: "樣式",
          kind: { type: "choice", choices: ["plain", "fancy"] },
          required: true,
        },
      ],
      permission: "",
      ephemeral: false,
    };
    expect(ExtCommandSpecSchema.parse(spec)).toEqual(spec);
    expect(ExtCommandSpecSchema.safeParse({ ...spec, ephemeral: undefined }).success).toBe(false);
  });
});

describe("what the host sends", () => {
  it("reads tools.call, commands.invoke and prompt.contribute", () => {
    const call = ExtToolCallParamsSchema.parse({
      name: "dice",
      context: {
        turn: "01JC0000000000000000000000",
        context,
        account,
        message: { context, id: "999" },
        priority: "direct",
      },
    });
    expect(call.args).toEqual({});
    expect(
      ExtToolCallParamsSchema.safeParse({
        name: "dice",
        context: { ...call.context, priority: "x" },
      }).success,
    ).toBe(false);
    const invocation = {
      path: ["hello"],
      args: { name: "小明", n: 3, flag: true },
      invoker: account,
      invoker_display_name: "Owen",
      context,
      invoker_is_guild_admin: false,
    };
    expect(ExtInvocationSchema.parse(invocation)).toEqual(invocation);
    const prompt = {
      key: "facts",
      request: {
        profile: "p",
        turn: "t",
        context,
        participants: [{ account, display_name: "Owen", person: null }],
        speakers: [account],
        query: "q",
        recent: [],
        voice: false,
        now: "2026-11-01T10:00:00Z",
      },
    };
    expect(ExtPromptContributeParamsSchema.parse(prompt)).toEqual(prompt);
    expect(ExtPromptContributeResultSchema.parse({})).toEqual({ sections: [] });
    expect(
      ExtPromptContributeResultSchema.safeParse({
        sections: [{ key: "k", title: "t", body: "b", order: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it("reads the event notification: the bus envelope, for a typed event and an extension's own", () => {
    const envelope = {
      id: "01JC0000000000000000000001",
      at: "2026-11-01T10:00:01.123Z",
      type: "agent.turn.completed",
      v: 1,
      parent: null,
      turn: "01JC0000000000000000000000",
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      key: null,
      scope: null,
      source: "agent",
      data: { turn: "01JC0000000000000000000000", context, text: "沒幹嘛啊" },
    };
    expect(ExtEventNotificationSchema.parse({ envelope })).toEqual({ envelope });
    const own = { ...envelope, type: "ext.x.y", source: "ext.x", data: { n: [1, null] } };
    expect(ExtEventNotificationSchema.parse({ envelope: own, future: 1 })).toEqual({
      envelope: own,
    });
    // A type nobody knows still reads: the envelope does not depend on the type.
    expect(
      ExtEventNotificationSchema.safeParse({ envelope: { ...envelope, type: "from.the.future" } })
        .success,
    ).toBe(true);
    // Protocol 1's form is not an envelope.
    expect(
      ExtEventNotificationSchema.safeParse({
        topic: "agent.turn.completed",
        id: envelope.id,
        ts: envelope.at,
        source: "agent",
        causation: null,
        correlation: null,
        event: { type: "agent_turn_completed", data: envelope.data },
      }).success,
    ).toBe(false);
    const { session: _session, ...missing } = envelope;
    expect(ExtEventNotificationSchema.safeParse({ envelope: missing }).success).toBe(false);
  });
});

describe("what the extension sends", () => {
  it("reads events.publish: a type and its data, and the context a publisher may set", () => {
    expect(ExtEventsPublishParamsSchema.parse({ type: "ext.x.hi" })).toEqual({
      type: "ext.x.hi",
      data: null,
      turn: null,
      parent: null,
      key: null,
    });
    const full = {
      type: "game.mc.death",
      data: { type: "death", important: true },
      turn: "01JC0000000000000000000000",
      parent: "01JC0000000000000000000001",
      key: "death:1",
    };
    expect(ExtEventsPublishParamsSchema.parse({ ...full, scope: "public" })).toEqual(full);
    // Protocol 1's form names a topic, not a type.
    expect(ExtEventsPublishParamsSchema.safeParse({ topic: "ext.x.hi", payload: 1 }).success).toBe(
      false,
    );
  });
});

describe("tasks", () => {
  it("reads a spec within its bounds", () => {
    const spec = { id: "t1", goal: "goto", args: { x: 1 }, budget_s: 30 };
    expect(ExtTaskSpecSchema.parse(spec)).toEqual(spec);
    for (const bad of [
      { ...spec, id: "" },
      { ...spec, id: "x".repeat(65) },
      { ...spec, goal: "" },
      { ...spec, args: [] },
      { ...spec, budget_s: 0 },
      { ...spec, budget_s: EXT_LIMITS.TASK_BUDGET_MAX_S + 1 },
    ]) {
      expect(ExtTaskSpecSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("reads every kind of event, and refuses a code it does not know", () => {
    const events = [
      { type: "started", task: "a", goal: "goto", at },
      { type: "progress", task: "a", progress: null, detail: "far", at },
      { type: "done", task: "a", detail: "ok", data: { n: 1 }, at },
      { type: "failed", task: "a", code: "died", detail: "dead", at },
      { type: "steered", task: "a", steer: "s", outcome: "too_late", detail: "", at },
    ];
    for (const event of events) expect(ExtTaskEventSchema.parse(event)).toEqual(event);
    expect(
      ExtTaskEventSchema.safeParse({ type: "failed", task: "a", code: "nope", detail: "", at })
        .success,
    ).toBe(false);
  });

  it("reads a steer, an observed state and an executor", () => {
    const steer = { id: "s", task: "t", patch: { x: 2 }, why: "w", cause: "c" };
    expect(ExtTaskSteerSchema.parse(steer)).toEqual(steer);
    expect(ExtTaskSteerSchema.safeParse({ ...steer, why: "x".repeat(401) }).success).toBe(false);
    const state = { at, state: { hp: 20 }, task: null, summary: "fine" };
    expect(ExtStructuredStateSchema.parse(state)).toEqual(state);
    expect(
      ExtExecutorDeclSchema.parse({ name: "X", goals: [{ name: "a", description: "b" }] }).goals,
    ).toEqual([{ name: "a", description: "b", parameters: null, budget_s: null }]);
    expect(
      ExtExecutorDeclSchema.safeParse({ name: "X", goals: [{ name: "Bad Name", description: "" }] })
        .success,
    ).toBe(false);
  });
});

describe("the envelope", () => {
  it("describes a request, a notification, a result and an error", () => {
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "shutdown", params: {} },
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad" } },
    ]) {
      expect(ExtRpcMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(ExtRpcMessageSchema.safeParse({ jsonrpc: "1.0", method: "x" }).success).toBe(false);
  });
});
