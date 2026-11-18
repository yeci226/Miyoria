// The heart's record on the event log (docs/design/v5-heart.md §2.2, §2.3; v5-data.md §2.7):
// her numbers for each person are one `heart_person` row, and every change of one of them is one
// `heart.changed` event, appended in the transaction that writes the row. There is no delta
// table: a person's history and the day's budget (the daily caps) are read from these events.
//
// `heart.evidence` is something that happened between her and someone that is not a change by
// itself (time together in voice, a song they heard, a game, a gift, a deal kept or broken): the
// nightly reflection reads the day's evidence and decides what it meant.
//
// Changes are for the owner (`owner`): she never shows people the numbers. They are small and
// the "why" of who she is with someone, so they are kept forever (`keep`). Evidence is about
// someone somewhere, so the session decides its scope; it is kept a year (`long`), like the
// lines it summarises.
//
// The envelope's `person_id` is the person the event is about.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** The numbers of a person's row. */
export const HeartFieldSchema = z
  .enum([
    "bond",
    "trust",
    "familiarity",
    "warmth",
    "respect",
    "ease",
    "grudge",
    "longing",
    "rapport",
  ])
  .meta({ id: "EventsHeartField" });
export type HeartFieldName = z.output<typeof HeartFieldSchema>;

/**
 * Why a number moved:
 * - `feel`: her own proposal in a `<feel>` block, sized and capped by the program;
 * - `reflect`: her nightly reflection on the person, capped the same way;
 * - `evidence`: an interaction that moves a number by itself (a gift's small step);
 * - `decay`: time (the daily pass);
 * - `admin`: the owner in the panel;
 * - `migrate`: carried over from the old social and self records.
 */
export const HeartCauseSchema = z
  .enum(["feel", "reflect", "evidence", "decay", "admin", "migrate"])
  .meta({ id: "EventsHeartCause" });
export type HeartCauseName = z.output<typeof HeartCauseSchema>;

/** A `heart.changed` payload: one number of one person moved. */
export const HeartChangedSchema = z
  .object({
    /** The person (identity's `persons.id`). */
    person: z.string(),
    field: HeartFieldSchema,
    /** What was applied after steps, damping, caps, range and anchors; 0 when nothing was. */
    delta: z.number(),
    /** The number once the change was written. */
    value_after: z.number(),
    /**
     * What was asked for before damping, caps, range and anchors (a `feel` proposal's step, a
     * reflection's change); `null` for a change nobody asked for in that size (decay, migrate).
     * It keeps the direction of a proposal that the caps took all of.
     */
    proposed: z.number().nullable(),
    /** Her words or the words she quotes as the reason; `""` without one. */
    reason_quote: z.string(),
    cause: HeartCauseSchema,
  })
  .meta({ id: "EventsHeartChanged" });
export type HeartChangedData = z.output<typeof HeartChangedSchema>;

/**
 * What kind of thing happened (v5-architecture §8.3 "every interaction is evidence"):
 * - `voice_together`: time in a voice channel with her (`weight`: minutes);
 * - `heard_song`: they were there for a song of hers, or asked for one;
 * - `played_together`: a game with her;
 * - `task_together`: a task or bounty done with her or for her;
 * - `gift`: a gift to her (`weight`: its value in coins);
 * - `card`: a card of hers given, traded or kept;
 * - `deal_kept`, `deal_broken`: deals are gone; kept so evidence already stored still reads.
 */
export const HeartEvidenceKindSchema = z
  .enum([
    "voice_together",
    "heard_song",
    "played_together",
    "task_together",
    "gift",
    "card",
    "deal_kept",
    "deal_broken",
  ])
  .meta({ id: "EventsHeartEvidenceKind" });
export type HeartEvidenceKindName = z.output<typeof HeartEvidenceKindSchema>;

/** A `heart.evidence` payload. */
export const HeartEvidenceSchema = z
  .object({
    person: z.string(),
    kind: HeartEvidenceKindSchema,
    /** What happened, short, neutral zh-TW (may contain names). */
    detail: z.string(),
    /** How much of it, in the kind's unit; `null` when the kind has none. */
    weight: z.number().nullable(),
    /** When it happened (the end of a span). */
    at: TimestampSchema,
  })
  .meta({ id: "EventsHeartEvidence" });
export type HeartEvidenceData = z.output<typeof HeartEvidenceSchema>;

/** One number of one person moved. */
export const HeartChanged = defineEvent({
  type: "heart.changed",
  v: 1,
  data: HeartChangedSchema,
  scope: "owner",
  tier: "keep",
});

/** Something happened between her and someone. */
export const HeartEvidence = defineEvent({
  type: "heart.evidence",
  v: 1,
  data: HeartEvidenceSchema,
  tier: "long",
});

/** The heart's log types. */
export const HEART_LOG_EVENTS = [HeartChanged, HeartEvidence] as const;
