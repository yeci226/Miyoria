// PostgreSQL backend (`pg`) with pgvector. Same schema as the Rust backend (the migrations in
// `migrations/postgres` are the Rust ones verbatim); parameterized queries only.
//
// Timestamps travel as text (the `timestamptz` parser is replaced) so microseconds survive;
// `bigint` columns are parsed to numbers; JSONB is sent as text with `::jsonb`; vectors as the
// pgvector text form `[1,2,3]`.

import { readdirSync, readFileSync } from "node:fs";
import { getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type ContextKind,
  type DecisionTrace,
  type Directive,
  type DirectiveRecord,
  type JsonObject,
  type JsonValue,
  type ModuleId,
  newId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import pg from "pg";
import {
  allowedDeltaAsync,
  authScopeKey,
  canonicalMemoryScope,
  cleanEmbedding,
  contextLookupKey,
  embeddingFromF32,
  fromMicros,
  memoryKind,
  memoryOrigin,
  memoryScopeKey,
  memorySourceJson,
  normalizeTimestamp,
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
  FortuneRecord,
  Goal,
  GoalPatch,
  GoalPledge,
  GoalStatus,
  LogEntry,
  MemberCardRecord,
  MemoryFilter,
  MemoryHit,
  MemoryKind,
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

const log = getLogger("store.postgres");

const MIGRATIONS_DIR = new URL("../migrations/postgres/", import.meta.url);

/** How often account creation retries after losing a race to a concurrent call. */
const MAX_RETRIES = 5;

/** Session-level advisory lock key held while migrating ("miyo" in ASCII). */
const MIGRATION_LOCK = 0x6d69796f;

export interface PostgresStoreOptions {
  /** Source of "now" for rows stamped by the store. Default: the database's `now()`. */
  clock?: Clock;
  /** Pool size. Default 10. */
  maxConnections?: number;
  /** How long to wait for a pooled connection. Default 10 000 ms. */
  connectTimeoutMs?: number;
}

type Row = Record<string, unknown>;
type Queryable = Pick<pg.PoolClient, "query">;

const OID_INT8 = 20;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

const TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === OID_TIMESTAMPTZ || oid === OID_TIMESTAMP) return (v: string) => v;
    if (oid === OID_INT8) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

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
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  throw new StoreError(`column \`${column}\` is not a number`);
}

function bool(row: Row, column: string): boolean {
  const v = row[column];
  if (typeof v !== "boolean") throw new StoreError(`column \`${column}\` is not a boolean`);
  return v;
}

function strings(row: Row, column: string): string[] {
  const v = row[column];
  if (!Array.isArray(v)) throw new StoreError(`column \`${column}\` is not an array`);
  return v.map(String);
}

function ts(row: Row, column: string): Timestamp {
  return normalizeTimestamp(str(row, column));
}

function optTs(row: Row, column: string): Timestamp | null {
  return row[column] == null ? null : ts(row, column);
}

/** Timestamps are sent as normalized UTC text (microsecond precision). */
function tsParam(value: Timestamp): string {
  return normalizeTimestamp(value);
}

function optTsParam(value: Timestamp | null): string | null {
  return value === null ? null : tsParam(value);
}

function limitParam(limit: number): number | null {
  return sqlLimit(limit);
}

/** `[1,2,3]`, the text form pgvector accepts. */
function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => String(Math.fround(x))).join(",")}]`;
}

function parseVector(s: string): number[] {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return embeddingFromF32(
    inner.split(",").map((x) => {
      const n = Number(x.trim());
      if (Number.isNaN(n)) {
        throw new StoreError(`invalid embedding component \`${x}\` in database`);
      }
      return Math.fround(n);
    }),
  );
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// ---- backend core -----------------------------------------------------------------------

class Pg {
  constructor(
    readonly pool: pg.Pool,
    readonly clock: Clock | null,
  ) {}

  /** `now` as a query parameter: the clock's time, or `null` for the database's `now()`. */
  now(): string | null {
    return this.clock === null ? null : fromMicros(Math.floor(this.clock.now()) * 1000);
  }

  async query(sql: string, params: unknown[] = [], on: Queryable = this.pool): Promise<Row[]> {
    const result = await on.query<Row>(sql, params);
    return result.rows;
  }

  async execute(sql: string, params: unknown[] = [], on: Queryable = this.pool): Promise<number> {
    const result = await on.query(sql, params);
    return result.rowCount ?? 0;
  }

  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function migrate(db: Pg): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, " +
          "name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      let applied = new Set(
        (await db.query("SELECT version FROM schema_version", [], client)).map((r) =>
          num(r, "version"),
        ),
      );
      if (applied.size === 0) applied = await adoptSqlxMigrations(db, client, files);
      const known = new Set(files.map((f) => Number.parseInt(f, 10)));
      for (const version of applied) {
        if (!known.has(version)) {
          throw new StoreError(`migration ${version} was previously applied but is missing`);
        }
      }
      for (const file of files) {
        const version = Number.parseInt(file, 10);
        if (applied.has(version)) continue;
        const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_version (version, name) VALUES ($1, $2)", [
            version,
            file.replace(/\.sql$/, ""),
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
        log.info({ version, file }, "applied database migration");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
    log.debug("database migrations are up to date");
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new StoreError("database migration failed", { cause });
  } finally {
    client.release();
  }
}

/**
 * A database migrated by the Rust backend (sqlx's `_sqlx_migrations`) has the same schema:
 * its successful versions are recorded as applied instead of being run again.
 */
async function adoptSqlxMigrations(
  db: Pg,
  client: pg.PoolClient,
  files: string[],
): Promise<Set<number>> {
  const exists = await db.query(
    "SELECT to_regclass('_sqlx_migrations') IS NOT NULL AS x",
    [],
    client,
  );
  if (!exists[0]?.x) return new Set();
  const rows = await db.query(
    "SELECT version FROM _sqlx_migrations WHERE success ORDER BY version",
    [],
    client,
  );
  const adopted = new Set<number>();
  for (const row of rows) {
    const version = num(row, "version");
    const file = files.find((f) => Number.parseInt(f, 10) === version);
    if (!file) continue;
    await client.query(
      "INSERT INTO schema_version (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [version, file.replace(/\.sql$/, "")],
    );
    adopted.add(version);
  }
  if (adopted.size > 0) log.info({ versions: [...adopted] }, "adopted sqlx migrations");
  return adopted;
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
      kind: str(row, "kind") as ContextKey["kind"],
    },
    author: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    author_name: str(row, "author_name"),
    text: str(row, "text"),
    is_self: bool(row, "is_self"),
    ts: ts(row, "ts"),
    turn: optStr(row, "turn_id"),
  };
}

class PgMessageLog implements MessageLog {
  constructor(private readonly db: Pg) {}

