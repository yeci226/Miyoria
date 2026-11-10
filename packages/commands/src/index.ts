// @miyoria/commands: platform-agnostic command framework.
//
// Commands are declared once as a `CommandSpec` with a handler (and optionally component routes
// and autocomplete handlers) and registered in the `CommandRegistry`, which the `commands`
// module provides as the `CommandRegistryKey` service. Platform adapters map specs to their own
// syntax (Discord slash commands, chat `!cmd`, CLI, panel), turn calls into an `Invocation` and
// send back the `CommandReply`: plain text plus an optional card (see `reply.ts`).
//
// Replies follow one visibility rule (`replyEphemeral`): the command's visibility, except that
// warnings and errors are always ephemeral. The visibility is the command's declaration
// (`CommandSpec.ephemeral`, public unless set) or the override of `[modules.commands.visibility]`.
// Controls on replies carry ids `mi:<route>:<params>` and are routed by the registry to the
// command that declared the route, under that command's permission; their `reply` answers
// follow the command's visibility too. A press always runs as the presser.
//
// Discord shows the whole tree plus the panels: `/miyo`, `/song`, and `i` (interactive) under a
// command that has subcommands (`/me i`, `/admin i`).
//
// Permission checks use the `Authorizer` service (the `auth` module's RBAC) when it is
// available. Without it the fallback `Permissions` applies the same built-in role grants
// (`nodes.ts`) to owners, guild admins and everyone else. Commands with `admin.*` / `owner.*`
// nodes are written to the `AuditLog` service when there is one.

export {
  type AnyComponentRoute,
  type AutocompleteHandler,
  type Choice,
  COMPONENT_PREFIX,
  ComponentInvocation,
  type ComponentInvocationData,
  ComponentResult,
  type ComponentRoute,
  componentId,
  componentSegments,
  defineRoute,
  intParam,
  MAX_COMPONENT_ID,
  type SessionInfo,
  validateRoute,
} from "./components.js";
export { type ReplySink, ReplySinkKey, type UserResolver, UserResolverKey } from "./direct.js";
export { HELP_NODE, registerHelp } from "./help.js";
export { CARD_NODE, FORTUNE_NODE, registerKeepsakes } from "./keepsakes.js";
export {
  MAX_MENUS_PER_TARGET,
  MENU_ROOT,
  type MenuSpec,
  type MenuTarget,
  menuArgs,
  menuCommandSpec,
} from "./menu.js";
export {
  MENU_FORGET,
  MENU_PERSON,
  MENU_REPLY,
  MENU_TEXT,
  MESSAGE_EXCLUDE_NODE,
  REPLY_COOLDOWN_MS,
  registerMenus,
  unregisterMenus,
} from "./menus.js";
export {
  type CommandsConfig,
  CommandsConfigSchema,
  CommandsModule,
  type CommandsModuleOptions,
  formatModuleList,
  moduleList,
  registerBuiltins,
} from "./module.js";
export { CommandMount } from "./mount.js";
export {
  type BuiltinRole,
  builtinRole,
  builtinRoleGrants,
  DIRECTIVE_MODERATE,
  FILE_READ,
  granted,
  isAdminNode,
  matches,
  SANDBOX_CODE_RUN,
  WEB_TOOL,
} from "./nodes.js";
export {
  type FieldAsk,
  mappedPaths,
  type PanelAction,
  type PanelDef,
  type PanelPage,
  type PanelStart,
  pathKey,
  registerPanelCommand,
  runCommand,
  type StatusLine,
} from "./panel.js";
export {
  CHANNEL_TIERS,
  type ChannelTier,
  PANEL_COMMANDS,
  type PanelsOptions,
  panelCommandPaths,
  panelDefs,
  registerPanels,
  tierOf,
  unregisterPanels,
} from "./panels.js";
export { Permissions, parseAccount, ROLE_RANK, type Role } from "./perms.js";
export {
  type AuthorizerPreload,
  AuthorizerPreloadKey,
  CommandArgError,
  type CommandHandler,
  CommandRegistry,
  CommandRegistryKey,
  type CommandRegistryOptions,
  type ComponentOutcome,
  type DispatchIo,
  type HandlerResult,
  MAX_PATH_DEPTH,
  normalizeArgs,
  PANEL_SUBCOMMAND,
  type RegisterOptions,
  TEXT as SYSTEM_TEXT,
  VersionSubscription,
  type Visibility,
} from "./registry.js";
export {
  type Accent,
  type ButtonStyle,
  type Card,
  type CardBlock,
  type CardButton,
  type CardOptions,
  type CardSelect,
  CommandReply,
  type ConfirmOptions,
  cancelled,
  cardReply,
  cardText,
  confirm,
  type Modal,
  type ModalField,
  notice,
  type Page,
  pageButtons,
  pageOf,
  type ReplyFile,
  type ReplySession,
  replyEphemeral,
  type SelectOption,
  type Tone,
} from "./reply.js";
export {
  MAX_SESSION_TTL_MS,
  PanelSessions,
  type PanelSessionsOptions,
  SESSION_TTL_MS,
} from "./session.js";
export {
  ArgKind,
  type ArgSpec,
  type ArgValue,
  argSpec,
  CommandError,
  type CommandSpec,
  type CommandSpecOptions,
  commandName,
  commandSpec,
  type FollowUp,
  type GroupInfo,
  Invocation,
  type InvocationData,
  type NodeCheck,
  type ResolvedUser,
  splitPath,
} from "./spec.js";
export { CATEGORY_ORDER, COMMAND_GROUPS, SLASH_REGROUP, typedCommand } from "./tree.js";
