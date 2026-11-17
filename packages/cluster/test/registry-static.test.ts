// Static entries added at run time (the addresses the modules' own config keys still name): their
// order, their removal, the reported endpoint that stands for one at the same URL, and the
// `entry` and `ignoreResting` options.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClusterError, EndpointRegistry } from "../src/index.js";
import { report, service } from "./helpers.js";

function registry(options: ConstructorParameters<typeof EndpointRegistry>[0] = {}) {
  const clock = { t: 1_000_000 };
  const reg = new EndpointRegistry({ clock: { now: () => clock.t }, ...options });
  return { reg, clock };
}

const hosts = (reg: EndpointRegistry, capability: string) =>
  reg.candidates(capability).map((e) => e.host);

describe("static entries added at run time", () => {
  it("come after the other endpoints, in the order they were added, until removed", () => {
    const { reg } = registry({
      static: { friend: { provides: ["sing"], url: "http://friend:8005" } },
    });
    let fired = 0;
    reg.watch("sing", () => fired++);
    // Added out of name order: the order of the calls is kept.
    const removeB = reg.addStatic("sing", { provides: ["sing"], url: "http://b:8005" });
    reg.addStatic("sing.fallback.1", { provides: ["sing"], url: "http://a:8005" });
    expect(fired).toBe(2);
    reg.setHost("pc", ["sing"]);
    reg.report("pc", report([service({ name: "sing", url: "http://pc:8005" })]));
    expect(hosts(reg, "sing")).toEqual(["friend", "pc", "sing", "sing.fallback.1"]);
    expect(reg.candidates("sing")[2]).toMatchObject({
      service: "sing",
      url: "http://b:8005",
      via: "direct",
      healthy: true,
      version: null,
    });

    removeB();
    expect(hosts(reg, "sing")).toEqual(["friend", "pc", "sing.fallback.1"]);
    removeB(); // twice: nothing
    expect(fired).toBe(4);
  });

  it("follow `order` when it names them", () => {
    const { reg } = registry({ order: { sing: ["sing.fallback.1"] } });
    reg.addStatic("sing", { provides: ["sing"], url: "http://b:8005" });
    reg.addStatic("sing.fallback.1", { provides: ["sing"], url: "http://a:8005" });
    expect(hosts(reg, "sing")).toEqual(["sing.fallback.1", "sing"]);
  });

  it("carry their token and headers, and refuse a name that is taken", () => {
    const { reg } = registry({
      static: { taken: { provides: ["sing"], url: "http://x:1" } },
    });
    reg.addStatic("imagegen", {
      provides: ["imagegen"],
      url: "http://comfy:8188",
      headers: { "x-proxy": "p" },
    });
    reg.addStatic("speech.asr.local", {
      provides: ["asr"],
      url: "http://asr:8003",
      token: "t",
    });
    expect(reg.pick("imagegen")?.headers).toEqual({ "x-proxy": "p" });
    expect(reg.pick("asr")?.headers).toEqual({ authorization: "Bearer t" });
    expect(() => reg.addStatic("taken", { provides: ["sing"], url: "http://y:1" })).toThrow(
      ClusterError,
    );
    expect(() => reg.addStatic("imagegen", { provides: ["sing"], url: "http://y:1" })).toThrow(
      /named `imagegen` already/,
    );
  });

  it("lose their resting state when removed", () => {
    const { reg } = registry();
    const remove = reg.addStatic("turn", { provides: ["turn"], url: "http://t:8006" });
    const endpoint = reg.pick("turn");
    if (endpoint === null) throw new Error("no endpoint");
    reg.failed(endpoint);
    expect(reg.pick("turn")).toBeNull();
    remove();
    reg.addStatic("turn", { provides: ["turn"], url: "http://t:8006" });
    expect(reg.pick("turn")?.host).toBe("turn");
  });
});

