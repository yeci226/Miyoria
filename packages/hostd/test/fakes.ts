// Fake services for the daemon tests: tiny Node scripts written into a temporary workspace, with
// a `service.toml` each. Every process a test starts is stopped in `cleanup()`, also when an
// assertion failed; the grandchildren the scripts report are killed there as a last resort.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, type DaemonOptions, pidAlive } from "../src/index.js";

export const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");

/** Serves `/health` (and `/env`, `/argv`) on `PORT`; logs to stdout and stderr. */
const HEALTH = `
const http = require("node:http");
const fs = require("node:fs");
const name = process.env.FAKE_NAME || "fake";
if (process.env.ORDER_FILE) fs.appendFileSync(process.env.ORDER_FILE, name + " spawn " + Date.now() + "\\n");
if (process.env.IGNORE_TERM) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
const status = process.env.HEALTH_STATUS || "ok";
const server = http.createServer((req, res) => {
  const send = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/health" || req.url === "/api/health") return send({ status, ...JSON.parse(process.env.HEALTH_EXTRA || "{}") });
  if (req.url === "/env") return send(process.env);
  if (req.url === "/argv") return send({ argv: process.argv, execArgv: process.execArgv });
  if (req.url === "/api/public/status") return send({ state: process.env.CORE_STATE || "idle", live: process.env.CORE_LIVE === "1" });
  res.writeHead(404); res.end();
});
setTimeout(() => {
  server.listen(Number(process.env.PORT), process.env.HOST || "127.0.0.1", () => {
    if (process.env.ORDER_FILE) fs.appendFileSync(process.env.ORDER_FILE, name + " ready " + Date.now() + "\\n");
    console.log(name + " listening on " + process.env.PORT);
    console.error(name + " says hello on stderr");
  });
}, Number(process.env.DELAY_MS || 0));
`;

/** Exits at once with code 3. */
const EXIT = `
console.log("bye from exit.cjs");
process.exit(3);
`;

/** Lives, never listens. */
const NEVER = `
console.log("never healthy");
setInterval(() => {}, 1000);
`;

