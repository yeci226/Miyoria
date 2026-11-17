// `miyoria hostd | up | down | restart | status | logs`: this machine's services, through its hostd
// (docs/design/v5-hostd.md §10). `up` starts the daemon in the background when none answers;
// `up --foreground` and `hostd` run it in this terminal. Everything else only talks to it.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostGpuArbiterStatus,
  type HostInfo,
  type HostLinkState,
  type HostServiceControlResult,
  type HostServiceEvent,
  type HostServiceList,
  type HostServiceState,
  type HostServiceStatus,
  type HostShutdownResult,
} from "@miyoria/contracts/host";
import {
  Daemon,
  fileTail,
  HOST_CONFIG_FILE,
  HostdClient,
  HostdRunningError,
  HostRpcError,
  type LoadedHostConfig,
  loadHostConfig,
} from "@miyoria/hostd";
import { cliVersion, PACKAGE_ROOT } from "../assets.js";
import { repoRoot } from "../stack/config.js";
import { bold, dim, fail, green, note, ok, println, red, section, warn, yellow } from "../ui.js";
import { loadConfig } from "./node.js";
import * as remote from "./remote.js";

export class HostCommandError extends Error {
  override readonly name = "HostCommandError";
}

/** The Core config and the `host.toml` a command works on, both absolute. */
export interface HostTarget {
  configPath: string;
  hostToml: string;
}

/** `--host-config`, else `host.toml` in the config file's folder. */
export function hostTarget(configPath: string, hostConfig?: string): HostTarget {
  const config = resolve(configPath);
  return {
    configPath: config,
    hostToml: resolve(hostConfig ?? join(dirname(config), HOST_CONFIG_FILE)),
  };
}

/**
 * Where the descriptors are: the source checkout around the workspace, else the one around this
 * CLI, else the installed package, which carries the catalog at the same relative paths
 * (`workers/*`, `services/*`, `packages/core` ...; scripts/build.mjs copies them).
 */
export function catalogRoot(hostToml: string, packageRoot: string = PACKAGE_ROOT): string {
  return repoRoot(hostToml) ?? repoRoot(join(packageRoot, "package.json")) ?? packageRoot;
}

/**
 * How this CLI was started (`{miyoria}`): `node dist/main.js` when installed, `node <tsx flags>
 * src/main.ts` from source.
 */
export function selfCommand(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? ""];
}

export function loadHost(target: HostTarget): LoadedHostConfig {
  if (!existsSync(target.hostToml)) {
    throw new HostCommandError(
      `找不到 ${target.hostToml}:用 \`miyoria host migrate\` 從 miyoria.toml 的 [machine] 和 [stack] 轉出一份`,
    );
  }
  return loadHostConfig(target.hostToml);
}

