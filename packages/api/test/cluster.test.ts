// `/api/cluster/*`: the hosts, join codes, host info and service actions over the control link,
// the endpoints, and the join route. The cluster module is stood in for by its real tables and
// registry with a link that is a table of connected hosts.

import { request } from "node:http";
import {
  ClusterKey,
  type ClusterService,
  clusterTables,
  EndpointRegistry,
  type HostConnection,
} from "@miyoria/cluster";
import { contract, routeMeta } from "@miyoria/contracts/api";
import { HOST_ERROR_CODE, type HostInfo } from "@miyoria/contracts/host";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";

/** A JSON POST with the `Host` header chosen (`fetch` does not let a caller set it). */
function postAs(
  base: string,
  path: string,
  host: string,
  json: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: { host, "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => {
          text += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(json));
  });
}
const T0 = Date.UTC(2026, 10, 16, 12);

const sups: Supervisor[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

/** What the fake link answers, by method; a function may throw to stand for a host's error. */
type Answer = (name: string, params: unknown) => unknown;

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { name: "RpcError", code });
}

const INFO: HostInfo & { services: Array<Record<string, unknown>> } = {
  name: "pc",
  version: "0.1.0",
  platform: "win32",
  protocol: 1,
  gpu: { name: "RTX", total_mb: 12_000, used_mb: 2_000, reserve_mb: 500 },
  link: "connected",
  services: [
    {
      name: "asr",
      kind: "worker",
      provides: ["asr"],
      state: "running",
      since: 1,
      healthy: true,
      restarts: 0,
      url: "http://pc:8003",
      token: "service-secret-token",
    },
  ],
};

async function harness(options: { cluster?: boolean; publicUrl?: string | null } = {}) {
  const store = await SqliteStore.open(":memory:", { plugins: [clusterTables] });
  stores.push(store);
  const clock = { t: T0 };
  const tables = store.plugin(clusterTables).withClock({ now: () => clock.t });
  const connections = new Map<string, HostConnection>();
  const answers = new Map<string, Answer>();
  const calls: Array<{ name: string; method: string; params: unknown }> = [];
  const registry = new EndpointRegistry({
    clock: { now: () => clock.t },
    static: { friend: { provides: ["sing"], url: "http://f:8005", token: "static-secret" } },
  });
  const cluster: ClusterService = {
    registry,
    guards: undefined as never,
    address: { address: "127.0.0.1", family: "IPv4", port: 7880 },
    publicUrl: options.publicUrl ?? null,
    hosts: {
      create: (o) => tables.hosts.create(o),
      approve: (n, c) => tables.hosts.approve(n, c),
      revoke: (n) => tables.hosts.revoke(n),
      remove: (n) => {
        const removed = tables.hosts.remove(n);
        if (removed !== null) {
          connections.delete(n);
          registry.removeHost(n);
        }
        return removed;
      },
      invite: (o) => tables.invites.invite(o),
      redeem: (code, name) => tables.invites.redeem(code, name),
      list: () => tables.hosts.list(),
      connected: () => [...connections.values()],
      call: async (name, method, params) => {
        calls.push({ name, method, params });
        const answer = answers.get(method);
        if (answer === undefined) throw new Error(`no answer for ${method}`);
        return answer(name, params);
      },
    },
  };
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  if (options.cluster !== false) sup.services.provide("kernel", ClusterKey, cluster);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const admin = (method: string, path: string, json?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(json === undefined ? {} : { json }) });
  const connect = (name: string) => {
    const host = tables.hosts.byName(name);
    if (host === null) throw new Error(`no host ${name}`);
    connections.set(name, {
      id: host.id,
      name,
      platform: "win32",
      version: "0.1.0",
      approved: host.status === "approved",
      since: T0 + 5_000,
    });
  };
  return { base, admin, tables, cluster, connect, answers, calls, clock, registry };
}

