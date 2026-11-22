// Several routes per host (docs/design/v5-hostd.md §16), with a fake fetch, a fake relay and a fake
// clock: what a host without routes still gets (exactly the old behaviour), Core's own checks of
// the routes (TLS), which route fits which work, failover and resting, probing, and downloads that
// travel in ranges over a tunnel and resume over the next route.

import type { HostReport, HostRoute, HostServiceStatus } from "@miyoria/contracts/host";
import { describe, expect, it } from "vitest";
import {
  EndpointRegistry,
  type LinkRelay,
  RouteProber,
  TransferChangedError,
} from "../src/index.js";
import { report, service } from "./helpers.js";

const MB = 1024 * 1024;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers by host name; anything else is a refused connection. */
function fakeFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, method: init.method ?? "GET", headers: new Headers(init.headers) });
    const handler = handlers[url.host];
    if (handler === undefined) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

/** A relay that answers like `handler`, with the calls it got. */
function fakeRelay(handler: Handler) {
  const calls: Array<{ path: string; headers: Headers }> = [];
  const relay: LinkRelay = {
    request: async (endpoint, path, init = {}) => {
      calls.push({ path, headers: new Headers(init.headers) });
      return handler(new URL(`http://relay.invalid/${endpoint.service}${path}`), init);
    },
  };
  return { relay, calls };
}

const gatewayHeaders = { "x-miyoria-route": "gateway" };

const ROUTES: HostRoute[] = [
  { name: "tailnet", kind: "tailnet", url: "friend.ts.net" },
  { name: "direct", kind: "direct", url: "https://friend.example.net:7890" },
  {
    name: "tunnel",
    kind: "tunnel",
    url: "https://friend-tunnel.example.com",
    max_body_bytes: 100 * MB,
  },
  { name: "relay", kind: "relay", implicit: true },
];

function sing(fields: Partial<HostServiceStatus> = {}): HostServiceStatus {
  return service({
    name: "sing",
    port: 8005,
    token: "svc-token",
    advertised: undefined,
    reach: {
      tailnet: "http://friend.ts.net:8005",
      direct: "https://friend.example.net:7890/svc/sing",
      tunnel: "https://friend-tunnel.example.com/svc/sing",
    },
    ...fields,
  });
}

function routed(services: HostServiceStatus[], routes = ROUTES): HostReport {
  return { ...report(services, "friend"), routes, route_token: "route-token" };
}

function setup(options: ConstructorParameters<typeof EndpointRegistry>[0] = {}) {
  const clock = { t: 1_000_000 };
  const reg = new EndpointRegistry({ clock: { now: () => clock.t }, ...options });
  return { reg, clock };
}

