// The `economy` plugin's tables on the store's database (`schema.ts`): the coin ledger and the
// wallets (`CoinLedgerStore`), the fortune slips (`FortuneStore`), her
// bounties (`BountyStore`) and economy 2.0's documents (`EconomyDocStore`).
// What names an account keeps the `AccountRef` in its record and identity's `accounts.id` in its
// row, made on first use like a link code's account. Core opens the store with
// `economyTables` and provides `store.plugin(economyTables)` under the economy's service keys
// (`records.ts`). Every read and write runs on the store's connection; a posting and its checks are
// one `Db.tx` (a savepoint inside a caller's).
//
// A wallet is a person with the persons they absorbed (identity keeps an absorbed person's row,
// `merged_into` set, so its rows are found again), or `PURSE`. A person id that was absorbed
// stands for the person that absorbed it.

import {
  accounts,
  type CategoryData,
  type Db,
  declined,
  EconomyPosted,
  type EconomyPostedData,
  type EventStore,
  type Identity,
  persons,
  StoreError,
  type StorePlugin,
  tablePart,
  toMicros,
} from "@miyoria/store";
import {
  type AccountRef,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
} from "@miyoria/types";
import { and, asc, desc, eq, getColumns, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { economySchema } from "./migrations.js";
import {
  type Bounty,
  type BountyPatch,
  type BountyStatus,
  type BountyStore,
  type CoinCap,
  type CoinEntry,
  type CoinLedgerStore,
  type CoinPost,
  type CoinRule,
  type DocFilter,
  type DocUpdate,
  type EconomyDoc,
  type EconomyDocStore,
  type FortuneRecord,
  type FortuneStore,
  type LedgerDayTotal,
  PURSE,
} from "./records.js";
import {
  type BountyRow,
  type DocRow,
  economyBounties,
  economyDocs,
  economyFortunes,
  economyLedger,
  economyWallets,
  type FortuneRow,
} from "./schema.js";

/** `limit` as SQLite's `LIMIT`: a negative one is none (the store's `sqlLimit`). */
function limitOf(limit: number): number {
  if (Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER) return limit > 0 ? -1 : 0;
  return Math.max(0, Math.floor(limit));
}

/**
 * The delta a rule lets through: earnings stop at every cap (`partial`: what still fits), `null`
 * when nothing does. `used` sums a cap so far.
 */
export function allowedDelta(
  delta: number,
  rule: CoinRule,
  used: (cap: CoinCap) => number,
): number | null {
  if (delta <= 0) return delta;
  let out = delta;
  for (const cap of rule.caps ?? []) {
    const room = cap.limit - used(cap);
    if (out <= room) continue;
    if (!rule.partial || room <= 0) return null;
    out = room;
  }
  return out;
}

const L = economyLedger;

/** The ledger's rows of the wallet named by placeholder `name`: the person and whom they absorbed. */
function ofWallet(name: string): SQL {
  const w = sql.placeholder(name);
  return sql`${L.person_id} IN (SELECT ${w} UNION ALL SELECT ${persons.id} FROM ${persons} WHERE ${persons.merged_into} = ${w})`;
}

/** `reason IN` the JSON array of placeholder `name`, or any reason when it is `null`. */
function reasonIn(name: string): SQL {
  const list = sql.placeholder(name);
  return sql`(${list} IS NULL OR ${L.reason} IN (SELECT value FROM json_each(${list})))`;
}

const ENTRY = {
  id: L.id,
  person: L.person_id,
  delta: L.delta,
  reason: L.reason,
  ref: L.ref,
  idem_key: L.idem_key,
  ts: L.ts,
};

/** What the ledger's events name as their source. */
export const LEDGER_SOURCE = "economy";

/**
 * The coin ledger and the wallets (`CoinLedgerStore`) on `economy_ledger` and `economy_wallets`.
 * Every row posted is also one `economy.posted` event, appended in the posting's transaction.
 */
export class LedgerTables implements CoinLedgerStore {
  readonly #db: Db;
  readonly #identity: Identity;
  readonly #events: EventStore;
  // The hottest reads, prepared once: every spend and earning runs them in its transaction.
  readonly #balance;
  readonly #byKey;
  readonly #entries;
  readonly #capOf;
  readonly #capAll;

  constructor(db: Db, identity: Identity, events: EventStore) {
    this.#db = db;
    this.#identity = identity;
    this.#events = events;
    const orm = db.orm;
    this.#balance = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(ofWallet("wallet"))
      .prepare();
    this.#byKey = orm
      .select(ENTRY)
      .from(L)
      .where(and(ofWallet("wallet"), eq(L.idem_key, sql.placeholder("key"))))
      .orderBy(asc(L.ts), asc(L.seq))
      .limit(1)
      .prepare();
    this.#entries = orm
      .select(ENTRY)
      .from(L)
      .where(
        and(
          ofWallet("wallet"),
          reasonIn("reasons"),
          sql`(${sql.placeholder("since")} IS NULL OR ${L.ts} >= ${sql.placeholder("since")})`,
        ),
      )
      .orderBy(desc(L.ts), desc(L.seq))
      .limit(sql.placeholder("limit"))
      .prepare();
    const capWhere = and(
      sql`${L.ts} >= ${sql.placeholder("since")}`,
      sql`${L.reason} IN (SELECT value FROM json_each(${sql.placeholder("reasons")}))`,
    );
    this.#capOf = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(and(capWhere, ofWallet("wallet")))
      .prepare();
    this.#capAll = orm
      .select({ n: sql<number>`COALESCE(SUM(${L.delta}), 0)` })
      .from(L)
      .where(capWhere)
      .prepare();
  }

  /**
   * The wallet `person` stands for: the purse, or the person that absorbed it, or itself. An id
   * identity does not know is a wallet of its own, as an account nobody saw was before.
   */
  #wallet(person: PersonId): PersonId {
    if (person === PURSE) return PURSE;
    return this.#identity.person(person)?.id ?? person;
  }

  /** The live person whose choices these are; the purse and an unknown id have none. */
  #person(person: PersonId): PersonId {
    const row = person === PURSE ? null : this.#identity.person(person);
    if (!row) throw new StoreError(`no person \`${person}\` to keep a wallet's choices for`);
    return row.id;
  }

  #sumOf(wallet: PersonId): number {
    this.#db.ensureOpen();
    return Number(this.#balance.get({ wallet })?.n ?? 0);
  }

  #first(wallet: PersonId, key: string): CoinEntry | null {
    this.#db.ensureOpen();
    return this.#byKey.get({ wallet, key }) ?? null;
  }

  #capUsed(cap: CoinCap): number {
    if (cap.reasons.length === 0) return 0;
    const params = { since: toMicros(cap.since), reasons: JSON.stringify(cap.reasons) };
    this.#db.ensureOpen();
    if (cap.wallet === null) return Number(this.#capAll.get(params)?.n ?? 0);
    const wallet = this.#wallet(cap.wallet);
    return Number(this.#capOf.get({ ...params, wallet })?.n ?? 0);
  }

  async post(entry: CoinEntry, rule: CoinRule = {}): Promise<CoinPost> {
    if (!Number.isSafeInteger(entry.delta)) throw new StoreError("a coin delta must be whole");
    try {
      return this.#db.tx((): CoinPost => {
        const wallet = this.#wallet(entry.person);
        if (entry.idem_key !== null) {
          const first = this.#first(wallet, entry.idem_key);
          if (first) return { status: "duplicate", entry: first, balance: this.#sumOf(wallet) };
        }
        const balance = this.#sumOf(wallet);
        const delta = allowedDelta(entry.delta, rule, (cap) => this.#capUsed(cap));
        if (delta === null) return { status: "capped", balance };
        if (rule.covered && balance + delta < 0) return { status: "short", balance };
        const posted: CoinEntry = { ...entry, person: wallet, delta };
        this.#insert(posted, balance);
        return { status: "posted", entry: posted, balance: balance + delta };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  /** One row and its `economy.posted` event; inside a transaction. */
  #insert(posted: CoinEntry, balance: number): void {
    const wallet = posted.person;
    const delta = posted.delta;
    this.#db.orm
      .insert(L)
      .values({
        id: posted.id,
        person_id: wallet,
        delta,
        reason: posted.reason,
        ref: posted.ref,
        idem_key: posted.idem_key,
        ts: posted.ts,
      })
      .run();
    // Its record on the event log, in this transaction: both are written, or neither.
    const data: EconomyPostedData = {
      entry_id: posted.id,
      person_id: wallet,
      delta,
      reason: posted.reason,
      ref: posted.ref,
      idem_key: posted.idem_key,
      balance: balance + delta,
    };
    this.#events.appendNow({
      draft: {
        id: newId(),
        at: posted.ts,
        type: EconomyPosted.type,
        v: EconomyPosted.v,
        person_id: wallet === PURSE ? null : wallet,
        key: `ledger:${posted.id}`,
        data,
      },
      source: LEDGER_SOURCE,
    });
  }

  async postAll(rows: readonly CoinEntry[], rule: { covered?: boolean } = {}): Promise<CoinPost> {
    const first = rows[0];
    if (first === undefined) throw new StoreError("nothing to post");
    for (const r of rows) {
      if (!Number.isSafeInteger(r.delta)) throw new StoreError("a coin delta must be whole");
      if (r.idem_key === null) throw new StoreError("every row of a posting needs its key");
      if (r.person !== first.person) throw new StoreError("one posting is one wallet");
    }
    try {
      return this.#db.tx((): CoinPost => {
        const wallet = this.#wallet(first.person);
        const done = this.#first(wallet, first.idem_key as string);
        if (done) return { status: "duplicate", entry: done, balance: this.#sumOf(wallet) };
        let balance = this.#sumOf(wallet);
        const total = rows.reduce((t, r) => t + r.delta, 0);
        if (rule.covered && balance + total < 0) return { status: "short", balance };
        for (const r of rows) {
          if (r !== first && this.#first(wallet, r.idem_key as string)) {
            throw new StoreError(`a key of the posting is taken: ${r.idem_key}`);
          }
        }
        for (const r of rows) {
          this.#insert({ ...r, person: wallet }, balance);
          balance += r.delta;
        }
        return { status: "posted", entry: { ...first, person: wallet }, balance };
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot write to the coin ledger", { cause });
    }
  }

  async balance(_profile: ProfileId, person: PersonId): Promise<number> {
    return this.#sumOf(this.#wallet(person));
  }

  async entries(
    _profile: ProfileId,
    person: PersonId,
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]> {
    if (filter.reasons?.length === 0) return [];
    this.#db.ensureOpen();
    return this.#entries.all({
      wallet: this.#wallet(person),
      reasons: filter.reasons === undefined ? null : JSON.stringify(filter.reasons),
      since: filter.since === undefined ? null : toMicros(filter.since),
      limit: limitOf(filter.limit),
    });
  }

  async byKey(_profile: ProfileId, person: PersonId, key: string): Promise<CoinEntry | null> {
    return this.#first(this.#wallet(person), key);
  }

  // ---- the wallets ----------------------------------------------------------------------

  /** The persons of a wallet: itself and whom it absorbed. */
  #members(wallet: PersonId): PersonId[] {
    return this.#db.orm
      .select({ id: persons.id })
      .from(persons)
      .where(sql`${persons.id} = ${wallet} OR ${persons.merged_into} = ${wallet}`)
      .all()
      .map((r) => r.id);
  }

  async selectedFrame(_profile: ProfileId, person: PersonId): Promise<string | null> {
    const wallet = this.#wallet(person);
    if (wallet === PURSE) return null;
    const row = this.#db.orm
      .select({ frame: economyWallets.frame })
      .from(economyWallets)
      .where(inArray(economyWallets.person_id, this.#members(wallet)))
      .orderBy(desc(economyWallets.updated_at))
      .limit(1)
      .get();
    return row?.frame ?? null;
  }

  async selectFrame(
    _profile: ProfileId,
    person: PersonId,
    frame: string | null,
    at: Timestamp,
  ): Promise<void> {
    const wallet = this.#person(person);
    this.#db.orm
      .insert(economyWallets)
      .values({ person_id: wallet, frame, updated_at: at })
      .onConflictDoUpdate({ target: economyWallets.person_id, set: { frame, updated_at: at } })
      .run();
  }

  async onBoard(_profile: ProfileId, person: PersonId): Promise<boolean> {
    const wallet = this.#wallet(person);
    if (wallet === PURSE) return true;
    const row = this.#db.orm
      .select({ x: economyWallets.person_id })
      .from(economyWallets)
      .where(
        and(
          eq(economyWallets.off_board, true),
          inArray(economyWallets.person_id, this.#members(wallet)),
        ),
      )
      .limit(1)
      .get();
    return row === undefined;
  }

  async setOnBoard(_profile: ProfileId, person: PersonId, on: boolean): Promise<void> {
    const wallet = this.#person(person);
    // A row made only for the board is the oldest, so it never hides a chosen frame.
    this.#db.tx(() => {
      for (const id of this.#members(wallet)) {
        this.#db.orm
          .insert(economyWallets)
          .values({
            person_id: id,
            frame: null,
            updated_at: "1970-01-01T00:00:00.000Z",
            off_board: !on,
          })
          .onConflictDoUpdate({ target: economyWallets.person_id, set: { off_board: !on } })
          .run();
      }
    });
  }

  async offBoard(_profile: ProfileId, limit: number): Promise<PersonId[]> {
    const live = sql<string>`COALESCE(${persons.merged_into}, ${economyWallets.person_id})`;
    return this.#db.orm
      .selectDistinct({ person: live })
      .from(economyWallets)
      .innerJoin(persons, eq(persons.id, economyWallets.person_id))
      .where(eq(economyWallets.off_board, true))
      .orderBy(live)
      .limit(limitOf(limit))
      .all()
      .map((r) => r.person);
  }

  // ---- totals ---------------------------------------------------------------------------

  async spent(
    _profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ person: PersonId; account: AccountRef | null; spent: number }[]> {
    if (reasons.length === 0) return [];
    // Only a person's rows: what the purse wrote is hers, never a spender's. The account is the
    // person's first, for who they are to her (`EconomyService.member`).
    const r = sql.raw("r");
    const rows = this.#db.orm.all<{
      person: string;
      platform: string | null;
      ext: string | null;
      n: number;
    }>(sql`
      SELECT s.person AS person, a.platform AS platform, a.external_id AS ext, s.n AS n FROM (
        SELECT COALESCE(${persons.merged_into}, ${persons.id}) AS person, -SUM(${L.delta}) AS n
        FROM ${L} JOIN ${persons} ON ${persons.id} = ${L.person_id}
        WHERE ${L.ts} >= ${toMicros(since)} AND ${L.delta} < 0
          AND ${L.reason} IN (SELECT value FROM json_each(${JSON.stringify(reasons)}))
          AND NOT EXISTS (SELECT 1 FROM ${L} AS ${r} WHERE ${r}.reason IN ('refund', 'refund_removed', 'card_refund')
            AND ${r}.ref = ${L.id})
        GROUP BY 1 HAVING SUM(${L.delta}) < 0
      ) s
      LEFT JOIN ${accounts} a ON a.id = (SELECT id FROM ${accounts} WHERE person_id = s.person
        ORDER BY first_seen, platform, external_id LIMIT 1)
      ORDER BY s.n DESC, s.person LIMIT ${limitOf(limit)}`);
    return rows.map((row) => ({
      person: row.person,
      account:
        row.platform === null || row.ext === null ? null : { platform: row.platform, id: row.ext },
      spent: Number(row.n),
    }));
  }

  async dailyTotals(
    _profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]> {
    // Microseconds since the epoch, moved to local time, divided into whole days (ts is positive;
    // the casts keep the division integral however the driver binds a JS number).
    const offset = Math.round(offsetMinutes) * 60_000_000;
    const day = sql`CAST((${L.ts} + CAST(${offset} AS INTEGER)) / 86400000000 AS INTEGER)`;
    const rows = this.#db.orm.all<{
      day: number;
      reason: string;
      positive: number;
      negative: number;
    }>(sql`
      SELECT ${day} AS day, ${L.reason} AS reason,
        COALESCE(SUM(CASE WHEN ${L.delta} > 0 THEN ${L.delta} ELSE 0 END), 0) AS positive,
        COALESCE(-SUM(CASE WHEN ${L.delta} < 0 THEN ${L.delta} ELSE 0 END), 0) AS negative
      FROM ${L} WHERE ${L.ts} >= ${toMicros(since)} GROUP BY 1, 2 ORDER BY 1, 2`);
    return rows.map((r) => ({
      day: Number(r.day),
      reason: String(r.reason),
      positive: Number(r.positive),
      negative: Number(r.negative),
    }));
  }
}

