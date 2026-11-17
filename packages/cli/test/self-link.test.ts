// `miyoria up` on the machine Core runs on: once `core` answers, this machine links itself (the
// code of `host join --local`), approves itself again when its services change, and never touches
// a host that joined with a code. Against a fake Core (the admin API's cluster routes) and a
// daemon in this process whose `core` is a small HTTP server.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, loadHostConfig } from "@miyoria/hostd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli.js";
import * as cluster from "../src/commands/cluster.js";
import * as host from "../src/commands/host.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const ADMIN = "admin-token";
const KEY = "local-host-key-0123456789";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** The cluster routes `self-link` uses. */
class FakeCore {
  readonly calls: Call[] = [];
  /** Hosts Core holds, as the `hosts` route returns them. */
  hosts: Array<Record<string, unknown>> = [];
  /** Answers instead of the route (a status and body). */
  fail: { status: number; body: unknown } | null = null;
  port = 0;
  readonly #server: Server;

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

  of(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] as string;
    this.calls.push({ method, path, body: raw === "" ? undefined : JSON.parse(raw) });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${ADMIN}`) return send(401, { error: "no" });
    if (this.fail !== null) return send(this.fail.status, this.fail.body);
    const body = this.calls.at(-1)?.body;
    if (method === "GET" && path === "/api/health") return send(200, { status: "ok" });
    if (method === "GET" && path === "/api/cluster/hosts") return send(200, this.hosts);
    if (method === "POST" && path === "/api/cluster/hosts") {
      const name = String(body?.name);
      if (this.hosts.some((h) => h.name === name)) return send(409, { error: "name taken" });
      const capabilities = body?.capabilities ?? [];
      this.hosts.push(view("h-1", name, "approved", capabilities as string[]));
      return send(200, { id: "h-1", name, key: KEY });
    }
    const approve = /^\/api\/cluster\/hosts\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approve !== null) {
      const name = decodeURIComponent(approve[1] as string);
      const found = this.hosts.find((h) => h.name === name);
      if (found === undefined) return send(404, { error: "no such host" });
      found.status = "approved";
      found.capabilities = body?.capabilities ?? [];
      return send(200, found);
    }
    return send(404, { error: `no route ${method} ${path}` });
  }
}

function view(
  id: string,
  name: string,
  status: string,
  capabilities: string[],
): Record<string, unknown> {
  return {
    id,
    name,
    status,
    capabilities,
    platform: "win32",
    version: "0.1.0",
    created_at: "2026-11-01T00:00:00.000Z",
    last_seen_at: null,
    connected: false,
    connected_since: null,
  };
}

const SERVER = `
const http = require("node:http");
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); })
  .listen(Number(process.env.PORT), "127.0.0.1");