function daemonFor(target: HostTarget, onShutdown?: () => void): Daemon {
  return new Daemon({
    hostConfig: target.hostToml,
    catalogRoot: catalogRoot(target.hostToml),
    configPath: target.configPath,
    miyoria: selfCommand(),
    version: cliVersion(),
    ...(onShutdown !== undefined ? { onShutdown } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolves on Ctrl+C or a termination request. */
function untilSignal(extra?: (stop: () => void) => void): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      done();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    extra?.(finish);
  });
}

// ---- output ------------------------------------------------------------------------------

const TAIL_LINES = 12;

function printTail(lines: readonly string[], logFile?: string): void {
  for (const line of lines.slice(-TAIL_LINES)) println(dim(`    | ${line}`));
  if (logFile !== undefined) println(dim(`    日誌:${logFile}`));
}

function printEvent(
  event: HostServiceEvent,
  logs: string,
  urlOf: (name: string) => string | undefined,
): void {
  const name = bold(event.service);
  const reason = event.reason ?? "";
  switch (event.state) {
    case "starting":
      if (event.previous !== "backoff") note(`啟動 ${event.service}`);
      return;
    case "running":
      ok(`${name}  ${urlOf(event.service) ?? "執行中"}`);
      return;
    case "foreign":
      warn(`${name}  ${reason}`);
      return;
    case "disabled":
      warn(`${name}  停用:${reason}`);
      return;
    case "backoff":
    case "failed":
      fail(`${event.service}  ${reason}`);
      printTail(event.log_tail ?? [], join(logs, `${event.service}.log`));
      return;
    case "stopped":
      println(`${red("■")} ${event.service}${reason !== "" ? dim(`  ${reason}`) : ""}`);
      return;
    default:
      return;
  }
}

/** States `up` stops waiting at. */
const SETTLED: ReadonlySet<HostServiceState> = new Set([
  "running",
  "foreign",
  "failed",
  "backoff",
  "disabled",
  "stopped",
  "external",
]);

/** Waits for each service to come up or fail and prints it; returns the ones that did not come up. */
export async function watchStarts(
  client: HostdClient,
  names: readonly string[],
  logs: string,
  timeoutMs: number | null,
): Promise<{ failed: string[]; pending: string[] }> {
  const started = Date.now();
  const left = new Set(names);
  const failed: string[] = [];
  while (left.size > 0 && (timeoutMs === null || Date.now() - started < timeoutMs)) {
    const { services } = await client.call<HostServiceList>("service.list");
    for (const name of [...left]) {
      const s = services.find((x) => x.name === name);
      if (s === undefined) {
        left.delete(name);
        continue;
      }
      if (!SETTLED.has(s.state)) continue;
      left.delete(name);
      const secs = dim(`${((Date.now() - started) / 1000).toFixed(1)} s`);
      switch (s.state) {
        case "running":
          ok(`${bold(name)}  ${s.url ?? "執行中"}  ${secs}`);
          break;
        case "foreign":
          warn(`${bold(name)}  ${s.reason ?? "已有別的程式在回應"}`);
          break;
        case "disabled":
          warn(`${bold(name)}  停用:${s.reason ?? ""}`);
          break;
        case "external":
          note(`${name} 是外部程式,hostd 不會啟動它`);
          break;
        case "stopped":
          warn(`${bold(name)}  已停止${s.reason !== undefined ? `:${s.reason}` : ""}`);
          break;
        default: {
          failed.push(name);
          fail(`${name}  ${s.reason ?? s.state}`);
          const { lines } = await client
            .call<{ lines: string[] }>("service.logs", { service: name, lines: TAIL_LINES })
            .catch(() => ({ lines: [] as string[] }));
          printTail(lines, join(logs, `${name}.log`));
        }
      }
    }
    if (left.size > 0) await sleep(300);
  }
  return { failed, pending: [...left] };
}

export function rpcText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- hostd -------------------------------------------------------------------------------

/**
 * `miyoria hostd`: the daemon in this terminal until Ctrl+C or `down`. It starts no service by
 * itself unless `start` (`--start`, what the logon entry passes) asks for the enabled ones.
 */
export async function hostd(target: HostTarget, options: { start?: boolean } = {}): Promise<void> {
  let shutdown: () => void = () => {};
  const daemon = daemonFor(target, () => shutdown());
  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof HostdRunningError) {
      if (options.start === true) {
        // The logon entry found a daemon already there (someone ran `up` first). Its job is
        // done once the enabled services are asked to start; ending in an error would make a
        // supervisor such as systemd start this again and again.
        await startEnabledThrough(target, error.info.pid);
        return;
      }
      throw new HostCommandError(
        `這個工作資料夾的 hostd 已在執行(pid ${error.info.pid});不會再開一個`,
      );
    }
    throw error;
  }
  const host = daemon.hostConfig;
  // Detached, stdout is the log file: the state lines are for a terminal only.
  if (process.stdout.isTTY) {
    println(
      `hostd 執行中(pid ${process.pid},本機 API 埠 ${daemon.port}),工作資料夾 ${host.workspace}`,
    );
    daemon.onEvent((e) =>
      printEvent(
        e,
        host.state.logs,
        (name) => daemon.report({ withTokens: false }).services.find((s) => s.name === name)?.url,
      ),
    );
  }
  if (options.start === true) {
    // The logon entry (`host autostart`): bring back what host.toml enables, as `up` would.
    try {
      await daemon.startAll();
    } catch (error) {
      fail(`啟動服務時出錯:${rpcText(error)}`);
    }
  }
  await untilSignal((stop) => {
    shutdown = stop;
  });
  await daemon.stop();
}