// ---- accounts -------------------------------------------------------------------------------

/** The rows of `refs` that exist, without repeats; an account never seen owns nothing. */
function accountIds(identity: Identity, refs: readonly AccountRef[]): string[] {
  const out = new Set<string>();
  for (const r of refs) {
    const id = identity.account(r)?.id;
    if (id !== undefined) out.add(id);
  }
  return [...out];
}

const accountOf = (platform: string | null, id: string | null): AccountRef | null =>
  platform === null || id === null ? null : { platform, id };

/** The account columns a row names it by, from a join on `accounts` under `alias`. */
function accountColumns(alias: typeof accounts) {
  return { platform: alias.platform, external_id: alias.external_id };
}

// ---- fortunes -------------------------------------------------------------------------------

const F = economyFortunes;

function fortuneOf(row: FortuneRow & { platform: string; external_id: string }): FortuneRecord {
  return {
    id: row.id,
    account: { platform: row.platform, id: row.external_id },
    person: row.person_id,
    day: row.day,
    issued_at: row.issued_at,
    entry: row.entry_id,
    slip: row.slip,
  };
}

/** The fortune slips (`FortuneStore`) on `economy_fortunes`. */
export class FortuneTables implements FortuneStore {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  #select() {
    return this.#db.orm
      .select({ ...getColumns(F), ...accountColumns(accounts) })
      .from(F)
      .innerJoin(accounts, eq(accounts.id, F.account_id));
  }

  async put(record: FortuneRecord, refs: readonly AccountRef[]): Promise<boolean> {
    try {
      return this.#db.tx((): boolean => {
        const account = this.#identity.ensureAccount(record.account);
        const wallet = [...new Set([account.id, ...accountIds(this.#identity, refs)])];
        const taken = this.#db.orm
          .select({ id: F.id })
          .from(F)
          .where(and(eq(F.day, record.day), inArray(F.account_id, wallet)))
          .limit(1)
          .get();
        if (taken) return false;
        this.#db.orm
          .insert(F)
          .values({
            id: record.id,
            account_id: account.id,
            person_id: record.person,
            day: record.day,
            issued_at: record.issued_at,
            entry_id: record.entry,
            slip: record.slip,
          })
          .run();
        return true;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the fortune", { cause });
    }
  }

  async forDay(
    _profile: ProfileId,
    refs: readonly AccountRef[],
    day: number,
  ): Promise<FortuneRecord | null> {
    const ids = accountIds(this.#identity, refs);
    if (ids.length === 0) return null;
    const row = this.#select()
      .where(and(eq(F.day, day), inArray(F.account_id, ids)))
      .orderBy(desc(F.issued_at), sql`${F}.rowid DESC`)
      .limit(1)
      .get();
    return row ? fortuneOf(row) : null;
  }

  async listFor(
    _profile: ProfileId,
    refs: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]> {
    const ids = accountIds(this.#identity, refs);
    if (ids.length === 0) return [];
    return this.#select()
      .where(inArray(F.account_id, ids))
      .orderBy(desc(F.issued_at), sql`${F}.rowid DESC`)
      .limit(limitOf(limit))
      .all()
      .map(fortuneOf);
  }

  async deleteFor(_profile: ProfileId, refs: readonly AccountRef[]): Promise<number> {
    const ids = accountIds(this.#identity, refs);
    if (ids.length === 0) return 0;
    return Number(this.#db.orm.delete(F).where(inArray(F.account_id, ids)).run().changes);
  }
}

/** A row of one of `spaces`, or of no Space (belongs to everyone). */
function inSpaces(column: SQLiteColumn, spaces: readonly string[]): SQL | undefined {
  return spaces.length === 0 ? isNull(column) : or(isNull(column), inArray(column, [...spaces]));
}

// ---- bounties ---------------------------------------------------------------------

const B = economyBounties;

function bountyOf(
  row: BountyRow & { platform: string | null; external_id: string | null },
): Bounty {
  return {
    id: row.id,
    task: row.task,
    reward: row.reward,
    hold: row.hold_entry,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    winner: accountOf(row.platform, row.external_id),
    space: row.space_id,
  };
}

/** Her bounties (`BountyStore`) on `economy_bounties`. */
export class BountyTables implements BountyStore {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  #select() {
    return this.#db.orm
      .select({ ...getColumns(B), ...accountColumns(accounts) })
      .from(B)
      .leftJoin(accounts, eq(accounts.id, B.winner_account_id));
  }

  async create(bounty: Bounty): Promise<void> {
    try {
      this.#db.tx(() => {
        const winner = bounty.winner ? this.#identity.ensureAccount(bounty.winner).id : null;
        this.#db.orm
          .insert(B)
          .values({
            id: bounty.id,
            task: bounty.task,
            reward: bounty.reward,
            hold_entry: bounty.hold,
            status: bounty.status,
            created_at: bounty.created_at,
            expires_at: bounty.expires_at,
            closed_at: bounty.closed_at,
            winner_account_id: winner,
            space_id: bounty.space,
          })
          .run();
      });
    } catch (cause) {
      throw new StoreError("cannot write the bounty", { cause });
    }
  }

  async get(id: string): Promise<Bounty | null> {
    const row = this.#select().where(eq(B.id, id)).get();
    return row ? bountyOf(row) : null;
  }

  async transition(
    id: string,
    from: readonly BountyStatus[],
    patch: BountyPatch,
  ): Promise<boolean> {
    if (from.length === 0) return false;
    return this.#db.tx(() => {
      const set: Partial<typeof B.$inferInsert> = { status: patch.status };
      if (patch.closed_at !== undefined) set.closed_at = patch.closed_at;
      if (patch.winner !== undefined) {
        set.winner_account_id = patch.winner ? this.#identity.ensureAccount(patch.winner).id : null;
      }
      const changed = this.#db.orm
        .update(B)
        .set(set)
        .where(and(eq(B.id, id), inArray(B.status, [...from])))
        .run();
      return changed.changes > 0;
    });
  }

  async list(
    _profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; spaces?: readonly string[]; limit: number },
  ): Promise<Bounty[]> {
    if (filter.statuses?.length === 0) return [];
    return this.#select()
      .where(
        and(
          filter.statuses ? inArray(B.status, [...filter.statuses]) : undefined,
          filter.spaces ? inSpaces(B.space_id, filter.spaces) : undefined,
        ),
      )
      .orderBy(desc(B.created_at), sql`${B}.rowid DESC`)
      .limit(limitOf(filter.limit))
      .all()
      .map(bountyOf);
  }
}

// ---- economy documents ----------------------------------------------------------------------

const X = economyDocs;

function docOf(row: DocRow & { platform: string | null; external_id: string | null }): EconomyDoc {
  return {
    id: row.id,
    kind: row.kind,
    owner: accountOf(row.platform, row.external_id),
    status: row.status,
    version: row.version,
    data: row.data,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.space_id === null ? {} : { space: row.space_id }),
  };
}