  async append(entry: LogEntry): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO message_log (id, profile_id, context_key, platform, scope, channel, kind, " +
          "author_platform, author_id, author_name, text, is_self, ts, turn_id) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        [
          entry.id,
          entry.profile,
          contextLookupKey(entry.context),
          entry.context.platform,
          entry.context.scope,
          entry.context.channel,
          entry.context.kind,
          entry.author.platform,
          entry.author.id,
          entry.author_name,
          entry.text,
          entry.is_self,
          tsParam(entry.ts),
          entry.turn,
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (pgCode(cause) === UNIQUE_VIOLATION) {
        throw new StoreError(`log entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append log entry", { cause });
    }
  }

  async purge(profile: ProfileId): Promise<number> {
    return this.db.execute("DELETE FROM message_log WHERE profile_id = $1", [profile]);
  }

  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const rows = await this.db.query(
      "SELECT * FROM (SELECT * FROM message_log WHERE profile_id = $1 AND context_key = $2 " +
        "ORDER BY ts DESC, seq DESC LIMIT $3) recent ORDER BY ts ASC, seq ASC",
      [profile, contextLookupKey(context), limitParam(limit)],
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
    const params: unknown[] = [profile, tsParam(since), limitParam(limit)];
    const who = authors.map((a) => {
      params.push(a.platform, a.id);
      return `(author_platform = $${params.length - 1} AND author_id = $${params.length})`;
    });
    const rows = await this.db.query(
      "SELECT * FROM (SELECT ts, kind, seq FROM message_log WHERE profile_id = $1 AND " +
        `NOT is_self AND ts >= $2 AND (${who.join(" OR ")}) ORDER BY ts DESC, seq DESC ` +
        "LIMIT $3) authored ORDER BY ts ASC, seq ASC",
      params,
    );
    return rows.map((row) => ({ ts: ts(row, "ts"), kind: str(row, "kind") as ContextKind }));
  }
}

// ---- member cards -------------------------------------------------------------------------

const MEMBER_CARD_COLUMNS =
  "serial, profile_id, author_platform, author_id, person_id, issued_at, " +
  "snapshot::text AS snapshot";

function memberCardFromRow(row: Row): MemberCardRecord {
  return {
    serial: str(row, "serial"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    issued_at: ts(row, "issued_at"),
    snapshot: parseJson<JsonObject>(str(row, "snapshot"), "member card"),
  };
}

/** `(author_platform = … AND author_id = …) OR …` over `accounts`, its parameters added to `params`. */
function authorsWhere(accounts: readonly AccountRef[], params: unknown[]): string {
  return accounts
    .map((a) => {
      params.push(a.platform, a.id);
      return `(author_platform = $${params.length - 1} AND author_id = $${params.length})`;
    })
    .join(" OR ");
}

class PgMemberCards implements MemberCardStore {
  constructor(private readonly db: Pg) {}

  async issue(card: MemberCardRecord): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO member_cards (serial, profile_id, author_platform, author_id, person_id, " +
          "issued_at, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [
          card.serial,
          card.profile,
          card.account.platform,
          card.account.id,
          card.person,
          tsParam(card.issued_at),
          JSON.stringify(card.snapshot),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (pgCode(cause) === UNIQUE_VIOLATION) {
        throw new StoreError(`member card \`${card.serial}\` already exists`, { cause });
      }
      throw new StoreError("cannot store the member card", { cause });
    }
  }

  async bySerial(profile: ProfileId, serial: string): Promise<MemberCardRecord | null> {
    const rows = await this.db.query(
      `SELECT ${MEMBER_CARD_COLUMNS} FROM member_cards WHERE profile_id = $1 AND serial = $2`,
      [profile, serial],
    );
    return rows[0] ? memberCardFromRow(rows[0]) : null;
  }

  async amend(profile: ProfileId, serial: string, snapshot: JsonObject): Promise<boolean> {
    const changed = await this.db.execute(
      "UPDATE member_cards SET snapshot = $3::jsonb WHERE profile_id = $1 AND serial = $2",
      [profile, serial, JSON.stringify(snapshot)],
    );
    return changed > 0;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<MemberCardRecord[]> {
    if (accounts.length === 0) return [];
    const params: unknown[] = [profile, limitParam(limit)];
    const rows = await this.db.query(
      `SELECT ${MEMBER_CARD_COLUMNS} FROM member_cards WHERE profile_id = $1 AND ` +
        `(${authorsWhere(accounts, params)}) ORDER BY issued_at DESC, seq DESC LIMIT $2`,
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
    const params: unknown[] = [profile, tsParam(since)];
    const rows = await this.db.query(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $1 AND issued_at >= $2 AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return rows[0] ? num(rows[0], "n") : 0;
  }

  async countFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: unknown[] = [profile];
    const rows = await this.db.query(
      "SELECT COUNT(*) AS n FROM member_cards WHERE profile_id = $1 AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
    );
    return rows[0] ? num(rows[0], "n") : 0;
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: unknown[] = [profile];
    return this.db.execute(
      `DELETE FROM member_cards WHERE profile_id = $1 AND (${authorsWhere(accounts, params)})`,
      params,
    );
  }
}

// ---- coins ---------------------------------------------------------------------------------

const COIN_COLUMNS = "id, profile_id, author_platform, author_id, delta, reason, ref, idem_key, ts";

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

/** `reason = ANY(…)` over `reasons`, its parameter added to `params`. */
function reasonsIn(reasons: readonly string[], params: unknown[]): string {
  params.push([...reasons]);
  return `reason = ANY($${params.length}::text[])`;
}

class PgCoins implements CoinLedgerStore {
  constructor(private readonly db: Pg) {}

  async #balance(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    on?: Queryable,
  ): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: unknown[] = [profile];
    const rows = await this.db.query(
      "SELECT COALESCE(SUM(delta), 0)::bigint AS n FROM coin_ledger WHERE profile_id = $1 AND " +
        `(${authorsWhere(accounts, params)})`,
      params,
      on,
    );
    return rows[0] ? num(rows[0], "n") : 0;
  }

  async #sum(profile: ProfileId, cap: CoinCap, on: Queryable): Promise<number> {
    if (cap.reasons.length === 0 || cap.accounts?.length === 0) return 0;
    const params: unknown[] = [profile, tsParam(cap.since)];
    const reasons = reasonsIn(cap.reasons, params);
    const who = cap.accounts === null ? "" : ` AND (${authorsWhere(cap.accounts, params)})`;
    const rows = await this.db.query(
      "SELECT COALESCE(SUM(delta), 0)::bigint AS n FROM coin_ledger WHERE profile_id = $1 AND " +
        `ts >= $2 AND ${reasons}${who}`,
      params,
      on,
    );
    return rows[0] ? num(rows[0], "n") : 0;
  }

  async #byKey(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    key: string,
    on?: Queryable,
  ): Promise<CoinEntry | null> {
    if (accounts.length === 0) return null;
    const params: unknown[] = [profile, key];
    const rows = await this.db.query(
      `SELECT ${COIN_COLUMNS} FROM coin_ledger WHERE profile_id = $1 AND idem_key = $2 AND ` +
        `(${authorsWhere(accounts, params)}) ORDER BY ts, seq LIMIT 1`,
      params,
      on,
    );
    return rows[0] ? coinFromRow(rows[0]) : null;
  }

  async post(entry: CoinEntry, rule: CoinRule): Promise<CoinPost> {
    if (!Number.isSafeInteger(entry.delta)) throw new StoreError("a coin delta must be whole");
    const wallet = walletWith(entry.account, rule.wallet);
    const profile = entry.profile;
    try {
      // Posts of one profile take turns: the checks and the insert see the same ledger.
      return await this.db.tx(async (client): Promise<CoinPost> => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `coin_ledger/${profile}`,
        ]);
        if (entry.idem_key !== null) {
          const first = await this.#byKey(profile, wallet, entry.idem_key, client);
          if (first) {
            const balance = await this.#balance(profile, wallet, client);
            return { status: "duplicate", entry: first, balance };
          }
        }
        const balance = await this.#balance(profile, wallet, client);
        const delta = await allowedDeltaAsync(entry.delta, rule, (cap) =>
          this.#sum(profile, cap, client),
        );
        if (delta === null) return { status: "capped", balance };
        if (rule.covered && balance + delta < 0) return { status: "short", balance };
        await this.db.execute(
          "INSERT INTO coin_ledger (id, profile_id, author_platform, author_id, delta, reason, " +
            "ref, idem_key, ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            entry.id,
            profile,
            entry.account.platform,
            entry.account.id,
            delta,
            entry.reason,
            entry.ref,
            entry.idem_key,
            tsParam(entry.ts),
          ],
          client,
        );
        return { status: "posted", entry: { ...entry, delta }, balance: balance + delta };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  balance(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    return this.#balance(profile, accounts);
  }

  async entries(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]> {
    if (accounts.length === 0 || filter.reasons?.length === 0) return [];
    const params: unknown[] = [profile, limitParam(filter.limit)];
    let where = `profile_id = $1 AND (${authorsWhere(accounts, params)})`;
    if (filter.reasons) where += ` AND ${reasonsIn(filter.reasons, params)}`;
    if (filter.since !== undefined) {
      params.push(tsParam(filter.since));
      where += ` AND ts >= $${params.length}`;
    }
    const rows = await this.db.query(
      `SELECT ${COIN_COLUMNS} FROM coin_ledger WHERE ${where} ORDER BY ts DESC, seq DESC LIMIT $2`,
      params,
    );
    return rows.map(coinFromRow);
  }

  byKey(profile: ProfileId, accounts: readonly AccountRef[], key: string) {
    return this.#byKey(profile, accounts, key);
  }

  async selectedFrame(profile: ProfileId, accounts: readonly AccountRef[]): Promise<string | null> {
    if (accounts.length === 0) return null;
    const params: unknown[] = [profile];
    const rows = await this.db.query(
      "SELECT frame FROM coin_wallets WHERE profile_id = $1 AND " +
        `(${authorsWhere(accounts, params)}) ORDER BY updated_at DESC LIMIT 1`,
      params,
    );
    return rows[0] ? optStr(rows[0], "frame") : null;
  }

  async selectFrame(
    profile: ProfileId,
    account: AccountRef,
    frame: string | null,
    at: Timestamp,
  ): Promise<void> {
    await this.db.execute(
      "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (profile_id, author_platform, author_id) " +
        "DO UPDATE SET frame = EXCLUDED.frame, updated_at = EXCLUDED.updated_at",
      [profile, account.platform, account.id, frame, tsParam(at)],
    );
  }

  async onBoard(profile: ProfileId, accounts: readonly AccountRef[]): Promise<boolean> {
    if (accounts.length === 0) return true;
    const params: unknown[] = [profile];
    const rows = await this.db.query(
      "SELECT 1 AS x FROM coin_wallets WHERE profile_id = $1 AND off_board AND " +
        `(${authorsWhere(accounts, params)}) LIMIT 1`,
      params,
    );
    return rows.length === 0;
  }

  async setOnBoard(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    on: boolean,
  ): Promise<void> {
    // A row made only for the board is the oldest, so it never hides a chosen frame.
    await this.db.tx(async (client) => {
      for (const account of accounts) {
        await this.db.execute(
          "INSERT INTO coin_wallets (profile_id, author_platform, author_id, frame, updated_at, " +
            "off_board) VALUES ($1, $2, $3, NULL, to_timestamp(0), $4) ON CONFLICT (profile_id, " +
            "author_platform, author_id) DO UPDATE SET off_board = EXCLUDED.off_board",
          [profile, account.platform, account.id, !on],
          client,
        );
      }
    });
  }

  async offBoardAccounts(profile: ProfileId, limit: number): Promise<AccountRef[]> {
    const rows = await this.db.query(
      "SELECT author_platform, author_id FROM coin_wallets WHERE profile_id = $1 AND off_board " +
        "ORDER BY author_platform, author_id LIMIT $2",
      [profile, limitParam(limit)],
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
    const params: unknown[] = [profile, tsParam(since), limitParam(limit)];
    const names = reasonsIn(reasons, params).replace("reason", "l.reason");
    const rows = await this.db.query(
      "SELECT l.author_platform AS author_platform, l.author_id AS author_id, " +
        "(-SUM(l.delta))::bigint AS n FROM coin_ledger l WHERE l.profile_id = $1 AND l.ts >= $2 " +
        `AND l.delta < 0 AND ${names} AND (l.reason <> 'deal_escrow' ` +
        "OR EXISTS (SELECT 1 FROM deals d WHERE d.escrow_entry = l.id AND d.status = 'settled')) " +
        "AND NOT EXISTS (SELECT 1 FROM coin_ledger r WHERE r.profile_id = l.profile_id AND " +
        "r.reason = 'refund' AND r.ref = l.id) GROUP BY l.author_platform, l.author_id " +
        "HAVING SUM(l.delta) < 0 ORDER BY n DESC, l.author_platform, l.author_id LIMIT $3",
      params,
    );
    return rows.map((r) => ({
      account: { platform: str(r, "author_platform"), id: str(r, "author_id") },
      spent: num(r, "n"),
    }));
  }
}

