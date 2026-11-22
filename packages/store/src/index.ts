// @miyoria/store: persistence interfaces, record types and their SQLite implementation on
// `node:sqlite` (a file, or `:memory:` for tests). `openStore(url)` opens the database a store
// URL names.

export {
  type ArtifactCleaner,
  ArtifactCleanerKey,
  CLEAN_PLUGIN,
  type FileLinkRefusal,
  type FileLinkRequest,
  type FileLinkResult,
  type FileLinks,
  FileLinksKey,
  type HandOut,
  isCleanCopy,
} from "./artifacts/handout.js";
export {
  ArtifactTypeError,
  decideType,
  MEDIA_TYPES,
  type MediaType,
  normalizeMime,
  SNIFF_BYTES,
  sniff,
  TextCheck,
} from "./artifacts/media.js";
export { isSpaceMember, type SpaceMembership, spaceMembership } from "./artifacts/membership.js";
export { artifactSchema } from "./artifacts/migrations.js";
export { ArtifactAttachments } from "./artifacts/outgoing.js";
export {
  ArtifactPathError,
  BlobLayout,
  cleanFilename,
  FILENAME_MAX_BYTES,
  isSha256,
} from "./artifacts/paths.js";
export {
  ArtifactPlaces,
  type ArtifactSite,
  type SiteOptions,
  type SitePlace,
} from "./artifacts/places.js";
export {
  ARTIFACT_KINDS,
  ARTIFACT_SCOPES,
  ARTIFACT_SOURCES,
  type ArtifactBlobRow,
  type ArtifactRow,
  type ArtifactShareRow,
  KEPT_BY,
  REVIEW_STATES,
  type ReviewState,
  SHARE_AUDIENCES,
  SHARE_MODES,
  SONG_COVER_SOURCE,
} from "./artifacts/schema.js";
export {
  type AudienceRefusal,
  type AudienceVerdict,
  audienceAllowed,
  type ShareableArtifact,
  type ShareTarget,
} from "./artifacts/share-policy.js";
export {
  type ArtifactShare,
  ArtifactShareError,
  ArtifactShares,
  DEFAULT_SHARE_TTL_MS,
  type ShareInput,
  type ShareLookup,
  type ShareRefusal,
  shareTokenHash,
} from "./artifacts/shares.js";
export {
  ARTIFACT_EVENT_SOURCE,
  type Artifact,
  ArtifactBlobMissingError,
  type ArtifactFilter,
  ArtifactHashMismatchError,
  type ArtifactInput,
  ArtifactInputError,
  ArtifactNotFoundError,
  type ArtifactPlace,
  ArtifactStore,
  ArtifactStoreKey,
  type ArtifactStoreOptions,
  ArtifactTooLargeError,
  DEFAULT_GRACE_MS,
  DEFAULT_LIFETIME_MS,
  DEFAULT_SIZE_LIMITS,
  type SweepResult,
} from "./artifacts/store.js";
export {
  ArtifactSweepSchedule,
  type Sweepable,
  type SweepScheduleOptions,
} from "./artifacts/sweeper.js";
export {
  type ArtifactViewer,
  isLive,
  maySee,
  scopeAllows,
  type VisibleArtifact,
} from "./artifacts/visibility.js";
export { DATA_CATEGORIES, dataCategory, STORE_DATA, storeRegistry } from "./categories.js";
export {
  authScopeKey,
  fromMicros,
  normalizeTimestamp,
  StoreError,
  toMicros,
} from "./common.js";
export {
  CONFIG_IMPORT_AUTHOR,
  ConfigImportError,
  type ConfigImportOptions,
  type ConfigImportResult,
  type ConfigImportTarget,
  type ImportedPlaceSetting,
  importConfigToml,
} from "./config/import.js";
export { configSchema } from "./config/migrations.js";
export { PersonaOverrides } from "./config/persona.js";
export {
  type PlaceSetting,
  type PlaceSettingChange,
  type PlaceSettingFilter,
  PlaceSettings,
  type PlaceSettingsOptions,
  type ResolvedPlaceSetting,
} from "./config/places.js";
export {
  CONFIG_SOURCE,
  ConfigConflictError,
  ConfigModuleState,
  type ConfigRevision,
  ConfigRevisions,
  type ConfigRevisionsOptions,
  type ConfigWriteOptions,
  changedPaths,
  MODULE_TOGGLE_AUTHOR,
  moduleFlags,
} from "./config/revisions.js";
export {
  type ConfigRevisionRow,
  PLACE_SCOPES,
  type PlaceScope,
  type PlaceSettingRow,
  type PluginStateRow,
} from "./config/schema.js";
export {
  PLUGIN_STATE_MAX_BYTES,
  PluginState,
  type PluginStateValue,
  SETTINGS_PLUGIN,
  SettingsState,
} from "./config/state.js";
export {
  type ArchivedFile,
  type ArchiveOptions,
  type ArchiveResult,
  archiveDatabase,
  archiveDate,
  heldFiles,
  MANIFEST_FILE,
} from "./cutover/archive.js";
export {
  type DatabaseCounts,
  type DatabaseLayout,
  type DoctorOptions,
  type DoctorReport,
  inspectDatabase,
  type MigrationReport,
} from "./cutover/doctor.js";
export {
  importLinks,
  importLinksFromFile,
  LINK_IMPORT_SOURCE,
  type LinkConflict,
  type LinkFileImportResult,
  type LinkImportCounts,
  type LinkImportOptions,
  type LinkImportResult,
  type LinkTarget,
  linkImportCounts,
  type OpenedLinkTarget,
  openLinkTarget,
  type PlannedAccount,
  type PlannedPerson,
  type PlannedPref,
  type PrefName,
  v4TierName,
} from "./cutover/links.js";
export {
  CutoverError,
  type CutoverErrorCode,
  type FileFacts,
  fileFacts,
  openReadOnly,
  type ReadOnlyDatabase,
} from "./cutover/old-file.js";
export {
  CATEGORY_SPECS,
  type CategoryData,
  type CategoryInventory,
  type CategorySpec,
  categoryModules,
  DATA_EXPORT_FORMAT,
  type DataCategory,
  type DataCategoryId,
  type DataExport,
  type DataInventory,
  type DataPart,
  DataRegistry,
  GLOBAL_SETTINGS_PROFILE,
  isDataCategoryId,
  type PartInventory,
  prefsPart,
  RESET_CATEGORIES,
  resolveCategories,
  type SettingsPart,
  type SqlDialect,
  type Stmt,
  settingsPart,
  type TablePart,
  tablePart,
  type WipeCounts,
  type WipeOptions,
} from "./data.js";
export { Db, type Orm, type Params, type Row } from "./db.js";
export { AUDIT_TYPES_SQL, AuditTrail } from "./events/audit.js";
export {
  CHAT_TYPES_SQL,
  type ChatLineOptions,
  ChatLog,
  type ChatLogStore,
  messageKey,
  utteranceKey,
} from "./events/chat.js";
export {
  type CursorFilter,
  type CursorRead,
  type DrainOptions,
  type DrainResult,
  EVENT_CURSORS_SQL,
  type EventCursor,
  EventCursors,
} from "./events/cursors.js";
export {
  LLM_CALL_TYPE_SQL,
  LlmCall,
  type LlmCallData,
  type LlmCallStore,
  LlmCallTotals,
  type LlmModelTotals,
} from "./events/llm.js";
export {
  type Awaitable,
  COMPACTED_TIERS,
  type CompactedTier,
  type EventCompaction,
  type EventCompactionResult,
  type EventLogStore,
  type EventQuery,
  type EventRollup,
  EventStore,
  type EventStoreOptions,
  type EventWrite,
  type LoggedEvent,
  type Redaction,
  type RedactionFilter,
  type RedactionListener,
  sessionScope,
} from "./events/log.js";
export {
  CHAT_SQL,
  EVENTS_SQL,
  LLM_CALLS_SQL,
  PARTIAL_REDACTION_SQL,
  TURNS_AUDIT_SQL,
} from "./events/schema.js";
export { TurnLog } from "./events/turns.js";
export {
  ConfigRevised,
  coreEventRegistry,
  EconomyPosted,
  type EconomyPostedData,
  FACTS_EVENTS,
  FACTS_TYPE_PREFIX,
  FactsAction,
  FactsDecision,
  FactsDelivered,
  FactsDirective,
  FactsObservation,
  FactsObservationAmbient,
  FactsObservationSaid,
  FactsProposal,
  FactsResult,
  FactsSteer,
  FactsThought,
  FactsUtterance,
  HeartChanged,
  type HeartChangedData,
  HeartEvidence,
  type HeartEvidenceData,
  PrivacyRedacted,
  SettingsChanged,
  typeDefaults,
} from "./events/types.js";
export {
  HANDLE_PREFIX,
  type PersonHandleDirectory,
  StoredHandleDirectory,
} from "./handles.js";
export {
  HOME_SESSION,
  Identity,
  linkCodeHash,
  onPlaceRows,
  type Place,
  type PlaceAuthor,
  type PlaceRowChange,
  type ResolveOptions,
} from "./identity/identity.js";
export { identitySchema } from "./identity/migrations.js";
export { isMemberOf, SpacePlaces } from "./identity/places.js";
export {
  type AccountRow,
  // The Drizzle tables other plugins' foreign keys point at.
  accounts,
  type Lane,
  type LegacySnapshot,
  type LinkedBy,
  type PersonPrefs,
  type PersonRow,
  persons,
  type RoomCaps,
  type RoomKind,
  type RoomRow,
  type SessionRow,
  type SpaceMemberRow,
  type SpaceRow,
  spaces,
} from "./identity/schema.js";
export { knownNames } from "./known-names.js";
export { legacySchema } from "./legacy-schema/index.js";
export { MemorySettingsStore } from "./memory-settings.js";
export {
  type AppliedMigration,
  appliedMigrations,
  checkDatabaseFile,
  checksum,
  coreSchema,
  databaseRefusal,
  lintSchemas,
  type MigrateOptions,
  type Migration,
  migrate,
  orderSchemas,
  type PluginSchema,
  SchemaError,
  type SchemaErrorCode,
  schemaVersions,
} from "./migrate.js";
export {
  DEFAULT_STORE_URL,
  type OpenStoreOptions,
  openStore,
  parseStoreUrl,
  type StoreLocation,
} from "./open.js";
export { micros } from "./orm.js";
export {
  declined,
  hookCounts,
  PERSON_FORGET_ACTION,
  PERSON_FORGET_TYPE,
  PERSON_MERGE_ACTION,
  PERSON_MERGE_TYPE,
  PersonData,
  type PersonDataStore,
  type PersonForget,
  type PersonHookOutcome,
  type PersonHookResult,
  type PersonHooks,
  type PersonMerge,
  type PersonRequestResult,
} from "./person-data.js";
export type { PluginContext, SettingsFamily, StorePlugin } from "./plugin.js";
export { openPluginDatabase, type PluginDatabaseOptions } from "./plugin-db.js";
export {
  type Account,
  type AuditEntry,
  type AuthoredEntry,
  type AuthScope,
  type DecisionRecord,
  type LogEntry,
  logEntryFromIncoming,
  type MemberCardRecord,
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
  type NodeOverride,
  type Person,
  type PersonaOverride,
  type PrunePolicy,
  type Relationship,
  type RelationshipDelta,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
} from "./records.js";
export { SqliteStore, type SqliteStoreOptions } from "./sqlite.js";
export {
  type AuditLog,
  AuditLogKey,
  type AuthStore,
  AuthStoreKey,
  type DecisionLog,
  DecisionLogKey,
  type DirectiveStore,
  type IdentityStore,
  IdentityStoreKey,
  type MemberCardStore,
  MemberCardStoreKey,
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  type MessageLog,
  MessageLogKey,
  type PeopleStore,
  PeopleStoreKey,
  type PersonaOverrideStore,
  PersonaOverrideStoreKey,
  type ProfileDataStore,
  ProfileDataStoreKey,
  type RelationshipStore,
  type SettingsStore,
  SettingsStoreKey,
  type Store,
  StoreKey,
} from "./stores.js";
