// The SDK's peer over a real WebSocket pair (`WebSocketTransport`): the SDK has no WebSocket
// package, the cluster has `ws`. Requests both ways, concurrent requests, cancellation, timeouts,
// malformed messages by role, binary frames left alone, the size cap, and the end of the socket.

import type { AddressInfo } from "node:net";
import { EXT_ERROR_CODE } from "@miyoria/contracts/ext";
import {
  type PeerOptions,
  type PeerRole,
  RpcError,
  RpcPeer,
  WebSocketTransport,
} from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

interface Pair {
  server: WebSocket;
  client: WebSocket;
}

let wss: WebSocketServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = null;
});

async function pair(): Promise<Pair> {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const accepted = new Promise<WebSocket>((resolve) => wss?.once("connection", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  const server = await accepted;
  sockets.push(server, client);
  return { server, client };
}

type Handlers = Omit<PeerOptions, "transport" | "output" | "input">;

function peer(ws: WebSocket, handlers: Handlers = {}, role: PeerRole = "host"): RpcPeer {
  return new RpcPeer({
    transport: new WebSocketTransport(ws),
    role,
    timeoutMs: 2_000,
    ...handlers,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("RpcPeer over a WebSocket", () => {
  it("requests and notifications in both directions", async () => {
    const { server, client } = await pair();
    const told: unknown[] = [];
    const core = peer(server, {
      onRequest: (method, params) => ({ core: method, params }),
      onNotification: (method, params) => told.push([method, params]),
    });
    const host = peer(client, { onRequest: (method) => ({ host: method }) });
    expect(await host.request("cluster.guard", { a: 1 })).toEqual({
      core: "cluster.guard",
      params: { a: 1 },
    });
    expect(await core.request("host.info")).toEqual({ host: "host.info" });
    expect(host.notify("host.report", { services: [] })).toBe(true);
    await expect.poll(() => told).toEqual([["host.report", { services: [] }]]);
  });

  it("answers concurrent requests as each finishes", async () => {
    const { server, client } = await pair();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    peer(server, {
      onRequest: async (method) => {
        const gate = deferred();
        gates.set(method, gate);
        await gate.promise;
        return method;
      },
    });
    const host = peer(client);
    const order: string[] = [];
    const slow = host.request("slow").then((v) => order.push(v as string));
    const fast = host.request("fast").then((v) => order.push(v as string));
    await expect.poll(() => gates.size).toBe(2);
    gates.get("fast")?.resolve();
    await fast;
    gates.get("slow")?.resolve();
    await slow;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("cancels the other side's work when the caller gives up", async () => {
    const { server, client } = await pair();
    const cancelled = deferred<unknown>();
    peer(server, {
      onRequest: (_method, _params, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            cancelled.resolve(signal.reason);
            reject(signal.reason);
          });
        }),
    });
    const host = peer(client);
    const controller = new AbortController();
    const asked = host.request("service.logs", { follow: true }, undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("stop following"));
    await expect(asked).rejects.toThrow("stop following");
    expect(await cancelled.promise).toBeInstanceOf(RpcError);
  });

  it("times a request out, and tells the other side", async () => {
    const { server, client } = await pair();
    const cancelled = deferred();
    peer(server, {
      onRequest: (_m, _p, signal) =>
        new Promise(() => signal.addEventListener("abort", () => cancelled.resolve())),
    });
    const host = peer(client);
    await expect(host.request("host.info", null, 50)).rejects.toMatchObject({
      code: EXT_ERROR_CODE.Timeout,
    });
    await cancelled.promise;
  });

  it("answers a message that is not JSON as the host, and ends the link as an extension", async () => {
    const replies: unknown[] = [];
    const a = await pair();
    peer(a.server, {}, "host");
    a.client.on("message", (data) => replies.push(JSON.parse(String(data))));
    a.client.send("{not json");
    await expect
      .poll(() => replies)
      .toMatchObject([{ id: null, error: { code: EXT_ERROR_CODE.ParseError } }]);

    const closed = deferred<Error | undefined>();
    const b = await pair();
    const ext = peer(b.server, { onClose: (error) => closed.resolve(error) }, "extension");
    b.client.send("{not json");
    expect(await closed.promise).toBeInstanceOf(SyntaxError);
    expect(ext.closed).toBe(true);
  });

  it("leaves binary frames to whoever else listens", async () => {
    const { server, client } = await pair();
    const told: string[] = [];
    const binary: number[] = [];
    server.on("message", (data, isBinary) => {
      if (isBinary) binary.push((data as Buffer).length);
    });
    peer(server, { onNotification: (method) => told.push(method) });
    const host = peer(client);
    client.send(Buffer.from([1, 2, 3]));
    host.notify("after");
    await expect.poll(() => told).toEqual(["after"]);
    expect(binary).toEqual([3]);
  });

  it("fails pending requests when the socket closes, and reports the close", async () => {
    const { server, client } = await pair();
    peer(server, { onRequest: () => new Promise(() => undefined) });
    const closed = deferred<Error | undefined>();
    const host = peer(client, { onClose: (error) => closed.resolve(error) });
    const pending = host.request("host.info");
    server.close(1001, "going away");
    await expect(pending).rejects.toMatchObject({ code: EXT_ERROR_CODE.Closed });
    expect(await closed.promise).toBeUndefined();
    expect(host.closed).toBe(true);
    expect(host.notify("late")).toBe(false);
    await expect(host.request("late")).rejects.toMatchObject({ code: EXT_ERROR_CODE.Closed });
  });

  it("drops a notification it may drop when the socket's queue is full", () => {
    let queued = 0;
    const socket = {
      readyState: 1,
      get bufferedAmount() {
        return queued;
      },
      send: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const p = new RpcPeer({ transport: new WebSocketTransport(socket) });
    expect(p.tryNotify("event", {})).toBe(true);
    queued = 64 * 1024 * 1024;
    expect(p.tryNotify("event", {})).toBe(false);
    expect(p.notify("event", {})).toBe(true);
  });

  it("refuses serve, which is for streams", async () => {
    const { server } = await pair();
    const p = peer(server);
    await expect(p.serve(new (await import("node:stream")).PassThrough())).rejects.toThrow(
      /reads from the start/,
    );
  });
});