/** Economy 2.0's documents (`EconomyDocStore`) on `economy_docs`. */
export class DocTables implements EconomyDocStore {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  #select() {
    return this.#db.orm
      .select({ ...getColumns(X), ...accountColumns(accounts) })
      .from(X)
      .leftJoin(accounts, eq(accounts.id, X.owner_account_id));
  }

  #owner(owner: AccountRef | null): string | null {
    return owner === null ? null : this.#identity.ensureAccount(owner).id;
  }

  async create(doc: EconomyDoc): Promise<boolean> {
    try {
      return this.#db.tx(
        () =>
          this.#db.orm
            .insert(X)
            .values({
              kind: doc.kind,
              id: doc.id,
              owner_account_id: this.#owner(doc.owner),
              status: doc.status,
              version: doc.version,
              data: doc.data,
              created_at: doc.created_at,
              updated_at: doc.updated_at,
              space_id: doc.space ?? null,
            })
            .onConflictDoNothing()
            .run().changes > 0,
      );
    } catch (cause) {
      throw new StoreError("cannot write the economy document", { cause });
    }
  }

  async get(_profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null> {
    const row = this.#select()
      .where(and(eq(X.kind, kind), eq(X.id, id)))
      .get();
    return row ? docOf(row) : null;
  }

  async update(
    _profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean> {
    try {
      return this.#db.tx(() => {
        const set: Partial<typeof X.$inferInsert> = {
          status: next.status,
          data: next.data,
          version: sql`${X.version} + 1` as never,
          updated_at: next.at,
        };
        if (next.owner !== undefined) set.owner_account_id = this.#owner(next.owner);
        const changed = this.#db.orm
          .update(X)
          .set(set)
          .where(and(eq(X.kind, kind), eq(X.id, id), eq(X.version, expected)))
          .run();
        return changed.changes > 0;
      });
    } catch (cause) {
      throw new StoreError("cannot update the economy document", { cause });
    }
  }

  async list(_profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]> {
    if (filter.statuses?.length === 0 || filter.owners?.length === 0) return [];
    const owners = filter.owners ? accountIds(this.#identity, filter.owners) : null;
    if (owners !== null && owners.length === 0) return [];
    return this.#select()
      .where(
        and(
          eq(X.kind, kind),
          filter.statuses ? inArray(X.status, [...filter.statuses]) : undefined,
          owners ? inArray(X.owner_account_id, owners) : undefined,
          filter.spaces ? inSpaces(X.space_id, filter.spaces) : undefined,
        ),
      )
      .orderBy(desc(X.created_at), desc(X.id))
      .limit(limitOf(filter.limit))
      .all()
      .map(docOf);
  }

  async prune(
    _profile: ProfileId,
    kind: string,
    before: Timestamp,
    limit: number,
  ): Promise<number> {
    if (limit <= 0) return 0;
    try {
      return this.#db.tx(() => {
        const old = this.#db.orm
          .select({ id: X.id })
          .from(X)
          .where(and(eq(X.kind, kind), sql`${X.created_at} < ${toMicros(before)}`))
          .orderBy(asc(X.created_at), asc(X.id))
          .limit(limit);
        return Number(
          this.#db.orm
            .delete(X)
            .where(and(eq(X.kind, kind), inArray(X.id, old)))
            .run().changes,
        );
      });
    } catch (cause) {
      throw new StoreError("cannot prune the economy documents", { cause });
    }
  }
}

