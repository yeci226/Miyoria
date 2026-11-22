// Storage interfaces. Each area is its own interface so callers never depend on the backend;
// `SqliteStore` implements all of them, and tests may provide their own.
//
// Data that belongs to one character is keyed by `ProfileId`. Module state and people are
// shared by all profiles. Map results have their keys in ascending order.

import {
  type AccountRef,
  type ContextKey,
  type Directive,
  type DirectiveRecord,
  type JsonObject,
  type JsonValue,
  type PersonId,
  type Places,
  type PlatformId,
  type ProfileId,
  serviceKey,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import type { ArtifactStore } from "./artifacts/store.js";
import type { PlaceSettings } from "./config/places.js";
import type { ConfigModuleState } from "./config/revisions.js";
import type { DataCategoryId, DataExport, DataInventory, WipeCounts, WipeOptions } from "./data.js";
import type { ChatLogStore } from "./events/chat.js";
import type { LlmCallStore } from "./events/llm.js";
import type { EventLogStore } from "./events/log.js";
import type { PersonHandleDirectory } from "./handles.js";
import type { PersonDataStore, PersonRequestResult } from "./person-data.js";
import type { StorePlugin } from "./plugin.js";
import type {
  Account,
  AuditEntry,
  AuthoredEntry,
  AuthScope,
  DecisionRecord,
  LogEntry,
  MemberCardRecord,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  NodeOverride,
  Person,
  PersonaOverride,
  PrunePolicy,
  Relationship,
  RelationshipDelta,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "./records.js";

/**
 * The conversation lines of one character, per context: on SQLite a reading of the chat events
 * (`ChatLog`). `profile` arguments name the character the database belongs to.
 */
export interface MessageLog {
  /** Appends an entry. Entry ids must be unique. */
  append(entry: LogEntry): Promise<void>;
  /**
   * The most recent `limit` entries of a context, oldest first. Entries with equal timestamps
   * keep their append order.
   */
  recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]>;
  /**
   * When and where `authors` wrote since `since`, oldest first, without the text: for counting.
   * At most `limit` entries, the most recent ones.
   */
  authoredSince(
    profile: ProfileId,
    authors: readonly AccountRef[],
    since: Timestamp,
    limit: number,
  ): Promise<AuthoredEntry[]>;
  /** Deletes every entry of a profile (all contexts); returns how many. */
  purge(profile: ProfileId): Promise<number>;
}

/**
 * Cards issued on the member page. "Their cards" are the cards of any of `accounts`, so a person
 * with several linked accounts sees one set.
 */
export interface MemberCardStore {
  /** Stores a card. Serials must be unique. */
  issue(card: MemberCardRecord): Promise<void>;
  /** The card with this exact serial in the profile, or `null`. */
  bySerial(profile: ProfileId, serial: string): Promise<MemberCardRecord | null>;
  /** Replaces a card's snapshot (voiding it); `false` when there is no such card. */
  amend(profile: ProfileId, serial: string, snapshot: JsonObject): Promise<boolean>;
  /** The cards of `accounts`, newest first, at most `limit`. */
  listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<MemberCardRecord[]>;
  /** How many cards `accounts` were issued at or after `since`. */
  countSince(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    since: Timestamp,
  ): Promise<number>;
  /** How many cards `accounts` hold. */
  countFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number>;
  /** Deletes every card of `accounts`; returns how many. */
  deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number>;
}

/** Runtime edits of persona sections, with full version history. */
export interface PersonaOverrideStore {
  /** Stores a new version of a section and returns its version number. */
  set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number>;
  /** Latest body of every overridden section of a profile. */
  current(profile: ProfileId): Promise<Map<string, string>>;
  /** Every version of one section, oldest first. */
  history(profile: ProfileId, key: string): Promise<PersonaOverride[]>;
}

/** People and their platform accounts. */
export interface PeopleStore {
  /**
   * Records that an account was seen, creating a person on first sight. Returns the person the
   * account belongs to.
   */
  upsertAccount(account: AccountRef, displayName: string): Promise<PersonId>;
  personByAccount(account: AccountRef): Promise<Person | null>;
  /** Every person with their accounts, oldest first (by `created_at`, then id). */
  all(): Promise<Person[]>;
}

export interface DecisionLog {
  append(record: DecisionRecord): Promise<void>;
  /** Newest first, optionally only for one context. */
  recent(profile: ProfileId, context: ContextKey | null, limit: number): Promise<DecisionRecord[]>;
  /**
   * Records how a turn ended (`agent.turn.outcome`), one row per turn (a repeated write of the
   * same turn replaces it). Optional so older backends and test doubles keep working; callers
   * use `?.`.
   */
  appendOutcome?(profile: ProfileId, record: TurnOutcomeRecord): Promise<void>;
  /** Turn outcomes, newest first, optionally only for one context. */
  recentOutcomes?(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<TurnOutcomeRecord[]>;
  /**
   * Every decision since `sinceTs` (inclusive), newest first, with no row cap: for the turn
   * metrics, which need the whole window. Optional like the other turn methods.
   */
  decisionsSince?(profile: ProfileId, sinceTs: Timestamp): Promise<DecisionRecord[]>;
  /** Every turn outcome since `sinceTs` (inclusive), newest first, with no row cap. */
  outcomesSince?(profile: ProfileId, sinceTs: Timestamp): Promise<TurnOutcomeRecord[]>;
}

/**
 * Small per-profile JSON settings changed at runtime (e.g. channel modes set with `/channel mode`).
 * Keys are free-form, conventionally `area:subkey`.
 */
export interface SettingsStore {
  get(profile: ProfileId, key: string): Promise<JsonValue | null>;
  /** `null` deletes the key. */
  set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void>;
  /** All keys starting with `prefix`, in key order. */
  list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>>;
  /** Deletes every key starting with `prefix`; returns how many. */
  deletePrefix(profile: ProfileId, prefix: string): Promise<number>;
}

/**
 * Long-term memory records (episodes, facts, her own notes, followups). On SQLite the `memory`
 * plugin's tables (`@miyoria/memory/memory` `memoryTables`, provided as `MemoryRecordStoreKey`);
 * the interface stays here because the social module and the panel use it too.
 */
export interface MemoryRecordStore {
  upsert(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<boolean>;
  /**
   * Union of full-text hits and nearest neighbours, restricted to `query.scopes`, never
   * superseded records, at most `limit` of each kind of match. Ranking beyond that is the
   * caller's job.
   */
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  /** Newest first. */
  list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]>;
  /** How many records `list` would return without `filter.limit`; optional for test doubles. */
  count?(profile: ProfileId, filter: MemoryFilter): Promise<number>;
  /**
   * For each of `people`, what `list` with that `subject` and `limit: limitEach` returns, in one
   * read: a record about several of them comes back once. Newest first. Optional for test
   * doubles (callers fall back to one `list` per person).
   */
  listAbout?(
    profile: ProfileId,
    people: readonly PersonId[],
    limitEach: number,
  ): Promise<MemoryRecord[]>;
  /**
   * Up to `limit` records that are not superseded and have no embedding, newest first. Optional
   * for test doubles.
   */
  missingEmbeddings?(profile: ProfileId, limit: number): Promise<MemoryRecord[]>;
  /** Records access (bumps `access_count`, sets `last_accessed`). */
  touch(ids: readonly string[], at: Timestamp): Promise<void>;
  /**
   * Open followups with `due <= now`, newest due first (the oldest ones are the ones nobody
   * brought up in time). With `maxAgeMs`, followups that became due longer ago than that are
   * not returned.
   */
  dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs?: number | null,
  ): Promise<MemoryRecord[]>;
  /**
   * Closes (`done`) every open followup that became due before `dueBefore`; returns how many.
   * A followup nobody picked up within a few hours is not worth bringing up any more.
   */
  expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number>;
  /** Deletes forgettable episodes; returns how many. */
  prune(profile: ProfileId, policy: PrunePolicy): Promise<number>;
  /** Deletes everything about a person (they asked her to forget them). */
  deleteBySubject(profile: ProfileId, person: PersonId): Promise<number>;
  /**
   * Rewrites every record about `absorb` to be about `keep`, in every profile (people are
   * shared and `absorb` no longer exists once merged): `absorb` in `subjects` becomes `keep`
   * (no duplicates, order kept) and a `person` scope of `absorb` becomes `keep`'s. Content,
   * tokens, embeddings and timestamps are unchanged, so the full-text and vector indexes stay
   * valid. One transaction. Returns how many records changed.
   */
  mergePerson(keep: PersonId, absorb: PersonId): Promise<number>;
}

/**
 * The old `relationships` and `relationship_deltas` tables. Read-only since phase 4 step 5: what
 * she feels about people lives on the heart's `heart_person` rows, and only the heart's migration
 * (`@miyoria/heart/person`, `migrateOnStart`) reads these. The writes stay for the store's own
 * tests and the data page until v5-data §8 step 14 drops the tables.
 */
export interface RelationshipStore {
  get(profile: ProfileId, person: PersonId): Promise<Relationship | null>;
  upsert(relationship: Relationship): Promise<void>;
  list(profile: ProfileId): Promise<Relationship[]>;
  delete(profile: ProfileId, person: PersonId): Promise<boolean>;
  recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void>;
  /** Oldest first. */
  deltasSince(profile: ProfileId, person: PersonId, since: Timestamp): Promise<RelationshipDelta[]>;
}

/** Linking several platform accounts to one person. */
export interface IdentityStore {
  /** Moves `account` to `person` (creating the account row if needed). */
  linkAccount(account: AccountRef, person: PersonId): Promise<void>;
  /**
   * Moves every account of `absorb` to `keep` and makes `absorb` part of `keep`. The SQLite store
   * runs every schema's `mergePerson` hook with it in one transaction (memories move with it,
   * `personData`) and returns what each did; `null` when no hook ran (a person merged into
   * itself, a store without hooks). Callers merge what they cache themselves (relationships) first.
   */
  mergePeople(keep: PersonId, absorb: PersonId): Promise<PersonRequestResult | null>;
  accountsOf(person: PersonId): Promise<Account[]>;
  setPersonName(person: PersonId, displayName: string): Promise<void>;
  /** Stores a one-time code issued to `account`, valid until `expiresAt`. */
  createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void>;
  /** Returns the issuing account and deletes the code, if still valid at `now`. */
  consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null>;
}

/** Roles, permission grants, platform role mappings. */
export interface AuthStore {
  roles(): Promise<RoleDefinition[]>;
  upsertRole(role: RoleDefinition): Promise<void>;
  deleteRole(name: string): Promise<boolean>;

  assignmentsFor(account: AccountRef): Promise<RoleAssignment[]>;
  allAssignments(): Promise<RoleAssignment[]>;
  /** Replaces an assignment with the same (account, role, scope). */
  assign(assignment: RoleAssignment): Promise<void>;
  revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean>;

  mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]>;
  setMapping(mapping: RoleMapping): Promise<void>;
  removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean>;

  overrides(): Promise<NodeOverride[]>;
  /** Replaces an override with the same (scope, role, node). */
  setOverride(override: NodeOverride): Promise<void>;
  removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first, optionally only one actor's entries. */
  recent(limit: number, actor: string | null): Promise<AuditEntry[]>;
}

