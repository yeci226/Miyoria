// The daemon: one per workspace folder (docs/design/v5-hostd.md §4). It loads `host.toml` and the
// catalog, supervises the services, serves the local API, writes `run/hostd.json`, and is the
// `HostApi` the control link talks to. `miyoria hostd`, `miyoria up` (detached) and
// `miyoria up --foreground` all run this class; tests run it in-process.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import {
  HOST_ERROR_CODE,
  HOST_FETCH_LIMITS,
  HOST_METHOD,
  HOST_PROTOCOL_VERSION,
  type HostCheckout,
  type HostClusterContext,
  type HostGuardState,
  type HostInfo,
  type HostLinkState,
  type HostLinks,
  type HostRelinkResult,
  type HostRemoteUpdate,
  type HostReport,
  type HostServiceControlResult,
  HostServiceControlSchema,
  type HostServiceEvent,
  type HostServiceInstallResult,
  HostServiceInstallSchema,
  type HostServiceList,
  type HostServiceLogsResult,
  HostServiceLogsSchema,
  type HostServiceRemoveResult,
  HostServiceRemoveSchema,
  type HostShutdownResult,
  HostShutdownSchema,
  type HostUpdateResult,
  HostUpdateSchema,
  type HostUpgradeCancelResult,
  type HostUpgradeMissing,
  HostUpgradeSchema,
} from "@miyoria/contracts/host";
import { type Logger, pino } from "pino";
import type { RotatingFileStream } from "rotating-file-stream";
import { type ZodType, z } from "zod";
import {
  type Caller,
  type ClusterClient,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "./api.js";
import { type Catalog, type LinkPlaceholder, loadCatalog, placeholdersIn } from "./catalog.js";
import { HostdClient } from "./client.js";
import { createGateway } from "./gateway.js";
import { CardReader, cudaIndex, freeOf, GpuCache, type GpuReader, type GpuSample } from "./gpu.js";
import { type ArbiterService, GPU_PROFILE_FILE, GpuArbitration } from "./gpu-arbiter.js";
import { coreStatusGuard, guardedMessage, guardUnknownMessage } from "./guard.js";
import { type LoadedHostConfig, loadHostConfig } from "./host-config.js";
import {
  type CommandRunner,
  execaRunner,
  type InstallDeps,
  inspectService,
  installService,
  removeService,
} from "./install/index.js";
import { CoreLink, type CoreLinkOptions, type CoreLinkState } from "./link/index.js";
import { linkValues } from "./links.js";
import { rotatingLog, ServiceLog } from "./logs.js";
import { localAddress } from "./ports.js";
import {
  localUrl,
  offloadUrls,
  planServices,
  type ResolveContext,
  type ServicePlan,
} from "./resolve.js";
import { type LoadedRoutes, loadRoutes, reachOf, reportRoutes, withLocal } from "./routes.js";
import { serviceRouting, VariantHasher } from "./routing.js";
import {
  pidAlive,
  type RunInfo,
  readRunFile,
  removeRunFile,
  runFilePath,
  writeRunFile,
} from "./run-file.js";
import { createLocalApi, JSON_RPC } from "./server.js";
import { DEFAULT_TIMING, ManagedService, type ServiceHost, type Timing } from "./service.js";
import { readCheckout } from "./upgrade/git.js";
import { type UpgradeHost, Upgrader } from "./upgrade/upgrader.js";

export interface DaemonOptions {
  /** `host.toml`; its folder is the workspace. */
  hostConfig: string;
  /** The folder holding the catalog roots (`workers/*`, `apps/*`, …). */
  catalogRoot: string;
  /** The Core config path, `{config}`. */
  configPath: string;
  /**
   * How this CLI is started, `{miyoria}`: the program and its leading arguments, e.g.
   * `[process.execPath, ...process.execArgv, process.argv[1]]`.
   */
  miyoria: readonly string[];
  /** The daemon's version in `host.info` and the run file. */
  version?: string;
  /** The environment services inherit from (default `process.env`). */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /**
   * Reads the graphics card, for `host.info` and the GPU arbiter (default NVML through `koffi`,
   * else `nvidia-smi`). `null` from it means the card cannot be read.
   */
  readGpu?: GpuReader;
  timing?: Partial<Timing>;
  /**
   * Called after `host.shutdown` stopped every service, once its answer is sent. The default
   * stops the daemon (`stop()`); `miyoria hostd` also exits the process.
   */
  onShutdown?: () => void | Promise<void>;
  /** What installing needs from outside (the runner, the downloads, PATH); tests replace these. */
  installDeps?: Omit<InstallDeps, "root">;
  /** Makes the control link (tests). Default a `CoreLink`. */
  linkFactory?: (api: HostApi, options: CoreLinkOptions) => LinkHandle;
  /** What reading the checkout and a remote update (`host.upgrade`) use; tests replace these. */
  upgrade?: UpgradeOptions;
}

/** The seams of the checkout reading and of `host.upgrade`. */
export interface UpgradeOptions {
  /** Runs git and pnpm (default the installer's runner, else execa). */
  runner?: CommandRunner;
  /** Asks a service's health for `busy` (default `fetch`). */
  fetch?: typeof fetch;
  /** How often the checkout is read again for the report. Default 60 s. */
  checkoutEveryMs?: number;
  /** How often a waiting update asks whether the host is idle. Default 5 s. */
  pollMs?: number;
  /** How long restarted services have to become healthy. Default 10 minutes. */
  healthyMs?: number;
  /** The pnpm program. */
  pnpm?: string;
}

/** What the daemon needs of its control link; `CoreLink` is one. */
export interface LinkHandle {
  readonly state: CoreLinkState;
  start(): void;
  stop(): Promise<void>;
}

/** The status reason of a node that runs with older link values than Core's (H4b). */
export const LINKS_CHANGED_REASON = "連線資訊已更新,需要重啟";

/** The file Core's join writes into the state folder (H5). */
export const HOST_KEY_FILE = "host.key";

/** `<state>/host.key`: the id Core gave this host and its key. */
export const HostKeySchema = z.object({ id: z.string().min(1), key: z.string().min(1) });
export type HostKey = z.output<typeof HostKeySchema>;

/** The host key of a state folder; `null` when there is none. Throws when it is unreadable. */
export function readHostKey(stateDir: string): HostKey | null {
  const file = join(stateDir, HOST_KEY_FILE);
  if (!existsSync(file)) return null;
  return HostKeySchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Another daemon of the same workspace answers. */
export class HostdRunningError extends Error {
  override name = "HostdRunningError";
  readonly info: RunInfo;

  constructor(info: RunInfo) {
    super(`hostd already runs for this workspace (pid ${info.pid}, port ${info.port})`);
    this.info = info;
  }
}

/** The methods the daemon serves now; the others of `HOST_METHOD` come in later steps. */
const SERVED: ReadonlySet<string> = new Set([
  HOST_METHOD.Info,
  HOST_METHOD.ServiceList,
  HOST_METHOD.ServiceStart,
  HOST_METHOD.ServiceStop,
  HOST_METHOD.ServiceRestart,
  HOST_METHOD.ServiceLogs,
  HOST_METHOD.HostShutdown,
  HOST_METHOD.HostRelink,
  HOST_METHOD.ServiceInstall,
  HOST_METHOD.ServiceRemove,
  HOST_METHOD.HostUpdate,
  HOST_METHOD.ClusterResolve,
  HOST_METHOD.ClusterLlm,
  HOST_METHOD.ClusterFetch,
  HOST_METHOD.GpuAcquire,
  HOST_METHOD.GpuRenew,
  HOST_METHOD.GpuRelease,
  HOST_METHOD.GpuBusy,
  HOST_METHOD.GpuState,
  HOST_METHOD.HostUpgrade,
  HOST_METHOD.HostUpgradeCancel,
]);

/**
 * Methods only Core may call: the operator on this machine updates with `miyoria update`, which
 * asks before it downloads and shows everything it does.
 */
const CORE_ONLY: ReadonlySet<string> = new Set([HOST_METHOD.HostUpgrade]);

/** The lease methods: a holder service's only (`gpu.state` may be read by the operator and Core). */
const GPU_LEASE: ReadonlySet<string> = new Set([
  HOST_METHOD.GpuAcquire,
  HOST_METHOD.GpuRenew,
  HOST_METHOD.GpuRelease,
  HOST_METHOD.GpuBusy,
]);

/** Service states in which its process is gone: a lease it held is over. */
const GONE: ReadonlySet<string> = new Set(["stopped", "backoff", "failed", "disabled"]);

/**
 * Methods Core serves that hostd passes on for the services of this machine (and the operator,
 * for debugging), adding which service asked. Core's own calls never come back this way.
 */
const FORWARDED: ReadonlySet<string> = new Set([
  HOST_METHOD.ClusterResolve,
  HOST_METHOD.ClusterLlm,
  HOST_METHOD.ClusterFetch,
]);

/** How long Core may take for a forwarded call: a completion, or a fetch's head and body. */
const FORWARD_TIMEOUT_MS: Readonly<Record<string, number>> = {
  [HOST_METHOD.ClusterLlm]: 180_000,
  [HOST_METHOD.ClusterFetch]: 2 * HOST_FETCH_LIMITS.HEAD_TIMEOUT_MS + 15_000,
};

/** Methods only the operator on this machine may call (they change what is installed here). */
const OPERATOR_ONLY: ReadonlySet<string> = new Set([
  HOST_METHOD.HostShutdown,
  HOST_METHOD.HostRelink,
  HOST_METHOD.ServiceInstall,
  HOST_METHOD.ServiceRemove,
  HOST_METHOD.HostUpdate,
]);

function allowed(caller: Caller, method: string): boolean {
  switch (caller.kind) {
    case "operator":
      return !GPU_LEASE.has(method) && !CORE_ONLY.has(method);
    case "core":
      return !OPERATOR_ONLY.has(method) && !FORWARDED.has(method) && !GPU_LEASE.has(method);
    case "service":
      // A service may use `gpu.*` only when it may hold the card; the call checks that.
      return FORWARDED.has(method) || GPU_LEASE.has(method) || method === HOST_METHOD.GpuState;
  }
}

function parseParams<T>(schema: ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new HostRpcError(
      JSON_RPC.InvalidParams,
      parsed.error.issues
        .map((i) => `${i.path.map(String).join(".") || "params"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Daemon implements HostApi {
  readonly #options: DaemonOptions;
  readonly #token = randomBytes(32).toString("base64url");
  /** What the services of this machine send to each other until they stop calling each other. */
  readonly #hostToken = randomBytes(24).toString("base64url");
  readonly #timing: Timing;
  readonly #gpu: GpuCache;
  /** How the card is read; set at start unless the options gave one. */
  #readCard: GpuReader | null;
  #cardReader: CardReader | null = null;
  /** GPU arbitration (H7); made at start. */
  #arbitration: GpuArbitration | null = null;
  readonly #events = new Set<(event: HostServiceEvent) => void>();
  readonly #changes = new Set<() => void>();
  readonly #services = new Map<string, ManagedService>();
  /** Service names in the order their processes were first spawned. */
  readonly #spawnOrder: string[] = [];
  #host: LoadedHostConfig | null = null;
  #catalog: Catalog | null = null;
  #server: Server | null = null;
  #port = 0;
  #runFile = "";
  #startedAt = "";
  #log: Logger = pino({ enabled: false });
  #logStream: RotatingFileStream | null = null;
  #guard: GuardSource | null = null;
  #defaultGuard: GuardSource;
  #cluster: ClusterClient | null = null;
  #link: LinkHandle | null = null;
  #stopping: Promise<void> | null = null;
  #ctx: ResolveContext | null = null;
  #serviceHost: ServiceHost | null = null;
  /** Serialises installs and updates: two `uv sync` into one cache and one environment do not mix. */
  #installing: Promise<unknown> = Promise.resolve();
  /** Serialises `host.relink`: two calls at once would leave two links. */
  #relinking: Promise<unknown> = Promise.resolve();
  /** What Core last told this host about its node links (`cluster.links`); kept across redials. */
  #links: HostLinks["links"] = {};
  /** Serialises the restarts new link values cause. */
  #linkChecks: Promise<unknown> = Promise.resolve();
  /** The checkout as last read; `null` when it is not one, `undefined` before the first read. */
  #checkout: HostCheckout | null | undefined = undefined;
  #checkoutTimer: ReturnType<typeof setInterval> | null = null;
  /** Looks at the services' `[routing]` readiness and variant again (a file that appeared). */
  #routingTimer: ReturnType<typeof setInterval> | null = null;
  /** What that look found last, as JSON. */
  #routingSeen = "";
  #checkoutReading: Promise<void> | null = null;
  /**
   * `host.toml [update] allow_remote` (default `true`, also without the table), read at start and
   * with each checkout reading. `false` until the file was read.
   */
  #allowRemote = false;
  /** `host.upgrade` (v5-hostd §14); made at start. */
  #upgrader: Upgrader | null = null;
  /** The variant hashes of `[routing]` (v5-hostd §15), with what they read cached. */
  readonly #variants = new VariantHasher();
  /** The card's total memory as last read, to tell when it changed. */
  #gpuTotal: number | null = null;
  /** `routes.toml` as read at start (v5-hostd §16); `null` without the file. */
  #routes: LoadedRoutes | null = null;
  /** What Core sends to probe the gateway; only Core learns it, over the control link. */
  readonly #routeToken = randomBytes(24).toString("base64url");
  /** The gateway of the `direct` and `tunnel` routes while it listens. */
  #gateway: Server | null = null;
  /** Why the gateway does not listen, when a route needs it. */
  #gatewayProblem: string | null = null;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#readCard = options.readGpu ?? null;
    this.#gpu = new GpuCache(() => this.#readGpu());
    this.#defaultGuard = coreStatusGuard(() => {
      const core = this.#services.get("core");
      const port = core?.port;
      if (core === undefined || port === undefined || this.#host === null) return null;
      return localUrl(this.#host.config.network.bind, port);
    });
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /**
   * Loads `host.toml` and the catalog, listens, writes the run file. Starts no service: that is
   * `startAll` or `service.start`. Throws `HostConfigError` or `HostdRunningError`.
   */
  async start(): Promise<void> {
    const host = loadHostConfig(this.#options.hostConfig);
    this.#host = host;
    this.#runFile = runFilePath(host.state.root);
    const existing = readRunFile(this.#runFile);
    if (
      existing !== null &&
      pidAlive(existing.pid) &&
      (await new HostdClient(existing).ping(2000))
    ) {
      throw new HostdRunningError(existing);
    }

    mkdirSync(host.state.logs, { recursive: true });
    this.#logStream = rotatingLog(host.state.logs, "hostd.log");
    (this.#logStream as Writable).on("error", () => {
      // The daemon keeps running without its own log.
    });
    this.#log = pino(
      { base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.isoTime },
      this.#logStream,
    );

    this.#routes = loadRoutes({
      workspace: host.workspace,
      advertise: host.config.network.advertise,
      bind: host.config.network.bind,
    });
    for (const problem of this.#routes?.problems ?? []) {
      this.#log.warn({ file: this.#routes?.file, problem }, "routes problem");
    }

    const catalog = loadCatalog(this.#options.catalogRoot);
    this.#catalog = catalog;
    for (const problem of catalog.problems) {
      this.#log.warn({ file: problem.file, problem: problem.message }, "descriptor problem");
    }
    const ctx: ResolveContext = {
      workspace: host.workspace,
      state: host.state.root,
      bind: host.config.network.bind,
      configPath: resolve(this.#options.configPath),
      miyoria: this.#options.miyoria,
      node: process.execPath,
      env: this.#options.env ?? process.env,
      platform: this.#options.platform ?? process.platform,
      ...(host.config.paths.ca_bundle !== undefined
        ? { caBundle: resolve(host.workspace, host.config.paths.ca_bundle) }
        : {}),
    };
    const serviceHost: ServiceHost = {
      ctx,
      advertise: host.config.network.advertise,
      coreIsLocal: () => isLoopbackUrl(this.#host?.config.cluster?.url),
      timing: this.#timing,
      log: this.#log,
      hostdUrl: () => `http://127.0.0.1:${this.#port}`,
      hostToken: () => this.#hostToken,
      links: () => this.linkValues(),
      offloadUrls: () =>
        offloadUrls(
          [...this.#services.values()].map((s) => s.plan),
          (plan) => this.#services.get(plan.name)?.port,
          ctx.bind,
        ),
      gpuArbiter: () => this.#arbitration?.mode ?? host.config.gpu.arbiter,
      leased: (name) => this.#arbitration?.holds(name) ?? false,
      service: (name) => this.#services.get(name),
      emit: (event) => {
        // A node that came up with older link values than Core's latest gets them now.
        if (event.state === "running") this.#queueLinkCheck([event.service]);
        this.#syncArbiter();
        // A holder whose process is gone holds nothing: speech comes back now.
        if (GONE.has(event.state) && this.#arbitration?.isHolder(event.service)) {
          this.#arbitration.holderGone(event.service);
        }
        for (const listener of this.#events) {
          try {
            listener(event);
          } catch (error) {
            this.#log.error({ err: error }, "event listener failed");
          }
        }
      },
      changed: () => {
        this.#syncArbiter();
        for (const listener of this.#changes) {
          try {
            listener();
          } catch (error) {
            this.#log.error({ err: error }, "change listener failed");
          }
        }
      },
      spawned: (name) => {
        if (!this.#spawnOrder.includes(name)) this.#spawnOrder.push(name);
      },
      routing: (service) => this.#routingOf(service),
      outside: (name) => this.#outside(name),
      reach: (service, port) => this.#reachOf(service.name, port),
    };
    this.#ctx = ctx;
    this.#serviceHost = serviceHost;
    for (const plan of planServices(catalog, host, ctx)) {
      this.#services.set(plan.name, this.#manage(plan));
      if (plan.disabled !== null) {
        this.#log.info({ service: plan.name, reason: plan.disabled }, "service disabled");
      }
    }

    if (this.#readCard === null) {
      const card = new CardReader({
        index: cudaIndex(this.#cardEnv(ctx)),
        platform: ctx.platform,
        env: ctx.env,
      });
      this.#cardReader = card;
      this.#readCard = card.read;
    }
    this.#arbitration = new GpuArbitration({
      mode: host.config.gpu.arbiter,
      read: () => this.#readGpu(),
      target: (name) => this.target(name),
      profileFile: join(host.state.root, GPU_PROFILE_FILE),
      log: this.#log,
      changed: () => serviceHost.changed(),
    });
    this.#syncArbiter();

    const server = createLocalApi({
      authenticate: (token) => this.#authenticate(token),
      call: (method, params, caller, signal, onLine) =>
        this.call(method, params, caller, signal, onLine),
      hasService: (name) => this.#services.has(name),
      tailLogs: (name, lines) => this.#services.get(name)?.logs.tail(lines) ?? [],
      followLogs: (name, listener) => this.followLogs(name, listener),
      onError: (error) => this.#log.error({ err: error }, "local API failed"),
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        server.off("error", fail);
        done();
      });
    });
    const address = server.address();
    this.#port = typeof address === "object" && address !== null ? address.port : 0;
    this.#server = server;
    this.#startedAt = new Date().toISOString();
    writeRunFile(this.#runFile, {
      pid: process.pid,
      port: this.#port,
      token: this.#token,
      started_at: this.#startedAt,
      version: this.version,
      workspace: host.workspace,
    });

    await this.#startGateway();
    for (const service of this.#services.values()) service.watchExternal();
    this.#allowRemote = host.config.update.allow_remote;
    this.#upgrader = new Upgrader({
      root: this.#options.catalogRoot,
      runner: this.#upgradeRunner(),
      env: ctx.env,
      platform: ctx.platform,
      host: this.#upgradeHost(),
      ...(this.#options.upgrade?.pollMs !== undefined
        ? { pollMs: this.#options.upgrade.pollMs }
        : {}),
      ...(this.#options.upgrade?.healthyMs !== undefined
        ? { healthyMs: this.#options.upgrade.healthyMs }
        : {}),
      ...(this.#options.upgrade?.pnpm !== undefined ? { pnpm: this.#options.upgrade.pnpm } : {}),
    });
    // The first reading before the link's first report, so Core sees the version at once.
    await this.#readCheckout();
    const every = this.#options.upgrade?.checkoutEveryMs ?? 60_000;
    this.#checkoutTimer = setInterval(() => void this.#readCheckout(), every);
    this.#checkoutTimer.unref();
    this.#routingTimer = setInterval(
      () => this.#checkRouting(),
      this.#options.upgrade?.checkoutEveryMs === undefined ? 30_000 : every,
    );
    this.#routingTimer.unref();
    this.#startLink(host);
    void this.#gpu.read();
    if (this.#arbitration.mode === "hostd") await this.#arbitration.ensure();
    this.#log.info(
      { port: this.#port, workspace: host.workspace, services: [...this.#services.keys()] },
      "hostd started",
    );
  }

  /** Starts every service of this host in order (the `after` waits happen in the services). */
  async startAll(): Promise<void> {
    for (const service of this.#services.values()) {
      if (service.plan.kind === "external" || !service.plan.override.enabled) continue;
      await service.start();
    }
  }

  /** Stops every service (reverse start order), the API, and removes the run file. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    if (this.#checkoutTimer !== null) clearInterval(this.#checkoutTimer);
    this.#checkoutTimer = null;
    if (this.#routingTimer !== null) clearInterval(this.#routingTimer);
    this.#routingTimer = null;
    // An update still waiting goes away; one that changed something already finishes its step.
    this.#upgrader?.cancel();
    // Before the services: a holder stopping now gives nothing back by itself.
    this.#arbitration?.close();
    await this.#stopServices();
    for (const service of this.#services.values()) service.close();
    const link = this.#link;
    this.#link = null;
    if (link !== null) {
      try {
        await link.stop();
      } catch (error) {
        this.#log.warn({ err: error }, "control link did not stop cleanly");
      }
    }
    const gateway = this.#gateway;
    this.#gateway = null;
    if (gateway !== null) {
      await new Promise<void>((done) => {
        gateway.close(() => done());
        gateway.closeAllConnections();
      });
    }
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
    if (this.#runFile !== "") removeRunFile(this.#runFile, this.#token);
    await this.#cardReader?.close().catch(() => undefined);
    for (const service of this.#services.values()) await service.logs.close();
    this.#log.info("hostd stopped");
    const stream = this.#logStream;
    this.#logStream = null;
    if (stream !== null) await new Promise<void>((done) => stream.end(() => done()));
  }

  /** Stops the services: the started ones in reverse start order, then the rest. */
  async #stopServices(): Promise<string[]> {
    const order = [
      ...[...this.#spawnOrder].reverse(),
      ...[...this.#services.keys()].reverse().filter((n) => !this.#spawnOrder.includes(n)),
    ];
    const stopped: string[] = [];
    // A service waiting to be restarted must not come back while the others are being stopped.
    for (const service of this.#services.values()) {
      if (service.state === "backoff") service.close();
    }
    for (const name of order) {
      const service = this.#services.get(name);
      if (service === undefined || !service.active) continue;
      try {
        await service.stop();
        stopped.push(name);
      } catch (error) {
        this.#log.error({ service: name, err: error }, "stop failed");
      }
    }
    return stopped;
  }

  /**
   * Dials Core when `host.toml` has `[cluster] url` and `<state>/host.key` exists. Without either
   * the daemon runs on its own; that is not an error.
   */
  #startLink(host: LoadedHostConfig): void {
    const url = host.config.cluster?.url;
    if (url === undefined) return;
    let key: HostKey | null;
    try {
      key = readHostKey(host.state.root);
    } catch (error) {
      this.#log.warn({ err: error }, "host.key is unreadable; not dialling Core");
      return;
    }
    if (key === null) {
      this.#log.info({ url }, "no host.key yet; not dialling Core (miyoria host join writes it)");
      return;
    }
    const options: CoreLinkOptions = {
      url,
      hostId: key.id,
      key: key.key,
      name: host.config.name,
      platform: process.platform,
      version: this.version,
      logger: this.#log,
    };
    const link = (this.#options.linkFactory ?? ((api, o) => new CoreLink(api, o)))(this, options);
    this.#link = link;
    link.start();
    this.#log.info({ url }, "dialling Core");
  }

  /** `cluster.context`: who listens and which songs are needed now, for the GPU arbiter. */
  setContext(context: HostClusterContext): void {
    this.#arbitration?.context(context);
  }

  /**
   * `host.relink`: reads `[cluster]` of `host.toml` and `<state>/host.key` again, hangs up the
   * current link and dials with what the files say now. Only the cluster address and the name are
   * taken from the file; the services were planned at start.
   */
  relink(): Promise<HostRelinkResult> {
    const run = this.#relinking.then(() => this.#relink());
    this.#relinking = run.catch(() => undefined);
    return run;
  }

  async #relink(): Promise<HostRelinkResult> {
    const current = this.#host;
    if (current === null || this.#stopping !== null) {
      throw new HostRpcError(HOST_ERROR_CODE.Busy, "the daemon is not running");
    }
    let fresh: LoadedHostConfig;
    try {
      fresh = loadHostConfig(current.file);
    } catch (error) {
      throw new HostRpcError(
        JSON_RPC.InvalidParams,
        error instanceof Error ? error.message : String(error),
      );
    }
    const { cluster: _old, ...rest } = current.config;
    const next: LoadedHostConfig = {
      ...current,
      config: {
        ...rest,
        name: fresh.config.name,
        ...(fresh.config.cluster !== undefined ? { cluster: fresh.config.cluster } : {}),
      },
    };
    this.#host = next;
    const old = this.#link;
    this.#link = null;
    if (old !== null) {
      try {
        await old.stop();
      } catch (error) {
        this.#log.warn({ err: error }, "control link did not stop cleanly");
      }
    }
    this.#startLink(next);
    this.#log.info({ link: this.linkState }, "control link read again");
    return { link: this.linkState };
  }

  // ---- accessors -------------------------------------------------------------------------------

  /** The control link's state; `none` when the daemon has no link. */
  get linkState(): HostLinkState {
    return this.#link?.state ?? "none";
  }

  get version(): string {
    return this.#options.version ?? "0.0.0";
  }

  /** The local API's port (0 before `start`). */
  get port(): number {
    return this.#port;
  }

  /** The operator token, as the run file holds it. */
  get token(): string {
    return this.#token;
  }

  get runFile(): string {
    return this.#runFile;
  }

  get hostConfig(): LoadedHostConfig {
    if (this.#host === null) throw new Error("the daemon has not started");
    return this.#host;
  }

  /** The service names in start order. */
  serviceNames(): string[] {
    return [...this.#services.keys()];
  }

  // ---- HostApi ---------------------------------------------------------------------------------

  report(options: { withTokens: boolean }): HostReport {
    if (this.#gpu.stale) void this.#gpu.read();
    return this.#info(options.withTokens);
  }

  #info(withTokens: boolean): HostInfo {
    const sample = this.#gpu.last;
    return {
      name: this.#host?.config.name ?? "",
      version: this.version,
      platform: process.platform,
      protocol: HOST_PROTOCOL_VERSION,
      gpu:
        sample === null
          ? null
          : {
              name: sample.name,
              total_mb: sample.total_mb,
              used_mb: sample.used_mb,
              free_mb: freeOf(sample),
              reserve_mb: this.#host?.config.gpu.reserve_mb ?? 0,
            },
      services: [...this.#services.values()].map((s) => s.status(withTokens)),
      link: this.linkState,
      ...(this.#arbitration === null ? {} : { arbiter: this.#arbitration.status() }),
      ...(this.#checkout === undefined ? {} : { checkout: this.#checkout }),
      remote_update: this.remoteUpdate(),
      upgrade: this.#upgrader?.job ?? null,
      ...this.#routesReport(withTokens),
    };
  }

  // ---- routes (v5-hostd §16) -------------------------------------------------------------------

  /** The routes now: `routes.toml` with `local` first while Core runs on this machine. */
  #routesNow(): LoadedRoutes | null {
    const loaded = this.#routes;
    const host = this.#host;
    if (loaded === null || host === null) return null;
    const local = isLoopbackUrl(host.config.cluster?.url)
      ? localAddress(host.config.network.bind)
      : null;
    return withLocal(loaded, local);
  }

  #routesReport(withTokens: boolean): Pick<HostInfo, "routes" | "route_token"> {
    const routes = this.#routesNow();
    if (routes === null) return {};
    return {
      routes: reportRoutes(routes, this.#gatewayProblem),
      ...(withTokens ? { route_token: this.#routeToken } : {}),
    };
  }

  #reachOf(name: string, port: number): Record<string, string> | undefined {
    const routes = this.#routesNow();
    if (routes === null) return undefined;
    return reachOf(
      routes,
      name,
      port,
      this.#gatewayToken(name) !== undefined,
      this.#gateway !== null,
    );
  }

  /**
   * The token a gateway request for `name` must carry: its own token, for a worker that is not
   * Core. Core's own service and the nodes are never behind the gateway.
   */
  #gatewayToken(name: string): string | undefined {
    const managed = this.#services.get(name);
    if (managed === undefined || managed.plan.kind !== "worker") return undefined;
    if (name === "core" || managed.plan.provides.includes("core")) return undefined;
    return managed.token;
  }

  /** Starts the gateway when a route of `routes.toml` needs one. A failure is a route problem. */
  async #startGateway(): Promise<void> {
    const plan = this.#routes?.gateway ?? null;
    if (plan === null) return;
    let tls: { cert: Buffer; key: Buffer } | null = null;
    if (plan.tls !== null) {
      try {
        tls = { cert: await readFile(plan.tls.cert), key: await readFile(plan.tls.key) };
      } catch (error) {
        this.#gatewayProblem = `閘道讀不到憑證:${error instanceof Error ? error.message : String(error)}`;
        this.#log.warn({ problem: this.#gatewayProblem }, "gateway not started");
        return;
      }
    }
    const gateway = createGateway({
      tls,
      logger: this.#log,
      host: {
        target: (name) => this.target(name),
        tokenOf: (name) => this.#gatewayToken(name),
        routeToken: () => this.#routeToken,
      },
    });
    try {
      await new Promise<void>((done, fail) => {
        gateway.once("error", fail);
        gateway.listen({ host: plan.bind, port: plan.port }, () => {
          gateway.off("error", fail);
          done();
        });
      });
    } catch (error) {
      this.#gatewayProblem = `閘道沒辦法聽 ${plan.bind}:${plan.port}:${error instanceof Error ? error.message : String(error)}`;
      this.#log.warn({ problem: this.#gatewayProblem }, "gateway not started");
      return;
    }
    gateway.on("error", (error) => this.#log.error({ err: error }, "gateway failed"));
    this.#gateway = gateway;
    this.#gatewayProblem = null;
    this.#log.info({ bind: plan.bind, port: plan.port, tls: tls !== null }, "gateway listening");
  }

  /** Where the gateway listens, while it does. */
  get gatewayAddress(): { host: string; port: number } | null {
    const address = this.#gateway?.address();
    if (address === undefined || address === null || typeof address !== "object") return null;
    return { host: address.address, port: address.port };
  }

  onEvent(listener: (event: HostServiceEvent) => void): () => void {
    this.#events.add(listener);
    return () => {
      this.#events.delete(listener);
    };
  }

  onChange(listener: () => void): () => void {
    this.#changes.add(listener);
    return () => {
      this.#changes.delete(listener);
    };
  }

  followLogs(service: string, listener: (line: string) => void): () => void {
    return this.#service(service).logs.follow(listener);
  }

  target(service: string): { url: string; headers: Record<string, string> } | null {
    const managed = this.#services.get(service);
    const port = managed?.port;
    const host = this.#host;
    if (managed === undefined || !managed.active || port === undefined || host === null) {
      return null;
    }
    const token = managed.token;
    return {
      url: localUrl(host.config.network.bind, port),
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    };
  }

  setGuardSource(source: GuardSource | null): void {
    this.#guard = source;
  }

  setClusterClient(client: ClusterClient | null): void {
    this.#cluster = client;
  }

  /** The `cluster.*` client while the control link is up (used from H5 on). */
  get clusterClient(): ClusterClient | null {
    return this.#cluster;
  }

  /**
   * `cluster.links`: where Core's node links are now. A node service whose process runs with
   * other (or no) values from hostd is restarted once to take them, unless one of its guarded
   * states is active (or unknown): then it keeps running and its status says it needs a restart.
   */
  setLinks(links: HostLinks["links"]): void {
    this.#links = links;
    this.#log.info({ links: Object.keys(links) }, "Core sent the node links");
    this.#queueLinkCheck([...this.#services.keys()]);
  }

  /** The `{link:...}` values now: what Core sent, with the address built from `[cluster] url`. */
  linkValues(): Partial<Record<LinkPlaceholder, string>> {
    return linkValues(this.#links, this.#host?.config.cluster?.url);
  }

  /** Runs the link check of these services after the ones before it. */
  #queueLinkCheck(names: readonly string[]): void {
    if (Object.keys(this.#links).length === 0) return;
    const run = this.#linkChecks.then(() => this.#checkLinks(names));
    this.#linkChecks = run.catch((error: unknown) =>
      this.#log.error({ err: error }, "applying the node links failed"),
    );
  }

  /** Restarts the running services among `names` whose link values are out of date. */
  async #checkLinks(names: readonly string[]): Promise<void> {
    if (this.#stopping !== null) return;
    const now = this.linkValues();
    for (const name of names) {
      const service = this.#services.get(name);
      if (service === undefined || service.state !== "running") continue;
      const used = service.usedLinks;
      const stale = (Object.keys(used) as LinkPlaceholder[]).filter((key) => {
        const value = now[key];
        return value !== undefined && value !== used[key];
      });
      if (stale.length === 0) continue;
      try {
        await this.#checkGuard(service, false);
      } catch (error) {
        if (!(error instanceof HostRpcError)) throw error;
        this.#log.warn(
          { service: name, links: stale, reason: error.message },
          "node links changed; not restarting it now",
        );
        service.note(LINKS_CHANGED_REASON);
        continue;
      }
      this.#log.info({ service: name, links: stale }, "node links changed; restarting it");
      await service.stop();
      const fresh = this.#replan([name]) ?? service;
      await fresh.start();
    }
  }

  /**
   * Runs one method. `onLine` receives the progress lines of the long ones (`service.install`,
   * `host.update`); the local API sends them to the caller as they come.
   */
  async call(
    method: string,
    params: unknown,
    caller: Caller,
    signal?: AbortSignal,
    onLine?: (line: string) => void,
  ): Promise<unknown> {
    if (!SERVED.has(method)) {
      throw new HostRpcError(JSON_RPC.MethodNotFound, `method not found: ${method}`);
    }
    if (!allowed(caller, method)) {
      throw new HostRpcError(HOST_ERROR_CODE.NotAllowed, `${caller.kind} may not call ${method}`);
    }
    switch (method) {
      case HOST_METHOD.Info: {
        await this.#gpu.read();
        return this.#info(false);
      }
      case HOST_METHOD.ServiceList:
        return {
          services: [...this.#services.values()].map((s) => s.status(false)),
        } satisfies HostServiceList;
      case HOST_METHOD.ServiceStart: {
        const { service } = parseParams(HostServiceControlSchema, params);
        const managed = this.#service(service);
        return { service, state: await managed.start() } satisfies HostServiceControlResult;
      }
      case HOST_METHOD.ServiceStop: {
        const { service, force } = parseParams(HostServiceControlSchema, params);
        const managed = this.#service(service);
        await this.#checkGuard(managed, force === true);
        return { service, state: await managed.stop() } satisfies HostServiceControlResult;
      }
      case HOST_METHOD.ServiceRestart: {
        const { service, force } = parseParams(HostServiceControlSchema, params);
        const managed = this.#service(service);
        await this.#checkGuard(managed, force === true);
        await managed.stop();
        // What a pull or an install changed (the command, the port, the environment) is read now.
        const fresh = this.#replan([service]) ?? managed;
        return { service, state: await fresh.start() } satisfies HostServiceControlResult;
      }
      case HOST_METHOD.ServiceInstall: {
        const params_ = parseParams(HostServiceInstallSchema, params);
        return await this.#exclusive(() => this.#install(params_, signal, onLine));
      }
      case HOST_METHOD.ServiceRemove: {
        const params_ = parseParams(HostServiceRemoveSchema, params);
        return await this.#exclusive(() => this.#remove(params_));
      }
      case HOST_METHOD.HostUpdate: {
        const params_ = parseParams(HostUpdateSchema, params);
        return await this.#exclusive(() => this.#update(params_, signal, onLine));
      }
      case HOST_METHOD.ServiceLogs: {
        const { service, lines } = parseParams(HostServiceLogsSchema, params);
        return { lines: this.#service(service).logs.tail(lines) } satisfies HostServiceLogsResult;
      }
      case HOST_METHOD.HostRelink:
        return await this.relink();
      case HOST_METHOD.HostUpgrade:
        return await this.#upgrade(params);
      case HOST_METHOD.HostUpgradeCancel: {
        const upgrader = this.#upgrader;
        return {
          cancelled: upgrader?.cancel() ?? false,
          job: upgrader?.job ?? null,
        } satisfies HostUpgradeCancelResult;
      }
      case HOST_METHOD.ClusterResolve:
      case HOST_METHOD.ClusterLlm:
      case HOST_METHOD.ClusterFetch:
        return await this.#forward(method, params, caller, signal);
      case HOST_METHOD.GpuAcquire:
      case HOST_METHOD.GpuRenew:
      case HOST_METHOD.GpuRelease:
      case HOST_METHOD.GpuBusy:
      case HOST_METHOD.GpuState:
        return await this.#gpuCall(method, params, caller);
      case HOST_METHOD.HostShutdown: {
        const { force } = parseParams(HostShutdownSchema, params);
        if (force !== true) {
          for (const service of this.#services.values()) await this.#checkGuard(service, false);
        }
        this.#arbitration?.close();
        const stopped = await this.#stopServices();
        const done = this.#options.onShutdown ?? (() => this.stop());
        setTimeout(() => {
          Promise.resolve()
            .then(done)
            .catch((error: unknown) => this.#log.error({ err: error }, "shutdown failed"));
        }, 50);
        return { stopped } satisfies HostShutdownResult;
      }
      default:
        throw new HostRpcError(JSON_RPC.MethodNotFound, `method not found: ${method}`);
    }
  }

  /**
   * Passes a `cluster.*` call on to Core with the name of the service that asked: a service's own
   * name, whatever it sent; the operator's `service` param as given (for debugging). Core decides
   * what that service may use. Without a link: `NotLinked`.
   */
  async #forward(
    method: string,
    params: unknown,
    caller: Caller,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const client = this.#cluster;
    if (client === null) {
      throw new HostRpcError(
        HOST_ERROR_CODE.NotLinked,
        `hostd 沒有連上 Core,不能轉送 ${method}(沒有 [cluster] url、沒有 host.key,或連線中斷)`,
      );
    }
    const given =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    const { service: asked, ...rest } = given;
    const service =
      caller.kind === "service" ? caller.service : typeof asked === "string" ? asked : undefined;
    return await client.call(
      method,
      service === undefined ? rest : { ...rest, service },
      signal,
      FORWARD_TIMEOUT_MS[method],
    );
  }

  // ---- routing (v5-hostd §15) ------------------------------------------------------------------

  /** A service's `[routing]` as it applies here: readiness, variant, the owner's limits. */
  #routingOf(service: ManagedService) {
    const host = this.#host;
    const ctx = this.#ctx;
    if (host === null || ctx === null) return undefined;
    const plan = service.plan;
    return serviceRouting(plan.entry, plan.override, {
      paths: {
        root: this.#options.catalogRoot,
        workspace: host.workspace,
        state: host.state.root,
        models: host.state.models,
      },
      env: (name) =>
        plan.override.env[name] ?? plan.entry?.descriptor.run?.env[name] ?? ctx.env[name],
      gpuTotalMb: () => this.#gpu.last?.total_mb ?? null,
      hasher: this.#variants,
    });
  }

  /**
   * Reports again when a service's readiness or variant changed without anything else changing
   * (a model file was put in place): those are read when a report is made, and nothing else would
   * make one.
   */
  #checkRouting(): void {
    const now = JSON.stringify(
      [...this.#services.values()].map((s) => {
        const r = this.#routingOf(s);
        return r === undefined ? null : [s.name, r.ready, r.reason ?? null, r.variant ?? null];
      }),
    );
    if (now === this.#routingSeen) return;
    this.#routingSeen = now;
    this.#serviceHost?.changed();
  }

  /** Why a service that uses the card is held up from outside: another service holds a lease. */
  #outside(name: string): string | undefined {
    const service = this.#services.get(name);
    if (service?.plan.gpuPolicy === undefined) return undefined;
    const other = this.#arbitration?.status().leases.find((lease) => lease.holder !== name);
    return other === undefined ? undefined : `${other.holder} 正在用顯卡(${other.stage})`;
  }

  // ---- GPU arbitration (H7) --------------------------------------------------------------------

  /**
   * One read of the card; `null` when it cannot be read. A new total (the first reading) is a
   * change of the report: a service's `[routing] needs.vram_gb` is judged by it (§15.1).
   */
  #readGpu(): Promise<GpuSample | null> {
    const read = this.#readCard;
    const sample = read === null ? Promise.resolve(null) : read().catch(() => null);
    return sample.then((s) => {
      const total = s?.total_mb ?? null;
      if (total !== this.#gpuTotal) {
        this.#gpuTotal = total;
        this.#serviceHost?.changed();
      }
      return s;
    });
  }

  /**
   * Where the card's index comes from: the daemon's environment, then the song worker's own
   * `CUDA_VISIBLE_DEVICES` from its descriptor and `host.toml`, as the worker itself reads it.
   */
  #cardEnv(ctx: ResolveContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...ctx.env };
    for (const service of this.#services.values()) {
      if (service.plan.gpuPolicy !== "on_demand" || !service.plan.override.enabled) continue;
      Object.assign(env, settingsOf(service.plan));
      break;
    }
    return env;
  }

  /** Tells the arbitration what runs where now. */
  #syncArbiter(): void {
    const arbitration = this.#arbitration;
    if (arbitration === null) return;
    const services: ArbiterService[] = [];
    for (const managed of this.#services.values()) {
      const plan = managed.plan;
      const descriptor = plan.entry?.descriptor;
      if (descriptor === undefined) continue;
      const policy = plan.gpuPolicy;
      const service =
        policy === undefined ? descriptor : { ...descriptor, gpu: { ...descriptor.gpu, policy } };
      services.push({
        service,
        enabled: plan.override.enabled,
        url: this.target(plan.name)?.url ?? null,
        settings: settingsOf(plan),
      });
    }
    arbitration.update(services);
  }

  /** `gpu.*`: a holder service's lease calls, or `gpu.state`. */
  async #gpuCall(method: string, params: unknown, caller: Caller): Promise<unknown> {
    const arbitration = this.#arbitration;
    if (arbitration === null || this.#stopping !== null) {
      throw new HostRpcError(HOST_ERROR_CODE.Busy, "the daemon is not running");
    }
    let holder: string | null = null;
    if (caller.kind === "service") {
      if (!arbitration.isHolder(caller.service)) {
        throw new HostRpcError(
          HOST_ERROR_CODE.NotAllowed,
          `${caller.service} 不能借用顯卡(它的 [gpu] policy 不是 on_demand)`,
        );
      }
      holder = caller.service;
    }
    const arbiter = await arbitration.ensure();
    if (arbiter === null) {
      throw new HostRpcError(
        HOST_ERROR_CODE.Unavailable,
        `hostd 沒有在分配顯卡:${arbitration.reason}`,
      );
    }
    return await arbitration.call(arbiter, method, params, holder);
  }

  // ---- installing ------------------------------------------------------------------------------

  /** Runs `task` after the installs before it. */
  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#installing.then(task, task);
    this.#installing = run.catch(() => undefined);
    return run;
  }

  #installDeps(): InstallDeps {
    return { ...this.#options.installDeps, root: this.#options.catalogRoot };
  }

  /** A managed service for a plan, with its own log. */
  #manage(plan: ServicePlan, logs?: ServiceLog): ManagedService {
    const host = this.#host;
    const serviceHost = this.#serviceHost;
    if (host === null || serviceHost === null) throw new Error("the daemon has not started");
    const log =
      logs ??
      new ServiceLog(plan.name, host.state.logs, (error) =>
        this.#log.warn({ service: plan.name, err: error }, "service log failed"),
      );
    return new ManagedService(plan, log, serviceHost);
  }

  /** Reads `host.toml` and the descriptors again. Returns `false` when `host.toml` does not load. */
  #reload(): boolean {
    const current = this.#host;
    if (current === null) return false;
    try {
      const fresh = loadHostConfig(current.file);
      this.#host = { ...current, config: { ...current.config, services: fresh.config.services } };
    } catch (error) {
      this.#log.warn({ err: error }, "host.toml does not load; the services keep their plans");
      return false;
    }
    this.#catalog = loadCatalog(this.#options.catalogRoot);
    return true;
  }

  /**
   * Plans the named services again from `host.toml` and the descriptors as they are now. A service
   * that is not running gets its new plan (it may be new, or startable now that its environment
   * exists); one that is running keeps its plan until it restarts. Returns the service of the first
   * name.
   */
  #replan(names: readonly string[]): ManagedService | undefined {
    const host = this.#host;
    const catalog = this.#catalog;
    const ctx = this.#ctx;
    if (host === null || catalog === null || ctx === null) return undefined;
    this.#reload();
    const fresh = this.#host as LoadedHostConfig;
    const plans = planServices(this.#catalog ?? catalog, fresh, ctx);
    const next = new Map<string, ManagedService>();
    for (const plan of plans) {
      const existing = this.#services.get(plan.name);
      const replace =
        names.includes(plan.name) &&
        (existing === undefined || existing.state === "disabled" || existing.state === "stopped");
      if (replace) {
        existing?.close();
        const managed = this.#manage(plan, existing?.logs);
        managed.watchExternal();
        next.set(plan.name, managed);
      } else if (existing !== undefined) {
        next.set(plan.name, existing);
      }
    }
    // A service that left host.toml while it runs stays until it is stopped.
    for (const [name, service] of this.#services) {
      if (!next.has(name) && service.active) next.set(name, service);
    }
    this.#services.clear();
    for (const [name, service] of next) this.#services.set(name, service);
    this.#serviceHost?.changed();
    return names[0] === undefined ? undefined : this.#services.get(names[0]);
  }

  async #install(
    params: { service: string; extras?: string[]; only_stale?: boolean; no_files?: boolean },
    signal: AbortSignal | undefined,
    onLine: ((line: string) => void) | undefined,
  ): Promise<HostServiceInstallResult> {
    this.#reload();
    const entry = this.#entryOf(params.service);
    const host = this.hostConfig;
    const result = await installService(entry, host, this.#installDeps(), {
      ...(params.extras !== undefined ? { extras: params.extras } : {}),
      ...(params.only_stale !== undefined ? { onlyStale: params.only_stale } : {}),
      ...(params.no_files !== undefined ? { noFiles: params.no_files } : {}),
      ...(onLine !== undefined ? { onLine } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    // The environment exists now: a disabled service becomes startable without a daemon restart.
    this.#replan([params.service]);
    this.#log.info(
      { service: params.service, ok: result.ok, runtime: result.runtime.state },
      "service installed",
    );
    return result;
  }

  /** Stops the service (the guard applies), deletes the environment hostd manages, forgets it. */
  async #remove(params: {
    service: string;
    force?: boolean;
    keep_env?: boolean;
  }): Promise<HostServiceRemoveResult> {
    const managed = this.#services.get(params.service);
    let stopped = false;
    if (managed?.active) {
      await this.#checkGuard(managed, params.force === true);
      await managed.stop();
      stopped = true;
    }
    const host = this.hostConfig;
    const removed = removeService(host, params.service, {
      ...(params.keep_env !== undefined ? { keepEnv: params.keep_env } : {}),
    });
    if (managed !== undefined) {
      managed.close();
      this.#services.delete(params.service);
      this.#serviceHost?.changed();
    }
    this.#log.info({ service: params.service, deleted: removed.deletedEnv }, "service removed");
    return {
      service: params.service,
      stopped,
      ...(removed.deletedEnv !== undefined ? { deleted_env: removed.deletedEnv } : {}),
    };
  }

  /** Re-reads descriptors and `host.toml`, re-plans, and syncs the environments that are stale. */
  async #update(
    params: { services?: string[]; force?: boolean },
    signal: AbortSignal | undefined,
    onLine: ((line: string) => void) | undefined,
  ): Promise<HostUpdateResult> {
    this.#reload();
    const host = this.hostConfig;
    const names = (params.services ?? Object.keys(host.config.services)).filter(
      (name) => host.config.services[name]?.enabled !== false,
    );
    const results: HostServiceInstallResult[] = [];
    for (const name of names) {
      const entry = this.#catalog?.services.get(name);
      if (entry === undefined) continue;
      if (entry.descriptor.install.runtime !== "python") continue;
      results.push(
        await installService(entry, host, this.#installDeps(), {
          onlyStale: params.force !== true,
          // Files are downloaded only after the person agreed: `miyoria update` asks, then
          // installs each service that needs them with `service.install`.
          noFiles: true,
          ...(onLine !== undefined ? { onLine } : {}),
          ...(signal !== undefined ? { signal } : {}),
        }),
      );
    }
    this.#replan(names);
    return { services: results };
  }

  #entryOf(name: string) {
    const entry = this.#catalog?.services.get(name);
    if (entry === undefined) {
      throw new HostRpcError(HOST_ERROR_CODE.UnknownService, `沒有叫 ${name} 的服務`);
    }
    if (this.#host?.config.services[name] === undefined) {
      throw new HostRpcError(
        HOST_ERROR_CODE.NotInstalled,
        `${name} 不是這台的服務(host.toml 沒有 [services.${name}])`,
      );
    }
    return entry;
  }

  // ---- the checkout and remote updates (v5-hostd §14) ----------------------------------------

  /**
   * Whether this host takes `host.upgrade` now, and why not. Core's own machine never does: an
   * update there restarts Core and rebuilds the panel under it, which `miyoria update` on that
   * machine does with a person watching.
   */
  remoteUpdate(): HostRemoteUpdate {
    if (!this.#allowRemote) {
      return {
        allowed: false,
        reason: "這台的主人關掉了遠端更新(host.toml 的 [update] allow_remote = false)",
      };
    }
    const core = this.#services.get("core");
    // Core started by hand beside this daemon is still Core's machine: its link is local.
    if (
      (core?.plan.override.enabled && core.plan.entry !== null) ||
      isLoopbackUrl(this.#host?.config.cluster?.url)
    ) {
      return {
        allowed: false,
        reason: "這台跑著 Core,不能從面板更新;請在這台執行 miyoria update",
      };
    }
    if (this.#checkout === null) {
      return { allowed: false, reason: "這台不是從 git checkout 執行的,不能遠端更新" };
    }
    return { allowed: true };
  }

  /** The runner of git and pnpm. */
  #upgradeRunner(): CommandRunner {
    return this.#options.upgrade?.runner ?? this.#options.installDeps?.runner ?? execaRunner;
  }

  /** Reads `[update]` of host.toml and the checkout again; reports when either changed. */
  #readCheckout(): Promise<void> {
    this.#checkoutReading ??= (async () => {
      const host = this.#host;
      if (host !== null) {
        try {
          this.#allowRemote = loadHostConfig(host.file).config.update.allow_remote;
        } catch {
          // A host.toml that does not load keeps the value read before.
        }
      }
      let next: HostCheckout | null;
      try {
        next = await readCheckout({
          root: this.#options.catalogRoot,
          runner: this.#upgradeRunner(),
          env: this.#ctx?.env ?? process.env,
          now: () => Date.now(),
          platform: this.#ctx?.platform ?? process.platform,
        });
      } catch (error) {
        this.#log.warn({ err: error }, "cannot read the checkout");
        next = null;
      }
      const before = this.#checkout;
      this.#checkout = next;
      const same =
        before !== undefined &&
        before?.commit === next?.commit &&
        before?.branch === next?.branch &&
        before?.dirty === next?.dirty &&
        before?.behind === next?.behind &&
        before?.ahead === next?.ahead;
      if (!same) this.#serviceHost?.changed();
    })().finally(() => {
      this.#checkoutReading = null;
    });
    return this.#checkoutReading;
  }

  async #upgrade(params: unknown): Promise<unknown> {
    const upgrader = this.#upgrader;
    if (upgrader === null || this.#stopping !== null) {
      throw new HostRpcError(HOST_ERROR_CODE.Busy, "the daemon is not running");
    }
    const parsed = parseParams(HostUpgradeSchema, params);
    // The file decides at the moment of asking, not what the last report said.
    await this.#readCheckout();
    const remote = this.remoteUpdate();
    if (!remote.allowed) {
      throw new HostRpcError(HOST_ERROR_CODE.NotAllowed, remote.reason ?? "不能遠端更新");
    }
    this.#log.info({ target: parsed.commit, by: parsed.by }, "Core asked for an update");
    return await upgrader.begin(parsed);
  }

  /** What `Upgrader` needs of this daemon. */
  #upgradeHost(): UpgradeHost {
    const RUNNING = new Set(["running", "starting", "backoff"]);
    return {
      services: () =>
        [...this.#services.values()].map((s) => ({
          name: s.name,
          entry: s.plan.entry,
          running: RUNNING.has(s.state),
        })),
      busy: (signal) => this.#busyReasons(signal),
      reload: () => {
        this.#reload();
      },
      staleEnvs: () => {
        const host = this.#host;
        const catalog = this.#catalog;
        if (host === null || catalog === null) return [];
        const out: string[] = [];
        for (const [name, override] of Object.entries(host.config.services)) {
          const entry = catalog.services.get(name);
          if (!override.enabled || entry === undefined) continue;
          if (entry.descriptor.install.runtime !== "python") continue;
          const inspected = inspectService(entry, host, this.#installDeps());
          if (inspected.runtime.kind !== "managed") continue;
          if (inspected.runtime.state?.state !== "ready") out.push(name);
        }
        return out;
      },
      sync: (name, signal, onLine) =>
        this.#exclusive(async () => {
          const result = await this.#install(
            { service: name, only_stale: true, no_files: true },
            signal,
            onLine,
          );
          return {
            ok: result.ok,
            ...(result.runtime.detail !== undefined ? { detail: result.runtime.detail } : {}),
          };
        }),
      stop: async (name) => {
        await this.#services.get(name)?.stop();
      },
      start: async (name) => {
        const managed = this.#service(name);
        const fresh = this.#replan([name]) ?? managed;
        await fresh.start();
      },
      restart: async (name) => {
        const managed = this.#service(name);
        await managed.stop();
        const fresh = this.#replan([name]) ?? managed;
        await fresh.start();
      },
      healthy: (names, timeoutMs, signal) => this.#waitHealthy(names, timeoutMs, signal),
      missing: () => this.#missingForUpgrade(),
      changed: () => {
        this.#serviceHost?.changed();
        if (this.#upgrader !== null && !this.#upgrader.busy) void this.#readCheckout();
      },
      log: this.#log,
    };
  }

  /**
   * Why this host is not idle, in words: a GPU lease, a guarded state Core reports for a service
   * that guards it (or Core cannot be asked), or a running service whose health says `busy` or a
   * queue (the song worker's `/health`).
   */
  async #busyReasons(signal: AbortSignal): Promise<string[]> {
    const reasons: string[] = [];
    for (const lease of this.#arbitration?.status().leases ?? []) {
      reasons.push(`${lease.holder} 正在用顯卡(${lease.stage})`);
    }
    const guarded = new Set<HostGuardState>();
    for (const service of this.#services.values()) {
      if (!service.active) continue;
      for (const state of service.plan.entry?.descriptor.run?.guard ?? []) guarded.add(state);
    }
    if (guarded.size > 0) {
      try {
        const states = await (this.#guard ?? this.#defaultGuard).states(
          AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        );
        if (states.includes("singing") && guarded.has("singing")) reasons.push("她正在唱歌");
        if (states.includes("live") && guarded.has("live")) reasons.push("她正在直播");
      } catch {
        reasons.push("問不到 Core 她現在忙不忙");
      }
    }
    const fetchImpl = this.#options.upgrade?.fetch ?? fetch;
    for (const service of this.#services.values()) {
      if (service.state !== "running") continue;
      const path = service.plan.entry?.descriptor.run?.health.http;
      const target = this.target(service.name);
      if (path === undefined || target === null) continue;
      try {
        const res = await fetchImpl(`${target.url}${path}`, {
          headers: target.headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        const body: unknown = await res.json();
        if (typeof body !== "object" || body === null) continue;
        const { busy, queued } = body as { busy?: unknown; queued?: unknown };
        if (busy === true) reasons.push(`${service.name} 正在處理工作`);
        else if (typeof queued === "number" && queued > 0) {
          reasons.push(`${service.name} 還有 ${queued} 個工作在排隊`);
        }
      } catch {
        // A health answer that is not JSON says nothing about work.
      }
    }
    return reasons;
  }

  /** Waits until each named service runs healthy; the rest with why, at the deadline. */
  async #waitHealthy(
    names: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Array<{ service: string; reason: string }>> {
    const deadline = Date.now() + timeoutMs;
    const pending = new Set(names);
    const out: Array<{ service: string; reason: string }> = [];
    while (pending.size > 0) {
      for (const name of [...pending]) {
        const s = this.#services.get(name);
        if (s === undefined) {
          pending.delete(name);
          out.push({ service: name, reason: "這台已經沒有這個服務" });
          continue;
        }
        const status = s.status(false);
        if (status.state === "running" && status.healthy) pending.delete(name);
        else if (
          status.state === "failed" ||
          status.state === "disabled" ||
          status.state === "stopped"
        ) {
          pending.delete(name);
          out.push({ service: name, reason: status.reason ?? status.state });
        }
      }
      if (pending.size === 0 || signal.aborted) break;
      if (Date.now() >= deadline) {
        for (const name of pending) out.push({ service: name, reason: "時間內沒有變成健康" });
        break;
      }
      await new Promise((done) => setTimeout(done, Math.min(1000, this.#timing.pollMs * 5)));
    }
    return out;
  }

  /** What the enabled services lack that an update never fetches. */
  #missingForUpgrade(): HostUpgradeMissing[] {
    const host = this.#host;
    const catalog = this.#catalog;
    if (host === null || catalog === null) return [];
    const out: HostUpgradeMissing[] = [];
    for (const [name, override] of Object.entries(host.config.services)) {
      const entry = catalog.services.get(name);
      if (!override.enabled || entry === undefined) continue;
      const inspected = inspectService(entry, host, this.#installDeps());
      for (const file of inspected.files) {
        if (file.optional || file.state === "verified" || file.state === "present") continue;
        out.push({ service: name, kind: "file", what: file.path });
      }
      for (const model of inspected.models) {
        if (!model.present) out.push({ service: name, kind: "model", what: model.repo });
      }
      for (const item of inspected.manual) {
        if (!item.present) out.push({ service: name, kind: "manual", what: item.what });
      }
    }
    return out;
  }

  // ---- helpers ---------------------------------------------------------------------------------

  #service(name: string): ManagedService {
    const service = this.#services.get(name);
    if (service !== undefined) return service;
    if (this.#catalog?.services.has(name)) {
      throw new HostRpcError(
        HOST_ERROR_CODE.NotInstalled,
        `${name} 不是這台的服務(host.toml 沒有 [services.${name}])`,
      );
    }
    throw new HostRpcError(HOST_ERROR_CODE.UnknownService, `沒有叫 ${name} 的服務`);
  }

  #authenticate(token: string): Caller | null {
    if (sameToken(token, this.#token)) return { kind: "operator" };
    for (const service of this.#services.values()) {
      const own = service.token;
      if (own !== undefined && service.active && sameToken(token, own)) {
        return { kind: "service", service: service.name };
      }
    }
    return null;
  }

  /** Refuses a stop or restart someone asked for while a guarded state is active. */
  async #checkGuard(service: ManagedService, force: boolean): Promise<void> {
    const guard: readonly HostGuardState[] = service.plan.entry?.descriptor.run?.guard ?? [];
    if (force || guard.length === 0 || !service.active) return;
    let states: HostGuardState[];
    try {
      states = await (this.#guard ?? this.#defaultGuard).states(AbortSignal.timeout(4000));
    } catch (error) {
      this.#log.info({ service: service.name, err: error }, "guard states unknown");
      throw new HostRpcError(HOST_ERROR_CODE.Guarded, guardUnknownMessage(service.name, guard), {
        states: null,
      });
    }
    const active = guard.filter((s) => states.includes(s));
    if (active.length > 0) {
      throw new HostRpcError(HOST_ERROR_CODE.Guarded, guardedMessage(service.name, active), {
        states: active,
      });
    }
  }
}

/**
 * A service's own settings for the GPU arbiter: descriptor `[run] env`, then `host.toml` env, as
 * the service would see them. Values with a placeholder are left out (the `SING_*` tuning is
 * plain numbers and names).
 */
function settingsOf(plan: ServicePlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of [plan.entry?.descriptor.run?.env ?? {}, plan.override.env]) {
    for (const [key, value] of Object.entries(table)) {
      if (placeholdersIn(value).length === 0) out[key] = value;
    }
  }
  return out;
}

/** Whether `url` names this machine itself: `localhost`, `127.x.x.x` or `::1`. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 && parts[0] === "127" && parts.every((part) => /^[0-9]{1,3}$/.test(part))
  );
}
