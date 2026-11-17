// The cluster (docs/design/v5-hostd.md §6.2): the machines that joined Core, their control links,
// and the services their hostd runs. Each type is the bus topic it is published on, and its
// payload is that event's data.
//
// Tiers (v5-data §2.5): a host joining, being approved and being removed are changes to who may
// run her services, kept like the audit (`keep`). A link coming and going and a service changing
// state are operational, kept 90 days like the kernel's module states (`short`). All of it names
// machines, addresses and failures: for the owner (`owner`).

import { z } from "zod";
import { HostServiceStateSchema } from "../../host/src/methods.js";
import { defineEvent } from "./registry.js";

/** A service state as hostd reports it (`HostServiceState` of the host protocol). */
export const ClusterServiceStateKindSchema = z
  .enum(HostServiceStateSchema.options)
  .meta({ id: "EventsClusterServiceStateKind" });

/** A host was created: through an invite, or by the owner: `cluster.host.joined`. */
export const ClusterHostJoinedSchema = z
  .object({
    /** The host's id, the one its hostd sends in `hello`. */
    id: z.string(),
    host: z.string(),
    /** It was approved at once (the owner made it), or waits for approval (an invite). */
    status: z.enum(["pending", "approved"]),
  })
  .meta({ id: "EventsClusterHostJoined" });
export type ClusterHostJoinedData = z.output<typeof ClusterHostJoinedSchema>;

/** The owner approved a host for these capabilities: `cluster.host.approved`. */
export const ClusterHostApprovedSchema = z
  .object({ host: z.string(), capabilities: z.array(z.string()) })
  .meta({ id: "EventsClusterHostApproved" });
export type ClusterHostApprovedData = z.output<typeof ClusterHostApprovedSchema>;

/** A host's key was revoked, or its row deleted: `cluster.host.removed`. */
export const ClusterHostRemovedSchema = z
  .object({ host: z.string(), how: z.enum(["revoked", "deleted"]) })
  .meta({ id: "EventsClusterHostRemoved" });
export type ClusterHostRemovedData = z.output<typeof ClusterHostRemovedSchema>;

/** A host's control link was accepted: `cluster.host.connected`. */
export const ClusterHostConnectedSchema = z
  .object({
    host: z.string(),
    platform: z.string(),
    version: z.string(),
    /** Whether what it reports is used. A pending host may connect and report. */
    approved: z.boolean(),
  })
  .meta({ id: "EventsClusterHostConnected" });
export type ClusterHostConnectedData = z.output<typeof ClusterHostConnectedSchema>;

/** A host's control link closed; its endpoints are gone: `cluster.host.disconnected`. */
export const ClusterHostDisconnectedSchema = z
  .object({
    host: z.string(),
    /** The WebSocket close code (`HOST_LINK_CLOSE`, or what the socket closed with). */
    code: z.number().int(),
    reason: z.string(),
  })
  .meta({ id: "EventsClusterHostDisconnected" });
export type ClusterHostDisconnectedData = z.output<typeof ClusterHostDisconnectedSchema>;

/** A service of a connected host changed state (its `service.event`): `cluster.service.state`. */
export const ClusterServiceStateSchema = z
  .object({
    host: z.string(),
    service: z.string(),
    state: ClusterServiceStateKindSchema,
    previous: ClusterServiceStateKindSchema,
    reason: z.string().nullable(),
  })
  .meta({ id: "EventsClusterServiceState" });
export type ClusterServiceStateData = z.output<typeof ClusterServiceStateSchema>;

export const ClusterHostJoined = defineEvent({
  type: "cluster.host.joined",
  v: 1,
  data: ClusterHostJoinedSchema,
  scope: "owner",
  tier: "keep",
});

export const ClusterHostApproved = defineEvent({
  type: "cluster.host.approved",
  v: 1,
  data: ClusterHostApprovedSchema,
  scope: "owner",
  tier: "keep",
});

export const ClusterHostRemoved = defineEvent({
  type: "cluster.host.removed",
  v: 1,
  data: ClusterHostRemovedSchema,
  scope: "owner",
  tier: "keep",
});

export const ClusterHostConnected = defineEvent({
  type: "cluster.host.connected",
  v: 1,
  data: ClusterHostConnectedSchema,
  scope: "owner",
  tier: "short",
});

export const ClusterHostDisconnected = defineEvent({
  type: "cluster.host.disconnected",
  v: 1,
  data: ClusterHostDisconnectedSchema,
  scope: "owner",
  tier: "short",
});

export const ClusterServiceState = defineEvent({
  type: "cluster.service.state",
  v: 1,
  data: ClusterServiceStateSchema,
  scope: "owner",
  tier: "short",
});

/** Every cluster type. */
export const CLUSTER_EVENTS = [
  ClusterHostJoined,
  ClusterHostApproved,
  ClusterHostRemoved,
  ClusterHostConnected,
  ClusterHostDisconnected,
  ClusterServiceState,
] as const;