/** Asks the daemon that already runs for this workspace to start what host.toml enables. */
async function startEnabledThrough(target: HostTarget, pid: number): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    warn(`hostd 已在執行(pid ${pid}),但連不上它的本機 API;沒有另外啟動服務`);
    return;
  }
  const { services: listed } = await client.call<HostServiceList>("service.list");
  const names = enabledNames(host, listed);
  for (const service of names) {
    await client
      .call<HostServiceControlResult>("service.start", { service })
      .catch((error: unknown) => warn(`${service}  ${rpcText(error)}`));
  }
  note(`hostd 已在執行(pid ${pid});已請它啟動 ${names.length} 個啟用的服務`);
}

// ---- up ------------------------------------------------------------------------------------

export interface UpOptions {
  services: string[];
  foreground?: boolean;
  timeoutSecs?: number;
  noWait?: boolean;
  /**
   * Once `core` of this machine answers: links this machine to it (`cluster.selfLink`; passed in
   * because that module imports this one). Absent with `--no-link`.
   */
  selfLink?: (host: LoadedHostConfig) => Promise<void>;
}

/** The services `up` starts without names: every one `host.toml` enables, in start order. */
function enabledNames(host: LoadedHostConfig, listed: readonly HostServiceStatus[]): string[] {
  return listed
    .filter((s) => s.kind !== "external" && host.config.services[s.name]?.enabled !== false)
    .map((s) => s.name);
}

