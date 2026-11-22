// Params and results of the methods of the control link and the local API. The `gpu.*` and
// `cluster.context` shapes are in `gpu.ts`.

import { z } from "zod";
import { HostGpuArbitrationSchema } from "./gpu.js";
import { HostRouteSchema } from "./routes.js";
import { HostServiceLoadSchema, HostServiceRoutingSchema } from "./routing.js";
import { HostGpuPolicySchema, HostGuardStateSchema } from "./service.js";
import { HostCheckoutSchema, HostRemoteUpdateSchema, HostUpgradeJobSchema } from "./upgrade.js";

/** First message of the control link, host → Core. `host` is the id Core's `join` gave it. */
export const HostHelloSchema = z
  .object({
    protocol: z.number().int(),
    host: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    platform: z.string(),
    version: z.string(),
  })
  .meta({ id: "HostHello" });
export type HostHello = z.output<typeof HostHelloSchema>;

/** Core's answer to `hello`. */
export const HostWelcomeSchema = z
  .object({
    protocol: z.number().int(),
    core_version: z.string(),
    /** The name Core has for this host. */
    host: z.string(),
    /** The capabilities Core has approved for it. */
    approved: z.array(z.string()),
  })
  .meta({ id: "HostWelcome" });
export type HostWelcome = z.output<typeof HostWelcomeSchema>;

export const HostServiceStateSchema = z
  .enum([
    "stopped",
    "starting",
    "running",
    "stopping",
    "backoff",
    "failed",
    "external",
    "foreign",
    "disabled",
  ])
  .meta({ id: "HostServiceState" });
export type HostServiceState = z.output<typeof HostServiceStateSchema>;

/** One service as hostd reports it. */
export const HostServiceStatusSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["worker", "node", "external"]),
    provides: z.array(z.string()),
    state: HostServiceStateSchema,
    /** Epoch milliseconds of the last state change. */
    since: z.number(),
    pid: z.number().int().optional(),
    port: z.number().int().optional(),
    /** Where the service listens, as seen on its own machine. */
    url: z.string().optional(),
    /**
     * The base URL Core can call directly: present when the host advertises an address, or when
     * the Core it reports to runs on the same machine. Without it Core reaches the service
     * through the host's control link.
     */
    advertised: z.string().optional(),
    /**
     * By route name (`routes.toml`, v5-hostd §16): the base URL of this service on that route
     * (`http://<address>:<port>` on a `tailnet` route, `<gateway url>/svc/<name>` on `direct` and
     * `tunnel`). Absent on a host without `routes.toml`, and from older daemons.
     */
    reach: z.record(z.string(), z.string()).optional(),
    healthy: z.boolean(),
    /** Restarts within the current give-up window. */
    restarts: z.number().int().nonnegative(),
    version: z.string().optional(),
    /** Why the service is failed, in backoff or disabled. */
    reason: z.string().optional(),
    /** The service token; only present in reports on the control link. */
    token: z.string().optional(),
    gpu: z
      .object({
        policy: HostGpuPolicySchema,
        resident_mb: z.number().optional(),
        leased: z.boolean(),
      })
      .optional(),
    /** Its `[routing]` as it applies here (v5-hostd §15); older daemons leave it out. */
    routing: HostServiceRoutingSchema.optional(),
    /** Its last load reading, for a service that reports one (`[routing] queue`). */
    load: HostServiceLoadSchema.optional(),
  })
  .meta({ id: "HostServiceStatus" });
export type HostServiceStatus = z.output<typeof HostServiceStatusSchema>;

/** What the card reads now. */
export const HostGpuReadingSchema = z
  .object({
    name: z.string().optional(),
    total_mb: z.number(),
    used_mb: z.number(),
    /** What the device has free, every process on it counted; older daemons leave it out. */
    free_mb: z.number().optional(),
    reserve_mb: z.number(),
  })
  .meta({ id: "HostGpuReading" });
export type HostGpuReading = z.output<typeof HostGpuReadingSchema>;

