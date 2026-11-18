// Config revisions (docs/design/v5-data.md §6): the cluster config as numbered, whole documents.
// The current config is the highest version; a change is the next revision, never an edit, so
// every earlier config stays readable and two can be compared. Each revision commits a
// `config.revised` event (owner, kept) naming who wrote it and the paths that changed.
//
// Applying a revision is writing it: "live reload is the next revision". The TOML file stays what
// Core reads at start until the cut-over (§7) switches it to the current revision, so nothing
// here reloads modules. A document is a JSON object as the TOML file holds it, env references
// (`${NAME}`) unexpanded; secrets never go in (§6). A caller may pass a `validate` hook: Core
// passes the root schema of the whole file (`@miyoria/core` `validateRevision`).
//
// Module on/off is the `enabled` flag of `modules.<id>` in the current revision (§6: "one place
// for is it on"); Core's boot reads it through `ConfigModuleState` (`Store.moduleState`).

import { JsonObjectSchema } from "@miyoria/contracts/wire";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModuleId,
  newId,
  toTimestamp,
} from "@miyoria/types";
import { desc, eq, sql } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { EventStore } from "../events/log.js";
import { ConfigRevised } from "../events/types.js";
import { type ConfigRevisionRow, configRevisions } from "./schema.js";

/** One version of the cluster config. */
export type ConfigRevision = ConfigRevisionRow;

/** Where config changes are stamped from in the event log. */
export const CONFIG_SOURCE = "config";

/** The revision a write expected to replace is not the current one any more. */
export class ConfigConflictError extends StoreError {
  readonly expected: number;
  readonly current: number;

  constructor(expected: number, current: number) {
    super(`config revision ${current} is current, not ${expected}: reload and apply again`);
    this.expected = expected;
    this.current = current;
  }
}

export interface ConfigWriteOptions {
  note?: string | null;
  /**
   * The version the writer started from (`0`: none yet). When given and another revision was
   * written since, nothing is written and a `ConfigConflictError` is thrown.
   */
  expected?: number;
}

export interface ConfigRevisionsOptions {
  /** Checks (and may normalise) a document before it is written; throws to refuse it. */
  validate?: (doc: JsonObject) => JsonObject;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function pathOf(parent: string, key: string): string {
  const part = BARE_KEY.test(key) ? key : JSON.stringify(key);
  return parent === "" ? part : `${parent}.${part}`;
}

/**
 * The paths whose value differs between `before` and `after`, sorted: objects are compared key by
 * key (key order does not matter), anything else whole. Keys that are not bare TOML keys are
 * quoted: `modules."platform.discord.bot".enabled`.
 */
export function changedPaths(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  parent = "",
): string[] {
  // A whole document against none: every top-level key is new.
  if (parent === "" && before === undefined) return changedPaths({}, after, parent);
  if (parent === "" && after === undefined) return changedPaths(before, {}, parent);
  if (isJsonObject(before ?? null) && isJsonObject(after ?? null)) {
    const a = before as JsonObject;
    const b = after as JsonObject;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys
      .flatMap((k) => changedPaths(a[k], b[k], pathOf(parent, k)))
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }
  if (before === undefined && after === undefined) return [];
  if (before !== undefined && after !== undefined && same(before, after)) return [];
  return [parent];
}

function same(a: JsonValue, b: JsonValue): boolean {
  if (isJsonObject(a) && isJsonObject(b)) return changedPaths(a, b).length === 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i] as JsonValue));
  }
  return a === b;
}

/** The cluster config's revisions on one database. */
export class ConfigRevisions {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #validate: ((doc: JsonObject) => JsonObject) | null;
  readonly #current;
  readonly #byVersion;

  constructor(db: Db, events: EventStore, options: ConfigRevisionsOptions = {}) {
    this.#db = db;
    this.#events = events;
    this.#validate = options.validate ?? null;
    const orm = db.orm;
    this.#current = orm
      .select()
      .from(configRevisions)
      .orderBy(desc(configRevisions.version))
      .limit(1)
      .prepare();
    this.#byVersion = orm
      .select()
      .from(configRevisions)
      .where(eq(configRevisions.version, sql.placeholder("version")))
      .prepare();
  }

  /** The current config: the highest version. `null` before the first revision. */
  current(): ConfigRevision | null {
    this.#db.ensureOpen();
    return this.#current.get() ?? null;
  }

  get(version: number): ConfigRevision | null {
    this.#db.ensureOpen();
    return this.#byVersion.get({ version }) ?? null;
  }

  /** Revisions, newest first; at most `limit` when given. */
  history(limit?: number): ConfigRevision[] {
    const query = this.#db.orm
      .select()
      .from(configRevisions)
      .orderBy(desc(configRevisions.version));
    return limit === undefined ? query.all() : query.limit(Math.max(0, limit)).all();
  }

