// The extension protocol's wire is LSP's. This test holds the project's own JSON-RPC code to
// that: frames it writes are read by `vscode-jsonrpc`'s message reader, and frames
// `vscode-jsonrpc` writes are read by it, for a request, a response, an error, a notification and
// a cancel, in both directions and for both roles of the peer. `vscode-jsonrpc` is a dev
// dependency used here only; nothing ships it.

import { PassThrough } from "node:stream";
import { sleep } from "@miyoria/runtime/kernel";
import { RpcError, RpcPeer } from "@miyoria/sdk";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  CancellationTokenSource,
  createMessageConnection,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { METHOD_NOT_FOUND, Peer } from "../src/index.js";

interface Link {
  /** `vscode-jsonrpc`'s end. */
  theirs: MessageConnection;
  /** Bytes our peer writes (their reader reads them) and reads (their writer writes them). */
  ourOut: PassThrough;
  ourIn: PassThrough;
}

const open: MessageConnection[] = [];

afterEach(() => {
  for (const c of open.splice(0)) c.dispose();
});

function link(): Link {
  const ourOut = new PassThrough();
  const ourIn = new PassThrough();
  const theirs = createMessageConnection(
    new StreamMessageReader(ourOut, "utf-8"),
    new StreamMessageWriter(ourIn, { charset: "utf-8" }),
  );
  theirs.listen();
  open.push(theirs);
  return { theirs, ourOut, ourIn };
}

/** Our peer in `role`, connected to `vscode-jsonrpc`; its handler answers by `method`. */
function ours(
  role: "host" | "extension",
  answer: (method: string, params: unknown, signal: AbortSignal) => unknown,
  notes: Array<[string, unknown]> = [],
) {
  const l = link();
  const peer = new RpcPeer({
    input: l.ourIn,
    output: l.ourOut,
    role,
    timeoutMs: 2000,
    onRequest: async (method, params, signal) => answer(method, params, signal),
    onNotification: (method, params) => {
      notes.push([method, params]);
    },
  });
  return { ...l, peer, notes };
}

