// How she feels and what that does to her, read-only: `GET /api/affect` (the strongest emotions,
// the derived mood, the drives, the bias table and what she shows). How she feels about each person
// is `GET /api/people`; changes go through the people routes.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import {
  DrivesSchema,
  EmotionNameSchema,
  EmotionReadingSchema,
  MoodSchema,
  ShownEmotionSchema,
} from "./inner.js";
import { route } from "./route.js";

/** What her feelings push her toward: added to her talkativeness and initiative, and her wishes. */
export const AffectBiasesSchema = z
  .object({
    /** Added to her talkativeness (-1..1). */
    talkativeness: z.number(),
    /** Added to her willingness to start things (-1..1). */
    initiative: z.number(),
    /** Per wish (`chat_with`, `play`, `stream`, `rest`, `sing`): weight 0..1 and why. */
    wants: z.array(
      z.object({
        want: z.string(),
        weight: z.number(),
        person: z.string().nullable(),
        why: z.string(),
        /** The emotion behind it, when one is (a drive otherwise). */
        from: EmotionNameSchema.optional(),
      }),
    ),
  })
  .meta({ id: "ApiAffectBiases" });
export type AffectBiases = z.output<typeof AffectBiasesSchema>;

/** `GET /api/affect`. */
export const AffectSnapshotSchema = z
  .object({
    at: TimestampSchema,
    drives: DrivesSchema,
    /** 0..1 */
    boredom: z.number(),
    /** The strongest 2 or 3 emotions only. */
    top: z.array(EmotionReadingSchema),
    /** Derived, never stored on its own. */
    mood: MoodSchema,
    /** One line for the prompt (`心情不錯、有點累`). */
    mood_line: z.string(),
    shown: ShownEmotionSchema.nullable(),
    biases: AffectBiasesSchema,
  })
  .meta({ id: "ApiAffectSnapshot" });
export type AffectSnapshot = z.output<typeof AffectSnapshotSchema>;

export const affect = {
  /** Her emotions, derived mood, drives and the behaviour biases they imply. */
  snapshot: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/affect" })
    .output(AffectSnapshotSchema),
};
