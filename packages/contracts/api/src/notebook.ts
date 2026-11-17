// What the memory module added in V4, read-only:
//
// * the pages of her notebook, newest change first. Only pages she wrote for herself (no place) are
//   readable here: a page written in a DM or in a guild belongs to that place.
// * one such page with its text.
// * the "just now" timeline as she reads it from a context: what she did and what happened around
//   her lately. Lines from a DM are left out and counted, because the panel is not where she may
//   quote them.

import { z } from "zod";
import { ContextKeySchema, PersonIdSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

export const NotebookEntrySchema = z
  .object({
    path: z.string(),
    chars: z.number(),
    updated_at: TimestampSchema,
    /** The person it is about (`人/<名字>`), when known. */
    about: PersonIdSchema.nullable(),
  })
  .meta({ id: "ApiNotebookEntry" });
export type NotebookEntry = z.output<typeof NotebookEntrySchema>;

export const NotebookPageSchema = z
  .object({
    ...NotebookEntrySchema.shape,
    body: z.string(),
    created_at: TimestampSchema,
  })
  .meta({ id: "ApiNotebookPage" });
export type NotebookPage = z.output<typeof NotebookPageSchema>;

/** `GET /api/notebook`. */
export const NotebookIndexSchema = z
  .object({ pages: z.array(NotebookEntrySchema) })
  .meta({ id: "ApiNotebookIndex" });
export type NotebookIndex = z.output<typeof NotebookIndexSchema>;

export const JustNowKindSchema = z
  .enum(["song", "game", "voice", "stream", "notice", "talk", "asked"])
  .meta({ id: "ApiJustNowKind" });
export type JustNowKind = z.output<typeof JustNowKindSchema>;

/** One line of the timeline, with where it happened. */
export const JustNowEntrySchema = z
  .object({
    at: TimestampSchema,
    kind: JustNowKindSchema,
    place: z.object({
      kind: z.enum(["here", "voice", "text", "dm"]),
      /** Shown to her: `這裡`, `語音`, `別的文字頻道`, `和 Owen 的私訊`. */
      label: z.string(),
      /** `null`: her own state, which belongs to no place. */
      context: ContextKeySchema.nullable(),
    }),
    /** One line for her (may quote people). */
    text: z.string(),
    /** From a DM: only for her. */
    private: z.boolean(),
  })
  .meta({ id: "ApiJustNowEntry" });
export type JustNowEntry = z.output<typeof JustNowEntrySchema>;

/** `GET /api/recent`. */
export const RecentViewSchema = z
  .object({
    entries: z.array(JustNowEntrySchema),
    /** Lines left out because they came from a DM. */
    private_hidden: z.number(),
  })
  .meta({ id: "ApiRecentView" });
export type RecentView = z.output<typeof RecentViewSchema>;

export const notebook = {
  /** Her pages, newest change first. */
  pages: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/notebook" })
    .output(NotebookIndexSchema),
  /** One page; `404` when she has none by that path. */
  page: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/notebook/page" })
    .input(z.object({ query: z.object({ path: z.string().min(1).max(300) }) }))
    .output(NotebookPageSchema),
};

/**
 * The timeline from `context`, a JSON-encoded context key that the server decodes (missing: `400`,
 * not JSON: `400`).
 */
export const recent = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/recent" })
  .input(z.object({ query: z.object({ context: z.string().optional() }) }))
  .output(RecentViewSchema);
