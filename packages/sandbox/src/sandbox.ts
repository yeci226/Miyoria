import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage, getLogger, sleep } from "@miyoria/kernel";
import { type Clock, isUlid, type JsonValue, newId, systemClock } from "@miyoria/types";
import {
  buildRunArgs,
  CONTAINER_ENV,
  ENTRY_FILE,
  entryCommand,
  execArgs,
  inspectImageArgs,
  KEEPER_COMMAND,
  keeperUser,
  killAllArgs,
  killArgs,
  LABEL,
  LABEL_INSTANCE,
  LABEL_KIND,
  LABEL_RUN,
  LABEL_SESSION,
  listArgs,
  NAME_PREFIX,
  pullArgs,
  removeArgs,
  runningArgs,
  STANDBY_READY,
  standbyCommand,
  versionArgs,
} from "./args.js";
import type { SandboxConfig } from "./config.js";
import {
  egressNetworkName,
  egressProxyArgs,
  egressProxyName,
  egressReadyArgs,
  networkConnectArgs,
  networkCreateArgs,
  networkInspectArgs,
  networkRemoveArgs,
  proxyEnv,
} from "./egress.js";
import { checkProfileId } from "./paths.js";
import { type PoolStats, type Standby, WarmPool } from "./pool.js";
import type { DockerRunner, ExecOptions, ExecResult } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import {
  FRESH,
  type KilledReason,
  LANGUAGES,
  type Language,
  type RunRequest,
  RunRequestSchema,
  type RunResult,
  type Sandbox,
  SandboxError,
  type SandboxHealth,
  SessionClosedError,
  type SessionCloseReason,
  type SessionInfo,
} from "./types.js";
import {
  collectOutputs,
  createRunDirs,
  createSessionDirs,
  MAX_SESSION_ENTRIES,
  pruneRuns,
  type RunDirs,
  removeDir,
  sessionsDir,
  signatures,
  ToolsWorkspace,
  walkWork,
  writeInputs,
  writeProgram,
} from "./workspace.js";
import { PersistentWorkspace, type Removed } from "./workspace-store.js";

const log = getLogger("sandbox");

/** How long `docker run` gets to exit after `docker kill` before the CLI is killed too. */
export const KILL_GRACE_MS = 5_000;
/** Timeout of small Docker CLI calls (version, kill, rm, inspect, ps). */
export const CONTROL_TIMEOUT_MS = 15_000;
/** Timeout of starting a pooled or session container (`docker run -d`). */
export const START_TIMEOUT_MS = 60_000;
/** Output kept from control calls. */
const CONTROL_OUTPUT_BYTES = 16 * 1024;
/** Sessions that closed on their own, remembered by name until she is told. */
const MAX_TOMBSTONES = 32;
const MIB = 1024 * 1024;
/** How often and how long `#startEgress` waits for the proxy to listen. */
const EGRESS_READY_TRIES = 20;
const EGRESS_READY_WAIT_MS = 250;

/** A `docker exec` failure of the CLI or the daemon (not of the program). */
const DAEMON_ERROR =
  /^(Error response from daemon|error during connect|Cannot connect to the Docker daemon)/m;

/** Receives `sandbox.*` events (the module publishes them on the bus). */
export type SandboxPublisher = (topic: string, payload: JsonValue) => void;

export interface DockerSandboxOptions {
  /** Absolute sandbox root (`config.root` resolved). */
  root: string;
  profile: string;
  runner: DockerRunner;
  clock?: Clock;
  publisher?: SandboxPublisher;
  /** Host uid / gid for `user = "auto"`; default `process.getuid?.()`. */
  hostUser?: { uid: number; gid: number } | null;
  /** Default `KILL_GRACE_MS` (tests shorten it). */
  killGraceMs?: number;
}

/** Outcome of making sure an image is present locally. */
export interface ImageCheck {
  image: string;
  pulled: boolean;
  duration_ms: number;
}

/** Resolves `user = "auto"` (see `SandboxConfig.user`). */
export function resolveUser(configured: string, host: { uid: number; gid: number } | null): string {
  if (configured !== "auto") return configured;
  if (host && host.uid > 0 && host.gid > 0) return `${host.uid}:${host.gid}`;
  return "65534:65534";
}

function defaultHostUser(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return { uid: process.getuid(), gid: process.getgid() };
}

