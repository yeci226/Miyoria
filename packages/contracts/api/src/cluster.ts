// The cluster: the machines that joined Core (`hostd` on each), the codes to join with, what each
// machine runs, and where each capability can be used now (docs/design/v5-hostd.md §6, §7). The
// owner manages hosts from the panel and the CLI; `POST /api/cluster/join` is the one route a
// machine uses before it has anything but a code.
//
// A host's key is shown in the answer that creates it and nowhere else, and so is an invite's
// code. No answer carries a key's hash or a service token.

import { z } from "zod";
import {
  HostCheckoutSchema,
  HostGpuReadingSchema,
  HostLinkStateSchema,
  HostRemoteUpdateSchema,
  HostRouteKindSchema,
  HostRoutingClassSchema,
  HostRoutingLatencySchema,
  HostServiceRoutingSchema,
  HostServiceStatusSchema,
  HostUpgradeJobSchema,
} from "../../host/src/index.js";
import { TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** A host as the owner sees it. */
export const ClusterHostViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["pending", "approved", "revoked"]),
    /** What the owner approved it for. */
    capabilities: z.array(z.string()),
    platform: z.string().nullable(),
    version: z.string().nullable(),
    created_at: TimestampSchema,
    last_seen_at: TimestampSchema.nullable(),
    /** Its control link is up now. */
    connected: z.boolean(),
    connected_since: TimestampSchema.nullable(),
    /**
     * Its git checkout, from its last report while connected. `null`: it does not run from one;
     * absent: not connected, or its hostd is older than remote updates (version unknown).
     */
    checkout: HostCheckoutSchema.nullable().optional(),
    /** How its commit stands to Core's (absent without both checkouts). */
    relation: z
      .object({
        relation: z.enum(["same", "behind", "ahead", "diverged", "unknown"]),
        /** Commits between the two, for `behind` and `ahead`. */
        count: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** Whether it takes an update from the panel; absent from an older hostd (it does not). */
    remote_update: HostRemoteUpdateSchema.optional(),
    /** Its running or last update; `null` before the first. */
    upgrade: HostUpgradeJobSchema.nullable().optional(),
  })
  .meta({ id: "ApiClusterHostView" });
export type ClusterHostView = z.output<typeof ClusterHostViewSchema>;

/** Body of `POST /api/cluster/invites`. */
export const ClusterInviteRequestSchema = z
  .object({
    /** Fixes the name of the host that uses the code. */
    name: z.string().min(1).max(64).optional(),
    /** How long the code works, in seconds (default 10 minutes). */
    ttl_s: z
      .number()
      .int()
      .positive()
      .max(7 * 86_400)
      .optional(),
  })
  .meta({ id: "ApiClusterInviteRequest" });
export type ClusterInviteRequest = z.input<typeof ClusterInviteRequestSchema>;

/** The only time an invite's code is shown. */
export const ClusterInviteSchema = z
  .object({ code: z.string(), expires_at: TimestampSchema })
  .meta({ id: "ApiClusterInvite" });
export type ClusterInvite = z.output<typeof ClusterInviteSchema>;

/** Body of `POST /api/cluster/hosts`. */
export const ClusterCreateHostRequestSchema = z
  .object({ name: z.string().min(1).max(64), capabilities: z.array(z.string().min(1).max(64)) })
  .meta({ id: "ApiClusterCreateHostRequest" });
export type ClusterCreateHostRequest = z.input<typeof ClusterCreateHostRequestSchema>;

/** A host made by the owner, approved at once. The only time its key is shown. */
export const ClusterCreatedHostSchema = z
  .object({ id: z.string(), name: z.string(), key: z.string() })
  .meta({ id: "ApiClusterCreatedHost" });
export type ClusterCreatedHost = z.output<typeof ClusterCreatedHostSchema>;

/** Body of `POST /api/cluster/hosts/{name}/approve`. */
export const ClusterApproveRequestSchema = z
  .object({ capabilities: z.array(z.string().min(1).max(64)) })
  .meta({ id: "ApiClusterApproveRequest" });
export type ClusterApproveRequest = z.input<typeof ClusterApproveRequestSchema>;

/** One service of a host, as `host.info` lists it, without its token. */
export const ClusterServiceStatusSchema = HostServiceStatusSchema.omit({ token: true }).meta({
  id: "ApiClusterServiceStatus",
});
export type ClusterServiceStatus = z.output<typeof ClusterServiceStatusSchema>;

