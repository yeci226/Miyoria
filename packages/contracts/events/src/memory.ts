// Her memory and learning (docs/design/v5-contracts.md §3, K12a): what the world module found
// worth her attention, the feedback and folds of the conversation module, a knowledge document
// that changed and a reflection that ran. Each type is the bus topic it is published on, and its
// payload is that event's data.
//
// Tiers (v5-data §2.5): a salient change is an ambient observation (`ambient`), no default scope.
// The rest is kept 90 days (`short`): feedback and folds name people and places (the session
// decides); a knowledge document may hold what someone said in a DM, and a reflection her day in
// her words: for the owner (`owner`).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonObjectSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

export const SalienceKindSchema = z
  .enum(["came_online", "joined_voice", "started_game", "channel_quiet", "mentioned"])
  .meta({ id: "EventsSalienceKind" });

/** A change worth her attention, merged from raw ones: `world.salient`. */
export const SalientEventSchema = z
  .object({
    kind: SalienceKindSchema,
    /** Coalescing key (same key = same thing happening again). */
    key: z.string(),
    account: AccountRefSchema.nullable(),
    person: z.string().nullable(),
    display_name: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    /** Short neutral description (zh-TW) with untrusted names inside. */
    detail: z.string(),
    /** 0..1, how much it probably matters. */
    score: z.number(),
    /** How many raw occurrences were merged into this event. */
    count: z.number(),
    first_at: TimestampSchema,
    at: TimestampSchema,
  })
  .meta({ id: "EventsSalientEvent" });
export type SalientEventData = z.output<typeof SalientEventSchema>;

/** Someone's phrase about her that the fold noticed: `feedback.signal`. */
export const FeedbackSignalSchema = z
  .object({
    context: ContextKeySchema,
    account: AccountRefSchema,
    /** `null` when the account is not a person she knows. */
    person: z.string().nullable(),
    name: z.string(),
    tone: z.enum(["positive", "negative"]),
    /** Their words, cut short (untrusted text). */
    quote: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsFeedbackSignal" });
export type FeedbackSignalData = z.output<typeof FeedbackSignalSchema>;

/** Everything up to and including this line of the conversation is folded in. */
export const FoldMarkSchema = z
  .object({
    /** Log entry id (ULID). */
    id: z.string(),
    ts: TimestampSchema,
  })
  .meta({ id: "EventsFoldMark" });

/** A conversation's lines were folded into her running notes: `conversation.folded`. */
export const ConversationFoldedSchema = z
  .object({
    context: ContextKeySchema,
    folded_up_to: FoldMarkSchema,
    /** Lines folded this time. */
    lines: z.number(),
    /** Total lines folded since the context went quiet last (a long session). */
    session_lines: z.number(),
  })
  .meta({ id: "EventsConversationFolded" });
export type ConversationFoldedData = z.output<typeof ConversationFoldedSchema>;

/** What a knowledge document is about. */
export const KnowledgeSubjectSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("person"), person: z.string() }),
    z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }),
    z.object({ type: z.literal("self") }),
    /** Anything she names herself. */
    z.object({ type: z.literal("topic"), name: z.string() }),
  ])
  .meta({ id: "EventsKnowledgeSubject" });

/** Who wrote something: her own judgment, an inference, what someone said, or the owner. */
export const KnowledgeSourceKindSchema = z
  .enum(["self", "inferred", "said", "panel"])
  .meta({ id: "EventsKnowledgeSourceKind" });

/** Where a field of a document came from. */
export const KnowledgeFieldSourceSchema = z
  .object({
    kind: KnowledgeSourceKindSchema,
    /** Who said it (`said`). */
    account: AccountRefSchema.nullable(),
    name: z.string().nullable(),
    /** Where it was learned (a DM or a server); `null` for her own thoughts and the panel. */
    origin: z.string().nullable(),
    /** 0..1 */
    confidence: z.number(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsKnowledgeFieldSource" });

/** One change of a document. */
export const KnowledgeVersionSchema = z
  .object({
    version: z.number(),
    at: TimestampSchema,
    by: KnowledgeSourceKindSchema,
    /** Display name of who it is attributed to, if anyone. */
    name: z.string().nullable(),
    why: z.string(),
    /** What changed, in short (`replace /likes`, `created`). */
    ops: z.array(z.string()),
  })
  .meta({ id: "EventsKnowledgeVersion" });

/** One of her documents. */
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
    sources: z.record(z.string(), KnowledgeFieldSourceSchema),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    version: z.number(),
    history: z.array(KnowledgeVersionSchema),
  })
  .meta({ id: "EventsKnowledgeDoc" });
export type KnowledgeDocData = z.output<typeof KnowledgeDocSchema>;

/** A document was created, changed or deleted (`deleted`: the last state it had): `knowledge.changed`. */
export const KnowledgeChangedSchema = z
  .object({ doc: KnowledgeDocSchema, deleted: z.boolean() })
  .meta({ id: "EventsKnowledgeChanged" });
export type KnowledgeChangedData = z.output<typeof KnowledgeChangedSchema>;

/** One of her reflections: `reflect.run`. */
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
  .meta({ id: "EventsReflectionRun" });
export type ReflectionRunData = z.output<typeof ReflectionRunSchema>;

export const WorldSalient = defineEvent({
  type: "world.salient",
  v: 1,
  data: SalientEventSchema,
  tier: "ambient",
});

export const FeedbackSignal = defineEvent({
  type: "feedback.signal",
  v: 1,
  data: FeedbackSignalSchema,
  tier: "short",
});

export const ConversationFolded = defineEvent({
  type: "conversation.folded",
  v: 1,
  data: ConversationFoldedSchema,
  tier: "short",
});

export const KnowledgeChanged = defineEvent({
  type: "knowledge.changed",
  v: 1,
  data: KnowledgeChangedSchema,
  scope: "owner",
  tier: "short",
});

export const ReflectRun = defineEvent({
  type: "reflect.run",
  v: 1,
  data: ReflectionRunSchema,
  scope: "owner",
  tier: "short",
});

/** Every memory and learning type. */
export const MEMORY_EVENTS = [
  WorldSalient,
  FeedbackSignal,
  ConversationFolded,
  KnowledgeChanged,
  ReflectRun,
] as const;