/** The economy plugin's code over its tables. */
export interface EconomyTables {
  readonly ledger: LedgerTables;
  readonly fortunes: FortuneTables;
  readonly bounties: BountyTables;
  readonly docs: DocTables;
}

/**
 * The economy's parts of the `relationships` category: coins come from being with her, so the
 * wallet goes with the relationship, not with a forget. The whole database's (one character). The
 * ledger is by person (no foreign key); a wallet row goes with its person, and what names an
 * account with the account.
 */
const economyData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("coin_ledger", "economy_ledger", "node", "ts", "seq", {
        id: "text",
        person_id: "text",
        delta: "num",
        reason: "text",
        ref: "text",
        idem_key: "text",
        ts: "ts",
      }),
      tablePart("coin_wallets", "economy_wallets", "node", "updated_at", "person_id", {
        person_id: "text",
        frame: "text",
        off_board: "bool",
        updated_at: "ts",
      }),
      // The fortune slips she wrote for them, kept like their cards.
      tablePart("fortunes", "economy_fortunes", "node", "issued_at", "issued_at, id", {
        id: "text",
        account_id: "text",
        person_id: "text",
        day: "num",
        issued_at: "ts",
        entry_id: "text",
        slip: "json",
      }),
      // The bounties from her purse.
      tablePart("bounties", "economy_bounties", "node", "created_at", "created_at, id", {
        id: "text",
        task: "text",
        reward: "num",
        hold_entry: "text",
        status: "text",
        created_at: "ts",
        expires_at: "ts",
        closed_at: "ts",
        winner_account_id: "text",
        space_id: "text",
      }),
      // Economy 2.0: predictions and bets, her room, and the collectibles of before drawing was removed.
      tablePart("economy_docs", "economy_docs", "node", "updated_at", "created_at, kind, id", {
        kind: "text",
        id: "text",
        owner_account_id: "text",
        status: "text",
        version: "num",
        data: "json",
        created_at: "ts",
        updated_at: "ts",
        space_id: "text",
      }),
    ],
    // Each posting's record (`economy.posted`) goes with the ledger, not with the event log alone.
    keptEvents: `type = '${EconomyPosted.type}'`,
  },
];

/** The `economy` plugin's tables and code (`StorePlugin`). */
export const economyTables: StorePlugin<EconomyTables> = {
  schema: economySchema,
  open: ({ db, events, identity }) => ({
    ledger: new LedgerTables(db, identity, events),
    fortunes: new FortuneTables(db, identity),
    bounties: new BountyTables(db, identity),
    docs: new DocTables(db, identity),
  }),
  data: economyData,
  // Money is kept (v5-data §2.5); the member page deletes their fortune slips itself.
  forgetPerson: () =>
    declined("coins, wallets and bounties are kept; the member page deletes fortune slips"),
  // A wallet is a person with the persons they absorbed (see the top of this file).
  mergePerson: () => declined("a wallet resolves the persons it absorbed when it is read"),
};