/** What the host says about itself (`host.info`), without service tokens. */
export const ClusterHostInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    platform: z.string(),
    protocol: z.number().int(),
    gpu: HostGpuReadingSchema.nullable(),
    services: z.array(ClusterServiceStatusSchema),
    link: HostLinkStateSchema.optional(),
    checkout: HostCheckoutSchema.nullable().optional(),
    remote_update: HostRemoteUpdateSchema.optional(),
    upgrade: HostUpgradeJobSchema.nullable().optional(),
  })
  .meta({ id: "ApiClusterHostInfo" });
export type ClusterHostInfo = z.output<typeof ClusterHostInfoSchema>;

/** Body of `POST /api/cluster/hosts/{name}/services/{service}/{action}`. */
export const ClusterServiceActionRequestSchema = z
  .object({ force: z.boolean().optional() })
  .meta({ id: "ApiClusterServiceActionRequest" });
export type ClusterServiceActionRequest = z.input<typeof ClusterServiceActionRequestSchema>;

/** What the host answers to `service.start`, `service.stop` and `service.restart`. */
export const ClusterServiceResultSchema = z
  .object({ service: z.string(), state: HostServiceStatusSchema.shape.state })
  .meta({ id: "ApiClusterServiceResult" });
export type ClusterServiceResult = z.output<typeof ClusterServiceResultSchema>;

/** One place a capability can be used. `url` only for one Core calls itself; never a header. */
export const ClusterEndpointViewSchema = z
  .object({
    host: z.string(),
    service: z.string(),
    via: z.enum(["direct", "link"]),
    healthy: z.boolean(),
    version: z.string().nullable(),
    url: z.string().optional(),
  })
  .meta({ id: "ApiClusterEndpointView" });
export type ClusterEndpointView = z.output<typeof ClusterEndpointViewSchema>;

/** Per capability, its candidates in the order they are tried. */
export const ClusterEndpointsSchema = z
  .object({
    capabilities: z.array(
      z.object({ capability: z.string(), candidates: z.array(ClusterEndpointViewSchema) }),
    ),
  })
  .meta({ id: "ApiClusterEndpoints" });
export type ClusterEndpoints = z.output<typeof ClusterEndpointsSchema>;

/** Body of `POST /api/cluster/join`. */
export const ClusterJoinRequestSchema = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    platform: z.string().max(64).optional(),
    version: z.string().max(64).optional(),
  })
  .meta({ id: "ApiClusterJoinRequest" });
export type ClusterJoinRequest = z.input<typeof ClusterJoinRequestSchema>;

/** What a machine gets for a good code: its id, its key (once) and where its link goes. */
export const ClusterJoinResultSchema = z
  .object({ host_id: z.string(), key: z.string(), link_url: z.string() })
  .meta({ id: "ApiClusterJoinResult" });
export type ClusterJoinResult = z.output<typeof ClusterJoinResultSchema>;

/** Core's own checkout: the commit an update from the panel names. */
export const ClusterCoreCheckoutSchema = z
  .object({
    /** `null` when Core does not run from a git checkout: then no host can be updated from here. */
    checkout: HostCheckoutSchema.nullable(),
  })
  .meta({ id: "ApiClusterCoreCheckout" });
export type ClusterCoreCheckout = z.output<typeof ClusterCoreCheckoutSchema>;

/** Body of `POST /api/cluster/upgrade`: the hosts to bring to Core's commit. */
export const ClusterUpgradeRequestSchema = z
  .object({
    hosts: z.array(z.string().min(1).max(64)).min(1).max(32),
    /** How long each host may wait for a running job before it gives up. Default 1800. */
    wait_s: z.number().int().min(0).max(21_600).optional(),
  })
  .meta({ id: "ApiClusterUpgradeRequest" });
export type ClusterUpgradeRequest = z.input<typeof ClusterUpgradeRequestSchema>;

