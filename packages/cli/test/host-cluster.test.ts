// `miyoria host invite | join | ls | approve | remove` and `status --all`, against a small fake HTTP
// server that plays Core's cluster routes (the admin token checked), a temporary workspace, and
// for the relink a daemon running in this process with a fake control link.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostApi, LinkHandle } from "@miyoria/hostd";
import { Daemon } from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkArgs, parseArgs, UsageError } from "../src/cli.js";
import * as cluster from "../src/commands/cluster.js";
import * as host from "../src/commands/host.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const ADMIN = "admin-token";
const KEY = "super-secret-host-key-0123456789";

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Plays Core's routes. `reply` returns a canned answer for a route, `routes` the defaults. */
class FakeCore {
  readonly calls: Call[] = [];
  hosts: unknown[] = [];
  infos: Record<string, unknown> = {};
  /** Overrides by `METHOD path`. */
  readonly replies = new Map<string, Reply>();
  #server: Server;
  port = 0;

  constructor() {
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => this.#server.listen(0, "127.0.0.1", done));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.#server.close(() => done());
      this.#server.closeAllConnections();
    });
  }

  calls_to(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async #handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] as string;
    const call: Call = {
      method,
      path,
      body: raw === "" ? undefined : JSON.parse(raw),
      authorization: req.headers.authorization,
    };
    this.calls.push(call);
    const reply = this.#route(call);
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(reply.status === 204 || reply.body === undefined ? "" : JSON.stringify(reply.body));
  }

  #route(call: Call): Reply {
    const { method, path } = call;
    const canned = this.replies.get(`${method} ${path}`);
    if (path !== "/api/cluster/join" && call.authorization !== `Bearer ${ADMIN}`) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (canned !== undefined) return canned;
    if (method === "GET" && path === "/api/health") {
      return { status: 200, body: { status: "ok", version: "9.9.9" } };
    }
    if (method === "GET" && path === "/api/modules") return { status: 200, body: [] };
    if (method === "GET" && path === "/api/llm/usage") return { status: 200, body: {} };
    if (method === "GET" && path === "/api/cluster/hosts") return { status: 200, body: this.hosts };
    if (method === "POST" && path === "/api/cluster/invites") {
      return { status: 200, body: { code: "ABCD-1234", expires_at: "2030-01-02T03:04:00.000Z" } };
    }
    if (method === "POST" && path === "/api/cluster/hosts") {
      const body = call.body as { name: string };
      return { status: 200, body: { id: "h-local", name: body.name, key: KEY } };
    }
    const info = /^\/api\/cluster\/hosts\/([^/]+)\/info$/.exec(path);
    if (method === "GET" && info !== null) {
      const known = this.infos[decodeURIComponent(info[1] as string)];
      return known === undefined
        ? { status: 409, body: { error: "host is not connected" } }
        : { status: 200, body: known };
    }
    const approve = /^\/api\/cluster\/hosts\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approve !== null) {
      const name = decodeURIComponent(approve[1] as string);
      const body = call.body as { capabilities: string[] };
      return {
        status: 200,
        body: { ...view(name), status: "approved", capabilities: body.capabilities },
      };
    }
    if (method === "DELETE" && /^\/api\/cluster\/hosts\/[^/]+$/.test(path)) {
      return { status: 204 };
    }
    return { status: 404, body: { error: `no route ${method} ${path}` } };
  }
}

function view(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name,
    status: "approved",
    capabilities: [],
    platform: "win32",
    version: "0.1.0",
    created_at: "2026-11-01T00:00:00.000Z",
    last_seen_at: null,
    connected: false,
    connected_since: null,
    ...extra,
  };
}

function service(name: string, provides: string[], state = "running"): Record<string, unknown> {
  return {
    name,
    kind: "worker",
    provides,
    state,
    since: Date.now() - 120_000,
    port: 8003,
    pid: 42,
    healthy: true,
    restarts: 0,
  };
}

let dir: string;
let out: string[];
let restore: () => void;
let core: FakeCore;
const daemons: Daemon[] = [];