describe("one endpoint per URL", () => {
  it("a reported endpoint at a static entry's URL is returned instead, in the entry's place", () => {
    const { reg } = registry();
    reg.addStatic("sing", { provides: ["sing"], url: "http://100.1.2.3:8005" });
    reg.addStatic("sing.fallback.1", { provides: ["sing"], url: "http://127.0.0.1:8005" });
    reg.setHost("main-pc", ["sing", "asr"]);
    reg.report(
      "main-pc",
      report([
        service({
          name: "sing",
          provides: ["sing"],
          url: "http://127.0.0.1:8005/",
          token: "secret",
        }),
      ]),
    );
    // The friend's worker (`url`) stays first: the reported one takes the fallback's place.
    const list = reg.candidates("sing");
    expect(list.map((e) => e.host)).toEqual(["sing", "main-pc"]);
    expect(list[1]).toMatchObject({ service: "sing", headers: { authorization: "Bearer secret" } });

    // `entry` finds it under the static entry's name too.
    expect(reg.candidates("sing", { entry: "sing.fallback.1" }).map((e) => e.host)).toEqual([
      "main-pc",
    ]);
    expect(reg.candidates("sing", { entry: "sing" }).map((e) => e.url)).toEqual([
      "http://100.1.2.3:8005",
    ]);
    expect(reg.candidates("sing", { entry: "nothing" })).toEqual([]);

    // The host goes away: the static entry is back.
    reg.removeHost("main-pc");
    expect(hosts(reg, "sing")).toEqual(["sing", "sing.fallback.1"]);
  });

  it("only for the same capability, and not for a link endpoint", () => {
    const { reg } = registry();
    reg.addStatic("voice.turn", { provides: ["turn", "vad"], url: "http://127.0.0.1:8006" });
    reg.setHost("pc", ["turn"]);
    reg.report(
      "pc",
      report([service({ name: "turn", provides: ["turn"], url: "http://127.0.0.1:8006" })]),
    );
    expect(hosts(reg, "turn")).toEqual(["pc"]);
    expect(hosts(reg, "vad")).toEqual(["voice.turn"]);

    reg.setHost("far", ["sing"]);
    reg.report("far", report([service({ name: "sing" })]));
    reg.addStatic("sing", { provides: ["sing"], url: "link://far/sing" });
    expect(reg.candidates("sing").map((e) => e.via)).toEqual(["link", "direct"]);
  });

  it("an entry of [modules.cluster.static] stands for one added at the same URL", () => {
    const { reg } = registry({
      static: { "friend-sing": { provides: ["sing"], url: "http://100.1.2.3:8005", token: "f" } },
    });
    reg.addStatic("sing", { provides: ["sing"], url: "http://100.1.2.3:8005" });
    reg.addStatic("sing.fallback.1", { provides: ["sing"], url: "http://127.0.0.1:8005" });
    expect(hosts(reg, "sing")).toEqual(["friend-sing", "sing.fallback.1"]);
    expect(reg.pick("sing", { entry: "sing" })?.headers).toEqual({ authorization: "Bearer f" });
  });
});

describe("ignoreResting", () => {
  it("keeps a failed endpoint in its place; an unhealthy one still goes last", () => {
    const { reg } = registry();
    reg.addStatic("sing", { provides: ["sing"], url: "http://a:8005" });
    reg.addStatic("sing.fallback.1", { provides: ["sing"], url: "http://b:8005" });
    const first = reg.pick("sing");
    if (first === null) throw new Error("no endpoint");
    reg.failed(first);
    expect(hosts(reg, "sing")).toEqual(["sing.fallback.1", "sing"]);
    expect(reg.candidates("sing", { ignoreResting: true }).map((e) => e.host)).toEqual([
      "sing",
      "sing.fallback.1",
    ]);

    reg.setHost("pc", ["sing"]);
    reg.report("pc", report([service({ name: "sing", url: "http://pc:1", healthy: false })]));
    expect(reg.candidates("sing", { ignoreResting: true }).map((e) => e.host)).toEqual([
      "sing",
      "sing.fallback.1",
      "pc",
    ]);
  });
});

describe("request to an entry added at run time", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it("sends its headers and its token", async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { reg } = registry();
    reg.addStatic("imagegen", {
      provides: ["imagegen"],
      url,
      token: "tok",
      headers: { "x-proxy": "p" },
    });
    const endpoint = reg.pick("imagegen");
    if (endpoint === null) throw new Error("no endpoint");
    const seen = (await (
      await reg.request(endpoint, "/system_stats")
    ).json()) as IncomingHttpHeaders;
    expect(seen.authorization).toBe("Bearer tok");
    expect(seen["x-proxy"]).toBe("p");
  });
});