/** No key (and no hash of one) anywhere in a response text. */
function expectNoSecrets(text: string, keys: string[] = []) {
  expect(text).not.toContain("key_hash");
  expect(text).not.toMatch(/"key"/);
  for (const key of keys) expect(text).not.toContain(key);
  expect(text).not.toContain("service-secret-token");
  expect(text).not.toContain("static-secret");
}

describe("the admin routes need the token", () => {
  it("answers 401 without it, and 503 while the cluster module is not running", async () => {
    const h = await harness({ cluster: false });
    const paths: Array<[string, string, unknown?]> = [
      ["GET", "/api/cluster/hosts"],
      ["POST", "/api/cluster/invites", {}],
      ["POST", "/api/cluster/hosts", { name: "a", capabilities: [] }],
      ["POST", "/api/cluster/hosts/a/approve", { capabilities: [] }],
      ["DELETE", "/api/cluster/hosts/a"],
      ["GET", "/api/cluster/hosts/a/info"],
      ["POST", "/api/cluster/hosts/a/services/asr/start", {}],
      ["GET", "/api/cluster/endpoints"],
    ];
    for (const [method, path, json] of paths) {
      const anonymous = await raw(h.base, method, path, json === undefined ? {} : { json });
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      const wrong = await raw(h.base, method, path, {
        token: "nope",
        ...(json === undefined ? {} : { json }),
      });
      expect(wrong.status, `${method} ${path} wrong token`).toBe(401);
      const answer = await h.admin(method, path, json);
      expect(answer.status, `${method} ${path}`).toBe(503);
      expect(answer.body).toEqual({ error: "the cluster module is not running" });
    }
    const joined = await raw(h.base, "POST", "/api/cluster/join", {
      json: { code: "ABCD-1234", name: "pc" },
    });
    expect(joined.status).toBe(503);
  });
});

describe("who may call", () => {
  it("join is the only public route; the rest are admin routes", () => {
    expect(routeMeta(contract, ["cluster", "join"])).toEqual({
      audience: "public",
      permission: null,
    });
    for (const name of [
      "hosts",
      "invite",
      "create",
      "approve",
      "remove",
      "info",
      "service",
      "endpoints",
    ]) {
      expect(routeMeta(contract, ["cluster", name]), name).toEqual({
        audience: "admin",
        permission: null,
      });
    }
  });
});

describe("hosts", () => {
  it("creates one approved at once, shows its key only there, and lists it", async () => {
    const h = await harness();
    const made = await h.admin("POST", "/api/cluster/hosts", {
      name: "main-pc",
      capabilities: ["core", "asr"],
    });
    expect(made.status).toBe(200);
    const key = (made.body as { key: string }).key;
    expect(made.body).toEqual({ id: expect.any(String), name: "main-pc", key });
    expect(key.length).toBeGreaterThan(20);

    const list = await h.admin("GET", "/api/cluster/hosts");
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      {
        id: (made.body as { id: string }).id,
        name: "main-pc",
        status: "approved",
        capabilities: ["core", "asr"],
        platform: null,
        version: null,
        created_at: new Date(T0).toISOString(),
        last_seen_at: null,
        connected: false,
        connected_since: null,
      },
    ]);
    expectNoSecrets(list.text, [key]);

    h.connect("main-pc");
    const after = (await h.admin("GET", "/api/cluster/hosts")).body as Array<{
      connected: boolean;
      connected_since: string | null;
    }>;
    expect(after[0]).toMatchObject({
      connected: true,
      connected_since: new Date(T0 + 5_000).toISOString(),
    });

    expect(
      (await h.admin("POST", "/api/cluster/hosts", { name: "main-pc", capabilities: [] })).status,
    ).toBe(409);
    const bad = await h.admin("POST", "/api/cluster/hosts", {
      name: "has space",
      capabilities: [],
    });
    expect(bad.status).toBe(400);
    expectNoSecrets(bad.text);
  });

  it("approves a pending host for exactly the capabilities given", async () => {
    const h = await harness();
    const invite = h.tables.invites.invite({ by: "t" });
    const joined = h.tables.invites.redeem(invite.code, "friend-pc");
    const approved = await h.admin("POST", "/api/cluster/hosts/friend-pc/approve", {
      capabilities: ["sing", "sing", "tts"],
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      name: "friend-pc",
      status: "approved",
      capabilities: ["sing", "tts"],
    });
    expectNoSecrets(approved.text, [joined.key]);
    expect(
      (await h.admin("POST", "/api/cluster/hosts/nobody/approve", { capabilities: [] })).status,
    ).toBe(404);
    h.tables.hosts.revoke("friend-pc");
    expect(
      (await h.admin("POST", "/api/cluster/hosts/friend-pc/approve", { capabilities: [] })).status,
    ).toBe(409);
  });

  it("removes a host: its key stops working and it is no longer connected", async () => {
    const h = await harness();
    const made = h.tables.hosts.create({ name: "pc", approved: true, capabilities: ["asr"] });
    h.connect("pc");
    const gone = await h.admin("DELETE", "/api/cluster/hosts/pc");
    expect(gone.status).toBe(204);
    expect(gone.text).toBe("");
    expect(h.tables.hosts.verify(made.host.id, made.key)).toBe(false);
    expect(h.cluster.hosts.connected()).toEqual([]);
    expect((await h.admin("GET", "/api/cluster/hosts")).body).toEqual([]);
    expect((await h.admin("DELETE", "/api/cluster/hosts/pc")).status).toBe(404);
  });
});