// ---- fortunes ------------------------------------------------------------------------------

const FORTUNE_COLUMNS =
  "id, profile_id, author_platform, author_id, person_id, day, issued_at, entry_id, " +
  "slip::text AS slip";

function fortuneFromRow(row: Row): FortuneRecord {
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    account: { platform: str(row, "author_platform"), id: str(row, "author_id") },
    person: optStr(row, "person_id"),
    day: num(row, "day"),
    issued_at: ts(row, "issued_at"),
    entry: optStr(row, "entry_id"),
    slip: parseJson<JsonObject>(str(row, "slip"), "fortune"),
  };
}

class PgFortunes implements FortuneStore {
  constructor(private readonly db: Pg) {}

  async put(record: FortuneRecord, accounts: readonly AccountRef[]): Promise<boolean> {
    const wallet = walletWith(record.account, accounts);
    try {
      return await this.db.tx(async (client): Promise<boolean> => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `fortunes/${record.profile}`,
        ]);
        const params: unknown[] = [record.profile, record.day];
        const taken = await this.db.query(
          "SELECT id FROM fortunes WHERE profile_id = $1 AND day = $2 AND " +
            `(${authorsWhere(wallet, params)}) LIMIT 1`,
          params,
          client,
        );
        if (taken.length > 0) return false;
        await this.db.execute(
          "INSERT INTO fortunes (id, profile_id, author_platform, author_id, person_id, day, " +
            "issued_at, entry_id, slip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
          [
            record.id,
            record.profile,
            record.account.platform,
            record.account.id,
            record.person,
            record.day,
            tsParam(record.issued_at),
            record.entry,
            JSON.stringify(record.slip),
          ],
          client,
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
    const params: unknown[] = [profile, day];
    const rows = await this.db.query(
      `SELECT ${FORTUNE_COLUMNS} FROM fortunes WHERE profile_id = $1 AND day = $2 AND ` +
        `(${authorsWhere(accounts, params)}) ORDER BY issued_at DESC, seq DESC LIMIT 1`,
      params,
    );
    return rows[0] ? fortuneFromRow(rows[0]) : null;
  }

  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]> {
    if (accounts.length === 0) return [];
    const params: unknown[] = [profile, limitParam(limit)];
    const rows = await this.db.query(
      `SELECT ${FORTUNE_COLUMNS} FROM fortunes WHERE profile_id = $1 AND ` +
        `(${authorsWhere(accounts, params)}) ORDER BY issued_at DESC, seq DESC LIMIT $2`,
      params,
    );
    return rows.map(fortuneFromRow);
  }

  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    if (accounts.length === 0) return 0;
    const params: unknown[] = [profile];
    return this.db.execute(
      `DELETE FROM fortunes WHERE profile_id = $1 AND (${authorsWhere(accounts, params)})`,
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

/** `status = ANY(...)` over `statuses`, its parameter added to `params`. */
function statusIn(statuses: readonly string[], params: unknown[]): string {
  params.push([...statuses]);
  return `status = ANY($${params.length}::text[])`;
}

class PgDeals implements DealStore {
  constructor(private readonly db: Pg) {}

  async create(deal: Deal): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO deals (id, profile_id, author_platform, author_id, reward_item, " +
          "reward_count, reward_value, task, prepaid, escrow_entry, status, created_at, " +
          "done_at, due_at, closed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, " +
          "$12, $13, $14, $15)",
        [
          deal.id,
          deal.profile,
          deal.account.platform,
          deal.account.id,
          deal.item,
          deal.count,
          deal.value,
          deal.task,
          deal.prepaid,
          deal.escrow,
          deal.status,
          tsParam(deal.created_at),
          optTsParam(deal.done_at),
          optTsParam(deal.due_at),
          optTsParam(deal.closed_at),
        ],
      );
    } catch (cause) {
      throw new StoreError("cannot write the deal", { cause });
    }
  }

  async get(id: string): Promise<Deal | null> {
    const rows = await this.db.query("SELECT * FROM deals WHERE id = $1", [id]);
    return rows[0] ? dealFromRow(rows[0]) : null;
  }

  async transition(id: string, from: readonly DealStatus[], patch: DealPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: unknown[] = [id, patch.status];
    const sets = ["status = $2"];
    for (const [column, value] of [
      ["done_at", patch.done_at],
      ["due_at", patch.due_at],
      ["closed_at", patch.closed_at],
    ] as const) {
      if (value === undefined) continue;
      params.push(optTsParam(value));
      sets.push(`${column} = $${params.length}::timestamptz`);
    }
    const changed = await this.db.execute(
      `UPDATE deals SET ${sets.join(", ")} WHERE id = $1 AND ${statusIn(from, params)}`,
      params,
    );
    return changed > 0;
  }

  async forAccounts(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    filter: { statuses?: readonly DealStatus[]; since?: Timestamp; limit: number },
  ): Promise<Deal[]> {
    if (accounts.length === 0 || filter.statuses?.length === 0) return [];
    const params: unknown[] = [profile, limitParam(filter.limit)];
    let where = `profile_id = $1 AND (${authorsWhere(accounts, params)})`;
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    if (filter.since !== undefined) {
      params.push(tsParam(filter.since));
      where += ` AND created_at >= $${params.length}`;
    }
    const rows = await this.db.query(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT $2`,
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
    const params: unknown[] = [profile, limitParam(filter.limit)];
    let where = `profile_id = $1 AND ${statusIn(statuses, params)}`;
    if (filter.since !== undefined) {
      params.push(tsParam(filter.since));
      where += ` AND created_at >= $${params.length}`;
    }
    const rows = await this.db.query(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at, seq LIMIT $2`,
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

class PgGoals implements GoalStore {
  constructor(private readonly db: Pg) {}

  async create(goal: Goal): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO goals (id, profile_id, title, promise, target, status, created_at, " +
          "deadline, closed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          goal.id,
          goal.profile,
          goal.title,
          goal.promise,
          goal.target,
          goal.status,
          tsParam(goal.created_at),
          tsParam(goal.deadline),
          optTsParam(goal.closed_at),
        ],
      );
    } catch (cause) {
      throw new StoreError("cannot write the goal", { cause });
    }
  }

