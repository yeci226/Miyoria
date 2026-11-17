// The extension protocol as the SDK speaks it, pinned: one example of every message in each
// direction goes through the SDK's parse and build code, and the exact text on the wire is the
// expectation. These tests describe behaviour, not code: they hold across moving the types and
// the RPC machinery into other packages.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type ExtensionDefinition, runExtension } from "../src/extension.js";
import { FrameDecoder, FramingError, MAX_FRAME, encodeFrame } from "../src/framing.js";
import { CANCEL_METHOD, RpcError, RpcPeer } from "../src/rpc.js";
import { TaskFailure, TaskRunner } from "../src/task.js";
import { ErrorCode, PROTOCOL_VERSION } from "../src/types.js";
import { waitFor } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const frame = (text: string) =>
  Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n`), Buffer.from(text)]);

/** An extension runtime over raw streams: write text frames in, read the text frames it wrote. */
function raw(def: ExtensionDefinition, timeoutMs = 1000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const exits: number[] = [];
  const decoder = new FrameDecoder();
  const frames: string[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) frames.push(JSON.stringify(message));
  });
  const runtime = runExtension(def, { input, output, timeoutMs, exit: (c) => exits.push(c) });
  const send = (text: string) => input.write(frame(text));
  return { runtime, input, output, frames, exits, send };
}

const INIT =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":2,"host":{"name":"miyoria","version":"0.1.0"},"extension":{"id":"test.ext","version":"1.0.0","dir":"/ext","game":null},"config":{"greeting":"hi"},"permissions":{"events":["custom.*"],"tools":true,"commands":true,"network":[],"input":[]}}}';

const CONTEXT = '{"platform":"discord","scope":"123","channel":"456","kind":"channel"}';

/** Registers one of everything during `activate`. */
function rich(): ExtensionDefinition {
  return {
    async activate(ctx) {
      await ctx.tools.register({
        name: "weather.now",
        description: "now",
        params: { city: { type: "string" } },
        readOnly: true,
        permission: "tools.weather",
        run: (args, tc) => `${String(args.city)} for ${tc.account.id}`,
      });
      await ctx.tools.register({
        name: "dice",
        description: "roll",
        run: async () => ({ total: 17 }),
      });
      await ctx.commands.register({
        path: "dice roll",
        description: "roll",
        args: [
          { name: "sides", description: "n", type: "integer", required: false },
          { name: "style", description: "s", choices: ["plain", "fancy"] },
        ],
        run: (inv) => `rolled by ${inv.invoker_display_name}`,
      });
      await ctx.commands.register({
        path: ["hello"],
        description: "hi",
        permission: "owner.hello",
        ephemeral: true,
        run: () => ({ text: "哈囉" }),
      });
      await ctx.prompt.register("facts", (request) => [
        { title: "小知識", body: `q=${request.query}` },
        { title: "later", body: "b", key: "k2", order: 7 },
      ]);
      ctx.events.on("agent.*", () => {});
      await ctx.tasks.register(
        new TaskRunner({
          observe: async () => ({ state: { hp: 20 }, summary: "fine" }),
          run: () => new Promise(() => {}),
        }),
        {
          name: "Fake",
          goals: [{ name: "goto", description: "walk", parameters: { type: "object" }, budget_s: 120 }],
          guide: "  survive  ",
        },
      );
    },
  };
}

describe("host to extension: what the SDK reads and answers", () => {
  it("answers initialize with every contribution", async () => {
    const x = raw(rich());
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    expect(x.frames[0]).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"protocol":2,"contributions":{"tools":[{"name":"weather.now","description":"now","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},"permission":"tools.weather","read_only":true},{"name":"dice","description":"roll","parameters":{"type":"object","properties":{},"required":[]},"permission":null}],"commands":[{"path":["dice","roll"],"description":"roll","args":[{"name":"sides","description":"n","kind":{"type":"integer"},"required":false},{"name":"style","description":"s","kind":{"type":"choice","choices":["plain","fancy"]},"required":true}],"permission":"","ephemeral":false},{"path":["hello"],"description":"hi","args":[],"permission":"owner.hello","ephemeral":true}],"prompts":["facts"],"subscriptions":["agent.*"],"executor":{"name":"Fake","goals":[{"name":"goto","description":"walk","parameters":{"type":"object"},"budget_s":120}],"guide":"survive"}}}}',
    );
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("refuses initialize from a host that speaks protocol 1", async () => {
    const x = raw({ activate() {} });
    x.send(INIT.replace('"protocol":2', '"protocol":1'));
    await waitFor(() => x.frames.length >= 1);
    expect(x.frames[0]).toBe(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"the host speaks extension protocol 1 and this extension speaks 2; the host is older: update Miyoria"}}',
    );
  });

  it("answers an empty extension with empty contributions", async () => {
    const x = raw({ activate() {} });
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    expect(x.frames[0]).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"protocol":2,"contributions":{"tools":[],"commands":[],"prompts":[],"subscriptions":[]}}}',
    );
    // A second initialize is refused.
    x.send(INIT.replace('"id":1', '"id":2'));
    await waitFor(() => x.frames.length >= 2);
    expect(x.frames[1]).toBe(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"already initialized"}}',
    );
  });

  it("answers tools.call, commands.invoke and prompt.contribute", async () => {
    const x = raw(rich());
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    x.frames.length = 0;
    const toolContext = `{"turn":"01JC0000000000000000000000","context":${CONTEXT},"account":{"platform":"discord","id":"789"},"message":{"context":${CONTEXT},"id":"999"},"priority":"direct"}`;
    x.send(
      `{"jsonrpc":"2.0","id":7,"method":"tools.call","params":{"name":"weather.now","args":{"city":"Taipei","extra":1},"context":${toolContext}}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":8,"method":"tools.call","params":{"name":"dice","context":${toolContext}}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":9,"method":"tools.call","params":{"name":"nope","args":{},"context":${toolContext}}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":10,"method":"commands.invoke","params":{"path":["dice","roll"],"args":{"style":"plain"},"invoker":{"platform":"discord","id":"789"},"invoker_display_name":"Owen","context":${CONTEXT},"invoker_is_guild_admin":false,"platform_roles":[],"resolved_users":{}}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":11,"method":"commands.invoke","params":{"path":["hello"],"args":{},"invoker":{"platform":"discord","id":"789"},"invoker_display_name":"Owen","context":${CONTEXT},"invoker_is_guild_admin":false}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":12,"method":"commands.invoke","params":{"path":["nope"],"args":{},"invoker":{"platform":"discord","id":"789"},"invoker_display_name":"Owen","context":${CONTEXT},"invoker_is_guild_admin":false}}`,
    );
    x.send(
      `{"jsonrpc":"2.0","id":13,"method":"prompt.contribute","params":{"key":"facts","request":{"profile":"p","turn":"01JC0000000000000000000000","context":${CONTEXT},"participants":[],"speakers":[],"query":"今天","recent":[],"voice":false,"now":"2026-11-01T10:00:00Z"}}}`,
    );
    x.send(
      '{"jsonrpc":"2.0","id":14,"method":"prompt.contribute","params":{"key":"nope","request":{}}}',
    );
    await waitFor(() => x.frames.length >= 8);
    const byId = new Map(x.frames.map((f) => [(JSON.parse(f) as { id: number }).id, f]));
    expect(byId.get(7)).toBe('{"jsonrpc":"2.0","id":7,"result":{"content":"Taipei for 789"}}');
    expect(byId.get(8)).toBe('{"jsonrpc":"2.0","id":8,"result":{"content":"{\\"total\\":17}"}}');
    expect(byId.get(9)).toBe(
      '{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"unknown tool \\"nope\\""}}',
    );
    expect(byId.get(10)).toBe('{"jsonrpc":"2.0","id":10,"result":{"text":"rolled by Owen"}}');
    expect(byId.get(11)).toBe('{"jsonrpc":"2.0","id":11,"result":{"text":"哈囉"}}');
    expect(byId.get(12)).toBe(
      '{"jsonrpc":"2.0","id":12,"error":{"code":-32601,"message":"unknown command \\"nope\\""}}',
    );
    expect(byId.get(13)).toBe(
      '{"jsonrpc":"2.0","id":13,"result":{"sections":[{"key":"facts","title":"小知識","body":"q=今天","order":100},{"key":"k2","title":"later","body":"b","order":7}]}}',
    );
    expect(byId.get(14)).toBe(
      '{"jsonrpc":"2.0","id":14,"error":{"code":-32601,"message":"unknown prompt \\"nope\\""}}',
    );
  });

  it("delivers the event notification, and answers an unknown method", async () => {
    const seen: unknown[] = [];
    const x = raw({
      activate(ctx) {
        ctx.events.on("agent.*", (e) => {
          seen.push(e);
        });
      },
    });
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    const envelope = `{"id":"01JC0000000000000000000001","at":"2026-11-01T10:00:01.123Z","type":"agent.turn.completed","v":1,"parent":null,"turn":"01JC0000000000000000000000","session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null,"source":"agent","data":{"turn":"01JC0000000000000000000000","context":${CONTEXT},"text":"沒幹嘛啊"},"future":1}`;
    // Protocol 1's form, and a notification without an envelope: ignored.
    x.send(
      `{"jsonrpc":"2.0","method":"event","params":{"topic":"agent.turn.completed","id":"01JC0000000000000000000002","ts":"2026-11-01T10:00:01.123Z","source":"agent","causation":null,"correlation":null,"event":{"type":"agent_turn_completed","data":{}}}}`,
    );
    x.send('{"jsonrpc":"2.0","method":"event","params":{"topic":"other.thing"}}');
    x.send(`{"jsonrpc":"2.0","method":"event","params":{"envelope":${envelope},"later":1}}`);
    x.send('{"jsonrpc":"2.0","method":"unknown.note","params":{}}');
    x.send('{"jsonrpc":"2.0","id":5,"method":"no.such","params":{},"extra":true}');
    await waitFor(() => x.frames.length >= 2);
    expect(seen).toEqual([JSON.parse(envelope)]);
    expect(x.frames[1]).toBe(
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"unknown method \\"no.such\\""}}',
    );
    expect(x.frames).toHaveLength(2);
  });

  it("answers the task methods, and sends task.event notifications", async () => {
    const x = raw(rich());
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    x.frames.length = 0;
    x.send(
      '{"jsonrpc":"2.0","id":20,"method":"task.start","params":{"task":{"id":"t1","goal":"goto","args":{"x":1},"budget_s":30}}}',
    );
    await waitFor(() => x.frames.length >= 2);
    await waitFor(() => x.frames.length >= 2);
    x.send('{"jsonrpc":"2.0","id":21,"method":"task.observe","params":{}}');
    x.send('{"jsonrpc":"2.0","id":22,"method":"task.steer","params":{"steer":{"id":"s1","task":"t1","patch":{},"why":"w","cause":"c"}}}');
    x.send('{"jsonrpc":"2.0","id":23,"method":"task.cancel","params":{"task":"t1"}}');
    x.send('{"jsonrpc":"2.0","id":24,"method":"task.cancel","params":{}}');
    await waitFor(() => x.frames.length >= 7);
    const normalised = x.frames
      .map((f) => f.replace(/"at":"[^"]+"/g, '"at":"<at>"'))
      .sort();
    expect(normalised).toEqual(
      [
        '{"jsonrpc":"2.0","id":20,"result":{}}',
        '{"jsonrpc":"2.0","id":21,"result":{"at":"<at>","state":{"hp":20},"task":null,"summary":"fine"}}',
        '{"jsonrpc":"2.0","id":22,"error":{"code":-32601,"message":"this task executor cannot be steered"}}',
        '{"jsonrpc":"2.0","id":23,"result":{}}',
        '{"jsonrpc":"2.0","id":24,"error":{"code":-32602,"message":"task.cancel needs `task`"}}',
        '{"jsonrpc":"2.0","method":"task.event","params":{"event":{"type":"started","task":"t1","goal":"goto","at":"<at>"}}}',
        '{"jsonrpc":"2.0","method":"task.event","params":{"event":{"type":"failed","task":"t1","code":"cancelled","detail":"cancelled","at":"<at>"}}}',
      ].sort(),
    );
  });

  it("sends a refused task.start with its failure code in data", async () => {
    const x = raw({
      async activate(ctx) {
        await ctx.tasks.register(
          {
            observe: async () => {
              throw new TaskFailure("precondition", "not in a world");
            },
            start: async () => {
              throw new TaskFailure("invalid", "bad goal");
            },
            cancel: async () => {},
            events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
            steer: async () => {},
          },
          { name: "E", goals: [] },
        );
      },
    });
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    expect(x.frames[0]).toContain('"executor":{"name":"E","goals":[],"guide":null,"steer":true}');
    x.send('{"jsonrpc":"2.0","id":2,"method":"task.start","params":{"task":{}}}');
    x.send('{"jsonrpc":"2.0","id":3,"method":"task.observe","params":{}}');
    x.send('{"jsonrpc":"2.0","id":4,"method":"task.steer","params":{"steer":{"id":"s","task":"t"}}}');
    x.send('{"jsonrpc":"2.0","id":5,"method":"task.steer","params":{}}');
    await waitFor(() => x.frames.length >= 5);
    const byId = (f: string) => (JSON.parse(f) as { id: number }).id;
    expect(x.frames.slice(1).sort((a, b) => byId(a) - byId(b))).toEqual([
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad goal","data":{"code":"invalid"}}}',
      '{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"not in a world","data":{"code":"precondition"}}}',
      '{"jsonrpc":"2.0","id":4,"result":{}}',
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"task.steer needs `steer` with `id` and `task`"}}',
    ]);
  });

  it("stops a request's handler on $/cancelRequest, and answers with what the handler throws", async () => {
    let seen: AbortSignal | undefined;
    const x = raw({
      async activate(ctx) {
        await ctx.tools.register({
          name: "slow",
          description: "waits",
          run: (_args, tc) =>
            new Promise((_resolve, reject) => {
              seen = tc.signal;
              tc.signal?.addEventListener("abort", () => reject(tc.signal?.reason), { once: true });
            }),
        });
      },
    });
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1);
    x.send(
      `{"jsonrpc":"2.0","id":30,"method":"tools.call","params":{"name":"slow","args":{},"context":{"turn":"t","context":${CONTEXT},"account":{"platform":"discord","id":"1"},"message":{"context":${CONTEXT},"id":"m"},"priority":"direct"}}}`,
    );
    await waitFor(() => seen !== undefined);
    x.send(`{"jsonrpc":"2.0","method":"${CANCEL_METHOD}","params":{"id":30}}`);
    await waitFor(() => x.frames.length >= 2);
    expect(seen?.aborted).toBe(true);
    expect(x.frames[1]).toBe(
      '{"jsonrpc":"2.0","id":30,"error":{"code":-32800,"message":"cancelled by the host"}}',
    );
    expect(CANCEL_METHOD).toBe("$/cancelRequest");
    // Cancelling an id nobody runs is ignored.
    x.send(`{"jsonrpc":"2.0","method":"${CANCEL_METHOD}","params":{"id":999}}`);
    await sleep(20);
    expect(x.frames).toHaveLength(2);
  });

  it("exits when the host goes away, and not after shutdown", async () => {
    const x = raw({ activate() {} });
    x.input.end();
    await waitFor(() => x.exits.length === 1);
    expect(x.exits).toEqual([0]);
    const y = raw({ activate() {} });
    y.send(INIT);
    await waitFor(() => y.frames.length >= 1);
    y.send('{"jsonrpc":"2.0","method":"shutdown","params":{}}');
    await waitFor(() => y.exits.length >= 1);
    await sleep(20);
    expect(y.exits).toEqual([0]);
  });
});

