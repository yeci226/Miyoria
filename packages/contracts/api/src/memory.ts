// Her long-term memories (the active profile): browse, search, edit and delete. A search uses the
// memory engine's hybrid recall when the memory module runs, else the store's full-text search;
// either way over every scope of the profile (an admin view).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  PersonIdSchema,
  PlatformIdSchema,
  ProfileIdSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { route } from "./route.js";
import { DigitsQuery, FlagQuery } from "./shared.js";

/**
 * `episode`: something that happened; `fact`: about a person or the world; `self_note`: her own
 * experiences, opinions and promises; `followup`: something to bring up later (has `due`).
 */
export const MemoryKindSchema = z
  .enum(["episode", "fact", "self_note", "followup"])
  .meta({ id: "ApiMemoryKind" });
export type MemoryKind = z.output<typeof MemoryKindSchema>;

/** Where a memory may be recalled. */
export const MemoryScopeSchema = z
  .discriminatedUnion("type", [
    /** Anywhere. */
    z.object({ type: z.literal("global") }),
    /** Anywhere in one guild. */
    z.object({ type: z.literal("guild"), platform: PlatformIdSchema, guild: z.string() }),
    /** Only in one channel (or voice channel). */
    z.object({ type: z.literal("channel"), context: ContextKeySchema }),
    /** Only in the DM with this account. */
    z.object({ type: z.literal("dm"), account: AccountRefSchema }),
    /** Anywhere this person is present. */
    z.object({ type: z.literal("person"), person: PersonIdSchema }),
  ])
  .meta({ id: "ApiMemoryScope" });
export type MemoryScope = z.output<typeof MemoryScopeSchema>;

/** A memory record without its search tokens and embedding vector. */
export const MemoryRecordViewSchema = z
  .object({
    /** ULID. */
    id: z.string(),
    profile: ProfileIdSchema,
    kind: MemoryKindSchema,
    scope: MemoryScopeSchema,
    /** People the memory is about. */
    subjects: z.array(PersonIdSchema),
    content: z.string(),
    /** 0..1 */
    importance: z.number(),
    /** 0..1 */
    confidence: z.number(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    last_accessed: TimestampSchema.nullable(),
    access_count: z.number(),
    /** Where it was learned. */
    source_context: ContextKeySchema.nullable(),
    /** Followups: earliest time to bring it up. */
    due: TimestampSchema.nullable(),
    /** Followups: already brought up. */
    done: z.boolean(),
    /** Replaced by a newer record (kept for history, never recalled). */
    superseded_by: z.string().nullable(),
    has_embedding: z.boolean(),
  })
  .meta({ id: "ApiMemoryRecordView" });
export type MemoryRecordView = z.output<typeof MemoryRecordViewSchema>;

/** One memory of a list or search; the scores are present only for a search (`q`). */
export const MemoryItemSchema = z
  .object({
    record: MemoryRecordViewSchema,
    /** The backend's full-text relevance, 0 when only the vector matched. */
    text_score: z.number().optional(),
    /** `null` for a search that compared no vectors. */
    vector_score: z.number().nullable().optional(),
    /** Hybrid recall score, present when the search ran through the memory engine. */
    score: z.number().optional(),
  })
  .meta({ id: "ApiMemoryItem" });
export type MemoryItem = z.output<typeof MemoryItemSchema>;

/** A page of memories; `next_cursor` is the `before` of the next page, `null` on the last one. */
export const MemoryPageSchema = z
  .object({ items: z.array(MemoryItemSchema), next_cursor: z.string().nullable() })
  .meta({ id: "ApiMemoryPage" });
export type MemoryPage = z.output<typeof MemoryPageSchema>;

/** Body of `PATCH /api/memory/{id}`; fields left out (or `null`) are unchanged. */
export const UpdateMemoryRequestSchema = z
  .object({
    content: z.string().nullish(),
    kind: MemoryKindSchema.nullish(),
    importance: z.number().nullish(),
    done: z.boolean().nullish(),
  })
  .meta({ id: "ApiUpdateMemoryRequest" });
export type UpdateMemoryRequest = z.input<typeof UpdateMemoryRequestSchema>;

/**
 * Query of the list. `q` searches (hybrid recall through the memory module, else full text) and
 * leaves out superseded records; without it the list is newest first. `subject` is a person's ULID
 * and `before` a time (pagination when listing): the server answers `400` for a bad one. `limit`
 * defaults to 50 and is held to 1..500.
 */
const ListQuery = z.object({
  q: z.string().optional(),
  kind: MemoryKindSchema.optional(),
  subject: z.string().optional(),
  before: z.string().optional(),
  include_superseded: FlagQuery.optional(),
  limit: DigitsQuery.optional(),
});

const MemoryParams = z.object({ params: z.object({ id: z.string() }) });

export const memory = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/memory" })
    .input(z.object({ query: ListQuery }))
    .output(MemoryPageSchema),
  /** `400` for an empty or over-long `content` or an `importance` outside 0..1; `404` for an unknown id. */
  update: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PATCH", path: "/api/memory/{id}" })
    .input(z.object({ ...MemoryParams.shape, body: UpdateMemoryRequestSchema }))
    .output(MemoryRecordViewSchema),
  /** No content. `404` for an unknown id. */
  remove: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/memory/{id}", successStatus: 204 })
    .input(MemoryParams),
};
