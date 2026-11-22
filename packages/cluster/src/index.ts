// @miyoria/cluster: the cluster module of Core (docs/design/v5-hostd.md §6). The control link
// each host's hostd dials, the hosts that joined (`cluster_hosts`, `cluster_invites`), the
// registry of service endpoints, and the guarded states hosts ask about.

export { ACTIVITY_EVENTS, ActivityTracker } from "./activity.js";
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
  type CheckoutSource,
  type CommitRelation,
  execGit,
  findCheckoutRoot,
  type GitCheckoutOptions,
  type GitExec,
  gitCheckout,
} from "./checkout.js";
export {
  type ClusterConfig,
  ClusterConfigSchema,
  DEFAULT_CLUSTER_BIND,
  type RoutingCapabilityConfig,
  RoutingCapabilityConfigSchema,
  type RoutingConfig,
  RoutingConfigSchema,
  SPEECH_HOST_MODES,
  type SpeechHostMode,
  type StaticEndpointConfig,
  StaticEndpointConfigSchema,
} from "./config.js";
export {
  ALPHA,
  ANY_HOST,
  type EstimateRow,
  type EstimateStore,
  Estimates,
  memoryEstimateStore,
} from "./estimates.js";
export { GuardRegistry, type GuardSourceFn } from "./guards.js";
export {
  ClusterLink,
  type ClusterLinkOptions,
  closeSocket,
  type HostConnection,
  isLoopbackAddress,
} from "./link.js";
export { clusterSchema } from "./migrations.js";
export {
  type ClusterComplete,
  type ClusterGuard,
  type ClusterHosts,
  ClusterKey,
  type ClusterLinksSource,
  ClusterModule,
  type ClusterModuleOptions,
  type ClusterRouting,
  type ClusterService,
  clusterRouting,
  type RoutingControlInput,
  type RoutingSnapshot,
} from "./module.js";
export {
  type CapabilityRouting,
  type ClusterActivity,
  type DispatchDecision,
  type DispatchedUnit,
  type Endpoint,
  EndpointRegistry,
  type EndpointRegistryOptions,
  type EndpointRouting,
  type LinkRelay,
  NO_PANEL_CONTROLS,
  type PanelControls,
  type PickOptions,
  RelayUnavailableError,
  type ScoreParts,
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
export { RouteProber, type RouteProberOptions } from "./route-probe.js";
export {
  bodyOf,
  neverSent,
  type RoutedDeps,
  type RoutedEndpoint,
  RouteError,
  routedRequest,
  TransferChangedError,
} from "./routed.js";
export {
  GATEWAY_KINDS,
  type ProbeTask,
  REALTIME_KINDS,
  type RouteChoice,
  type RouteHealth,
  type RouteState,
  type RoutesConfig,
  RoutesConfigSchema,
  RouteTable,
  type RouteView,
  type RouteWork,
} from "./routes.js";
export {
  type ClusterControlRow,
  type ClusterEstimateRow,
  type ClusterHostRow,
  type ClusterInviteRow,
  CONTROL_KINDS,
  type ControlKind,
  clusterControls,
  clusterEstimates,
  clusterHosts,
  clusterInvites,
  HOST_STATUSES,
  type HostStatus,
} from "./schema.js";
export {
  ClusterError,
  ClusterTables,
  type ControlRecord,
  Controls,
  clusterTables,
  DEFAULT_INVITE_TTL_S,
  EstimateTable,
  type HostRecord,
  Hosts,
  InviteError,
  Invites,
  type MachineDatabase,
  type NewHost,
  type NewInvite,
  openMachineDatabase,
} from "./tables.js";
