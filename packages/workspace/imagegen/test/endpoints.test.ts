// ComfyUI through the endpoint registry: the endpoint's headers reach the server, no endpoint is
// an `unreachable` error, a job keeps to the server it was pinned to, a server that gives no
// answer is reported, and the progress socket is opened only for a direct endpoint.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ComfyClient, ComfyError } from "../src/comfy.js";
import { comfyAt, FakeEndpoints } from "./endpoints.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A ComfyUI that answers `/system_stats` and `/history/<id>` (a finished run). */
async function comfy(name: string, seen: IncomingHttpHeaders[] = []): Promise<string> {
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/system_stats") {
      res.end(JSON.stringify({ system: { comfyui_version: name }, devices: [] }));
    } else if (req.url?.startsWith("/history/")) {
      const id = req.url.slice("/history/".length);
      res.end(
        JSON.stringify({
          [id]: { outputs: {}, status: { status_str: "success", completed: true, messages: [] } },
        }),
      );
    } else res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("ComfyClient and the endpoint registry", () => {
  it("sends the endpoint's headers (a proxy's token)", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const url = await comfy("0.3", seen);
    const client = new ComfyClient({
      endpoints: comfyAt(url, { authorization: "Bearer proxy" }),
      webSocket: null,
    });
    expect((await client.stats()).version).toBe("0.3");
    expect(seen[0]?.authorization).toBe("Bearer proxy");
    expect(client.url).toBe(url);
  });

  it("no endpoint: an unreachable error, so the job waits and is retried", async () => {
    const client = new ComfyClient({ endpoints: new FakeEndpoints(), webSocket: null });
    const error = await client.stats().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComfyError);
    expect((error as ComfyError).kind).toBe("unreachable");
    expect((error as ComfyError).message).toBe("no ComfyUI is known to the endpoint registry");
    expect(() => client.pin()).toThrow(ComfyError);
    expect(client.url).toBeNull();
    expect(new ComfyClient({ endpoints: null }).url).toBeNull();
  });

  it("a pinned client keeps to its server when the registry changes", async () => {
    const a = await comfy("a");
    const b = await comfy("b");
    const endpoints = new FakeEndpoints([{ name: "pc", url: a }]);
    const client = new ComfyClient({ endpoints, webSocket: null });
    const job = client.pin();
    endpoints.entries = [{ name: "other", url: b }];
    expect((await job.stats()).version).toBe("a");
    expect((await client.stats()).version).toBe("b");
  });

  it("reports a server that gives no answer", async () => {
    const endpoints = comfyAt("http://127.0.0.1:9");
    const client = new ComfyClient({ endpoints, webSocket: null, timeoutMs: 2_000 });
    await expect(client.stats()).rejects.toThrow(/ComfyUI is unreachable/);
    expect(endpoints.failures.map((e) => e.host)).toEqual(["imagegen"]);
  });

  it("opens the progress socket only for a direct endpoint, with its headers", async () => {
    const url = await comfy("a");
    const opened: unknown[][] = [];
    class FakeWs {
      constructor(...args: unknown[]) {
        opened.push(args);
      }
      addEventListener(): void {}
      close(): void {}
    }
    const signal = new AbortController().signal;
    const direct = new ComfyClient({
      endpoints: comfyAt(url, { authorization: "Bearer p" }),
      webSocket: FakeWs as unknown as typeof WebSocket,
    });
    await direct.follow("p1", "c1", { signal, onProgress: () => undefined, pollMs: 10 });
    expect(opened).toEqual([
      [`${url.replace("http", "ws")}/ws?clientId=c1`, { headers: { authorization: "Bearer p" } }],
    ]);

    // Over a control link there is no socket; the run is still followed through `request`.
    const linked = new FakeEndpoints([{ name: "far", url: "link://far/comfyui", via: "link" }]);
    linked.request = (_endpoint, path, init) => fetch(`${url}${path}`, init);
    const relayed = new ComfyClient({
      endpoints: linked,
      webSocket: FakeWs as unknown as typeof WebSocket,
    });
    const run = await relayed.follow("p2", "c2", { signal, onProgress: () => undefined });
    expect(run.status).toBe("success");
    expect(opened).toHaveLength(1);
  });
});