  async get(id: string): Promise<Goal | null> {
    const rows = await this.db.query("SELECT * FROM goals WHERE id = $1", [id]);
    return rows[0] ? goalFromRow(rows[0]) : null;
  }

  async transition(id: string, from: readonly GoalStatus[], patch: GoalPatch): Promise<boolean> {
    if (from.length === 0) return false;
    const params: unknown[] = [id, patch.status];
    const sets = ["status = $2"];
    if (patch.closed_at !== undefined) {
      params.push(optTsParam(patch.closed_at));
      sets.push(`closed_at = $${params.length}::timestamptz`);
    }
    const changed = await this.db.execute(
      `UPDATE goals SET ${sets.join(", ")} WHERE id = $1 AND ${statusIn(from, params)}`,
      params,
    );
    return changed > 0;
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly GoalStatus[]; limit: number },
  ): Promise<Goal[]> {
    if (filter.statuses?.length === 0) return [];
    const params: unknown[] = [profile, limitParam(filter.limit)];
    let where = "profile_id = $1";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = await this.db.query(
      `SELECT * FROM goals WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT $2`,
      params,
    );
    return rows.map(goalFromRow);
  }

  async addPledge(pledge: GoalPledge): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO goal_pledges (id, goal_id, profile_id, author_platform, author_id, " +
          "amount, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          pledge.id,
          pledge.goal,
          pledge.profile,
          pledge.account.platform,
          pledge.account.id,
          pledge.amount,
          tsParam(pledge.created_at),
        ],
      );
    } catch (cause) {
      throw new StoreError("cannot write the pledge", { cause });
    }
  }

  async pledges(goal: string): Promise<GoalPledge[]> {
    const rows = await this.db.query(
      "SELECT * FROM goal_pledges WHERE goal_id = $1 ORDER BY created_at, seq",
      [goal],
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

class PgBounties implements BountyStore {
  constructor(private readonly db: Pg) {}

  async create(bounty: Bounty): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO bounties (id, profile_id, task, reward, hold_entry, status, created_at, " +
          "expires_at, closed_at, winner_platform, winner_id) VALUES ($1, $2, $3, $4, $5, $6, " +
          "$7, $8, $9, $10, $11)",
        [
          bounty.id,
          bounty.profile,
          bounty.task,
          bounty.reward,
          bounty.hold,
          bounty.status,
          tsParam(bounty.created_at),
          tsParam(bounty.expires_at),
          optTsParam(bounty.closed_at),
          bounty.winner?.platform ?? null,
          bounty.winner?.id ?? null,
        ],
      );
    } catch (cause) {
      throw new StoreError("cannot write the bounty", { cause });
    }
  }

  async get(id: string): Promise<Bounty | null> {
    const rows = await this.db.query("SELECT * FROM bounties WHERE id = $1", [id]);
    return rows[0] ? bountyFromRow(rows[0]) : null;
  }

  async transition(
    id: string,
    from: readonly BountyStatus[],
    patch: BountyPatch,
  ): Promise<boolean> {
    if (from.length === 0) return false;
    const params: unknown[] = [id, patch.status];
    const sets = ["status = $2"];
    if (patch.closed_at !== undefined) {
      params.push(optTsParam(patch.closed_at));
      sets.push(`closed_at = $${params.length}::timestamptz`);
    }
    if (patch.winner !== undefined) {
      params.push(patch.winner?.platform ?? null, patch.winner?.id ?? null);
      sets.push(`winner_platform = $${params.length - 1}`, `winner_id = $${params.length}`);
    }
    const changed = await this.db.execute(
      `UPDATE bounties SET ${sets.join(", ")} WHERE id = $1 AND ${statusIn(from, params)}`,
      params,
    );
    return changed > 0;
  }

  async list(
    profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; limit: number },
  ): Promise<Bounty[]> {
    if (filter.statuses?.length === 0) return [];
    const params: unknown[] = [profile, limitParam(filter.limit)];
    let where = "profile_id = $1";
    if (filter.statuses) where += ` AND ${statusIn(filter.statuses, params)}`;
    const rows = await this.db.query(
      `SELECT * FROM bounties WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT $2`,
      params,
    );
    return rows.map(bountyFromRow);
  }
}

// ---- module state -------------------------------------------------------------------------

class PgModuleState implements ModuleStateStore {
  constructor(private readonly db: Pg) {}

  async get(module: ModuleId): Promise<boolean | null> {
    const rows = await this.db.query("SELECT enabled FROM module_state WHERE module_id = $1", [
      module,
    ]);
    return rows[0] ? bool(rows[0], "enabled") : null;
  }

  async set(module: ModuleId, enabled: boolean): Promise<void> {
    await this.db.execute(
      "INSERT INTO module_state (module_id, enabled, updated_at) VALUES ($1, $2, " +
        "COALESCE($3::timestamptz, now())) ON CONFLICT (module_id) DO UPDATE SET " +
        "enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at",
      [module, enabled, this.db.now()],
    );
  }

  async list(): Promise<Map<ModuleId, boolean>> {
    const rows = await this.db.query(
      'SELECT module_id, enabled FROM module_state ORDER BY module_id COLLATE "C"',
    );
    return new Map(rows.map((r) => [str(r, "module_id"), bool(r, "enabled")]));
  }
}

// ---- persona overrides --------------------------------------------------------------------

class PgPersonaOverrides implements PersonaOverrideStore {
  constructor(private readonly db: Pg) {}

  async set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    // Edits of one section are serialized with a transaction-scoped advisory lock, so the next
    // version number is never contended.
    try {
      return await this.db.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `persona_overrides/${profile}/${key}`,
        ]);
        const rows = await this.db.query(
          "INSERT INTO persona_overrides (profile_id, section_key, version, body, edited_by, " +
            "edited_at) SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, " +
            "COALESCE($5::timestamptz, now()) FROM persona_overrides " +
            "WHERE profile_id = $1 AND section_key = $2 RETURNING version",
          [profile, key, body, editedBy, this.db.now()],
          client,
        );
        if (!rows[0]) throw new StoreError("cannot store persona override");
        return num(rows[0], "version");
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store persona override", { cause });
    }
  }

  async current(profile: ProfileId): Promise<Map<string, string>> {
    const rows = await this.db.query(
      "SELECT DISTINCT ON (section_key) section_key, body FROM persona_overrides " +
        "WHERE profile_id = $1 ORDER BY section_key, version DESC",
      [profile],
    );
    const entries = rows.map((r) => [str(r, "section_key"), str(r, "body")] as const);
    return new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    const rows = await this.db.query(
      "SELECT version, body, edited_by, edited_at FROM persona_overrides " +
        "WHERE profile_id = $1 AND section_key = $2 ORDER BY version ASC",
      [profile, key],
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
  'WHERE person_id = $1 ORDER BY first_seen, platform COLLATE "C", account_id COLLATE "C"';

class PgPeople implements PeopleStore {
  constructor(private readonly db: Pg) {}

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const existing = await this.db.query(
        "UPDATE accounts SET display_name = $3, last_seen = COALESCE($4::timestamptz, now()) " +
          "WHERE platform = $1 AND account_id = $2 RETURNING person_id",
        [account.platform, account.id, displayName, this.db.now()],
      );
      if (existing[0]) return str(existing[0], "person_id");
      // First sight: create the person and the account together. If a concurrent call created
      // the account first, roll back and reuse it.
      const person = newId();
      const created = await this.db
        .tx(async (client) => {
          const now = this.db.now();
          await client.query(
            "INSERT INTO people (id, display_name, created_at) VALUES ($1, $2, " +
              "COALESCE($3::timestamptz, now()))",
            [person, displayName, now],
          );
          const inserted = await this.db.execute(
            "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
              "last_seen) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), " +
              "COALESCE($5::timestamptz, now())) ON CONFLICT (platform, account_id) DO NOTHING",
            [account.platform, account.id, person, displayName, now],
            client,
          );
          if (inserted !== 1) throw new LostRace();
          return true;
        })
        .catch((error: unknown) => {
          if (error instanceof LostRace) return false;
          throw error;
        });
      if (created) return person;
    }
    throw new StoreError(
      `account \`${account.platform}:${account.id}\` is being created concurrently; try again`,
    );
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const rows = await this.db.query(
      "SELECT p.id, p.display_name, p.created_at FROM accounts a " +
        "JOIN people p ON p.id = a.person_id WHERE a.platform = $1 AND a.account_id = $2",
      [account.platform, account.id],
    );
    const row = rows[0];
    if (!row) return null;
    const id = str(row, "id");
    return {
      id,
      display_name: str(row, "display_name"),
      created_at: ts(row, "created_at"),
      accounts: (await this.db.query(ACCOUNTS_OF, [id])).map(accountFromRow),
    };
  }

  async all(): Promise<Person[]> {
    // One statement, so people and accounts come from the same snapshot.
    const rows = await this.db.query(
      "SELECT p.id, p.display_name AS person_name, p.created_at, a.platform, a.account_id, " +
        "a.display_name, a.first_seen, a.last_seen FROM people p " +
        "LEFT JOIN accounts a ON a.person_id = p.id " +
        'ORDER BY p.created_at, p.id COLLATE "C", a.first_seen, a.platform COLLATE "C", ' +
        'a.account_id COLLATE "C"',
    );
    const out: Person[] = [];
    for (const row of rows) {
      const id = str(row, "id");
      let person = out[out.length - 1];
      if (person?.id !== id) {
        person = {
          id,
          display_name: str(row, "person_name"),
          created_at: ts(row, "created_at"),
          accounts: [],
        };
        out.push(person);
      }
      if (row.platform != null) person.accounts.push(accountFromRow(row));
    }
    return out;
  }
}

