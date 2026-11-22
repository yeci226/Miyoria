// The `cluster` plugin's tables (`schema.ts`): the hosts that joined and the codes to join with
// (docs/design/v5-hostd.md §6.2, §7). They are the install's machines, shared by every profile
// (docs/design/v5-profiles.md §7): on the install's own store (`store.plugin(clusterTables)`), and
// for a profile with a database of its own on that same file opened for them alone
// (`openMachineDatabase`).
//
// A host's key and an invite's code are shown once, when they are made, and only their SHA-256
// is stored. Keys are compared in constant time.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  type Db,
  openPluginDatabase,
  type PluginDatabaseOptions,
  type StorePlugin,
} from "@miyoria/store";
import { type Clock, newId, systemClock, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, asc, eq } from "drizzle-orm";
import type { EstimateRow, EstimateStore } from "./estimates.js";
import { clusterSchema } from "./migrations.js";
import type { PanelControls } from "./registry.js";
import {
  type ClusterHostRow,
  type ControlKind,
  clusterControls,
  clusterEstimates,
  clusterHosts,
  clusterInvites,
  type HostStatus,
} from "./schema.js";

/** A request the cluster refuses: a taken name, an unknown host, a bad code. */
export class ClusterError extends Error {
  override name = "ClusterError";
}

/** A join code that does not work: unknown, used or expired, said the same way for all three. */
export class InviteError extends ClusterError {
  override name = "InviteError";
}

/** A host as the owner and the link see it. The key's hash never leaves the tables. */
export interface HostRecord {
  id: string;
  name: string;
  status: HostStatus;
  /** The capabilities the owner approved it for. */
  capabilities: string[];
  platform: string | null;
  version: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
}

/** A new host, with its key: the only time the key is seen. */
export interface NewHost {
  host: HostRecord;
  key: string;
}

/** A new invite, with its code: the only time the code is seen. */
export interface NewInvite {
  code: string;
  name: string | null;
  expires_at: Timestamp;
}

/** Host names: what `order`, the CLI and the events use. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Invite code letters: no I and no O, which read as 1 and 0. */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** How long an invite works when the caller does not say. */
export const DEFAULT_INVITE_TTL_S = 600;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A host key: 32 random bytes, base64url. */
function newKey(): string {
  return randomBytes(32).toString("base64url");
}

/** `ABCD-1234`. */
function newCode(): string {
  let letters = "";
  for (let i = 0; i < 4; i++) letters += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return `${letters}-${String(randomInt(10_000)).padStart(4, "0")}`;
}

/** The code as it is hashed: what a person typed, trimmed and upper-cased. */
function normalCode(code: string): string {
  return code.trim().toUpperCase();
}

function record(row: ClusterHostRow): HostRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    capabilities: [...row.capabilities],
    platform: row.platform,
    version: row.version,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v !== ""))];
}

/** Compared even for an unknown host, so a wrong id takes as long as a wrong key. */
const NO_HASH = "0".repeat(64);