`;

let dir: string;
let out: string[];
let restore: () => void;
let core: FakeCore;
const daemons: Daemon[] = [];

beforeEach(async () => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "self-link-"));
  // A checkout of its own, so nothing above it is taken for the source folder.
  write("pnpm-workspace.yaml", "packages: []\n");
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) } satisfies Output);
  core = new FakeCore();
  await core.start();
  coreToml();
  for (const [name, provides] of [
    ["core", "core"],
    ["asr", "asr"],
  ] as const) {
    write(`workers/${name}/server.cjs`, SERVER);
    write(
      `workers/${name}/service.toml`,
      `name = "${name}"\nkind = "worker"\nprovides = ["${provides}"]\n[run]\ncommand = ["{node}", "{service}/server.cjs"]\nport = "auto"\nport_env = "PORT"\n[run.health]\nhttp = "/"\nstartup_s = 15\n[run.stop]\ngrace_s = 1\n`,
    );
  }
  write("host.toml", 'name = "test-pc"\n[services.core]\nenabled = true\n');
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

const read = (path: string) => readFileSync(join(dir, path), "utf8");

/** `miyoria.toml` pointing at the fake Core, the admin token included unless `token` is false. */
function coreToml(options: { token?: boolean; bind?: string } = {}): void {
  const token = options.token === false ? "" : `token = "${ADMIN}"\n`;
  write(
    "miyoria.toml",
    `[modules.api]\nbind = "${options.bind ?? `127.0.0.1:${core.port}`}"\n${token}\n[modules.cluster]\nbind = "127.0.0.1:47880"\n`,
  );
}

const target = (): host.HostTarget => host.hostTarget(join(dir, "miyoria.toml"));
const loaded = () => loadHostConfig(target().hostToml);
const text = () => out.join("");
const linkLines = () => out.filter((l) => /本機的 Core|自動連上|重新核准/.test(l));

async function startDaemon(): Promise<Daemon> {
  const t = target();
  const daemon = new Daemon({
    hostConfig: t.hostToml,
    catalogRoot: dir,
    configPath: t.configPath,
    miyoria: [process.execPath],
    version: "test",
    readGpu: async () => null,
    timing: { pollMs: 100 },
    onShutdown: () => {},
  });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

const withLink = (): host.UpOptions => ({
  services: [],
  selfLink: (h) => cluster.selfLink(target(), h),
});

describe("up links this machine to its own Core", () => {
  it("links the first time: creates the host, writes host.key and [cluster], one line", async () => {
    await startDaemon();
    await host.up(target(), withLink());

    const created = core.of("POST", "/api/cluster/hosts");
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toEqual({ name: "test-pc", capabilities: ["core"] });
    expect(JSON.parse(read("data/host/host.key"))).toEqual({ id: "h-1", key: KEY, local: true });
    expect(loaded().config.cluster?.url).toBe("ws://127.0.0.1:47880/cluster-link");
    expect(linkLines()).toHaveLength(1);
    expect(linkLines()[0]).toContain("這台電腦已連上本機的 Core(名字 test-pc,核准:core)");
    expect(text()).toContain("全部就緒");
  }, 30_000);

  it("does nothing the second time", async () => {
    await startDaemon();
    await host.up(target(), withLink());
    out.length = 0;
    core.calls.length = 0;
    await host.up(target(), withLink());
    expect(core.of("POST", "/api/cluster/hosts")).toHaveLength(0);
    expect(core.of("POST", "/api/cluster/hosts/test-pc/approve")).toHaveLength(0);
    expect(linkLines()).toHaveLength(0);
  }, 30_000);

  it("approves again when the services change, only for a host it made itself", async () => {
    await startDaemon();
    await host.up(target(), withLink());
    out.length = 0;
    write("host.toml", `${read("host.toml")}\n[services.asr]\nenabled = true\n`);
    await cluster.selfLink(target(), loaded());
    const approved = core.of("POST", "/api/cluster/hosts/test-pc/approve");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.body).toEqual({ capabilities: ["asr", "core"] });
    expect(linkLines()).toHaveLength(1);
    expect(linkLines()[0]).toContain("已重新核准這台電腦(test-pc):asr、core");
  }, 30_000);

  it("never touches a host that joined with a code", async () => {
    write("data/host/host.key", JSON.stringify({ id: "h-9", key: "k" }));
    core.hosts = [view("h-9", "test-pc", "approved", ["core"])];
    write("host.toml", `${read("host.toml")}\n[services.asr]\nenabled = true\n`);
    await cluster.selfLink(target(), loaded());
    expect(core.calls).toEqual([]);
    expect(out).toEqual([]);
  });

  it("leaves a machine alone that has a [cluster] url and no key", async () => {
    write(
      "host.toml",
      `${read("host.toml")}\n[cluster]\nurl = "ws://elsewhere:7880/cluster-link"\n`,
    );
    await cluster.selfLink(target(), loaded());
    expect(core.calls).toEqual([]);
    expect(out).toEqual([]);
    expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
  });

  it("says so, once, when its host is gone from Core or was revoked", async () => {
    write("data/host/host.key", JSON.stringify({ id: "h-1", key: "k", local: true }));
    await cluster.selfLink(target(), loaded());
    expect(out.join("")).toContain("Core 裡沒有這台電腦了");
    expect(out).toHaveLength(1);

    out.length = 0;
    core.hosts = [view("h-1", "test-pc", "revoked", [])];
    await cluster.selfLink(target(), loaded());
    expect(out.join("")).toContain("被撤銷了,沒有自動核准");
    expect(core.of("POST", "/api/cluster/hosts/test-pc/approve")).toHaveLength(0);
  });
});

describe("a problem is one line and `up` goes on", () => {
  async function oneLine(expected: RegExp): Promise<void> {
    await startDaemon();
    await expect(host.up(target(), withLink())).resolves.toBeUndefined();
    const lines = linkLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(expected);
    expect(text()).toContain("全部就緒");
    expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
  }

  it("no admin token configured", async () => {
    coreToml({ token: false });
    await oneLine(/這台沒有自動連上本機的 Core:.*token/i);
  }, 30_000);

  it("the cluster module is off", async () => {
    core.fail = { status: 503, body: { error: "off" } };
    await oneLine(/cluster 模組沒有在執行/);
  }, 30_000);

  it("the admin API refuses the token", async () => {
    coreToml({ bind: `127.0.0.1:${core.port}` });
    write("miyoria.toml", `[modules.api]\nbind = "127.0.0.1:${core.port}"\ntoken = "wrong"\n`);
    await oneLine(/不接受這個 token/);
  }, 30_000);

  it("Core's name is taken", async () => {
    core.hosts = [view("h-5", "test-pc", "approved", [])];
    await oneLine(/已經有叫 test-pc 的電腦/);
  }, 30_000);

  it("there is no miyoria.toml", async () => {
    rmSync(join(dir, "miyoria.toml"));
    await oneLine(/這台沒有自動連上本機的 Core:/);
  }, 30_000);
});

describe("when up links", () => {
  it("does not link with --no-link, and parses the flag", async () => {
    expect(parseArgs(["up", "--no-link"]).ctx.options["no-link"]).toBe(true);
    expect(parseArgs(["up"]).ctx.options["no-link"]).toBeUndefined();
    await startDaemon();
    await host.up(target(), { services: [] }); // what `--no-link` passes: no selfLink
    expect(core.calls).toEqual([]);
    expect(existsSync(join(dir, "data/host/host.key"))).toBe(false);
  }, 30_000);

  it("only after core answers, and only when core is among the services started", async () => {
    await startDaemon();
    const selfLink = vi.fn(async () => {});
    // asr is not in host.toml: the start fails and nothing links.
    await expect(host.up(target(), { services: ["asr"], selfLink })).rejects.toThrow(/沒有起來/);
    expect(selfLink).not.toHaveBeenCalled();
    await host.up(target(), { services: ["core"], selfLink });
    expect(selfLink).toHaveBeenCalledTimes(1);
  }, 30_000);
});