/** The daemon of the workspace; started detached (no window) when none answers. */
async function ensureDaemon(target: HostTarget, host: LoadedHostConfig): Promise<HostdClient> {
  const running = await HostdClient.connect(host.state.root);
  if (running !== null) {
    note(`hostd 已在執行(pid ${running.info.pid})`);
    return running;
  }
  mkdirSync(host.state.logs, { recursive: true });
  const logFile = join(host.state.logs, "hostd.log");
  const [program, ...leading] = selfCommand() as [string, ...string[]];
  const fd = openSync(logFile, "a");
  let exitCode: number | null = null;
  let spawnError: string | null = null;
  try {
    const child = spawn(
      program,
      [...leading, "hostd", "-c", target.configPath, "--host-config", target.hostToml],
      {
        cwd: host.workspace,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: process.env,
      },
    );
    child.on("exit", (code) => {
      exitCode = code ?? -1;
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const client = await HostdClient.connect(host.state.root, 1000);
    if (client !== null) {
      ok(`hostd 已在背景啟動(pid ${client.info.pid}),日誌 ${logFile}`);
      return client;
    }
    if (exitCode !== null || spawnError !== null) break;
    await sleep(250);
  }
  fail(
    spawnError !== null
      ? `hostd 無法啟動:${spawnError}`
      : exitCode !== null
        ? `hostd 啟動後結束了(代碼 ${exitCode})`
        : "hostd 在 30 秒內沒有回應",
  );
  printTail(fileTail(logFile, TAIL_LINES), logFile);
  throw new HostCommandError("hostd 沒有起來");
}

export async function up(target: HostTarget, options: UpOptions): Promise<void> {
  const host = loadHost(target);
  if (options.foreground) {
    await foreground(target, host, options);
    return;
  }
  const client = await ensureDaemon(target, host);
  const { services: listed } = await client.call<HostServiceList>("service.list");
  const names = options.services.length > 0 ? options.services : enabledNames(host, listed);
  if (names.length === 0) {
    warn(`沒有要啟動的服務:${target.hostToml} 沒有啟用任何 [services.<名稱>]`);
    return;
  }
  section(`啟動 ${names.join(" → ")}`);
  const asked: string[] = [];
  let refused = 0;
  for (const service of names) {
    try {
      await client.call<HostServiceControlResult>("service.start", { service });
      asked.push(service);
    } catch (error) {
      refused += 1;
      fail(rpcText(error));
    }
  }
  if (options.noWait) {
    note("已交給 hostd;用 `miyoria status` 看進度");
    if (refused > 0) throw new HostCommandError(`${refused} 個服務無法啟動`);
    return;
  }
  const timeoutMs = options.timeoutSecs !== undefined ? options.timeoutSecs * 1000 : null;
  const { failed, pending } = await watchStarts(client, asked, host.state.logs, timeoutMs);
  if (pending.length > 0) {
    warn(`還在啟動:${pending.join("、")}(hostd 會繼續;用 \`miyoria status\` 看)`);
  }
  if (options.selfLink !== undefined && asked.includes("core") && !pending.includes("core")) {
    const { services } = await client.call<HostServiceList>("service.list");
    if (services.find((s) => s.name === "core")?.state === "running") {
      await options.selfLink(host);
    }
  }
  const bad = failed.length + refused;
  if (bad > 0) throw new HostCommandError(`${bad} 個服務沒有起來`);
  if (pending.length === 0) println(`\n${green("全部就緒")}。\`miyoria down\` 停止全部服務。`);
}

/** `up --foreground`: the supervisor inside this terminal; Ctrl+C stops everything. */
async function foreground(
  target: HostTarget,
  host: LoadedHostConfig,
  options: UpOptions,
): Promise<void> {
  let shutdown: () => void = () => {};
  const daemon = daemonFor(target, () => shutdown());
  try {
    await daemon.start();
  } catch (error) {
    if (error instanceof HostdRunningError) {
      throw new HostCommandError(
        `這個工作資料夾的 hostd 已在背景執行(pid ${error.info.pid});用 \`miyoria up\`,或先 \`miyoria down\``,
      );
    }
    throw error;
  }
  daemon.onEvent((e) =>
    printEvent(
      e,
      host.state.logs,
      (name) => daemon.report({ withTokens: false }).services.find((s) => s.name === name)?.url,
    ),
  );
  const listed = daemon.report({ withTokens: false }).services;
  const names = options.services.length > 0 ? options.services : enabledNames(host, listed);
  section(`啟動 ${names.join(" → ") || "(沒有服務)"}(前景,Ctrl+C 依相反順序停止全部)`);
  const operator = { kind: "operator" } as const;
  for (const service of names) {
    try {
      await daemon.call("service.start", { service }, operator);
    } catch (error) {
      fail(rpcText(error));
    }
  }
  let stopping = false;
  if (options.selfLink !== undefined && names.includes("core")) {
    // Core takes a while: link in the background once it answers, without holding Ctrl+C back.
    const link = options.selfLink;
    void (async () => {
      const until = Date.now() + 5 * 60_000;
      while (!stopping && Date.now() < until) {
        const state = daemon.report({ withTokens: false }).services.find((s) => s.name === "core");
        if (state?.state === "running") {
          await link(host);
          return;
        }
        if (state?.state === "failed") return;
        await sleep(500);
      }
    })();
  }
  await untilSignal((stop) => {
    shutdown = stop;
  });
  stopping = true;
  section("停止服務");
  await daemon.stop();
}

// ---- down / restart --------------------------------------------------------------------------

export async function down(
  target: HostTarget,
  options: { services: string[]; force?: boolean },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    warn("hostd 沒有在執行;沒有要停止的服務");
    return;
  }
  const force = options.force === true;
  if (options.services.length === 0) {
    let result: HostShutdownResult;
    try {
      result = await client.call<HostShutdownResult>(
        "host.shutdown",
        { force },
        { timeoutMs: 600_000 },
      );
    } catch (error) {
      if (error instanceof HostRpcError && error.code === HOST_ERROR_CODE.Guarded) {
        throw new HostCommandError(`沒有停止任何服務:${error.message}`);
      }
      throw error;
    }
    for (const name of result.stopped) println(`${red("■")} ${name}`);
    ok("hostd 已結束");
    return;
  }
  let errors = 0;
  for (const service of options.services) {
    try {
      const r = await client.call<HostServiceControlResult>(
        "service.stop",
        { service, force },
        { timeoutMs: 120_000 },
      );
      if (r.state === "stopped") println(`${red("■")} ${service}`);
      else if (r.state === "foreign") warn(`${service} 不是這個 hostd 啟動的,不會停止它`);
      else if (r.state === "external") warn(`${service} 是外部程式,hostd 不會停止它`);
      else warn(`${service}:${r.state}`);
    } catch (error) {
      errors += 1;
      fail(rpcText(error));
    }
  }
  if (errors > 0) throw new HostCommandError(`${errors} 個服務沒有停止`);
}

export async function restart(
  target: HostTarget,
  options: { service: string; force?: boolean; timeoutSecs?: number },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    throw new HostCommandError(`hostd 沒有在執行;用 \`miyoria up ${options.service}\` 啟動`);
  }
  await client.call<HostServiceControlResult>(
    "service.restart",
    { service: options.service, force: options.force === true },
    { timeoutMs: 120_000 },
  );
  note(`已重新啟動 ${options.service},等待就緒…`);
  const timeoutMs = options.timeoutSecs !== undefined ? options.timeoutSecs * 1000 : null;
  const { failed } = await watchStarts(client, [options.service], host.state.logs, timeoutMs);
  if (failed.length > 0) throw new HostCommandError(`${options.service} 沒有起來`);
}

