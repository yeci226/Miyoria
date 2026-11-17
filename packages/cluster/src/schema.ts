// The tables of the `cluster` plugin (docs/design/v5-hostd.md §6.2), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added.
//
// - `cluster_hosts`: the machines that joined. A host proves who it is with a key Core gave it
//   once; only the key's SHA-256 is kept. `capabilities` is what the owner approved it for,
//   whatever it reports.
// - `cluster_invites`: one-time join codes, kept hashed.
//
// Live endpoints are not here: they are rebuilt from the next `host.report` after a restart.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export type ClusterHostRow = typeof clusterHosts.$inferSelect;
export type ClusterInviteRow = typeof clusterInvites.$inferSelect;