describe("a host without routes.toml", () => {
  it("is routed exactly as before: its advertised address, one try, no fallback", async () => {
    const { fn, calls } = fakeFetch({});
    const { relay, calls: relayed } = fakeRelay(() => new Response("relayed"));
    const { reg } = setup({ fetch: fn });
    reg.setRelay(relay);
    reg.setHost("pc", ["sing"]);
    reg.report("pc", report([service({ name: "sing", url: "http://pc:8005", token: "t" })]));
    const [endpoint] = reg.candidates("sing");
    expect(endpoint).toEqual({
      capability: "sing",
      host: "pc",
      service: "sing",
      url: "http://pc:8005",
      via: "direct",
      headers: { authorization: "Bearer t" },
      healthy: true,
      version: null,
    });
    await expect(reg.request(endpoint as never, "/songs")).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
    expect(relayed).toHaveLength(0);
    expect(reg.routes.due()).toEqual([]);
  });

  it("without an address goes through the relay as before", async () => {
    const { relay, calls } = fakeRelay(() => new Response("ok"));
    const { reg } = setup();
    reg.setRelay(relay);
    reg.setHost("pc", ["sing"]);
    reg.report("pc", report([service({ name: "sing", port: 8005 })]));
    const endpoint = reg.pick("sing");
    expect(endpoint?.via).toBe("link");
    expect(await (await reg.request(endpoint as never, "/songs")).text()).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("shows what it has on the machines page", () => {
    const { reg } = setup();
    reg.setHost("pc", ["sing"]);
    reg.report("pc", report([service({ name: "sing", url: "http://pc:8005" })]));
    reg.setLink("pc", { rttMs: 12 });
    const [host] = reg.hostRouting();
    expect(host?.routes.map((r) => [r.name, r.kind, r.in_use])).toEqual([
      ["advertised", "tailnet", ["realtime", "interactive", "bulk"]],
      ["relay", "relay", []],
    ]);
    expect(host?.routes[1]?.rtt_ms).toBe(12);
  });
});

describe("Core's own checks", () => {
  it("never uses a direct or tunnel route over plain HTTP, except to this machine", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report(
      "friend",
      routed(
        [
          sing({
            reach: {
              direct: "http://friend.example.net:7890/svc/sing",
              local: "http://127.0.0.1:7890/svc/sing",
            },
          }),
        ],
        [
          { name: "direct", kind: "direct", url: "http://friend.example.net:7890" },
          { name: "local", kind: "tunnel", url: "http://127.0.0.1:7890" },
          { name: "relay", kind: "relay" },
        ],
      ),
    );
    const view = reg.hostRouting()[0]?.routes ?? [];
    expect(view.find((r) => r.name === "direct")).toMatchObject({ state: "invalid" });
    expect(view.find((r) => r.name === "direct")?.reason).toContain("https");
    expect(view.find((r) => r.name === "local")?.state).toBe("unknown");
    const plan = reg.routes.plan("friend", "sing", "interactive").map((c) => c.route.name);
    expect(plan).toEqual(["local", "relay"]);
  });

  it("drops a service address that is not under its route", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report(
      "friend",
      routed([sing({ reach: { direct: "https://elsewhere.example.org/svc/sing" } })]),
    );
    expect(reg.routes.plan("friend", "sing", "interactive").map((c) => c.route.name)).toEqual([
      "relay",
    ]);
  });

  it("shows no token on the machines page", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()]));
    const text = JSON.stringify(reg.hostRouting());
    expect(text).not.toContain("route-token");
    expect(text).not.toContain("svc-token");
  });
});

describe("which route fits the work", () => {
  it("real-time work takes tailnet or direct only, and a direct query keeps to them", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()]));
    expect(reg.routes.plan("friend", "sing", "realtime").map((c) => c.route.name)).toEqual([
      "tailnet",
      "direct",
    ]);
    const [direct] = reg.candidates("sing", { direct: true });
    expect(direct).toMatchObject({ url: "http://friend.ts.net:8005", direct_only: true });
    expect(reg.candidates("sing")[0]?.direct_only).toBeUndefined();
  });

  it("a host with only a tunnel and the relay is not offered for real-time work", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report(
      "friend",
      routed(
        [sing({ reach: { tunnel: "https://friend-tunnel.example.com/svc/sing" } })],
        [ROUTES[2] as HostRoute, ROUTES[3] as HostRoute],
      ),
    );
    expect(reg.candidates("sing", { direct: true })).toEqual([]);
    expect(reg.pick("sing")).toMatchObject({
      url: "https://friend-tunnel.example.com/svc/sing",
      via: "direct",
    });
  });

  it("latency first for answers, throughput first for files, the relay last", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()]));
    reg.routes.ok("friend", "tailnet", 90);
    reg.routes.ok("friend", "direct", 30);
    reg.routes.ok("friend", "tunnel", 120);
    reg.routes.sample("friend", "tailnet", 2 * MB, 1000);
    reg.routes.sample("friend", "direct", 10 * MB, 1000);
    reg.routes.sample("friend", "tunnel", 40 * MB, 1000);
    reg.setLink("friend", { rttMs: 5 });
    expect(reg.routes.plan("friend", "sing", "interactive").map((c) => c.route.name)).toEqual([
      "direct",
      "tailnet",
      "tunnel",
      "relay",
    ]);
    expect(reg.routes.plan("friend", "sing", "bulk").map((c) => c.route.name)).toEqual([
      "tunnel",
      "direct",
      "relay",
      "tailnet",
    ]);
  });

  it("an upload over a route's body limit does not take that route", () => {
    const { reg } = setup();
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()], [ROUTES[2] as HostRoute, ROUTES[3] as HostRoute]));
    expect(
      reg.routes.plan("friend", "sing", "bulk", { bytes: 150 * MB }).map((c) => c.route.name),
    ).toEqual(["relay"]);
    // A stream of unknown length neither.
    expect(
      reg.routes.plan("friend", "sing", "bulk", { bytes: null }).map((c) => c.route.name),
    ).toEqual(["relay"]);
  });
});