/** Starts a child that waits, writes the child's pid to PID_FILE, then waits too. */
const SPAWNER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.PID_FILE, String(child.pid));
console.log("spawned child " + child.pid);
if (process.env.IGNORE_TERM) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
setInterval(() => {}, 1000);
`;

/**
 * A speech service of the GPU peer protocol (docs/design/v5-gpu.md §8): `/offload`, `/reload`,
 * `/busy`, `/health`, each requiring the service's own token. Every offload and reload is kept,
 * with its body and whether the token was right, and served on `/calls` (no token needed).
 * `BUSY` is what `/busy` answers.
 */
const SPEECH = `
const http = require("node:http");
const token = process.env.MIYORIA_SERVICE_TOKEN;
const calls = [];
let offloaded = false;
let reason = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const auth = token !== undefined && req.headers.authorization === "Bearer " + token;
    if (req.url === "/calls") return send(200, calls);
    if (req.url === "/env") return send(200, process.env);
    if (req.method === "POST") calls.push({ path: req.url, body: body === "" ? null : JSON.parse(body), auth, at: Date.now() });
    if (!auth) return send(401, { error: "unauthorized" });
    if (req.url === "/health") return send(200, { status: "ok", offloaded, loading: false, released_mb: null, ...(offloaded ? { reason } : {}) });
    if (req.url === "/busy") return send(200, { busy: Number(process.env.BUSY || 0) });
    if (req.method === "POST" && req.url === "/offload") {
      offloaded = true;
      reason = JSON.parse(body || "{}").reason ?? null;
      return send(200, { state: "offloaded", offload_ms: 5, released_mb: 1000 });
    }
    if (req.method === "POST" && req.url === "/reload") {
      offloaded = false;
      reason = null;
      return send(200, { state: "ready", reload_ms: 5 });
    }
    send(404, { error: "not found" });
  });
});
server.listen(Number(process.env.PORT), process.env.HOST || "127.0.0.1", () => console.log("speech on " + process.env.PORT));
`;

export const SCRIPTS = {
  "health.cjs": HEALTH,
  "speech.cjs": SPEECH,
  "exit.cjs": EXIT,
  "never.cjs": NEVER,
  "spawner.cjs": SPAWNER,
} as const;

export interface FakeService {
  name: string;
  /** TOML lines of the descriptor after `kind`. */
  toml: string;
  /** `[services.<name>]` lines of host.toml. */
  host?: string;
  folder?: string;
}

/** A descriptor that runs one of the scripts with `{node}`. */
export function fake(
  name: string,
  script: keyof typeof SCRIPTS,
  extra: {
    port?: number | "auto" | null;
    health?: string;
    run?: string;
    env?: Record<string, string>;
    tables?: string;
    host?: string;
    command?: string[];
  } = {},
): FakeService {
  const port =
    extra.port === undefined ? '"auto"' : extra.port === null ? null : JSON.stringify(extra.port);
  const env = { FAKE_NAME: name, ...extra.env };
  const command = extra.command ?? ["{node}", `{service}/${script}`];
  return {
    name,
    host: extra.host,
    toml: [
      `provides = ["${name}"]`,
      "[run]",
      `command = ${JSON.stringify(command)}`,
      ...(port !== null ? [`port = ${port}`, 'host_env = "HOST"', 'port_env = "PORT"'] : []),
      `env = { ${Object.entries(env)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join(", ")} }`,
      extra.run ?? "",
      "[run.health]",
      extra.health ??
        (port !== null ? 'http = "/health"\nstartup_s = 15\ninterval_s = 0.3' : "process = true"),
      "[run.stop]",
      "grace_s = 1",
      "[run.restart]",
      "backoff_s = [0.2]",
      extra.tables ?? "",
    ].join("\n"),
  };
}

export interface TestWorkspace {
  root: string;
  hostToml: string;
  state: string;
  file(path: string): string;
  read(path: string): string;
}

const made: string[] = [];
const daemons: Daemon[] = [];
const pidFiles: string[] = [];

/** A workspace with the fakes under `workers/<name>/` and a host.toml listing them. */
export function workspace(services: FakeService[], hostExtra = ""): TestWorkspace {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, "ws-"));
  made.push(root);
  const write = (path: string, text: string) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return full;
  };
  for (const s of services) {
    const folder = s.folder ?? `workers/${s.name}`;
    write(`${folder}/service.toml`, `name = "${s.name}"\nkind = "worker"\n${s.toml}\n`);
    for (const [file, text] of Object.entries(SCRIPTS)) write(`${folder}/${file}`, text);
  }
  const host = [
    'name = "test-host"',
    hostExtra,
    ...services.map((s) => `[services.${s.name}]\nenabled = true\n${s.host ?? ""}`),
  ].join("\n");
  const hostToml = write("host.toml", `${host}\n`);
  return {
    root,
    hostToml,
    state: join(root, "data", "host"),
    file: (path) => join(root, path),
    read: (path) => readFileSync(join(root, path), "utf8"),
  };
}

/** Writes a file into a workspace. */
export function writeIn(ws: TestWorkspace, path: string, text: string, mode?: number): string {
  const full = ws.file(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  if (mode !== undefined) chmodSync(full, mode);
  return full;
}

/** A file whose content is a pid this test caused; killed in `cleanup` if still alive. */
export function trackPidFile(file: string): void {
  pidFiles.push(file);
}

export function daemonFor(ws: TestWorkspace, options: Partial<DaemonOptions> = {}): Daemon {
  const daemon = new Daemon({
    hostConfig: ws.hostToml,
    catalogRoot: ws.root,
    configPath: join(ws.root, "miyoria.toml"),
    miyoria: [process.execPath],
    version: "test",
    readGpu: async () => null,
    timing: { pollMs: 100, processSettleMs: 300, externalMs: 200 },
    onShutdown: () => {},
    ...options,
  });
  daemons.push(daemon);
  return daemon;
}

export async function cleanup(): Promise<void> {
  for (const daemon of daemons.splice(0)) {
    try {
      await daemon.stop();
    } catch {
      // keep cleaning
    }
  }
  for (const file of pidFiles.splice(0)) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Polls `check` until it returns a value that is not `undefined`/`false`. */
export async function until<T>(
  check: () => T | Promise<T>,
  timeoutMs = 15_000,
  what = "condition",
): Promise<Exclude<T, false | undefined | null>> {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await check();
    if (last !== undefined && last !== false && last !== null) {
      return last as Exclude<T, false | undefined | null>;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
