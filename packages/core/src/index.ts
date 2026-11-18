// @miyoria/core: wires config, store, profile and every module into a running core node.

export { describeStep as describeObsSetupStep } from "@miyoria/stage";
export {
  buildCoreWith,
  Core,
  type CoreOptions,
  type DiscoveredExtension,
  type ExtensionDiscovery,
  type ModuleCatalog,
  type ModuleDeps,
  ProfileIdKey,
  runUntilSignal,
  shutdownSignal,
} from "./boot.js";
export { CLI_PLATFORM, CliPlatform, type CliPlatformOptions } from "./cli-platform.js";
export {
  assertStartConfig,
  CONFIG_SECTIONS,
  type ConfigCheck,
  checkStartConfig,
  MODULE_CONFIG_SCHEMAS,
  rootConfigSchema,
  startPolicy,
  validateRevision,
} from "./config-schema.js";
export type {
  ExtensionListing,
  ExtensionManifestInfo,
  ExtensionsCli,
  ExtensionValidation,
  InstalledExtension,
  NewExtensionOptions,
} from "./ext-cli.js";
export {
  configuredModules,
  MODULE_IDS,
  moduleEnabled,
  NEEDS_TOKEN,
  OPT_IN_MODULES,
  REQUIRED_MODULE_REASONS,
  REQUIRED_MODULES,
} from "./module-ids.js";
export {
  DEFERRED_CHECK_MS,
  type Effective,
  effectiveSection,
  GUARDED_MODULES,
  layerSection,
  ModuleSettings,
  type ModuleSettingsOptions,
} from "./module-settings.js";
export {
  buildCore,
  defaultCatalog,
  extensionsCli,
  llmModule,
  openStore,
  runStageNode,
  type StageObsSetupResult,
  setupStageObs,
} from "./modules.js";
export {
  type CoreLogLevel,
  DEFAULT_DATABASE_URL,
  DEFAULT_PROFILE,
  DEFAULT_PROFILES_DIR,
  databaseUrl,
  loadProfile,
  logFilter,
  logLevel,
  ProfileLoadError,
  profileId,
  profilesDir,
  resolveDatabaseUrl,
  sqlitePath,
} from "./settings.js";