/**
 * Whole-profile data operations by category (see `data.ts`): what there is, a JSON backup of
 * it, and deleting it in one transaction.
 */
export interface ProfileDataStore {
  /** Row counts and last update of every category. */
  inventory(profile: ProfileId): Promise<DataInventory>;
  /** The rows of `categories`, as they are (non-exportable categories are left out). */
  export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport>;
  /**
   * Deletes `categories` and what they require (`resolveCategories`), all or nothing. Kept
   * categories are refused.
   */
  wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options?: WipeOptions,
  ): Promise<WipeCounts>;
}

/**
 * The owner's rules (docs/design/v3-architecture.md §9). A rule that ended stays as a row until
 * `prune`, so the panel can show it.
 */
export interface DirectiveStore {
  insert(profile: ProfileId, directive: Directive): Promise<void>;
  /** The rules in force at `now`, oldest first. */
  active(profile: ProfileId, now: Timestamp): Promise<DirectiveRecord[]>;
  /** Every rule, ended ones too, newest first. */
  all(profile: ProfileId, limit: number): Promise<DirectiveRecord[]>;
  /** Ends a rule; `false` when it does not exist or already ended. */
  revoke(profile: ProfileId, id: string, by: string, at: Timestamp): Promise<boolean>;
  /** Deletes rules that ended before `before`; `until_revoked` rules still in force stay. */
  prune(profile: ProfileId, before: Timestamp): Promise<number>;
}

