// @miyoria/cluster: the cluster module of Core (docs/design/v5-hostd.md §6). The control link
// each host's hostd dials, the hosts that joined (`cluster_hosts`, `cluster_invites`), the
// registry of service endpoints, and the guarded states hosts ask about.

export {
  type CallerHost,
  ClusterCalls,
  type ClusterCallsOptions,
  type ClusterCompleteFn,
  type ClusterCompletion,
  type ClusterRateLimit,
  type ClusterUse,
  type ClusterUses,
  DEFAULT_CLUSTER_LLM_PURPOSES,
  DEFAULT_CLUSTER_LLM_RATE,
  DEFAULT_CLUSTER_USES,
} from "./calls.js";
export {
  type ClusterConfig,
  ClusterConfigSchema,
  DEFAULT_CLUSTER_BIND,
  type StaticEndpointConfig,
  StaticEndpointConfigSchema,
} from "./config.js";
export { GuardRegistry, type GuardSourceFn } from "./guards.js";
export { ClusterLink, type ClusterLinkOptions, closeSocket, type HostConnection } from "./link.js";
export { clusterSchema } from "./migrations.js";
export {
  type ClusterComplete,
  type ClusterGuard,
  type ClusterHosts,
  ClusterKey,
  type ClusterLinksSource,
  ClusterModule,
  type ClusterModuleOptions,
  type ClusterService,
} from "./module.js";
export {
  type Endpoint,
  EndpointRegistry,
  type EndpointRegistryOptions,
  type LinkRelay,
  type PickOptions,
  RelayUnavailableError,
} from "./registry.js";
export {
  ClusterRelay,
  DEFAULT_RELAY_TIMEOUT_MS,
  RelayChannel,
  type RelayChannelOptions,
  RelayError,
  type RelayHost,
  type RelayOptions,
} from "./relay.js";
export {
  type ClusterHostRow,
  type ClusterInviteRow,
  clusterHosts,
  clusterInvites,
  HOST_STATUSES,
  type HostStatus,
} from "./schema.js";
export {
  ClusterError,
  ClusterTables,
  clusterTables,
  DEFAULT_INVITE_TTL_S,
  type HostRecord,
  Hosts,
  InviteError,
  Invites,
  type NewHost,
  type NewInvite,
} from "./tables.js";