/** The hosts that joined (`cluster_hosts`). */
export class Hosts {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * Adds a host and returns its key, once. `approved` makes it usable at once for
   * `capabilities` (the owner adding a machine); otherwise it waits for `approve`.
   */
  create(options: { name: string; approved?: boolean; capabilities?: readonly string[] }): NewHost {
    const name = options.name.trim();
    if (!NAME.test(name)) {
      throw new ClusterError(
        `host name \`${options.name}\` must be 1 to 64 letters, digits, dots, dashes or underscores`,
      );
    }
    const key = newKey();
    const id = newId();
    const approved = options.approved ?? false;
    this.#db.tx(() => {
      if (this.#row(name) !== undefined) throw new ClusterError(`a host named \`${name}\` exists`);
      this.#db.orm
        .insert(clusterHosts)
        .values({
          id,
          name,
          key_hash: sha256(key),
          status: approved ? "approved" : "pending",
          capabilities: approved ? unique(options.capabilities ?? []) : [],
          created_at: toTimestamp(this.#clock.now()),
        })
        .run();
    });
    return { host: this.#must(name), key };
  }

  /** Whether `key` is the key of host `id`, and the host is not revoked. Constant time. */
  verify(id: string, key: string): boolean {
    const row = this.#db.orm.select().from(clusterHosts).where(eq(clusterHosts.id, id)).get();
    const expected = Buffer.from(row?.key_hash ?? NO_HASH, "hex");
    const got = Buffer.from(sha256(key), "hex");
    const same = expected.length === got.length && timingSafeEqual(expected, got);
    return same && row !== undefined && row.status !== "revoked";
  }

  /** Approves a pending or approved host for exactly these capabilities. */
  approve(name: string, capabilities: readonly string[]): HostRecord {
    const row = this.#row(name);
    if (row === undefined) throw new ClusterError(`no host named \`${name}\``);
    if (row.status === "revoked") {
      throw new ClusterError(`host \`${name}\` was revoked: it has to join again`);
    }
    this.#db.orm
      .update(clusterHosts)
      .set({ status: "approved", capabilities: unique(capabilities) })
      .where(eq(clusterHosts.id, row.id))
      .run();
    return this.#must(name);
  }

  /** Revokes a host's key: its link is refused from now on. `null` when there is no such host. */
  revoke(name: string): HostRecord | null {
    const row = this.#row(name);
    if (row === undefined) return null;
    this.#db.orm
      .update(clusterHosts)
      .set({ status: "revoked", capabilities: [] })
      .where(eq(clusterHosts.id, row.id))
      .run();
    return this.#must(name);
  }

  /** Deletes a host's row. Returns what it was, `null` when there was none. */
  remove(name: string): HostRecord | null {
    const row = this.#row(name);
    if (row === undefined) return null;
    this.#db.orm.delete(clusterHosts).where(eq(clusterHosts.id, row.id)).run();
    return record(row);
  }

  /** Records a connection: when, and what the host said it runs on. */
  seen(id: string, at: { platform: string; version: string }): void {
    this.#db.orm
      .update(clusterHosts)
      .set({
        platform: at.platform,
        version: at.version,
        last_seen_at: toTimestamp(this.#clock.now()),
      })
      .where(eq(clusterHosts.id, id))
      .run();
  }

  get(id: string): HostRecord | null {
    const row = this.#db.orm.select().from(clusterHosts).where(eq(clusterHosts.id, id)).get();
    return row === undefined ? null : record(row);
  }

  byName(name: string): HostRecord | null {
    const row = this.#row(name);
    return row === undefined ? null : record(row);
  }

  /** Every host, by name. */
  list(): HostRecord[] {
    return this.#db.orm
      .select()
      .from(clusterHosts)
      .orderBy(asc(clusterHosts.name))
      .all()
      .map(record);
  }

  #row(name: string): ClusterHostRow | undefined {
    return this.#db.orm.select().from(clusterHosts).where(eq(clusterHosts.name, name)).get();
  }

  #must(name: string): HostRecord {
    const row = this.#row(name);
    if (row === undefined) throw new ClusterError(`no host named \`${name}\``);
    return record(row);
  }
}

/** One-time join codes (`cluster_invites`). */
export class Invites {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #hosts: Hosts;

  constructor(db: Db, clock: Clock, hosts: Hosts) {
    this.#db = db;
    this.#clock = clock;
    this.#hosts = hosts;
  }

  /** Makes a code that works once within `ttl_s` seconds, and returns it once. */
  invite(options: { name?: string | null; ttl_s?: number; by: string }): NewInvite {
    const ttl = options.ttl_s ?? DEFAULT_INVITE_TTL_S;
    if (!(ttl > 0)) throw new ClusterError("an invite must work for some time");
    const name = options.name?.trim() || null;
    if (name !== null && !NAME.test(name)) {
      throw new ClusterError(`host name \`${options.name}\` is not a valid name`);
    }
    const code = newCode();
    const expires = toTimestamp(this.#clock.now() + ttl * 1000);
    this.#db.orm
      .insert(clusterInvites)
      .values({ code_hash: sha256(code), name, expires_at: expires, created_by: options.by })
      .run();
    return { code, name, expires_at: expires };
  }

  /**
   * Uses a code: creates a pending host called `name` (or the name the invite fixed) and returns
   * its id and key. An unknown, used or expired code fails the same way (`InviteError`); a taken
   * name fails without using the code up.
   */
  redeem(code: string, name: string): NewHost {
    const hash = sha256(normalCode(code));
    const now = this.#clock.now();
    return this.#db.tx(() => {
      const invite = this.#db.orm
        .select()
        .from(clusterInvites)
        .where(eq(clusterInvites.code_hash, hash))
        .get();
      if (invite === undefined || invite.used_at !== null || Date.parse(invite.expires_at) <= now) {
        throw new InviteError("this code does not work: it is unknown, used or expired");
      }
      const wanted = name.trim();
      if (invite.name !== null && wanted !== "" && wanted !== invite.name) {
        throw new ClusterError(`this code is for a host named \`${invite.name}\``);
      }
      const created = this.#hosts.create({ name: invite.name ?? wanted });
      this.#db.orm
        .update(clusterInvites)
        .set({ used_at: toTimestamp(now) })
        .where(eq(clusterInvites.code_hash, hash))
        .run();
      return created;
    });
  }
}

/** What Core measured of each host (`cluster_estimates`, v5-hostd §15.4). */
export class EstimateTable implements EstimateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  load(): EstimateRow[] {
    return this.#db.orm
      .select()
      .from(clusterEstimates)
      .all()
      .map((row) => ({ ...row, updated_at: Date.parse(row.updated_at) }));
  }

  save(row: EstimateRow): void {
    const values = { ...row, updated_at: toTimestamp(row.updated_at) };
    this.#db.orm
      .insert(clusterEstimates)
      .values(values)
      .onConflictDoUpdate({
        target: [clusterEstimates.host, clusterEstimates.capability],
        set: values,
      })
      .run();
  }
}