/** Rolls back a first-sight insert that lost to a concurrent one. */
class LostRace extends Error {
  override readonly name = "LostRace";
}

class PgIdentity implements IdentityStore {
  constructor(private readonly db: Pg) {}

  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    // A new account row has no name yet; its id stands in until the account is seen.
    try {
      await this.db.execute(
        "INSERT INTO accounts (platform, account_id, person_id, display_name, first_seen, " +
          "last_seen) VALUES ($1, $2, $3, $2, COALESCE($4::timestamptz, now()), " +
          "COALESCE($4::timestamptz, now())) ON CONFLICT (platform, account_id) " +
          "DO UPDATE SET person_id = EXCLUDED.person_id",
        [account.platform, account.id, person, this.db.now()],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (pgCode(cause) === FOREIGN_KEY_VIOLATION) {
        throw new StoreError(`unknown person \`${person}\``, { cause });
      }
      throw new StoreError("cannot link account", { cause });
    }
  }

  async mergePeople(keep: PersonId, absorb: PersonId): Promise<void> {
    await this.db.tx(async (client) => {
      // Rows are locked in id order, so concurrent merges cannot deadlock.
      const found = (
        await this.db.query(
          "SELECT id FROM people WHERE id = ANY($1) ORDER BY id FOR UPDATE",
          [[keep, absorb]],
          client,
        )
      ).map((r) => str(r, "id"));
      for (const person of [keep, absorb]) {
        if (!found.includes(person)) throw new StoreError(`unknown person \`${person}\``);
      }
      if (keep === absorb) return;
      await client.query("UPDATE accounts SET person_id = $1 WHERE person_id = $2", [keep, absorb]);
      await client.query("DELETE FROM people WHERE id = $1", [absorb]);
    });
  }

  async accountsOf(person: PersonId): Promise<Account[]> {
    return (await this.db.query(ACCOUNTS_OF, [person])).map(accountFromRow);
  }

  async setPersonName(person: PersonId, displayName: string): Promise<void> {
    const changed = await this.db.execute("UPDATE people SET display_name = $2 WHERE id = $1", [
      person,
      displayName,
    ]);
    if (changed === 0) throw new StoreError(`unknown person \`${person}\``);
  }

  async createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void> {
    await this.db.execute(
      "INSERT INTO link_codes (code, platform, account_id, expires_at) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (code) DO UPDATE SET platform = EXCLUDED.platform, " +
        "account_id = EXCLUDED.account_id, expires_at = EXCLUDED.expires_at",
      [code, account.platform, account.id, tsParam(expiresAt)],
    );
  }

  async consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null> {
    const rows = await this.db.query(
      "DELETE FROM link_codes WHERE code = $1 RETURNING platform, account_id, expires_at",
      [code],
    );
    const row = rows[0];
    if (!row || toMicros(str(row, "expires_at")) <= toMicros(now)) return null;
    return { platform: str(row, "platform"), id: str(row, "account_id") };
  }
}

// ---- decisions ----------------------------------------------------------------------------

class PgDecisionLog implements DecisionLog {
  constructor(private readonly db: Pg) {}