/**
 * One handle per storage area, all backed by the same backend. Areas are separate objects
 * (several of them have a `get` / `list` / `delete` with different signatures).
 */
export interface Store {
  readonly messages: MessageLog;
  /** Module on/off: the `enabled` flags of the current config revision. */
  readonly moduleState: ConfigModuleState;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  readonly decisions: DecisionLog;
  readonly settings: SettingsStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  readonly audit: AuditLog;
  readonly profileData: ProfileDataStore;
  /** The event log (`events`). Optional for test doubles; without it the log stays in memory. */
  readonly events?: EventLogStore;
  /**
   * The files she makes (`artifacts/store.ts`). `null` for an in-memory database, which has no
   * folder for the bytes; optional for test doubles.
   */
  readonly artifacts?: ArtifactStore | null;
  /**
   * Chat lines on the event log: writing them, "do not remember this" and "forget me". Optional
   * for test doubles; `messages` reads the same lines.
   */
  readonly chat?: ChatLogStore;
  /**
   * The LLM calls on the event log, as cost and usage totals. Optional for test doubles; without
   * it the `llm` module's spending starts from zero at every start.
   */
  readonly llmCalls?: LlmCallStore;
  readonly cards: MemberCardStore;
  /**
   * Her stable names for people, kept by the backend itself (the SQLite store's are
   * `persons.handle`). Optional: without it the app keeps them in `settings`.
   */
  readonly handles?: PersonHandleDirectory;
  /**
   * Forgetting and merging a person through every installed schema's hooks, in one transaction
   * (`person-data.ts`). Optional for test doubles.
   */
  readonly personData?: PersonDataStore;
  /**
   * Identity's Spaces, Rooms and members (`identity/places.ts`), which Core provides as
   * `PlacesKey`. Optional for test doubles; without it Core provides no `Places` and every module
   * runs on the cluster config.
   */
  readonly places?: Places;
  /**
   * The per-place settings (`config/places.ts`) Core's `PlaceConfig` reads. Optional for test
   * doubles, like `places`.
   */
  readonly config?: { readonly places: PlaceSettings };
  /**
   * A plugin's tables on this database and its code over them (`plugin.ts`): migrated when the
   * store opened with it, or the first time it is asked for; built once per store.
   */
  plugin<T>(plugin: StorePlugin<T>): T;
  /** Releases the backend (closes the database). */
  close(): Promise<void>;
}

// Service keys: the app provides each area (owner `"kernel"`) so modules can look them up.
export const MessageLogKey = serviceKey<MessageLog>("MessageLog");
export const PersonaOverrideStoreKey = serviceKey<PersonaOverrideStore>("PersonaOverrideStore");
export const PeopleStoreKey = serviceKey<PeopleStore>("PeopleStore");
export const DecisionLogKey = serviceKey<DecisionLog>("DecisionLog");
export const SettingsStoreKey = serviceKey<SettingsStore>("SettingsStore");
export const MemoryRecordStoreKey = serviceKey<MemoryRecordStore>("MemoryRecordStore");
export const IdentityStoreKey = serviceKey<IdentityStore>("IdentityStore");
export const AuthStoreKey = serviceKey<AuthStore>("AuthStore");
export const AuditLogKey = serviceKey<AuditLog>("AuditLog");
export const ProfileDataStoreKey = serviceKey<ProfileDataStore>("ProfileDataStore");
export const MemberCardStoreKey = serviceKey<MemberCardStore>("MemberCardStore");
export const StoreKey = serviceKey<Store>("Store");
