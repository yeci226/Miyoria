// SQLite backend on the built-in `node:sqlite` (`DatabaseSync`). A file database or `:memory:`
// (for tests and quick runs).
//
// Every call is synchronous inside an async method, so one call never interleaves with another
// in this process: read-modify-write sequences run inside one `BEGIN IMMEDIATE` transaction
// without awaiting. Other processes on the same file are handled by WAL and the busy timeout.
//
// Timestamps are INTEGER microseconds since the epoch, JSON values are text. The plugins' tables
// (memory, economy, auth, ...) are their packages' (`plugin.ts`).

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AccountRef,
  type Clock,
  type JsonObject,
  type PersonId,
  type ProfileId,
  systemClock,
  type Timestamp,
} from "@miyoria/types";
import { artifactSchema } from "./artifacts/migrations.js";
import { ArtifactStore } from "./artifacts/store.js";
import { storeRegistry } from "./categories.js";
import {
  fromMicros,
  optionalMicros,
  optionalTimestamp,
  parseJson,
  StoreError,
  sqlLimit,
  toMicros,
  u32,
} from "./common.js";
import {
  type ConfigImportOptions,
  type ConfigImportResult,
  importConfigToml,
} from "./config/import.js";
import { configSchema } from "./config/migrations.js";
import { PersonaOverrides } from "./config/persona.js";
import { PlaceSettings } from "./config/places.js";
import {
  ConfigModuleState,
  ConfigRevisions,
  type ConfigRevisionsOptions,
} from "./config/revisions.js";
import { PluginState, SettingsState } from "./config/state.js";
import {
  addCount,
  type CategoryData,
  type DataCategoryId,
  type DataExport,
  type DataInventory,
  type DataRegistry,
  type SqlDialect,
  type Stmt,
  type WipeCounts,
  type WipeOptions,
} from "./data.js";
import { Db, type Params, type Row } from "./db.js";
import { AuditTrail } from "./events/audit.js";
import { ChatLog } from "./events/chat.js";
import { LlmCallTotals } from "./events/llm.js";
import { EventStore } from "./events/log.js";
import { TurnLog } from "./events/turns.js";
import type { PersonHandleDirectory } from "./handles.js";
import {
  IdentityHandles,
  IdentityLinks,
  IdentityPeople,
  PrefsSettings,
} from "./identity/adapters.js";
import { Identity } from "./identity/identity.js";
import { identitySchema } from "./identity/migrations.js";
import { SpacePlaces } from "./identity/places.js";
import { legacySchema } from "./legacy-schema/index.js";
import {
  checkDatabaseFile,
  migrate,
  orderSchemas,
  type PluginSchema,
  schemaVersions,
} from "./migrate.js";
import { declined, PersonData } from "./person-data.js";
import { type PluginContext, RoutedSettings, type StorePlugin } from "./plugin.js";
import type { MemberCardRecord, Relationship, RelationshipDelta } from "./records.js";
import type {
  IdentityStore,
  MemberCardStore,
  MessageLog,
  PeopleStore,
  PersonaOverrideStore,
  ProfileDataStore,
  RelationshipStore,
  SettingsStore,
  Store,
} from "./stores.js";

export interface SqliteStoreOptions {
  /** Source of "now" for rows stamped by the store (`edited_at`, `first_seen`, ...). */
  clock?: Clock;
  /** How long a write waits for another process's lock. Default 5000 ms. */
  busyTimeoutMs?: number;
  /** Plugin schemas to migrate besides the store's own (`core`, `identity`, `config`, `legacy`). */
  schemas?: readonly PluginSchema[];
  /** Plugins whose tables are migrated at open and whose code is attached (`store.plugin`). */
  plugins?: readonly StorePlugin<unknown>[];
  /**
   * Where the artifact store keeps its bytes. Default: `artifacts` beside a database file; none
   * for `:memory:` (then `artifacts` is `null`).
   */
  artifactRoot?: string | null;
  /** The config revisions' options: Core passes the root config schema as `validate`. */
  config?: ConfigRevisionsOptions;
}

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

const SQLITE_DIALECT: SqlDialect = {
  startsWith: (column, param) => `substr(${column}, 1, length(${param})) = ${param}`,
  jsonText: (column) => column,
  keyOrder: "key",
  list: (values) => JSON.stringify(values),
  bool: (value) => (value ? 1 : 0),
};

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

// ---- whole-profile export / wipe ----------------------------------------------------------

/** Inventory, export and wipe of the categories this store's schemas declare. */
export class SqliteProfileData implements ProfileDataStore {
  /** The store's own declarations and those of the plugins attached so far (`declare`). */
  #registry: DataRegistry = storeRegistry();

  constructor(
    private readonly db: Db,
    private readonly modules: ConfigModuleState,
  ) {}

  #query = async (stmt: Stmt) => this.db.allStmt(stmt);

  /** The categories as the store's schemas and its attached plugins make them up. */
  get registry(): DataRegistry {
    return this.#registry;
  }

