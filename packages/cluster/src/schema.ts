// The tables of the `cluster` plugin (docs/design/v5-hostd.md §6.2), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added.
//
// - `cluster_hosts`: the machines that joined. A host proves who it is with a key Core gave it
//   once; only the key's SHA-256 is kept. `capabilities` is what the owner approved it for,
//   whatever it reports.
// - `cluster_invites`: one-time join codes, kept hashed.
// - `cluster_estimates`: what Core measured of each host per capability (a unit's time, the
//   transfer rate) and of each capability (a unit's result size, host `*`), v5-hostd §15.4.
// - `cluster_controls`: the owner's pins, exclusions, weights and drains from the panel (§15.6).
//
// Live endpoints are not here: they are rebuilt from the next `host.report` after a restart.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const HOST_STATUSES = ["pending", "approved", "revoked"] as const;
/** `pending`: joined, not approved yet. `revoked`: its key no longer works. */
export type HostStatus = (typeof HOST_STATUSES)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const clusterHosts = sqliteTable(
  "cluster_hosts",
  {
    /** What its hostd sends in `hello` as `host`. */
    id: text().primaryKey(),
    /** Unique; what the owner, the order lists and the events call it. */
    name: text().notNull(),
    /** Hex SHA-256 of the 32-byte key. */
    key_hash: text().notNull(),
    status: text({ enum: HOST_STATUSES }).notNull(),
    /** The approved capability names. */
    capabilities: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    /** From its last `hello`. */
    platform: text(),
    version: text(),
    created_at: micros().notNull(),
    last_seen_at: micros(),
  },
  (t) => [
    uniqueIndex("cluster_hosts_name_idx").on(t.name),
    check("cluster_hosts_status_check", sql`${t.status} IN (${oneOf(HOST_STATUSES)})`),
  ],
);

export const clusterInvites = sqliteTable(
  "cluster_invites",
  {
    /** Hex SHA-256 of the code, as typed (upper case, with its dash). */
    code_hash: text().primaryKey(),
    /** The name the host will get, when the invite fixed one. */
    name: text(),
    expires_at: micros().notNull(),
    used_at: micros(),
    /** Who made it (`principalActor`, `admin`, `cli`). */
    created_by: text().notNull(),
  },
  (t) => [index("cluster_invites_expires_idx").on(t.expires_at)],
);

export const clusterEstimates = sqliteTable(
  "cluster_estimates",
  {
    /** A host name, or `*` for the capability's own numbers. */
    host: text().notNull(),
    capability: text().notNull(),
    /** Decayed averages; null before the first sample. */
    unit_ms: real(),
    unit_n: integer().notNull().default(0),
    rate_bps: real(),
    rate_n: integer().notNull().default(0),
    size_bytes: real(),
    size_n: integer().notNull().default(0),
    updated_at: micros().notNull(),
  },
  (t) => [primaryKey({ name: "cluster_estimates_pk", columns: [t.host, t.capability] })],
);

export const CONTROL_KINDS = ["pin", "exclude", "weight", "drain"] as const;
/** `pin` and `exclude` name a capability; `weight` and `drain` are a host's (capability `""`). */
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const clusterControls = sqliteTable(
  "cluster_controls",
  {
    kind: text({ enum: CONTROL_KINDS }).notNull(),
    capability: text().notNull().default(""),
    host: text().notNull(),
    /** A weight's value; null for the others. */
    value: real(),
    /** Who set it (`principalActor`). */
    by: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "cluster_controls_pk", columns: [t.kind, t.capability, t.host] }),
    check("cluster_controls_kind_check", sql`${t.kind} IN (${oneOf(CONTROL_KINDS)})`),
  ],
);

export type ClusterHostRow = typeof clusterHosts.$inferSelect;
export type ClusterInviteRow = typeof clusterInvites.$inferSelect;
export type ClusterEstimateRow = typeof clusterEstimates.$inferSelect;
export type ClusterControlRow = typeof clusterControls.$inferSelect;
