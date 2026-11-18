// The extension protocol as the host speaks it, pinned: one example of every message in each
// direction goes through the host's parse and build code, and the exact text on the wire (or the
// exact parsed value) is the expectation. These tests describe behaviour, not code: they hold
// across moving the schemas and the RPC machinery into other packages.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { CommandRegistry, CommandRegistryKey, Invocation, Permissions } from "@miyoria/commands";
import type { ToolContext, ToolSpec } from "@miyoria/llm/tools";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  EventBus,
  exemptFromBusCheck,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type BusEnvelope,
  Events,
  type JsonValue,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  TaskExecutorsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANCEL_METHOD,
  CommandSpecSchema,
  ContributionsSchema,
  discover,
  ExecutorDeclSchema,
  encodeFrame,
  FrameDecoder,
  FrameError,
  HOST_VERSION,
  INTERNAL_ERROR,
  InitializeResultSchema,
  invokeCommand,
  MAX_FRAME,
  METHOD_NOT_FOUND,
  Peer,
  PROTOCOL_VERSION,
  ProxyExecutor,
  ProxyPrompt,
  ProxyTool,
  RpcError,
  type RpcHandler,
  TaskExecutorRegistry,
  TIMEOUT,
  ToolDeclSchema,
} from "../src/index.js";

// The custom.* and other.thing topics are made up to test who may publish and receive.
exemptFromBusCheck(["custom.hello", "other.thing"]);

const HERE = dirname(fileURLToPath(import.meta.url));

const context = { platform: "discord", scope: "123", channel: "456", kind: "channel" } as const;
const account = { platform: "discord", id: "789" };

/** What `peer` wrote to `out` so far, as the text of each frame body. */
function bodies(out: PassThrough): string[] {
  const chunk = out.read() as Buffer | null;
  if (chunk === null) return [];
  return new FrameDecoder().push(chunk).map((b) => b.toString("utf8"));
}

/** A fake extension: reads frames from `input`, records them, answers requests with `answer`. */
function fakeExtension(
  input: PassThrough,
  output: PassThrough,
  answer: (method: string, params: JsonValue) => JsonValue | undefined,
): { seen: string[] } {
  const seen: string[] = [];
  const decoder = new FrameDecoder();
  input.on("data", (chunk: Buffer) => {
    for (const body of decoder.push(chunk)) {
      const text = body.toString("utf8");
      seen.push(text);
      const message = JSON.parse(text) as { id?: number; method?: string; params?: JsonValue };
      if (message.id === undefined || message.method === undefined) continue;
      const result = answer(message.method, message.params ?? null);
      if (result === undefined) continue; // never answers
      output.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result }));
    }
  });
  return { seen };
}