describe("failover", () => {
  function friend(handlers: Record<string, Handler>, relayHandler?: Handler) {
    const { fn, calls } = fakeFetch(handlers);
    const relay = fakeRelay(relayHandler ?? (() => new Response("relayed")));
    const { reg, clock } = setup({
      fetch: fn,
      routes: {
        probe_secs: 300,
        sample_secs: 0,
        sample_kib: 256,
        timeout_ms: 5000,
        rest_secs: [30, 120],
        chunk_mb: 64,
      },
    });
    reg.setRelay(relay.relay);
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()]));
    return { reg, clock, calls, relayed: relay.calls };
  }

  it("a GET goes on to the next route and the failed one rests", async () => {
    const { reg, clock, calls } = friend({
      "friend.example.net:7890": () => new Response("from direct", { headers: gatewayHeaders }),
    });
    const endpoint = reg.pick("sing");
    const res = await reg.request(endpoint as never, "/songs");
    expect(await res.text()).toBe("from direct");
    expect(calls.map((c) => c.url)).toEqual([
      "http://friend.ts.net:8005/songs",
      "https://friend.example.net:7890/svc/sing/songs",
    ]);
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer svc-token");
    const tailnet = reg.hostRouting()[0]?.routes.find((r) => r.name === "tailnet");
    expect(tailnet).toMatchObject({ state: "resting" });
    // Resting: the next request goes straight to the route that worked.
    await reg.request(endpoint as never, "/songs");
    expect(calls.at(-1)?.url).toBe("https://friend.example.net:7890/svc/sing/songs");
    // Its rest is over: it may be tried again, but after the route that works.
    clock.t += 31_000;
    expect(reg.routes.plan("friend", "sing", "interactive")[0]?.route.name).toBe("direct");
  });

  it("a POST that may have arrived is not sent again", async () => {
    const { reg, calls, relayed } = friend({
      "friend.ts.net:8005": () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        });
      },
    });
    const endpoint = reg.pick("sing");
    await expect(
      reg.request(endpoint as never, "/jobs", { method: "POST", body: "{}" }),
    ).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
    expect(relayed).toHaveLength(0);
  });

  it("a POST that never left goes on to the next route", async () => {
    const { reg, calls } = friend({
      "friend.example.net:7890": () => new Response("taken", { headers: gatewayHeaders }),
    });
    const endpoint = reg.pick("sing");
    const res = await reg.request(endpoint as never, "/jobs", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("taken");
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("a stream body gets one try", async () => {
    const { reg, calls } = friend({
      "friend.example.net:7890": () => new Response("taken", { headers: gatewayHeaders }),
    });
    const endpoint = reg.pick("sing");
    const body = new ReadableStream({
      start: (c) => {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    await expect(
      reg.request(endpoint as never, "/karaoke/voice", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    ).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
  });

  it("a tunnel's edge answering for a gateway that is down is a failed route", async () => {
    const { fn, calls } = fakeFetch({
      "friend-tunnel.example.com": () => new Response("error 1033", { status: 530 }),
    });
    const relay = fakeRelay(() => new Response("relayed"));
    const { reg } = setup({ fetch: fn });
    reg.setRelay(relay.relay);
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()], [ROUTES[2] as HostRoute, ROUTES[3] as HostRoute]));
    const res = await reg.request(reg.pick("sing") as never, "/jobs", {
      method: "POST",
      body: "{}",
    });
    expect(await res.text()).toBe("relayed");
    expect(calls).toHaveLength(1);
    expect(reg.hostRouting()[0]?.routes[0]).toMatchObject({ name: "tunnel", state: "resting" });
  });

  it("a gateway's own 503 is the service's answer, not a route failure", async () => {
    const { reg, calls } = friend({
      "friend.ts.net:8005": () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      "friend.example.net:7890": () => new Response("{}", { status: 503, headers: gatewayHeaders }),
    });
    const res = await reg.request(reg.pick("sing") as never, "/songs");
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(reg.hostRouting()[0]?.routes.find((r) => r.name === "direct")?.state).toBe("up");
  });

  it("real-time work never falls back to a tunnel or the relay", async () => {
    const { reg, relayed } = friend({});
    const [endpoint] = reg.candidates("sing", { direct: true });
    await expect(reg.request(endpoint as never, "/health")).rejects.toThrow("fetch failed");
    expect(relayed).toHaveLength(0);
  });
});

describe("probing", () => {
  it("pings each route, samples gateway routes, re-probes a route when its rest is over", async () => {
    let t = 1_000_000;
    const clock = { now: () => t };
    const { fn, calls } = fakeFetch({
      "friend.ts.net:8005": () => {
        t += 20;
        return new Response('{"status":"ok"}');
      },
      "friend.example.net:7890": (url) => {
        t += 50;
        const bytes = Number(url.searchParams.get("bytes") ?? 0);
        if (bytes > 0) {
          const body = new Uint8Array(bytes);
          return new Response(body, { headers: gatewayHeaders });
        }
        return new Response('{"ok":true}', { headers: gatewayHeaders });
      },
      "friend-tunnel.example.com": () => new Response("bad gateway", { status: 502 }),
    });
    const reg = new EndpointRegistry({
      clock,
      routes: {
        probe_secs: 300,
        sample_secs: 1800,
        sample_kib: 256,
        timeout_ms: 5000,
        rest_secs: [30],
        chunk_mb: 64,
      },
    });
    reg.setHost("friend", ["sing"]);
    reg.report("friend", routed([sing()]));
    const prober = new RouteProber({ table: reg.routes, clock, fetch: fn });
    await prober.tick();
    expect(calls.map((c) => c.url).sort()).toEqual([
      "http://friend.ts.net:8005/health",
      "https://friend-tunnel.example.com/_miyoria/probe",
      "https://friend.example.net:7890/_miyoria/probe",
    ]);
    expect(calls.find((c) => c.url.includes("_miyoria"))?.headers.get("authorization")).toBe(
      "Bearer route-token",
    );
    const view = () => reg.hostRouting()[0]?.routes ?? [];
    expect(view().find((r) => r.name === "tunnel")?.state).toBe("resting");
    expect(view().find((r) => r.name === "tunnel")?.reason).toContain("閘道");
    expect(view().find((r) => r.name === "direct")?.state).toBe("up");
    // Nothing due until the next interval, but the throughput sample of the route that works.
    calls.length = 0;
    await prober.tick();
    expect(calls.map((c) => c.url)).toEqual([
      "https://friend.example.net:7890/_miyoria/probe?bytes=262144",
    ]);
    expect(view().find((r) => r.name === "direct")?.samples).toBe(1);
    calls.length = 0;
    await prober.tick();
    expect(calls).toEqual([]);
    // The tunnel's rest is over: it is probed again at once.
    t += 31_000;
    await prober.tick();
    expect(calls.map((c) => c.url)).toEqual(["https://friend-tunnel.example.com/_miyoria/probe"]);
    // The interval passed: every route again.
    calls.length = 0;
    t += 300_000;
    await prober.tick();
    expect(calls).toHaveLength(3);
  });
});

// ---- downloads in ranges ---------------------------------------------------------------------

const FILE = new Uint8Array(500_000).map((_, i) => (i * 7) & 0xff);

/** Serves FILE with ranges and an ETag; `cut(attempt)` breaks a body after that many bytes. */
function fileServer(options: {
  etag?: () => string;
  cut?: (n: number) => number | null;
  gateway?: boolean;
}) {
  let n = 0;
  const seen: string[] = [];
  const handler: Handler = (_url, init) => {
    n += 1;
    const headers = new Headers(init.headers);
    const range = headers.get("range");
    const etag = options.etag?.() ?? '"v1"';
    const ifRange = headers.get("if-range");
    seen.push(`${range ?? "-"} ${ifRange ?? "-"}`);
    let from = 0;
    let to = FILE.length - 1;
    let status = 200;
    if (range !== null && (ifRange === null || ifRange === etag)) {
      const m = /^bytes=(\d+)-(\d*)$/u.exec(range) as RegExpExecArray;
      from = Number(m[1]);
      to = m[2] === "" ? FILE.length - 1 : Math.min(FILE.length - 1, Number(m[2]));
      status = 206;
    }
    const part = FILE.subarray(from, to + 1);
    const cut = options.cut?.(n) ?? null;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        pulls += 1;
        if (pulls === 1) c.enqueue(part.slice(0, cut ?? part.byteLength));
        else if (cut === null) c.close();
        else c.error(new TypeError("terminated"));
      },
    });
    return new Response(body, {
      status,
      headers: {
        etag,
        "accept-ranges": "bytes",
        "content-length": String(part.byteLength),
        ...(status === 206 ? { "content-range": `bytes ${from}-${to}/${FILE.length}` } : {}),
        ...(options.gateway === false ? {} : gatewayHeaders),
      },
    });
  };
  return { handler, seen };
}