  /**
   * Writes `doc` as the next revision and returns it. A document equal to the current one writes
   * nothing and returns the current revision. Throws a `StoreError` for a document that is not a
   * JSON object (or that `validate` refuses), and a `ConfigConflictError` when `expected` is not
   * the current version.
   */
  write(doc: JsonObject, by: string, options: ConfigWriteOptions = {}): ConfigRevision {
    const parsed = JsonObjectSchema.safeParse(doc);
    if (!parsed.success) throw new StoreError("a config revision must be a JSON object");
    if (by.trim() === "") throw new StoreError("a config revision needs its author");
    const checked = this.#validate === null ? parsed.data : this.#validate(parsed.data);
    return this.#db.tx(() => {
      const current = this.current();
      const version = current?.version ?? 0;
      if (options.expected !== undefined && options.expected !== version) {
        throw new ConfigConflictError(options.expected, version);
      }
      const changed = changedPaths(current?.doc, checked);
      if (current !== null && changed.length === 0) return current;
      const at = toTimestamp(this.#db.clock.now());
      const row = this.#db.orm
        .insert(configRevisions)
        .values({
          version: version + 1,
          doc: checked,
          created_at: at,
          created_by: by,
          note: options.note ?? null,
        })
        .returning()
        .get();
      this.#events.appendNow({
        draft: {
          id: newId(),
          at,
          type: ConfigRevised.type,
          v: ConfigRevised.v,
          data: { version: row.version, created_by: by, note: row.note, changed },
        },
        source: CONFIG_SOURCE,
      });
      return row;
    });
  }

  /** Writes revision `version`'s document again, as the next revision. */
  revert(version: number, by: string): ConfigRevision {
    return this.#db.tx(() => {
      const old = this.get(version);
      if (old === null) throw new StoreError(`there is no config revision ${version}`);
      return this.write(old.doc, by, { note: `revert to ${version}` });
    });
  }
}

/** The modules section of a document, as an object (a missing or malformed one is empty). */
function modulesOf(doc: JsonObject | undefined): JsonObject {
  const modules = doc?.modules;
  return isJsonObject(modules ?? null) ? (modules as JsonObject) : {};
}

/** Every module's `enabled` flag in a document, by module id in order. */
export function moduleFlags(doc: JsonObject | undefined): Map<ModuleId, boolean> {
  const out: [ModuleId, boolean][] = [];
  for (const [id, section] of Object.entries(modulesOf(doc))) {
    if (!isJsonObject(section)) continue;
    const enabled = section.enabled;
    if (typeof enabled === "boolean") out.push([id, enabled]);
  }
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(out);
}

/** Who writes the revisions a runtime toggle makes. */
export const MODULE_TOGGLE_AUTHOR = "runtime";

/**
 * Module on/off over the config revisions: a module's remembered on/off is the `enabled`
 * flag of `modules.<id>` in the current revision, and a toggle writes the next revision. Setting
 * the value it already has writes nothing. Core's boot decides what to follow (a required
 * module's flag is not).
 */
export class ConfigModuleState {
  readonly #db: Db;
  readonly #revisions: ConfigRevisions;

  constructor(db: Db, revisions: ConfigRevisions) {
    this.#db = db;
    this.#revisions = revisions;
  }

  /** The revisions the flags live in; Core's settings layer writes the rest of a module's section. */
  get revisions(): ConfigRevisions {
    return this.#revisions;
  }

  /** `null` when the flag was never set (the config default applies). */
  async get(module: ModuleId): Promise<boolean | null> {
    return moduleFlags(this.#revisions.current()?.doc).get(module) ?? null;
  }

  async set(module: ModuleId, enabled: boolean): Promise<void> {
    this.#db.tx(() => {
      const doc = structuredClone(this.#revisions.current()?.doc ?? {});
      const modules = modulesOf(doc);
      const section = modules[module];
      if (isJsonObject(section ?? null) && (section as JsonObject).enabled === enabled) return;
      modules[module] = {
        ...(isJsonObject(section ?? null) ? (section as JsonObject) : {}),
        enabled,
      };
      doc.modules = modules;
      this.#revisions.write(doc, MODULE_TOGGLE_AUTHOR, {
        note: `module ${module} ${enabled ? "on" : "off"}`,
      });
    });
  }

  async list(): Promise<Map<ModuleId, boolean>> {
    return moduleFlags(this.#revisions.current()?.doc);
  }

  /**
   * Removes every module's `enabled` flag (the data page's `module_state` wipe) in one revision
   * written by `by`; returns how many there were.
   */
  clear(by: string): number {
    return this.#db.tx(() => {
      const current = this.#revisions.current();
      const flags = moduleFlags(current?.doc);
      if (current === null || flags.size === 0) return 0;
      const doc = structuredClone(current.doc);
      const modules = modulesOf(doc);
      for (const id of flags.keys()) {
        const { enabled: _, ...rest } = modules[id] as JsonObject;
        modules[id] = rest;
      }
      doc.modules = modules;
      this.#revisions.write(doc, by, { note: "module on/off flags cleared" });
      return flags.size;
    });
  }
}
