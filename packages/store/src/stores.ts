// Storage interfaces. Each area is its own interface so callers never depend on a backend;
// backends (SQLite by default, Postgres optional) implement all of them.
//
// Data that belongs to one character is keyed by `ProfileId`. Module state and people are
// shared by all profiles. Rust `BTreeMap` results are `Map`s with keys in ascending order.

import {
  type AccountRef,
  type ContextKey,
  type Directive,
  type DirectiveRecord,
  type JsonObject,
  type JsonValue,
  type LogEvent,
  type LogEventFilter,
  type ModuleId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  serviceKey,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import type { DataCategoryId, DataExport, DataInventory, WipeCounts, WipeOptions } from "./data.js";
import type {
  Account,
  AuditEntry,
  AuthoredEntry,
  AuthScope,
  Bounty,
  BountyPatch,
  BountyStatus,
  CoinEntry,
  CoinPost,
  CoinRule,
  Deal,
  DealPatch,
  DealStatus,
  DecisionRecord,
  DocFilter,
  DocUpdate,
  EconomyDoc,
  FortuneRecord,
  Goal,
  GoalFulfiller,
  GoalPatch,
  GoalPledge,
  GoalStatus,
  LedgerDayTotal,
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

/** Append-only conversation log per profile and context. */
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

/** Totals over the whole coin ledger, for the economy's health table (docs/design/v4-plan.md §10). */
export interface LedgerStatsStore {
  /**
   * Coins issued (positive rows) and recovered (negative rows) per local day and reason, from
   * `since` on, all accounts, her purse included. One `GROUP BY`; `offsetMinutes` is the local
   * time zone as minutes east of UTC.
   */
  dailyTotals(
    profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]>;
}

/**
 * The coin ledger (docs/design/economy.md §6): append-only, the balance is a sum. "A wallet" is
 * the rows of any of `accounts`, so a person with several linked accounts has one.
 */
export interface CoinLedgerStore extends LedgerStatsStore {
  /**
   * Appends `entry` in one transaction with the checks of `rule`: the key (once per wallet), the
   * caps, the balance.
   */
  post(entry: CoinEntry, rule: CoinRule): Promise<CoinPost>;
  balance(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number>;
  /** Rows of the wallet, newest first, at most `limit`; `reasons` and `since` narrow them. */
  entries(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]>;
  /** The first row of the wallet with this key, or `null`. */
  byKey(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    key: string,
  ): Promise<CoinEntry | null>;
  /** The card frame chosen last by any of `accounts`, or `null`. */
  selectedFrame(profile: ProfileId, accounts: readonly AccountRef[]): Promise<string | null>;
  selectFrame(
    profile: ProfileId,
    account: AccountRef,
    frame: string | null,
    at: Timestamp,
  ): Promise<void>;
  /** Whether `accounts` are on the sponsor board: yes unless one of them left it. */
  onBoard(profile: ProfileId, accounts: readonly AccountRef[]): Promise<boolean>;
  /**
   * Puts every one of `accounts` on the board or takes them off, so a person is on it as a whole.
   * It never touches the frame choice.
   */
  setOnBoard(profile: ProfileId, accounts: readonly AccountRef[], on: boolean): Promise<void>;
  /** The accounts that left the board, at most `limit`. */
  offBoardAccounts(profile: ProfileId, limit: number): Promise<AccountRef[]>;
  /**
   * What each account spent since `since` on `reasons`, biggest first, at most `limit`: negative
   * rows that were not refunded. `deal_escrow` counts only for a settled deal (released to her).
   */
  spent(
    profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ account: AccountRef; spent: number }[]>;
}

/**
 * The versioned documents of economy 2.0: collection items, predictions and bets, commissions and
 * her room (docs/design/v4-plan.md §10). One table, keyed by (profile, kind, id).
 */
export interface EconomyDocStore {
  /** Stores `doc`; `false` when the id already exists (nothing changes). */
  create(doc: EconomyDoc): Promise<boolean>;
  get(profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null>;
  /**
   * Compare and set: replaces status, data (and the owner when `next.owner` is given, `null`
   * included) and bumps the version, only when the stored version is `expected`. `false` otherwise.
   */
  update(
    profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean>;
  /** Newest first (by creation, the id breaking a tie), at most `filter.limit`. */
  list(profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]>;
}

/**
 * Fortune slips she wrote on the member page (docs/design/economy.md §13), at most one per person
 * per local day. "Theirs" are the slips of any of `accounts`.
 */
export interface FortuneStore {
  /** Stores a slip; `false` when one of these `accounts` already has one for that `day`. */
  put(record: FortuneRecord, accounts: readonly AccountRef[]): Promise<boolean>;
  /** The slip of `day` of any of `accounts`, or `null`. */
  forDay(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    day: number,
  ): Promise<FortuneRecord | null>;
  /** The slips of `accounts`, newest first, at most `limit`. */
  listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]>;
  /** Deletes every slip of `accounts`; returns how many. */
  deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number>;
}

/** Deals she accepted (docs/design/economy.md §12): they outlive restarts. */
export interface DealStore {
  create(deal: Deal): Promise<void>;
  get(id: string): Promise<Deal | null>;
  /**
   * Changes the deal only while its status is one of `from`; `false` when it was not (another
   * writer got there first, or it is gone). The one place a status moves.
   */
  transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean>;
  /** Deals of any of `accounts`, newest first; `statuses` and `since` (created) narrow them. */
  forAccounts(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]>;
  /** Deals of everyone in these statuses, oldest first (the sweep, her context). */
  byStatus(
    profile: ProfileId,
    statuses: readonly DealStatus[],
    filter: { since?: Timestamp; limit: number },
  ): Promise<Deal[]>;
}

/** Her crowdfunding goals and what people pledged (docs/design/economy.md §13). */
export interface GoalStore {
  create(goal: Goal): Promise<void>;
  get(id: string): Promise<Goal | null>;
  /** Changes the goal only while its status is one of `from`; `false` when it was not. */
  transition(id: string, from: readonly GoalStatus[], patch: GoalPatch): Promise<boolean>;
  /** Goals newest first; `statuses` narrows them. */
  list(
    profile: ProfileId,
    filter: { statuses?: readonly GoalStatus[]; limit: number },
  ): Promise<Goal[]>;
  /**
   * Marks a reached goal's promise kept; `false` when the goal is not reached or was marked
   * already (the first mark stands).
   */
  fulfill(id: string, by: GoalFulfiller, at: Timestamp): Promise<boolean>;
  addPledge(pledge: GoalPledge): Promise<void>;
  /** Every pledge of a goal, oldest first. */
  pledges(goal: string): Promise<GoalPledge[]>;
}

/** Bounties she posted from her purse (docs/design/economy.md §13). */
export interface BountyStore {
  create(bounty: Bounty): Promise<void>;
  get(id: string): Promise<Bounty | null>;
  /** Changes the bounty only while its status is one of `from`; `false` when it was not. */
  transition(id: string, from: readonly BountyStatus[], patch: BountyPatch): Promise<boolean>;
  /** Bounties newest first; `statuses` narrows them. */
  list(
    profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; limit: number },
  ): Promise<Bounty[]>;
}

/** Persisted runtime enabled / disabled flag per module. */
export interface ModuleStateStore {
  /** `null` when the flag was never set (the config default applies). */
  get(module: ModuleId): Promise<boolean | null>;
  set(module: ModuleId, enabled: boolean): Promise<void>;
  list(): Promise<Map<ModuleId, boolean>>;
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

/** Long-term memory records (episodes, facts, her own notes, followups). */
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
   * Moves every account of `absorb` to `keep` and deletes `absorb`. Callers must merge
   * per-profile data (relationships, memories) first.
   */
  mergePeople(keep: PersonId, absorb: PersonId): Promise<void>;
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

/** What one compaction pass of the EventLog may delete. */
export interface EventCompaction {
  /** Ambient observations from before this time go. */
  fold_before: Timestamp;
  /** Every event from before this time goes (`null`: none). */
  expire_before: Timestamp | null;
  /** Rows deleted at most in this pass (it blocks whatever else runs on the store). */
  max_rows: number;
}

export interface EventCompactionResult {
  /** Ambient observations deleted. */
  folded: number;
  /** Other events deleted because they expired. */
  expired: number;
  /** Another pass may find more (what these rows caused is gone now). */
  more: boolean;
}

/** How many events compaction removed, per UTC day, kind and source. */
export interface EventRollup {
  day: Timestamp;
  kind: string;
  source: string;
  count: number;
  first_at: Timestamp;
  last_at: Timestamp;
}

/**
 * The EventLog's rows (docs/design/v3-architecture.md §5). Append-only: nothing changes a row.
 * Compaction deletes only rows no other row names as `cause`, so what survives keeps its whole
 * `cause` chain; old rows go leaf first, over several passes.
 */
export interface EventLogStore {
  /** Writes `events` in one transaction. An id that already exists is left as it is. */
  append(profile: ProfileId, events: readonly LogEvent[]): Promise<void>;
  get(profile: ProfileId, id: string): Promise<LogEvent | null>;
  query(profile: ProfileId, filter: LogEventFilter): Promise<LogEvent[]>;
  /** The events that name one of `causes` as their `cause`, oldest first. */
  effectsOf(profile: ProfileId, causes: readonly string[], limit: number): Promise<LogEvent[]>;
  compact(profile: ProfileId, policy: EventCompaction): Promise<EventCompactionResult>;
  /** What compaction removed, newest day first. */
  rollups(profile: ProfileId, limit: number): Promise<EventRollup[]>;
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
  readonly moduleState: ModuleStateStore;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  readonly decisions: DecisionLog;
  readonly settings: SettingsStore;
  readonly memories: MemoryRecordStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  readonly auth: AuthStore;
  readonly audit: AuditLog;
  readonly profileData: ProfileDataStore;
  /** The EventLog. Only the SQLite backend has it so far; without it the log stays in memory. */
  readonly events?: EventLogStore;
  readonly directives: DirectiveStore;
  readonly cards: MemberCardStore;
  readonly coins: CoinLedgerStore;
  readonly deals: DealStore;
  readonly fortunes: FortuneStore;
  readonly goals: GoalStore;
  readonly bounties: BountyStore;
  readonly economyDocs: EconomyDocStore;
  /** Releases the backend (closes the database). */
  close(): Promise<void>;
}

// Service keys: the app provides each area (owner `"kernel"`) so modules can look them up.
export const MessageLogKey = serviceKey<MessageLog>("MessageLog");
export const ModuleStateStoreKey = serviceKey<ModuleStateStore>("ModuleStateStore");
export const PersonaOverrideStoreKey = serviceKey<PersonaOverrideStore>("PersonaOverrideStore");
export const PeopleStoreKey = serviceKey<PeopleStore>("PeopleStore");
export const DecisionLogKey = serviceKey<DecisionLog>("DecisionLog");
export const SettingsStoreKey = serviceKey<SettingsStore>("SettingsStore");
export const MemoryRecordStoreKey = serviceKey<MemoryRecordStore>("MemoryRecordStore");
export const RelationshipStoreKey = serviceKey<RelationshipStore>("RelationshipStore");
export const IdentityStoreKey = serviceKey<IdentityStore>("IdentityStore");
export const AuthStoreKey = serviceKey<AuthStore>("AuthStore");
export const AuditLogKey = serviceKey<AuditLog>("AuditLog");
export const ProfileDataStoreKey = serviceKey<ProfileDataStore>("ProfileDataStore");
export const EventLogStoreKey = serviceKey<EventLogStore>("EventLogStore");
export const DirectiveStoreKey = serviceKey<DirectiveStore>("DirectiveStore");
export const MemberCardStoreKey = serviceKey<MemberCardStore>("MemberCardStore");
export const CoinLedgerStoreKey = serviceKey<CoinLedgerStore>("CoinLedgerStore");
export const DealStoreKey = serviceKey<DealStore>("DealStore");
export const FortuneStoreKey = serviceKey<FortuneStore>("FortuneStore");
export const GoalStoreKey = serviceKey<GoalStore>("GoalStore");
export const BountyStoreKey = serviceKey<BountyStore>("BountyStore");
export const EconomyDocsKey = serviceKey<EconomyDocStore>("EconomyDocs");
export const LedgerStatsKey = serviceKey<LedgerStatsStore>("LedgerStats");
export const StoreKey = serviceKey<Store>("Store");
