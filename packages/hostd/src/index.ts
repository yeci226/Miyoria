// The per-machine supervisor (docs/design/v5-hostd.md).
export {
  type Caller,
  type ClusterClient,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "./api.js";
export {
  CATALOG_ROOTS,
  type Catalog,
  type CatalogEntry,
  type CatalogProblem,
  DESCRIPTOR_FILE,
  ENV_PLACEHOLDER_PREFIX,
  isKnownPlaceholder,
  LINK_PLACEHOLDER_PREFIX,
  LINK_PLACEHOLDERS,
  type LinkPlaceholder,
  loadCatalog,
  PLACEHOLDERS,
  placeholdersIn,
} from "./catalog.js";
export {
  type CallOptions,
  HostdClient,
  HostdUnavailableError,
  type LogsOptions,
} from "./client.js";
export {
  Daemon,
  type DaemonOptions,
  HOST_KEY_FILE,
  HostdRunningError,
  type HostKey,
  HostKeySchema,
  isLoopbackUrl,
  LINKS_CHANGED_REASON,
  type LinkHandle,
  readHostKey,
  type UpgradeOptions,
} from "./daemon.js";
export {
  type InstallFile,
  InstallFileSchema,
  relativePathProblem,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
  type ServiceInstall,
  sourceLabel,
  sourceUrl,
} from "./descriptor.js";
export { matchesPassEnv, mergeEnv, passEnv, workerBaseEnv } from "./env.js";
export {
  createGateway,
  type GatewayHost,
  type GatewayLogger,
  type GatewayOptions,
  gatewayTarget,
} from "./gateway.js";
export {
  CardReader,
  type CardReaderOptions,
  cudaIndex,
  type DeviceReading,
  deviceReader,
  freeOf,
  fromNvml,
  GpuCache,
  type GpuReader,
  type GpuSample,
  loadNvml,
  type NvmlBinding,
  type NvmlRaw,
  nvidiaSmiReader,
  nvmlLibraries,
  parseNvidiaSmi,
} from "./gpu.js";
export {
  type ArbiterService,
  GPU_PROFILE_FILE,
  GpuArbitration,
  type GpuArbitrationOptions,
  jsonProfileStore,
  realTimers,
} from "./gpu-arbiter.js";
export { coreStatusGuard, GuardUnknownError, guardStatesOf } from "./guard.js";
export {
  HOST_CONFIG_FILE,
  HostConfigError,
  type LoadedHostConfig,
  loadHostConfig,
  parseHostConfig,
  type StateLayout,
  stateLayout,
} from "./host-config.js";
export * from "./install/index.js";
export { linkUrl, linkValues } from "./links.js";
export { fileTail, MEMORY_LINES, ServiceLog } from "./logs.js";
export { HttpPeerClient, PeerError, type ServiceTarget } from "./peers.js";
export {
  freePort,
  localAddress,
  PORT_DENIED_HINT,
  type PortProbe,
  type PortState,
  probePort,
  tcpConnect,
} from "./ports.js";
export { httpHealthy } from "./probe.js";
export {
  checkPlan,
  expandService,
  filesProblem,
  type LiveValues,
  offloadUrls,
  planServices,
  pythonIn,
  type ResolveContext,
  ResolveError,
  type ServicePlan,
  type SpawnSpec,
  type UsedLinks,
} from "./resolve.js";
export {
  type GatewayPlan,
  gatewayProblem,
  type LoadedRoutes,
  loadRoutes,
  type RouteContext,
  type RoutePlan,
  reachOf,
  reportRoutes,
  routesFile,
  withLocal,
} from "./routes.js";
export {
  pidAlive,
  RUN_FILE,
  type RunInfo,
  readRunFile,
  runFilePath,
} from "./run-file.js";
export { JSON_RPC } from "./server.js";
export { DEFAULT_TIMING, type Timing } from "./service.js";
export {
  type ChangedByOptions,
  needsPnpmInstall,
  servicesChangedBy,
  upgradeNotes,
} from "./upgrade/changes.js";
export {
  changedFiles,
  type GitOptions,
  type GitResult,
  git,
  gitEnv,
  hasCommit,
  headOf,
  isAncestor,
  looksLikeCheckout,
  readCheckout,
  trackedChanges,
  trackingOf,
} from "./upgrade/git.js";
export {
  type UpgradeHost,
  Upgrader,
  type UpgraderOptions,
  type UpgradeService,
} from "./upgrade/upgrader.js";