/** One of the owner's routing controls from the panel. */
export interface ControlRecord {
  kind: ControlKind;
  /** `""` for a host's weight or drain. */
  capability: string;
  host: string;
  value: number | null;
  by: string;
  at: Timestamp;
}

/** The owner's pins, exclusions, weights and drains from the panel (`cluster_controls`, §15.6). */
export class Controls {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  list(): ControlRecord[] {
    return this.#db.orm
      .select()
      .from(clusterControls)
      .orderBy(
        asc(clusterControls.kind),
        asc(clusterControls.capability),
        asc(clusterControls.host),
      )
      .all();
  }

  /** Sets one; a pin replaces the capability's other pin. */
  set(control: {
    kind: ControlKind;
    capability?: string;
    host: string;
    value?: number;
    by: string;
  }): ControlRecord {
    const capability =
      control.kind === "pin" || control.kind === "exclude" ? (control.capability ?? "") : "";
    if ((control.kind === "pin" || control.kind === "exclude") && capability === "") {
      throw new ClusterError(`a ${control.kind} names a capability`);
    }
    if (control.kind === "weight" && !(control.value !== undefined && control.value > 0)) {
      throw new ClusterError("a weight is a number above 0");
    }
    const row = {
      kind: control.kind,
      capability,
      host: control.host,
      value: control.kind === "weight" ? (control.value as number) : null,
      by: control.by,
      at: toTimestamp(this.#clock.now()),
    };
    this.#db.tx(() => {
      if (control.kind === "pin") {
        this.#db.orm
          .delete(clusterControls)
          .where(and(eq(clusterControls.kind, "pin"), eq(clusterControls.capability, capability)))
          .run();
      }
      this.#db.orm
        .insert(clusterControls)
        .values(row)
        .onConflictDoUpdate({
          target: [clusterControls.kind, clusterControls.capability, clusterControls.host],
          set: { value: row.value, by: row.by, at: row.at },
        })
        .run();
    });
    return row;
  }

  /** Removes one; whether it was there. */
  clear(control: { kind: ControlKind; capability?: string; host: string }): boolean {
    const capability =
      control.kind === "pin" || control.kind === "exclude" ? (control.capability ?? "") : "";
    const removed = this.#db.orm
      .delete(clusterControls)
      .where(
        and(
          eq(clusterControls.kind, control.kind),
          eq(clusterControls.capability, capability),
          eq(clusterControls.host, control.host),
        ),
      )
      .returning()
      .all();
    return removed.length > 0;
  }

  /** The controls as the registry takes them. */
  view(): PanelControls {
    const pins: Record<string, string> = {};
    const excludes: Record<string, string[]> = {};
    const weights: Record<string, number> = {};
    const drained: string[] = [];
    for (const c of this.list()) {
      if (c.kind === "pin") pins[c.capability] = c.host;
      else if (c.kind === "exclude")
        excludes[c.capability] = [...(excludes[c.capability] ?? []), c.host];
      else if (c.kind === "weight" && c.value !== null) weights[c.host] = c.value;
      else if (c.kind === "drain") drained.push(c.host);
    }
    return { pins, excludes, weights, drained };
  }
}

/** The `cluster` plugin's code over its tables. */
export class ClusterTables {
  readonly hosts: Hosts;
  readonly invites: Invites;
  readonly estimates: EstimateTable;
  readonly controls: Controls;
  readonly #db: Db;

  constructor(db: Db, clock: Clock = systemClock) {
    this.#db = db;
    this.hosts = new Hosts(db, clock);
    this.invites = new Invites(db, clock, this.hosts);
    this.estimates = new EstimateTable(db);
    this.controls = new Controls(db, clock);
  }

  /** The same tables, with another clock (the module's, a test's). */
  withClock(clock: Clock): ClusterTables {
    return new ClusterTables(this.#db, clock);
  }
}

/** The `cluster` plugin's tables and code (`StorePlugin`). They name machines, not people. */
export const clusterTables: StorePlugin<ClusterTables> = {
  schema: clusterSchema,
  open: ({ db }) => new ClusterTables(db),
};

/** The machines' tables on a database opened for them alone, and how to close it. */
export interface MachineDatabase {
  readonly tables: ClusterTables;
  close(): void;
}

/**
 * Opens the install's machine database at `path` (docs/design/v5-profiles.md §7) for the
 * `cluster` tables only: a new file holds `_migrations` and `cluster_*`, nothing of a character;
 * on the install's own store file only the `cluster` schema is migrated and nothing else is
 * touched.
 */
export function openMachineDatabase(
  path: string,
  options: PluginDatabaseOptions = {},
): MachineDatabase {
  const db = openPluginDatabase(path, [clusterSchema], options);
  return { tables: new ClusterTables(db, options.clock ?? systemClock), close: () => db.close() };
}