describe("extension to host: what the SDK writes", () => {
  it("writes requests and notifications during and after activation", async () => {
    let ctx: Parameters<ExtensionDefinition["activate"]>[0] | undefined;
    const x = raw({
      activate(c) {
        ctx = c;
      },
    });
    x.send(INIT);
    await waitFor(() => x.frames.length >= 1 && ctx !== undefined);
    x.frames.length = 0;
    const c = ctx as NonNullable<typeof ctx>;
    const answer = (id: number, result: string) =>
      sleep(5).then(() => x.input.write(frame(`{"jsonrpc":"2.0","id":${id},"result":${result}}`)));
    const run = async () => {
      const a = c.tools.register({ name: "late.tool", description: "d", run: () => "x" });
      await waitFor(() => x.frames.length >= 1);
      await answer(1, '{"name":"late_tool"}');
      await a;
      const b = c.events.publish(
        "ext.test.ext.hello",
        { n: 1 },
        { turn: "01JC0000000000000000000000", parent: "01JC0000000000000000000001" },
      );
      await waitFor(() => x.frames.length >= 2);
      await answer(2, "{}");
      await b;
      const g = c.storage.get<number>("k");
      await waitFor(() => x.frames.length >= 3);
      await answer(3, '{"value":5}');
      expect(await g).toBe(5);
      const s = c.storage.set("k", { n: 1 });
      await waitFor(() => x.frames.length >= 4);
      await answer(4, "{}");
      await s;
      const d = c.storage.delete("k");
      await waitFor(() => x.frames.length >= 5);
      await answer(5, "{}");
      await d;
      c.events.on("game.*", () => {});
      await waitFor(() => x.frames.length >= 6);
      await answer(6, '{"topics":["game.*"]}');
    };
    await run();
    c.log.info("connected", { port: 25565 });
    c.log.warn("plain");
    await waitFor(() => x.frames.length >= 8);
    expect(x.frames).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"tools.register","params":{"name":"late.tool","description":"d","parameters":{"type":"object","properties":{},"required":[]},"permission":null}}',
      '{"jsonrpc":"2.0","id":2,"method":"events.publish","params":{"type":"ext.test.ext.hello","data":{"n":1},"turn":"01JC0000000000000000000000","parent":"01JC0000000000000000000001"}}',
      '{"jsonrpc":"2.0","id":3,"method":"storage.get","params":{"key":"k"}}',
      '{"jsonrpc":"2.0","id":4,"method":"storage.set","params":{"key":"k","value":{"n":1}}}',
      '{"jsonrpc":"2.0","id":5,"method":"storage.set","params":{"key":"k","value":null}}',
      '{"jsonrpc":"2.0","id":6,"method":"events.subscribe","params":{"topics":["game.*"]}}',
      '{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"connected","fields":{"port":25565}}}',
      '{"jsonrpc":"2.0","method":"log","params":{"level":"warn","message":"plain"}}',
    ]);
  });

  it("fails a request with the host's error, drops late responses, times out without cancelling", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: string[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) frames.push(JSON.stringify(m));
    });
    const peer = new RpcPeer({ input, output, timeoutMs: 40 });
    const failed = peer.request("a");
    input.write(
      frame('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"denied","data":{"why":1}}}'),
    );
    await expect(failed).rejects.toMatchObject({ code: -32001, message: "denied", data: { why: 1 } });
    const timedOut = await peer.request("slow", { n: 1 }).catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(RpcError);
    expect(timedOut).toMatchObject({ code: ErrorCode.Timeout, message: '"slow" timed out after 40 ms' });
    // A late answer is ignored, and no `$/cancelRequest` was written for the timeout.
    input.write(frame('{"jsonrpc":"2.0","id":2,"result":1}'));
    await sleep(10);
    expect(frames).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"a","params":null}',
      '{"jsonrpc":"2.0","id":2,"method":"slow","params":{"n":1}}',
    ]);
    expect(peer.closed).toBe(false);
    peer.notify("bare");
    await sleep(5);
    expect(frames.at(-1)).toBe('{"jsonrpc":"2.0","method":"bare","params":null}');
  });

  it("answers a message that is not an object with a null-id error", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: string[] = [];
    const decoder = new FrameDecoder();
    output.on("data", (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) frames.push(JSON.stringify(m));
    });
    new RpcPeer({ input, output });
    input.write(frame("[1]"));
    input.write(frame("5"));
    await sleep(10);
    expect(frames).toEqual([
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"not an object"}}',
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"not an object"}}',
    ]);
  });
});