describe("extension to host: what the host reads", () => {
  it("reads a tool declaration, with its defaults and without unknown keys", () => {
    expect(
      ToolDeclSchema.parse({
        name: "weather.now",
        description: "now",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        permission: "tools.weather",
        read_only: true,
        future_field: 1,
      }),
    ).toEqual({
      name: "weather.now",
      description: "now",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      permission: "tools.weather",
      read_only: true,
    });
    expect(ToolDeclSchema.parse({ name: "a", description: "b" })).toEqual({
      name: "a",
      description: "b",
      parameters: { type: "object", properties: {} },
      permission: null,
      read_only: false,
    });
    expect(ToolDeclSchema.safeParse({ name: "a" }).success).toBe(false);
    expect(ToolDeclSchema.safeParse({ name: 1, description: "b" }).success).toBe(false);
    expect(ToolDeclSchema.safeParse("a").success).toBe(false);
  });

  it("reads a command spec: every field is required, choice kinds carry choices", () => {
    const spec = {
      path: ["dice", "roll"],
      description: "roll",
      args: [
        { name: "sides", description: "n", kind: { type: "integer" }, required: false },
        {
          name: "style",
          description: "s",
          kind: { type: "choice", choices: ["plain", "fancy"] },
          required: true,
        },
      ],
      permission: "",
      ephemeral: false,
    };
    expect(CommandSpecSchema.parse({ ...spec, extra: true })).toEqual(spec);
    expect(CommandSpecSchema.safeParse({ ...spec, ephemeral: undefined }).success).toBe(false);
    expect(
      CommandSpecSchema.safeParse({
        ...spec,
        args: [{ name: "x", description: "", kind: { type: "float" }, required: true }],
      }).success,
    ).toBe(false);
  });

  it("reads an executor declaration with its bounds", () => {
    const decl = {
      name: "Minecraft",
      goals: [
        {
          name: "goto",
          description: "walk",
          parameters: { type: "object" },
          budget_s: 120,
        },
      ],
      guide: "survive",
      steer: true,
    };
    expect(ExecutorDeclSchema.parse(decl)).toEqual(decl);
    expect(ExecutorDeclSchema.parse({ name: "X" })).toEqual({
      name: "X",
      goals: [],
      guide: null,
      steer: false,
    });
    expect(
      ExecutorDeclSchema.parse({ name: "X", goals: [{ name: "a", description: "b" }] }).goals,
    ).toEqual([{ name: "a", description: "b", parameters: null, budget_s: null }]);
    expect(ExecutorDeclSchema.safeParse({ name: "" }).success).toBe(false);
    expect(ExecutorDeclSchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
    expect(
      ExecutorDeclSchema.safeParse({ name: "X", goals: [{ name: "Bad Name", description: "" }] })
        .success,
    ).toBe(false);
    expect(
      ExecutorDeclSchema.safeParse({
        name: "X",
        goals: [{ name: "a", description: "", budget_s: 86_401 }],
      }).success,
    ).toBe(false);
    expect(
      ExecutorDeclSchema.safeParse({
        name: "X",
        goals: [{ name: "a", description: "", budget_s: 0 }],
      }).success,
    ).toBe(false);
    expect(ExecutorDeclSchema.safeParse({ name: "X", guide: "g".repeat(8001) }).success).toBe(
      false,
    );
  });

  it("reads contributions and the initialize result, every field optional", () => {
    // Without `protocol`: an extension of protocol 1 (the handshake refuses it).
    expect(InitializeResultSchema.parse({})).toEqual({
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
    expect(
      InitializeResultSchema.parse({
        protocol: 2,
        contributions: {
          tools: [{ name: "dice", description: "roll" }],
          prompts: ["facts"],
          subscriptions: ["agent.turn.completed"],
          executor: { name: "E" },
          unknown_part: [],
        },
        extra: 1,
      }),
    ).toEqual({
      protocol: 2,
      contributions: {
        tools: [
          {
            name: "dice",
            description: "roll",
            parameters: { type: "object", properties: {} },
            permission: null,
            read_only: false,
          },
        ],
        commands: [],
        prompts: ["facts"],
        subscriptions: ["agent.turn.completed"],
        executor: { name: "E", goals: [], guide: null, steer: false },
        status: false,
      },
    });
    expect(ContributionsSchema.safeParse({ tools: "no" }).success).toBe(false);
    expect(InitializeResultSchema.safeParse(null).success).toBe(false);
  });
});

describe("host to extension: what the host writes", () => {
  it("sends tools.call with the tool context", async () => {
    const hostOut = new PassThrough();
    const peer = new Peer(hostOut);
    const spec: ToolSpec = { name: "weather_now", description: "d", parameters: {} };
    const tool = new ProxyTool(peer, "weather.now", spec, null, 1000);
    const input = new PassThrough();
    const ext = fakeExtension(hostOut, input, () => ({ content: "晴,22 度" }));
    void peer.serve(input, { request: async () => null, notification: () => {} });
    const text = await tool.call(
      {
        turn: "01JC0000000000000000000000",
        context,
        account,
        message: { context, id: "999" },
        priority: "direct",
        signal: new AbortController().signal,
      } as unknown as ToolContext,
      { city: "Taipei" },
    );
    expect(text).toBe("晴,22 度");
    expect(ext.seen).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"tools.call","params":{"name":"weather.now","args":{"city":"Taipei"},"context":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"account":{"platform":"discord","id":"789"},"message":{"context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"id":"999"},"priority":"direct"}}}',
    ]);
  });

  it("sends commands.invoke and reads its reply", async () => {
    const hostOut = new PassThrough();
    const peer = new Peer(hostOut);
    const input = new PassThrough();
    const ext = fakeExtension(hostOut, input, () => ({ text: "哈囉,小明!", ephemeral: true }));
    void peer.serve(input, { request: async () => null, notification: () => {} });
    const inv = Invocation.create("hello", account, context);
    inv.invoker_display_name = "Owen";
    inv.withArg("name", "小明");
    const spec = {
      path: ["hello"],
      description: "",
      args: [],
      permission: "",
      ephemeral: false,
    };
    const reply = await invokeCommand(peer, spec, inv, 1000);
    expect(reply).toEqual({ text: "哈囉,小明!", ephemeral: true });
    expect(ext.seen).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"commands.invoke","params":{"path":["hello"],"args":{"name":"小明"},"invoker":{"platform":"discord","id":"789"},"invoker_display_name":"Owen","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"invoker_is_guild_admin":false,"platform_roles":[],"resolved_users":{}}}',
    ]);
  });

  it("answers a plain string and fills the default for ephemeral", async () => {
    const hostOut = new PassThrough();
    const peer = new Peer(hostOut);
    const input = new PassThrough();
    fakeExtension(hostOut, input, () => "just text");
    void peer.serve(input, { request: async () => null, notification: () => {} });
    const inv = Invocation.create("hello", account, context);
    const spec = { path: ["hello"], description: "", args: [], permission: "", ephemeral: true };
    expect(await invokeCommand(peer, spec, inv, 1000)).toEqual({
      text: "just text",
      ephemeral: true,
    });
  });

  it("sends prompt.contribute and reads the sections", async () => {
    const hostOut = new PassThrough();
    const peer = new Peer(hostOut);
    const input = new PassThrough();
    const ext = fakeExtension(hostOut, input, () => ({
      sections: [{ key: "facts", title: "小知識", body: "……", order: 50 }],
    }));
    void peer.serve(input, { request: async () => null, notification: () => {} });
    const prompt = new ProxyPrompt(peer, "ext.x.facts", "facts", 1000);
    const request: PromptRequest = {
      profile: "deepseek-chan",
      turn: "01JC0000000000000000000000",
      context,
      participants: [{ account, display_name: "Owen", person: null }],
      speakers: [account],
      query: "Owen: 今天要幹嘛",
      recent: [],
      voice: false,
      now: "2026-11-01T10:00:00Z",
    };
    expect(await prompt.contribute(request)).toEqual([
      { key: "facts", title: "小知識", body: "……", order: 50 },
    ]);
    expect(ext.seen).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"prompt.contribute","params":{"key":"facts","request":{"profile":"deepseek-chan","turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"participants":[{"account":{"platform":"discord","id":"789"},"display_name":"Owen","person":null}],"speakers":[{"platform":"discord","id":"789"}],"query":"Owen: 今天要幹嘛","recent":[],"voice":false,"now":"2026-11-01T10:00:00Z"}}}',
    ]);
  });

  it("sends task.start, task.cancel, task.steer and task.observe", async () => {
    const hostOut = new PassThrough();
    const peer = new Peer(hostOut);
    const input = new PassThrough();
    const ext = fakeExtension(
      hostOut,
      input,
      (method): JsonValue =>
        method === "task.observe"
          ? { at: "2026-11-14T00:00:00.000Z", state: { hp: 20 }, task: null, summary: "fine" }
          : {},
    );
    void peer.serve(input, { request: async () => null, notification: () => {} });
    const proxy = new ProxyExecutor(
      peer,
      { owner: "game.mc", name: "Minecraft", goals: [], guide: null },
      { callTimeoutMs: 1000, graceMs: 1000, publish: () => {}, steer: true },
    );
    await proxy.start({ id: "t1", goal: "goto", args: { x: 1 }, budget_s: 30 });
    await proxy.steer?.({ id: "s1", task: "t1", patch: { x: 2 }, why: "closer", cause: "c1" });
    await proxy.cancel("t1");
    expect(await proxy.observe()).toEqual({
      at: "2026-11-14T00:00:00.000Z",
      state: { hp: 20 },
      task: null,
      summary: "fine",
    });
    proxy.close("disconnected", "done");
    expect(ext.seen).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"task.start","params":{"task":{"id":"t1","goal":"goto","args":{"x":1},"budget_s":30}}}',
      '{"jsonrpc":"2.0","id":2,"method":"task.steer","params":{"steer":{"id":"s1","task":"t1","patch":{"x":2},"why":"closer","cause":"c1"}}}',
      '{"jsonrpc":"2.0","id":3,"method":"task.cancel","params":{"task":"t1"}}',
      '{"jsonrpc":"2.0","id":4,"method":"task.observe","params":{}}',
    ]);
  });

  it("reads every kind of task.event notification, and drops what is not one", () => {
    const published: unknown[] = [];
    const out = new PassThrough();
    const proxy = new ProxyExecutor(
      new Peer(out),
      { owner: "game.mc", name: "M", goals: [], guide: null },
      { callTimeoutMs: 1000, graceMs: 1000, publish: (e) => published.push(e), steer: true },
    );
    const at = "2026-11-14T00:00:00.000Z";
    for (const event of [
      { type: "started", task: "a", goal: "goto", at },
      { type: "progress", task: "a", progress: 1.5, detail: "far", at },
      { type: "progress", task: "a", progress: null, at },
      { type: "done", task: "a", detail: "ok", data: { n: 1 }, at },
      { type: "failed", task: "a", code: "internal", detail: "late", at },
      { type: "started", task: "b", goal: "g", at, extra: 1 },
      { type: "failed", task: "b", code: "nope", detail: "", at },
      { type: "failed", task: "b", code: "died", detail: "dead", at },
      "junk",
    ]) {
      proxy.onEvent({ event } as JsonValue);
    }
    expect(published).toEqual([
      { type: "started", task: "a", goal: "goto", at },
      { type: "progress", task: "a", progress: 1, detail: "far", at },
      { type: "progress", task: "a", progress: null, detail: "", at },
      { type: "done", task: "a", detail: "ok", data: { n: 1 }, at },
      { type: "started", task: "b", goal: "g", at },
      { type: "failed", task: "b", code: "died", detail: "dead", at },
    ]);
  });
});