// ---- status ------------------------------------------------------------------------------

/** The control link's state as `status` says it. */
/**
 * Who decides how the card is shared, for `status`: nothing when the daemon says nothing about
 * it (an older one), one line for the mode, one per lease, and the last decision.
 */
export function arbiterLines(
  arbiter: HostGpuArbiterStatus | undefined,
  now = Date.now(),
): string[] {
  if (arbiter === undefined) return [];
  if (arbiter.mode === "worker")
    return [`仲裁   ${dim('由翻唱服務自己決定(host.toml [gpu] arbiter = "worker")')}`];
  if (!arbiter.active) {
    return [
      `仲裁   ${yellow("hostd,但沒有在運作")}${arbiter.reason === undefined ? "" : `:${arbiter.reason}`}`,
    ];
  }
  const lines = [
    `仲裁   hostd${arbiter.policy === undefined ? "" : `(政策 ${arbiter.policy})`},${
      arbiter.leases.length === 0 ? "沒有服務佔用顯卡" : `${arbiter.leases.length} 個租約`
    }`,
  ];
  for (const lease of arbiter.leases) {
    const what = [lease.mode, lease.code].filter((part) => part !== null).join(" / ");
    const evicted = lease.evicted.length > 0 ? `,讓出:${lease.evicted.join("、")}` : "";
    lines.push(
      `       ${bold(lease.holder)} 在 ${lease.stage} 階段${what === "" ? "" : `(${what})`},已 ${ago(now - lease.since)}${evicted}`,
    );
  }
  if (arbiter.last !== null) {
    lines.push(
      dim(
        `       上次判斷:${arbiter.last.stage} ${arbiter.last.mode} / ${arbiter.last.code},${ago(now - arbiter.last.at)}前:${arbiter.last.reason}`,
      ),
    );
  }
  return lines;
}
export function linkText(state: HostLinkState | undefined): string {
  switch (state) {
    case "connected":
      return green("已連上");
    case "connecting":
      return yellow("連線中");
    case "unauthorized":
      return red("被拒絕(host.key 無效或已撤銷)");
    case "stopped":
      return dim("已停止");
    default:
      return dim("沒有(host.toml 沒有 [cluster] 或還沒有 host.key)");
  }
}

/** `12 秒`, `5 分`, `3 小時`, `2 天`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小時`;
  return `${Math.floor(s / 86_400)} 天`;
}

function stateColor(state: HostServiceState, text: string): string {
  switch (state) {
    case "running":
      return green(text);
    case "failed":
    case "backoff":
      return red(text);
    case "starting":
    case "stopping":
    case "foreign":
      return yellow(text);
    case "disabled":
    case "stopped":
      return dim(text);
    default:
      return text;
  }
}

/** Terminal columns of a text: CJK and full-width characters take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0xffdc ? 2 : 1;
  }
  return width;
}

/** The service table of `status`. */
export function serviceTable(services: readonly HostServiceStatus[], now = Date.now()): string[] {
  const head = ["服務", "狀態", "健康", "埠", "PID", "重啟", "自從", "原因"];
  const rows = services.map((s) => [
    s.name,
    s.state,
    s.state === "running" || s.state === "external" || s.state === "foreign"
      ? s.healthy
        ? "✓"
        : "✗"
      : "-",
    s.port !== undefined ? String(s.port) : "-",
    s.pid !== undefined ? String(s.pid) : "-",
    String(s.restarts),
    `${ago(now - s.since)}前`,
    s.reason ?? "",
  ]);
  const widths = head.map((_, i) =>
    Math.max(...[head, ...rows].map((r) => displayWidth(r[i] ?? ""))),
  );
  const pad = (text: string, i: number) =>
    text + " ".repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(text)));
  const lines = [dim(head.map((h, i) => (i === head.length - 1 ? h : pad(h, i))).join("  "))];
  rows.forEach((row, r) => {
    const state = services[r]?.state as HostServiceState;
    lines.push(
      row
        .map((cell, i) => {
          const text = i === row.length - 1 ? cell : pad(cell, i);
          return i === 1 ? stateColor(state, text) : text;
        })
        .join("  ")
        .trimEnd(),
    );
  });
  return lines;
}