describe("malformed frames and the size cap", () => {
  const open = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const closed: Array<Error | undefined> = [];
    const peer = new RpcPeer({ input, output, onClose: (e) => closed.push(e) });
    return { input, output, closed, peer };
  };

  it("closes the connection on a bad header, and fails what is pending", async () => {
    for (const bytes of [
      "Content-Type: x\r\n\r\n{}",
      "garbage\r\n\r\n",
      "Content-Length: abc\r\n\r\n",
      `Content-Length: ${MAX_FRAME + 1}\r\n\r\n`,
    ]) {
      const { input, closed, peer } = open();
      const pending = peer.request("x", null, 5000);
      input.write(bytes);
      await expect(pending).rejects.toMatchObject({ code: ErrorCode.Closed });
      expect(closed).toHaveLength(1);
      expect(closed[0]).toBeInstanceOf(FramingError);
      expect(peer.closed).toBe(true);
    }
  });

  it("closes the connection on a header that never ends", async () => {
    const { input, closed } = open();
    input.write(Buffer.alloc(9000, 0x61));
    await sleep(10);
    expect(closed[0]).toBeInstanceOf(FramingError);
    expect(String(closed[0]?.message)).toBe("header too long");
  });

  it("closes the connection on a body that is not JSON", async () => {
    const { input, closed, peer } = open();
    input.write(frame("{nope"));
    await sleep(10);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeInstanceOf(SyntaxError);
    expect(peer.closed).toBe(true);
  });

  it("closes quietly when the stream ends, even in the middle of a frame", async () => {
    const { input, closed, peer } = open();
    input.write("Content-Length: 50\r\n\r\n{}");
    input.end();
    await sleep(10);
    expect(closed).toEqual([undefined]);
    expect(peer.closed).toBe(true);
  });

  it("accepts a frame of exactly the cap and refuses one byte more", () => {
    expect(MAX_FRAME).toBe(16 * 1024 * 1024);
    const body = `"${"x".repeat(MAX_FRAME - 2)}"`;
    expect(Buffer.byteLength(body)).toBe(MAX_FRAME);
    const decoder = new FrameDecoder();
    const out = decoder.push(Buffer.concat([Buffer.from(`Content-Length: ${MAX_FRAME}\r\n\r\n`), Buffer.from(body)]));
    expect(out).toHaveLength(1);
    expect((out[0] as string).length).toBe(MAX_FRAME - 2);
    expect(() => new FrameDecoder().push(`Content-Length: ${MAX_FRAME + 1}\r\n\r\n`)).toThrow(
      /too large/,
    );
  });

  it("counts Content-Length in bytes, reads any header case, keeps a partial frame", () => {
    expect(encodeFrame({ t: "骰" }).toString("utf8")).toBe('Content-Length: 11\r\n\r\n{"t":"骰"}');
    const decoder = new FrameDecoder();
    expect(
      decoder.push('content-type: application/json\r\nCONTENT-LENGTH: 7\r\n\r\n{"x":1}Content-Len'),
    ).toEqual([{ x: 1 }]);
    expect(decoder.pending).toBe(11);
  });
});
