// Each module's settings and its card on the system page (docs/design/v5-settings.md §3, §6): the
// fields the panel may change (read from the module's schema by Core), their values and where each
// comes from, a save that restarts the module, the history of the module's panel edits and a
// revert, the card's facts and quick actions, and the rooms the channel picker offers.
//
// Who may: reading needs panel access like every admin route; a save or a revert also needs
// `admin.settings.<module id>` (owner and admin hold it through `*` / `admin.*`; give a moderator
// one module with that node), which the server checks per module.

import { z } from "zod";
import { JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { ModuleInfoSchema, ModuleStateKindSchema } from "./core.js";
import { route } from "./route.js";
import { DigitsQuery, SpaceQuery } from "./shared.js";

/** How a field is drawn (`role`, `person`, `multi` and `rows` are declared for later steps). */
export const SettingKindSchema = z
  .enum([
    "switch",
    "number",
    "text",
    "select",
    "multi",
    "channel",
    "role",
    "person",
    "time",
    "weekday",
    "duration",
    "coins",
    "ratio",
    "rows",
  ])
  .meta({ id: "ApiSettingKind" });
export type SettingKind = z.output<typeof SettingKindSchema>;

export const SettingGroupSchema = z
  .object({ id: z.string(), label: z.string() })
  .meta({ id: "ApiSettingGroup" });
export type SettingGroup = z.output<typeof SettingGroupSchema>;

/** One field the panel may draw. Limits, options and the default come from the module's schema. */
export const SettingFieldSchema = z
  .object({
    /** Dotted, relative to the module's section: `rewards.coins_per_point`. */
    path: z.string(),
    keys: z.array(z.string()),
    kind: SettingKindSchema,
    label: z.string(),
    help: z.string().nullable(),
    group: z.string().nullable(),
    order: z.number(),
    /** `module`: saving restarts the module; `core`: it takes a restart of Core. */
    apply: z.enum(["module", "core"]),
    /** Why changing it is dangerous (the panel asks first). */
    danger: z.string().nullable(),
    secret: z.boolean(),
    /** `space` / `room`: may differ per server / per room (docs/design/v5-places.md). */
    scope: z.enum(["cluster", "space", "room"]),
    /** How a place's value meets the ones above it: the nearest wins, or a list takes them all. */
    merge: z.enum(["replace", "union"]),
    unit: z.enum(["ms", "s", "min", "h", "day"]).nullable(),
    labels: z.record(z.string(), z.string()).nullable(),
    room: z.enum(["text", "voice", "thread"]).nullable(),
    multiple: z.boolean(),
    /** What a channel field stores: a bare id, or a context key. */
    ref: z.enum(["id", "context"]),
    min: z.number().nullable(),
    max: z.number().nullable(),
    step: z.number().nullable(),
    int: z.boolean(),
    max_length: z.number().nullable(),
    pattern: z.string().nullable(),
    options: z.array(z.string()).nullable(),
    slider: z.boolean(),
    long: z.boolean(),
    default: JsonValueSchema.nullable(),
  })
  .meta({ id: "ApiSettingField" });
export type SettingField = z.output<typeof SettingFieldSchema>;

/**
 * Where a value comes from: the schema default, the file, the database's cluster layer (`panel`,
 * while it differs from the file), or a place's own value (`space`, `room`).
 */
export const SettingSourceSchema = z
  .enum(["default", "file", "panel", "space", "room"])
  .meta({ id: "ApiSettingSource" });
export type SettingSource = z.output<typeof SettingSourceSchema>;

/** A field's value at a place: the place's own value and what clearing it returns to. */
export const SettingPlaceValueSchema = z
  .object({
    own: JsonValueSchema.nullable(),
    own_set: z.boolean(),
    inherited: JsonValueSchema.nullable(),
    inherited_from: SettingSourceSchema,
  })
  .meta({ id: "ApiSettingPlaceValue" });
export type SettingPlaceValue = z.output<typeof SettingPlaceValueSchema>;

/** A field's value, and where it comes from. */
export const SettingValueSchema = z
  .object({
    /** What the module runs with; `null` for a secret. */
    value: JsonValueSchema.nullable(),
    source: SettingSourceSchema,
    /** What `miyoria.toml` says (`null`: it does not set the key, or a secret). */
    file: JsonValueSchema.nullable(),
    file_set: z.boolean(),
    /** A secret: whether it has a value. */
    set: z.boolean(),
    env: z.string().nullable(),
    /** The panel's value no longer fits the schema and is skipped, with why. */
    invalid: z.string().nullable(),
    /** Read for a place, a field that may differ there: its own value and what it inherits. */
    place: SettingPlaceValueSchema.nullable().optional(),
  })
  .meta({ id: "ApiSettingValue" });
export type SettingValue = z.output<typeof SettingValueSchema>;

/** The place a view was read for: a Space, and one of its rooms by channel id. */
export const SettingsPlaceViewSchema = z
  .object({
    space: z.object({ id: z.string(), name: z.string() }),
    room: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  })
  .meta({ id: "ApiSettingsPlaceView" });
export type SettingsPlaceView = z.output<typeof SettingsPlaceViewSchema>;

/**
 * `?space=&room=` of the settings routes: a Space (identity's id) and optionally one of its rooms
 * (the platform's channel id). Without `space` the routes are about the whole cluster.
 */
export const SettingsPlaceQuery = z.object({
  ...SpaceQuery.shape,
  room: z.string().min(1).max(64).optional(),
});

/** `GET /api/modules/{id}/settings`. */
export const ModuleSettingsSchema = z
  .object({
    module: z.string(),
    name: z.string(),
    /** The config revision the values were read at; a save names it as `expected`. */
    revision: z.number(),
    groups: z.array(SettingGroupSchema),
    fields: z.array(SettingFieldSchema),
    values: z.record(z.string(), SettingValueSchema),
    updated: z
      .object({ version: z.number(), at: TimestampSchema, by: z.string(), by_label: z.string() })
      .nullable(),
    /** A save now would wait for this guarded state (`singing`, `live`) before restarting. */
    guard: z.string().nullable(),
    /** A saved change waits for this guarded state. */
    pending: z.string().nullable(),
    /** The caller may save (`admin.settings.<id>` and write access; for a place, there). */
    can_edit: z.boolean(),
    /** The coins' name, for `coins` fields. */
    currency: z.string(),
    /** The place asked for (`?space=&room=`); `null`: the whole cluster. */
    place: SettingsPlaceViewSchema.nullable().optional(),
  })
  .meta({ id: "ApiModuleSettings" });
export type ModuleSettings = z.output<typeof ModuleSettingsSchema>;

/** `PUT /api/modules/{id}/settings`. */
export const SaveSettingsRequestSchema = z
  .object({
    expected: z.number().int().min(0),
    set: z.record(z.string(), JsonValueSchema).default({}),
    reset: z.array(z.string()).default([]),
    note: z.string().max(200).nullable().optional(),
  })
  .meta({ id: "ApiSaveSettingsRequest" });
export type SaveSettingsRequest = z.input<typeof SaveSettingsRequestSchema>;

/**
 * What a save did: `restarted` the module with it, `deferred` the restart until a guarded state
 * ends, `stored` it for a module that is off, found it `unchanged`, or (a place's values) put it
 * in effect at once without a restart (`immediate`).
 */
export const SaveSettingsResultSchema = z
  .object({
    revision: z.number(),
    applied: z.enum(["restarted", "deferred", "stored", "unchanged", "immediate"]),
    state: ModuleStateKindSchema,
    reason: z.string().nullable(),
  })
  .meta({ id: "ApiSaveSettingsResult" });
export type SaveSettingsResult = z.output<typeof SaveSettingsResultSchema>;

/** A refused save (400): one problem per field, in zh-TW, after the field's label. */
export const SettingProblemSchema = z
  .object({ path: z.string(), message: z.string() })
  .meta({ id: "ApiSettingProblem" });
export type SettingProblem = z.output<typeof SettingProblemSchema>;

export const SettingsChangeSchema = z
  .object({
    version: z.number(),
    at: TimestampSchema,
    by: z.string(),
    /** Who, in words: the person's name, 管理 token, CLI, ... */
    by_label: z.string(),
    note: z.string().nullable(),
    changes: z.array(
      z.object({
        path: z.string(),
        label: z.string(),
        before: JsonValueSchema.nullable(),
        after: JsonValueSchema.nullable(),
      }),
    ),
    /** A place's change: the Space's own value, or a room's (channel id and name). */
    place: z
      .object({
        scope: z.enum(["space", "room"]),
        room: z.string().nullable(),
        name: z.string().nullable(),
      })
      .nullable()
      .optional(),
  })
  .meta({ id: "ApiSettingsChange" });
export type SettingsChange = z.output<typeof SettingsChangeSchema>;

export const SettingsHistorySchema = z
  .object({ items: z.array(SettingsChangeSchema), next_before: z.number().nullable() })
  .meta({ id: "ApiSettingsHistory" });
export type SettingsHistory = z.output<typeof SettingsHistorySchema>;

/** `POST /api/modules/{id}/settings/revert`: the module's panel settings as of `version` (0: none). */
export const RevertSettingsRequestSchema = z
  .object({ version: z.number().int().min(0), expected: z.number().int().min(0) })
  .meta({ id: "ApiRevertSettingsRequest" });
export type RevertSettingsRequest = z.output<typeof RevertSettingsRequestSchema>;

// ---- the card --------------------------------------------------------------------------------

/** `GET /api/modules/{id}`: one module with its card and what it depends on. */
export const ModuleDetailSchema = z
  .object({
    ...ModuleInfoSchema.shape,
    required: z.boolean(),
    requires: z.array(z.string()),
    optional: z.array(z.string()),
    /** Modules a restart of this one stops too. */
    dependents: z.array(z.string()),
  })
  .meta({ id: "ApiModuleDetail" });
export type ModuleDetail = z.output<typeof ModuleDetailSchema>;

/** A quick action's answer. */
export const ModuleActionResultSchema = z
  .object({ text: z.string() })
  .meta({ id: "ApiModuleActionResult" });
export type ModuleActionResult = z.output<typeof ModuleActionResultSchema>;

// ---- places ----------------------------------------------------------------------------------

export const PlaceRoomSchema = z
  .object({
    platform: z.string(),
    id: z.string(),
    context: z.string(),
    name: z.string(),
    kind: z.enum(["text", "voice", "thread"]),
    space: z.object({ id: z.string(), name: z.string() }),
    category: z.object({ id: z.string(), name: z.string() }).nullable(),
    position: z.number(),
    usable: z.boolean(),
    reason: z.string().nullable(),
  })
  .meta({ id: "ApiPlaceRoom" });
export type PlaceRoom = z.output<typeof PlaceRoomSchema>;

/** `GET /api/places/rooms`: `ready` is false while no platform is connected (the list is empty). */
export const PlaceRoomsSchema = z
  .object({ ready: z.boolean(), rooms: z.array(PlaceRoomSchema) })
  .meta({ id: "ApiPlaceRooms" });
export type PlaceRooms = z.output<typeof PlaceRoomsSchema>;

const ModuleParams = z.object({ id: z.string() });

/**
 * The module routes this file adds. They come before `POST /api/modules/{id}/{action}` in the
 * table, so `/api/modules/{id}/settings` is matched as itself.
 */
export const moduleSettings = {
  /** One module: status, card, dependencies. 404 for an unknown id. */
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/modules/{id}" })
    .input(z.object({ params: ModuleParams }))
    .output(ModuleDetailSchema),
  /** With `?space=` (and `room=`): the values there. 404 for a Space she is not in. */
  settings: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/modules/{id}/settings" })
    .input(z.object({ params: ModuleParams, query: SettingsPlaceQuery.optional() }))
    .output(ModuleSettingsSchema),
  /**
   * Saves and applies. 403 without `admin.settings.<id>`; 400 `{ error, problems }` for values
   * Core refuses; 409 when the config changed since `expected`. With `?space=` (and `room=`): the
   * place's own values, in effect at once (`expected` is not checked); `admin.settings.<id>` may
   * then come from a role assigned in that server.
   */
  saveSettings: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/modules/{id}/settings" })
    .input(
      z.object({
        params: ModuleParams,
        query: SettingsPlaceQuery.optional(),
        body: SaveSettingsRequestSchema,
      }),
    )
    .output(SaveSettingsResultSchema),
  /**
   * Newest first; `before` is the last version shown. `limit` 1..100, default 10. With `?space=`
   * (and `room=`): that place's own changes, `version` being their place in the event log.
   */
  settingsHistory: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/modules/{id}/settings/history" })
    .input(
      z.object({
        params: ModuleParams,
        query: z.object({
          limit: DigitsQuery.optional(),
          before: DigitsQuery.optional(),
          ...SettingsPlaceQuery.shape,
        }),
      }),
    )
    .output(SettingsHistorySchema),
  revertSettings: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/modules/{id}/settings/revert" })
    .input(z.object({ params: ModuleParams, body: RevertSettingsRequestSchema }))
    .output(SaveSettingsResultSchema),
  /** A card's quick action, through the actuator gate as the panel when it names a capability. */
  cardAction: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/modules/{id}/actions/{action}" })
    .input(z.object({ params: z.object({ id: z.string(), action: z.string() }) }))
    .output(ModuleActionResultSchema),
};

export const places = {
  rooms: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/places/rooms" })
    .input(
      z.object({
        query: z.object({
          kind: z.enum(["text", "voice", "thread"]).optional(),
          space: z.string().optional(),
        }),
      }),
    )
    .output(PlaceRoomsSchema),
};
