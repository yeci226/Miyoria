// The handle on one `node:sqlite` connection that the store and the migration runner share:
// cached prepared statements, named parameters, a synchronous write transaction (savepoints when
// nested), and Drizzle on the same connection (`orm`) for the tables declared with it.

import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import type { Clock } from "@miyoria/types";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { StoreError } from "./common.js";
import type { Stmt } from "./data.js";

export type Row = Record<string, SQLOutputValue>;
export type Params = Record<string, SQLInputValue>;
/** Drizzle over the store's connection (`Db.orm`). Its queries run synchronously. */
export type Orm = NodeSQLiteDatabase;

/** `$1` placeholders as named `$p1` (`node:sqlite` binds no positional `?1`). */
function numbered(stmt: Stmt): [string, Params] {
  const params: Params = {};
  stmt.params.forEach((value, i) => {
    params[`p${i + 1}`] = value as SQLInputValue;
  });
  return [stmt.sql.replace(/\$(\d+)/g, "$$p$1"), params];
}

/**
 * One connection: cached prepared statements, `$name` parameters, and `tx` for a synchronous
 * `BEGIN IMMEDIATE` transaction.
 */
export class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  readonly clock: Clock;
  #open = true;
  #depth = 0;
  #orm: Orm | null = null;
  /** What `afterCommit` queued in the open transaction. */
  readonly #committed: (() => void)[] = [];

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

  /**
   * Throws a `StoreError` once the store is closed. Prepared Drizzle queries run on their own
   * statements, past `orm`'s check: callers that keep them check here first.
   */
  ensureOpen(): void {
    if (!this.#open) throw new StoreError("the store is closed");
  }

  /** Whether a transaction is open (what it wrote may still be rolled back). */
  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  /**
   * Runs `fn` in one write transaction. `fn` must not await. Inside another `tx` it runs in a
   * savepoint instead: an error rolls back what `fn` wrote and leaves the outer transaction open.
   */
  tx<T>(fn: () => T): T {
    if (this.#db.isTransaction) return this.#savepoint(fn);
    this.#db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#committed.length = 0;
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
    for (const told of this.#committed.splice(0)) told();
    return result;
  }

  #savepoint<T>(fn: () => T): T {
    const name = `tx${++this.#depth}`;
    const queued = this.#committed.length;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#committed.length = queued;
      if (this.#db.isTransaction) this.#db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    } finally {
      this.#depth--;
    }
  }

  /**
   * Runs `fn` once what was just written is committed: at once outside a transaction, after the
   * outermost `tx` commits inside one, and never when that transaction (or the savepoint `fn` was
   * queued in) rolls back. For telling in-memory listeners about a write; `fn` must not throw.
   */
  afterCommit(fn: () => void): void {
    if (this.#db.isTransaction) this.#committed.push(fn);
    else fn();
  }

  /**
   * Drizzle on this same connection: its queries see and join whatever transaction `tx` opened.
   * Use `tx` for transactions, not Drizzle's `transaction()` (it issues its own `BEGIN`).
   */
  get orm(): Orm {
    if (!this.#open) throw new StoreError("the store is closed");
    this.#orm ??= drizzle({ client: this.#db });
    return this.#orm;
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#statements.clear();
    this.#orm = null;
    this.#db.close();
  }
}
