// The daemon with a `routes.toml` (v5-hostd §16): its report carries the routes and each service's
// address on them, the route token only on the control link, and its gateway reaches the service
// with the service's own token. Without the file the report is what it was.

import { HostInfoSchema, type HostServiceList } from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import { freePort } from "../src/index.js";
import { cleanup, daemonFor, fake, until, workspace, writeIn } from "./fakes.js";

afterEach(cleanup);

const OP = { kind: "operator" } as const;
const T = { timeout: 40_000 };
const FAR = ["[cluster]", 'url = "wss://core.example:7880/cluster-link"', ""].join("\n");

async function running(daemon: ReturnType<typeof daemonFor>, name: string) {
  await daemon.call("service.start", { service: name }, OP);
  return until(async () => {
    const list = (await daemon.call("service.list", {}, OP)) as HostServiceList;
    const s = list.services.find((x) => x.name === name);
    return s?.state === "running" ? s : undefined;
  }, 20_000);
}

describe("a daemon with routes.toml", () => {
  it("reports its routes and serves its services through the gateway", T, async () => {
    const ws = workspace([fake("a", "health.cjs")], FAR);
    const port = await freePort();
    writeIn(
      ws,
      "routes.toml",
      [
        "[gateway]",
        `port = ${port}`,
        "[[route]]",
        'kind = "tunnel"',
        `url = "http://127.0.0.1:${port}"`,
      ].join("\n"),
    );
    const daemon = daemonFor(ws);
    await daemon.start();
    const a = await running(daemon, "a");
    expect(a.reach).toEqual({ tunnel: `http://127.0.0.1:${port}/svc/a` });

    // The operator sees the routes, never the route token.
    const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
    expect(info.routes).toEqual([
      {
        name: "tunnel",
        kind: "tunnel",
        url: `http://127.0.0.1:${port}`,
        max_body_bytes: 100 * 1024 * 1024,
      },
      { name: "relay", kind: "relay", implicit: true },
    ]);
    expect(info.route_token).toBeUndefined();
    const linked = daemon.report({ withTokens: true });
    expect(linked.route_token).toMatch(/^[\w-]{20,}$/u);
    const token = linked.services.find((s) => s.name === "a")?.token as string;

    const health = await fetch(`http://127.0.0.1:${port}/svc/a/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("x-miyoria-route")).toBe("gateway");
    expect(await health.json()).toMatchObject({ status: "ok" });
    const probe = await fetch(`http://127.0.0.1:${port}/_miyoria/probe`, {
      headers: { authorization: `Bearer ${linked.route_token}` },
    });
    expect(probe.status).toBe(200);
    const stranger = await fetch(`http://127.0.0.1:${port}/svc/a/health`);
    expect(stranger.status).toBe(401);
  });

  it("reports a gateway that cannot listen as a problem of its routes", T, async () => {
    const ws = workspace([fake("a", "health.cjs")], FAR);
    const port = await freePort();
    writeIn(
      ws,
      "routes.toml",
      [
        "[gateway]",
        `port = ${port}`,
        'tls_cert = "missing.pem"',
        'tls_key = "missing-key.pem"',
        "[[route]]",
        'kind = "direct"',
        'url = "https://friend.example.net"',
      ].join("\n"),
    );
    const daemon = daemonFor(ws);
    await daemon.start();
    const a = await running(daemon, "a");
    expect(a.reach).toEqual({});
    const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
    expect(info.routes?.[0]?.problem).toContain("憑證");
  });

  it("without routes.toml reports nothing new", T, async () => {
    const ws = workspace([fake("a", "health.cjs")], FAR);
    const daemon = daemonFor(ws);
    await daemon.start();
    const a = await running(daemon, "a");
    expect(a.reach).toBeUndefined();
    const linked = daemon.report({ withTokens: true });
    expect(linked.routes).toBeUndefined();
    expect(linked.route_token).toBeUndefined();
  });
});
