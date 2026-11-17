// The cluster: the machines that joined Core (`hostd` on each), the codes to join with, what each
// machine runs, and where each capability can be used now (docs/design/v5-hostd.md §6, §7). The
// owner manages hosts from the panel and the CLI; `POST /api/cluster/join` is the one route a
// machine uses before it has anything but a code.
//
// A host's key is shown in the answer that creates it and nowhere else, and so is an invite's
// code. No answer carries a key's hash or a service token.

import { z } from "zod";
import {
  HostGpuReadingSchema,
  HostLinkStateSchema,
  HostServiceStatusSchema,
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
