import { describe, expect, it } from "vitest";
import { type ExtensionContext, toolDecl } from "../src/extension.js";
import * as Events from "../src/events.js";
import { ErrorCode, type Envelope, type Invocation, PROTOCOL_VERSION } from "../src/types.js";
import { account, context, fakeHost, toolContext, waitFor } from "./helpers.js";

function envelope(type: string, data: Envelope["data"] = {}): Envelope {
  return {
    id: "01J00000000000000000000001",
    at: "2026-11-01T00:00:00Z",
    type,
    v: 1,
    parent: null,
    turn: null,
    session: null,
    space_id: null,
    room_id: null,
    person_id: null,
    account_id: null,
    key: null,
    scope: null,
    source: "test",
    data,
  };
}

function invocation(path: string[], args: Invocation["args"] = {}): Invocation {
  return {
    path,
    args,
    invoker: account,
    invoker_display_name: "Owen",
    context,
    invoker_is_guild_admin: false,
  };
}

describe("extension runtime", () => {
  it("returns activation registrations as contributions", async () => {
    let seenCtx: ExtensionContext | undefined;
    const h = fakeHost({
      activate(ctx) {
        seenCtx = ctx;
        ctx.tools.register({
          name: "weather.now",
          description: "天氣",
          params: { city: { type: "string" }, unit: { type: "string" } },
          optional: ["unit"],
          permission: "tools.weather",
          run: ({ city }) => `sunny in ${city}`,
        });
        ctx.commands.register({
          path: "dice roll",
          description: "擲骰子",
          args: [
            { name: "sides", description: "面數", type: "integer", required: false },
            { name: "style", description: "樣式", choices: ["plain", "fancy"] },
          ],
          run: () => "4",
        });
        ctx.prompt.register("facts", () => [{ title: "事實", body: "x" }]);
        ctx.events.on("custom.*", () => {});
        ctx.events.on("custom.*", () => {});
      },
    });
    const result = await h.initialize();
    expect(seenCtx?.config).toEqual({ greeting: "hi" });
    expect(seenCtx?.id).toBe("test.ext");
    expect(result.contributions).toEqual({
      tools: [
        {
          name: "weather.now",
          description: "天氣",
          parameters: {
            type: "object",
            properties: { city: { type: "string" }, unit: { type: "string" } },
            required: ["city"],
          },
          permission: "tools.weather",
        },
      ],
      commands: [
        {
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
        },
      ],
      prompts: ["facts"],
      subscriptions: ["custom.*"],
    });
    expect(h.requests).toEqual([]);
    expect(h.runtime.phase).toBe("active");
    await expect(h.initialize()).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it("dispatches tool calls, commands and prompts", async () => {
    const h = fakeHost({
      activate(ctx) {
        ctx.tools.register({
          name: "echo.say",
          description: "echo",
          params: { text: { type: "string" } },
          run: ({ text }, call) => `${text} for ${call.account.id}`,
        });
        ctx.tools.register({
          name: "obj",
          description: "returns an object",
          run: () => ({ n: 1 }),
        });
        ctx.tools.register({
          name: "fail",
          description: "throws",
          run: () => {
            throw new Error("broken tool");
          },
        });
        ctx.commands.register({ path: "hello", description: "hi", run: (inv) => `hi ${inv.invoker_display_name}` });
        ctx.commands.register({
          path: ["secret"],
          description: "s",
          ephemeral: true,
          run: () => ({ text: "shh", ephemeral: true }),
        });
        ctx.prompt.register("facts", (req) => [{ title: "事實", body: req.query, order: 3 }]);
      },
    });
    await h.initialize();
    const call = (name: string, args: unknown = {}) =>
      h.host.request("tools.call", { name, args, context: toolContext });
    expect(await call("echo.say", { text: "yo" })).toEqual({ content: "yo for 42" });
    expect(await call("obj")).toEqual({ content: '{"n":1}' });
    await expect(call("fail")).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: "broken tool",
    });
    await expect(call("missing")).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });

    expect(await h.host.request("commands.invoke", invocation(["hello"]))).toEqual({ text: "hi Owen" });
    expect(await h.host.request("commands.invoke", invocation(["secret"]))).toEqual({
      text: "shh",
      ephemeral: true,
    });
    await expect(h.host.request("commands.invoke", invocation(["nope"]))).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });

    const sections = await h.host.request("prompt.contribute", {
      key: "facts",
      request: { query: "你好" },
    });
    expect(sections).toEqual({ sections: [{ key: "facts", title: "事實", body: "你好", order: 3 }] });
  });

  it("sends requests for registrations after activation", async () => {
    let ctx!: ExtensionContext;
    const h = fakeHost({
      activate(c) {
        ctx = c;
      },
    });
    await h.initialize();
    await ctx.tools.register({ name: "late", description: "late tool", run: () => "ok" });
    await ctx.commands.register({ path: "late cmd", description: "late", run: () => "ok" });
    await ctx.prompt.register("late", () => []);
    await ctx.tools.unregister("late");
    expect(h.requests.map((r) => r.method)).toEqual([
      "tools.register",
      "commands.register",
      "prompt.register",
      "tools.unregister",
    ]);
    expect(h.requests[0]?.params).toMatchObject({ name: "late", parameters: { type: "object" } });
    expect(h.requests[1]?.params).toMatchObject({ path: ["late", "cmd"] });
    await expect(
      h.host.request("tools.call", { name: "late", args: {}, context: toolContext }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it("drops a registration the host refuses", async () => {
    let ctx!: ExtensionContext;
    const h = fakeHost(
      {
        activate(c) {
          ctx = c;
        },
      },
      (call) => {
        if (call.method === "tools.register") {
          throw Object.assign(new Error("no tools"), { code: ErrorCode.PermissionDenied });
        }
        return {};
      },
    );
    await h.initialize();
    await expect(ctx.tools.register({ name: "t", description: "t", run: () => "" })).rejects.toThrow();
    await expect(
      h.host.request("tools.call", { name: "t", args: {}, context: toolContext }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it("routes events by pattern and publishes", async () => {
    const got: string[] = [];
    let ctx!: ExtensionContext;
    const h = fakeHost({
      activate(c) {
        ctx = c;
        c.events.on("custom.a.*", (e) => {
          got.push(`a:${e.type}`);
        });
        c.events.on("*", (e) => {
          got.push(`all:${e.type}`);
        });
      },
    });
    await h.initialize();
    // Not an envelope (protocol 1's form among them): ignored.
    h.host.notify("event", { topic: "custom.a.y", event: { type: "custom", data: {} } });
    h.host.notify("event", { envelope: { type: "custom.a.z" } });
    h.host.notify("event", { envelope: envelope("custom.a.x") });
    h.host.notify("event", { envelope: envelope("custom.b") });
    await waitFor(() => got.length === 3);
    expect(got.sort()).toEqual(["a:custom.a.x", "all:custom.a.x", "all:custom.b"]);

    await ctx.events.publish("custom.out", { n: 1 }, { turn: "01J" });
    const off = ctx.events.on("custom.new", () => {});
    await waitFor(() => h.requests.length === 2);
    off();
    await waitFor(() => h.requests.length === 3);
    expect(h.requests).toEqual([
      { method: "events.publish", params: { type: "custom.out", data: { n: 1 }, turn: "01J" } },
      { method: "events.subscribe", params: { topics: ["custom.new"] } },
      { method: "events.unsubscribe", params: { topics: ["custom.new"] } },
    ]);
  });

  it("subscribes by definition: typed payloads, families through a prefix", async () => {
    const states: string[] = [];
    const games: string[] = [];
    const h = fakeHost({
      activate(c) {
        c.events.on(Events.VoicePlaybackEvent, (e) => {
          states.push(e.data.state);
        });
        c.events.on(Events.GameAdapterEvent, (e) => {
          games.push(`${e.type}:${e.data.type}`);
        });
      },
    });
    const result = await h.initialize();
    expect(result.contributions.subscriptions).toEqual(["voice.playback", "game.*"]);
    const playback = { context, turn: null, state: "finished", text: "嗨" };
    // Another version, and a type under `game.` the family does not cover: not delivered.
    h.host.notify("event", { envelope: { ...envelope("voice.playback", playback), v: 2 } });
    h.host.notify("event", { envelope: envelope("game.osu", { type: "x" }) });
    h.host.notify("event", { envelope: envelope("voice.playback", playback) });
    h.host.notify("event", { envelope: envelope("game.osu.death", { type: "death" }) });
    await waitFor(() => states.length === 1 && games.length === 1);
    expect(states).toEqual(["finished"]);
    expect(games).toEqual(["game.osu.death:death"]);
  });

  it("refuses a host that speaks another protocol, saying which side is older", async () => {
    const h = fakeHost({ activate() {} });
    await expect(h.initialize({ protocol: 1 })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message:
        "the host speaks extension protocol 1 and this extension speaks 2; the host is older: update Miyoria",
    });
    await expect(h.initialize({ protocol: 3 })).rejects.toMatchObject({
      message:
        "the host speaks extension protocol 3 and this extension speaks 2; the extension is older: rebuild it against a newer @miyoria/sdk",
    });
    // Refused before activating: a host that speaks 2 can still initialize it.
    expect((await h.initialize()).protocol).toBe(PROTOCOL_VERSION);
  });

  it("uses host storage and logs through notifications", async () => {
    const store = new Map<string, unknown>();
    let ctx!: ExtensionContext;
    const h = fakeHost(
      {
        activate(c) {
          ctx = c;
        },
      },
      ({ method, params }) => {
        const p = params as { key: string; value?: unknown };
        if (method === "storage.set") {
          if (p.value === null) store.delete(p.key);
          else store.set(p.key, p.value);
          return {};
        }
        if (method === "storage.get") return { value: store.get(p.key) ?? null };
        return {};
      },
    );
    await h.initialize();
    expect(await ctx.storage.get("k")).toBeUndefined();
    await ctx.storage.set("k", { score: 3 });
    expect(await ctx.storage.get("k")).toEqual({ score: 3 });
    await ctx.storage.delete("k");
    expect(await ctx.storage.get("k")).toBeUndefined();

    ctx.log.warn("careful", { n: 1 });
    await waitFor(() => h.notifications.length === 1);
    expect(h.notifications[0]).toEqual({
      method: "log",
      params: { level: "warn", message: "careful", fields: { n: 1 } },
    });
  });

  it("runs shutdown hooks and deactivate before exiting", async () => {
    const order: string[] = [];
    const h = fakeHost({
      activate(ctx) {
        ctx.onShutdown(() => {
          order.push("hook");
        });
      },
      deactivate() {
        order.push("deactivate");
      },
    });
    await h.initialize();
    h.host.notify("shutdown", {});
    await waitFor(() => h.exits.length === 1);
    expect(order).toEqual(["hook", "deactivate"]);
    expect(h.exits).toEqual([0]);
  });

  it("declares steer only when the executor has it, and dispatches task.steer to it", async () => {
    const steers: unknown[] = [];
    const base = {
      observe: async () => ({ at: "2026-11-01T00:00:00Z", state: {}, task: null, summary: "" }),
      start: async () => {},
      cancel: async () => {},
      events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }),
    };
    const info = { name: "Fake", goals: [] };
    const steerable = fakeHost({
      activate: (ctx) =>
        ctx.tasks.register({ ...base, steer: async (steer) => void steers.push(steer) }, info),
    });
    const declared = await steerable.initialize();
    expect(declared.contributions.executor?.steer).toBe(true);
    const steer = { id: "s1", task: "t1", patch: { a: 1 }, why: "w", cause: "c" };
    expect(await steerable.host.request("task.steer", { steer })).toEqual({});
    expect(steers).toEqual([steer]);
    await expect(steerable.host.request("task.steer", {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    const plain = fakeHost({ activate: (ctx) => ctx.tasks.register(base, info) });
    const plainInit = await plain.initialize();
    expect(plainInit.contributions.executor).not.toHaveProperty("steer");
    await expect(plain.host.request("task.steer", { steer })).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });
});

describe("toolDecl", () => {
  it("sends read_only only when the tool says it only looks", () => {
    const base = { name: "a", description: "b", run: () => "" };
    expect(toolDecl(base)).not.toHaveProperty("read_only");
    expect(toolDecl({ ...base, readOnly: false })).not.toHaveProperty("read_only");
    expect(toolDecl({ ...base, readOnly: true }).read_only).toBe(true);
  });
});