/** Short stable id of a sandbox root, used as the instance label. */
export function instanceId(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

/** Name of the container of run or session container `id` (a ULID). */
function containerName(id: string): string {
  return `${NAME_PREFIX}${id.toLowerCase()}`;
}

function decodeOutput(data: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

/** A failure of the Docker CLI itself (`docker run` exits 125 and prints `docker: ...`). */
function dockerFailure(result: ExecResult): string | null {
  if (result.error !== null) return result.error;
  if (result.exit_code !== 125) return null;
  const text = decodeOutput(result.stderr).trim();
  return /^docker: /m.test(text) || /Error response from daemon/.test(text) ? text : null;
}

/** First line of a control call's error. */
function why(result: ExecResult): string {
  return (
    result.error ??
    (decodeOutput(result.stderr).trim().split("\n")[0] || `docker exited ${result.exit_code}`)
  );
}

function sessionClosed(name: string, reason: SessionCloseReason): SessionClosedError {
  return new SessionClosedError(name, reason);
}

/** `docker exec` found its container gone or stopped. */
class ContainerGoneError extends Error {
  override readonly name = "ContainerGoneError";
}

/** How one program is started and stopped. */
interface Launch {
  /** Runs the Docker CLI (`docker run`, `docker exec`, or the pooled container's go). */
  start(options: ExecOptions): Promise<ExecResult>;
  /** Ends the program (timeout, abort, output limit). */
  kill(): Promise<unknown>;
  /** The CLI did not exit within the grace after `kill` and was dropped. */
  hung(): Promise<unknown>;
  /** The container a `docker exec` runs in; `null` for `docker run`. */
  container: string | null;
  /** A pooled container: its stderr starts with `STANDBY_READY`, which is not the program's. */
  standby?: boolean;
}

type Validated = Required<Omit<RunRequest, "network">> & { network: "none" | "allow" };
type Executed = Omit<RunResult, "files_out" | "files_out_truncated" | "session">;

/** One of her named sessions. */
interface Session {
  name: string;
  language: Language;
  /** Container id (a ULID; its workspace is `sessions/<id>`) and name. */
  id: string;
  container: string;
  /** Set once its container is being started. */
  dirs: RunDirs | null;
  created_at: number;
  last_used_at: number;
  runs: number;
  disk_bytes: number;
  /** One run at a time. */
  lock: Semaphore;
  /** Aborted when the session ends: the running and the waiting runs stop. */
  ended: AbortController;
  closed: SessionCloseReason | null;
  /** The run in progress. */
  current: Promise<unknown> | null;
  disposed: Promise<void> | null;
}

/**
 * `Sandbox` on the Docker CLI. A fresh run gets a fresh container (`buildRunArgs` has the flags)
 * and a fresh workspace directory, started for it or taken from the warm pool (the same container
 * started ahead of time, waiting for its one program; see `pool.ts`). A named session is one
 * long-lived container per name, same flags, whose `/work` carries over; nothing a run starts in
 * it outlives the run. Runs are limited by a semaphore; a wall-clock timer kills the program. See
 * the package README for the threat model.
 */
export class DockerSandbox implements Sandbox {
  readonly tools: ToolsWorkspace;
  readonly workspace: PersistentWorkspace | null;
  readonly instance: string;
  readonly #config: SandboxConfig;
  readonly #root: string;
  readonly #sessionsDir: string;
  readonly #runner: DockerRunner;
  readonly #clock: Clock;
  readonly #publish: SandboxPublisher;
  readonly #user: string;
  readonly #killGraceMs: number;
  readonly #slots: Semaphore;
  readonly #closing = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Run ids whose workspace is in use (never pruned), including the pool's. */
  readonly #active = new Set<string>();
  readonly #images = new Map<string, Promise<ImageCheck>>();
  readonly #pool: WarmPool;
  readonly #sessions = new Map<string, Session>();
  /** Sessions that closed on their own, by name, until she uses the name again. */
  readonly #tombstones = new Map<string, SessionCloseReason>();
  #sweep: ReturnType<typeof setInterval> | null = null;
  /** The egress proxy is up (checked again before each use). */
  #egressUp = false;
  #egressTouched = false;
  #egressStart: Promise<void> | null = null;
  #health: SandboxHealth = {
    available: false,
    server_version: null,
    error: null,
    checked_at: null,
  };
  #healthCheck: Promise<SandboxHealth> | null = null;

  constructor(config: SandboxConfig, options: DockerSandboxOptions) {
    this.#config = config;
    this.#root = resolve(options.root);
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#publish = options.publisher ?? (() => {});
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#user = resolveUser(
      config.user,
      options.hostUser === undefined ? defaultHostUser() : options.hostUser,
    );
    this.#slots = new Semaphore(config.max_concurrent, config.max_queued);
    this.instance = instanceId(this.#root);
    const profile = checkProfileId(options.profile);
    this.tools = new ToolsWorkspace(join(this.#root, "profiles", profile, "tools"), {
      maxScripts: config.max_scripts,
      maxScriptBytes: config.caps.max_code_bytes,
    });
    const ws = config.workspace;
    this.workspace = ws.enabled
      ? new PersistentWorkspace(
          join(this.#root, "profiles", profile, "workspace"),
          {
            maxBytes: ws.max_mb * MIB,
            maxFiles: ws.max_files,
            maxFileBytes: ws.max_file_kb * 1024,
          },
          // Outside the directory a container can write: the approvals of her scripts.
          join(this.#root, "profiles", profile, "workspace-scripts.json"),
        )
      : null;
    this.#sessionsDir = sessionsDir(this.#root, profile);
    this.#pool = new WarmPool({
      size: config.pool_size,
      languages: LANGUAGES,
      start: (language) => this.#startPooled(language),
      discard: (entry) => this.#discardPooled(entry),
    });
  }

  get root(): string {
    return this.#root;
  }

  get networkAllow(): readonly string[] {
    return this.#config.network.allow;
  }

  /** The container user (`uid:gid`). */
  get user(): string {
    return this.#user;
  }

  /** Last health result without checking. */
  get lastHealth(): SandboxHealth {
    return this.#health;
  }

  /** The warm pool's counters. */
  get pool(): PoolStats {
    return this.#pool.stats;
  }

  async health(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<SandboxHealth> {
    const age =
      this.#health.checked_at === null
        ? Number.POSITIVE_INFINITY
        : this.#clock.now() - this.#health.checked_at;
    if (!options.refresh && age <= this.#config.health_ttl_ms) return this.#health;
    this.#healthCheck ??= this.#checkHealth(options.signal).finally(() => {
      this.#healthCheck = null;
    });
    return this.#healthCheck;
  }

  async #checkHealth(signal?: AbortSignal): Promise<SandboxHealth> {
    const result = await this.#control(versionArgs(), signal);
    const version = decodeOutput(result.stdout).trim();
    const ok = result.error === null && result.exit_code === 0 && version !== "";
    const error = ok ? null : why(result);
    const first = this.#health.checked_at === null;
    const before = this.#health.available;
    this.#health = {
      available: ok,
      server_version: ok ? version : null,
      error,
      checked_at: this.#clock.now(),
    };
    if (first || before !== ok) {
      if (ok) log.info({ version }, "docker is available");
      else log.warn({ err: error }, "docker is not available; the sandbox is degraded");
    }
    // Docker went away or came back: the pooled containers may be gone with it.
    if (!first && before !== ok) void this.#pool.discardAll();
    if (ok) this.#pool.fill();
    return this.#health;
  }

  /** A Docker CLI call that is not a program run (bounded time and output). */
  #control(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<ExecResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.#runner.exec(args, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      maxOutputBytes: CONTROL_OUTPUT_BYTES,
    });
  }

  /**
   * Makes sure the egress network and its proxy are up and returns the network's name (see
   * `egress.ts`). Concurrent callers share one start; a proxy that died is started again.
   */
  async #ensureEgress(signal: AbortSignal): Promise<string> {
    if (this.#egressStart === null) {
      this.#egressStart = this.#startEgress(signal).finally(() => {
        this.#egressStart = null;
      });
    }
    await this.#egressStart;
    return egressNetworkName(this.instance);
  }

  async #startEgress(signal: AbortSignal): Promise<void> {
    const network = egressNetworkName(this.instance);
    const proxy = egressProxyName(this.instance);
    if (this.#egressUp && (await this.#state(proxy)) === "running") return;
    this.#egressUp = false;
    this.#egressTouched = true;
    await this.ensureImage("node", signal);
    const fail = (what: string, result: ExecResult): SandboxError =>
      new SandboxError("docker_failed", `egress proxy: cannot ${what}: ${why(result)}`);
    const inspected = await this.#control(networkInspectArgs(network), signal);
    if (inspected.exit_code !== 0) {
      const created = await this.#control(networkCreateArgs(network, this.instance), signal);
      if (created.exit_code !== 0 || created.error !== null) {
        throw fail("create the network", created);
      }
    }
    // A leftover of the same name (stopped, or from before a Docker restart) would block the start.
    await this.#control(removeArgs([proxy]), signal).catch(() => undefined);
    const started = await this.#control(
      egressProxyArgs({
        name: proxy,
        instance: this.instance,
        image: this.image("node"),
        network: this.#config.network,
      }),
      signal,
      START_TIMEOUT_MS,
    );
    if (started.exit_code !== 0 || started.error !== null) throw fail("start the proxy", started);
    const connected = await this.#control(networkConnectArgs(network, proxy), signal);
    if (connected.exit_code !== 0 || connected.error !== null) {
      await this.#control(removeArgs([proxy])).catch(() => undefined);
      throw fail("connect the proxy", connected);
    }
    const ready = egressReadyArgs(proxy, this.#config.network.proxy_port);
    for (let attempt = 0; attempt < EGRESS_READY_TRIES; attempt++) {
      const probe = await this.#control(ready, signal);
      if (probe.exit_code === 0 && probe.error === null) {
        this.#egressUp = true;
        return;
      }
      await sleep(EGRESS_READY_WAIT_MS, signal);
    }
    await this.#control(removeArgs([proxy])).catch(() => undefined);
    throw new SandboxError("docker_failed", "egress proxy: it did not start listening");
  }

  /** Removes the proxy and the egress network (leftovers, or at shutdown). */
  async #teardownEgress(): Promise<void> {
    this.#egressUp = false;
    await this.#control(removeArgs([egressProxyName(this.instance)])).catch(() => undefined);
    await this.#control(networkRemoveArgs(egressNetworkName(this.instance))).catch(() => undefined);
  }

  /**
   * Removes containers of this instance left over from an earlier process (crash, kill -9),
   * pooled and session containers included. Call it before `warm`. Returns how many were removed.
   */
  async reap(signal?: AbortSignal): Promise<number> {
    const listed = await this.#control(listArgs(this.instance), signal);
    if (listed.exit_code !== 0) return 0;
    const ids = decodeOutput(listed.stdout)
      .split(/\s+/)
      .filter((id) => /^[0-9a-f]{12,64}$/.test(id));
    if (ids.length === 0) return 0;
    const removed = await this.#control(removeArgs(ids), signal);
    // A leftover egress proxy goes with them; its network can go once nothing is on it.
    await this.#control(networkRemoveArgs(egressNetworkName(this.instance)), signal).catch(
      () => undefined,
    );
    if (removed.exit_code === 0)
      log.info({ count: ids.length }, "removed leftover sandbox containers");
    else
      log.warn(
        { err: decodeOutput(removed.stderr).trim() },
        "could not remove leftover containers",
      );
    return removed.exit_code === 0 ? ids.length : 0;
  }

  /** Starts keeping `pool_size` containers ready per language (after `reap`). */
  warm(): void {
    if (!this.#closing.signal.aborted) this.#pool.enable();
  }

  /**
   * Deletes old run workspaces beyond `keep_runs`, and session workspaces no live session owns
   * (left by an earlier process).
   */
  async prune(): Promise<number> {
    let removed = await pruneRuns(this.#root, this.#config.keep_runs, this.#active);
    const live = new Set([...this.#sessions.values()].map((s) => s.id));
    let names: string[] = [];
    try {
      names = await readdir(this.#sessionsDir);
    } catch {
      // No sessions yet.
    }
    for (const name of names) {
      if (isUlid(name) && !live.has(name) && (await removeDir(join(this.#sessionsDir, name)))) {
        removed++;
      }
    }
    return removed;
  }

  /** Image for a language. */
  image(language: Language): string {
    return this.#config.images[language];
  }

  /**
   * Makes sure the language's image is present, pulling it once if not (concurrent callers share
   * the pull). Throws `SandboxError` (`image_unavailable`).
   */
  ensureImage(language: Language, signal?: AbortSignal): Promise<ImageCheck> {
    const image = this.image(language);
    let check = this.#images.get(image);
    if (!check) {
      check = this.#pullIfMissing(image, signal);
      this.#images.set(image, check);
      // A failed check is retried by the next run.
      check.catch(() => this.#images.delete(image));
    }
    return check;
  }

  async #pullIfMissing(image: string, signal?: AbortSignal): Promise<ImageCheck> {
    const started = this.#clock.now();
    const inspect = await this.#control(inspectImageArgs(image), signal);
    if (inspect.exit_code === 0) return { image, pulled: false, duration_ms: 0 };
    log.info({ image }, "pulling sandbox image");
    const pull = await this.#control(pullArgs(image), signal, this.#config.pull_timeout_ms);
    if (pull.exit_code !== 0) {
      const why = pull.error ?? decodeOutput(pull.stderr).trim().split("\n")[0] ?? "";
      throw new SandboxError("image_unavailable", `could not pull \`${image}\`: ${why}`);
    }
    const check = { image, pulled: true, duration_ms: this.#clock.now() - started };
    log.info({ image, duration_ms: check.duration_ms }, "pulled sandbox image");
    return check;
  }

  async run(request: RunRequest, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.#closing.signal.aborted) throw new SandboxError("closed", "the sandbox is shut down");
    const parsed = this.#validate(request);
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#closing.signal])
      : this.#closing.signal;
    const task = this.#run(parsed, signal);
    this.#inFlight.add(task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(task);
    }
  }

  #validate(request: RunRequest): Validated {
    const parsed = RunRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SandboxError("invalid_request", `invalid run request: ${parsed.error.message}`);
    }
    const r = parsed.data;
    const caps = this.#config.caps;
    const configured = this.#config.network.allow;
    if (r.network !== undefined && r.network !== "none") {
      if (configured.length === 0) {
        throw new SandboxError(
          "network_unsupported",
          "no network allowlist is configured ([modules.sandbox.network] allow); runs have no network",
        );
      }
      const unknown = r.network.allow.filter((host) => !configured.includes(host.toLowerCase()));
      if (unknown.length > 0) {
        throw new SandboxError(
          "invalid_request",
          `hosts not in the configured allowlist: ${unknown.join(", ")}`,
        );
      }
    }
    const wantsNetwork = r.network !== undefined && r.network !== "none";
    if (r.mount_workspace && this.workspace === null) {
      throw new SandboxError("invalid_request", "the workspace is turned off");
    }
    if (Buffer.byteLength(r.code, "utf8") > caps.max_code_bytes) {
      throw new SandboxError("invalid_request", `code is over ${caps.max_code_bytes} bytes`);
    }
    const stdin = r.stdin ?? "";
    if (Buffer.byteLength(stdin, "utf8") > caps.max_stdin_bytes) {
      throw new SandboxError("invalid_request", `stdin is over ${caps.max_stdin_bytes} bytes`);
    }
    const timeout = r.timeout_ms ?? this.#config.default_timeout_ms;
    if (timeout > this.#config.max_timeout_ms) {
      throw new SandboxError(
        "invalid_request",
        `timeout_ms is over the maximum of ${this.#config.max_timeout_ms}`,
      );
    }
    const session = r.session ?? FRESH;
    if (session !== FRESH && r.mount_tools) {
      throw new SandboxError("invalid_request", "sessions do not mount /tools; use a fresh run");
    }
    if (session !== FRESH && r.mount_workspace) {
      throw new SandboxError(
        "invalid_request",
        "sessions do not mount /workspace; use a fresh run",
      );
    }
    if (session !== FRESH && wantsNetwork) {
      throw new SandboxError("invalid_request", "sessions have no network; use a fresh run");
    }
    return {
      network: wantsNetwork ? "allow" : "none",
      mount_workspace: r.mount_workspace ?? false,
      language: r.language,
      code: r.code,
      files: r.files ?? [],
      stdin,
      timeout_ms: timeout,
      mount_tools: r.mount_tools ?? false,
      session,
    };
  }

  async #run(r: Validated, signal: AbortSignal): Promise<RunResult> {
    const health = await this.health({ signal });
    if (!health.available) {
      throw new SandboxError(
        "unavailable",
        `docker is not available: ${health.error ?? "unknown"}`,
      );
    }
    if (r.session !== FRESH) return this.#runInSession(r, signal);
    const release = await this.#slot(signal);
    try {
      await this.ensureImage(r.language, signal);
      // The pool's containers mount no tools or workspace and have no network.
      const plain = !r.mount_tools && !r.mount_workspace && r.network === "none";
      const pooled = plain ? this.#pool.take(r.language) : null;
      if (pooled) {
        try {
          return await this.#runPooled(pooled, r, signal);
        } catch (error) {
          if (!(error instanceof ContainerGoneError)) throw error;
          log.warn({ err: error.message }, "a pooled container was gone; using a fresh one");
        }
      }
      return await this.#runFresh(r, signal);
    } finally {
      release();
      await this.#housekeeping();
    }
  }

  async #slot(signal: AbortSignal): Promise<() => void> {
    let release: (() => void) | null;
    try {
      release = await this.#slots.acquire(signal);
    } catch (error) {
      throw new SandboxError("closed", "the run was cancelled while waiting", { cause: error });
    }
    if (release === null) throw new SandboxError("busy", "too many sandbox runs are waiting");
    return release;
  }

  async #housekeeping(): Promise<void> {
    try {
      await this.prune();
    } catch (error) {
      // Pruning is housekeeping; a failure must not fail the run.
      log.warn({ err: errorMessage(error) }, "pruning sandbox runs failed");
    }
  }

  #labels(kind: "run" | "pool" | "session", id: string, session?: string): Record<string, string> {
    return {
      [LABEL]: "1",
      [LABEL_INSTANCE]: this.instance,
      [LABEL_RUN]: id,
      [LABEL_KIND]: kind,
      ...(session === undefined ? {} : { [LABEL_SESSION]: session }),
    };
  }

  /** Publishes `sandbox.run.finished` (no code, no output) and returns the result. */
  #done(done: RunResult): RunResult {
    this.#publish("sandbox.run.finished", {
      run_id: done.run_id,
      language: done.language,
      exit_code: done.exit_code,
      duration_ms: done.duration_ms,
      killed_reason: done.killed_reason,
      files_out: done.files_out.length,
      session: done.session?.name ?? null,
    });
    return done;
  }

  /** Output files of a fresh or pooled run (none when it was aborted before it started). */
  async #finishRun(
    result: Executed,
    workDir: string,
    inputs: ReadonlyMap<string, string>,
  ): Promise<RunResult> {
    const outputs =
      result.exit_code === null && result.killed_reason === "aborted"
        ? { files: [], truncated: false }
        : await collectOutputs(workDir, inputs, this.#config.caps);
    return this.#done({
      ...result,
      files_out: outputs.files,
      files_out_truncated: outputs.truncated,
      session: null,
    });
  }

  async #releaseRunDirs(runId: string, dirs: RunDirs): Promise<void> {
    await removeDir(dirs.codeDir);
    if (this.#config.keep_runs === 0) await removeDir(dirs.dir);
    this.#active.delete(runId);
  }

  /** A fresh run in a container started for it (`docker run --rm -i`). */
  async #runFresh(r: Validated, signal: AbortSignal): Promise<RunResult> {
    const runId = newId();
    this.#active.add(runId);
    const dirs = await createRunDirs(this.#root, runId).catch((error: unknown) => {
      this.#active.delete(runId);
      throw error;
    });
    try {
      await writeProgram(dirs.codeDir, r.language, r.code);
      const inputs = await writeInputs(dirs.workDir, r.files, this.#config.caps);
      const toolsDir = r.mount_tools ? await this.tools.ensure() : null;
      const workspace = r.mount_workspace ? this.workspace : null;
      let workspaceDir: string | null = null;
      let before: Map<string, string> = new Map();
      if (workspace) {
        workspaceDir = await workspace.ensure();
        const usage = await workspace.usage();
        if (usage.overflow) {
          throw new SandboxError(
            "limit",
            "the workspace has too many entries to mount; delete some files first",
          );
        }
        before = await workspace.snapshot();
      }
      const network = r.network === "allow" ? await this.#ensureEgress(signal) : null;
      const name = containerName(runId);
      const args = buildRunArgs({
        name,
        image: this.image(r.language),
        labels: this.#labels("run", runId),
        workDir: dirs.workDir,
        codeDir: dirs.codeDir,
        toolsDir,
        workspaceDir,
        ...(network === null ? {} : { network }),
        user: this.#user,
        limits: this.#config.limits,
        command: entryCommand(r.language),
        env:
          network === null
            ? CONTAINER_ENV
            : { ...CONTAINER_ENV, ...proxyEnv(this.#config.network.proxy_port) },
      });
      const state: { removed?: Removed[] } = {};
      const enforce = async (): Promise<void> => {
        // Whatever happened to the run, the container may have written in the workspace.
        if (!workspace) return;
        const removed = await workspace.enforce(before).catch((error: unknown) => {
          log.warn({ err: errorMessage(error) }, "could not check the workspace after a run");
          return undefined;
        });
        if (removed === undefined) return;
        state.removed = removed;
        if (removed.length > 0) {
          this.#publish("sandbox.workspace.enforced", { run_id: runId, removed: removed.length });
        }
      };
      try {
        const result = await this.#execute(
          runId,
          r,
          {
            start: (options) => this.#runner.exec(args, options),
            kill: () => this.#control(killArgs(name)),
            hung: () => this.#control(removeArgs([name])),
            container: null,
          },
          signal,
        );
        await enforce();
        const finished = await this.#finishRun(result, dirs.workDir, inputs);
        return state.removed === undefined
          ? finished
          : { ...finished, workspace_removed: state.removed };
      } catch (error) {
        await enforce();
        throw error;
      }
    } finally {
      await this.#releaseRunDirs(runId, dirs);
    }
  }

  /**
   * Starts a pooled container: the `docker run` of a fresh run (same flags, a workspace of its
   * own), whose command waits for its program (`standbyCommand`). Resolves once it is up.
   */
  async #startPooled(language: Language): Promise<Standby> {
    if (this.#closing.signal.aborted) throw new SandboxError("closed", "the sandbox is shut down");
    await this.ensureImage(language, this.#closing.signal);
    const id = newId();
    this.#active.add(id);
    const dirs = await createRunDirs(this.#root, id).catch((error: unknown) => {
      this.#active.delete(id);
      throw error;
    });
    const name = containerName(id);
    const args = buildRunArgs({
      name,
      image: this.image(language),
      labels: this.#labels("pool", id),
      workDir: dirs.workDir,
      codeDir: dirs.codeDir,
      toolsDir: null,
      user: this.#user,
      limits: this.#config.limits,
      command: standbyCommand(entryCommand(language)),
      env: CONTAINER_ENV,
    });
    const cli = new AbortController();
    let send: (stdin: string | null) => void = () => {};
    const stdinLater = new Promise<string | null>((resolve) => {
      send = resolve;
    });
    // The run's output-limit kill, once it has one.
    const wiring = { onOutputLimit: () => {} };
    let up: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      up = resolve;
    });
    let first = true;
    const result = this.#runner.exec(args, {
      stdinLater,
      signal: cli.signal,
      maxOutputBytes: this.#config.caps.max_output_bytes,
      outputLimit: {
        bytes: this.#config.caps.kill_output_bytes,
        onExceeded: () => wiring.onOutputLimit(),
      },
      onData: (stream, chunk) => {
        if (stream !== "stderr" || !first) return;
        first = false;
        up(chunk[0] === STANDBY_READY);
      },
    });
    const entry: Standby = {
      id,
      name,
      language,
      dirs,
      result,
      exited: false,
      go: (stdin, w) => {
        wiring.onOutputLimit = w.onOutputLimit;
        if (w.signal.aborted) cli.abort();
        else w.signal.addEventListener("abort", () => cli.abort(), { once: true });
        send(`\n${stdin}`);
        return result;
      },
      abort: () => {
        send(null);
        cli.abort();
      },
    };
    void result.then(() => {
      entry.exited = true;
      up(false);
    });
    const timer = setTimeout(() => up(false), START_TIMEOUT_MS);
    const onClose = () => up(false);
    this.#closing.signal.addEventListener("abort", onClose, { once: true });
    const ok = await ready;
    clearTimeout(timer);
    this.#closing.signal.removeEventListener("abort", onClose);
    if (!ok) {
      await this.#discardPooled(entry);
      const failure = why(await result);
      throw new SandboxError(
        "docker_failed",
        `cannot start a pooled container: ${failure.slice(0, 300)}`,
      );
    }
    return entry;
  }

  async #discardPooled(entry: Standby): Promise<void> {
    await this.#control(removeArgs([entry.name])).catch(() => undefined);
    entry.abort();
    await entry.result;
    await removeDir(entry.dirs.dir);
    this.#active.delete(entry.id);
  }

  /** A fresh run in a pooled container: its program and inputs go in, then the go line. */
  async #runPooled(entry: Standby, r: Validated, signal: AbortSignal): Promise<RunResult> {
    let sent = false;
    try {
      if (entry.exited) throw new ContainerGoneError("the pooled container ended before its run");
      await writeProgram(entry.dirs.codeDir, r.language, r.code);
      const inputs = await writeInputs(entry.dirs.workDir, r.files, this.#config.caps);
      const result = await this.#execute(
        entry.id,
        r,
        {
          start: (options) => {
            sent = true;
            return entry.go(options.stdin ?? "", {
              signal: options.signal ?? new AbortController().signal,
              onOutputLimit: options.outputLimit?.onExceeded ?? (() => {}),
            });
          },
          kill: () => this.#control(killArgs(entry.name)),
          hung: () => this.#control(removeArgs([entry.name])),
          container: null,
          standby: true,
        },
        signal,
      );
      // Its CLI returned, so the container ended with the program: nothing it started is left
      // to change the outputs while they are read.
      return await this.#finishRun(result, entry.dirs.workDir, inputs);
    } finally {
      if (!sent) {
        // Never used (bad input, aborted, already gone), and never to be used.
        await this.#control(removeArgs([entry.name])).catch(() => undefined);
        entry.abort();
      }
      await this.#releaseRunDirs(entry.id, entry.dirs);
    }
  }

  /** Whether a container still runs: `gone` (no such container), `unknown` (Docker failed). */
  async #state(name: string): Promise<"running" | "stopped" | "gone" | "unknown"> {
    const result = await this.#control(runningArgs(name)).catch(() => null);
    if (result === null) return "unknown";
    if (result.exit_code === 0) {
      return decodeOutput(result.stdout).trim() === "true" ? "running" : "stopped";
    }
    return /no such (container|object)/i.test(decodeOutput(result.stderr)) ? "gone" : "unknown";
  }

  /** `docker run -d` of a session container (its keeper waits for `docker exec`). */
  async #startKeeper(
    id: string,
    language: Language,
    dirs: RunDirs,
    user: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const name = containerName(id);
    const args = buildRunArgs({
      name,
      image: this.image(language),
      labels,
      workDir: dirs.workDir,
      codeDir: dirs.codeDir,
      toolsDir: null,
      user,
      limits: this.#config.limits,
      command: KEEPER_COMMAND,
      env: CONTAINER_ENV,
      detached: true,
    });
    const started = await this.#control(args, this.#closing.signal, START_TIMEOUT_MS);
    if (started.exit_code !== 0 || started.error !== null) {
      await this.#control(removeArgs([name])).catch(() => undefined);
      throw new SandboxError("docker_failed", `cannot start a container: ${why(started)}`);
    }
  }

  /** Runs one program (`launch`) under the wall-clock, abort and output limits. */
  async #execute(
    runId: string,
    r: Pick<Validated, "language" | "timeout_ms" | "stdin">,
    launch: Launch,
    signal: AbortSignal,
  ): Promise<Executed> {
    if (signal.aborted) {
      return {
        run_id: runId,
        language: r.language,
        exit_code: null,
        stdout: "",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 0,
        killed_reason: "aborted",
      };
    }

    // Object fields, not `let`s: the kill callbacks set them, and TypeScript does not see that.
    const state: { killed: KilledReason | null; killing: Promise<void> | null } = {
      killed: null,
      killing: null,
    };
    const cli = new AbortController();
    const kill = (reason: KilledReason) => {
      if (state.killed !== null) return;
      state.killed = reason;
      state.killing = (async () => {
        await launch.kill().catch(() => undefined);
        // The CLI normally exits right after the kill; if it hangs, drop it and make sure the
        // container is gone.
        try {
          await sleep(this.#killGraceMs, cli.signal);
        } catch {
          return;
        }
        cli.abort();
        await launch.hung().catch(() => undefined);
      })();
    };
    const timer = setTimeout(() => kill("timeout"), r.timeout_ms);
    const onAbort = () => kill("aborted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const started = this.#clock.now();
    let result: ExecResult;
    try {
      result = await launch.start({
        stdin: r.stdin,
        signal: cli.signal,
        maxOutputBytes: this.#config.caps.max_output_bytes,
        outputLimit: {
          bytes: this.#config.caps.kill_output_bytes,
          onExceeded: () => kill("output_limit"),
        },
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const duration = this.#clock.now() - started;
    // Stop the grace timer of a kill that already worked.
    if (!cli.signal.aborted) cli.abort();
    await state.killing;
    if (launch.standby && result.stderr[0] === STANDBY_READY) {
      result = {
        ...result,
        stderr: result.stderr.subarray(1),
        stderr_bytes: result.stderr_bytes - 1,
      };
    }

    if (state.killed === null) {
      if (launch.container === null) {
        const failure = dockerFailure(result);
        if (failure !== null) {
          throw new SandboxError("docker_failed", `docker run failed: ${failure.slice(0, 500)}`);
        }
      } else if (
        result.error !== null ||
        (result.exit_code !== 0 && DAEMON_ERROR.test(decodeOutput(result.stderr)))
      ) {
        // The program can print the same text, so ask Docker whether the container is there.
        const where = await this.#state(launch.container);
        const text = (result.error ?? decodeOutput(result.stderr).trim()).slice(0, 500);
        if (where === "gone" || where === "stopped") throw new ContainerGoneError(text);
        if (where === "unknown")
          throw new SandboxError("docker_failed", `docker exec failed: ${text}`);
      }
    }
    const exitCode = result.exit_code;
    const reason: KilledReason | null = state.killed ?? (exitCode === 137 ? "memory" : null);
    const max = this.#config.caps.max_output_bytes;
    return {
      run_id: runId,
      language: r.language,
      exit_code: exitCode,
      stdout: decodeOutput(result.stdout),
      stderr: decodeOutput(result.stderr),
      stdout_truncated: result.stdout_bytes > max,
      stderr_truncated: result.stderr_bytes > max,
      duration_ms: duration,
      killed_reason: reason,
    };
  }

  // ---- Sessions ---------------------------------------------------------------------------

  #expiry(session: Session, now: number): SessionCloseReason | null {
    const cfg = this.#config.sessions;
    if (now - session.created_at >= cfg.lifetime_minutes * 60_000) return "lifetime";
    if (now - session.last_used_at >= cfg.idle_minutes * 60_000) return "idle";
    return null;
  }

  #busy(session: Session): boolean {
    return session.current !== null || session.lock.waiting > 0;
  }

  async #runInSession(r: Validated, signal: AbortSignal): Promise<RunResult> {
    const name = r.session;
    const cfg = this.#config.sessions;
    let session = this.#sessions.get(name);
    if (!session) {
      const gone = this.#tombstones.get(name);
      if (gone !== undefined) {
        // Told once; the next run with this name starts a new session.
        this.#tombstones.delete(name);
        throw sessionClosed(name, gone);
      }
      if (cfg.max === 0) throw new SandboxError("limit", "sessions are turned off");
      if (this.#sessions.size >= cfg.max) {
        throw new SandboxError(
          "limit",
          `at most ${cfg.max} sessions at once (open: ${[...this.#sessions.keys()].join(", ")}); ` +
            "close one first",
        );
      }
      const now = this.#clock.now();
      session = {
        name,
        language: r.language,
        id: newId(),
        container: "",
        dirs: null,
        created_at: now,
        last_used_at: now,
        runs: 0,
        disk_bytes: 0,
        lock: new Semaphore(1, this.#config.max_queued),
        ended: new AbortController(),
        closed: null,
        current: null,
        disposed: null,
      };
      session.container = containerName(session.id);
      this.#sessions.set(name, session);
      this.#syncSweep();
    }
    if (session.language !== r.language) {
      throw new SandboxError(
        "invalid_request",
        `session \`${name}\` runs ${session.language}; use another session name for ${r.language}`,
      );
    }
    const runSignal = AbortSignal.any([signal, session.ended.signal]);
    let unlock: (() => void) | null;
    try {
      unlock = await session.lock.acquire(runSignal);
    } catch (error) {
      if (session.closed !== null) throw sessionClosed(name, session.closed);
      throw new SandboxError("closed", "the run was cancelled while waiting", { cause: error });
    }
    if (unlock === null)
      throw new SandboxError("busy", `session \`${name}\` has too many runs waiting`);
    const task = this.#sessionRun(session, r, runSignal);
    session.current = task;
    try {
      return await task;
    } finally {
      session.current = null;
      unlock();
      this.#syncSweep();
    }
  }

  async #sessionRun(session: Session, r: Validated, signal: AbortSignal): Promise<RunResult> {
    if (session.closed !== null) throw sessionClosed(session.name, session.closed);
    const expired = this.#expiry(session, this.#clock.now());
    if (expired !== null) {
      await this.#endInside(session, expired);
      throw sessionClosed(session.name, expired);
    }
    let release: () => void;
    try {
      release = await this.#slot(signal);
    } catch (error) {
      if (session.closed !== null) throw sessionClosed(session.name, session.closed);
      throw error;
    }
    try {
      await this.ensureImage(r.language, signal);
      let created = false;
      if (session.dirs === null) {
        await this.#startSession(session);
        created = true;
      }
      return await this.#execInSession(session, r, signal, created);
    } catch (error) {
      if (error instanceof ContainerGoneError) {
        log.warn({ session: session.name, err: error.message }, "a session's container was gone");
        await this.#endInside(session, "lost");
        throw sessionClosed(session.name, "lost");
      }
      throw error;
    } finally {
      release();
    }
  }

  async #startSession(session: Session): Promise<void> {
    try {
      session.dirs = await createSessionDirs(this.#sessionsDir, session.id);
      // The keeper runs as another uid than her programs, so `killAllArgs` spares it.
      await this.#startKeeper(
        session.id,
        session.language,
        session.dirs,
        keeperUser(this.#user),
        this.#labels("session", session.id, session.name),
      );
    } catch (error) {
      // Never started: no tombstone, the next run tries again.
      this.#markEnded(session, "lost", false);
      await this.#disposeSession(session);
      throw error;
    }
    log.info({ session: session.name, language: session.language }, "sandbox session started");
    this.#publish("sandbox.session.started", { name: session.name, language: session.language });
  }

  async #execInSession(
    session: Session,
    r: Validated,
    signal: AbortSignal,
    created: boolean,
  ): Promise<RunResult> {
    const dirs = session.dirs as RunDirs;
    const container = session.container;
    const runId = newId();
    const entry = ENTRY_FILE[r.language];
    const file = `run-${runId.toLowerCase()}${entry.slice(entry.lastIndexOf("."))}`;
    const caps = this.#config.caps;
    await writeProgram(dirs.codeDir, r.language, r.code, file);
    try {
      const inputs = await writeInputs(dirs.workDir, r.files, caps, { replace: true });
      const before = signatures(await walkWork(dirs.workDir, MAX_SESSION_ENTRIES));
      let hung = false;
      const execute = execArgs(container, entryCommand(r.language, file), this.#user);
      const result = await this.#execute(
        runId,
        r,
        {
          start: (options) => this.#runner.exec(execute, options),
          kill: () => this.#control(killAllArgs(container, this.#user)),
          hung: async () => {
            hung = true;
            await this.#control(removeArgs([container]));
          },
          container,
        },
        signal,
      );
      // Nothing a run starts outlives it, and nothing changes the files while they are read.
      const cleared =
        !hung &&
        (await this.#control(killAllArgs(container, this.#user)).catch(() => null))?.exit_code ===
          0;
      if (!cleared) {
        await this.#endInside(session, "lost");
        return this.#done({
          ...result,
          files_out: [],
          files_out_truncated: true,
          session: { name: session.name, created, closed: "lost" },
        });
      }
      const walked = await walkWork(dirs.workDir, MAX_SESSION_ENTRIES);
      const outputs =
        result.exit_code === null && result.killed_reason === "aborted"
          ? { files: [], truncated: false }
          : await collectOutputs(dirs.workDir, inputs, caps, { before, walked });
      session.runs++;
      session.last_used_at = this.#clock.now();
      session.disk_bytes = walked.bytes;
      let closed = session.closed;
      const quota = this.#config.sessions.disk_mb * MIB;
      if (closed === null && (walked.bytes > quota || walked.entries > MAX_SESSION_ENTRIES)) {
        log.info(
          { session: session.name, bytes: walked.bytes, entries: walked.entries },
          "a session's workspace is over its quota; closing it",
        );
        closed = "disk";
        await this.#endInside(session, "disk");
      }
      return this.#done({
        ...result,
        files_out: outputs.files,
        files_out_truncated: outputs.truncated,
        session: { name: session.name, created, closed },
      });
    } finally {
      await rm(join(dirs.codeDir, file), { force: true }).catch(() => undefined);
    }
  }

  /** Marks a session closed: no new runs, the running and waiting ones are aborted. */
  #markEnded(session: Session, reason: SessionCloseReason, tombstone: boolean): void {
    if (session.closed !== null) return;
    session.closed = reason;
    if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
    if (tombstone) {
      this.#tombstones.delete(session.name);
      this.#tombstones.set(session.name, reason);
      for (const old of this.#tombstones.keys()) {
        if (this.#tombstones.size <= MAX_TOMBSTONES) break;
        this.#tombstones.delete(old);
      }
    }
    session.ended.abort(sessionClosed(session.name, reason));
    this.#syncSweep();
    if (session.dirs !== null) {
      log.info({ session: session.name, reason, runs: session.runs }, "sandbox session closed");
      this.#publish("sandbox.session.closed", {
        name: session.name,
        reason,
        runs: session.runs,
      });
    }
  }

  /** Removes a session's container and workspace (once). */
  #disposeSession(session: Session): Promise<void> {
    session.disposed ??= (async () => {
      if (session.dirs === null) return;
      await this.#control(removeArgs([session.container])).catch(() => undefined);
      await removeDir(session.dirs.dir);
    })();
    return session.disposed;
  }

  /** Ends a session from inside its own run (it is told in that run's result or error). */
  async #endInside(session: Session, reason: SessionCloseReason): Promise<void> {
    this.#markEnded(session, reason, false);
    await this.#disposeSession(session);
  }

  /** Ends a session from outside: its running run is aborted and awaited first. */
  async #end(session: Session, reason: SessionCloseReason, tombstone: boolean): Promise<void> {
    this.#markEnded(session, reason, tombstone);
    await session.current?.catch(() => undefined);
    await this.#disposeSession(session);
  }

  /**
   * Closes sessions past their idle time or lifetime (not while a run uses them; the next run
   * finds them expired). She is told when she next uses the name. Runs on a timer while any
   * session is open. Returns how many were closed.
   */
  async sweepSessions(): Promise<number> {
    const now = this.#clock.now();
    const ends: Promise<void>[] = [];
    for (const session of [...this.#sessions.values()]) {
      const reason = this.#expiry(session, now);
      if (reason !== null && !this.#busy(session)) ends.push(this.#end(session, reason, true));
    }
    await Promise.all(ends);
    return ends.length;
  }

  /** Keeps the expiry timer running exactly while sessions are open. */
  #syncSweep(): void {
    if (this.#sessions.size > 0 && this.#sweep === null && !this.#closing.signal.aborted) {
      const cfg = this.#config.sessions;
      const shortest = Math.min(cfg.idle_minutes, cfg.lifetime_minutes) * 60_000;
      const every = Math.min(30_000, Math.max(1000, Math.floor(shortest / 4)));
      this.#sweep = setInterval(() => {
        this.sweepSessions().catch((error: unknown) => {
          log.warn({ err: errorMessage(error) }, "closing expired sessions failed");
        });
      }, every);
      this.#sweep.unref?.();
    } else if (this.#sessions.size === 0 && this.#sweep !== null) {
      clearInterval(this.#sweep);
      this.#sweep = null;
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.sweepSessions();
    const cfg = this.#config.sessions;
    return [...this.#sessions.values()]
      .sort((a, b) => a.created_at - b.created_at)
      .map((s) => ({
        name: s.name,
        language: s.language,
        created_at: s.created_at,
        last_used_at: s.last_used_at,
        runs: s.runs,
        disk_bytes: s.disk_bytes,
        expires_at: Math.min(
          s.last_used_at + cfg.idle_minutes * 60_000,
          s.created_at + cfg.lifetime_minutes * 60_000,
        ),
        busy: this.#busy(s),
      }));
  }

  async closeSession(name: string): Promise<boolean> {
    const session = this.#sessions.get(name);
    this.#tombstones.delete(name);
    if (!session) return false;
    await this.#end(session, "closed", false);
    return true;
  }

  /**
   * Kills every running program (`aborted`), refuses new runs, and removes the pool's and the
   * sessions' containers and workspaces.
   */
  async close(): Promise<void> {
    this.#closing.abort(new SandboxError("closed", "the sandbox is shut down"));
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) this.#markEnded(session, "shutdown", false);
    await Promise.allSettled([...this.#inFlight]);
    await Promise.all([
      this.#pool.close(),
      ...sessions.map((session) => this.#end(session, "shutdown", false)),
    ]);
    if (this.#egressTouched) await this.#teardownEgress();
    if (this.#sweep !== null) clearInterval(this.#sweep);
    this.#sweep = null;
  }
}