describe("the rpc layer, as the host runs it", () => {
  const serve = (peer: Peer, input: PassThrough, handler: RpcHandler) => {
    peer.serve(input, handler).catch(() => undefined);
  };
  const frame = (text: string) =>
    Buffer.concat([
      Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n`),
      Buffer.from(text),
    ]);
  const noop: RpcHandler = { request: async () => null, notification: () => {} };

  it("answers a request, an unknown method and a failing handler with exact frames", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const peer = new Peer(out);
    const handler: RpcHandler = {
      async request(method, params) {
        if (method === "echo") return params;
        if (method === "denied") throw RpcError.denied("no");
        if (method === "data") throw new RpcError(-32003, "taken", { name: "x" });
        if (method === "boom") throw new Error("boom");
        throw new RpcError(METHOD_NOT_FOUND, `unknown method \`${method}\``);
      },
      notification: () => {},
    };
    serve(peer, input, handler);
    input.write(frame('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":[1,"二"]}}'));
    input.write(frame('{"jsonrpc":"2.0","id":2,"method":"nope"}'));
    input.write(frame('{"jsonrpc":"2.0","id":3,"method":"denied","params":null}'));
    input.write(frame('{"jsonrpc":"2.0","id":"s","method":"data"}'));
    input.write(frame('{"jsonrpc":"2.0","id":5,"method":"boom"}'));
    input.write(
      frame('{"jsonrpc":"2.0","id":6,"method":"echo","params":{"k":1},"unknown_key":true}'),
    );
    await sleep(30);
    expect(bodies(out)).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"a":[1,"二"]}}',
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"unknown method `nope`"}}',
      '{"jsonrpc":"2.0","id":3,"error":{"code":-32001,"message":"no"}}',
      '{"jsonrpc":"2.0","id":"s","error":{"code":-32003,"message":"taken","data":{"name":"x"}}}',
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32603,"message":"boom"}}',
      '{"jsonrpc":"2.0","id":6,"result":{"k":1}}',
    ]);
  });

  it("answers a message that is not an object, and bad JSON, and goes on", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    serve(new Peer(out), input, noop);
    input.write(frame("[1,2]"));
    input.write(frame("{nope"));
    input.write(frame('{"jsonrpc":"2.0","id":9,"method":"x"}'));
    await sleep(30);
    const sent = bodies(out);
    expect(sent[0]).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"not an object"}}',
    );
    expect(JSON.parse(sent[1] as string)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(sent[2]).toBe('{"jsonrpc":"2.0","id":9,"result":null}');
  });

  it("serves notifications silently, a failing one included", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const seen: Array<[string, JsonValue]> = [];
    serve(new Peer(out), input, {
      request: async () => null,
      notification: (method, params) => {
        seen.push([method, params]);
        throw new Error("ignored");
      },
    });
    input.write(frame('{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"hi"}}'));
    input.write(frame('{"jsonrpc":"2.0","method":"bare"}'));
    await sleep(30);
    expect(seen).toEqual([
      ["log", { level: "info", message: "hi" }],
      ["bare", null],
    ]);
    expect(bodies(out)).toEqual([]);
  });

  it("writes requests, notifications and cancels exactly", async () => {
    const out = new PassThrough();
    const peer = new Peer(out);
    const controller = new AbortController();
    const aborted = peer.request("tools.call", { n: 1 }, 5000, controller.signal);
    controller.abort(new Error("turn cancelled"));
    await expect(aborted).rejects.toThrow("turn cancelled");
    await expect(peer.request("slow", {}, 20)).rejects.toMatchObject({ code: TIMEOUT });
    await peer.notify("shutdown", {});
    expect(peer.tryNotify("event", { topic: "a" })).toBe(true);
    expect(bodies(out)).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"tools.call","params":{"n":1}}',
      `{"jsonrpc":"2.0","method":"${CANCEL_METHOD}","params":{"id":1}}`,
      '{"jsonrpc":"2.0","id":2,"method":"slow","params":{}}',
      `{"jsonrpc":"2.0","method":"${CANCEL_METHOD}","params":{"id":2}}`,
      '{"jsonrpc":"2.0","method":"shutdown","params":{}}',
      '{"jsonrpc":"2.0","method":"event","params":{"topic":"a"}}',
    ]);
    // A request that is already aborted is never written.
    const gone = new AbortController();
    gone.abort(new Error("already"));
    await expect(peer.request("x", {}, 1000, gone.signal)).rejects.toThrow("already");
    expect(bodies(out)).toEqual([]);
  });

  it("fails a request with the error response it got, and with CLOSED when the stream ends", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const peer = new Peer(out);
    serve(peer, input, noop);
    const failed = peer.request("a", {}, 1000);
    input.write(
      frame('{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"taken","data":{"x":1}}}'),
    );
    await expect(failed).rejects.toMatchObject({ code: -32003, message: "taken", data: { x: 1 } });
    const bad = peer.request("b", {}, 1000);
    input.write(frame('{"jsonrpc":"2.0","id":2,"error":"oops"}'));
    await expect(bad).rejects.toMatchObject({ code: INTERNAL_ERROR, message: "bad error object" });
    // Responses to nothing, and unknown keys on a response, change nothing.
    input.write(frame('{"jsonrpc":"2.0","id":77,"result":1}'));
    const late = peer.request("c", {}, 1000);
    input.write(frame('{"jsonrpc":"2.0","id":3,"result":{"v":2},"extra":1}'));
    await expect(late).resolves.toEqual({ v: 2 });
    const open = peer.request("d", {}, 5000);
    input.end();
    await expect(open).rejects.toMatchObject({ code: -32005, message: "connection closed" });
    expect(peer.isClosed).toBe(true);
    // The writer is still open, so a notification still goes out; only an ended writer refuses.
    await expect(peer.notify("x", {})).resolves.toBeUndefined();
    out.end();
    await expect(peer.notify("x", {})).rejects.toMatchObject({ code: -32005 });
    expect(peer.tryNotify("x", {})).toBe(false);
  });

  it("rejects serve on a malformed frame, and ends a truncated stream with an error", async () => {
    for (const [bytes, message] of [
      ["Content-Type: x\r\n\r\n{}", /missing Content-Length/],
      ["garbage\r\n", /malformed header/],
      ["Content-Length: abc\r\n\r\n", /bad Content-Length/],
      [`Content-Length: ${MAX_FRAME + 1}\r\n\r\n`, /too large/],
      ["Content-Length: 50\r\n\r\n{}", /unexpected end/],
    ] as const) {
      const input = new PassThrough();
      const peer = new Peer(new PassThrough());
      const served = peer.serve(input, noop);
      input.write(bytes);
      if (message.source === "unexpected end") input.end();
      await expect(served).rejects.toThrow(message);
      await expect(served).rejects.toBeInstanceOf(FrameError);
      expect(peer.isClosed).toBe(true);
    }
  });

  it("accepts a frame of exactly the cap and refuses one byte more", () => {
    expect(MAX_FRAME).toBe(16 * 1024 * 1024);
    const body = Buffer.alloc(MAX_FRAME, 0x20);
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      Buffer.concat([Buffer.from(`Content-Length: ${MAX_FRAME}\r\n\r\n`), body]),
    );
    expect(frames).toHaveLength(1);
    expect((frames[0] as Buffer).length).toBe(MAX_FRAME);
    expect(() =>
      new FrameDecoder().push(Buffer.from(`Content-Length: ${MAX_FRAME + 1}\r\n\r\n`)),
    ).toThrow(/too large/);
  });

  it("counts Content-Length in bytes and reads headers in any case, extra ones ignored", () => {
    expect(encodeFrame({ t: "骰" }).toString("utf8")).toBe('Content-Length: 11\r\n\r\n{"t":"骰"}');
    const decoder = new FrameDecoder();
    const raw = 'content-type: application/json\r\nCONTENT-LENGTH: 7\r\n\r\n{"x":1}';
    expect(decoder.push(Buffer.from(raw)).map((b) => b.toString())).toEqual(['{"x":1}']);
    expect(() => decoder.end()).not.toThrow();
  });

  it("drops events when the writer queue is full, and keeps requests flowing", () => {
    // A writer that never drains: its queue fills, `tryNotify` says so, `notify` still writes.
    const slow = new PassThrough({ highWaterMark: 1 });
    const peer = new Peer(slow);
    const big = { blob: "x".repeat(1024 * 1024) };
    let queued = 0;
    while (peer.tryNotify("event", big) && queued < 100) queued++;
    expect(queued).toBeGreaterThan(0);
    expect(queued).toBeLessThan(100);
    expect(peer.tryNotify("event", {})).toBe(false);
  });
});