describe("invites", () => {
  it("shows the code once and the code works for a join", async () => {
    const h = await harness();
    const made = await h.admin("POST", "/api/cluster/invites", { name: "friend-pc", ttl_s: 300 });
    expect(made.status).toBe(200);
    const { code, expires_at } = made.body as { code: string; expires_at: string };
    expect(code).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(expires_at).toBe(new Date(T0 + 300_000).toISOString());
    expect(Object.keys(made.body as object).sort()).toEqual(["code", "expires_at"]);
    // Nothing a later call shows holds the code.
    expect((await h.admin("GET", "/api/cluster/hosts")).text).not.toContain(code);
    expect((await h.admin("POST", "/api/cluster/invites", { name: "bad name" })).status).toBe(400);
    expect((await h.admin("POST", "/api/cluster/invites", { ttl_s: 0 })).status).toBe(422);
  });
});

describe("host info", () => {
  it("asks the host and leaves the service tokens out", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "pc", approved: true, capabilities: ["asr"] });
    h.connect("pc");
    h.answers.set("host.info", () => INFO);
    const answer = await h.admin("GET", "/api/cluster/hosts/pc/info");
    expect(answer.status).toBe(200);
    expect(h.calls).toEqual([{ name: "pc", method: "host.info", params: null }]);
    expect(answer.body).toMatchObject({
      name: "pc",
      protocol: 1,
      link: "connected",
      services: [{ name: "asr", url: "http://pc:8003", state: "running" }],
    });
    expectNoSecrets(answer.text);
    expect(answer.text).not.toContain("token");
  });

  it("is a clear 409 for a host that is not connected, 404 for an unknown one", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "pc", approved: true, capabilities: [] });
    const off = await h.admin("GET", "/api/cluster/hosts/pc/info");
    expect(off.status).toBe(409);
    expect(off.body).toEqual({ error: "host `pc` is not connected" });
    expect((await h.admin("GET", "/api/cluster/hosts/none/info")).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it("is a 502 when the host answers something unreadable", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "pc", approved: true, capabilities: [] });
    h.connect("pc");
    h.answers.set("host.info", () => ({ nonsense: true }));
    expect((await h.admin("GET", "/api/cluster/hosts/pc/info")).status).toBe(502);
  });
});

