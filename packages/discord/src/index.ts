// @miyoria/discord: Discord bot account adapter (module `platform.discord.bot`).
//
// This is the official bot account: it reads and writes text messages, reacts, shows typing and
// serves slash commands, buttons, select menus, modals and autocomplete from the
// `CommandRegistry`. Replies are Components V2 messages (render.ts), never embeds. It never
// joins voice; that is the separate self-account voice node. See `module.ts` for the Developer
// Portal setup.
//
// Pure logic lives in testable functions: `splitMessage` (split.ts), the discord.js <-> Miyoria
// mapping (mapping.ts), rendering (render.ts), the slash command tree and its validation
// (slash.ts), command sync and scope cleanup (sync.ts) and the interaction flow
// (interaction.ts). `DiscordHistory` (history.ts) reads earlier messages for the agent.

export { type DiscordConfig, DiscordConfigSchema, validateDiscordConfig } from "./config.js";
export { ambientChannel, type ChannelIds, messageAllowed } from "./gate.js";
export {
  DiscordHistory,
  type FetchedLike,
  type HistoryClientLike,
  MAX_FETCH,
  type MessageManagerLike,
} from "./history.js";
export {
  type Ack as InteractionAck,
  type AutocompleteInteractionLike,
  type CommandDispatcher,
  type CommandInteractionLike,
  type ComponentInteractionLike,
  type ContextMenuInteractionLike,
  componentInvocation,
  DEFER_AFTER_MS,
  type EditPayload,
  HANDLER_FAILED_TEXT,
  handleAutocomplete,
  handleCommandInteraction,
  handleComponentInteraction,
  handleContextMenuInteraction,
  type InteractionEnv,
  InteractionState,
  invocationFromInteraction,
  invocationFromMenu,
  MENU_GONE_TEXT,
  type RepliableLike,
  respondError,
} from "./interaction.js";
export {
  type ArgValueLike,
  account,
  commandPath,
  contextKey,
  displayName,
  hasContent,
  incomingMessage,
  isAdminPermissions,
  isGuildAdmin,
  kindOf,
  type MemberLike,
  type MentionNames,
  type MentionsLike,
  type MessageLike,
  mentionNames,
  type OptionLike,
  PLATFORM,
  parseUserIds,
  platform,
  quotedMessage,
  type ResolvedLike,
  replyRef,
  resolvedUsers,
  resolveMentions,
  snowflake,
} from "./mapping.js";
export {
  createClient,
  DiscordBotModule,
  intents,
  SHUTDOWN_GRACE_MS,
} from "./module.js";
export {
  ACCENT_COLORS,
  disableComponents,
  hasControls,
  MAX_V2_COMPONENTS,
  MAX_V2_TEXT,
  type MessagePayload,
  NO_MENTIONS,
  type PayloadFile,
  renderCard,
  renderModal,
  renderReply,
} from "./render.js";
export {
  DiscordUserResolver,
  type FetchedMember,
  type ResolverClientLike,
} from "./resolver.js";
export {
  type DiscordOutgoing,
  DiscordSendError,
  DiscordSink,
  type RestLike,
  type RestRequest,
} from "./sink.js";
export {
  buildTree,
  type GroupLookup,
  type SlashCommandJson,
  type SlashKind,
  type SlashNode,
  type SlashOptionJson,
  toContextMenuCommands,
  toCreateCommands,
  truncate,
  validateCommand,
  validCommands,
} from "./slash.js";
export { MAX_MESSAGE_LEN, splitMessage } from "./split.js";
export {
  type CommandSource,
  currentCommands,
  type ResetReport,
  resetCommands,
  runSyncLoop,
  SYNC_DEBOUNCE_MS,
  type SyncLoopOptions,
  type SyncOptions,
  type SyncRest,
  type SyncRunnerOptions,
  syncCommands,
  syncRunner,
} from "./sync.js";
