// A route through hostd's real gateway on loopback (v5-hostd §16): Core's registry, the gateway of
// `@miyoria/hostd` and a file service that answers ranges, over real sockets. A tunnel route with
// a small body limit brings a file in ranges under it; a cut connection is resumed over the next
// route; every request the service saw carries its own token, never Core's.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostReport } from "@miyoria/contracts/host";
import { createGateway } from "@miyoria/hostd";
import { afterEach, describe, expect, it } from "vitest";
import { EndpointRegistry } from "../src/index.js";
import { report, service } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

const FILE = Buffer.alloc(300_000);
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 13) & 0xff;

/** The song worker's file route: ranges with an ETag. `cutOnce` cuts the first answer short. */
async function fileService(options: { cutOnce?: number } = {}) {
  const seen: Array<{ range: string | null; auth: string | null }> = [];
  let cut = options.cutOnce ?? null;
  const server = createServer((req, res) => {
    seen.push({
      range: (req.headers.range as string | undefined) ?? null,
      auth: req.headers.authorization ?? null,
    });
    const m = /^bytes=(\d+)-(\d*)$/u.exec(String(req.headers.range ?? ""));
    const from = m === null ? 0 : Number(m[1]);
    const to = m === null || m[2] === "" ? FILE.length - 1 : Number(m[2]);
    const part = FILE.subarray(from, to + 1);
    res.writeHead(m === null ? 200 : 206, {
      etag: '"v1"',
      "accept-ranges": "bytes",
      "content-length": part.length,
      ...(m === null ? {} : { "content-range": `bytes ${from}-${to}/${FILE.length}` }),
    });
    if (cut !== null) {
      const n = cut;
      cut = null;
      res.write(part.subarray(0, n), () => res.destroy());
      return;
    }
    res.end(part);
  });
  return { port: await listen(server), seen };
}

async function gatewayFor(servicePort: number) {
  const server = createGateway({
    tls: null,
    host: {
      target: (name) =>
        name === "sing"
          ? { url: `http://127.0.0.1:${servicePort}`, headers: { authorization: "Bearer inside" } }
          : null,
      tokenOf: (name) => (name === "sing" ? "sing-token" : undefined),
      routeToken: () => "route-token",
    },
  });
  return listen(server);
}

function hostReport(gatewayPort: number, extra: Partial<HostReport> = {}): HostReport {
  const url = `http://127.0.0.1:${gatewayPort}`;
  return {
    ...report([
      service({
        name: "sing",
        port: 8005,
        token: "sing-token",
        advertised: undefined,
        reach: { tunnel: `${url}/svc/sing`, second: `${url}/svc/sing` },
      }),
    ]),
    routes: [
      { name: "tunnel", kind: "tunnel", url, max_body_bytes: 196_608 },
      { name: "second", kind: "direct", url },
      { name: "relay", kind: "relay", implicit: true },
    ],
    route_token: "route-token",
    ...extra,
  };
}

describe("through the real gateway", () => {
  it("brings a file in ranges under the tunnel's limit", async () => {
    const svc = await fileService();
    const gw = await gatewayFor(svc.port);
    const reg = new EndpointRegistry();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", hostReport(gw));
    reg.routes.ok("friend", "tunnel", 1);
    reg.routes.ok("friend", "second", 50);
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4");
    expect(Buffer.from(await res.arrayBuffer()).equals(FILE)).toBe(true);
    expect(svc.seen.map((s) => s.range)).toEqual([
      "bytes=0-131071",
      "bytes=131072-262143",
      "bytes=262144-299999",
    ]);
    // The service sees its own authorization, which the gateway adds.
    expect(new Set(svc.seen.map((s) => s.auth))).toEqual(new Set(["Bearer inside"]));
  });

  it("resumes a cut connection over the next route", async () => {
    const svc = await fileService({ cutOnce: 10_000 });
    const gw = await gatewayFor(svc.port);
    const reg = new EndpointRegistry();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", hostReport(gw, {}));
    reg.routes.ok("friend", "second", 1);
    reg.routes.ok("friend", "tunnel", 50);
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4");
    expect(Buffer.from(await res.arrayBuffer()).equals(FILE)).toBe(true);
    expect(svc.seen[0]?.range).toBeNull();
    expect(svc.seen[1]?.range).toBe("bytes=10000-141071");
    expect(reg.hostRouting()[0]?.routes.find((r) => r.name === "second")?.state).toBe("resting");
  });
});
