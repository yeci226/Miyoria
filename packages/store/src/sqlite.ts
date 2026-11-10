// SQLite backend on the built-in `node:sqlite` (`DatabaseSync`). A file database or `:memory:`
// (which replaces the Rust in-memory backend for tests and quick runs).
//
// Every call is synchronous inside an async method, so one call never interleaves with another
// in this process: read-modify-write sequences run inside one `BEGIN IMMEDIATE` transaction
// without awaiting. Other processes on the same file are handled by WAL and the busy timeout.
//
// Timestamps are INTEGER microseconds since the epoch, JSON values are text, embeddings are
// little-endian float32 BLOBs (cosine computed in JS), full text uses FTS5 over `tokens`.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type ContextKind,
  type DecisionTrace,
  type Directive,
  type DirectiveRecord,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LogEvent,
  type LogEventFilter,
  type LogEventKind,
  type ModuleId,
  newId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  systemClock,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import {
  allowedDelta,
  authScopeKey,
  canonicalMemoryScope,
  cleanEmbedding,
  contextLookupKey,
  cosine,
  decodeEmbedding,
  embeddingFromF32,
  encodeEmbedding,
  fromMicros,
  MAX_DECISIONS,
  memoryKind,
  memoryOrigin,
  memoryScopeKey,
  memorySourceJson,
  optionalMicros,
  optionalTimestamp,
  parseJson,
  queryTokens,
  StoreError,
  sourceEvents,
  sqlLimit,
  toMicros,
  u32,
  walletWith,
} from "./common.js";
import {
  addCount,
  type DataCategoryId,
  type DataExport,
  type DataInventory,
  readExport,
  readInventory,
  type SqlDialect,
  type Stmt,
  type WipeCounts,
  type WipeOptions,
  wipeStatements,
} from "./data.js";
import type {
  Account,
  AuditEntry,
  AuthoredEntry,
  AuthScope,
  Bounty,
  BountyPatch,
  BountyStatus,
  CoinCap,
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
  MemoryScope,
  MemorySource,
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
import type {
  AuditLog,
  AuthStore,
  BountyStore,
  CoinLedgerStore,
  DealStore,
  DecisionLog,
  DirectiveStore,
  EconomyDocStore,
  EventCompaction,
  EventCompactionResult,
  EventLogStore,
  EventRollup,
  FortuneStore,
  GoalStore,
  IdentityStore,
  MemberCardStore,
  MemoryRecordStore,
  MessageLog,
  ModuleStateStore,
  PeopleStore,
  PersonaOverrideStore,
  ProfileDataStore,
  RelationshipStore,
  SettingsStore,
  Store,
} from "./stores.js";

const log = getLogger("store.sqlite");

/** Ordered `NNNN_name.sql` files, applied once each and recorded in `schema_version`. */
const MIGRATIONS_DIR = new URL("../migrations/sqlite/", import.meta.url);

export interface SqliteStoreOptions {
  /** Source of "now" for rows stamped by the store (`edited_at`, `first_seen`, ...). */
  clock?: Clock;
  /** How long a write waits for another process's lock. Default 5000 ms. */
  busyTimeoutMs?: number;
  /**
   * Decisions kept per profile (older ones are dropped); `null` keeps all. Default: 10 000 for
   * `:memory:` (like the Rust in-memory backend), unbounded for files (like PostgreSQL).
   */
  maxDecisionsPerProfile?: number | null;
}

type Row = Record<string, SQLOutputValue>;
type Params = Record<string, SQLInputValue>;

// ---- row accessors ----------------------------------------------------------------------

function str(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`column \`${column}\` is not text`);
  return v;
}

function optStr(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
}

function num(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`column \`${column}\` is not a number`);
}

function optNum(row: Row, column: string): number | null {
  const v = row[column];
  return v === null || v === undefined ? null : num(row, column);
}

function bool(row: Row, column: string): boolean {
  return num(row, column) !== 0;
}

function json<T>(row: Row, column: string, what: string): T {
  return parseJson<T>(str(row, column), what);
}

function ts(row: Row, column: string): Timestamp {
  return fromMicros(num(row, column));
}

function optTs(row: Row, column: string): Timestamp | null {
  return optionalTimestamp(optNum(row, column));
}

function isConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === "number" && (code & 0xff) === 19; // SQLITE_CONSTRAINT
}

/** `null` limits are "no limit", SQLite's `LIMIT -1`. */
function limitParam(limit: number): number {
  return sqlLimit(limit) ?? -1;
}

// ---- backend core -----------------------------------------------------------------------

/** `$1` placeholders as named `$p1` (`node:sqlite` binds no positional `?1`). */
function numbered(stmt: Stmt): [string, Params] {
  const params: Params = {};
  stmt.params.forEach((value, i) => {
    params[`p${i + 1}`] = value as SQLInputValue;
  });
  return [stmt.sql.replace(/\$(\d+)/g, "$$p$1"), params];
}

const SQLITE_DIALECT: SqlDialect = {
  startsWith: (column, param) => `substr(${column}, 1, length(${param})) = ${param}`,
  jsonText: (column) => column,
  keyOrder: "key",
  list: (values) => JSON.stringify(values),
  bool: (value) => (value ? 1 : 0),
};

class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  readonly clock: Clock;
  #open = true;

  constructor(db: DatabaseSync, clock: Clock) {
    this.#db = db;
    this.clock = clock;
  }

  nowMicros(): number {
    return Math.floor(this.clock.now()) * 1000;
  }

  #stmt(sql: string): StatementSync {
    if (!this.#open) throw new StoreError("the store is closed");
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  all(sql: string, params: Params = {}): Row[] {
    return this.#stmt(sql).all(params);
  }

  get(sql: string, params: Params = {}): Row | undefined {
    return this.#stmt(sql).get(params);
  }

  run(sql: string, params: Params = {}): number {
    return Number(this.#stmt(sql).run(params).changes);
  }

  /** A `$1`-style statement (`data.ts`). */
  allStmt(stmt: Stmt): Row[] {
    return this.all(...numbered(stmt));
  }

  runStmt(stmt: Stmt): number {
    return this.run(...numbered(stmt));
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** Runs `fn` in one write transaction. `fn` must not await. */
  tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#statements.clear();
    this.#db.close();
  }
}

function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const known = new Set(files.map((f) => Number.parseInt(f, 10)));
  const applied = new Set(
    db.all("SELECT version FROM schema_version").map((r) => num(r, "version")),
  );
  for (const version of applied) {
    if (!known.has(version)) {
      throw new StoreError(`migration ${version} was previously applied but is missing`);
    }
  }
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
    try {
      db.tx(() => {
        db.exec(sql);
        db.run("INSERT INTO schema_version (version, name, applied_at) VALUES ($v, $name, $at)", {
          v: version,
          name: file.replace(/\.sql$/, ""),
          at: db.nowMicros(),
        });
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("database migration failed", { cause });
    }
    log.info({ version, file }, "applied database migration");
  }
  log.debug("database migrations are up to date");
}

// ---- conversation log ---------------------------------------------------------------------

function logEntryFromRow(row: Row): LogEntry {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    context: {
      platform: str(row, "platform"),
      scope: optStr(row, "scope"),
      channel: str(row, "channel"),
      kind: str(row, "kind") as ContextKind,
    },
    author: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    author_name: str(row, "author_name"),
    text: str(row, "text"),
    is_self: bool(row, "is_self"),
    ts: ts(row, "ts"),
    turn: optStr(row, "turn_id"),
  };
}

class SqliteMessageLog implements MessageLog {
  constructor(private readonly db: Db) {}