beforeEach(async () => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "cluster-"));
  // A checkout of its own, so nothing above it is taken for the source folder.
  write("pnpm-workspace.yaml", "packages: []\n");
  mkdirSync(join(dir, "workers"), { recursive: true });
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) } satisfies Output);
  core = new FakeCore();
  await core.start();
  coreToml();
});

afterEach(async () => {
  restore();
  for (const d of daemons.splice(0)) await d.stop();
  await core.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

function read(path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

/** `miyoria.toml` pointing at the fake Core. */
function coreToml(extra = "", bind = `127.0.0.1:${core.port}`): void {
  write("miyoria.toml", `[modules.api]\nbind = "${bind}"\ntoken = "${ADMIN}"\n${extra}`);
}

function target(): host.HostTarget {
  return host.hostTarget(join(dir, "miyoria.toml"));
}

const text = () => out.join("");

function descriptor(name: string, provides: string[]): void {
  write(
    `workers/${name}/service.toml`,
    `name = "${name}"\nkind = "worker"\nprovides = ${JSON.stringify(provides)}\n[run]\ncommand = ["x"]\n`,
  );
}

const JOINED: Reply = {
  status: 200,
  body: { host_id: "h-1", key: KEY, link_url: "ws://core.lan:7880/cluster-link" },
};

function joinWith(options: Partial<cluster.JoinOptions> = {}): Promise<void> {
  return cluster.joinHost(target(), {
    coreUrl: `http://127.0.0.1:${core.port}`,
    code: "ABCD-1234",
    ...options,
  });
}

describe("command line", () => {
  it("parses_the_host_commands", () => {
    const invite = parseArgs(["host", "invite", "--name", "laptop", "--ttl", "30"]);
    expect(invite.path.map((c) => c.name)).toEqual(["miyoria", "host", "invite"]);
    expect(invite.ctx.options).toMatchObject({ name: "laptop", ttl: "30" });
    expect(parseArgs(["host", "invite"]).ctx.options.ttl).toBe("10");

    const join = parseArgs(["host", "join", "http://c:7878", "--code", "ABCD-1234", "--force"]);
    expect(join.path.map((c) => c.name)).toEqual(["miyoria", "host", "join"]);
    expect(join.ctx.args).toEqual(["http://c:7878"]);
    expect(join.ctx.options).toMatchObject({ code: "ABCD-1234", force: true });
    const local = parseArgs(["host", "join", "--local", "--name", "main"]);
    expect(local.ctx.options).toMatchObject({ local: true, name: "main" });
    expect(() => checkArgs(local.path, local.ctx)).not.toThrow();
    const both = parseArgs(["host", "join", "--local", "http://c:7878"]);
    expect(() => checkArgs(both.path, both.ctx)).toThrow(UsageError);

    const approve = parseArgs(["host", "approve", "laptop", "asr", "tts"]);
    expect(approve.ctx.args).toEqual(["laptop", "asr", "tts"]);
    expect(() => checkArgs(approve.path, approve.ctx)).not.toThrow();
    const bare = parseArgs(["host", "approve"]);
    expect(() => checkArgs(bare.path, bare.ctx)).toThrow(/name/);

    const remove = parseArgs(["host", "remove", "laptop", "-y"]);
    expect(remove.ctx).toMatchObject({ args: ["laptop"], yes: true });
    expect(parseArgs(["host", "ls"]).path.at(-1)?.name).toBe("ls");
    expect(parseArgs(["status", "--all"]).ctx.options.all).toBe(true);
  });
});

describe("host invite", () => {
  it("prints_the_code_when_it_expires_and_the_join_command", async () => {
    coreToml("", `127.0.0.1:${core.port}`);
    await cluster.invite(target(), { name: "laptop", ttlMinutes: 30 });
    const call = core.calls_to("POST", "/api/cluster/invites")[0];
    expect(call?.authorization).toBe(`Bearer ${ADMIN}`);
    expect(call?.body).toEqual({ name: "laptop", ttl_s: 1800 });
    expect(text()).toContain("ABCD-1234");
    expect(text()).toContain("miyoria host join http://127.0.0.1:");
    expect(text()).toContain("--code ABCD-1234 --name laptop");
    expect(text()).toContain("2030-01-02");
    // loopback: the other machine cannot reach it, and the way out is named
    expect(text()).toContain("別台電腦連不到");
    expect(text()).toContain("[modules.api] bind");
  });

  it("gives_the_address_another_machine_uses", () => {
    const at = (bind: string) =>
      cluster.publicApiAddress(
        Config.fromToml(`[modules.api]\nbind = "${bind}"\n`, () => undefined),
      );
    expect(at("192.168.1.10:7878")).toEqual({ url: "http://192.168.1.10:7878", reachable: true });
    expect(at("main-pc.tailnet:9000")).toEqual({
      url: "http://main-pc.tailnet:9000",
      reachable: true,
    });
    expect(at("[fd00::1]:7878")).toEqual({ url: "http://[fd00::1]:7878", reachable: true });
    expect(at("127.0.0.1:7878").reachable).toBe(false);
    expect(at("localhost:7878").reachable).toBe(false);
    const wildcard = at("0.0.0.0:7878");
    expect(wildcard.reachable).toBe(true);
    expect(wildcard.url).toMatch(/^http:\/\/.+:7878$/);
    expect(wildcard.url).not.toContain("0.0.0.0");
  });

  it("rejects_a_ttl_out_of_range_and_says_when_core_is_not_there", async () => {
    await expect(cluster.invite(target(), { ttlMinutes: 0 })).rejects.toThrow(/--ttl/);
    await expect(cluster.invite(target(), { ttlMinutes: 20_000 })).rejects.toThrow(/--ttl/);
    core.replies.set("POST /api/cluster/invites", {
      status: 503,
      body: { error: "the cluster module is not running" },
    });
    await expect(cluster.invite(target())).rejects.toThrow(/cluster 模組沒有在執行/);
    await core.stop();
    await expect(cluster.invite(target())).rejects.toThrow(/連不上 Core 的管理 API/);
    core = new FakeCore(); // a stop() for the afterEach
    await core.start();
  });
});

describe("host join", () => {
  it("writes_the_key_and_cluster_url_without_printing_the_key", async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    await joinWith({ name: "laptop" });
    const call = core.calls_to("POST", "/api/cluster/join")[0];
    expect(call?.authorization).toBeUndefined();
    expect(call?.body).toMatchObject({
      code: "ABCD-1234",
      name: "laptop",
      platform: process.platform,
    });

    expect(JSON.parse(read("data/host/host.key"))).toEqual({ id: "h-1", key: KEY });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "data/host/host.key")).mode & 0o777).toBe(0o600);
    }
    expect(read("host.toml")).toBe(
      'name = "laptop"\n\n[cluster]\nurl = "ws://core.lan:7880/cluster-link"\n',
    );
    expect(text()).not.toContain(KEY);
    expect(text()).toContain("已加入 Core");
    expect(text()).toContain("miyoria host approve laptop");
    expect(text()).toContain("miyoria up");
  });

  it("keeps_what_host_toml_already_says_and_takes_its_name_and_state_folder", async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    write(
      "host.toml",
      '# my machine\nname = "gpu-box"\n\n[paths]\nstate = "state-here"  # kept\n\n[services.asr]\nenabled = true\n',
    );
    await joinWith();
    expect(core.calls_to("POST", "/api/cluster/join")[0]?.body).toMatchObject({ name: "gpu-box" });
    expect(existsSync(join(dir, "state-here/host.key"))).toBe(true);
    const toml = read("host.toml");
    expect(toml).toContain("# my machine");
    expect(toml).toContain('state = "state-here"  # kept');
    expect(toml).toContain("[services.asr]\nenabled = true");
    expect(toml).toContain('[cluster]\nurl = "ws://core.lan:7880/cluster-link"');
    expect(toml).toContain('name = "gpu-box"');
    expect(text()).not.toContain(KEY);
  });

  it("replaces_an_old_cluster_url_and_follows_a_new_name", async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    write("host.toml", 'name = "a"\n[cluster]\nurl = "ws://old:1/cluster-link" # old\n');
    await joinWith({ name: "b" });
    const toml = read("host.toml");
    expect(toml).toContain('name = "b"');
    expect(toml).toContain('url = "ws://core.lan:7880/cluster-link" # old');
    expect(toml).not.toContain("old:1");
  });

  it("falls_back_to_the_os_host_name", async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    await joinWith();
    const sent = core.calls_to("POST", "/api/cluster/join")[0]?.body as { name: string };
    expect(sent.name).not.toBe("");
    expect(read("host.toml")).toContain(`name = ${JSON.stringify(sent.name)}`);
  });

  it("refuses_a_second_time_without_force_and_does_not_use_the_code", async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    await joinWith({ name: "laptop" });
    const before = read("data/host/host.key");
    await expect(joinWith({ name: "laptop" })).rejects.toThrow(/--force/);
    expect(core.calls_to("POST", "/api/cluster/join")).toHaveLength(1);
    expect(read("data/host/host.key")).toBe(before);

    core.replies.set("POST /api/cluster/join", {
      status: 200,
      body: {
        host_id: "h-2",
        key: "another-key-9876543210",
        link_url: "ws://core.lan:7880/cluster-link",
      },
    });
    out.length = 0;
    await joinWith({ name: "laptop", force: true });
    expect(JSON.parse(read("data/host/host.key"))).toEqual({
      id: "h-2",
      key: "another-key-9876543210",
    });
    expect(text()).not.toContain("another-key");
  });

  it("explains_each_failure_and_writes_nothing", async () => {
    const cases: Array<[Reply, RegExp]> = [
      [{ status: 403, body: { error: "this code does not work" } }, /邀請碼不能用.*host invite/],
      [
        { status: 409, body: { error: "a host named `laptop` exists" } },
        /不接受這個名字.*exists.*--name/,
      ],
      [
        { status: 429, body: { error: "too many requests" }, headers: { "retry-after": "42" } },
        /試太多次.*42 秒/,
      ],
      [
        { status: 503, body: { error: "the cluster module is not running" } },
        /cluster 模組沒有在執行/,
      ],
      [{ status: 404, body: { error: "not found" } }, /不像 Miyoria Core/],
      [{ status: 500, body: { error: "boom" } }, /Core 回應 500:boom/],
      [{ status: 200, body: { nope: true } }, /不是 Miyoria Core 的加入結果/],
    ];
    for (const [reply, message] of cases) {
      core.replies.set("POST /api/cluster/join", reply);
      await expect(joinWith({ name: "laptop" })).rejects.toThrow(message);
      expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
      expect(existsSync(join(dir, "host.toml"))).toBe(false);
    }
  });

  it("says_so_when_core_cannot_be_reached", async () => {
    const dead = new FakeCore();
    await dead.start();
    const port = dead.port;
    await dead.stop();
    await expect(joinWith({ coreUrl: `127.0.0.1:${port}`, name: "laptop" })).rejects.toThrow(
      /連不上 http:\/\/127\.0\.0\.1:\d+.*bind/,
    );
    expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
  });

  it("needs_a_url_and_a_code_and_a_url_that_is_one", async () => {
    await expect(cluster.joinHost(target(), { code: "X" })).rejects.toThrow(/core-url/);
    await expect(cluster.joinHost(target(), { coreUrl: "http://c:1" })).rejects.toThrow(/--code/);
    await expect(joinWith({ coreUrl: "ftp://c" })).rejects.toThrow(/http/);
    expect(cluster.normalizeCoreUrl("192.168.1.10:7878/")).toBe("http://192.168.1.10:7878");
    expect(cluster.normalizeCoreUrl("https://core.example/x/y")).toBe("https://core.example");
    expect(core.calls).toEqual([]);
  });

  it("asks_a_running_hostd_to_dial_and_prints_the_link_state", { timeout: 30_000 }, async () => {
    core.replies.set("POST /api/cluster/join", JOINED);
    write("host.toml", 'name = "gpu-box"\n');
    const made: Array<{ url: string; hostId: string; key: string }> = [];
    const daemon = new Daemon({
      hostConfig: join(dir, "host.toml"),
      catalogRoot: dir,
      configPath: join(dir, "miyoria.toml"),
      miyoria: [process.execPath],
      version: "test",
      readGpu: async () => null,
      onShutdown: () => {},
      linkFactory: (_api: HostApi, options): LinkHandle => {
        made.push({ url: options.url, hostId: options.hostId, key: options.key });
        let started = false;
        return {
          get state() {
            return started ? "connected" : "stopped";
          },
          start: () => {
            started = true;
          },
          stop: async () => {
            started = false;
          },
        };
      },
    });
    daemons.push(daemon);
    await daemon.start();
    expect(made).toEqual([]);

    await joinWith();
    expect(made).toEqual([{ url: "ws://core.lan:7880/cluster-link", hostId: "h-1", key: KEY }]);
    expect(text()).toContain("hostd 與 Core 的連線:");
    expect(text()).toContain("已連上");
    expect(text()).not.toContain("miyoria up");
    expect(text()).not.toContain(KEY);
  });
});