  async append(record: DecisionRecord): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO decision_log (id, profile_id, context_key, ts, trace) " +
          "VALUES ($1, $2, $3, $4, $5::jsonb)",
        [
          record.id,
          record.profile,
          contextLookupKey(record.trace.context),
          tsParam(record.ts),
          JSON.stringify(record.trace),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (pgCode(cause) === UNIQUE_VIOLATION) {
        throw new StoreError(`decision \`${record.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append decision", { cause });
    }
  }

  async recent(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<DecisionRecord[]> {
    const rows = await this.db.query(
      "SELECT id, ts, trace::text AS trace FROM decision_log WHERE profile_id = $1 AND " +
        '($2::text IS NULL OR context_key = $2) ORDER BY ts DESC, id COLLATE "C" DESC LIMIT $3',
      [profile, context === null ? null : contextLookupKey(context), limitParam(limit)],
    );
    return rows.map((r) => ({
      id: str(r, "id"),
      profile,
      ts: ts(r, "ts"),
      trace: parseJson<DecisionTrace>(str(r, "trace"), "decision trace"),
    }));
  }

  async appendOutcome(profile: ProfileId, record: TurnOutcomeRecord): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO turn_outcomes (id, profile_id, context_key, ts, outcome, record) " +
          "VALUES ($1, $2, $3, $4, $5, $6::jsonb) " +
          "ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, " +
          "context_key = EXCLUDED.context_key, ts = EXCLUDED.ts, " +
          "outcome = EXCLUDED.outcome, record = EXCLUDED.record",
        [
          record.turn,
          profile,
          contextLookupKey(record.context),
          tsParam(record.at),
          record.outcome.type,
          JSON.stringify(record),
        ],
      );
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
    const rows = await this.db.query(
      "SELECT record::text AS record FROM turn_outcomes WHERE profile_id = $1 AND " +
        '($2::text IS NULL OR context_key = $2) ORDER BY ts DESC, id COLLATE "C" DESC LIMIT $3',
      [profile, context === null ? null : contextLookupKey(context), limitParam(limit)],
    );
    return rows.map((r) => parseJson<TurnOutcomeRecord>(str(r, "record"), "turn outcome"));
  }
}

// ---- settings -----------------------------------------------------------------------------

class PgSettings implements SettingsStore {
  constructor(private readonly db: Pg) {}

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const rows = await this.db.query(
      "SELECT value::text AS value FROM profile_settings WHERE profile_id = $1 AND key = $2",
      [profile, key],
    );
    return rows[0] ? parseJson<JsonValue>(str(rows[0], "value"), "setting") : null;
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    if (value === null) {
      await this.db.execute("DELETE FROM profile_settings WHERE profile_id = $1 AND key = $2", [
        profile,
        key,
      ]);
      return;
    }
    await this.db.execute(
      "INSERT INTO profile_settings (profile_id, key, value, updated_at) VALUES ($1, $2, " +
        "$3::jsonb, COALESCE($4::timestamptz, now())) ON CONFLICT (profile_id, key) " +
        "DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
      [profile, key, JSON.stringify(value), this.db.now()],
    );
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    // `left()` instead of `LIKE`, so `%` and `_` in the prefix are literal.
    const rows = await this.db.query(
      "SELECT key, value::text AS value FROM profile_settings WHERE profile_id = $1 AND " +
        'left(key, char_length($2)) = $2 ORDER BY key COLLATE "C"',
      [profile, prefix],
    );
    return new Map(
      rows.map((r) => [str(r, "key"), parseJson<JsonValue>(str(r, "value"), "setting")]),
    );
  }

  async deletePrefix(profile: ProfileId, prefix: string): Promise<number> {
    return this.db.execute(
      "DELETE FROM profile_settings WHERE profile_id = $1 AND left(key, char_length($2)) = $2",
      [profile, prefix],
    );
  }
}

// ---- whole-profile export / wipe ----------------------------------------------------------

const PG_DIALECT: SqlDialect = {
  startsWith: (column, param) => `left(${column}, char_length(${param}::text)) = ${param}::text`,
  jsonText: (column) => `${column}::text`,
  keyOrder: 'key COLLATE "C"',
  list: (values) => [...values],
  bool: (value) => value,
};

class PgProfileData implements ProfileDataStore {
  constructor(private readonly db: Pg) {}

  #query = (stmt: Stmt) => this.db.query(stmt.sql, stmt.params);

  async #now(): Promise<string> {
    const rows = await this.db.query("SELECT COALESCE($1::timestamptz, now()) AS now", [
      this.db.now(),
    ]);
    return normalizeTimestamp(str(rows[0] ?? {}, "now"));
  }

  async inventory(profile: ProfileId): Promise<DataInventory> {
    return readInventory(PG_DIALECT, this.#query, profile, await this.#now());
  }

  async export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport> {
    return readExport(PG_DIALECT, this.#query, profile, categories, await this.#now());
  }

  async wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): Promise<WipeCounts> {
    const statements = wipeStatements(PG_DIALECT, profile, categories, options);
    try {
      return await this.db.tx(async (client) => {
        const counts: WipeCounts = {};
        for (const { part, stmt } of statements) {
          addCount(counts, part, await this.db.execute(stmt.sql, stmt.params, client));
        }
        return counts;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot wipe the profile data", { cause });
    }
  }
}

// ---- memory records -----------------------------------------------------------------------

/** JSON and vector values travel as text. */
const MEMORY_COLUMNS =
  "id, profile_id, kind, scope::text AS scope, subjects, content, tokens, " +
  "embedding::text AS embedding, importance, confidence, created_at, updated_at, " +
  "last_accessed, access_count, source_context, source, origin, source_events, due, done, " +
  "superseded_by";

function memoryFromRow(row: Row): MemoryRecord {
  const embedding = optStr(row, "embedding");
  const sourceContext = optStr(row, "source_context");
  const source = optStr(row, "source");
  return {
    id: str(row, "id"),
    profile: str(row, "profile_id"),
    kind: memoryKind(str(row, "kind")),
    scope: parseJson<MemoryScope>(str(row, "scope"), "memory scope"),
    subjects: strings(row, "subjects"),
    content: str(row, "content"),
    tokens: str(row, "tokens"),
    embedding: embedding === null ? null : parseVector(embedding),
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
    source_events: sourceEvents(row.source_events),
    due: optTs(row, "due"),
    done: bool(row, "done"),
    superseded_by: optStr(row, "superseded_by"),
  };
}

class PgMemories implements MemoryRecordStore {
  constructor(private readonly db: Pg) {}

  async upsert(record: MemoryRecord): Promise<void> {
    const embedding = cleanEmbedding(record.embedding);
    const scope = JSON.stringify(canonicalMemoryScope(record.scope));
    try {
      await this.db.execute(
        "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, " +
          "content, tokens, embedding, importance, confidence, created_at, updated_at, " +
          "last_accessed, access_count, source_context, due, done, superseded_by, source, " +
          "origin, source_events) " +
          "VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13, " +
          "$14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb) " +
          "ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, " +
          "kind = EXCLUDED.kind, scope = EXCLUDED.scope, scope_key = EXCLUDED.scope_key, " +
          "subjects = EXCLUDED.subjects, content = EXCLUDED.content, " +
          "tokens = EXCLUDED.tokens, embedding = EXCLUDED.embedding, " +
          "importance = EXCLUDED.importance, confidence = EXCLUDED.confidence, " +
          "created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, " +
          "last_accessed = EXCLUDED.last_accessed, access_count = EXCLUDED.access_count, " +
          "source_context = EXCLUDED.source_context, due = EXCLUDED.due, " +
          "done = EXCLUDED.done, superseded_by = EXCLUDED.superseded_by, " +
          "source = EXCLUDED.source, origin = EXCLUDED.origin, " +
          "source_events = EXCLUDED.source_events",
        [
          record.id,
          record.profile,
          memoryKind(record.kind),
          scope,
          scope,
          record.subjects,
          record.content,
          record.tokens,
          embedding === null ? null : vectorLiteral(embedding),
          record.importance,
          record.confidence,
          tsParam(record.created_at),
          tsParam(record.updated_at),
          optTsParam(record.last_accessed),
          u32(record.access_count),
          record.source_context === null ? null : contextLookupKey(record.source_context),
          optTsParam(record.due),
          record.done,
          record.superseded_by,
          memorySourceJson(record.source),
          memoryOrigin(record.origin ?? "unknown"),
          JSON.stringify(sourceEvents(record.source_events)),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store memory record", { cause });
    }
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const rows = await this.db.query(`SELECT ${MEMORY_COLUMNS} FROM memory_records WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? memoryFromRow(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.execute("DELETE FROM memory_records WHERE id = $1", [id])) > 0;
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const embedding = cleanEmbedding(query.embedding);
    const limit = sqlLimit(query.limit);
    if (limit === 0) return [];
    const scopes = query.scopes.map(memoryScopeKey);
    const kinds: MemoryKind[] | null = query.kinds === null ? null : [...query.kinds];
    const hits: MemoryHit[] = [];

    // Full text: OR of one `plainto_tsquery` per token, so the GIN index on `tsv` applies.
    const tokens = queryTokens(query.tokens);
    if (tokens.length > 0) {
      const tsquery = tokens.map((_, i) => `plainto_tsquery('simple', $${i + 5})`).join(" || ");
      let rows: Row[];
      try {
        rows = await this.db.query(
          `SELECT ${MEMORY_COLUMNS}, ts_rank(tsv, ${tsquery})::float8 AS score ` +
            "FROM memory_records WHERE profile_id = $1 AND scope_key = ANY($2) " +
            "AND ($3::text[] IS NULL OR kind = ANY($3)) " +
            `AND superseded_by IS NULL AND tsv @@ (${tsquery}) ` +
            'ORDER BY score DESC, created_at DESC, id COLLATE "C" DESC LIMIT $4',
          [query.profile, scopes, kinds, limit, ...tokens],
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

    // Nearest neighbours among rows with the query's dimension. Exact scan: there is no ANN
    // index yet. The CASE keeps the distance from being evaluated on rows of another dimension.
    if (embedding !== null) {
      let rows: Row[];
      try {
        rows = await this.db.query(
          `SELECT ${MEMORY_COLUMNS}, ` +
            "CASE WHEN vector_dims(embedding) = $5 THEN embedding <=> $4::vector END AS dist " +
            "FROM memory_records WHERE profile_id = $1 AND scope_key = ANY($2) " +
            "AND ($3::text[] IS NULL OR kind = ANY($3)) " +
            "AND superseded_by IS NULL AND embedding IS NOT NULL " +
            "AND vector_dims(embedding) = $5 " +
            'ORDER BY dist ASC, created_at DESC, id COLLATE "C" DESC LIMIT $6',
          [query.profile, scopes, kinds, vectorLiteral(embedding), embedding.length, limit],
        );
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError("memory vector search failed", { cause });
      }
      for (const row of rows) {
        const dist = row.dist == null ? null : num(row, "dist");
        const score = dist === null || !Number.isFinite(1 - dist) ? 0 : 1 - dist;
        const id = str(row, "id");
        const hit = hits.find((h) => h.record.id === id);
        if (hit) hit.vector_score = score;
        else hits.push({ record: memoryFromRow(row), text_score: 0, vector_score: score });
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    let rows: Row[];
    try {
      rows = await this.db.query(
        `SELECT ${MEMORY_COLUMNS} FROM memory_records WHERE profile_id = $1 ` +
          "AND ($2::text IS NULL OR $2 = ANY(subjects)) " +
          "AND ($3::text IS NULL OR scope_key = $3) " +
          "AND ($4::text IS NULL OR kind = $4) " +
          "AND ($5::timestamptz IS NULL OR created_at < $5) " +
          "AND ($6 OR superseded_by IS NULL) " +
          'ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $7',
        [
          profile,
          filter.subject,
          filter.scope === null ? null : memoryScopeKey(filter.scope),
          filter.kind,
          optTsParam(filter.before),
          filter.include_superseded,
          limitParam(filter.limit),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot list memory records", { cause });
    }
    return rows.map(memoryFromRow);
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    if (ids.length === 0) return;
    await this.db.execute(
      "UPDATE memory_records SET access_count = access_count + 1, last_accessed = $2 " +
        "WHERE id = ANY($1)",
      [[...new Set(ids)], tsParam(at)],
    );
  }

  async dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs: number | null = null,
  ): Promise<MemoryRecord[]> {
    const rows = await this.db.query(
      `SELECT ${MEMORY_COLUMNS} FROM memory_records WHERE profile_id = $1 AND ` +
        "kind = 'followup' AND NOT done AND superseded_by IS NULL AND due <= $2 AND " +
        "($3::bigint IS NULL OR due >= $2::timestamptz - ($3::bigint * interval '1 millisecond')) " +
        'ORDER BY due DESC, id COLLATE "C" DESC',
      [profile, tsParam(now), maxAgeMs === null ? null : Math.round(maxAgeMs)],
    );
    return rows.map(memoryFromRow);
  }

  async expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number> {
    return this.db.execute(
      "UPDATE memory_records SET done = TRUE WHERE profile_id = $1 AND kind = 'followup' " +
        "AND NOT done AND due IS NOT NULL AND due < $2",
      [profile, tsParam(dueBefore)],
    );
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    return this.db.execute(
      "DELETE FROM memory_records WHERE profile_id = $1 AND kind = 'episode' AND " +
        "created_at < $2 AND importance <= $3 AND (last_accessed IS NULL OR last_accessed < $4)",
      [
        profile,
        tsParam(policy.created_before),
        policy.max_importance,
        tsParam(policy.not_accessed_since),
      ],
    );
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    return this.db.execute(
      "DELETE FROM memory_records WHERE profile_id = $1 AND ($2 = ANY(subjects) OR scope_key = $3)",
      [profile, person, memoryScopeKey({ type: "person", person })],
    );
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    // One statement. `tokens` and `embedding` are untouched, so the generated `tsv` and the
    // vectors stay as they are. Subjects keep their first-occurrence order without duplicates.
    try {
      return await this.db.execute(
        "UPDATE memory_records SET " +
          "subjects = CASE WHEN $2::text = ANY(subjects) THEN ARRAY(" +
          "SELECT u.s FROM unnest(array_replace(subjects, $2::text, $1::text)) " +
          "WITH ORDINALITY AS u(s, ord) GROUP BY u.s ORDER BY min(u.ord)) ELSE subjects END, " +
          "scope = CASE WHEN scope_key = $3 THEN $4::text::jsonb ELSE scope END, " +
          "scope_key = CASE WHEN scope_key = $3 THEN $4::text ELSE scope_key END " +
          "WHERE $2::text = ANY(subjects) OR scope_key = $3",
        [
          keep,
          absorb,
          memoryScopeKey({ type: "person", person: absorb }),
          memoryScopeKey({ type: "person", person: keep }),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot merge memory records", { cause });
    }
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
    tags: strings(row, "tags"),
    notes: str(row, "notes"),
    call_name: optStr(row, "call_name"),
    interactions: u32(num(row, "interactions")),
    last_interaction: optTs(row, "last_interaction"),
    updated_at: ts(row, "updated_at"),
  };
}

class PgRelationships implements RelationshipStore {
  constructor(private readonly db: Pg) {}

  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const rows = await this.db.query(
      "SELECT * FROM relationships WHERE profile_id = $1 AND person_id = $2",
      [profile, person],
    );
    return rows[0] ? relationshipFromRow(rows[0]) : null;
  }

  async upsert(r: Relationship): Promise<void> {
    await this.db.execute(
      "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, tags, " +
        "notes, call_name, interactions, last_interaction, updated_at) VALUES ($1, $2, $3, $4, " +
        "$5, $6, $7, $8, $9, $10, $11) ON CONFLICT (profile_id, person_id) DO UPDATE SET " +
        "affinity = EXCLUDED.affinity, trust = EXCLUDED.trust, " +
        "familiarity = EXCLUDED.familiarity, tags = EXCLUDED.tags, notes = EXCLUDED.notes, " +
        "call_name = EXCLUDED.call_name, interactions = EXCLUDED.interactions, " +
        "last_interaction = EXCLUDED.last_interaction, updated_at = EXCLUDED.updated_at",
      [
        r.profile,
        r.person,
        r.affinity,
        r.trust,
        r.familiarity,
        r.tags,
        r.notes,
        r.call_name,
        u32(r.interactions),
        optTsParam(r.last_interaction),
        tsParam(r.updated_at),
      ],
    );
  }

  async list(profile: ProfileId): Promise<Relationship[]> {
    const rows = await this.db.query(
      'SELECT * FROM relationships WHERE profile_id = $1 ORDER BY person_id COLLATE "C"',
      [profile],
    );
    return rows.map(relationshipFromRow);
  }

  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.db.tx(async (client) => {
      await client.query(
        "DELETE FROM relationship_deltas WHERE profile_id = $1 AND person_id = $2",
        [profile, person],
      );
      const removed = await this.db.execute(
        "DELETE FROM relationships WHERE profile_id = $1 AND person_id = $2",
        [profile, person],
        client,
      );
      return removed > 0;
    });
  }

  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    await this.db.execute(
      "INSERT INTO relationship_deltas (profile_id, person_id, at, affinity, trust, " +
        "familiarity, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        profile,
        person,
        tsParam(delta.at),
        delta.affinity,
        delta.trust,
        delta.familiarity,
        delta.reason,
      ],
    );
  }

  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: Timestamp,
  ): Promise<RelationshipDelta[]> {
    const rows = await this.db.query(
      "SELECT at, affinity, trust, familiarity, reason FROM relationship_deltas " +
        "WHERE profile_id = $1 AND person_id = $2 AND at >= $3 ORDER BY at, seq",
      [profile, person, tsParam(since)],
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
    scope: parseJson<AuthScope>(str(row, "scope"), "auth scope"),
    granted_by: str(row, "granted_by"),
    at: ts(row, "at"),
  };
}

const ASSIGNMENT_COLUMNS = "platform, account_id, role, scope, granted_by, at";
const ASSIGNMENT_ORDER =
  'at, platform COLLATE "C", account_id COLLATE "C", role COLLATE "C", scope COLLATE "C"';

class PgAuth implements AuthStore {
  constructor(private readonly db: Pg) {}

  async roles(): Promise<RoleDefinition[]> {
    const rows = await this.db.query(
      'SELECT name, rank, grants, denies, builtin FROM roles ORDER BY rank DESC, name COLLATE "C"',
    );
    return rows.map((r) => ({
      name: str(r, "name"),
      rank: num(r, "rank"),
      grants: strings(r, "grants"),
      denies: strings(r, "denies"),
      builtin: bool(r, "builtin"),
    }));
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    await this.db.execute(
      "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($1, $2, $3, $4, $5) " +
        "ON CONFLICT (name) DO UPDATE SET rank = EXCLUDED.rank, grants = EXCLUDED.grants, " +
        "denies = EXCLUDED.denies, builtin = EXCLUDED.builtin",
      [role.name, role.rank, role.grants, role.denies, role.builtin],
    );
  }

  async deleteRole(name: string): Promise<boolean> {
    return this.db.tx(async (client) => {
      const rows = await this.db.query(
        "SELECT builtin FROM roles WHERE name = $1 FOR UPDATE",
        [name],
        client,
      );
      if (!rows[0]) return false;
      if (bool(rows[0], "builtin")) throw new StoreError(`role \`${name}\` is built in`);
      for (const table of ["role_assignments", "role_mappings", "node_overrides"]) {
        await client.query(`DELETE FROM ${table} WHERE role = $1`, [name]);
      }
      await client.query("DELETE FROM roles WHERE name = $1", [name]);
      return true;
    });
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    const rows = await this.db.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM role_assignments WHERE platform = $1 AND ` +
        `account_id = $2 ORDER BY ${ASSIGNMENT_ORDER}`,
      [account.platform, account.id],
    );
    return rows.map(assignmentFromRow);
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    const rows = await this.db.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM role_assignments ORDER BY ${ASSIGNMENT_ORDER}`,
    );
    return rows.map(assignmentFromRow);
  }

  async assign(a: RoleAssignment): Promise<void> {
    await this.db.execute(
      "INSERT INTO role_assignments (platform, account_id, role, scope, granted_by, at) " +
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (platform, account_id, role, scope) " +
        "DO UPDATE SET granted_by = EXCLUDED.granted_by, at = EXCLUDED.at",
      [
        a.account.platform,
        a.account.id,
        a.role,
        authScopeKey(a.scope),
        a.granted_by,
        tsParam(a.at),
      ],
    );
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const removed = await this.db.execute(
      "DELETE FROM role_assignments WHERE platform = $1 AND account_id = $2 AND role = $3 " +
        "AND scope = $4",
      [account.platform, account.id, role, authScopeKey(scope)],
    );
    return removed > 0;
  }

  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    const rows = await this.db.query(
      "SELECT platform_role, role FROM role_mappings WHERE platform = $1 AND guild = $2 " +
        'ORDER BY platform_role COLLATE "C"',
      [platform, guild],
    );
    return rows.map((r) => ({
      platform,
      guild,
      platform_role: str(r, "platform_role"),
      role: str(r, "role"),
    }));
  }

  async setMapping(m: RoleMapping): Promise<void> {
    await this.db.execute(
      "INSERT INTO role_mappings (platform, guild, platform_role, role) VALUES ($1, $2, $3, " +
        "$4) ON CONFLICT (platform, guild, platform_role) DO UPDATE SET role = EXCLUDED.role",
      [m.platform, m.guild, m.platform_role, m.role],
    );
  }

  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const removed = await this.db.execute(
      "DELETE FROM role_mappings WHERE platform = $1 AND guild = $2 AND platform_role = $3",
      [platform, guild, platformRole],
    );
    return removed > 0;
  }

  async overrides(): Promise<NodeOverride[]> {
    const rows = await this.db.query(
      "SELECT scope, role, node, allow FROM node_overrides " +
        'ORDER BY scope COLLATE "C", role COLLATE "C", node COLLATE "C"',
    );
    return rows.map((r) => ({
      scope: parseJson<AuthScope>(str(r, "scope"), "auth scope"),
      role: str(r, "role"),
      node: str(r, "node"),
      allow: bool(r, "allow"),
    }));
  }

  async setOverride(o: NodeOverride): Promise<void> {
    await this.db.execute(
      "INSERT INTO node_overrides (scope, role, node, allow) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (scope, role, node) DO UPDATE SET allow = EXCLUDED.allow",
      [authScopeKey(o.scope), o.role, o.node, o.allow],
    );
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const removed = await this.db.execute(
      "DELETE FROM node_overrides WHERE scope = $1 AND role = $2 AND node = $3",
      [authScopeKey(scope), role, node],
    );
    return removed > 0;
  }
}

function directiveFromRow(row: Row): DirectiveRecord {
  return {
    id: str(row, "id"),
    issuer: parseJson<AccountRef>(str(row, "issuer"), "directive issuer"),
    authority: str(row, "authority") as DirectiveRecord["authority"],
    scope: parseJson<DirectiveRecord["scope"]>(str(row, "scope"), "directive scope"),
    effect: str(row, "effect") as DirectiveRecord["effect"],
    text: str(row, "text"),
    expires: optTs(row, "expires") ?? "until_revoked",
    source_event: str(row, "source_event"),
    created_at: ts(row, "created_at"),
    revoked_at: optTs(row, "revoked_at"),
    revoked_by: optStr(row, "revoked_by"),
  };
}

const DIRECTIVE_COLUMNS =
  "id, issuer::text AS issuer, authority, scope::text AS scope, effect, text, expires, " +
  "source_event, created_at, revoked_at, revoked_by";

class PgDirectives implements DirectiveStore {
  constructor(private readonly db: Pg) {}

  async insert(profile: ProfileId, d: Directive): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO directives (id, profile_id, issuer, authority, scope, effect, text, " +
          "expires, source_event, created_at) " +
          "VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10)",
        [
          d.id,
          profile,
          JSON.stringify(d.issuer),
          d.authority,
          JSON.stringify(d.scope),
          d.effect,
          d.text,
          d.expires === "until_revoked" ? null : tsParam(d.expires),
          d.source_event,
          tsParam(d.created_at),
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the directive", { cause });
    }
  }

  async active(profile: ProfileId, now: Timestamp): Promise<DirectiveRecord[]> {
    const rows = await this.db.query(
      `SELECT ${DIRECTIVE_COLUMNS} FROM directives WHERE profile_id = $1 ` +
        "AND revoked_at IS NULL AND (expires IS NULL OR expires > $2) ORDER BY created_at, id",
      [profile, tsParam(now)],
    );
    return rows.map(directiveFromRow);
  }

  async all(profile: ProfileId, limit: number): Promise<DirectiveRecord[]> {
    const rows = await this.db.query(
      `SELECT ${DIRECTIVE_COLUMNS} FROM directives WHERE profile_id = $1 ` +
        "ORDER BY created_at DESC, id DESC LIMIT $2",
      [profile, limitParam(limit)],
    );
    return rows.map(directiveFromRow);
  }

  async revoke(profile: ProfileId, id: string, by: string, at: Timestamp): Promise<boolean> {
    const changed = await this.db.execute(
      "UPDATE directives SET revoked_at = $4, revoked_by = $3 " +
        "WHERE id = $2 AND profile_id = $1 AND revoked_at IS NULL",
      [profile, id, by, tsParam(at)],
    );
    return changed > 0;
  }

  async prune(profile: ProfileId, before: Timestamp): Promise<number> {
    return this.db.execute(
      "DELETE FROM directives WHERE profile_id = $1 AND (revoked_at < $2 OR expires < $2)",
      [profile, tsParam(before)],
    );
  }
}

class PgAudit implements AuditLog {
  constructor(private readonly db: Pg) {}

  async append(entry: AuditEntry): Promise<void> {
    try {
      await this.db.execute(
        "INSERT INTO audit_log (id, at, actor, action, target, detail, ok) " +
          "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
        [
          entry.id,
          tsParam(entry.at),
          entry.actor,
          entry.action,
          entry.target,
          JSON.stringify(entry.detail),
          entry.ok,
        ],
      );
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      if (pgCode(cause) === UNIQUE_VIOLATION) {
        throw new StoreError(`audit entry \`${entry.id}\` already exists`, { cause });
      }
      throw new StoreError("cannot append audit entry", { cause });
    }
  }

  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    const rows = await this.db.query(
      "SELECT id, at, actor, action, target, detail::text AS detail, ok FROM audit_log " +
        "WHERE ($2::text IS NULL OR actor = $2) " +
        'ORDER BY at DESC, id COLLATE "C" DESC LIMIT $1',
      [limitParam(limit), actor],
    );
    return rows.map((r) => ({
      id: str(r, "id"),
      at: ts(r, "at"),
      actor: str(r, "actor"),
      action: str(r, "action"),
      target: str(r, "target"),
      detail: parseJson<JsonValue>(str(r, "detail"), "audit detail"),
      ok: bool(r, "ok"),
    }));
  }
}

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one PostgreSQL pool. */
export class PostgresStore implements Store {
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
  readonly directives: DirectiveStore;
  readonly cards: MemberCardStore;
  readonly coins: CoinLedgerStore;
  readonly deals: DealStore;
  readonly fortunes: FortuneStore;
  readonly goals: GoalStore;
  readonly bounties: BountyStore;
  readonly #pool: pg.Pool;
  #closed = false;

  private constructor(db: Pg) {
    this.#pool = db.pool;
    this.messages = new PgMessageLog(db);
    this.moduleState = new PgModuleState(db);
    this.personaOverrides = new PgPersonaOverrides(db);
    this.people = new PgPeople(db);
    this.decisions = new PgDecisionLog(db);
    this.settings = new PgSettings(db);
    this.memories = new PgMemories(db);
    this.relationships = new PgRelationships(db);
    this.identity = new PgIdentity(db);
    this.auth = new PgAuth(db);
    this.audit = new PgAudit(db);
    this.profileData = new PgProfileData(db);
    this.directives = new PgDirectives(db);
    this.cards = new PgMemberCards(db);
    this.coins = new PgCoins(db);
    this.deals = new PgDeals(db);
    this.fortunes = new PgFortunes(db);
    this.goals = new PgGoals(db);
    this.bounties = new PgBounties(db);
  }

  /** Connects and runs pending migrations. */
  static async connect(url: string, options: PostgresStoreOptions = {}): Promise<PostgresStore> {
    const pool = new pg.Pool({
      connectionString: url,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
      types: TYPES,
    });
    // Idle clients that lose their connection emit `error` on the pool; without a listener
    // that would crash the process.
    pool.on("error", (err) => log.warn({ err }, "idle PostgreSQL connection failed"));
    try {
      const client = await pool.connect();
      client.release();
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      await pool.end().catch(() => undefined);
      throw new StoreError("cannot connect to PostgreSQL", { cause });
    }
    const db = new Pg(pool, options.clock ?? null);
    try {
      await migrate(db);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    return new PostgresStore(db);
  }

  /** The underlying pool (for tests and admin tools). */
  get pool(): pg.Pool {
    return this.#pool;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}