/** What each host said to the request. A refusal is a result, with the host's reason. */
export const ClusterUpgradeResultSchema = z
  .object({
    /** The commit asked for (Core's `HEAD`). */
    commit: z.string(),
    results: z.array(
      z.object({
        host: z.string(),
        ok: z.boolean(),
        job: HostUpgradeJobSchema.optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .meta({ id: "ApiClusterUpgradeResult" });
export type ClusterUpgradeResult = z.output<typeof ClusterUpgradeResultSchema>;

/** What a host answered to the cancel of its waiting update. */
export const ClusterUpgradeCancelResultSchema = z
  .object({ cancelled: z.boolean(), job: HostUpgradeJobSchema.nullable() })
  .meta({ id: "ApiClusterUpgradeCancelResult" });
export type ClusterUpgradeCancelResult = z.output<typeof ClusterUpgradeCancelResultSchema>;

// ---- job dispatch (v5-hostd §15) -----------------------------------------------------------------

/** What makes up an endpoint's score, in ms. */
export const ClusterScorePartsSchema = z
  .object({
    wait_ms: z.number(),
    run_ms: z.number(),
    transfer_ms: z.number(),
    penalty_ms: z.number(),
    /** The penalties, in words. */
    penalties: z.array(z.string()),
    weight: z.number(),
  })
  .meta({ id: "ApiClusterScoreParts" });

/** One endpoint of a capability: whether it takes new work, its score or why not. */
export const ClusterEndpointRoutingSchema = z
  .object({
    host: z.string(),
    service: z.string(),
    via: z.enum(["direct", "link"]),
    healthy: z.boolean(),
    /** It failed a moment ago and rests. */
    resting: z.boolean(),
    /** It takes new work. */
    eligible: z.boolean(),
    /** Why not, in words. */
    reason: z.string().optional(),
    /** Seconds until a new unit would be back on Core (`job`); `null` for the other classes. */
    score_s: z.number().nullable(),
    parts: ClusterScorePartsSchema.optional(),
    /** Its `[routing]` as its host reports it; `null` from an older hostd or a static entry. */
    routing: HostServiceRoutingSchema.nullable(),
    load: z
      .object({
        running: z.number(),
        queued: z.number(),
        age_ms: z.number(),
        outside: z.string().optional(),
      })
      .nullable(),
    /** Units Core sent that its host's report does not show yet. */
    pending: z.number().int(),
    /** Its host carries her voice now through a service this one yields to. */
    speech: z.boolean(),
    /** What Core measured there. */
    estimate: z.object({
      unit_s: z.number().nullable(),
      rate_mb_s: z.number().nullable(),
      units: z.number().int(),
      transfers: z.number().int(),
    }),
  })
  .meta({ id: "ApiClusterEndpointRouting" });

/** Why the last units of a capability went where they went. */
export const ClusterDispatchDecisionSchema = z
  .object({
    at: TimestampSchema,
    host: z.string(),
    service: z.string(),
    what: z.string().optional(),
    scores: z.array(
      z.object({
        host: z.string(),
        service: z.string(),
        score_s: z.number().nullable(),
        reason: z.string().optional(),
      }),
    ),
  })
  .meta({ id: "ApiClusterDispatchDecision" });

export const ClusterSpeechHostModeSchema = z
  .enum(["never", "when_idle", "always"])
  .meta({ id: "ApiClusterSpeechHostMode" });

/** One capability's routing. */
export const ClusterCapabilityRoutingSchema = z
  .object({
    capability: z.string(),
    /** `null`: no host declares one; it is routed as before (first healthy in order). */
    class: HostRoutingClassSchema.nullable(),
    latency: HostRoutingLatencySchema.nullable(),
    yields_to: z.array(z.string()),
    /** The variant every instance must have. */
    variant: z.string().nullable(),
    speech_mode: ClusterSpeechHostModeSchema,
    /** For `single`: the instance in use and the ones that are not. */
    conflict: z.object({ used: z.string(), others: z.array(z.string()) }).nullable(),
    /** Hosts disagree about the class (the strictest is used). */
    class_conflict: z.array(z.string()).nullable(),
    endpoints: z.array(ClusterEndpointRoutingSchema),
    decisions: z.array(ClusterDispatchDecisionSchema),
    sessions: z.array(
      z.object({ key: z.string(), host: z.string(), service: z.string(), since: TimestampSchema }),
    ),
    /** The size of a unit's results Core reckons with, in MB. */
    result_mb: z.number().nullable(),
  })
  .meta({ id: "ApiClusterCapabilityRouting" });

export const ClusterRoutingControlKindSchema = z
  .enum(["pin", "exclude", "weight", "drain"])
  .meta({ id: "ApiClusterRoutingControlKind" });

/** One of the owner's controls set from the panel. */
export const ClusterRoutingControlSchema = z
  .object({
    kind: ClusterRoutingControlKindSchema,
    /** `""` for a host's weight or drain. */
    capability: z.string(),
    host: z.string(),
    value: z.number().nullable(),
    by: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "ApiClusterRoutingControl" });

/** One route of a host (v5-hostd §16): its state, what it is used for now, what was measured. */
export const ClusterRouteViewSchema = z
  .object({
    name: z.string(),
    kind: HostRouteKindSchema,
    /** The gateway's URL, or the tailnet address; `null` for the relay. Never a token. */
    url: z.string().nullable(),
    /** Not declared in the host's `routes.toml` (its advertised address, Core's machine, the relay). */
    implicit: z.boolean(),
    state: z.enum(["unknown", "up", "down", "resting", "invalid"]),
    /** The kinds of work it is the first choice for now. */
    in_use: z.array(z.enum(["realtime", "interactive", "bulk"])),
    rtt_ms: z.number().nullable(),
    mb_s: z.number().nullable(),
    /** Throughput samples behind `mb_s`. */
    samples: z.number().int(),
    max_body_mb: z.number().nullable(),
    probed_at: TimestampSchema.nullable(),
    ok_at: TimestampSchema.nullable(),
    /** Why it is invalid, or why it failed last. */
    reason: z.string().nullable(),
  })
  .meta({ id: "ApiClusterRouteView" });
export type ClusterRouteView = z.output<typeof ClusterRouteViewSchema>;

/** Job dispatch as the machines page shows it. */
export const ClusterRoutingSchema = z
  .object({
    capabilities: z.array(ClusterCapabilityRoutingSchema),
    hosts: z.array(
      z.object({
        host: z.string(),
        /** It runs on Core's own machine; `null` when unknown. */
        local: z.boolean().nullable(),
        rtt_ms: z.number().nullable(),
        /** Why it takes nothing new; `null` when it does. */
        drained: z.string().nullable(),
        weight: z.number(),
        /** The ways Core reaches it (v5-hostd §16) and what was measured; older Cores leave it out. */
        routes: z.array(ClusterRouteViewSchema).optional(),
      }),
    ),
    /** Where her voice is, as the speech-host rule sees it. */
    activity: z.object({
      in_voice: z.boolean(),
      live: z.boolean(),
      last_spoke_at: TimestampSchema.nullable(),
      idle: z.boolean(),
    }),
    /** `[modules.cluster.routing]` as Core read it: what the panel cannot change. */
    config: z.object({
      allow_on_speech_host: ClusterSpeechHostModeSchema,
      idle_minutes: z.number(),
      weights: z.record(z.string(), z.number()),
      drain: z.array(z.string()),
      capabilities: z.record(
        z.string(),
        z.object({
          allow_on_speech_host: ClusterSpeechHostModeSchema.optional(),
          pin: z.string().optional(),
          exclude: z.array(z.string()),
          variant: z.string().optional(),
        }),
      ),
    }),
    /** The owner's controls from the panel. */
    panel: z.array(ClusterRoutingControlSchema),
  })
  .meta({ id: "ApiClusterRouting" });
export type ClusterRouting = z.output<typeof ClusterRoutingSchema>;

/** Body of `POST /api/cluster/routing/controls`: set or take away one control. */
export const ClusterRoutingControlRequestSchema = z
  .object({
    action: z.enum(["set", "clear"]),
    kind: ClusterRoutingControlKindSchema,
    host: z.string().min(1).max(64),
    /** For `pin` and `exclude`. */
    capability: z.string().min(1).max(64).optional(),
    /** For `weight` (above 0). */
    value: z.number().positive().max(100).optional(),
  })
  .meta({ id: "ApiClusterRoutingControlRequest" });
export type ClusterRoutingControlRequest = z.input<typeof ClusterRoutingControlRequestSchema>;

/**
 * The node an account must hold to pin, exclude, weigh or drain from the panel: `owner.*`, like
 * `owner.cluster.update` (the owner role has it; admin and moderator do not).
 */
export const CLUSTER_ROUTE_PERMISSION = "owner.cluster.route";

/**
 * The node an account must hold to update hosts from the panel. An `owner.*` node: the owner role
 * has it through `*`, the admin role's `admin.*` does not cover it, and the owner may grant it to
 * someone by name. Hosts take updates unless they opt out, so this stays the owner's by default.
 */
export const CLUSTER_UPDATE_PERMISSION = "owner.cluster.update";

const HostParams = z.object({ name: z.string() });
const ServiceParams = z.object({ name: z.string(), service: z.string(), action: z.string() });

export const cluster = {
  /** `503` while the cluster module is not running (the same for every route here). */
  hosts: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/cluster/hosts" })
    .output(z.array(ClusterHostViewSchema)),
  /** Shows the code once. */
  invite: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/cluster/invites" })
    .input(z.object({ body: ClusterInviteRequestSchema }))
    .output(ClusterInviteSchema),
  /** A host approved at once, for the machine Core itself runs on. Shows the key once. */
  create: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/cluster/hosts" })
    .input(z.object({ body: ClusterCreateHostRequestSchema }))
    .output(ClusterCreatedHostSchema),
  /** `404` for an unknown host, `409` for a revoked one. */
  approve: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/cluster/hosts/{name}/approve" })
    .input(z.object({ params: HostParams, body: ClusterApproveRequestSchema }))
    .output(ClusterHostViewSchema),
  /** Its key stops working and its link is closed. `404` for an unknown host. */
  remove: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/cluster/hosts/{name}", successStatus: 204 })
    .input(z.object({ params: HostParams })),
  /** `409` while the host is not connected. */
  info: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/cluster/hosts/{name}/info" })
    .input(z.object({ params: HostParams }))
    .output(ClusterHostInfoSchema),
  /**
   * `action` is `start`, `stop` or `restart` (another is a `404`). `409` while the host is not
   * connected, or when it answers that a guarded state is active (repeat with `force`).
   */
  service: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/cluster/hosts/{name}/services/{service}/{action}" })
    .input(z.object({ params: ServiceParams, body: ClusterServiceActionRequestSchema }))
    .output(ClusterServiceResultSchema),
  endpoints: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/cluster/endpoints" })
    .output(ClusterEndpointsSchema),
  /** Core's own checkout. */
  checkout: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/cluster/checkout" })
    .output(ClusterCoreCheckoutSchema),
  /**
   * Asks each host to update itself to Core's commit (v5-hostd §14). `409` when Core has no
   * checkout. Each host's refusal (opted out, not connected, Core's own machine, a changed
   * tree) is one result with its reason; each is in the audit log.
   */
  upgrade: route
    .meta({
      audience: "admin",
      permission: CLUSTER_UPDATE_PERMISSION,
      refusal: "更新電腦需要 owner.cluster.update 權限(預設只有擁有者有)",
    })
    .route({ method: "POST", path: "/api/cluster/upgrade" })
    .input(z.object({ body: ClusterUpgradeRequestSchema }))
    .output(ClusterUpgradeResultSchema),
  /** Cancels a host's update that still waits. `409` while the host is not connected. */
  upgradeCancel: route
    .meta({
      audience: "admin",
      permission: CLUSTER_UPDATE_PERMISSION,
      refusal: "更新電腦需要 owner.cluster.update 權限(預設只有擁有者有)",
    })
    .route({ method: "POST", path: "/api/cluster/hosts/{name}/upgrade/cancel" })
    .input(z.object({ params: HostParams, body: z.object({}) }))
    .output(ClusterUpgradeCancelResultSchema),
  /** Job dispatch: each capability's class, its endpoints' scores or why not, the decisions. */
  routing: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/cluster/routing" })
    .output(ClusterRoutingSchema),
  /**
   * Sets or takes away a pin, an exclusion, a weight or a drain (v5-hostd §15.6); each is in the
   * audit log. `400` for a control without what it needs. Answers the routing as it is now.
   */
  routingControl: route
    .meta({
      audience: "admin",
      permission: CLUSTER_ROUTE_PERMISSION,
      refusal: "調整分派需要 owner.cluster.route 權限(預設只有擁有者有)",
    })
    .route({ method: "POST", path: "/api/cluster/routing/controls" })
    .input(z.object({ body: ClusterRoutingControlRequestSchema }))
    .output(ClusterRoutingSchema),
  /**
   * No session: the code is the credential. A code that is unknown, used or expired is always the
   * same `403`. At most 5 attempts a minute per address (`429`).
   */
  join: route
    .meta({ audience: "public", permission: null })
    .route({ method: "POST", path: "/api/cluster/join" })
    .input(z.object({ body: ClusterJoinRequestSchema }))
    .output(ClusterJoinResultSchema),
};
