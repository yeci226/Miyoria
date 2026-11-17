// The registry of endpoints, fed directly: approval, order, static entries, resting, `direct`,
// watching, and requests to a direct endpoint and a link one.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EndpointRegistry, RelayUnavailableError } from "../src/index.js";
import { report, service } from "./helpers.js";

function registry(options: ConstructorParameters<typeof EndpointRegistry>[0] = {}) {
  const clock = { t: 1_000_000 };
  const reg = new EndpointRegistry({ clock: { now: () => clock.t }, ...options });
  return { reg, clock };
}

describe("what is returned", () => {
  it("only capabilities a host is approved for, from serving services", () => {
    const { reg } = registry();
    reg.setHost("pc", ["asr", "turn"]);
    reg.report(
      "pc",
      report([
        service({ name: "asr", url: "http://pc:8003", token: "secret", version: "1.2" }),
        service({ name: "tts", url: "http://pc:8002" }),
        service({ name: "turn", provides: ["turn", "vad"], url: "http://pc:8006" }),
        service({ name: "asr2", provides: ["asr"], url: "http://pc:9", state: "failed" }),
      ]),
    );
    expect(reg.candidates("asr")).toEqual([
      {
        capability: "asr",
        host: "pc",
        service: "asr",
        url: "http://pc:8003",
        via: "direct",
        headers: { authorization: "Bearer secret" },
        healthy: true,
        version: "1.2",
      },
    ]);
    expect(reg.pick("tts")).toBeNull();
    expect(reg.pick("turn")?.service).toBe("turn");
    expect(reg.pick("vad")).toBeNull();
  });

  it("lists the capabilities that have an endpoint now", () => {
    const { reg } = registry({ static: { f: { provides: ["sing"], url: "http://f:1" } } });
    reg.setHost("pc", ["asr", "tts"]);
    reg.report(
      "pc",
      report([
        service({ name: "asr", url: "http://pc:1" }),
        service({ name: "tts", url: "http://pc:2", state: "failed" }),
        service({ name: "turn", url: "http://pc:3" }),
      ]),
    );
    expect(reg.capabilities()).toEqual(["asr", "sing"]);
  });

  it("nothing of a pending host, and nothing of a host that is gone", () => {
    const { reg } = registry();
    reg.setHost("pc", null);
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1" })]));
    expect(reg.pick("asr")).toBeNull();
    reg.setHost("pc", ["asr"]);
    expect(reg.pick("asr")?.host).toBe("pc");
    reg.removeHost("pc");
    expect(reg.pick("asr")).toBeNull();
    // A report from a host that is not connected is not kept.
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1" })]));
    reg.setHost("pc", ["asr"]);
    expect(reg.pick("asr")).toBeNull();
  });

  it("a service without a URL is reachable only through the link", () => {
    const { reg } = registry();
    reg.setHost("far", ["sing"]);
    reg.report("far", report([service({ name: "sing" })]));
    expect(reg.pick("sing")).toMatchObject({ via: "link", url: "link://far/sing" });
    expect(reg.pick("sing", { direct: true })).toBeNull();
    expect(reg.candidates("sing", { direct: true })).toEqual([]);
  });

  it("an address on the host itself is not one Core can call", () => {
    // A joined machine that advertises nothing still says where its service listens
    // (`http://127.0.0.1:...`): calling that from Core would hit Core's own machine.
    const { reg } = registry();
    reg.setHost("far", ["sing"]);
    reg.report(
      "far",
      report([service({ name: "sing", url: "http://127.0.0.1:8005", advertised: undefined })]),
    );
    expect(reg.pick("sing")).toMatchObject({ via: "link", url: "link://far/sing" });
    expect(reg.pick("sing", { direct: true })).toBeNull();
  });

  it("static entries, always direct, with their token as a header", () => {
    const { reg } = registry({
      static: {
        "friend-sing": { provides: ["sing", "lyrics"], url: "http://100.1.2.3:8005", token: "t" },
        plain: { provides: ["sing"], url: "http://10.0.0.2:8005" },
      },
    });
    expect(reg.candidates("sing")).toMatchObject([
      { host: "friend-sing", service: "friend-sing", via: "direct", healthy: true },
      { host: "plain", headers: {} },
    ]);
    expect(reg.pick("lyrics")?.headers).toEqual({ authorization: "Bearer t" });
  });
});