/** One lease of the card, in short, for `host.info` (the whole state is `gpu.state`). */
export const HostGpuLeaseStatusSchema = z
  .object({
    lease: z.string(),
    /** The service that holds it. */
    holder: z.string(),
    stage: z.string(),
    /** The job's last decision (`share`, `exclusive`, `wait`, `cpu`, `offload`), null before one. */
    mode: z.string().nullable(),
    code: z.string().nullable(),
    /** Epoch milliseconds of the lease's first call. */
    since: z.number(),
    /** The job's window is open (speech was taken offline for it at some point). */
    window: z.boolean(),
    /** The services offline for it now, by name. */
    evicted: z.array(z.string()),
  })
  .meta({ id: "HostGpuLeaseStatus" });
export type HostGpuLeaseStatus = z.output<typeof HostGpuLeaseStatusSchema>;

/** Who shares the card on this host, and what hostd decided last, for `host.info`. */
export const HostGpuArbiterStatusSchema = z
  .object({
    /** `host.toml [gpu] arbiter`. */
    mode: z.enum(["worker", "hostd"]),
    /** hostd arbitrates now: mode `hostd`, a readable card and a service with a `[gpu]` policy. */
    active: z.boolean(),
    /** Why it does not, with mode `hostd`. */
    reason: z.string().optional(),
    policy: HostGpuArbitrationSchema.optional(),
    leases: z.array(HostGpuLeaseStatusSchema),
    /** The last decision that changed a job's mode or code. Epoch milliseconds. */
    last: z
      .object({
        lease: z.string(),
        stage: z.string(),
        mode: z.string(),
        code: z.string(),
        reason: z.string(),
        at: z.number(),
      })
      .nullable(),
  })
  .meta({ id: "HostGpuArbiterStatus" });
export type HostGpuArbiterStatus = z.output<typeof HostGpuArbiterStatusSchema>;

/** Where the daemon's control link to Core is; `none` without `[cluster]` or a host key. */
export const HostLinkStateSchema = z
  .enum(["none", "connecting", "connected", "unauthorized", "stopped"])
  .meta({ id: "HostLinkState" });
export type HostLinkState = z.output<typeof HostLinkStateSchema>;

/** `host.info` result. `gpu` is null when the machine has no card. */
export const HostInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    platform: z.string(),
    protocol: z.number().int(),
    gpu: HostGpuReadingSchema.nullable(),
    services: z.array(HostServiceStatusSchema),
    /** The control link's state; older daemons leave it out. */
    link: HostLinkStateSchema.optional(),
    /** GPU arbitration on this host; older daemons leave it out. */
    arbiter: HostGpuArbiterStatusSchema.optional(),
    /** The git checkout it runs from; `null` when it is not one. Older daemons leave it out. */
    checkout: HostCheckoutSchema.nullable().optional(),
    /** Whether it takes `host.upgrade`. Older daemons leave it out: they never do. */
    remote_update: HostRemoteUpdateSchema.optional(),
    /** The running update, or the last one; `null` before the first. */
    upgrade: HostUpgradeJobSchema.nullable().optional(),
    /**
     * The routes Core may reach this host by (v5-hostd §16), the implicit ones included. Absent on
     * a host without `routes.toml` and from older daemons: Core then routes it as before.
     */
    routes: z.array(HostRouteSchema).optional(),
    /**
     * What Core sends to probe this host's gateway (`/_miyoria/probe`); new at each daemon start.
     * Only in reports on the control link, like the service tokens.
     */
    route_token: z.string().optional(),
  })
  .meta({ id: "HostInfo" });
export type HostInfo = z.output<typeof HostInfoSchema>;

/** `host.report` notification params: the whole snapshot, sent on connect and on every change. */
export const HostReportSchema = HostInfoSchema.meta({ id: "HostReport" });
export type HostReport = z.output<typeof HostReportSchema>;

/** `service.event` notification params: one state change. */
export const HostServiceEventSchema = z
  .object({
    service: z.string(),
    state: HostServiceStateSchema,
    previous: HostServiceStateSchema,
    /** Epoch milliseconds. */
    at: z.number(),
    reason: z.string().optional(),
    /** The last log lines, sent when the service failed. */
    log_tail: z.array(z.string()).optional(),
  })
  .meta({ id: "HostServiceEvent" });
export type HostServiceEvent = z.output<typeof HostServiceEventSchema>;

/** `service.list` result. */
export const HostServiceListSchema = z
  .object({ services: z.array(HostServiceStatusSchema) })
  .meta({ id: "HostServiceList" });
export type HostServiceList = z.output<typeof HostServiceListSchema>;

