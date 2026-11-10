// `miyoria up`: starts the stack in order (workers, core, voice node, stage), waits for each
// health check, and stops everything it started on Ctrl+C. It never kills a process it did not
// start: a port held by something else is reported, not taken over.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import { cliVersion } from "../assets.js";
import { buildChecks, type DeepDeps, type DeepInput, workerChecks } from "../stack/checks.js";
import {
  offloadUrls,
  parseBind,
  pythonPath,
  repoRoot,
  type Stack,
  stackConfig,
  startOrder,
  workerUrl,
} from "../stack/config.js";
import { isLoopback } from "../stack/roles.js";
import {
  defaultRunner,
  type PortProbe,
  probePort,
  spawnTarget,
  tailLines,
  workerBaseEnv,
} from "../stack/system.js";
import { bold, dim, fail, green, note, ok, println, red, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";

export class UpError extends Error {
  override readonly name = "UpError";
}

export interface ServiceSpec {
  /** `core`, `voice-node`, `stage` or the worker's name. */
  name: string;
  kind: "worker" | "core" | "voice-node" | "stage";
  command: string;
  args: string[];
  cwd: string;
  /** The child's whole environment. */
  env: Record<string, string | undefined>;
  logFile: string;
  /** Answers 200 when ready; without one the service counts as up after `aliveMs`. */
  health: string | null;
  /** Where to reach it, for the summary. */
  url: string | null;
  timeoutMs: number;
  /** Shown in the plan: environment variable names set for this service (never values). */
  envKeys: string[];
  port: number | null;
  host: string;
}

export interface ServiceHandle {
  pid: number | undefined;
  /** `null` while running. */
  exitCode(): number | null;
  stop(): Promise<void>;
}

export type SpawnService = (spec: ServiceSpec) => ServiceHandle;

export interface UpDeps {
  spawnService: SpawnService;
  fetchImpl: typeof fetch;
  probe: PortProbe;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readLog: (path: string) => string;
  /** Resolves when the stack should stop (Ctrl+C, or the core exited). */
  waitForStop: (handles: Array<{ spec: ServiceSpec; handle: ServiceHandle }>) => Promise<void>;
  deep: DeepDeps;
  /** How long a service without a health URL must stay alive. */
  aliveMs: number;
  pollMs: number;
}

export interface UpOptions {
  only?: string[];
  skip?: string[];
  dryRun?: boolean;
  timeoutSecs?: number;
  /** Skip the checks of the worker and build setup before starting. */
  noCheck?: boolean;
}

// ---- plan --------------------------------------------------------------------------------

export interface PlanInput {
  config: Config;
  configPath: string;
  stack: Stack;
  root: string | null;
  nodeExec?: { execPath: string; execArgv: string[]; script: string };
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

function apiHealth(config: Config): { url: string; host: string; port: number } | null {
  const section = config.module("api");
  if (!section.enabled) return null;
  const bind =
    isJsonObject(section.config) && typeof section.config.bind === "string"
      ? section.config.bind
      : "127.0.0.1:7878";
  const parsed = parseBind(bind);
  if (!parsed) return null;
  const host = parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host;
  return { url: `http://${host}:${parsed.port}`, host: parsed.host, port: parsed.port };
}

function stageOverlayBind(config: Config): string {
  const stage = config.section("stage");
  return isJsonObject(stage) && typeof stage.overlay_bind === "string"
    ? stage.overlay_bind
    : "127.0.0.1:7884";
}

/** Core's Voice Link address for the voice node, only when `[machine.hosts]` puts core elsewhere. */
function voiceLinkUrl(config: Config, stack: Stack): string | null {
  const host = stack.machine?.hosts.core;
  if (host === undefined || isLoopback(host)) return null;
  const modules = config.section("modules");
  const link = isJsonObject(modules) ? modules["voice.link"] : undefined;
  const bind = isJsonObject(link) && typeof link.bind === "string" ? link.bind : "127.0.0.1:7879";
  const port = parseBind(bind)?.port ?? 7879;
  return `ws://${host}:${port}/voice-link`;
}

/** What `up` would start, in order. No side effects. */
export function buildPlan(input: PlanInput): ServiceSpec[] {
  const { config, configPath, stack, root } = input;
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const logs = join(dirname(resolve(configPath)), "data", "stack", "logs");
  const exec = input.nodeExec ?? {
    execPath: process.execPath,
    execArgv: process.execArgv,
    script: process.argv[1] ?? "",
  };
  const specs: ServiceSpec[] = [];

  if (stack.workers.length > 0 && root === null) {
    throw new UpError(
      "[stack.workers] 要在 Miyoria 的原始碼資料夾裡用(找不到 workers/ 和 pnpm-workspace.yaml)",
    );
  }
  for (const w of startOrder(stack.workers)) {
    const workerEnv: Record<string, string> = {
      ...workerBaseEnv(env),
      HOST: w.host,
      PORT: String(w.port),
    };
    const urls = offloadUrls(w, stack.workers);
    if (urls !== "") workerEnv.SING_OFFLOAD_URLS = urls;
    const base = root as string;
    // The voices folder is relative to the repo, not to wherever the worker's working directory is.
    if (w.name === "tts" && stack.machine !== null) {
      workerEnv.VOICES_DIR = join(base, "workers", "voices");
    }
    Object.assign(workerEnv, w.env);
    specs.push({
      name: w.name,
      kind: "worker",
      command: pythonPath(join(base, w.venv), platform),
      args: [w.entry],
      cwd: join(base, "workers", w.dir),
      env: workerEnv,
      logFile: join(logs, `${w.name}.log`),
      health: `${workerUrl(w)}/health`,
      url: workerUrl(w),
      timeoutMs: (w.startTimeoutSecs ?? stack.startTimeoutSecs) * 1000,
      envKeys: Object.keys(workerEnv).filter(
        (k) =>
          k in w.env ||
          k === "SING_OFFLOAD_URLS" ||
          k === "PORT" ||
          k === "VOICES_DIR" ||
          k === "HOST",
      ),
      port: w.port,
      host: w.host,
    });
  }

  const self = (sub: string) => ({
    command: exec.execPath,
    args: [...exec.execArgv, exec.script, sub, "-c", configPath],
  });
  if (stack.core) {
    const api = apiHealth(config);
    specs.push({
      name: "core",
      kind: "core",
      ...self("core"),
      cwd: dirname(resolve(configPath)),
      env: { ...env },
      logFile: join(logs, "core.log"),
      health: api ? `${api.url}/api/health` : null,
      url: api ? `${api.url}/` : null,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: [],
      port: api?.port ?? null,
      host: api?.host ?? "127.0.0.1",
    });
  }
  if (stack.voiceNode) {
    if (root === null) throw new UpError("voice node 要在原始碼資料夾裡用(apps/voice-node)");
    // The node reads VOICE_LINK_URL from its own environment; when core is on another computer
    // the address comes from `[machine.hosts]` (the node's .env still holds the token).
    const link = voiceLinkUrl(config, stack);
    specs.push({
      name: "voice-node",
      kind: "voice-node",
      command: "pnpm",
      args: ["start"],
      cwd: join(root, "apps", "voice-node"),
      env: link ? { ...env, VOICE_LINK_URL: link } : { ...env },
      logFile: join(logs, "voice-node.log"),
      health: null,
      url: null,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: link ? ["VOICE_LINK_URL"] : [],
      port: null,
      host: "127.0.0.1",
    });
  }
  if (stack.stage) {
    const overlay = parseBind(stageOverlayBind(config)) ?? { host: "127.0.0.1", port: 7884 };
    specs.push({
      name: "stage",
      kind: "stage",
      ...self("stage"),
      cwd: dirname(resolve(configPath)),
      env: { ...env },
      logFile: join(logs, "stage.log"),
      health: null,
      url: `http://${overlay.host === "0.0.0.0" ? "127.0.0.1" : overlay.host}:${overlay.port}/overlay/`,
      timeoutMs: stack.startTimeoutSecs * 1000,
      envKeys: [],
      port: overlay.port,
      host: overlay.host,
    });
  }
  return specs;
}

export function selectServices(
  plan: readonly ServiceSpec[],
  only: readonly string[] | undefined,
  skip: readonly string[] | undefined,
): ServiceSpec[] {
  const names = new Set(plan.map((s) => s.name));
  for (const n of [...(only ?? []), ...(skip ?? [])]) {
    if (!names.has(n)) {
      throw new UpError(
        `沒有叫 \`${n}\` 的服務;可用:${[...names].join("、") || "(沒有設定任何服務)"}`,
      );
    }
  }
  return plan.filter(
    (s) => (only === undefined || only.includes(s.name)) && !(skip ?? []).includes(s.name),
  );
}

// ---- start -------------------------------------------------------------------------------

const PORT_FIX = [
  "Windows 保留了這個埠(動態埠範圍從 1024 開始時常見):用系統管理員 PowerShell 執行 net stop winnat 再 net start winnat",
  "`miyoria doctor --deep` 會列出保留範圍和長期做法;Miyoria 不會替你改系統設定",
];

async function waitReady(
  spec: ServiceSpec,
  handle: ServiceHandle,
  deps: UpDeps,
): Promise<"ready" | "exited" | "timeout"> {
  const started = deps.now();
  while (deps.now() - started < spec.timeoutMs) {
    if (handle.exitCode() !== null) return "exited";
    if (spec.health === null) {
      if (deps.now() - started >= deps.aliveMs) return "ready";
    } else {
      try {
        const res = await deps.fetchImpl(spec.health, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return "ready";
      } catch {
        // not listening yet
      }
    }
    await deps.sleep(deps.pollMs);
  }
  return "timeout";
}

export interface Started {
  spec: ServiceSpec;
  handle: ServiceHandle;
}

/** Starts the services in order; on a failure stops the ones already started and throws. */
export async function startStack(specs: readonly ServiceSpec[], deps: UpDeps): Promise<Started[]> {
  const started: Started[] = [];
  const stopAll = async () => {
    for (const s of [...started].reverse()) await s.handle.stop();
  };
  try {
    for (const spec of specs) {
      const t0 = deps.now();
      if (spec.health !== null) {
        try {
          const res = await deps.fetchImpl(spec.health, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            ok(`${spec.name}  已在執行,沿用 ${spec.url ?? spec.health}`);
            continue;
          }
        } catch {
          // not running: start it
        }
      }
      if (spec.port !== null) {
        const state = await deps.probe(spec.port, spec.host);
        if (state === "denied") {
          throw new UpError(
            `${spec.name}:埠 ${spec.port} 被 Windows 保留,綁不上\n${PORT_FIX.map((l) => `    修正:${l}`).join("\n")}`,
          );
        }
        if (state === "in-use") {
          throw new UpError(
            `${spec.name}:埠 ${spec.port} 已被別的程式佔用,而且那不是健康的 ${spec.name}\n    修正:netstat -ano | findstr :${spec.port} 找出 PID;確認是舊的行程後自己關掉,\`up\` 不會替你結束別人的程式`,
          );
        }
      }
      note(`啟動 ${spec.name}${spec.port ? `(port ${spec.port})` : ""},日誌 ${spec.logFile}`);
      const handle = deps.spawnService(spec);
      started.push({ spec, handle });
      const result = await waitReady(spec, handle, deps);
      const secs = ((deps.now() - t0) / 1000).toFixed(1);
      if (result === "ready") {
        ok(`${spec.name}  ${spec.url ?? "執行中"}  ${dim(`${secs} s`)}`);
        continue;
      }
      const tail = spec.kind === "worker" ? tailLines(safeRead(deps, spec.logFile), 12) : [];
      const why =
        result === "exited"
          ? `${spec.name} 啟動後結束了(代碼 ${handle.exitCode()})`
          : `${spec.name} 在 ${Math.round(spec.timeoutMs / 1000)} 秒內沒有通過健康檢查(${spec.health})`;
      throw new UpError(
        [why, `    日誌:${spec.logFile}`, ...tail.map((l) => dim(`    | ${l}`))].join("\n"),
      );
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  return started;
}

function safeRead(deps: UpDeps, path: string): string {
  try {
    return deps.readLog(path);
  } catch {
    return "";
  }
}

// ---- command -----------------------------------------------------------------------------

function printPlan(specs: readonly ServiceSpec[]): void {
  section("啟動順序(dry-run,不會啟動任何東西)");
  specs.forEach((s, i) => {
    println(`${i + 1}. ${bold(s.name)}  ${s.command} ${s.args.join(" ")}`);
    println(dim(`     工作目錄 ${s.cwd}`));
    if (s.envKeys.length > 0) println(dim(`     設定的環境變數 ${s.envKeys.join(", ")}(值不顯示)`));
    println(dim(`     日誌 ${s.logFile}${s.health ? `;健康檢查 ${s.health}` : ""}`));
  });
}

export async function run(
  configPath: string,
  options: UpOptions = {},
  deps: UpDeps = defaultUpDeps(),
): Promise<void> {
  const config = await loadConfig(configPath);
  const stack = stackConfig(config);
  const root = repoRoot(configPath);
  const plan = selectServices(
    buildPlan({ config, configPath, stack, root }),
    options.only,
    options.skip,
  );
  if (options.timeoutSecs !== undefined) {
    for (const s of plan) s.timeoutMs = options.timeoutSecs * 1000;
  }
  if (plan.length === 0) {
    warn("沒有要啟動的服務:[stack] 預設只啟動 core;worker 要在 [stack.workers] 設定");
    return;
  }
  if (options.dryRun) {
    printPlan(plan);
    return;
  }

  if (!options.noCheck) {
    const input: DeepInput = {
      config,
      configDir: dirname(resolve(configPath)),
      root,
      stack,
      deps: deps.deep,
    };
    const blocking = workerChecks(input).filter((f) => f.level === "fail");
    for (const f of blocking) {
      fail(`${f.what}  ${f.detail}`);
      for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
    }
    if (blocking.length > 0)
      throw new UpError(`${blocking.length} 項設定問題,先修正再啟動(--no-check 可略過)`);
    for (const f of await buildChecks(input)) {
      if (f.level === "ok") continue;
      warn(`${f.what}  ${f.detail}`);
      for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
    }
  }

  section(`啟動 ${plan.map((s) => s.name).join(" → ")}`);
  const started = await startStack(plan, deps);
  if (started.length === 0) return;
  println(`\n${green("全部就緒")}。Ctrl+C 會依相反順序停止這次啟動的服務。`);
  await deps.waitForStop(started);
  section("停止服務");
  for (const s of [...started].reverse()) {
    await s.handle.stop();
    println(`${red("■")} ${s.spec.name}`);
  }
}

// ---- real process handling ---------------------------------------------------------------

function realSpawn(spec: ServiceSpec): ServiceHandle {
  mkdirSync(dirname(spec.logFile), { recursive: true });
  const fd = openSync(spec.logFile, "a");
  writeSync(fd, `\n--- ${new Date().toISOString()} ${spec.name} ---\n`);
  let child: ChildProcess;
  try {
    const target = spawnTarget(spec.command, spec.args);
    child = spawn(target.command, target.args, {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ["ignore", fd, fd],
      shell: target.shell,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  let code: number | null = null;
  let exited = false;
  child.on("error", () => {
    exited = true;
    code = -1;
  });
  child.on("exit", (c) => {
    exited = true;
    code = c ?? -1;
  });
  return {
    pid: child.pid,
    exitCode: () => (exited ? code : null),
    stop: async () => {
      if (exited || child.pid === undefined) return;
      if (process.platform === "win32") {
        // The tree: a worker started through a shell has children of its own.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 3000));
        if (!exited) child.kill("SIGKILL");
      }
    },
  };
}

function waitForSignal(handles: Started[]): Promise<void> {
  return new Promise((resolveStop) => {
    const finish = () => {
      clearInterval(timer);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveStop();
    };
    const timer = setInterval(() => {
      const core = handles.find((h) => h.spec.kind === "core");
      if (core && core.handle.exitCode() !== null) {
        fail(`core 結束了(代碼 ${core.handle.exitCode()}),日誌 ${core.spec.logFile}`);
        finish();
        return;
      }
      for (const h of handles) {
        if (h.spec.kind !== "core" && h.handle.exitCode() !== null && !reported.has(h.spec.name)) {
          reported.add(h.spec.name);
          warn(`${h.spec.name} 結束了(代碼 ${h.handle.exitCode()}),日誌 ${h.spec.logFile}`);
        }
      }
    }, 2000);
    const reported = new Set<string>();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export function defaultUpDeps(): UpDeps {
  return {
    spawnService: realSpawn,
    fetchImpl: fetch,
    probe: probePort,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    readLog: (path) => readFileSync(path, "utf8"),
    waitForStop: waitForSignal,
    deep: {
      platform: process.platform,
      run: defaultRunner,
      probe: probePort,
      fetchImpl: fetch,
      env: process.env,
      tmpdir: tmpdir(),
      version: cliVersion(),
    },
    aliveMs: 4000,
    pollMs: 1000,
  };
}
