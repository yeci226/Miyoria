// What she organized and learned, read-only: her documents, her running notes on each
// conversation, her reflections with the lessons and feedback they rest on, and the condensed
// digests of her older thoughts. Changes are hers (or the data page's delete), not these routes'.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonObjectSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { route } from "./route.js";
import { LooseCount } from "./shared.js";

/** What a document is about. */
export const KnowledgeSubjectSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("person"), person: z.string() }),
    z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }),
    z.object({ type: z.literal("self") }),
    /** Anything she names herself. */
    z.object({ type: z.literal("topic"), name: z.string() }),
  ])
  .meta({ id: "ApiKnowledgeSubject" });
export type KnowledgeSubject = z.output<typeof KnowledgeSubjectSchema>;

/**
 * Who wrote something: `self` (her own judgment), `inferred` (she concluded it from a
 * conversation, which others can influence), `said` (attributed to the person who said it),
 * `panel` (the owner).
 */
export const SourceKindSchema = z
  .enum(["self", "inferred", "said", "panel"])
  .meta({ id: "ApiSourceKind" });
export type SourceKind = z.output<typeof SourceKindSchema>;

/** Where a field came from. */
export const FieldSourceSchema = z
  .object({
    kind: SourceKindSchema,
    /** Who said it (`said`). */
    account: AccountRefSchema.nullable(),
    name: z.string().nullable(),
    /** Where it was learned (a DM or a server), `null` for her own thoughts and the panel. */
    origin: z.string().nullable(),
    /** 0 to 1. */
    confidence: z.number(),
    at: TimestampSchema,
  })
  .meta({ id: "ApiFieldSource" });
export type FieldSource = z.output<typeof FieldSourceSchema>;

/** One change of a document. */
export const KnowledgeVersionSchema = z
  .object({
    version: z.number(),
    at: TimestampSchema,
    by: SourceKindSchema,
    /** Display name of who it is attributed to, if anyone. */
    name: z.string().nullable(),
    why: z.string(),
    /** What changed, in short (`replace /likes`, `created`). */
    ops: z.array(z.string()),
  })
  .meta({ id: "ApiKnowledgeVersion" });
export type KnowledgeVersion = z.output<typeof KnowledgeVersionSchema>;

/** One of her documents, with its short id (as her prompts show it) and whom it is about. */
export const KnowledgeDocSchema = z
  .object({
    /** ULID. */
    id: z.string(),
    subject: KnowledgeSubjectSchema,
    /** Her own label of the kind of document. */
    kind: z.string(),
    title: z.string(),
    /** Schema-free: whatever structure she chose. */
    content: JsonObjectSchema,
    /** JSON pointer (`""` is the document, `/likes/0`) to its source. */
    sources: z.record(z.string(), FieldSourceSchema),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    version: z.number(),
    history: z.array(KnowledgeVersionSchema),
    short_id: z.string(),
    subject_label: z.string(),
  })
  .meta({ id: "ApiKnowledgeDoc" });
export type KnowledgeDoc = z.output<typeof KnowledgeDocSchema>;

/** `GET /api/knowledge`: every document, most recently updated first. */
export const KnowledgeViewSchema = z
  .object({ documents: z.array(KnowledgeDocSchema) })
  .meta({ id: "ApiKnowledgeView" });
export type KnowledgeView = z.output<typeof KnowledgeViewSchema>;

/** Her running notes on one conversation, with the place's name. */
export const ConversationNoteSchema = z
  .object({
    context: ContextKeySchema,
    updated_at: TimestampSchema,
    /** Everything up to and including this line is folded in; `null` before the first fold. */
    folded_up_to: z.object({ id: z.string(), ts: TimestampSchema }).nullable(),
    /** How many folds and lines went into it. */
    folds: z.number(),
    lines: z.number(),
    /** A short narrative recap. */
    recap: z.string(),
    /** Her own structured notes: free-form JSON she organizes. */
    notes: JsonObjectSchema,
    /** When each thread of the notes last appeared or changed (missing in old states). */
    touched: z.record(z.string(), TimestampSchema).optional(),
    label: z.string().nullable(),
  })
  .meta({ id: "ApiConversationNote" });
export type ConversationNote = z.output<typeof ConversationNoteSchema>;

