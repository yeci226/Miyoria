// @miyoria/auth: role-based permissions (module `auth`).
//
// Every account has one effective role per context; the role grants permission nodes such as
// `voice.join` or `admin.module.toggle`. The `AuthStore` is the source of truth; `AuthService`
// caches it and answers `Authorizer` checks synchronously.
//
// Resolution: config owners -> `owner`; explicit assignments whose scope (global / guild /
// channel) covers the subject's context; platform role mappings of the subject's guild; guild
// admins -> `admin`. The highest rank wins; with no candidate the default role (`user`)
// applies. An explicit assignment of a blocked role (rank <= 0) beats everything except config
// owners.
//
// A node is then checked against the effective role's overrides in the most specific scope that
// has a matching one (channel > guild > global), falling back to the role's own lists; at each
// level a deny beats a grant. Patterns: exact, `prefix.*`, `*`.
//
// Wiring: the app provides `AuthStoreKey` (required) and `AuditLogKey` (optional) and registers
// `AuthModule`, which provides `AuthServiceKey`, `AuthorizerKey` and `AuthorizerPreloadKey` and
// registers the `admin role ...` / `admin perm ...` commands.
//
// Storage: the plugin owns its tables (`schema.ts`, `migrations.ts`). Core opens the store with
// `authTables` and provides `store.plugin(authTables).store` as `AuthStoreKey`.

export {
  ADMIN,
  BLOCKED,
  BLOCKED_RANK,
  builtinRoles,
  builtinStatus,
  LEGACY_BUILTIN_GRANTS,
  MODERATOR,
  OWNER,
  PANEL_ACCESS,
  PANEL_WRITE,
  RESTRICTED,
  TRUSTED,
  USER,
} from "./builtin.js";
export { AuthCommands, COMMAND_PATHS } from "./commands.js";
export { authSchema } from "./migrations.js";
export {
  AuthConfigSchema,
  AuthModule,
  AuthServiceKey,
  LOAD_TIMEOUT_MS,
  parseAccount,
} from "./module.js";
export { isValidPattern, matches } from "./node.js";
export {
  type Candidate,
  candidateEquals,
  type GuildKey,
  guildKeyId,
  guildOf,
  isConfigOwner,
  outranks,
  type Resolution,
  Snapshot,
  type Source,
  scopeCovers,
  scopeEquals,
  sourceEquals,
} from "./resolve.js";
export {
  AuthError,
  AuthService,
  type AuthServiceOptions,
  accountString,
  errorChain,
  PRELOAD_TIMEOUT_MS,
} from "./service.js";
export {
  type AuthPlugin,
  type AuthSession,
  AuthSessions,
  AuthTables,
  authTables,
  SESSION_PREFIX,
} from "./tables.js";