describe("service actions", () => {
  it("runs start, stop and restart on the host", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "pc", approved: true, capabilities: [] });
    h.connect("pc");
    for (const [method, state] of [
      ["service.start", "running"],
      ["service.stop", "stopped"],
      ["service.restart", "running"],
    ] as const) {
      h.answers.set(method, (_n, params) => ({
        service: (params as { service: string }).service,
        state,
      }));
    }
    const start = await h.admin("POST", "/api/cluster/hosts/pc/services/asr/start", {});
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ service: "asr", state: "running" });
    const stop = await h.admin("POST", "/api/cluster/hosts/pc/services/asr/stop", { force: true });
    expect(stop.body).toEqual({ service: "asr", state: "stopped" });
    expect((await h.admin("POST", "/api/cluster/hosts/pc/services/tts/restart", {})).status).toBe(
      200,
    );
    expect(h.calls).toEqual([
      { name: "pc", method: "service.start", params: { service: "asr" } },
      { name: "pc", method: "service.stop", params: { service: "asr", force: true } },
      { name: "pc", method: "service.restart", params: { service: "tts" } },
    ]);
    expect((await h.admin("POST", "/api/cluster/hosts/pc/services/asr/explode", {})).status).toBe(
      404,
    );
    expect(
      (await h.admin("POST", "/api/cluster/hosts/pc/services/asr/start", { force: "yes" })).status,
    ).toBe(422);
  });

  it("answers 409 with the host's message for a guarded state, and for a host not connected", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "pc", approved: true, capabilities: [] });
    h.answers.set("service.stop", () => {
      throw rpcError(HOST_ERROR_CODE.Guarded, "she is singing: repeat with force to stop it");
    });
    h.answers.set("service.start", () => {
      throw rpcError(HOST_ERROR_CODE.UnknownService, "no service `nope`");
    });
    expect((await h.admin("POST", "/api/cluster/hosts/pc/services/asr/stop", {})).status).toBe(409);
    h.connect("pc");
    const guarded = await h.admin("POST", "/api/cluster/hosts/pc/services/asr/stop", {});
    expect(guarded.status).toBe(409);
    expect(guarded.body).toEqual({ error: "she is singing: repeat with force to stop it" });
    expect((await h.admin("POST", "/api/cluster/hosts/pc/services/nope/start", {})).status).toBe(
      404,
    );
    expect((await h.admin("POST", "/api/cluster/hosts/ghost/services/asr/start", {})).status).toBe(
      404,
    );
  });
});

describe("endpoints", () => {
  it("lists the candidates per capability, a url only for direct ones and never a header", async () => {
    const h = await harness();
    h.registry.setHost("pc", ["asr", "tts"]);
    h.registry.report("pc", {
      ...INFO,
      services: [
        {
          name: "asr",
          kind: "worker",
          provides: ["asr"],
          state: "running",
          since: 1,
          healthy: true,
          restarts: 0,
          url: "http://pc:8003",
          advertised: "http://pc:8003",
          token: "service-secret-token",
          version: "1.2",
        },
        {
          name: "tts",
          kind: "worker",
          provides: ["tts"],
          state: "running",
          since: 1,
          healthy: true,
          restarts: 0,
          token: "service-secret-token",
        },
      ],
    });
    const answer = await h.admin("GET", "/api/cluster/endpoints");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      capabilities: [
        {
          capability: "asr",
          candidates: [
            {
              host: "pc",
              service: "asr",
              via: "direct",
              healthy: true,
              version: "1.2",
              url: "http://pc:8003",
            },
          ],
        },
        {
          capability: "sing",
          candidates: [
            {
              host: "friend",
              service: "friend",
              via: "direct",
              healthy: true,
              version: null,
              url: "http://f:8005",
            },
          ],
        },
        {
          capability: "tts",
          candidates: [{ host: "pc", service: "tts", via: "link", healthy: true, version: null }],
        },
      ],
    });
    expectNoSecrets(answer.text);
    expect(answer.text).not.toContain("headers");
    expect(answer.text).not.toContain("link://");
  });
});