describe("order", () => {
  it("the order list first, then the rest by name, healthy and rested before the others", () => {
    const { reg, clock } = registry({
      order: { sing: ["friend", "main"] },
      static: { friend: { provides: ["sing"], url: "http://friend:8005" } },
      retrySecs: 30,
    });
    for (const name of ["main", "b-pc", "a-pc"]) {
      reg.setHost(name, ["sing"]);
      reg.report(name, report([service({ name: "sing", url: `http://${name}:8005` })]));
    }
    const hosts = () => reg.candidates("sing").map((e) => e.host);
    expect(hosts()).toEqual(["friend", "main", "a-pc", "b-pc"]);

    reg.report(
      "main",
      report([service({ name: "sing", url: "http://main:8005", healthy: false })]),
    );
    expect(hosts()).toEqual(["friend", "a-pc", "b-pc", "main"]);
    expect(reg.pick("sing")?.host).toBe("friend");

    // A failed endpoint rests for `retry_secs`, then comes back in its place.
    const friend = reg.pick("sing");
    if (friend === null) throw new Error("no endpoint");
    reg.failed(friend, new Error("refused"));
    expect(reg.pick("sing")?.host).toBe("a-pc");
    expect(hosts()).toEqual(["a-pc", "b-pc", "friend", "main"]);
    clock.t += 29_000;
    expect(reg.pick("sing")?.host).toBe("a-pc");
    clock.t += 1_000;
    expect(reg.pick("sing")?.host).toBe("friend");
  });
});

describe("watch", () => {
  it("fires when the endpoints of the capability change, and stops after dispose", () => {
    const { reg } = registry();
    let asr = 0;
    let tts = 0;
    const stop = reg.watch("asr", () => asr++);
    reg.watch("tts", () => tts++);
    reg.setHost("pc", ["asr"]);
    expect(asr).toBe(0); // nothing reported yet: no change
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1" })]));
    expect(asr).toBe(1);
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1" })]));
    expect(asr).toBe(1); // the same report
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1", healthy: false })]));
    expect(asr).toBe(2);
    reg.removeHost("pc");
    expect(asr).toBe(3);
    expect(tts).toBe(0);
    stop();
    reg.setHost("pc", ["asr"]);
    reg.report("pc", report([service({ name: "asr", url: "http://pc:1" })]));
    expect(asr).toBe(3);
  });
});

describe("request", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function echo(): Promise<string> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, body }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("calls a direct endpoint with its headers under the caller's", async () => {
    const url = await echo();
    const { reg } = registry({
      static: { w: { provides: ["tts"], url: `${url}/`, token: "service-token" } },
    });
    const endpoint = reg.pick("tts");
    if (endpoint === null) throw new Error("no endpoint");
    const plain = await reg.request(endpoint, "/health");
    const seen = (await plain.json()) as { path: string; headers: IncomingHttpHeaders };
    expect(seen.path).toBe("/health");
    expect(seen.headers.authorization).toBe("Bearer service-token");

    const own = await reg.request(endpoint, "synth", {
      method: "POST",
      headers: { "x-extra": "1", Authorization: "Bearer caller" },
      body: "hello",
    });
    const got = (await own.json()) as {
      path: string;
      method: string;
      body: string;
      headers: IncomingHttpHeaders;
    };
    expect(got).toMatchObject({ path: "/synth", method: "POST", body: "hello" });
    expect(got.headers["x-extra"]).toBe("1");
    expect(got.headers.authorization).toBe("Bearer caller");
  });

  it("refuses a link endpoint until a relay is set, then uses it", async () => {
    const { reg } = registry();
    reg.setHost("far", ["sing"]);
    reg.report("far", report([service({ name: "sing" })]));
    const endpoint = reg.pick("sing");
    if (endpoint === null) throw new Error("no endpoint");
    await expect(reg.request(endpoint, "/songs")).rejects.toThrow(RelayUnavailableError);
    await expect(reg.request(endpoint, "/songs")).rejects.toThrow(
      /reachable only through its control link, and the cluster module.s relay is not running/,
    );
    const asked: string[] = [];
    reg.setRelay({
      request: async (e, path) => {
        asked.push(`${e.host}${path}`);
        return new Response("ok");
      },
    });
    expect(await (await reg.request(endpoint, "/songs")).text()).toBe("ok");
    expect(asked).toEqual(["far/songs"]);
  });
});