describe("the whole handshake against a recording extension", { timeout: 30_000 }, () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("writes initialize and event frames exactly, for a custom and a typed event", async () => {
    dir = mkdtempSync(join(tmpdir(), "miyoria-pin-"));
    mkdirSync(dir, { recursive: true });
    const record = join(dir, "frames.jsonl");
    const config = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(join(HERE, "recorder-ext"))}]\ninit_timeout_ms = 5000\nshutdown_grace_ms = 500\n` +
        `[extensions."test.recorder"]\nrecord = ${JSON.stringify(record)}\n`,
    );
    const bus = new EventBus();
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus, services });
    services.provide("app", ToolRegistryKey, new ToolRegistry());
    services.provide("app", CommandRegistryKey, new CommandRegistry(new Permissions()));
    services.provide("app", PromptContributorsKey, new PromptContributors());
    services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    services.provide("app", SupervisorKey, sup);
    services.provide("app", TaskExecutorsKey, new TaskExecutorRegistry());
    const discovery = discover(config, ".");
    for (const m of discovery.modules) await sup.register(m.module, m.config, m.enabled);
    await sup.startAll();
    let typed = "";
    try {
      const deadline = Date.now() + 5000;
      while (sup.list().find((m) => m.id === "ext.test.recorder")?.state !== "running") {
        if (Date.now() > deadline) throw new Error("recorder did not start");
        await sleep(25);
      }
      // A custom event: a type nobody registered, as a bus envelope made elsewhere.
      const envelope: BusEnvelope = {
        id: "01JC0000000000000000000001",
        at: "2026-11-14T00:00:01.123Z",
        type: "custom.hello",
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
        source: "test",
        data: { n: 1 },
      };
      bus.publishEnvelope(envelope);
      bus.publishEnvelope({ ...envelope, type: "other.thing", data: 1 });
      // A typed event, published by its definition.
      typed = bus.publish(
        "agent",
        Events.AgentTurnCompleted,
        { turn: "01JC0000000000000000000000", context, text: "嗨" },
        {
          now: Date.UTC(2026, 10, 14, 0, 0, 2, 5),
          turn: "01JC0000000000000000000000",
          parent: envelope.id,
          session: "discord:123:456",
        },
      ).id;
      await sleep(300);
    } finally {
      await sup.stopAll();
    }
    const lines = readFileSync(record, "utf8").trim().split("\n");
    const initialize = JSON.parse(lines[0] as string) as { params: { extension: { dir: string } } };
    const extensionDir = initialize.params.extension.dir;
    expect(lines[0]?.replace(JSON.stringify(extensionDir).slice(1, -1), "<dir>")).toBe(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":2,"host":{"name":"miyoria","version":"${HOST_VERSION}"},"extension":{"id":"test.recorder","version":"0.0.2","dir":"<dir>","game":null},"config":{"record":${JSON.stringify(record)}},"permissions":{"events":["custom.*","agent.turn.completed"],"tools":false,"commands":false,"network":[],"input":[]}}}`,
    );
    // Protocol 2: the bus envelope, every key in `BusEnvelopeSchema`'s order, nothing else.
    expect(lines[1]).toBe(
      '{"jsonrpc":"2.0","method":"event","params":{"envelope":{"id":"01JC0000000000000000000001","at":"2026-11-14T00:00:01.123Z","type":"custom.hello","v":1,"parent":null,"turn":"01JC0000000000000000000000","session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null,"source":"test","data":{"n":1}}}}',
    );
    expect(lines[2]).toBe(
      `{"jsonrpc":"2.0","method":"event","params":{"envelope":{"id":"${typed}","at":"2026-11-14T00:00:02.005Z","type":"agent.turn.completed","v":1,"parent":"01JC0000000000000000000001","turn":"01JC0000000000000000000000","session":"discord:123:456","space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null,"source":"agent","data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"text":"嗨"}}}}`,
    );
    expect(lines[3]).toBe('{"jsonrpc":"2.0","method":"shutdown","params":{}}');
    expect(lines).toHaveLength(4);
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