describe("join", () => {
  const join = (
    h: Awaited<ReturnType<typeof harness>>,
    body: unknown,
    headers: Record<string, string> = {},
  ) => raw(h.base, "POST", "/api/cluster/join", { json: body, headers });

  it("takes a good code without a session and answers the id, the key and the link", async () => {
    const h = await harness();
    const { code } = h.tables.invites.invite({ by: "t" });
    const answer = await postAs(h.base, "/api/cluster/join", "core.example:7878", {
      code,
      name: "friend-pc",
      platform: "linux",
      version: "0.1.0",
    });
    expect(answer.status).toBe(200);
    const body = answer.body as { host_id: string; key: string; link_url: string };
    expect(Object.keys(body).sort()).toEqual(["host_id", "key", "link_url"]);
    expect(body.link_url).toBe("ws://core.example:7880/cluster-link");
    const row = h.tables.hosts.byName("friend-pc");
    expect(row).toMatchObject({ id: body.host_id, status: "pending" });
    expect(h.tables.hosts.verify(body.host_id, body.key)).toBe(true);
    // Shown once: the list never has it.
    expectNoSecrets((await h.admin("GET", "/api/cluster/hosts")).text, [body.key]);
  });

  it("builds the link from public_url when it is set, and from an IPv6 host without losing brackets", async () => {
    const set = await harness({ publicUrl: "wss://core.example/cluster-link" });
    const a = await join(set, { code: set.tables.invites.invite({ by: "t" }).code, name: "a" });
    expect((a.body as { link_url: string }).link_url).toBe("wss://core.example/cluster-link");
    const h = await harness();
    const b = await postAs(h.base, "/api/cluster/join", "[::1]:7878", {
      code: h.tables.invites.invite({ by: "t" }).code,
      name: "b",
    });
    expect((b.body as { link_url: string }).link_url).toBe("ws://[::1]:7880/cluster-link");
  });

  it("answers the same 403 for an unknown, a used and an expired code", async () => {
    const h = await harness();
    const used = h.tables.invites.invite({ by: "t" }).code;
    expect((await join(h, { code: used, name: "one" })).status).toBe(200);
    const expired = h.tables.invites.invite({ by: "t", ttl_s: 1 }).code;
    h.clock.t += 5_000;
    const answers = [
      await join(h, { code: "ZZZZ-0000", name: "two" }),
      await join(h, { code: used, name: "two" }),
      await join(h, { code: expired, name: "two" }),
    ];
    for (const a of answers) {
      expect(a.status).toBe(403);
      expect(a.body).toEqual({ error: "this code does not work" });
      expectNoSecrets(a.text);
    }
    expect(h.tables.hosts.list().map((x) => x.name)).toEqual(["one"]);
  });

  it("keeps a good code for another name when the name is taken", async () => {
    const h = await harness();
    h.tables.hosts.create({ name: "taken" });
    const { code } = h.tables.invites.invite({ by: "t" });
    expect((await join(h, { code, name: "taken" })).status).toBe(409);
    expect((await join(h, { code, name: "free" })).status).toBe(200);
  });

  it("allows 5 attempts a minute per address and then does nothing else", async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) {
      expect(
        (await join(h, { code: "ZZZZ-0000", name: "x" }, { "cf-connecting-ip": "203.0.113.9" }))
          .status,
      ).toBe(403);
    }
    const { code } = h.tables.invites.invite({ by: "t" });
    const limited = await join(h, { code, name: "pc" }, { "cf-connecting-ip": "203.0.113.9" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // The code was not used and no host made: the address was over its limit.
    expect(h.tables.hosts.list()).toEqual([]);
    // Another address is its own count, and the code still works.
    const other = await join(h, { code, name: "pc" }, { "cf-connecting-ip": "203.0.113.10" });
    expect(other.status).toBe(200);
  });

  it("is served while the public side is off, and refuses a body that does not match", async () => {
    const h = await harness();
    expect((await join(h, { name: "pc" })).status).toBe(422);
    expect((await join(h, { code: "", name: "pc" })).status).toBe(422);
  });
});
