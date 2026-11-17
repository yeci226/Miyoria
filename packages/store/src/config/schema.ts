// The tables of the `config` plugin (docs/design/v5-data.md §6), as Drizzle definitions.
//
// - `config_revisions`: the cluster config, one whole JSON document per version; the current one
//   is the highest version, and nothing is ever rewritten.
// - `place_settings`: per Space and per Room overrides, one JSON value per (plugin, key), resolved
//   room, then space, then the cluster config, then the schema default.
// - `plugin_state`: each plugin's small persistent state, one JSON value per (plugin, key).
// - `config_persona_overrides`: the edits of her persona sections made at runtime (the panel),
//   every version kept; the latest version of a section is the one in force.
//
// Like identity's, these tables carry no prefix: `config` is a core plugin that always runs, right
// after identity (§3.1), and `plugin_state` holds every plugin's rows. `migrations.ts` holds the
// SQL drizzle-kit generates from them, `STRICT` added; the drift test keeps the two together.

import type { JsonObject, JsonValue } from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { micros } from "../orm.js";

export const PLACE_SCOPES = ["space", "room"] as const;
/** What a place setting is attached to: a space (`spaces.id`) or a room (`rooms.id`). */
export type PlaceScope = (typeof PLACE_SCOPES)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

/** One version of the cluster config. */
export const configRevisions = sqliteTable("config_revisions", {
  /** 1, 2, 3, ...: never reused. */
  version: integer().primaryKey(),
  /** The whole cluster config, as the TOML file holds it (env references unexpanded). */
  doc: text({ mode: "json" }).$type<JsonObject>().notNull(),
  created_at: micros().notNull(),
  /** `import`, `runtime`, `cli`, `panel:<person>`, ... */
  created_by: text().notNull(),
  note: text(),
});

/** A per-place override of one plugin's setting. */
export const placeSettings = sqliteTable(
  "place_settings",
  {
    scope: text({ enum: PLACE_SCOPES }).notNull(),
    /** `spaces.id` or `rooms.id`, by `scope`. */
    scope_id: text().notNull(),
    plugin: text().notNull(),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<JsonValue>().notNull(),
    updated_at: micros().notNull(),
    updated_by: text().notNull(),
  },
  (t) => [
    primaryKey({ name: "place_settings_pk", columns: [t.scope, t.scope_id, t.plugin, t.key] }),
    check("place_settings_scope_check", sql`${t.scope} IN (${oneOf(PLACE_SCOPES)})`),
  ],
);

/** One plugin's small persistent value; collections need a table of their own. */
export const pluginState = sqliteTable(
  "plugin_state",
  {
    plugin: text().notNull(),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<JsonValue>().notNull(),
    /** The version of the value's shape, for the owner's parser. */
    v: integer().notNull().default(1),
    updated_at: micros().notNull(),
  },
  (t) => [primaryKey({ name: "plugin_state_pk", columns: [t.plugin, t.key] })],
);

/** One version of one persona section, as edited at runtime. */
export const configPersonaOverrides = sqliteTable(
  "config_persona_overrides",
  {
    /** The persona section, e.g. `identity` or `style`. */
    section_key: text().notNull(),
    /** 1, 2, 3, ... per section. */
    version: integer().notNull(),
    body: text().notNull(),
    /** Who made the edit, e.g. `panel:owen` or `discord:1234`. */
    edited_by: text().notNull(),
    edited_at: micros().notNull(),
  },
  (t) => [primaryKey({ name: "config_persona_overrides_pk", columns: [t.section_key, t.version] })],
);

export type ConfigRevisionRow = typeof configRevisions.$inferSelect;
export type PlaceSettingRow = typeof placeSettings.$inferSelect;
export type PluginStateRow = typeof pluginState.$inferSelect;