describe("host join --local", () => {
  it("makes_the_host_through_the_admin_api_with_the_capabilities_of_enabled_services", async () => {
    descriptor("asr", ["asr"]);
    descriptor("tts", ["tts", "tts.clone"]);
    descriptor("sing", ["sing"]);
    write(
      "host.toml",
      'name = "main-pc"\n# kept\n[services.asr]\n[services.tts]\n[services.sing]\nenabled = false\n',
    );
    coreToml('[modules.cluster]\nbind = "0.0.0.0:7999"\n');
    await cluster.joinHost(target(), { local: true });
    const call = core.calls_to("POST", "/api/cluster/hosts")[0];
    expect(call?.authorization).toBe(`Bearer ${ADMIN}`);
    expect(call?.body).toEqual({ name: "main-pc", capabilities: ["asr", "tts", "tts.clone"] });
    // Marked local: `up` may approve a host made this way again when the services change.
    expect(JSON.parse(read("data/host/host.key"))).toEqual({
      id: "h-local",
      key: KEY,
      local: true,
    });
    const toml = read("host.toml");
    expect(toml).toContain("# kept");
    expect(toml).toContain('[cluster]\nurl = "ws://127.0.0.1:7999/cluster-link"');
    expect(text()).not.toContain(KEY);
    expect(text()).toContain("已核准");
    expect(text()).not.toContain("miyoria host approve");
  });

  it("uses_the_default_cluster_port_and_a_given_name", async () => {
    descriptor("asr", ["asr"]);
    write("host.toml", 'name = "main-pc"\n[services.asr]\n');
    await cluster.joinHost(target(), { local: true, name: "core-box" });
    expect(core.calls_to("POST", "/api/cluster/hosts")[0]?.body).toMatchObject({
      name: "core-box",
    });
    expect(read("host.toml")).toContain('url = "ws://127.0.0.1:7880/cluster-link"');
    expect(read("host.toml")).toContain('name = "core-box"');
  });

  it("suggests_remove_when_the_name_exists_and_needs_host_toml_and_no_code", async () => {
    descriptor("asr", ["asr"]);
    write("host.toml", 'name = "main-pc"\n[services.asr]\n');
    core.replies.set("POST /api/cluster/hosts", {
      status: 409,
      body: { error: "a host named `main-pc` exists" },
    });
    await expect(cluster.joinHost(target(), { local: true })).rejects.toThrow(
      /miyoria host remove main-pc/,
    );
    expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
    await expect(cluster.joinHost(target(), { local: true, code: "X" })).rejects.toThrow(
      /不用邀請碼/,
    );
    rmSync(join(dir, "host.toml"));
    await expect(cluster.joinHost(target(), { local: true })).rejects.toThrow(/host migrate/);
  });
});