  async append(entry: LogEntry): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO message_log (id, profile_id, context_key, platform, scope, channel, kind, " +
          "author_platform, author_id, author_name, text, is_self, ts, turn_id) VALUES ($id, " +
          "$profile, $key, $platform, $scope, $channel, $kind, $author_platform, $author_id, " +
          "$author_name, $text, $is_self, $ts, $turn)",
        {
          id: entry.id,
          profile: entry.profile,
          key: contextLookupKey(entry.context),
          platform: entry.context.platform,
          scope: entry.context.scope,
          channel: entry.context.channel,
          kind: entry.context.kind,
          author_platform: entry.author.platform,
          author_id: entry.author.id,
          author_name: entry.author_name,
          text: entry.text,
          is_self: entry.is_self ? 1 : 0,
          ts: toMicros(entry.ts),
          turn: entry.turn,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`log entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append log entry", { cause });
    }
  }

  async purge(profile: ProfileId): Promise<number> {
    return this.db.run("DELETE FROM message_log WHERE profile_id = $profile", { profile });
  }

  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const rows = this.db.all(
      "SELECT * FROM (SELECT * FROM message_log WHERE profile_id = $profile AND " +
        "context_key = $key ORDER BY ts DESC, seq DESC LIMIT $limit) ORDER BY ts ASC, seq ASC",
      { profile, key: contextLookupKey(context), limit: limitParam(limit) },
    );
    return rows.map(logEntryFromRow);
  }

  async authoredSince(
    profile: ProfileId,
    authors: readonly AccountRef[],
    since: Timestamp,
    limit: number,
  ): Promise<AuthoredEntry[]> {
    if (authors.length === 0) return [];
    const params: Record<string, string | number> = {
      profile,
      since: toMicros(since),
      limit: limitParam(limit),
    };
    const who = authors.map((a, i) => {
      params[`p${i}`] = a.platform;
      params[`a${i}`] = a.id;
      return `(author_platform = $p${i} AND author_id = $a${i})`;
    });
    const rows = this.db.all(
      "SELECT * FROM (SELECT ts, kind, seq FROM message_log WHERE profile_id = $profile AND " +
        `is_self = 0 AND ts >= $since AND (${who.join(" OR ")}) ORDER BY ts DESC, seq DESC ` +
        "LIMIT $limit) ORDER BY ts ASC, seq ASC",
      params,
    );
    return rows.map((row) => ({ ts: ts(row, "ts"), kind: str(row, "kind") as ContextKind }));
  }
}

// ---- member cards -------------------------------------------------------------------------

function memberCardFromRow(row: Row): MemberCardRecord {
  return {
    serial: str(row, "serial"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    issued_at: ts(row, "issued_at"),
    snapshot: json<JsonObject>(row, "snapshot", "member card"),
  };
}

/** `(author_platform = … AND author_id = …) OR …` over `accounts`, its parameters added to `params`. */
function authorsWhere(accounts: readonly AccountRef[], params: Params): string {
  return accounts
    .map((a, i) => {
      params[`p${i}`] = a.platform;
      params[`a${i}`] = a.id;
      return `(author_platform = $p${i} AND author_id = $a${i})`;
    })
    .join(" OR ");
}

class SqliteMemberCards implements MemberCardStore {
  constructor(private readonly db: Db) {}

  async issue(card: MemberCardRecord): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO member_cards (serial, profile_id, author_platform, author_id, person_id, " +
          "issued_at, snapshot) VALUES ($serial, $profile, $platform, $id, $person, $at, $snapshot)",
        {
          serial: card.serial,
          profile: card.profile,
          platform: card.account.platform,
          id: card.account.id,
          person: card.person,
          at: toMicros(card.issued_at),
          snapshot: JSON.stringify(card.snapshot),
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`member card \`${card.serial}\` already exists`, { cause });
      }
      throw new StoreError("cannot store the member card", { cause });
    }
  }

  async bySerial(profile: ProfileId, serial: string): Promise<MemberCardRecord | null> {
    const row = this.db.get(
      "SELECT * FROM member_cards WHERE profile_id = $profile AND serial = $serial",
      { profile, serial },
    );
    return row ? memberCardFromRow(row) : null;
  }

  async amend(profile: ProfileId, serial: string, snapshot: JsonObject): Promise<boolean> {
    const changed = this.db.run(
      "UPDATE member_cards SET snapshot = $snapshot WHERE profile_id = $profile AND serial = $serial",
      { profile, serial, snapshot: JSON.stringify(snapshot) },
    );
    return changed > 0;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<MemberCardRecord[]> {
    if (accounts.length === 0) return [];
    const params: Params = { profile, limit: limitParam(limit) };
    const rows = this.db.all(
      `SELECT * FROM member_cards WHERE profile_id = $profile AND (${authorsWhere(accounts, params)}) ` +
        "ORDER BY issued_at DESC, rowid DESC LIMIT $limit",
      params,
    );
    return rows.map(memberCardFromRow);
  }

  async countSince(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    since: Timestamp,
  ): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile, since: toMicros(since) };
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $profile AND " +
        `issued_at >= $since AND (${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  async countFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    return this.db.run(
      "DELETE FROM member_cards WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
  }
}

// ---- coins ---------------------------------------------------------------------------------

function coinFromRow(row: Row): CoinEntry {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    delta: num(row, "delta"),
    reason: str(row, "reason"),
    ref: optStr(row, "ref"),
    idem_key: optStr(row, "idem_key"),
    ts: ts(row, "ts"),
  };
}

/** `reason IN (…)` over `reasons`, its parameters added to `params`. */
function reasonsIn(reasons: readonly string[], params: Params): string {
  const names = reasons.map((r, i) => {
    params[`r${i}`] = r;
    return `$r${i}`;
  });
  return `reason IN (${names.join(", ")})`;
}

class SqliteCoins implements CoinLedgerStore {
  constructor(private readonly db: Db) {}

  #balance(profile: ProfileId, accounts: readonly AccountRef[]): number {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT COALESCE(SUM(delta), 0) AS n FROM coin_ledger WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  #sum(profile: ProfileId, cap: CoinCap): number {
    if (cap.reasons.length === 0 || cap.accounts?.length === 0) return 0;
    const params: Params = { profile, since: toMicros(cap.since) };
    const who = cap.accounts === null ? "" : ` AND (${authorsWhere(cap.accounts, params)})`;
    const row = this.db.get(
      "SELECT COALESCE(SUM(delta), 0) AS n FROM coin_ledger WHERE profile_id = $profile AND " +
        `ts >= $since AND ${reasonsIn(cap.reasons, params)}${who}`,
      params,
    );
    return row ? num(row, "n") : 0;
  }

  #byKey(profile: ProfileId, accounts: readonly AccountRef[], key: string): CoinEntry | null {
    if (accounts.length === 0) return null;
    const params: Params = { profile, key };
    const row = this.db.get(
      "SELECT * FROM coin_ledger WHERE profile_id = $profile AND idem_key = $key AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY ts, rowid LIMIT 1`,
      params,
    );
    return row ? coinFromRow(row) : null;
  }

  async post(entry: CoinEntry, rule: CoinRule): Promise<CoinPost> {
    if (!Number.isSafeInteger(entry.delta)) throw new StoreError("a coin delta must be whole");
    const wallet = walletWith(entry.account, rule.wallet);
    const profile = entry.profile;
    try {
      return this.db.tx((): CoinPost => {
        if (entry.idem_key !== null) {
          const first = this.#byKey(profile, wallet, entry.idem_key);
          if (first) {
            return { status: "duplicate", entry: first, balance: this.#balance(profile, wallet) };
          }
        }
        const balance = this.#balance(profile, wallet);
        const delta = allowedDelta(entry.delta, rule, (cap) => this.#sum(profile, cap));
        if (delta === null) return { status: "capped", balance };
        if (rule.covered && balance + delta < 0) return { status: "short", balance };
        this.db.run(
          "INSERT INTO coin_ledger (id, profile_id, author_platform, author_id, delta, reason, " +
            "ref, idem_key, ts) VALUES ($id, $profile, $platform, $account, $delta, $reason, " +
            "$ref, $key, $ts)",
          {
            id: entry.id,
            profile,
            platform: entry.account.platform,
            account: entry.account.id,
            delta,
            reason: entry.reason,
            ref: entry.ref,
            key: entry.idem_key,
            ts: toMicros(entry.ts),
          },
        );
        return { status: "posted", entry: { ...entry, delta }, balance: balance + delta };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  async balance(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    return this.#balance(profile, accounts);
  }

  async entries(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]> {
    if (accounts.length === 0 || filter.reasons?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND (${authorsWhere(accounts, params)})`;
    if (filter.reasons) where += ` AND ${reasonsIn(filter.reasons, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND ts >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM coin_ledger WHERE ${where} ORDER BY ts DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(coinFromRow);
  }

  async byKey(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    key: string,
  ): Promise<CoinEntry | null> {
    return this.#byKey(profile, accounts, key);
  }

  async selectedFrame(profile: ProfileId, accounts: readonly AccountRef[]): Promise<string | null> {
    if (accounts.length === 0) return null;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT frame FROM coin_wallets WHERE profile_id = $profile AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY updated_at DESC LIMIT 1`,
      params,
    );
    return row ? optStr(row, "frame") : null;
  }

  async selectFrame(
    profile: ProfileId,
    account: AccountRef,
    frame: string | null,
    at: Timestamp,
  ): Promise<void> {
    this.db.run(
      "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at) " +
        "VALUES ($profile, $platform, $id, $frame, $at) ON CONFLICT (profile_id, " +
        "author_platform, author_id) DO UPDATE SET frame = excluded.frame, updated_at = " +
        "excluded.updated_at",
      { profile, platform: account.platform, id: account.id, frame, at: toMicros(at) },
    );
  }

  async onBoard(profile: ProfileId, accounts: readonly AccountRef[]): Promise<boolean> {
    if (accounts.length === 0) return true;
    const params: Params = { profile };
    const row = this.db.get(
      "SELECT 1 AS x FROM coin_wallets WHERE profile_id = $profile AND off_board = 1 AND " +
        `(${authorsWhere(accounts, params)}) LIMIT 1`,
      params,
    );
    return !row;
  }

  async setOnBoard(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    on: boolean,
  ): Promise<void> {
    // A row made only for the board is the oldest, so it never hides a chosen frame.
    this.db.tx(() => {
      for (const account of accounts) {
        this.db.run(
          "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at, " +
            "off_board) VALUES ($profile, $platform, $id, NULL, 0, $off) ON CONFLICT (profile_id, " +
            "author_platform, author_id) DO UPDATE SET off_board = excluded.off_board",
          { profile, platform: account.platform, id: account.id, off: on ? 0 : 1 },
        );
      }
    });
  }

  async offBoardAccounts(profile: ProfileId, limit: number): Promise<AccountRef[]> {
    const rows = this.db.all(
      "SELECT author_platform, author_id FROM coin_wallets WHERE profile_id = $profile AND " +
        "off_board = 1 ORDER BY author_platform, author_id LIMIT $limit",
      { profile, limit: limitParam(limit) },
    );
    return rows.map((r) => ({ platform: str(r, "author_platform"), id: str(r, "author_id") }));
  }

  async spent(
    profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ account: AccountRef; spent: number }[]> {
    if (reasons.length === 0) return [];
    const params: Params = { profile, since: toMicros(since), limit: limitParam(limit) };
    const names = reasons.map((r, i) => {
      params[`r${i}`] = r;
      return `$r${i}`;
    });
    const rows = this.db.all(
      "SELECT l.author_platform AS author_platform, l.author_id AS author_id, " +
        "-SUM(l.delta) AS n FROM coin_ledger l WHERE l.profile_id = $profile AND l.ts >= $since " +
        `AND l.delta < 0 AND l.reason IN (${names.join(", ")}) AND (l.reason <> 'deal_escrow' ` +
        "OR EXISTS (SELECT 1 FROM deals d WHERE d.escrow_entry = l.id AND d.status = 'settled')) " +
        "AND NOT EXISTS (SELECT 1 FROM coin_ledger r WHERE r.profile_id = l.profile_id AND " +
        "r.reason = 'refund' AND r.ref = l.id) GROUP BY l.author_platform, l.author_id " +
        "HAVING SUM(l.delta) < 0 ORDER BY n DESC, l.author_platform, l.author_id LIMIT $limit",
      params,
    );
    return rows.map((r) => ({
      account: { platform: str(r, "author_platform"), id: str(r, "author_id") },
      spent: num(r, "n"),
    }));
  }

  async dailyTotals(
    profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]> {
    // Microseconds since the epoch, moved to local time, divided into whole days (ts is positive;
    // the casts keep the division integral however the driver binds a JS number).
    const rows = this.db.all(
      "SELECT CAST((ts + CAST($offset AS INTEGER)) / 86400000000 AS INTEGER) AS day, reason, " +
        "COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS positive, " +
        "COALESCE(-SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END), 0) AS negative " +
        "FROM coin_ledger WHERE profile_id = $profile AND ts >= $since " +
        "GROUP BY day, reason ORDER BY day, reason",
      { profile, since: toMicros(since), offset: Math.round(offsetMinutes) * 60_000_000 },
    );
    return rows.map((r) => ({
      day: num(r, "day"),
      reason: str(r, "reason"),
      positive: num(r, "positive"),
      negative: num(r, "negative"),
    }));
  }
}

// ---- fortunes ------------------------------------------------------------------------------

function fortuneFromRow(row: Row): FortuneRecord {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    day: num(row, "day"),
    issued_at: ts(row, "issued_at"),
    entry: optStr(row, "entry_id"),
    slip: json<JsonObject>(row, "slip", "fortune"),
  };
}

class SqliteFortunes implements FortuneStore {
  constructor(private readonly db: Db) {}

  async put(record: FortuneRecord, accounts: readonly AccountRef[]): Promise<boolean> {
    const wallet = walletWith(record.account, accounts);
    try {
      return this.db.tx((): boolean => {
        const params: Params = { profile: record.profile, day: record.day };
        const taken = this.db.get(
          "SELECT id FROM fortunes WHERE profile_id = $profile AND day = $day AND " +
            `(${authorsWhere(wallet, params)}) LIMIT 1`,
          params,
        );
        if (taken) return false;
        this.db.run(
          "INSERT INTO fortunes (id, profile_id, author_platform, author_id, person_id, day, " +
            "issued_at, entry_id, slip) VALUES ($id, $profile, $platform, $account, $person, " +
            "$day, $at, $entry, $slip)",
          {
            id: record.id,
            profile: record.profile,
            platform: record.account.platform,
            account: record.account.id,
            person: record.person,
            day: record.day,
            at: toMicros(record.issued_at),
            entry: record.entry,
            slip: JSON.stringify(record.slip),
          },
        );
        return true;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the fortune", { cause });
    }
  }

  async forDay(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    day: number,
  ): Promise<FortuneRecord | null> {
    if (accounts.length === 0) return null;
    const params: Params = { profile, day };
    const row = this.db.get(
      "SELECT * FROM fortunes WHERE profile_id = $profile AND day = $day AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
      params,
    );
    return row ? fortuneFromRow(row) : null;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]> {
    if (accounts.length === 0) return [];
    const params: Params = { profile, limit: limitParam(limit) };
    const rows = this.db.all(
      `SELECT * FROM fortunes WHERE profile_id = $profile AND (${authorsWhere(accounts, params)}) ` +
        "ORDER BY issued_at DESC, rowid DESC LIMIT $limit",
      params,
    );
    return rows.map(fortuneFromRow);
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: Params = { profile };
    return this.db.run(
      `DELETE FROM fortunes WHERE profile_id = $profile AND (${authorsWhere(accounts, params)})`,
      params,
    );
  }
}

// ---- deals ---------------------------------------------------------------------------------

function dealFromRow(row: Row): Deal {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    item: str(row, "reward_item"),
    count: num(row, "reward_count"),
    value: num(row, "reward_value"),
    task: str(row, "task"),
    prepaid: bool(row, "prepaid"),
    escrow: optStr(row, "escrow_entry"),
    status: str(row, "status") as DealStatus,
    created_at: ts(row, "created_at"),
    done_at: optTs(row, "done_at"),
    due_at: optTs(row, "due_at"),
    closed_at: optTs(row, "closed_at"),
  };
}

/** `status IN (...)` over `statuses`, its parameters added to `params`. */
function statusIn(statuses: readonly string[], params: Params): string {
  const names = statuses.map((s, i) => {
    params[`s${i}`] = s;
    return `$s${i}`;
  });
  return `status IN (${names.join(", ")})`;
}

class SqliteDeals implements DealStore {
  constructor(private readonly db: Db) {}

  async create(deal: Deal): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO deals (id, profile_id, author_platform, author_id, reward_item, " +
          "reward_count, reward_value, task, prepaid, escrow_entry, status, created_at, " +
          "done_at, due_at, closed_at) VALUES ($id, $profile, $platform, $account, $item, " +
          "$count, $value, $task, $prepaid, $escrow, $status, $created, $done, $due, $closed)",
        {
          id: deal.id,
          profile: deal.profile,
          platform: deal.account.platform,
          account: deal.account.id,
          item: deal.item,
          count: deal.count,
          value: deal.value,
          task: deal.task,
          prepaid: deal.prepaid ? 1 : 0,
          escrow: deal.escrow,
          status: deal.status,
          created: toMicros(deal.created_at),
          done: optionalMicros(deal.done_at),
          due: optionalMicros(deal.due_at),
          closed: optionalMicros(deal.closed_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the deal", { cause });
    }
  }

  async get(id: string): Promise<Deal | null> {
    const row = this.db.get("SELECT * FROM deals WHERE id = $id", { id });
    return row ? dealFromRow(row) : null;
  }

  async transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    for (const [column, value] of [
      ["done_at", patch.done_at],
      ["due_at", patch.due_at],
      ["closed_at", patch.closed_at],
    ] as const) {
      if (value === undefined) continue;
      params[column] = optionalMicros(value);
      sets.push(`${column} = $${column}`);
    }
    return (
      this.db.run(
        `UPDATE deals SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async forAccounts(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (accounts.length === 0 || filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND (${authorsWhere(accounts, params)})`;
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND created_at >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(dealFromRow);
  }

  async byStatus(
    profile: ProfileId,
    statuses: readonly DealStatus[],
    filter: { since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (statuses.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = `profile_id = $profile AND ${statusIn(statuses, params)}`;
    if (filter.since !== undefined) {
      params.since = toMicros(filter.since);
      where += " AND created_at >= $since";
    }
    const rows = this.db.all(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at, rowid LIMIT $limit`,
      params,
    );
    return rows.map(dealFromRow);
  }
}

// ---- goals and bounties --------------------------------------------------------------------

function goalFromRow(row: Row): Goal {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    title: str(row, "title"),
    promise: str(row, "promise"),
    target: num(row, "target"),
    status: str(row, "status") as GoalStatus,
    created_at: ts(row, "created_at"),
    deadline: ts(row, "deadline"),
    closed_at: optTs(row, "closed_at"),
  };
}

function pledgeFromRow(row: Row): GoalPledge {
  return {
    id: str(row, "id"),
    goal: str(row, "goal_id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    amount: num(row, "amount"),
    created_at: ts(row, "created_at"),
  };
}

class SqliteGoals implements GoalStore {
  constructor(private readonly db: Db) {}

  async create(goal: Goal): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO goals (id, profile_id, title, promise, target, status, created_at, " +
          "deadline, closed_at) VALUES ($id, $profile, $title, $promise, $target, $status, " +
          "$created, $deadline, $closed)",
        {
          id: goal.id,
          profile: goal.profile,
          title: goal.title,
          promise: goal.promise,
          target: goal.target,
          status: goal.status,
          created: toMicros(goal.created_at),
          deadline: toMicros(goal.deadline),
          closed: optionalMicros(goal.closed_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the goal", { cause });
    }
  }

  async get(id: string): Promise<Goal | null> {
    const row = this.db.get("SELECT * FROM goals WHERE id = $id", { id });
    return row ? goalFromRow(row) : null;
  }

  async transition(id: string, from: readonly GoalStatus[], patch: GoalPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    if (patch.closed_at !== undefined) {
      params.closed_at = optionalMicros(patch.closed_at);
      sets.push("closed_at = $closed_at");
    }
    return (
      this.db.run(
        `UPDATE goals SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly GoalStatus[]; limit: number },
  ): Promise<Goal[]> {
    if (filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = this.db.all(
      `SELECT * FROM goals WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(goalFromRow);
  }

  async addPledge(pledge: GoalPledge): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO goal_pledges (id, goal_id, profile_id, author_platform, author_id, " +
          "amount, created_at) VALUES ($id, $goal, $profile, $platform, $account, $amount, " +
          "$created)",
        {
          id: pledge.id,
          goal: pledge.goal,
          profile: pledge.profile,
          platform: pledge.account.platform,
          account: pledge.account.id,
          amount: pledge.amount,
          created: toMicros(pledge.created_at),
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the pledge", { cause });
    }
  }

  async pledges(goal: string): Promise<GoalPledge[]> {
    const rows = this.db.all(
      "SELECT * FROM goal_pledges WHERE goal_id = $goal ORDER BY created_at, rowid",
      { goal },
    );
    return rows.map(pledgeFromRow);
  }
}

function bountyFromRow(row: Row): Bounty {
  const platform = optStr(row, "winner_platform");
  const id = optStr(row, "winner_id");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    task: str(row, "task"),
    reward: num(row, "reward"),
    hold: str(row, "hold_entry"),
    status: str(row, "status") as BountyStatus,
    created_at: ts(row, "created_at"),
    expires_at: ts(row, "expires_at"),
    closed_at: optTs(row, "closed_at"),
    winner: platform !== null && id !== null ? { platform, id } : null,
  };
}

class SqliteBounties implements BountyStore {
  constructor(private readonly db: Db) {}

  async create(bounty: Bounty): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO bounties (id, profile_id, task, reward, hold_entry, status, created_at, " +
          "expires_at, closed_at, winner_platform, winner_id) VALUES ($id, $profile, $task, " +
          "$reward, $hold, $status, $created, $expires, $closed, $platform, $winner)",
        {
          id: bounty.id,
          profile: bounty.profile,
          task: bounty.task,
          reward: bounty.reward,
          hold: bounty.hold,
          status: bounty.status,
          created: toMicros(bounty.created_at),
          expires: toMicros(bounty.expires_at),
          closed: optionalMicros(bounty.closed_at),
          platform: bounty.winner?.platform ?? null,
          winner: bounty.winner?.id ?? null,
        },
      );
    } catch (cause) {
      throw new StoreError("cannot write the bounty", { cause });
    }
  }

  async get(id: string): Promise<Bounty | null> {
    const row = this.db.get("SELECT * FROM bounties WHERE id = $id", { id });
    return row ? bountyFromRow(row) : null;
  }

  async transition(
    id: string,
    from: readonly BountyStatus[],
    patch: BountyPatch,
  ): Promise<boolean> {
    if (from.length === 0) return false;
    const params: Params = { id, status: patch.status };
    const sets = ["status = $status"];
    if (patch.closed_at !== undefined) {
      params.closed_at = optionalMicros(patch.closed_at);
      sets.push("closed_at = $closed_at");
    }
    if (patch.winner !== undefined) {
      params.winner_platform = patch.winner?.platform ?? null;
      params.winner_id = patch.winner?.id ?? null;
      sets.push("winner_platform = $winner_platform", "winner_id = $winner_id");
    }
    return (
      this.db.run(
        `UPDATE bounties SET ${sets.join(", ")} WHERE id = $id AND ${statusIn(from, params)}`,
        params,
      ) > 0
    );
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; limit: number },
  ): Promise<Bounty[]> {
    if (filter.statuses?.length === 0) return [];
    const params: Params = { profile, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = this.db.all(
      `SELECT * FROM bounties WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      params,
    );
    return rows.map(bountyFromRow);
  }
}

// ---- economy documents ---------------------------------------------------------------------

function docFromRow(row: Row): EconomyDoc {
  const platform = optStr(row, "owner_platform");
  const id = optStr(row, "owner_id");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: str(row, "kind"),
    owner: platform !== null && id !== null ? { platform, id } : null,
    status: str(row, "status"),
    version: num(row, "version"),
    data: json<JsonObject>(row, "data", "economy document"),
    created_at: ts(row, "created_at"),
    updated_at: ts(row, "updated_at"),
  };
}

class SqliteEconomyDocs implements EconomyDocStore {
  constructor(private readonly db: Db) {}

  async create(doc: EconomyDoc): Promise<boolean> {
    try {
      return (
        this.db.run(
          "INSERT INTO economy_docs (profile_id, kind, id, owner_platform, owner_id, status, " +
            "version, data, created_at, updated_at) VALUES ($profile, $kind, $id, $platform, " +
            "$owner, $status, $version, $data, $created, $updated) ON CONFLICT DO NOTHING",
          {
            profile: doc.profile,
            kind: doc.kind,
            id: doc.id,
            platform: doc.owner?.platform ?? null,
            owner: doc.owner?.id ?? null,
            status: doc.status,
            version: doc.version,
            data: JSON.stringify(doc.data),
            created: toMicros(doc.created_at),
            updated: toMicros(doc.updated_at),
          },
        ) > 0
      );
    } catch (cause) {
      throw new StoreError("cannot write the economy document", { cause });
    }
  }

  async get(profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null> {
    const row = this.db.get(
      "SELECT * FROM economy_docs WHERE profile_id = $profile AND kind = $kind AND id = $id",
      { profile, kind, id },
    );
    return row ? docFromRow(row) : null;
  }

  async update(
    profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean> {
    const params: Params = {
      profile,
      kind,
      id,
      expected,
      status: next.status,
      data: JSON.stringify(next.data),
      at: toMicros(next.at),
    };
    let owner = "";
    if (next.owner !== undefined) {
      params.platform = next.owner?.platform ?? null;
      params.owner = next.owner?.id ?? null;
      owner = ", owner_platform = $platform, owner_id = $owner";
    }
    try {
      return (
        this.db.run(
          "UPDATE economy_docs SET status = $status, data = $data, version = version + 1, " +
            `updated_at = $at${owner} WHERE profile_id = $profile AND kind = $kind AND ` +
            "id = $id AND version = $expected",
          params,
        ) > 0
      );
    } catch (cause) {
      throw new StoreError("cannot update the economy document", { cause });
    }
  }

  async list(profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]> {
    if (filter.statuses?.length === 0 || filter.owners?.length === 0) return [];
    const params: Params = { profile, kind, limit: limitParam(filter.limit) };
    let where = "profile_id = $profile AND kind = $kind";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    if (filter.owners) {
      const who = filter.owners.map((a, i) => {
        params[`op${i}`] = a.platform;
        params[`oi${i}`] = a.id;
        return `(owner_platform = $op${i} AND owner_id = $oi${i})`;
      });
      where += ` AND (${who.join(" OR ")})`;
    }
    const rows = this.db.all(
      `SELECT * FROM economy_docs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $limit`,
      params,
    );
    return rows.map(docFromRow);
  }
}

// ---- module state -------------------------------------------------------------------------

class SqliteModuleState implements ModuleStateStore {
  constructor(private readonly db: Db) {}

  async get(module: ModuleId): Promise<boolean | null> {
    const row = this.db.get("SELECT enabled FROM module_state WHERE module_id = $module", {
      module,
    });
    return row ? bool(row, "enabled") : null;
  }

  async set(module: ModuleId, enabled: boolean): Promise<void> {
    this.db.run(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ($module, $enabled, " +
        "$at) ON CONFLICT (module_id) DO UPDATE SET enabled = excluded.enabled, " +
        "updated_at = excluded.updated_at",
      { module, enabled: enabled ? 1 : 0, at: this.db.nowMicros() },
    );
  }

  async list(): Promise<Map<ModuleId, boolean>> {
    const rows = this.db.all("SELECT module_id, enabled FROM module_state ORDER BY module_id");
    return new Map(rows.map((r) => [str(r, "module_id"), bool(r, "enabled")]));
  }
}

// ---- persona overrides --------------------------------------------------------------------

class SqlitePersonaOverrides implements PersonaOverrideStore {
  constructor(private readonly db: Db) {}

  async set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    // One statement: the next version is computed under SQLite's write lock.
    const row = this.db.get(
      "INSERT INTO persona_overrides (profile_id, section_key, version, body, edited_by, " +
        "edited_at) SELECT $profile, $key, COALESCE(MAX(version), 0) + 1, $body, $by, $at " +
        "FROM persona_overrides WHERE profile_id = $profile AND section_key = $key " +
        "RETURNING version",
      { profile, key, body, by: editedBy, at: this.db.nowMicros() },
    );
    if (!row) throw new StoreError("cannot store persona override");
    return num(row, "version");
  }

  async current(profile: ProfileId): Promise<Map<string, string>> {
    const rows = this.db.all(
      "SELECT section_key, body FROM persona_overrides o WHERE profile_id = $profile AND " +
        "version = (SELECT MAX(version) FROM persona_overrides WHERE profile_id = " +
        "o.profile_id AND section_key = o.section_key) ORDER BY section_key",
      { profile },
    );
    return new Map(rows.map((r) => [str(r, "section_key"), str(r, "body")]));
  }

  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    const rows = this.db.all(
      "SELECT version, body, edited_by, edited_at FROM persona_overrides " +
        "WHERE profile_id = $profile AND section_key = $key ORDER BY version ASC",
      { profile, key },
    );
    return rows.map((r) => ({
      profile,
      key,
      version: num(r, "version"),
      body: str(r, "body"),
      edited_by: str(r, "edited_by"),
      edited_at: ts(r, "edited_at"),
    }));
  }
}

// ---- people and identity ------------------------------------------------------------------

function accountFromRow(row: Row): Account {
  return {
    account: { platform: str(row, "platform"), id: str(row, "account_id") },
    display_name: str(row, "display_name"),
    first_seen: ts(row, "first_seen"),
    last_seen: ts(row, "last_seen"),
  };
}

const ACCOUNTS_OF =
  "SELECT platform, account_id, display_name, first_seen, last_seen FROM accounts " +
  "WHERE person_id = $person ORDER BY first_seen, platform, account_id";

class SqlitePeople implements PeopleStore {
  constructor(private readonly db: Db) {}

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    const now = this.db.nowMicros();
    return this.db.tx(() => {
      const existing = this.db.get(
        "UPDATE accounts SET display_name = $name, last_seen = $now " +
          "WHERE platform = $platform AND account_id = $id RETURNING person_id",
        { platform: account.platform, id: account.id, name: displayName, now },
      );
      if (existing) return str(existing, "person_id");
      const person = newId();
      this.db.run(
        "INSERT INTO people (id, display_name, created_at) VALUES ($person, $name, $now)",
        { person, name: displayName, now },
      );
      this.db.run(
        "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
          "last_seen) VALUES ($platform, $id, $person, $name, $now, $now)",
        { platform: account.platform, id: account.id, person, name: displayName, now },
      );
      return person;
    });
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const row = this.db.get(
      "SELECT p.id, p.display_name, p.created_at FROM accounts a " +
        "JOIN people p ON p.id = a.person_id WHERE a.platform = $platform AND a.account_id = $id",
      { platform: account.platform, id: account.id },
    );
    if (!row) return null;
    const id = str(row, "id");
    return {
      id,
      display_name: str(row, "display_name"),
      created_at: ts(row, "created_at"),
      accounts: this.db.all(ACCOUNTS_OF, { person: id }).map(accountFromRow),
    };
  }

  async all(): Promise<Person[]> {
    const accounts = new Map<PersonId, Account[]>();
    const rows = this.db.all(
      "SELECT person_id, platform, account_id, display_name, first_seen, last_seen FROM accounts " +
        "ORDER BY first_seen, platform, account_id",
    );
    for (const row of rows) {
      const person = str(row, "person_id");
      const list = accounts.get(person) ?? [];
      list.push(accountFromRow(row));
      accounts.set(person, list);
    }
    return this.db
      .all("SELECT id, display_name, created_at FROM people ORDER BY created_at, id")
      .map((row) => ({
        id: str(row, "id"),
        display_name: str(row, "display_name"),
        created_at: ts(row, "created_at"),
        accounts: accounts.get(str(row, "id")) ?? [],
      }));
  }
}

class SqliteIdentity implements IdentityStore {
  constructor(private readonly db: Db) {}

  #exists(person: PersonId): boolean {
    return this.db.get("SELECT 1 AS x FROM people WHERE id = $person", { person }) !== undefined;
  }

  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    const now = this.db.nowMicros();
    this.db.tx(() => {
      if (!this.#exists(person)) throw new StoreError(`unknown person \`${person}\``);
      // A new account row has no name yet; its id stands in until the account is seen.
      this.db.run(
        "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
          "last_seen) VALUES ($platform, $id, $person, $id, $now, $now) " +
          "ON CONFLICT (platform, account_id) DO UPDATE SET person_id = excluded.person_id",
        { platform: account.platform, id: account.id, person, now },
      );
    });
  }

  async mergePeople(keep: PersonId, absorb: PersonId): Promise<void> {
    this.db.tx(() => {
      for (const person of [keep, absorb]) {
        if (!this.#exists(person)) throw new StoreError(`unknown person \`${person}\``);
      }
      if (keep === absorb) return;
      this.db.run("UPDATE accounts SET person_id = $keep WHERE person_id = $absorb", {
        keep,
        absorb,
      });
      this.db.run("DELETE FROM people WHERE id = $absorb", { absorb });
    });
  }

  async accountsOf(person: PersonId): Promise<Account[]> {
    return this.db.all(ACCOUNTS_OF, { person }).map(accountFromRow);
  }

  async setPersonName(person: PersonId, displayName: string): Promise<void> {
    const changed = this.db.run("UPDATE people SET display_name = $name WHERE id = $person", {
      person,
      name: displayName,
    });
    if (changed === 0) throw new StoreError(`unknown person \`${person}\``);
  }

  async createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void> {
    this.db.run(
      "INSERT INTO link_codes (code, platform, account_id, expires_at) VALUES ($code, " +
        "$platform, $id, $expires) ON CONFLICT (code) DO UPDATE SET platform = " +
        "excluded.platform, account_id = excluded.account_id, expires_at = excluded.expires_at",
      { code, platform: account.platform, id: account.id, expires: toMicros(expiresAt) },
    );
  }

  async consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null> {
    const row = this.db.get(
      "DELETE FROM link_codes WHERE code = $code RETURNING platform, account_id, expires_at",
      { code },
    );
    if (!row || num(row, "expires_at") <= toMicros(now)) return null;
    return { platform: str(row, "platform"), id: str(row, "account_id") };
  }
}

// ---- decisions ----------------------------------------------------------------------------

class SqliteDecisionLog implements DecisionLog {
  /** Rows per profile, tracked only when capped (the database has no other writer then). */
  readonly #counts = new Map<ProfileId, number>();

  constructor(
    private readonly db: Db,
    private readonly cap: number | null,
  ) {}

  async append(record: DecisionRecord): Promise<void> {
    const params = {
      id: record.id,
      profile: record.profile,
      key: contextLookupKey(record.trace.context),
      ts: toMicros(record.ts),
      trace: JSON.stringify(record.trace),
    };
    try {
      this.db.tx(() => {
        this.db.run(
          "INSERT INTO decision_log (id, profile_id, context_key, ts, trace) " +
            "VALUES ($id, $profile, $key, $ts, $trace)",
          params,
        );
        if (this.cap !== null) this.#trim(record.profile, this.cap);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`decision \`${record.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append decision", { cause });
    }
  }

  async appendOutcome(profile: ProfileId, record: TurnOutcomeRecord): Promise<void> {
    const params = {
      id: record.turn,
      profile,
      key: contextLookupKey(record.context),
      ts: toMicros(record.at),
      outcome: record.outcome.type,
      record: JSON.stringify(record),
    };
    try {
      this.db.tx(() => {
        this.db.run(
          "INSERT INTO turn_outcomes (id, profile_id, context_key, ts, outcome, record) " +
            "VALUES ($id, $profile, $key, $ts, $outcome, $record) " +
            "ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, " +
            "context_key = excluded.context_key, ts = excluded.ts, " +
            "outcome = excluded.outcome, record = excluded.record",
          params,
        );
        if (this.cap !== null) {
          this.db.run(
            "DELETE FROM turn_outcomes WHERE id IN (SELECT id FROM turn_outcomes WHERE " +
              "profile_id = $p ORDER BY ts DESC, id DESC LIMIT -1 OFFSET $cap)",
            { p: profile, cap: this.cap },
          );
        }
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot append turn outcome", { cause });
    }
  }

  async recentOutcomes(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<TurnOutcomeRecord[]> {
    const rows =
      context === null
        ? this.db.all(
            "SELECT record FROM turn_outcomes WHERE profile_id = $profile " +
              "ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, limit: limitParam(limit) },
          )
        : this.db.all(
            "SELECT record FROM turn_outcomes WHERE profile_id = $profile AND " +
              "context_key = $key ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, key: contextLookupKey(context), limit: limitParam(limit) },
          );
    return rows.map((r) => json<TurnOutcomeRecord>(r, "record", "turn outcome"));
  }

  async outcomesSince(profile: ProfileId, sinceTs: Timestamp): Promise<TurnOutcomeRecord[]> {
    const rows = this.db.all(
      "SELECT record FROM turn_outcomes WHERE profile_id = $profile AND ts >= $since " +
        "ORDER BY ts DESC, id DESC",
      { profile, since: toMicros(sinceTs) },
    );
    return rows.map((r) => json<TurnOutcomeRecord>(r, "record", "turn outcome"));
  }

  async decisionsSince(profile: ProfileId, sinceTs: Timestamp): Promise<DecisionRecord[]> {
    const rows = this.db.all(
      "SELECT id, ts, trace FROM decision_log WHERE profile_id = $profile AND ts >= $since " +
        "ORDER BY ts DESC, id DESC",
      { profile, since: toMicros(sinceTs) },
    );
    return rows.map((r) => ({
      id: str(r, "id"),
      profile,
      ts: ts(r, "ts"),
      trace: json<DecisionTrace>(r, "trace", "decision trace"),
    }));
  }

  #trim(profile: ProfileId, cap: number): void {
    let count = this.#counts.get(profile);
    if (count === undefined) {
      const row = this.db.get("SELECT count(*) AS n FROM decision_log WHERE profile_id = $p", {
        p: profile,
      });
      count = row ? num(row, "n") : 0;
    } else {
      count += 1;
    }
    if (count > cap) {
      this.db.run(
        "DELETE FROM decision_log WHERE id IN (SELECT id FROM decision_log WHERE " +
          "profile_id = $p ORDER BY ts ASC, id ASC LIMIT $n)",
        { p: profile, n: count - cap },
      );
      count = cap;
    }
    this.#counts.set(profile, count);
  }

  async recent(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<DecisionRecord[]> {
    const rows =
      context === null
        ? this.db.all(
            "SELECT id, ts, trace FROM decision_log WHERE profile_id = $profile " +
              "ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, limit: limitParam(limit) },
          )
        : this.db.all(
            "SELECT id, ts, trace FROM decision_log WHERE profile_id = $profile AND " +
              "context_key = $key ORDER BY ts DESC, id DESC LIMIT $limit",
            { profile, key: contextLookupKey(context), limit: limitParam(limit) },
          );
    return rows.map((r) => ({
      id: str(r, "id"),
      profile,
      ts: ts(r, "ts"),
      trace: json<DecisionTrace>(r, "trace", "decision trace"),
    }));
  }
}

// ---- settings -----------------------------------------------------------------------------

class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const row = this.db.get(
      "SELECT value FROM profile_settings WHERE profile_id = $profile AND key = $key",
      { profile, key },
    );
    return row ? json<JsonValue>(row, "value", "setting") : null;
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    if (value === null) {
      this.db.run("DELETE FROM profile_settings WHERE profile_id = $profile AND key = $key", {
        profile,
        key,
      });
      return;
    }
    this.db.run(
      "INSERT INTO profile_settings (profile_id, key, value, updated_at) VALUES ($profile, " +
        "$key, $value, $at) ON CONFLICT (profile_id, key) DO UPDATE SET value = " +
        "excluded.value, updated_at = excluded.updated_at",
      { profile, key, value: JSON.stringify(value), at: this.db.nowMicros() },
    );
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    // `substr` instead of `LIKE`, so `%` and `_` in the prefix are literal (and case matters).
    const rows = this.db.all(
      "SELECT key, value FROM profile_settings WHERE profile_id = $profile AND " +
        "substr(key, 1, length($prefix)) = $prefix ORDER BY key",
      { profile, prefix },
    );
    return new Map(rows.map((r) => [str(r, "key"), json<JsonValue>(r, "value", "setting")]));
  }

  async deletePrefix(profile: ProfileId, prefix: string): Promise<number> {
    return this.db.run(
      "DELETE FROM profile_settings WHERE profile_id = $profile AND " +
        "substr(key, 1, length($prefix)) = $prefix",
      { profile, prefix },
    );
  }
}

// ---- whole-profile export / wipe ----------------------------------------------------------

class SqliteProfileData implements ProfileDataStore {
  constructor(private readonly db: Db) {}

  #query = async (stmt: Stmt) => this.db.allStmt(stmt);

  async inventory(profile: ProfileId): Promise<DataInventory> {
    return readInventory(SQLITE_DIALECT, this.#query, profile, fromMicros(this.db.nowMicros()));
  }

  async export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport> {
    const now = fromMicros(this.db.nowMicros());
    return readExport(SQLITE_DIALECT, this.#query, profile, categories, now);
  }

  async wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): Promise<WipeCounts> {
    const statements = wipeStatements(SQLITE_DIALECT, profile, categories, options);
    try {
      return this.db.tx(() => {
        const counts: WipeCounts = {};
        for (const { part, stmt } of statements) addCount(counts, part, this.db.runStmt(stmt));
        return counts;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot wipe the profile data", { cause });
    }
  }
}

// ---- memory records -----------------------------------------------------------------------

function memoryFromRow(row: Row): MemoryRecord {
  const embedding = row.embedding;
  const sourceContext = optStr(row, "source_context");
  const source = optStr(row, "source");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: memoryKind(str(row, "kind")),
    scope: json<MemoryScope>(row, "scope", "memory scope"),
    subjects: json<PersonId[]>(row, "subjects", "memory subjects"),
    content: str(row, "content"),
    tokens: str(row, "tokens"),
    embedding:
      embedding instanceof Uint8Array ? embeddingFromF32(decodeEmbedding(embedding)) : null,
    importance: num(row, "importance"),
    confidence: num(row, "confidence"),
    created_at: ts(row, "created_at"),
    updated_at: ts(row, "updated_at"),
    last_accessed: optTs(row, "last_accessed"),
    access_count: u32(num(row, "access_count")),
    source_context:
      sourceContext === null ? null : parseJson<ContextKey>(sourceContext, "memory source context"),
    source: source === null ? null : parseJson<MemorySource>(source, "memory source"),
    origin: memoryOrigin(str(row, "origin")),
    source_events: sourceEvents(json<unknown>(row, "source_events", "memory source events")),
    due: optTs(row, "due"),
    done: bool(row, "done"),
    superseded_by: optStr(row, "superseded_by"),
  };
}

/** Newest first, ties broken by id (descending). */
function newestFirst(a: Row, b: Row): number {
  const at = num(a, "created_at");
  const bt = num(b, "created_at");
  if (at !== bt) return bt - at;
  const ai = str(a, "id");
  const bi = str(b, "id");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** An FTS5 query string matching any of the tokens (each one a quoted phrase). */
function ftsMatch(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

const SEARCH_FILTER =
  "m.profile_id = $profile AND m.scope_key IN (SELECT value FROM json_each($scopes)) " +
  "AND ($kinds IS NULL OR m.kind IN (SELECT value FROM json_each($kinds))) " +
  "AND m.superseded_by IS NULL";

class SqliteMemories implements MemoryRecordStore {
  constructor(private readonly db: Db) {}

  async upsert(record: MemoryRecord): Promise<void> {
    const embedding = cleanEmbedding(record.embedding);
    const scope = canonicalMemoryScope(record.scope);
    try {
      this.db.run(
        "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, " +
          "content, tokens, embedding, importance, confidence, created_at, updated_at, " +
          "last_accessed, access_count, source_context, source, origin, source_events, due, done, " +
          "superseded_by) " +
          "VALUES ($id, $profile, $kind, $scope, $scope_key, $subjects, $content, $tokens, " +
          "$embedding, $importance, $confidence, $created_at, $updated_at, $last_accessed, " +
          "$access_count, $source_context, $source, $origin, $source_events, $due, $done, " +
          "$superseded_by) " +
          "ON CONFLICT (id) DO UPDATE SET " +
          "profile_id = excluded.profile_id, kind = excluded.kind, scope = excluded.scope, " +
          "scope_key = excluded.scope_key, subjects = excluded.subjects, content = " +
          "excluded.content, tokens = excluded.tokens, embedding = excluded.embedding, " +
          "importance = excluded.importance, confidence = excluded.confidence, created_at = " +
          "excluded.created_at, updated_at = excluded.updated_at, last_accessed = " +
          "excluded.last_accessed, access_count = excluded.access_count, source_context = " +
          "excluded.source_context, source = excluded.source, origin = excluded.origin, " +
          "source_events = excluded.source_events, due = excluded.due, " +
          "done = excluded.done, superseded_by = excluded.superseded_by",
        {
          id: record.id,
          profile: record.profile,
          kind: memoryKind(record.kind),
          scope: JSON.stringify(scope),
          scope_key: JSON.stringify(scope),
          subjects: JSON.stringify(record.subjects),
          content: record.content,
          tokens: record.tokens,
          embedding: embedding === null ? null : encodeEmbedding(embedding),
          importance: record.importance,
          confidence: record.confidence,
          created_at: toMicros(record.created_at),
          updated_at: toMicros(record.updated_at),
          last_accessed: optionalMicros(record.last_accessed),
          access_count: u32(record.access_count),
          source_context:
            record.source_context === null ? null : contextLookupKey(record.source_context),
          source: memorySourceJson(record.source),
          origin: memoryOrigin(record.origin ?? "unknown"),
          source_events: JSON.stringify(sourceEvents(record.source_events)),
          due: optionalMicros(record.due),
          done: record.done ? 1 : 0,
          superseded_by: record.superseded_by,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store memory record", { cause });
    }
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.db.get("SELECT * FROM memory_records WHERE id = $id", { id });
    return row ? memoryFromRow(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.db.run("DELETE FROM memory_records WHERE id = $id", { id }) > 0;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const embedding = cleanEmbedding(query.embedding);
    const limit = sqlLimit(query.limit);
    if (limit === 0) return [];
    const filter = {
      profile: query.profile,
      scopes: JSON.stringify(query.scopes.map(memoryScopeKey)),
      kinds: query.kinds === null ? null : JSON.stringify(query.kinds),
    };
    const hits: MemoryHit[] = [];

    // Full text: OR of the tokens; relevance is FTS5's BM25 (negated, so higher is better).
    const tokens = queryTokens(query.tokens);
    if (tokens.length > 0) {
      let rows: Row[];
      try {
        rows = this.db.all(
          "SELECT m.*, -bm25(memory_fts) AS score FROM memory_fts " +
            "JOIN memory_records m ON m.seq = memory_fts.rowid " +
            `WHERE memory_fts MATCH $match AND ${SEARCH_FILTER} ` +
            "ORDER BY score DESC, m.created_at DESC, m.id DESC LIMIT $limit",
          { ...filter, match: ftsMatch(tokens), limit: limit ?? -1 },
        );
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError("memory text search failed", { cause });
      }
      for (const row of rows) {
        hits.push({
          record: memoryFromRow(row),
          text_score: num(row, "score"),
          vector_score: null,
        });
      }
    }

    // Nearest neighbours: exact cosine over the rows with the query's dimension.
    if (embedding !== null) {
      const query32 = Float32Array.from(embedding);
      const rows = this.db.all(
        `SELECT * FROM memory_records m WHERE ${SEARCH_FILTER} ` +
          "AND m.embedding IS NOT NULL AND length(m.embedding) = $bytes",
        { ...filter, bytes: embedding.length * 4 },
      );
      const scored = rows
        .map((row) => ({
          row,
          score: cosine(decodeEmbedding(row.embedding as Uint8Array), query32),
        }))
        .sort((a, b) => b.score - a.score || newestFirst(a.row, b.row))
        .slice(0, limit ?? undefined);
      for (const { row, score } of scored) {
        const id = str(row, "id");
        const hit = hits.find((h) => h.record.id === id);
        if (hit) hit.vector_score = score;
        else hits.push({ record: memoryFromRow(row), text_score: 0, vector_score: score });
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile " +
        "AND ($subject IS NULL OR EXISTS (SELECT 1 FROM json_each(subjects) WHERE value = " +
        "$subject)) AND ($scope IS NULL OR scope_key = $scope) " +
        "AND ($kind IS NULL OR kind = $kind) AND ($before IS NULL OR created_at < $before) " +
        "AND ($all = 1 OR superseded_by IS NULL) " +
        "ORDER BY created_at DESC, id DESC LIMIT $limit",
      {
        profile,
        subject: filter.subject,
        scope: filter.scope === null ? null : memoryScopeKey(filter.scope),
        kind: filter.kind,
        before: optionalMicros(filter.before),
        all: filter.include_superseded ? 1 : 0,
        limit: limitParam(filter.limit),
      },
    );
    return rows.map(memoryFromRow);
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    if (ids.length === 0) return;
    this.db.run(
      "UPDATE memory_records SET access_count = min(access_count + 1, 4294967295), " +
        "last_accessed = $at WHERE id IN (SELECT value FROM json_each($ids))",
      { ids: JSON.stringify([...new Set(ids)]), at: toMicros(at) },
    );
  }

  async dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs: number | null = null,
  ): Promise<MemoryRecord[]> {
    const rows = this.db.all(
      "SELECT * FROM memory_records WHERE profile_id = $profile AND kind = 'followup' AND " +
        "NOT done AND due IS NOT NULL AND superseded_by IS NULL AND due <= $now AND " +
        "($since IS NULL OR due >= $since) ORDER BY due DESC, id DESC",
      {
        profile,
        now: toMicros(now),
        since: maxAgeMs === null ? null : toMicros(now) - Math.round(maxAgeMs * 1000),
      },
    );
    return rows.map(memoryFromRow);
  }

  async expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number> {
    return this.db.run(
      "UPDATE memory_records SET done = 1 WHERE profile_id = $profile AND kind = 'followup' " +
        "AND NOT done AND due IS NOT NULL AND due < $before",
      { profile, before: toMicros(dueBefore) },
    );
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND kind = 'episode' AND " +
        "created_at < $before AND importance <= $max AND (last_accessed IS NULL OR " +
        "last_accessed < $since)",
      {
        profile,
        before: toMicros(policy.created_before),
        max: policy.max_importance,
        since: toMicros(policy.not_accessed_since),
      },
    );
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    return this.db.run(
      "DELETE FROM memory_records WHERE profile_id = $profile AND (EXISTS (SELECT 1 FROM " +
        "json_each(subjects) WHERE value = $person) OR scope_key = $scope)",
      { profile, person, scope: memoryScopeKey({ type: "person", person }) },
    );
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    const absorbScope = memoryScopeKey({ type: "person", person: absorb });
    const keepScope = memoryScopeKey({ type: "person", person: keep });
    // `tokens` is untouched, so the FTS triggers do not fire and `seq` (the FTS rowid) stays.
    return this.db.tx(() => {
      const rows = this.db.all(
        "SELECT id, subjects, scope_key FROM memory_records WHERE EXISTS (SELECT 1 FROM " +
          "json_each(subjects) WHERE value = $absorb) OR scope_key = $scope",
        { absorb, scope: absorbScope },
      );
      for (const row of rows) {
        const subjects = json<PersonId[]>(row, "subjects", "memory subjects");
        const moved = [...new Set(subjects.map((s) => (s === absorb ? keep : s)))];
        const rescoped = str(row, "scope_key") === absorbScope;
        this.db.run(
          "UPDATE memory_records SET subjects = $subjects, " +
            "scope = CASE WHEN $rescope THEN $scope ELSE scope END, " +
            "scope_key = CASE WHEN $rescope THEN $scope ELSE scope_key END WHERE id = $id",
          {
            id: str(row, "id"),
            subjects: JSON.stringify(moved),
            rescope: rescoped ? 1 : 0,
            scope: keepScope,
          },
        );
      }
      return rows.length;
    });
  }
}

// ---- relationships ------------------------------------------------------------------------

function relationshipFromRow(row: Row): Relationship {
  return {
    profile: str(row, "profile_id"),
    person: str(row, "person_id"),
    affinity: num(row, "affinity"),
    trust: num(row, "trust"),
    familiarity: num(row, "familiarity"),
    tags: json<string[]>(row, "tags", "relationship tags"),
    notes: str(row, "notes"),
    call_name: optStr(row, "call_name"),
    interactions: u32(num(row, "interactions")),
    last_interaction: optTs(row, "last_interaction"),
    updated_at: ts(row, "updated_at"),
  };
}

class SqliteRelationships implements RelationshipStore {
  constructor(private readonly db: Db) {}

  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const row = this.db.get(
      "SELECT * FROM relationships WHERE profile_id = $profile AND person_id = $person",
      { profile, person },
    );
    return row ? relationshipFromRow(row) : null;
  }

  async upsert(r: Relationship): Promise<void> {
    this.db.run(
      "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, tags, " +
        "notes, call_name, interactions, last_interaction, updated_at) VALUES ($profile, " +
        "$person, $affinity, $trust, $familiarity, $tags, $notes, $call_name, $interactions, " +
        "$last_interaction, $updated_at) ON CONFLICT (profile_id, person_id) DO UPDATE SET " +
        "affinity = excluded.affinity, trust = excluded.trust, familiarity = " +
        "excluded.familiarity, tags = excluded.tags, notes = excluded.notes, call_name = " +
        "excluded.call_name, interactions = excluded.interactions, last_interaction = " +
        "excluded.last_interaction, updated_at = excluded.updated_at",
      {
        profile: r.profile,
        person: r.person,
        affinity: r.affinity,
        trust: r.trust,
        familiarity: r.familiarity,
        tags: JSON.stringify(r.tags),
        notes: r.notes,
        call_name: r.call_name,
        interactions: u32(r.interactions),
        last_interaction: optionalMicros(r.last_interaction),
        updated_at: toMicros(r.updated_at),
      },
    );
  }

  async list(profile: ProfileId): Promise<Relationship[]> {
    return this.db
      .all("SELECT * FROM relationships WHERE profile_id = $profile ORDER BY person_id", {
        profile,
      })
      .map(relationshipFromRow);
  }

  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.db.tx(() => {
      this.db.run(
        "DELETE FROM relationship_deltas WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      const removed = this.db.run(
        "DELETE FROM relationships WHERE profile_id = $profile AND person_id = $person",
        { profile, person },
      );
      return removed > 0;
    });
  }

  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    this.db.run(
      "INSERT INTO relationship_deltas (profile_id, person_id, at, affinity, trust, " +
        "familiarity, reason) VALUES ($profile, $person, $at, $affinity, $trust, $familiarity, " +
        "$reason)",
      {
        profile,
        person,
        at: toMicros(delta.at),
        affinity: delta.affinity,
        trust: delta.trust,
        familiarity: delta.familiarity,
        reason: delta.reason,
      },
    );
  }

  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: Timestamp,
  ): Promise<RelationshipDelta[]> {
    const rows = this.db.all(
      "SELECT at, affinity, trust, familiarity, reason FROM relationship_deltas WHERE " +
        "profile_id = $profile AND person_id = $person AND at >= $since ORDER BY at, seq",
      { profile, person, since: toMicros(since) },
    );
    return rows.map((r) => ({
      at: ts(r, "at"),
      affinity: num(r, "affinity"),
      trust: num(r, "trust"),
      familiarity: num(r, "familiarity"),
      reason: str(r, "reason"),
    }));
  }
}

// ---- auth and audit -----------------------------------------------------------------------

function assignmentFromRow(row: Row): RoleAssignment {
  return {
    account: { platform: str(row, "platform"), id: str(row, "account_id") },
    role: str(row, "role"),
    scope: json<AuthScope>(row, "scope", "auth scope"),
    granted_by: str(row, "granted_by"),
    at: ts(row, "at"),
  };
}

const ASSIGNMENT_ORDER = "at, platform, account_id, role, scope";

class SqliteAuth implements AuthStore {
  constructor(private readonly db: Db) {}

  async roles(): Promise<RoleDefinition[]> {
    return this.db.all("SELECT * FROM roles ORDER BY rank DESC, name").map((r) => ({
      name: str(r, "name"),
      rank: num(r, "rank"),
      grants: json<string[]>(r, "grants", "role grants"),
      denies: json<string[]>(r, "denies", "role denies"),
      builtin: bool(r, "builtin"),
    }));
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    this.db.run(
      "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($name, $rank, $grants, " +
        "$denies, $builtin) ON CONFLICT (name) DO UPDATE SET rank = excluded.rank, grants = " +
        "excluded.grants, denies = excluded.denies, builtin = excluded.builtin",
      {
        name: role.name,
        rank: role.rank,
        grants: JSON.stringify(role.grants),
        denies: JSON.stringify(role.denies),
        builtin: role.builtin ? 1 : 0,
      },
    );
  }

  async deleteRole(name: string): Promise<boolean> {
    return this.db.tx(() => {
      const row = this.db.get("SELECT builtin FROM roles WHERE name = $name", { name });
      if (!row) return false;
      if (bool(row, "builtin")) throw new StoreError(`role \`${name}\` is built in`);
      for (const table of ["role_assignments", "role_mappings", "node_overrides"]) {
        this.db.run(`DELETE FROM ${table} WHERE role = $name`, { name });
      }
      this.db.run("DELETE FROM roles WHERE name = $name", { name });
      return true;
    });
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return this.db
      .all(
        "SELECT * FROM role_assignments WHERE platform = $platform AND account_id = $id " +
          `ORDER BY ${ASSIGNMENT_ORDER}`,
        { platform: account.platform, id: account.id },
      )
      .map(assignmentFromRow);
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    return this.db
      .all(`SELECT * FROM role_assignments ORDER BY ${ASSIGNMENT_ORDER}`)
      .map(assignmentFromRow);
  }

  async assign(a: RoleAssignment): Promise<void> {
    this.db.run(
      "INSERT INTO role_assignments (platform, account_id, role, scope, granted_by, at) " +
        "VALUES ($platform, $id, $role, $scope, $by, $at) ON CONFLICT (platform, account_id, " +
        "role, scope) DO UPDATE SET granted_by = excluded.granted_by, at = excluded.at",
      {
        platform: a.account.platform,
        id: a.account.id,
        role: a.role,
        scope: authScopeKey(a.scope),
        by: a.granted_by,
        at: toMicros(a.at),
      },
    );
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_assignments WHERE platform = $platform AND account_id = $id AND " +
        "role = $role AND scope = $scope",
      { platform: account.platform, id: account.id, role, scope: authScopeKey(scope) },
    );
    return removed > 0;
  }

  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    return this.db
      .all(
        "SELECT platform_role, role FROM role_mappings WHERE platform = $platform AND " +
          "guild = $guild ORDER BY platform_role",
        { platform, guild },
      )
      .map((r) => ({
        platform,
        guild,
        platform_role: str(r, "platform_role"),
        role: str(r, "role"),
      }));
  }

  async setMapping(m: RoleMapping): Promise<void> {
    this.db.run(
      "INSERT INTO role_mappings (platform, guild, platform_role, role) VALUES ($platform, " +
        "$guild, $platform_role, $role) ON CONFLICT (platform, guild, platform_role) " +
        "DO UPDATE SET role = excluded.role",
      { platform: m.platform, guild: m.guild, platform_role: m.platform_role, role: m.role },
    );
  }

  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM role_mappings WHERE platform = $platform AND guild = $guild AND " +
        "platform_role = $platform_role",
      { platform, guild, platform_role: platformRole },
    );
    return removed > 0;
  }

  async overrides(): Promise<NodeOverride[]> {
    return this.db.all("SELECT * FROM node_overrides ORDER BY scope, role, node").map((r) => ({
      scope: json<AuthScope>(r, "scope", "auth scope"),
      role: str(r, "role"),
      node: str(r, "node"),
      allow: bool(r, "allow"),
    }));
  }

  async setOverride(o: NodeOverride): Promise<void> {
    this.db.run(
      "INSERT INTO node_overrides (scope, role, node, allow) VALUES ($scope, $role, $node, " +
        "$allow) ON CONFLICT (scope, role, node) DO UPDATE SET allow = excluded.allow",
      { scope: authScopeKey(o.scope), role: o.role, node: o.node, allow: o.allow ? 1 : 0 },
    );
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const removed = this.db.run(
      "DELETE FROM node_overrides WHERE scope = $scope AND role = $role AND node = $node",
      { scope: authScopeKey(scope), role, node },
    );
    return removed > 0;
  }
}

// ---- event log ----------------------------------------------------------------------------

const DAY_MICROS = 86_400_000_000;

function logEventFromRow(row: Row): LogEvent {
  const context = optStr(row, "context");
  return {
    id: str(row, "id"),
    at: ts(row, "at"),
    kind: str(row, "kind") as LogEventKind,
    source: str(row, "source"),
    cause: optStr(row, "cause"),
    context: context === null ? null : parseJson<ContextKey>(context, "event context"),
    person: optStr(row, "person"),
    body: json<JsonValue>(row, "body", "event body"),
  };
}

/** The lookup columns of an event: `observation` keeps them in its `Observation`. */
function eventLookups(event: LogEvent): { key: string | null; salience: string | null } {
  const body = event.body;
  if (!isJsonObject(body)) return { key: null, salience: null };
  const fields = isJsonObject(body.observation) ? body.observation : body;
  const { attention_key: key, salience } = fields;
  return {
    key: typeof key === "string" ? key : null,
    salience: typeof salience === "string" ? salience : null,
  };
}

function directiveFromRow(row: Row): DirectiveRecord {
  return {
    id: str(row, "id"),
    issuer: json<AccountRef>(row, "issuer", "directive issuer"),
    authority: str(row, "authority") as DirectiveRecord["authority"],
    scope: json<DirectiveRecord["scope"]>(row, "scope", "directive scope"),
    effect: str(row, "effect") as DirectiveRecord["effect"],
    text: str(row, "text"),
    expires: optTs(row, "expires") ?? "until_revoked",
    source_event: str(row, "source_event"),
    created_at: ts(row, "created_at"),
    revoked_at: optTs(row, "revoked_at"),
    revoked_by: optStr(row, "revoked_by"),
  };
}

class SqliteDirectives implements DirectiveStore {
  constructor(private readonly db: Db) {}

  async insert(profile: ProfileId, d: Directive): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO directives (id, profile_id, issuer, authority, scope, effect, text, " +
          "expires, source_event, created_at) VALUES ($id, $profile, $issuer, $authority, " +
          "$scope, $effect, $text, $expires, $source_event, $created_at)",
        {
          id: d.id,
          profile,
          issuer: JSON.stringify(d.issuer),
          authority: d.authority,
          scope: JSON.stringify(d.scope),
          effect: d.effect,
          text: d.text,
          expires: d.expires === "until_revoked" ? null : toMicros(d.expires),
          source_event: d.source_event,
          created_at: toMicros(d.created_at),
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the directive", { cause });
    }
  }

  async active(profile: ProfileId, now: Timestamp): Promise<DirectiveRecord[]> {
    return this.db
      .all(
        "SELECT * FROM directives WHERE profile_id = $profile AND revoked_at IS NULL " +
          "AND (expires IS NULL OR expires > $now) ORDER BY created_at, id",
        { profile, now: toMicros(now) },
      )
      .map(directiveFromRow);
  }

  async all(profile: ProfileId, limit: number): Promise<DirectiveRecord[]> {
    return this.db
      .all(
        "SELECT * FROM directives WHERE profile_id = $profile " +
          "ORDER BY created_at DESC, id DESC LIMIT $limit",
        { profile, limit: limitParam(limit) },
      )
      .map(directiveFromRow);
  }

  async revoke(profile: ProfileId, id: string, by: string, at: Timestamp): Promise<boolean> {
    const changed = this.db.run(
      "UPDATE directives SET revoked_at = $at, revoked_by = $by " +
        "WHERE id = $id AND profile_id = $profile AND revoked_at IS NULL",
      { id, profile, by, at: toMicros(at) },
    );
    return changed > 0;
  }

  async prune(profile: ProfileId, before: Timestamp): Promise<number> {
    return this.db.run(
      "DELETE FROM directives WHERE profile_id = $profile " +
        "AND (revoked_at < $before OR expires < $before)",
      { profile, before: toMicros(before) },
    );
  }
}

class SqliteEventLog implements EventLogStore {
  constructor(private readonly db: Db) {}

  async append(profile: ProfileId, events: readonly LogEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      this.db.tx(() => {
        for (const event of events) {
          const { key, salience } = eventLookups(event);
          this.db.run(
            "INSERT INTO log_events (id, profile_id, at, kind, source, cause, context_key, " +
              "context, person, attention_key, salience, body) VALUES ($id, $profile, $at, " +
              "$kind, $source, $cause, $context_key, $context, $person, $key, $salience, $body) " +
              "ON CONFLICT (id) DO NOTHING",
            {
              id: event.id,
              profile,
              at: toMicros(event.at),
              kind: event.kind,
              source: event.source,
              cause: event.cause,
              context_key: event.context === null ? null : contextLookupKey(event.context),
              context: event.context === null ? null : JSON.stringify(event.context),
              person: event.person,
              key,
              salience,
              body: JSON.stringify(event.body),
            },
          );
        }
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot append to the event log", { cause });
    }
  }

  async get(profile: ProfileId, id: string): Promise<LogEvent | null> {
    const row = this.db.get("SELECT * FROM log_events WHERE id = $id AND profile_id = $profile", {
      id,
      profile,
    });
    return row ? logEventFromRow(row) : null;
  }

  async query(profile: ProfileId, filter: LogEventFilter): Promise<LogEvent[]> {
    const where = ["profile_id = $profile"];
    const params: Params = { profile, limit: limitParam(filter.limit ?? 100) };
    const add = (clause: string, name: string, value: SQLInputValue) => {
      where.push(clause);
      params[name] = value;
    };
    if (filter.kinds) {
      add("kind IN (SELECT value FROM json_each($kinds))", "kinds", JSON.stringify(filter.kinds));
    }
    if (filter.sources) {
      add(
        "source IN (SELECT value FROM json_each($sources))",
        "sources",
        JSON.stringify(filter.sources),
      );
    }
    if (filter.context) add("context_key = $context", "context", contextLookupKey(filter.context));
    if (filter.person !== undefined) add("person = $person", "person", filter.person);
    if (filter.attention_key !== undefined) {
      add("attention_key = $key", "key", filter.attention_key);
    }
    if (filter.turn !== undefined) {
      add(
        "COALESCE(json_extract(body, '$.turn'), json_extract(body, '$.turn_outcome.turn')) = $turn",
        "turn",
        filter.turn,
      );
    }
    if (filter.since !== undefined) add("at >= $since", "since", toMicros(filter.since));
    if (filter.until !== undefined) add("at < $until", "until", toMicros(filter.until));
    if (filter.before !== undefined) add("id < $before", "before", filter.before);
    if (filter.after !== undefined) add("id > $after", "after", filter.after);
    const order = filter.order === "asc" ? "ASC" : "DESC";
    const rows = this.db.all(
      `SELECT * FROM log_events WHERE ${where.join(" AND ")} ORDER BY id ${order} LIMIT $limit`,
      params,
    );
    return rows.map(logEventFromRow);
  }

  async effectsOf(
    profile: ProfileId,
    causes: readonly string[],
    limit: number,
  ): Promise<LogEvent[]> {
    if (causes.length === 0) return [];
    const rows = this.db.all(
      "SELECT * FROM log_events WHERE cause IN (SELECT value FROM json_each($causes)) " +
        "AND profile_id = $profile ORDER BY id ASC LIMIT $limit",
      { causes: JSON.stringify(causes), profile, limit: limitParam(limit) },
    );
    return rows.map(logEventFromRow);
  }

  /** Rows that may go: `tier` matches and no other row names them as its cause. */
  #leaves(profile: ProfileId, tier: string, before: Timestamp, limit: number): Row[] {
    return this.db.all(
      "SELECT e.seq, e.at, e.kind, e.source FROM log_events e WHERE e.profile_id = $profile " +
        `AND e.at < $before AND ${tier} AND NOT EXISTS ` +
        "(SELECT 1 FROM log_events c WHERE c.cause = e.id) ORDER BY e.at LIMIT $limit",
      { profile, before: toMicros(before), limit },
    );
  }

  /** Counts `rows` in the rollups and deletes them. */
  #remove(profile: ProfileId, rows: readonly Row[]): void {
    const groups = new Map<string, { day: number; kind: string; source: string; rows: Row[] }>();
    for (const row of rows) {
      const day = Math.floor(num(row, "at") / DAY_MICROS) * DAY_MICROS;
      const key = `${day}|${str(row, "kind")}|${str(row, "source")}`;
      let group = groups.get(key);
      if (!group) {
        group = { day, kind: str(row, "kind"), source: str(row, "source"), rows: [] };
        groups.set(key, group);
      }
      group.rows.push(row);
    }
    for (const group of groups.values()) {
      const times = group.rows.map((r) => num(r, "at"));
      this.db.run(
        "INSERT INTO log_event_rollups (profile_id, day, kind, source, count, first_at, last_at) " +
          "VALUES ($profile, $day, $kind, $source, $count, $first, $last) " +
          "ON CONFLICT (profile_id, day, kind, source) DO UPDATE SET " +
          "count = count + excluded.count, first_at = min(first_at, excluded.first_at), " +
          "last_at = max(last_at, excluded.last_at)",
        {
          profile,
          day: group.day,
          kind: group.kind,
          source: group.source,
          count: group.rows.length,
          first: Math.min(...times),
          last: Math.max(...times),
        },
      );
    }
    this.db.run("DELETE FROM log_events WHERE seq IN (SELECT value FROM json_each($seqs))", {
      seqs: JSON.stringify(rows.map((r) => num(r, "seq"))),
    });
  }

  async compact(profile: ProfileId, policy: EventCompaction): Promise<EventCompactionResult> {
    const limit = Math.max(1, Math.floor(policy.max_rows));
    try {
      return this.db.tx(() => {
        const ambient = this.#leaves(
          profile,
          "e.kind = 'observation' AND e.salience = 'ambient'",
          policy.fold_before,
          limit,
        );
        if (ambient.length > 0) this.#remove(profile, ambient);
        const left = limit - ambient.length;
        const old =
          policy.expire_before === null || left === 0
            ? []
            : this.#leaves(profile, "1 = 1", policy.expire_before, left);
        if (old.length > 0) this.#remove(profile, old);
        return {
          folded: ambient.length,
          expired: old.length,
          more: ambient.length + old.length > 0,
        };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot compact the event log", { cause });
    }
  }

  async rollups(profile: ProfileId, limit: number): Promise<EventRollup[]> {
    const rows = this.db.all(
      "SELECT * FROM log_event_rollups WHERE profile_id = $profile " +
        "ORDER BY day DESC, kind, source LIMIT $limit",
      { profile, limit: limitParam(limit) },
    );
    return rows.map((r) => ({
      day: ts(r, "day"),
      kind: str(r, "kind"),
      source: str(r, "source"),
      count: num(r, "count"),
      first_at: ts(r, "first_at"),
      last_at: ts(r, "last_at"),
    }));
  }
}

class SqliteAudit implements AuditLog {
  constructor(private readonly db: Db) {}

  async append(entry: AuditEntry): Promise<void> {
    try {
      this.db.run(
        "INSERT INTO audit_log (id, at, actor, action, target, detail, ok) VALUES ($id, $at, " +
          "$actor, $action, $target, $detail, $ok)",
        {
          id: entry.id,
          at: toMicros(entry.at),
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          detail: JSON.stringify(entry.detail),
          ok: entry.ok ? 1 : 0,
        },
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (isConstraintError(cause)) {
        throw new StoreError(`audit entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append audit entry", { cause });
    }
  }

  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    const rows = this.db.all(
      "SELECT * FROM audit_log WHERE ($actor IS NULL OR actor = $actor) " +
        "ORDER BY at DESC, id DESC LIMIT $limit",
      { actor, limit: limitParam(limit) },
    );
    return rows.map((r) => ({
      id: str(r, "id"),
      at: ts(r, "at"),
      actor: str(r, "actor"),
      action: str(r, "action"),
      target: str(r, "target"),
      detail: json<JsonValue>(r, "detail", "audit detail"),
      ok: bool(r, "ok"),
    }));
  }
}

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one SQLite database. */
export class SqliteStore implements Store {
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
  readonly events: EventLogStore;
  readonly directives: DirectiveStore;
  readonly cards: MemberCardStore;
  readonly coins: CoinLedgerStore;
  readonly deals: DealStore;
  readonly fortunes: FortuneStore;
  readonly goals: GoalStore;
  readonly bounties: BountyStore;
  readonly economyDocs: EconomyDocStore;
  readonly #db: Db;

  private constructor(db: Db, maxDecisions: number | null) {
    this.#db = db;
    this.messages = new SqliteMessageLog(db);
    this.moduleState = new SqliteModuleState(db);
    this.personaOverrides = new SqlitePersonaOverrides(db);
    this.people = new SqlitePeople(db);
    this.decisions = new SqliteDecisionLog(db, maxDecisions);
    this.settings = new SqliteSettings(db);
    this.memories = new SqliteMemories(db);
    this.relationships = new SqliteRelationships(db);
    this.identity = new SqliteIdentity(db);
    this.auth = new SqliteAuth(db);
    this.audit = new SqliteAudit(db);
    this.profileData = new SqliteProfileData(db);
    this.events = new SqliteEventLog(db);
    this.directives = new SqliteDirectives(db);
    this.cards = new SqliteMemberCards(db);
    this.coins = new SqliteCoins(db);
    this.deals = new SqliteDeals(db);
    this.fortunes = new SqliteFortunes(db);
    this.goals = new SqliteGoals(db);
    this.bounties = new SqliteBounties(db);
    this.economyDocs = new SqliteEconomyDocs(db);
  }

  /**
   * Opens (creating it and its directory if needed) a database file, or `":memory:"` for a
   * fresh in-memory database, and runs pending migrations.
   */
  static async open(path: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
    const memory = path === ":memory:";
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot open the SQLite database", { cause });
    }
    const db = new Db(raw, options.clock ?? systemClock);
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
      if (!memory) {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      }
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    const maxDecisions =
      options.maxDecisionsPerProfile !== undefined
        ? options.maxDecisionsPerProfile
        : memory
          ? MAX_DECISIONS
          : null;
    return new SqliteStore(db, maxDecisions);
  }

  /** Versions recorded in `schema_version`, ascending. */
  async schemaVersions(): Promise<number[]> {
    return this.#db
      .all("SELECT version FROM schema_version ORDER BY version")
      .map((r) => num(r, "version"));
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
