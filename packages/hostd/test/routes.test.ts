// `routes.toml` (v5-hostd §16): what a machine's owner may declare, what is refused and why (plain
// HTTP for `direct` and `tunnel`, a gateway on the network without TLS), the routes added without
// being declared, and where each service is on each route.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoutes, reachOf, reportRoutes, withLocal } from "../src/index.js";
import { TMP } from "./fakes.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(routes?: string): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "routes-"));
  made.push(dir);
  if (routes !== undefined) writeFileSync(join(dir, "routes.toml"), routes);
  return dir;
}

const load = (text: string | undefined, network: { advertise?: string; bind?: string } = {}) =>
  loadRoutes({
    workspace: folder(text),
    advertise: network.advertise,
    bind: network.bind ?? "0.0.0.0",
  });

describe("routes.toml", () => {
  it("without the file nothing is reported: the host is routed as before", () => {
    expect(load(undefined, { advertise: "pc.tailnet" })).toBeNull();
  });

  it("reads every kind, names them, and adds the advertised address and the relay", () => {
    const loaded = load(
      [
        "[gateway]",
        "port = 7890",
        "[[route]]",
        'kind = "direct"',
        'url = "https://friend.example.net:7890/"',
        "[[route]]",
        'kind = "tunnel"',
        'url = "https://miyoria.example.com"',
        "[[route]]",
        'kind = "tunnel"',
        'url = "https://second.example.com"',
        "max_body_mb = 50",
      ].join("\n"),
      { advertise: "friend.tail1234.ts.net" },
    );
    expect(loaded?.problems).toEqual([]);
    expect(loaded?.gateway).toEqual({ bind: "127.0.0.1", port: 7890, tls: null });
    expect(reportRoutes(loaded as never, null)).toEqual([
      { name: "advertise", kind: "tailnet", url: "friend.tail1234.ts.net", implicit: true },
      { name: "direct", kind: "direct", url: "https://friend.example.net:7890" },
      {
        name: "tunnel",
        kind: "tunnel",
        url: "https://miyoria.example.com",
        max_body_bytes: 100 * 1024 * 1024,
      },
      {
        name: "tunnel-2",
        kind: "tunnel",
        url: "https://second.example.com",
        max_body_bytes: 50 * 1024 * 1024,
      },
      { name: "relay", kind: "relay", implicit: true },
    ]);
  });

  it("refuses plain HTTP for direct and tunnel, except to this machine", () => {
    const loaded = load(
      [
        "[gateway]",
        "port = 7890",
        "[[route]]",
        'kind = "direct"',
        'url = "http://203.0.113.7:7890"',
        "[[route]]",
        'kind = "tunnel"',
        'url = "http://127.0.0.1:7890"',
      ].join("\n"),
    );
    const routes = reportRoutes(loaded as never, null);
    expect(routes[0]?.problem).toContain("https");
    expect(routes[1]?.problem).toBeUndefined();
  });

  it("refuses a gateway on the network without TLS, and half a certificate", () => {
    const route = ["[[route]]", 'kind = "direct"', 'url = "https://friend.example.net"'];
    const open = load(["[gateway]", 'bind = "0.0.0.0"', "port = 7890", ...route].join("\n"));
    expect(open?.gateway).toBeNull();
    expect(open?.problems[0]).toContain("TLS");
    expect(reportRoutes(open as never, null)[0]?.problem).toContain("TLS");
    const half = load(["[gateway]", "port = 7890", 'tls_cert = "cert.pem"', ...route].join("\n"));
    expect(half?.problems[0]).toContain("tls_key");
    const none = load(route.join("\n"));
    expect(none?.problems[0]).toContain("[gateway]");
    const tls = load(
      [
        "[gateway]",
        'bind = "0.0.0.0"',
        "port = 7890",
        'tls_cert = "certs/fullchain.pem"',
        'tls_key = "certs/privkey.pem"',
        ...route,
      ].join("\n"),
    );
    expect(tls?.problems).toEqual([]);
    expect(tls?.gateway?.tls?.cert.endsWith(join("certs", "fullchain.pem"))).toBe(true);
  });

  it("a tailnet route needs an address the services listen on", () => {
    const missing = load(["[[route]]", 'kind = "tailnet"'].join("\n"));
    expect(reportRoutes(missing as never, null)[0]?.problem).toContain("address");
    const loopback = load(["[[route]]", 'kind = "tailnet"', 'address = "pc.ts.net"'].join("\n"), {
      bind: "127.0.0.1",
    });
    expect(reportRoutes(loopback as never, null)[0]?.problem).toContain("bind");
    const port = load(["[[route]]", 'kind = "tailnet"', 'address = "pc.ts.net:8005"'].join("\n"));
    expect(reportRoutes(port as never, null)[0]?.problem).toContain("埠");
    const fine = load(["[[route]]", 'kind = "tailnet"'].join("\n"), { advertise: "pc.ts.net" });
    expect(reportRoutes(fine as never, null)[0]).toEqual({
      name: "tailnet",
      kind: "tailnet",
      url: "pc.ts.net",
    });
  });

  it("a file that does not load is one problem, and only the implicit routes are left", () => {
    const loaded = load(["[[route]]", 'kind = "direct"', 'uri = "https://x"'].join("\n"), {
      advertise: "pc.ts.net",
    });
    expect(loaded?.problems[0]).toContain("routes.toml");
    expect(reportRoutes(loaded as never, null).map((r) => r.name)).toEqual(["advertise", "relay"]);
  });

  it("refuses two routes of one name", () => {
    const loaded = load(
      [
        "[[route]]",
        'name = "home"',
        'kind = "tailnet"',
        'address = "a.ts.net"',
        "[[route]]",
        'name = "home"',
        'kind = "tailnet"',
        'address = "b.ts.net"',
      ].join("\n"),
    );
    expect(loaded?.problems[0]).toContain("home");
  });
});

describe("where a service is on each route", () => {
  const loaded = () =>
    load(
      [
        "[gateway]",
        "port = 7890",
        "[[route]]",
        'kind = "tunnel"',
        'url = "https://miyoria.example.com"',
      ].join("\n"),
      { advertise: "fd7a::1" },
    ) as NonNullable<ReturnType<typeof load>>;

  it("its own port on a tailnet address, under the gateway on the others", () => {
    expect(reachOf(withLocal(loaded(), "127.0.0.1"), "sing", 8005, true, true)).toEqual({
      local: "http://127.0.0.1:8005",
      advertise: "http://[fd7a::1]:8005",
      tunnel: "https://miyoria.example.com/svc/sing",
    });
  });

  it("not under the gateway while it does not listen, nor for what it does not serve", () => {
    expect(reachOf(loaded(), "sing", 8005, true, false)).toEqual({
      advertise: "http://[fd7a::1]:8005",
    });
    expect(reachOf(loaded(), "core", 7878, false, true)).toEqual({
      advertise: "http://[fd7a::1]:7878",
    });
    expect(reportRoutes(loaded(), "閘道沒辦法聽")[1]?.problem).toBe("閘道沒辦法聽");
  });
});
