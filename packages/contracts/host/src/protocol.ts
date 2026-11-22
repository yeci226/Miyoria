// What the host protocol carries that is not a message shape: the version, method and
// notification names, close codes, error codes and the built-in capability names
// (docs/design/v5-hostd.md §5).

/** The version a host sends in `hello`. Core closes with `BAD_HELLO` on any other. */
export const HOST_PROTOCOL_VERSION = 1;

/** Where Core serves the control link, on the cluster module's bind. */
export const HOST_LINK_PATH = "/cluster-link";

/** Requests. The first group is served by hostd, the `cluster.*` group by Core. */
export const HOST_METHOD = {
  Info: "host.info",
  ServiceList: "service.list",
  ServiceStart: "service.start",
  ServiceStop: "service.stop",
  ServiceRestart: "service.restart",
  ServiceLogs: "service.logs",
  ServiceInstall: "service.install",
  ServiceRemove: "service.remove",
  HostUpdate: "host.update",
  /**
   * Core only, and only to a host that has not opted out (`[update] allow_remote = false`): fast-forward to a commit
   * of the tracked upstream, install, restart, report (v5-hostd §14). Answers at once with the job;
   * its steps arrive in `host.report`. Not the same as `host.update`, the local re-sync.
   */
  HostUpgrade: "host.upgrade",
  /** Cancels an update that is still waiting, before it changed anything. */
  HostUpgradeCancel: "host.upgrade_cancel",
  /** Local API only: stop every service, then the daemon. */
  HostShutdown: "host.shutdown",
  /** Local API only: read `[cluster]` and `<state>/host.key` again and dial Core with them. */
  HostRelink: "host.relink",
  GpuAcquire: "gpu.acquire",
  GpuRenew: "gpu.renew",
  GpuRelease: "gpu.release",
  GpuBusy: "gpu.busy",
  GpuState: "gpu.state",
  ClusterGuard: "cluster.guard",
  ClusterResolve: "cluster.resolve",
  /** A completion through Core's LLM, for a service of the host (H8). */
  ClusterLlm: "cluster.llm",
  /** One small HTTP request to a capability's endpoint, made by Core, for a service of the host (H8). */
  ClusterFetch: "cluster.fetch",
} as const;

/**
 * Limits of `cluster.fetch`: the request body and the response body are each at most
 * `MAX_BODY_BYTES` (before base64), and the endpoint's response head must arrive within
 * `HEAD_TIMEOUT_MS` (the body then gets as long again).
 */
export const HOST_FETCH_LIMITS = {
  MAX_BODY_BYTES: 8 * 1024 * 1024,
  HEAD_TIMEOUT_MS: 60_000,
} as const;

/** Notifications. `host.report` and `service.*` go to Core, `cluster.*` come from it. */
export const HOST_NOTIFICATION = {
  Report: "host.report",
  ServiceEvent: "service.event",
  ServiceLog: "service.log",
  ClusterContext: "cluster.context",
  ClusterLinks: "cluster.links",
} as const;

/** WebSocket close codes of the control link, the same meanings as the voice link's. */
export const HOST_LINK_CLOSE = {
  /** Malformed hello or another version. The host does not retry. (No hello in time is `TIMEOUT`.) */
  BAD_HELLO: 4400,
  /** Wrong or revoked host key. The host does not retry. */
  UNAUTHORIZED: 4401,
  /** No hello in time, or no traffic from the host within Core's peer timeout. The host reconnects. */
  TIMEOUT: 4408,
  /** A newer connection for the same host took over. The host does not retry. */
  REPLACED: 4409,
  /** Core is shutting down. The host reconnects. */
  GOING_AWAY: 1001,
} as const;

/**
 * JSON-RPC error codes the host protocol adds to the standard ones. They sit in the range the
 * extension protocol uses (-32001 to -32005, -32800), below -32010 so no meaning is shared.
 */
export const HOST_ERROR_CODE = {
  /** No service of that name in the catalog. */
  UnknownService: -32010,
  /** The service is in the catalog but not installed on this host. */
  NotInstalled: -32011,
  /** A guarded state is active; repeat with `force` to go ahead. */
  Guarded: -32012,
  /** The service or the card is busy with something that cannot be interrupted. */
  Busy: -32013,
  /** The caller may not use this method or capability. */
  NotAllowed: -32014,
  /** hostd has no control link to Core now (no `[cluster]`, no host key, or the link is down). */
  NotLinked: -32015,
  /** Nothing can serve the request now: no usable endpoint, no LLM, or the endpoint failed. */
  Unavailable: -32016,
  /** A body is over `HOST_FETCH_LIMITS.MAX_BODY_BYTES`. */
  TooLarge: -32017,
  /** The host sent more `cluster.llm` requests than Core allows per minute. */
  RateLimited: -32018,
} as const;

/** Capability names the built-in services provide. A descriptor may list others. */
export const HOST_CAPABILITIES = [
  "core",
  "asr",
  "tts",
  "turn",
  "vad",
  "sing",
  "lyrics",
  "imagegen",
  "media",
  "voice-room",
  "renderer",
  "embed",
] as const;