/** `service.start`, `service.stop` and `service.restart` params: one service per call. */
export const HostServiceControlSchema = z
  .object({
    service: z.string(),
    /** Go ahead although a guarded state is active. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostServiceControl" });
export type HostServiceControl = z.output<typeof HostServiceControlSchema>;

/** The result of those three. */
export const HostServiceControlResultSchema = z
  .object({ service: z.string(), state: HostServiceStateSchema })
  .meta({ id: "HostServiceControlResult" });
export type HostServiceControlResult = z.output<typeof HostServiceControlResultSchema>;

/** `service.logs` params. With `follow`, lines then arrive as `service.log` until cancelled. */
export const HostServiceLogsSchema = z
  .object({
    service: z.string(),
    lines: z.number().int().min(1).max(2000).default(100),
    follow: z.boolean().default(false),
  })
  .meta({ id: "HostServiceLogs" });
export type HostServiceLogs = z.output<typeof HostServiceLogsSchema>;
export type HostServiceLogsIn = z.input<typeof HostServiceLogsSchema>;

export const HostServiceLogsResultSchema = z
  .object({ lines: z.array(z.string()) })
  .meta({ id: "HostServiceLogsResult" });
export type HostServiceLogsResult = z.output<typeof HostServiceLogsResultSchema>;

/** `service.log` notification params. */
export const HostServiceLogLineSchema = z
  .object({ service: z.string(), line: z.string() })
  .meta({ id: "HostServiceLogLine" });
export type HostServiceLogLine = z.output<typeof HostServiceLogLineSchema>;

/** `host.shutdown` params (local API only). */
export const HostShutdownSchema = z
  .object({
    /** Go ahead although a guarded state is active for a running service. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostShutdown" });
export type HostShutdown = z.output<typeof HostShutdownSchema>;

/** `host.shutdown` result, sent before the daemon exits. */
export const HostShutdownResultSchema = z
  .object({
    /** The services that were stopped, in the order they were stopped. */
    stopped: z.array(z.string()),
  })
  .meta({ id: "HostShutdownResult" });
export type HostShutdownResult = z.output<typeof HostShutdownResultSchema>;

/** `host.relink` result: where the control link is after the daemon read its files again. */
export const HostRelinkResultSchema = z
  .object({ link: HostLinkStateSchema })
  .meta({ id: "HostRelinkResult" });
export type HostRelinkResult = z.output<typeof HostRelinkResultSchema>;

/** `cluster.guard` result: the guarded states that are active now. */
export const HostGuardResultSchema = z
  .object({ states: z.array(HostGuardStateSchema) })
  .meta({ id: "HostGuardResult" });
export type HostGuardResult = z.output<typeof HostGuardResultSchema>;

/** One place a capability can be used (v5-hostd §6.3). */
export const HostEndpointSchema = z
  .object({
    capability: z.string(),
    /** The host name, or the static entry's name. */
    host: z.string(),
    service: z.string(),
    /** With `via: "link"` this is the address on the host itself, not one Core can call. */
    url: z.string(),
    /** `direct`: call `url`. `link`: the request travels over the host's control link. */
    via: z.enum(["direct", "link"]).default("direct"),
    /** What to send with each request, such as the bearer token. */
    headers: z.record(z.string(), z.string()),
    healthy: z.boolean(),
    version: z.string().nullable(),
    /**
     * Set on what a `direct` query returned from a host with routes (v5-hostd §16): its requests
     * go only over routes fit for real-time work (`tailnet`, `direct`), never a tunnel or the relay.
     */
    direct_only: z.boolean().optional(),
  })
  .meta({ id: "HostEndpoint" });
export type HostEndpoint = z.output<typeof HostEndpointSchema>;

/** `cluster.resolve` params. */
export const HostResolveSchema = z
  .object({
    capability: z.string(),
    /**
     * Set by hostd: the service of the host that asked. Core gives the endpoints (and their
     * tokens) only of a capability the `uses` table lets that service resolve.
     */
    service: z.string().optional(),
  })
  .meta({ id: "HostResolve" });
export type HostResolve = z.output<typeof HostResolveSchema>;

/** `cluster.resolve` result. */
export const HostResolveResultSchema = z
  .object({ endpoints: z.array(HostEndpointSchema) })
  .meta({ id: "HostResolveResult" });
export type HostResolveResult = z.output<typeof HostResolveResultSchema>;

// ---- what a service asks Core for through its hostd (H8) ----------------------------------------

/** One message of a `cluster.llm` conversation: text only. */
export const HostLlmMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })
  .meta({ id: "HostLlmMessage" });
export type HostLlmMessage = z.output<typeof HostLlmMessageSchema>;

/**
 * `cluster.llm` params: one completion through Core's LLM, counted in the budget and written to
 * the call log like any other call. `service` is set by hostd to the service that asked; what a
 * service sends there itself is overwritten. Core decides what the service may use.
 */
export const HostLlmSchema = z
  .object({
    /** The model purpose (`fast`); Core allows only the purposes on its list. */
    purpose: z.string().min(1),
    messages: z.array(HostLlmMessageSchema).min(1),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    /** Ask for a JSON object answer when the model supports it. */
    json: z.boolean().optional(),
    /** Set by hostd: the service of the host that asked. */
    service: z.string().optional(),
  })
  .meta({ id: "HostLlm" });
export type HostLlm = z.output<typeof HostLlmSchema>;

/** `cluster.llm` result. */
export const HostLlmResultSchema = z.object({ text: z.string() }).meta({ id: "HostLlmResult" });
export type HostLlmResult = z.output<typeof HostLlmResultSchema>;

/**
 * `cluster.fetch` params: Core sends one HTTP request to the first usable endpoint of
 * `capability` and returns the whole answer. For small calls (the ASR spot check: a short clip in a
 * multipart form the caller builds itself). Each body is at most `HOST_FETCH_LIMITS.MAX_BODY_BYTES`.
 */
export const HostFetchSchema = z
  .object({
    capability: z.string().min(1),
    /** An HTTP method in capitals (`GET`, `POST`). */
    method: z.string().regex(/^[A-Z]{1,16}$/u, "an HTTP method in capitals"),
    /** Appended to the endpoint's address: starts with one `/`. */
    path: z.string().regex(/^\/(?!\/)\S*$/u, "a path that starts with one /"),
    /** Request headers. `authorization`, `host`, `content-length` and hop-by-hop ones are not sent. */
    headers: z.record(z.string(), z.string()).optional(),
    /** The request body, base64. */
    body: z.string().optional(),
    /** Set by hostd: the service of the host that asked. */
    service: z.string().optional(),
  })
  .meta({ id: "HostFetch" });
export type HostFetch = z.output<typeof HostFetchSchema>;

/** `cluster.fetch` result: the endpoint's answer, whatever its status. */
export const HostFetchResultSchema = z
  .object({
    status: z.number().int(),
    /** Lower-case names, without hop-by-hop ones. */
    headers: z.record(z.string(), z.string()),
    /** The response body, base64. */
    body: z.string(),
  })
  .meta({ id: "HostFetchResult" });
export type HostFetchResult = z.output<typeof HostFetchResultSchema>;

// ---- where the nodes dial Core (H4b) ---------------------------------------------------------------

/** One of Core's node links (`voice.link`, `stage.link`): where it listens and its token. */
export const HostLinkValuesSchema = z
  .object({
    /** The whole address, when Core's config gives a public one; else the host builds it. */
    url: z.string().optional(),
    port: z.number().int().min(1).max(65_535),
    /** The WebSocket path (`/voice-link`). */
    path: z.string(),
    token: z.string(),
  })
  .meta({ id: "HostLinkValues" });
export type HostLinkValues = z.output<typeof HostLinkValuesSchema>;

/**
 * `cluster.links` notification params, Core → hostd: sent when the host connects, when it is
 * approved, and when the values change. `voice` only to a host approved for `voice-room`, `stage`
 * only to one approved for `renderer`; a link whose module is off is left out.
 */
export const HostLinksSchema = z
  .object({
    links: z.object({
      voice: HostLinkValuesSchema.optional(),
      stage: HostLinkValuesSchema.optional(),
    }),
  })
  .meta({ id: "HostLinks" });
export type HostLinks = z.output<typeof HostLinksSchema>;

// ---- installing (service.install, service.remove, host.update) ---------------------------------

/** What happened to the Python environment of one service. */
export const HostInstallRuntimeStateSchema = z
  .enum([
    /** `uv sync` ran and finished. */
    "synced",
    /** The install record already matched; nothing ran (`only_stale`). */
    "current",
    /** `host.toml` names an environment the user manages (`python = ...`); never touched. */
    "user-managed",
    /** The runtime needs no environment here (`node`, `binary`, `none`, or no `project`). */
    "none",
    /** The descriptor does not support this platform. */
    "unsupported",
    /** `uv` is not installed; `detail` says how to install it. */
    "uv-missing",
    /** `uv sync` ran and failed. */
    "failed",
  ])
  .meta({ id: "HostInstallRuntimeState" });
export type HostInstallRuntimeState = z.output<typeof HostInstallRuntimeStateSchema>;

/** `service.install` params: build the environment of one service and check the rest of `[install]`. */
export const HostServiceInstallSchema = z
  .object({
    service: z.string(),
    /** Replaces the extras of the descriptor and of `host.toml` for this run. */
    extras: z.array(z.string()).optional(),
    /** Run `uv sync` only when the install record differs from the lock, extras and descriptor. */
    only_stale: z.boolean().optional(),
    /** Do not download `install.files`. */
    no_files: z.boolean().optional(),
  })
  .meta({ id: "HostServiceInstall" });
export type HostServiceInstall = z.output<typeof HostServiceInstallSchema>;

/** `service.install` result, and one item of `host.update`'s. */
export const HostServiceInstallResultSchema = z
  .object({
    service: z.string(),
    /** False when something failed (a sync, a download); missing items to place by hand do not. */
    ok: z.boolean(),
    runtime: z.object({
      state: HostInstallRuntimeStateSchema,
      /** The environment folder, when there is one. */
      dir: z.string().optional(),
      /** The extras that were synced. */
      extras: z.array(z.string()).optional(),
      /** The reason, or what to do (the `uv` install command). */
      detail: z.string().optional(),
    }),
    /** `install.system`: programs on PATH. `hint` is how to install a missing one. */
    system: z.array(
      z.object({ program: z.string(), found: z.boolean(), hint: z.string().optional() }),
    ),
    files: z.array(
      z.object({
        path: z.string(),
        state: z.enum(["present", "downloaded", "missing", "failed"]),
        detail: z.string().optional(),
      }),
    ),
    manual: z.array(z.object({ path: z.string(), what: z.string(), present: z.boolean() })),
    /** `install.models` and whether each is in the host's model cache. */
    models: z.array(
      z.object({
        repo: z.string(),
        revision: z.string().optional(),
        present: z.boolean(),
      }),
    ),
  })
  .meta({ id: "HostServiceInstallResult" });
export type HostServiceInstallResult = z.output<typeof HostServiceInstallResultSchema>;

/** `service.remove` params: stop the service, delete the environment hostd manages, forget it. */
export const HostServiceRemoveSchema = z
  .object({
    service: z.string(),
    /** Stop it although a guarded state is active. */
    force: z.boolean().optional(),
    /** Keep the environment folder. */
    keep_env: z.boolean().optional(),
  })
  .meta({ id: "HostServiceRemove" });
export type HostServiceRemove = z.output<typeof HostServiceRemoveSchema>;

/** `service.remove` result. */
export const HostServiceRemoveResultSchema = z
  .object({
    service: z.string(),
    stopped: z.boolean(),
    /** The environment folder that was deleted; absent when there was none, it is the user's, or it was kept. */
    deleted_env: z.string().optional(),
  })
  .meta({ id: "HostServiceRemoveResult" });
export type HostServiceRemoveResult = z.output<typeof HostServiceRemoveResultSchema>;

/**
 * `host.update` params: read the descriptors and `host.toml` again (a `git pull` changed them),
 * re-plan the services, and sync the environments whose install record is stale. It restarts
 * nothing: the caller asks for each restart through the guard.
 */
export const HostUpdateSchema = z
  .object({
    /** Only these; default every enabled service. */
    services: z.array(z.string()).optional(),
    /** Sync even when the install record matches. */
    force: z.boolean().optional(),
  })
  .meta({ id: "HostUpdate" });
export type HostUpdate = z.output<typeof HostUpdateSchema>;

/** `host.update` result: one install result per service that was looked at. */
export const HostUpdateResultSchema = z
  .object({ services: z.array(HostServiceInstallResultSchema) })
  .meta({ id: "HostUpdateResult" });
export type HostUpdateResult = z.output<typeof HostUpdateResultSchema>;