function tunnelHost(tunnel: Handler, relay: Handler) {
  const { fn } = fakeFetch({ "friend-tunnel.example.com": tunnel });
  const r = fakeRelay(relay);
  const { reg } = setup({ fetch: fn });
  reg.setRelay(r.relay);
  reg.setHost("friend", ["sing"]);
  reg.report(
    "friend",
    routed(
      [sing({ reach: { tunnel: "https://friend-tunnel.example.com/svc/sing" } })],
      [{ ...(ROUTES[2] as HostRoute), max_body_bytes: 200_000 }, ROUTES[3] as HostRoute],
    ),
  );
  return { reg, relayed: r.calls };
}

describe("downloads over a route with a body limit", () => {
  it("travel in ranges under the limit and arrive as one body", async () => {
    const server = fileServer({});
    const { reg } = tunnelHost(server.handler, () => new Response("unused"));
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(FILE.length));
    expect(res.headers.get("content-range")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
    expect(server.seen).toEqual([
      "bytes=0-134463 -",
      'bytes=134464-268927 "v1"',
      'bytes=268928-403391 "v1"',
      'bytes=403392-499999 "v1"',
    ]);
  });

  it("resume a caller's range", async () => {
    const server = fileServer({});
    const { reg } = tunnelHost(server.handler, () => new Response("unused"));
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4", {
      headers: { range: "bytes=300000-", "if-range": '"v1"' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 300000-499999/${FILE.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE.subarray(300_000));
  });

  it("go on over the next route from the byte where a part broke", async () => {
    const tunnel = fileServer({ cut: (n) => (n === 2 ? 10_000 : null) });
    const relay = fileServer({ gateway: false });
    const { reg, relayed } = tunnelHost(tunnel.handler, relay.handler);
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
    // The second part broke after 10,000 bytes: the rest of it came over the relay.
    expect(relayed[0]?.headers.get("range")).toBe(`bytes=${134_464 + 10_000}-`);
    expect(relayed[0]?.headers.get("if-range")).toBe('"v1"');
    expect(reg.hostRouting()[0]?.routes[0]?.state).toBe("resting");
  });

  it("fail when the file changed in between", async () => {
    let version = 1;
    const server = fileServer({
      etag: () => `"v${version}"`,
      cut: (n) => {
        if (n === 2) version = 2;
        return null;
      },
    });
    const { reg } = tunnelHost(server.handler, () => new Response("unused"));
    const res = await reg.request(reg.pick("sing") as never, "/songs/a/files/video.mp4");
    await expect(res.arrayBuffer()).rejects.toBeInstanceOf(TransferChangedError);
  });

  it("an answer that cannot be resumed is passed on as it came", async () => {
    const { reg } = tunnelHost(
      () => new Response('{"songs":[]}', { headers: gatewayHeaders }),
      () => new Response("unused"),
    );
    const res = await reg.request(reg.pick("sing") as never, "/songs");
    expect(await res.json()).toEqual({ songs: [] });
  });
});
