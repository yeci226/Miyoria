import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocketServer, type WebSocket } from "ws";
import { CoreLink } from "../src/link.js";
import { encodePlaybackFrame } from "../src/protocol.js";

let server: WebSocketServer | undefined;
let link: CoreLink | undefined;

afterEach(async () => {
  await link?.stop();
  link = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function startServer(onConn: (ws: WebSocket, hello: Record<string, unknown>) => void) {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => server?.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  server.on("connection", (ws) => {
    ws.once("message", (data: RawData) => onConn(ws, JSON.parse(data.toString()) as Record<string, unknown>));
  });
  return `ws://127.0.0.1:${port}/voice-link`;
}

const once = <T extends unknown[]>(link: CoreLink, ev: "ready" | "fatal" | "down" | "message" | "playbackAudio") =>
  new Promise<T>((resolve) => link.once(ev as never, ((...args: T) => resolve(args)) as never));

describe("CoreLink", () => {
  it("sends hello with the self account, becomes ready on welcome, answers ping", async () => {
    let hello: Record<string, unknown> | undefined;
    const pongs: string[] = [];
    const url = await startServer((ws, h) => {
      hello = h;
      ws.on("message", (d: RawData) => pongs.push(d.toString()));
      ws.send(JSON.stringify({ type: "welcome", session: "S1" }));
      setTimeout(() => ws.send(JSON.stringify({ type: "ping" })), 20);
    });
    link = new CoreLink({ url, token: "secret", selfAccountId: "42" });
    const ready = once<[string]>(link, "ready");
    link.start();
    expect((await ready)[0]).toBe("S1");
    expect(hello).toEqual({
      type: "hello",
      version: 1,
      token: "secret",
      node: "voice-node",
      self_account: { platform: "discord", id: "42" },
      capabilities: ["play_duck", "play_pause"],
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(pongs).toContain('{"type":"pong"}');
    expect(link.send({ type: "error", message: "x" })).toBe(true);
  });

  it("does not send before welcome", async () => {
    const url = await startServer(() => {
      /* never welcomes */
    });
    link = new CoreLink({ url, token: "t", selfAccountId: "1", helloTimeoutMs: 10_000 });
    link.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(link.send({ type: "pong" })).toBe(false);
    expect(link.sendAudio(Buffer.from([1]))).toBe(false);
  });

  it("emits parsed commands and playback audio frames", async () => {
    const url = await startServer((ws) => {
      ws.send(JSON.stringify({ type: "welcome", session: "S" }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "join", guild: "1", channel: "2" }));
        ws.send(JSON.stringify({ type: "bogus" })); // ignored
        ws.send("not json"); // ignored
        ws.send(encodePlaybackFrame(7, Buffer.from([1, 0, 2, 0])));
      }, 20);
    });
    link = new CoreLink({ url, token: "t", selfAccountId: "1" });
    const msg = once<[unknown]>(link, "message");
    const audio = once<[number, Buffer]>(link, "playbackAudio");
    link.start();
    expect((await msg)[0]).toEqual({ type: "join", guild: "1", channel: "2" });
    const [play, pcm] = await audio;
    expect(play).toBe(7);
    expect([...pcm]).toEqual([1, 0, 2, 0]);
  });

  it("stops retrying on close code 4401 (bad token) and reports fatal", async () => {
    let connections = 0;
    const url = await startServer((ws) => {
      connections++;
      ws.close(4401, "bad token");
    });
    link = new CoreLink({ url, token: "nope", selfAccountId: "1", backoffMinMs: 20, backoffMaxMs: 40 });
    const fatal = once<[Error]>(link, "fatal");
    link.start();
    expect((await fatal)[0].message).toBe("bad token");
    await new Promise((r) => setTimeout(r, 200));
    expect(connections).toBe(1);
  });

  it("stops retrying on 4409 (replaced) and 4400 (version)", async () => {
    for (const code of [4409, 4400]) {
      const url = await startServer((ws) => ws.close(code));
      link = new CoreLink({ url, token: "t", selfAccountId: "1", backoffMinMs: 20 });
      const fatal = once<[Error]>(link, "fatal");
      link.start();
      await fatal;
      await link.stop();
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
  });

  it("reconnects with backoff after the server drops the socket, and re-sends hello", async () => {
    let connections = 0;
    const url = await startServer((ws) => {
      connections++;
      ws.send(JSON.stringify({ type: "welcome", session: `S${connections}` }));
      if (connections === 1) setTimeout(() => ws.terminate(), 30);
    });
    link = new CoreLink({ url, token: "t", selfAccountId: "1", backoffMinMs: 20, backoffMaxMs: 50 });
    const sessions: string[] = [];
    link.on("ready", (s) => sessions.push(s));
    const down = once<[{ code: number }]>(link, "down");
    link.start();
    await down;
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (sessions.length >= 2) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - t0 > 3000) {
          clearInterval(poll);
          reject(new Error("did not reconnect"));
        }
      }, 10);
    });
    expect(sessions).toEqual(["S1", "S2"]);
  });

  it("drops audio instead of queueing when the send buffer is over the limit", async () => {
    const url = await startServer((ws) => ws.send(JSON.stringify({ type: "welcome", session: "S" })));
    link = new CoreLink({ url, token: "t", selfAccountId: "1", maxBufferedBytes: 0 });
    const ready = once<[string]>(link, "ready");
    link.start();
    await ready;
    // First frame goes out (buffer empty), a burst piles up and later frames are refused.
    const results: boolean[] = [];
    for (let i = 0; i < 2000; i++) results.push(link.sendAudio(Buffer.alloc(64 * 1024)));
    expect(results.includes(false)).toBe(true);
  });
});
