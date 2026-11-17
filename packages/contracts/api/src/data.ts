// Every kind of data she has (the store's data categories, plus her tools workspace on disk): the
// inventory, a delete by category, and the factory reset. Managing it is owner only
// (`owner.data.manage`; the bearer token may do everything); the inventory is visible to every
// panel user.
//
// The export and the backup are downloads (an attachment, the backup with the one-time token a
// reset needs in the `x-miyoria-backup-token` header); they stay plain routes of the server.

import { z } from "zod";
import { ProfileIdSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** The owner-level node that lets a panel user export and delete her data. */
const NODE_DATA_MANAGE = "owner.data.manage";

/** Said when a session lacks the node, in place of the usual one. */
const MANAGE_REFUSAL = `managing her data needs \`${NODE_DATA_MANAGE}\``;

/** A kind of data: the store's categories, and her tools workspace on disk. */
export const DataCategoryIdSchema = z
  .enum([
    "memories",
    "relationships",
    "call_names",
    "inner",
    "knowledge",
    "learning",
    "conversation",
    "mood",
    "messages",
    "decisions",
    "event_log",
    "directives",
    "initiative",
    "artifacts",
    "people",
    "channels",
    "voice_consent",
    "privacy",
    "queue",
    "roles",
    "persona",
    "proposed_tools",
    "extensions",
    "module_state",
    "other_settings",
    "audit",
    "llm_usage",
    "panel_sessions",
    "tools_workspace",
  ])
  .meta({ id: "ApiDataCategoryId" });
export type DataCategoryId = z.output<typeof DataCategoryIdSchema>;

/** One part of a category (a table, or a set of settings). */
export const DataPartViewSchema = z
  .object({ id: z.string(), count: z.number(), updated_at: TimestampSchema.nullable() })
  .meta({ id: "ApiDataPartView" });
export type DataPartView = z.output<typeof DataPartViewSchema>;

/** One category of the inventory. */
export const DataCategoryViewSchema = z
  .object({
    id: DataCategoryIdSchema,
    count: z.number(),
    updated_at: TimestampSchema.nullable(),
    parts: z.array(DataPartViewSchema),
    /** Counts by a sub-kind (memories by kind). */
    breakdown: z.record(z.string(), z.number()).nullable(),
    /** Shared by every profile on this node. */
    shared: z.boolean(),
    /** Never deleted (export only). */
    kept: z.boolean(),
    exportable: z.boolean(),
    /** `typed`: deleting needs the profile id typed. */
    confirm: z.enum(["typed", "simple"]),
    /** Also deleted when this one is. */
    requires: z.array(DataCategoryIdSchema),
  })
  .meta({ id: "ApiDataCategoryView" });
export type DataCategoryView = z.output<typeof DataCategoryViewSchema>;

/** Everything she has, per category. */
export const DataInventoryViewSchema = z
  .object({
    profile: ProfileIdSchema,
    at: TimestampSchema,
    /** The caller may export, delete and reset (`owner.data.manage`). */
    can_manage: z.boolean(),
    categories: z.array(DataCategoryViewSchema),
  })
  .meta({ id: "ApiDataInventoryView" });
export type DataInventoryView = z.output<typeof DataInventoryViewSchema>;

/** What the panel tells the owner after a delete. */
export const DataNoteSchema = z
  .enum([
    /** Persona edits and module switches are gone from the store; live values change on restart. */
    "restart_core",
    /** Voice consent is cached for up to a minute. */
    "consent_cache",
  ])
  .meta({ id: "ApiDataNote" });
export type DataNote = z.output<typeof DataNoteSchema>;

/** What a delete or a reset removed. */
export const DataWipeResultSchema = z
  .object({
    deleted: z.array(DataCategoryIdSchema),
    /** Rows removed per part. */
    counts: z.record(z.string(), z.number()),
    /** Modules that did not start again. */
    failed_modules: z.array(z.string()),
    notes: z.array(DataNoteSchema),
  })
  .meta({ id: "ApiDataWipeResult" });
export type DataWipeResult = z.output<typeof DataWipeResultSchema>;

/**
 * Body of `POST /api/data/wipe`. The categories are strings the server checks (`400` for one it
 * does not know or that is kept); categories marked `typed` need `confirm` to be the profile id.
 */
export const DataWipeRequestSchema = z
  .object({ categories: z.array(z.string()).min(1), confirm: z.string().nullish() })
  .meta({ id: "ApiDataWipeRequest" });
export type DataWipeRequest = z.input<typeof DataWipeRequestSchema>;

/** Body of `POST /api/data/reset`: the profile id, and the token of a backup made just before. */
export const DataResetRequestSchema = z
  .object({ confirm: z.string(), backup_token: z.string() })
  .meta({ id: "ApiDataResetRequest" });
export type DataResetRequest = z.input<typeof DataResetRequestSchema>;

export const data = {
  inventory: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/data" })
    .output(DataInventoryViewSchema),
  /** `400` for a category that is unknown, kept or missing its confirmation. */
  wipe: route
    .meta({ audience: "admin", permission: NODE_DATA_MANAGE, refusal: MANAGE_REFUSAL })
    .route({ method: "POST", path: "/api/data/wipe" })
    .input(z.object({ body: DataWipeRequestSchema }))
    .output(DataWipeResultSchema),
  /** `409` without a backup made first by the same account (`POST /api/data/backup`). */
  reset: route
    .meta({ audience: "admin", permission: NODE_DATA_MANAGE, refusal: MANAGE_REFUSAL })
    .route({ method: "POST", path: "/api/data/reset" })
    .input(z.object({ body: DataResetRequestSchema }))
    .output(DataWipeResultSchema),
};