  /** The attached plugins' declarations, in the order they were attached. */
  declare(plugins: readonly CategoryData[]): void {
    this.#registry = storeRegistry(plugins);
  }

  async inventory(profile: ProfileId): Promise<DataInventory> {
    const now = fromMicros(this.db.nowMicros());
    return this.#registry.inventory(SQLITE_DIALECT, this.#query, profile, now);
  }

  async export(profile: ProfileId, categories: readonly DataCategoryId[]): Promise<DataExport> {
    const now = fromMicros(this.db.nowMicros());
    return this.#registry.export(SQLITE_DIALECT, this.#query, profile, categories, now);
  }

  async wipe(
    profile: ProfileId,
    categories: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): Promise<WipeCounts> {
    const statements = this.#registry.wipeStatements(SQLITE_DIALECT, profile, categories, options);
    try {
      return this.db.tx(() => {
        const counts: WipeCounts = {};
        for (const step of statements) {
          const n = step.stmt === null ? this.modules.clear("wipe") : this.db.runStmt(step.stmt);
          addCount(counts, step.part, n);
        }
        return counts;
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot wipe the profile data", { cause });
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

// ---- the store ----------------------------------------------------------------------------

/** Every storage area on one SQLite database. */
export class SqliteStore implements Store {
  readonly messages: MessageLog;
  /** Module on/off: the `enabled` flags of the current config revision. */
  readonly moduleState: ConfigModuleState;
  readonly personaOverrides: PersonaOverrideStore;
  readonly people: PeopleStore;
  /** Decisions and turn outcomes on the event log. */
  readonly decisions: TurnLog;
  readonly settings: SettingsStore;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  /** Audit entries on the event log. */
  readonly audit: AuditTrail;
  readonly profileData: SqliteProfileData;
  readonly events: EventStore;
  /** Chat lines on the event log; `messages` is the same object. */
  readonly chat: ChatLog;
  /** LLM calls on the event log, as cost and usage totals. */
  readonly llmCalls: LlmCallTotals;
  readonly cards: MemberCardStore;
  /** Persons, accounts and places (the `identity` plugin's tables). */
  readonly persons: Identity;
  /** Spaces, Rooms and members over `persons` (Core's `PlacesKey`). */
  readonly places: SpacePlaces;
  /** Config revisions, per-place settings and plugin state (the `config` plugin's tables). */
  readonly config: {
    readonly revisions: ConfigRevisions;
    readonly places: PlaceSettings;
    readonly state: PluginState;
  };
  readonly handles: PersonHandleDirectory;
  /** The files she makes (the `artifact` plugin's tables, bytes under the artifact root). */
  readonly artifacts: ArtifactStore | null;
  /** Forgetting and merging people through every schema's hooks (`person-data.ts`). */
  readonly personData: PersonData;
  readonly #db: Db;
  readonly #location: string;
  /** Every schema migrated on this database by this store (the store's own and plugins'). */
  readonly #schemas: PluginSchema[];
  readonly #settings: RoutedSettings;
  readonly #plugins = new Map<string, { plugin: StorePlugin<unknown>; opened: unknown }>();
  /** The attached plugins' data categories, in the order they were attached. */
  readonly #data: CategoryData[] = [];

  private constructor(
    db: Db,
    artifactRoot: string | null,
    schemas: readonly PluginSchema[],
    location: string,
    config: ConfigRevisionsOptions = {},
  ) {
    this.#db = db;
    this.#location = location;
    this.#schemas = [...schemas];
    this.persons = new Identity(db);
    this.places = new SpacePlaces(db, this.persons);
    this.events = new EventStore(db, { identity: this.persons });
    this.artifacts =
      artifactRoot === null ? null : new ArtifactStore(db, this.events, { root: artifactRoot });
    const revisions = new ConfigRevisions(db, this.events, config);
    this.config = {
      revisions,
      places: new PlaceSettings(db, this.events),
      state: new PluginState(db),
    };
    this.moduleState = new ConfigModuleState(db, revisions);
    this.personaOverrides = new PersonaOverrides(db);
    this.people = new IdentityPeople(this.persons);
    this.#settings = new RoutedSettings(new PrefsSettings(new SettingsState(db), this.persons));
    this.settings = this.#settings;
    this.relationships = new SqliteRelationships(db);
    this.identity = new IdentityLinks(this.persons, (keep, absorb) =>
      this.personData.merge(keep, absorb, { source: "identity" }),
    );
    this.handles = new IdentityHandles(this.persons);
    this.profileData = new SqliteProfileData(db, this.moduleState);
    this.chat = new ChatLog(db, this.events, this.persons);
    this.messages = this.chat;
    this.decisions = new TurnLog(db, this.events, this.persons);
    this.audit = new AuditTrail(db, this.events, this.persons);
    this.llmCalls = new LlmCallTotals(db);
    this.cards = new SqliteMemberCards(db);
    this.personData = new PersonData(db, this.events, this.persons, () => [
      "core",
      ...orderSchemas(this.#schemas).map((s) => s.plugin),
    ]);
    this.#ownPersonHooks();
  }

  /** The person hooks of the store's own schemas (`person-data.ts`). */
  #ownPersonHooks(): void {
    const { personData, persons, chat } = this;
    personData.add({
      plugin: "core",
      // What they said keeps its envelope and loses its content: their chat lines and her
      // observations of them, under every id they had.
      forgetPerson: (r) => ({
        counts: {
          lines: r.ids.reduce((n, id) => n + chat.forgetPerson(id, r.reason, r.source), 0),
        },
      }),
      mergePerson: () =>
        declined(
          "events are append-only: the absorbed id stays on its rows and resolves to the kept person",
        ),
    });
    personData.add({
      plugin: "identity",
      forgetPerson: () =>
        declined("the person and their accounts stay unless they ask to unlink (v5-data §2.4)"),
      mergePerson: (r) => {
        const moved = persons.accountsOf(r.absorb).length;
        persons.merge(r.keep, r.absorb);
        return { counts: { persons: 1, accounts: moved } };
      },
    });
    const db = this.#db;
    personData.add({
      plugin: "legacy",
      // The old tables are frozen (the heart migrated them); her old notes on them and the reasons
      // of the old changes are words made of what they said, so they go. The numbers stay.
      forgetPerson: (r) => {
        const ids = { ids: JSON.stringify(r.ids) };
        const among = "person_id IN (SELECT value FROM json_each($ids))";
        return {
          counts: {
            notes: db.run(
              `UPDATE relationships SET notes = '' WHERE ${among} AND notes <> ''`,
              ids,
            ),
            reasons: db.run(
              `UPDATE relationship_deltas SET reason = '' WHERE ${among} AND reason <> ''`,
              ids,
            ),
          },
        };
      },
      mergePerson: () =>
        declined("the old relationship tables are frozen: the heart's rows are merged instead"),
    });
  }

  /**
   * Opens (creating it and its directory if needed) a database file, or `":memory:"` for a
   * fresh in-memory database, and runs pending migrations. A file this build must not migrate
   * (a V4 database, see `migrate.ts`) is refused before anything is written to it.
   */
  static async open(path: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
    const memory = path === ":memory:";
    if (!memory) {
      mkdirSync(dirname(path), { recursive: true });
      checkDatabaseFile(path);
    }
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
      const plugins = options.plugins ?? [];
      const schemas = [
        identitySchema,
        configSchema,
        legacySchema,
        artifactSchema,
        ...(options.schemas ?? []),
        ...plugins.map((p) => p.schema),
      ];
      migrate(db, schemas, { location: path });
      const root = options.artifactRoot ?? (memory ? null : join(dirname(path), "artifacts"));
      const store = new SqliteStore(db, root, schemas, path, options.config);
      for (const plugin of plugins) store.plugin(plugin);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  plugin<T>(plugin: StorePlugin<T>): T {
    const id = plugin.schema.plugin;
    const attached = this.#plugins.get(id);
    if (attached !== undefined) {
      if (attached.plugin !== plugin) {
        throw new StoreError(`another plugin with the schema \`${id}\` is attached already`);
      }
      return attached.opened as T;
    }
    this.#db.ensureOpen();
    if (!this.#schemas.some((s) => s.plugin === id)) {
      migrate(this.#db, [...this.#schemas, plugin.schema], { location: this.#location });
      this.#schemas.push(plugin.schema);
    }
    const ctx: PluginContext = { db: this.#db, events: this.events, identity: this.persons };
    const opened = plugin.open(ctx);
    for (const family of plugin.settings?.(opened) ?? []) this.#settings.route(family);
    if (plugin.data !== undefined) {
      this.#data.push(...plugin.data);
      this.profileData.declare(this.#data);
    }
    const { forgetPerson, mergePerson } = plugin;
    if (forgetPerson !== undefined || mergePerson !== undefined) {
      this.personData.add({
        plugin: id,
        ...(forgetPerson && { forgetPerson: (r) => forgetPerson(opened, r) }),
        ...(mergePerson && { mergePerson: (r) => mergePerson(opened, r) }),
      });
    }
    this.#plugins.set(id, { plugin: plugin as StorePlugin<unknown>, opened });
    return opened;
  }

  /**
   * Imports the text of `miyoria.toml` as the next config revision, merged with the panel's keys,
   * its per-channel levels and per-server channels as place settings (`config/import.ts`). For
   * `miyoria config import`, by hand; again only with `replace`.
   */
  importConfig(text: string, options: ConfigImportOptions = {}): ConfigImportResult {
    const { revisions, places } = this.config;
    return importConfigToml(
      { db: this.#db, revisions, places, identity: this.persons },
      text,
      options,
    );
  }

  /** Versions of the `legacy` schema recorded in `_migrations`, ascending. */
  async schemaVersions(): Promise<number[]> {
    return schemaVersions(this.#db, legacySchema.plugin);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