describe.each(["host", "extension"] as const)("with vscode-jsonrpc, our peer as %s", (role) => {
  it("we send a request: they read it and their response resolves ours", async () => {
    const { theirs, peer } = ours(role, () => null);
    const seen: unknown[] = [];
    theirs.onRequest("echo", (params: unknown) => {
      seen.push(params);
      return { echoed: params, text: "骰子 🎲" };
    });
    const result = await peer.request("echo", { a: [1, "二"], b: null }, 2000);
    expect(seen).toEqual([{ a: [1, "二"], b: null }]);
    expect(result).toEqual({ echoed: { a: [1, "二"], b: null }, text: "骰子 🎲" });
  });

  it("we send a request: their error response rejects ours with its code, message and data", async () => {
    const { theirs, peer } = ours(role, () => null);
    theirs.onRequest("fail", () => {
      throw new ResponseError(-32003, "taken", { name: "x" });
    });
    await expect(peer.request("fail", {}, 2000)).rejects.toMatchObject({
      code: -32003,
      message: "taken",
      data: { name: "x" },
    });
    // A method they do not have: their MethodNotFound is read as ours.
    await expect(peer.request("missing", {}, 2000)).rejects.toMatchObject({
      code: METHOD_NOT_FOUND,
    });
  });

  it("we send a notification: they read it", async () => {
    const { theirs, peer } = ours(role, () => null);
    const seen: unknown[] = [];
    theirs.onNotification("log", (params: unknown) => {
      seen.push(params);
    });
    peer.notify("log", { level: "info", message: "骰" });
    peer.notify("log", { level: "warn", message: "second" });
    await sleep(50);
    expect(seen).toEqual([
      { level: "info", message: "骰" },
      { level: "warn", message: "second" },
    ]);
  });

  it("we give up on a request: they read $/cancelRequest and cancel the handler (host role)", async () => {
    const { theirs, peer } = ours(role, () => null);
    let token: { isCancellationRequested: boolean } | undefined;
    theirs.onRequest("slow", (_params: unknown, t: { isCancellationRequested: boolean }) => {
      token = t;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const aborted = peer.request("slow", {}, 5000, controller.signal);
    await sleep(30);
    controller.abort(new Error("turn cancelled"));
    await expect(aborted).rejects.toThrow("turn cancelled");
    await sleep(30);
    // Only the host cancels what it gave up on (docs/protocols/extension-rpc.md).
    expect(token?.isCancellationRequested).toBe(role === "host");
  });

  it("they send a request: our handler answers, and an RpcError reaches them whole", async () => {
    const { theirs } = ours(role, (method, params) => {
      if (method === "echo") return { got: params };
      throw new RpcError(-32001, "denied", { why: "x" });
    });
    await expect(theirs.sendRequest("echo", { n: 1, s: "骰" })).resolves.toEqual({
      got: { n: 1, s: "骰" },
    });
    const failed = await theirs.sendRequest("nope", {}).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ResponseError);
    expect(failed).toMatchObject({ code: -32001, message: "denied", data: { why: "x" } });
    // Whatever else a handler throws is an internal error with its message.
    const other = ours(role, () => {
      throw new Error("boom");
    });
    await expect(other.theirs.sendRequest("x", {})).rejects.toMatchObject({
      code: -32603,
      message: "boom",
    });
  });

  it("they send a notification: our handler reads it", async () => {
    const notes: Array<[string, unknown]> = [];
    const { theirs } = ours(role, () => null, notes);
    await theirs.sendNotification("event", { topic: "a.b", payload: [1, 2] });
    await theirs.sendNotification("shutdown");
    await sleep(50);
    expect(notes).toEqual([
      ["event", { topic: "a.b", payload: [1, 2] }],
      ["shutdown", null],
    ]);
  });

  it("they cancel a request: our handler's signal aborts", async () => {
    let signal: AbortSignal | undefined;
    const { theirs } = ours(role, (_method, _params, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const source = new CancellationTokenSource();
    // Their request is left unanswered by us; vscode-jsonrpc answers a cancelled request itself
    // only for requests it serves, so we just look at what reached our handler.
    void theirs.sendRequest("work", { n: 1 }, source.token).catch(() => undefined);
    await sleep(30);
    expect(signal?.aborted).toBe(false);
    source.cancel();
    await sleep(30);
    expect(signal?.aborted).toBe(true);
  });

  it("reads many frames written back to back, split at any byte", async () => {
    const out = new PassThrough();
    const theirs = createMessageConnection(
      new StreamMessageReader(out, "utf-8"),
      new StreamMessageWriter(new PassThrough(), { charset: "utf-8" }),
    );
    open.push(theirs);
    const seen: unknown[] = [];
    theirs.onNotification("n", (p: unknown) => {
      seen.push(p);
    });
    theirs.listen();
    const wire = new PassThrough();
    const chunks: Buffer[] = [];
    wire.on("data", (c: Buffer) => chunks.push(c));
    const peer = new RpcPeer({ output: wire, role });
    for (let i = 0; i < 5; i++) peer.notify("n", { i, t: "骰".repeat(i) });
    await sleep(10);
    const bytes = Buffer.concat(chunks);
    for (let i = 0; i < bytes.length; i += 7) out.write(bytes.subarray(i, i + 7));
    await sleep(50);
    expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => ({ i, t: "骰".repeat(i) })));
  });
});

describe("with vscode-jsonrpc, the host's Peer", () => {
  it("serves their requests and sends ours through the host's own adapter", async () => {
    const ourOut = new PassThrough();
    const ourIn = new PassThrough();
    const theirs = createMessageConnection(
      new StreamMessageReader(ourOut, "utf-8"),
      new StreamMessageWriter(ourIn, { charset: "utf-8" }),
    );
    theirs.listen();
    open.push(theirs);
    theirs.onRequest("tools.register", (p: unknown) => ({ name: (p as { name: string }).name }));
    const peer = new Peer(ourOut);
    const served = peer.serve(ourIn, {
      request: async (method, params): Promise<JsonValue> => ({ method, params }),
      notification: () => {},
    });
    served.catch(() => undefined);
    await expect(theirs.sendRequest("initialize", { protocol: 1 })).resolves.toEqual({
      method: "initialize",
      params: { protocol: 1 },
    });
    await expect(peer.request("tools.register", { name: "a.b" }, 2000)).resolves.toEqual({
      name: "a.b",
    });
  });
});
