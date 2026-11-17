// Her documents as the owner reads them: one per person, place, topic and herself, made of lines
// with how she knows each, where it may be shown and what it rests on (`@miyoria/memory/notes`).
//
// * `GET /api/notes/documents?kind=`: the documents with their line counts, and the totals by kind.
// * `GET /api/notes/documents/{id}?outdated=`: one document, its lines by section; the lines no
//   longer in use only with `outdated=true`.
// * `GET /api/notes/documents/{id}/history`: its change sets, oldest first.
// * `POST /api/notes/documents/{id}/revert` `{ version }`: puts the lines in use back as they were
//   after that version, as a new change set. Audited as `notes.revert`.

import { z } from "zod";
import { PersonIdSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { FlagQuery } from "./shared.js";

export const NoteKindSchema = z
  .enum(["person", "place", "topic", "self"])
  .meta({ id: "ApiNoteKind" });
export type NoteKind = z.output<typeof NoteKindSchema>;

export const NoteProvenanceSchema = z
  .enum(["told_by_subject", "told_by_other", "observed", "concluded"])
  .meta({ id: "ApiNoteProvenance" });
export type NoteProvenance = z.output<typeof NoteProvenanceSchema>;

export const NoteAuthorSchema = z
  .enum(["segment", "reflect", "tool", "import", "panel", "system"])
  .meta({ id: "ApiNoteAuthor" });
export type NoteAuthor = z.output<typeof NoteAuthorSchema>;

/** One document in a listing. */
export const NoteDocumentEntrySchema = z
  .object({
    id: z.string(),
    /** `#` and the last 6 characters of the id (what her prompts show). */
    short_id: z.string(),
    /** `person:<id>`, `place:<id>`, `topic:<slug>` or `self`. */
    subject: z.string(),
    kind: NoteKindSchema,
    /** What it is called: a person's name, a topic as she wrote it, `她自己`. */
    label: z.string(),
    /** Lines in use. */
    lines: z.number(),
    /** Its last change set; 0: never changed. */
    version: z.number(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiNoteDocumentEntry" });
export type NoteDocumentEntry = z.output<typeof NoteDocumentEntrySchema>;

export const NoteKindCountSchema = z
  .object({ kind: NoteKindSchema, documents: z.number(), lines: z.number() })
  .meta({ id: "ApiNoteKindCount" });
export type NoteKindCount = z.output<typeof NoteKindCountSchema>;

/** `GET /api/notes/documents`: most recently changed first. */
export const NotesListSchema = z
  .object({
    documents: z.array(NoteDocumentEntrySchema),
    /** Every kind, whatever `kind` asked for. */
    counts: z.array(NoteKindCountSchema),
  })
  .meta({ id: "ApiNotesList" });
export type NotesList = z.output<typeof NotesListSchema>;

/** The words a line rests on, and where they are from. */
export const NoteEvidenceViewSchema = z
  .object({
    /** Empty once redacted. */
    quote: z.string(),
    person_id: PersonIdSchema.nullable(),
    person_name: z.string().nullable(),
    at: TimestampSchema,
    redacted: z.boolean(),
  })
  .meta({ id: "ApiNoteEvidence" });
export type NoteEvidenceView = z.output<typeof NoteEvidenceViewSchema>;

export const NoteLineViewSchema = z
  .object({
    id: z.string(),
    short_id: z.string(),
    text: z.string(),
    provenance: NoteProvenanceSchema,
    told_by: PersonIdSchema.nullable(),
    told_by_name: z.string().nullable(),
    /** Where it may be shown. */
    scope: z.object({
      type: z.enum(["public", "self", "space", "room", "dm", "person"]),
      /** `她自己`, `公開`, `和 Owen 的私訊`, `某個伺服器`. */
      label: z.string(),
    }),
    confidence: z.number(),
    author: NoteAuthorSchema,
    evidence: z.array(NoteEvidenceViewSchema),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    /** `null`: in use. */
    outdated_at: TimestampSchema.nullable(),
    outdated_reason: z.string().nullable(),
  })
  .meta({ id: "ApiNoteLine" });
export type NoteLineView = z.output<typeof NoteLineViewSchema>;

export const NoteSectionViewSchema = z
  .object({ key: z.string(), label: z.string(), lines: z.array(NoteLineViewSchema) })
  .meta({ id: "ApiNoteSection" });
export type NoteSectionView = z.output<typeof NoteSectionViewSchema>;

/** `GET /api/notes/documents/{id}`. */
export const NoteDocumentViewSchema = z
  .object({
    document: NoteDocumentEntrySchema,
    /** In the order the kind shows them; only sections with lines to show. */
    sections: z.array(NoteSectionViewSchema),
    /** Lines no longer in use, whether or not they are listed. */
    outdated: z.number(),
  })
  .meta({ id: "ApiNoteDocumentView" });
export type NoteDocumentView = z.output<typeof NoteDocumentViewSchema>;

export const NoteChangeSchema = z
  .object({
    op: z.enum(["add", "outdate", "restore", "redact"]),
    line_id: z.string(),
    section: z.string(),
    section_label: z.string(),
    /** The line's text as it is now (empty once redacted). */
    text: z.string(),
  })
  .meta({ id: "ApiNoteChange" });
export type NoteChange = z.output<typeof NoteChangeSchema>;

export const NoteVersionSchema = z
  .object({
    version: z.number(),
    at: TimestampSchema,
    author: NoteAuthorSchema,
    reason: z.string().nullable(),
    changes: z.array(NoteChangeSchema),
  })
  .meta({ id: "ApiNoteVersion" });
export type NoteVersion = z.output<typeof NoteVersionSchema>;

/** `GET /api/notes/documents/{id}/history`: oldest first. */
export const NoteHistorySchema = z
  .object({ document: NoteDocumentEntrySchema, versions: z.array(NoteVersionSchema) })
  .meta({ id: "ApiNoteHistory" });
export type NoteHistory = z.output<typeof NoteHistorySchema>;

export const NoteRevertRequestSchema = z
  .strictObject({ version: z.number().int().min(0) })
  .meta({ id: "ApiNoteRevertRequest" });
export type NoteRevertRequest = z.output<typeof NoteRevertRequestSchema>;

export const NoteRevertResultSchema = z
  .object({
    document: NoteDocumentEntrySchema,
    /** The version the revert got; `null` when the lines in use were already those. */
    version: z.number().nullable(),
    restored: z.number(),
    outdated: z.number(),
    /** Lines that were in use then but lost their text since: they stay out. */
    gone: z.number(),
  })
  .meta({ id: "ApiNoteRevertResult" });
export type NoteRevertResult = z.output<typeof NoteRevertResultSchema>;

export const notes = {
  /** The documents, with the line counts and the totals by kind. */
  documents: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/notes/documents" })
    .input(z.object({ query: z.object({ kind: NoteKindSchema.optional() }) }))
    .output(NotesListSchema),
  /** One document; `404` when there is none by that id. */
  document: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/notes/documents/{id}" })
    .input(
      z.object({
        params: z.object({ id: z.string() }),
        query: z.object({ outdated: FlagQuery.optional() }),
      }),
    )
    .output(NoteDocumentViewSchema),
  /** Its change sets; `404` when there is no such document. */
  history: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/notes/documents/{id}/history" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(NoteHistorySchema),
  /** Back to how the lines in use were after `version`; `404` for no such document, `400` for no such version. */
  revert: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/notes/documents/{id}/revert" })
    .input(z.object({ params: z.object({ id: z.string() }), body: NoteRevertRequestSchema }))
    .output(NoteRevertResultSchema),
};