describe("host ls", () => {
  it("lists_every_column", async () => {
    core.hosts = [
      view("main-pc", {
        capabilities: ["asr", "tts"],
        connected: true,
        connected_since: new Date(Date.now() - 3 * 60_000).toISOString(),
        last_seen_at: new Date().toISOString(),
      }),
      view("laptop", { status: "pending", platform: "darwin", version: "0.2.0" }),
      view("old", {
        status: "revoked",
        platform: null,
        version: null,
        last_seen_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    ];
    await cluster.ls(target());
    const lines = text().split("\n");
    expect(lines[0]).toMatch(/名稱\s+狀態\s+連線\s+核准的能力\s+平台\s+版本\s+最後上線/);
    expect(text()).toMatch(
      /main-pc\s+approved\s+已連線\(3 分前起\)\s+asr、tts\s+win32\s+0\.1\.0\s+0 秒前/,
    );
    expect(text()).toMatch(/laptop\s+pending\s+未連線\s+-\s+darwin\s+0\.2\.0\s+-/);
    expect(text()).toMatch(/old\s+revoked\s+未連線\s+-\s+-\s+-\s+2 天前/);
  });

  it("says_what_to_do_when_core_has_no_hosts", async () => {
    await cluster.ls(target());
    expect(text()).toContain("host invite");
  });
});

describe("host approve", () => {
  it("approves_what_a_connected_host_reports_when_none_are_named", async () => {
    core.infos.laptop = {
      name: "laptop",
      version: "0.1.0",
      platform: "win32",
      protocol: 1,
      gpu: null,
      services: [
        service("asr", ["asr"]),
        service("tts", ["tts", "tts.clone"]),
        service("sing", ["sing"], "disabled"),
        service("dup", ["asr"]),
      ],
    };
    await cluster.approve(target(), "laptop", []);
    const call = core.calls_to("POST", "/api/cluster/hosts/laptop/approve")[0];
    expect(call?.body).toEqual({ capabilities: ["asr", "tts", "tts.clone"] });
    expect(text()).toContain("已核准 laptop:asr、tts、tts.clone");
  });

  it("approves_exactly_the_named_capabilities_without_asking_the_host", async () => {
    await cluster.approve(target(), "laptop", ["sing", "sing", "asr"]);
    expect(core.calls_to("GET", "/api/cluster/hosts/laptop/info")).toEqual([]);
    expect(core.calls_to("POST", "/api/cluster/hosts/laptop/approve")[0]?.body).toEqual({
      capabilities: ["sing", "asr"],
    });
    expect(text()).toContain("已核准 laptop:sing、asr");
  });

  it("explains_that_capabilities_must_be_named_when_the_host_is_not_connected", async () => {
    await expect(cluster.approve(target(), "laptop", [])).rejects.toThrow(
      /沒有連線.*miyoria host approve laptop asr tts/,
    );
    expect(core.calls_to("POST", "/api/cluster/hosts/laptop/approve")).toEqual([]);
  });

  it("says_for_an_unknown_host_and_a_revoked_one", async () => {
    core.replies.set("GET /api/cluster/hosts/ghost/info", {
      status: 404,
      body: { error: "no host" },
    });
    await expect(cluster.approve(target(), "ghost", [])).rejects.toThrow(/沒有叫 ghost/);
    core.replies.set("POST /api/cluster/hosts/old/approve", {
      status: 409,
      body: { error: "host `old` was revoked: it has to join again" },
    });
    await expect(cluster.approve(target(), "old", ["asr"])).rejects.toThrow(/revoked/);
  });

  it("collects_what_services_provide", () => {
    expect(
      cluster.providedBy({
        services: [
          service("a", ["x", "y"]),
          service("b", ["y"], "disabled"),
          service("c", ["z"]),
        ] as never,
      }),
    ).toEqual(["x", "y", "z"]);
  });
});

describe("host remove", () => {
  beforeEach(() => {
    core.hosts = [view("laptop", { connected: true })];
  });
  const deleted = () => core.calls_to("DELETE", "/api/cluster/hosts/laptop");

  it("asks_first_and_does_nothing_on_no", async () => {
    const asked: string[] = [];
    await cluster.removeHost(target(), "laptop", {
      yes: false,
      confirm: async (m) => {
        asked.push(m);
        return false;
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("laptop");
    expect(deleted()).toEqual([]);
    expect(text()).toContain("沒有移除");
  });

  it("removes_on_yes", async () => {
    await cluster.removeHost(target(), "laptop", { yes: false, confirm: async () => true });
    expect(deleted()).toHaveLength(1);
    expect(text()).toContain("已移除 laptop");
  });

  it("removes_without_asking_on_dash_y", async () => {
    await cluster.removeHost(target(), "laptop", {
      yes: true,
      confirm: async () => {
        throw new Error("must not ask");
      },
    });
    expect(deleted()).toHaveLength(1);
  });

  it("needs_dash_y_without_a_terminal_and_names_unknown_hosts", async () => {
    await expect(
      cluster.removeHost(target(), "laptop", { yes: false, confirm: null }),
    ).rejects.toThrow(/-y/);
    await expect(
      cluster.removeHost(target(), "ghost", { yes: true, confirm: null }),
    ).rejects.toThrow(/沒有叫 ghost/);
    expect(deleted()).toEqual([]);
  });
});

describe("status --all", () => {
  function listed() {
    core.hosts = [
      view("main-pc", {
        capabilities: ["asr"],
        connected: true,
        connected_since: new Date().toISOString(),
      }),
      view("laptop", {
        status: "pending",
        last_seen_at: new Date(Date.now() - 600_000).toISOString(),
      }),
    ];
    core.infos["main-pc"] = {
      name: "main-pc",
      version: "0.1.0",
      platform: "win32",
      protocol: 1,
      gpu: null,
      services: [service("asr", ["asr"]), service("tts", ["tts"], "failed")],
    };
  }

  beforeEach(() => {
    write("host.toml", 'name = "this-pc"\n');
  });

  it("adds_every_host_with_the_services_of_the_connected_ones", async () => {
    listed();
    await host.status(target(), { hosts: cluster.hostsSection });
    const all = text();
    expect(all).toContain("這台電腦:this-pc");
    expect(all).toContain("所有電腦(Core)");
    expect(all).toMatch(/main-pc\s+approved\s+已連線/);
    expect(all).toMatch(/\n {2}服務\s+狀態\s+健康\s+埠\s+PID\s+重啟\s+自從\s+原因/);
    expect(all).toMatch(/ {2}asr\s+running\s+✓\s+8003\s+42\s+0\s+2 分前/);
    expect(all).toMatch(/ {2}tts\s+failed/);
    // a host that is not connected is one line, and its services are not asked for
    expect(all).toMatch(/laptop\s+pending\s+未連線\s+最後上線 10 分前/);
    expect(core.calls_to("GET", "/api/cluster/hosts/laptop/info")).toEqual([]);
    expect(core.calls_to("GET", "/api/cluster/hosts/main-pc/info")).toHaveLength(1);
    expect(all).toContain("core 9.9.9");
  });

  it("is_the_old_output_without_all", async () => {
    listed();
    await host.status(target());
    expect(text()).not.toContain("所有電腦");
    expect(core.calls_to("GET", "/api/cluster/hosts")).toEqual([]);
  });

  it("keeps_the_local_table_and_says_so_in_one_line_when_core_does_not_answer", async () => {
    await core.stop();
    await host.status(target(), { hosts: cluster.hostsSection });
    expect(text()).toContain("這台電腦:this-pc");
    expect(text()).toContain("core 的管理 API 沒有回應");
    expect(text()).not.toContain("所有電腦");
    core = new FakeCore();
    await core.start();
  });

  it("says_when_the_cluster_module_is_not_running_and_still_shows_core", async () => {
    core.replies.set("GET /api/cluster/hosts", { status: 503, body: { error: "not running" } });
    await host.status(target(), { hosts: cluster.hostsSection });
    expect(text()).toContain("查不到各台電腦");
    expect(text()).toContain("cluster 模組沒有在執行");
    expect(text()).toContain("core 9.9.9");
  });

  it("notes_a_connected_host_whose_services_cannot_be_read", async () => {
    listed();
    core.replies.set("GET /api/cluster/hosts/main-pc/info", {
      status: 409,
      body: { error: "host `main-pc` is not connected" },
    });
    await host.status(target(), { hosts: cluster.hostsSection });
    expect(text()).toContain("查不到服務");
    expect(text()).toContain("laptop");
  });
});