/** Something she learned about how to behave, with the person's name. */
export const LessonSchema = z
  .object({
    id: z.string(),
    /** In her words. */
    text: z.string(),
    /** About this person. */
    person: z.string().nullable(),
    /** Where it applies (`null`: wherever the person is, or everywhere). */
    scope: z.string().nullable(),
    /** Nudges her talkativeness there (-1 much quieter to 1 chattier); `null`: none. */
    talk: z.number().nullable(),
    created_at: TimestampSchema,
    expires_at: TimestampSchema.nullable(),
    /** `daily`, `light`, `panel`. */
    source: z.string(),
    display_name: z.string().nullable(),
  })
  .meta({ id: "ApiLesson" });
export type Lesson = z.output<typeof LessonSchema>;

/** Feedback signals about her, per person or context, over some days. */
export const FeedbackTallySchema = z
  .object({
    /** `person:<id>` or a context string. */
    subject: z.string(),
    /** Display name or place. */
    label: z.string(),
    reactions_pos: z.number(),
    reactions_neg: z.number(),
    replies: z.number(),
    started: z.number(),
    answered: z.number(),
    ignored: z.number(),
    positive: z.number(),
    negative: z.number(),
    denied: z.number(),
    /** A few short examples (untrusted text). */
    examples: z.array(z.string()),
  })
  .meta({ id: "ApiFeedbackTally" });
export type FeedbackTally = z.output<typeof FeedbackTallySchema>;

/** One of her reflections. */
export const ReflectionRunSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    /** `daily` (the day) or `light` (after a long session). */
    kind: z.enum(["daily", "light"]),
    context: ContextKeySchema.nullable(),
    /** Her summary, in her words. */
    summary: z.string(),
    insights: z.number(),
    superseded: z.number(),
    lessons: z.array(z.string()),
    goals: z.array(z.string()),
    /** Documents changed (titles). */
    documents: z.array(z.string()),
    feelings: z.array(z.string()),
    error: z.string().nullable(),
    tokens: z.number().nullable(),
    ms: z.number(),
  })
  .meta({ id: "ApiReflectionRun" });
export type ReflectionRun = z.output<typeof ReflectionRunSchema>;

export const ReflectionStatsSchema = z
  .object({
    calls_today: z.number(),
    max_calls_per_day: z.number(),
    last_daily_at: TimestampSchema.nullable(),
    last_light_at: TimestampSchema.nullable(),
    /** Why she is not reflecting right now, if not. */
    idle_reason: z.string().nullable(),
  })
  .meta({ id: "ApiReflectionStats" });
export type ReflectionStats = z.output<typeof ReflectionStatsSchema>;

/** `GET /api/reflection`. */
export const ReflectionViewSchema = z
  .object({
    stats: ReflectionStatsSchema,
    /** Newest first. */
    runs: z.array(ReflectionRunSchema),
    lessons: z.array(LessonSchema),
    feedback: z.array(FeedbackTallySchema),
  })
  .meta({ id: "ApiReflectionView" });
export type ReflectionView = z.output<typeof ReflectionViewSchema>;

/** Older journal entries condensed into one record. */
export const ThoughtDigestSchema = z
  .object({
    id: z.string(),
    /** First and last thought it covers. */
    from: TimestampSchema,
    to: TimestampSchema,
    /** Thoughts condensed. */
    count: z.number(),
    /** What she was thinking about then (her voice, or a plain summary when no model ran). */
    summary: z.string(),
    /** Intents of those thoughts by `capability:status`. */
    intents: z.record(z.string(), z.number()),
    /** `summarizer` or `rule` (no model available or allowed). */
    by: z.enum(["summarizer", "rule"]),
  })
  .meta({ id: "ApiThoughtDigest" });
export type ThoughtDigest = z.output<typeof ThoughtDigestSchema>;

/**
 * `days` is held to 1..14 (default 7). A value that is not a number is the default, as it always
 * was, so the handler reads it.
 */
const ReflectionQuery = z.object({ days: LooseCount.optional() });

/** `limit` is held to 1..100 (default 20); one that is not a number is the default. */
const DigestsQuery = z.object({ limit: LooseCount.optional() });

export const knowledge = {
  /** Her documents, whatever their shape. */
  documents: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/knowledge" })
    .output(KnowledgeViewSchema),
  /** Her running notes on each conversation, most recently updated first. */
  conversations: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/knowledge/conversations" })
    .output(z.array(ConversationNoteSchema)),
};

/** Her reflections, lessons and feedback signals. */
export const reflection = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/reflection" })
  .input(z.object({ query: ReflectionQuery }))
  .output(ReflectionViewSchema);

/** Joins the `mind` group. */
export const mindDigests = {
  /** Condensed older thoughts, newest first. */
  digests: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mind/digests" })
    .input(z.object({ query: DigestsQuery }))
    .output(z.array(ThoughtDigestSchema)),
};
