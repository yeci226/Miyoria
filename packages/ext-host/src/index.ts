// @miyoria/ext-host: the extension host (module `extensions`).
//
// Extensions are separate processes described by `miyoria.extension.toml`. Each one runs as its
// own supervisor module `ext.<id>` and talks JSON-RPC 2.0 over stdio with `Content-Length`
// framing (`docs/protocols/extension-rpc.md`). The host proxies what an extension registers
// into the shared registries: tools into the `ToolRegistry`, commands into the
// `CommandRegistry`, prompt contributors into `PromptContributors`, and forwards bus events it
// is allowed to see.
//
// The app calls `discover(config, baseDir)` before starting the supervisor and registers every
// returned module; the `cli` functions back the `miyoria ext` subcommands.

export {
  ExtensionCliError,
  type ExtensionListing,
  type Installed,
  install,
  isGitSource,
  isValid,
  list,
  type NewOptions,
  newExtension,
  type Validation,
  validate,
} from "./cli.js";
export {
  type ExtensionSettings,
  extensionSettings,
  grantedPermissions,
  HOST_CONFIG_SECTION,
  type HostConfig,
  HostConfigSchema,
  hostConfigFromConfig,
  type PermissionOverride,
  PermissionOverrideSchema,
  resolvedDirs,
  runtimeCommand,
} from "./config.js";
export { BASE_ENV, type ExtensionEnv, extensionEnv } from "./env.js";
export {
  EXTENSIONS_MODULE_ID,
  ExtensionModule,
  ExtensionProcessError,
  type ExtensionSpec,
  ExtensionStartError,
  extensionModuleId,
  gameToolAllowed,
  HOST_VERSION,
  RESERVED_PREFIXES,
  reservedTopic,
  specEnv,
} from "./extension.js";
export {
  type CatalogEntry,
  type CatalogMcpServer,
  type DiscoveredModule,
  type Discovery,
  discover,
  EXAMPLE_DIRS,
  ExtensionCatalog,
  ExtensionCatalogKey,
  ExtensionsModule,
  findExtensionDirs,
  type SkippedExtension,
} from "./host.js";
export {
  type ConfigSection,
  type EnvSpec,
  ExtensionManifest,
  GAME_ADAPTER_KIND,
  KNOWN_KINDS,
  MANIFEST_FILE,
  ManifestError,
  type ManifestErrorKind,
  ManifestParseError,
  type McpServerSpec,
  type Permissions,
  PermissionsSchema,
  type Placement,
  type Runtime,
  runsOnCore,
  validEnvPattern,
  validGameId,
  validId,
  validPattern,
  validTopic,
} from "./manifest.js";
export {
  CommandSpecSchema,
  type Contributions,
  ContributionsSchema,
  type ExecutorDecl,
  ExecutorDeclSchema,
  type ExtensionInfo,
  type HostInfo,
  type InitializeParams,
  type InitializeResult,
  InitializeResultSchema,
  PROTOCOL_VERSION,
  registryToolName,
  type ToolDecl,
  ToolDeclSchema,
  validToolName,
} from "./protocol.js";
export {
  ExtensionCallError,
  invokeCommand,
  ProxyPrompt,
  ProxyTool,
  toolContextJson,
  toolResultText,
} from "./proxy.js";
export {
  CANCEL_METHOD,
  CLOSED,
  CONFLICT,
  encodeFrame,
  FrameDecoder,
  FrameError,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MAX_FRAME,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  PERMISSION_DENIED,
  Peer,
  RpcError,
  type RpcHandler,
  TIMEOUT,
  UNAVAILABLE,
} from "./rpc.js";
export { ProfileIdKey } from "./services.js";
export {
  callFailureCode,
  ProxyExecutor,
  type ProxyExecutorOptions,
  TaskCallError,
  TaskExecutorRegistry,
} from "./tasks.js";
export { SKIP_DIRS, type Snapshot, sameSnapshot, snapshot, watchRoots } from "./watch.js";
