// @miyoria/runtime/kernel: every feature is a `Module`. The `Supervisor` starts modules in dependency
// order, restarts them when they fail and lets them be enabled or disabled at runtime. Modules
// only talk to each other through the `EventBus` and the `ServiceRegistry`, both reached via
// the `ModuleContext` they get in `start`.

export {
  errorMessage,
  interval,
  isAbortError,
  SerialQueue,
  sleep,
  withTimeout,
} from "./async.js";
export {
  type BusPublishHook,
  busPublishHook,
  clearBusCheckExemptions,
  DEFAULT_BUS_CAPACITY,
  EventBus,
  type EventBusOptions,
  exemptFromBusCheck,
  type SubscribeOptions,
  Subscription,
  setBusPublishHook,
  TopicFilter,
  type TopicFilterLike,
  topicPrefix,
} from "./bus.js";
export {
  Config,
  ConfigError,
  type ConfigErrorCode,
  type EnvLookup,
  expandEnv,
  interpolateEnv,
  loadDotenv,
  type ModuleSection,
  parseSection,
  parseTomlJson,
  processEnv,
} from "./config.js";
export {
  type ConfigCheckOptions,
  type ConfigPolicy,
  type ConfigProblem,
  type ConfigSchema,
  type ConfigSchemaParts,
  type ConfigSection,
  type ConfigSeverity,
  CoreSectionSchema,
  checkConfig,
  composeConfigSchema,
  configJsonSchema,
  configPath,
  configProblemsError,
  describeProblem,
  moduleSectionSchema,
  schemaAt,
} from "./config-schema.js";
export { ModuleContext, type Task } from "./context.js";
export {
  type Endpoint,
  type EndpointQuery,
  type EndpointSource,
  type EndpointsOption,
  firstEndpoint,
} from "./endpoints.js";
export {
  configureLogging,
  formatLogLine,
  getLogger,
  type LogBindings,
  type LogFn,
  type Logger,
  type LoggingOptions,
  type LogLevel,
} from "./log.js";
export {
  Counter,
  DEFAULT_BUCKETS,
  formatValue,
  Gauge,
  Histogram,
  type HistogramOptions,
  type Labels,
  METRICS_CONTENT_TYPE,
  type MetricFamily,
  type MetricOptions,
  type MetricSample,
  MetricsError,
  MetricsRegistry,
  type MetricType,
  metrics,
  OVERFLOW_LABEL,
  renderMetrics,
} from "./metrics.js";
export {
  defineManifest,
  HEALTHY,
  type Health,
  type ManifestOptions,
  type Module,
  type ModuleManifest,
  type ModuleManifestJson,
  manifestJson,
} from "./module.js";
export { type ServiceLookup, ServiceRegistry, ServiceUnavailableError } from "./services.js";
export {
  MAX_BACKOFF_MS,
  MAX_RESTARTS_IN_WINDOW,
  type ModuleStatus,
  RESTART_WINDOW_MS,
  type RegisterOptions,
  RequiredModuleError,
  restartBackoffMs,
  STOP_TIMEOUT_MS,
  Supervisor,
  SupervisorError,
  SupervisorKey,
  type SupervisorOptions,
} from "./supervisor.js";