export interface StatusOptions {
  /** `--all`: after this machine's table, what shows every host of Core (`cluster.hostsSection`). */
  hosts?: (core: remote.Remote) => Promise<void>;
}

export async function status(target: HostTarget, options: StatusOptions = {}): Promise<void> {
  const host = existsSync(target.hostToml) ? loadHostConfig(target.hostToml) : null;
  if (host === null) {
    note(`沒有 ${target.hostToml}(\`miyoria host migrate\` 可以從 [machine] 和 [stack] 轉出)`);
  } else {
    const client = await HostdClient.connect(host.state.root);
    if (client === null) {
      section(`這台電腦:${host.config.name}`);
      warn("hostd 沒有在執行(`miyoria up` 會啟動它)");
      const enabled = Object.entries(host.config.services)
        .filter(([, s]) => s.enabled)
        .map(([name]) => name);
      println(`host.toml 啟用的服務:${enabled.join("、") || "(沒有)"}`);
    } else {
      const info = await client.call<HostInfo>("host.info");
      section(`這台電腦:${info.name}`);
      const uptime = Date.now() - Date.parse(client.info.started_at);
      println(
        `hostd  pid ${client.info.pid}  已執行 ${ago(uptime)}  Core 連線:${linkText(info.link)}  ${dim(client.info.workspace)}`,
      );
      println(
        info.gpu === null
          ? `顯卡   ${dim("讀不到(NVML 和 nvidia-smi 都沒有回應)")}`
          : `顯卡   ${info.gpu.name ?? ""}  已用 ${info.gpu.used_mb} / ${info.gpu.total_mb} MB${
              info.gpu.free_mb === undefined ? "" : `,可用 ${info.gpu.free_mb} MB`
            },保留 ${info.gpu.reserve_mb} MB`,
      );
      for (const line of arbiterLines(info.arbiter)) println(line);
      println();
      if (info.services.length === 0) println(dim("host.toml 沒有任何服務"));
      for (const line of serviceTable(info.services)) println(line);
    }
  }

  // Core, as the status command showed it before hostd.
  let core: remote.Remote;
  try {
    core = remote.clientFor(await loadConfig(target.configPath));
  } catch (error) {
    if (host === null) throw error;
    println(dim(`\n(不查 Core:${rpcText(error)})`));
    return;
  }
  if (!(await remote.isRunning(core))) {
    println(`\n${dim("core 的管理 API 沒有回應")}`);
    return;
  }
  await options.hosts?.(core);
  section("Core");
  await remote.status(core);
}

// ---- logs --------------------------------------------------------------------------------

export async function logs(
  target: HostTarget,
  options: { service: string; follow?: boolean; lines: number; signal?: AbortSignal },
): Promise<void> {
  const host = loadHost(target);
  const client = await HostdClient.connect(host.state.root);
  if (client === null) {
    const file = join(host.state.logs, `${options.service}.log`);
    if (!existsSync(file)) {
      throw new HostCommandError(`hostd 沒有在執行,也沒有 ${file}`);
    }
    for (const line of fileTail(file, options.lines)) println(line);
    if (options.follow) warn("hostd 沒有在執行,沒有新的行可以等");
    return;
  }
  for await (const line of client.logs(options.service, {
    lines: options.lines,
    follow: options.follow === true,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    println(line);
  }
}
