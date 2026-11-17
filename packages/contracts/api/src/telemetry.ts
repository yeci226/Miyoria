// What the panel charts over time: one sample a minute of her mood, drives and boredom, the LLM
// counters of `/metrics` and the mind's call counts, with a few bus topics counted between samples.
// The samples live in memory for 24 hours, so the series starts when the `api` module started.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { DrivesSchema, MoodSchema } from "./inner.js";
import { route } from "./route.js";
import { DigitsQuery } from "./shared.js";

/** Process-wide LLM counters at a sample, summed over models and purposes. */
export const TelemetryLlmSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    cost_usd: z.number(),
    errors: z.number(),
    /** `miyoria_llm_first_token_seconds`: cumulative counts at each finite upper bound. */
    first_token: z.object({
      count: z.number(),
      sum_s: z.number(),
      buckets: z.array(z.object({ le_s: z.number(), count: z.number() })),
    }),
  })
  .meta({ id: "ApiTelemetryLlm" });
export type TelemetryLlm = z.output<typeof TelemetryLlmSchema>;

/** One sample. Counters are totals since the process started; `events` count since the last one. */
export const TelemetryPointSchema = z
  .object({
    at: TimestampSchema,
    mood: MoodSchema.nullable(),
    boredom: z.number().nullable(),
    drives: DrivesSchema.nullable(),
    initiative: z.number().nullable(),
    llm: TelemetryLlmSchema,
    voice_sessions: z.number(),
    speaking: z.boolean(),
    /** `messages`, `turns`, `initiatives`, `utterances`, `actions` since the previous sample. */
    events: z.record(z.string(), z.number()),
  })
  .meta({ id: "ApiTelemetryPoint" });
export type TelemetryPoint = z.output<typeof TelemetryPointSchema>;

/** `GET /api/telemetry`: samples, oldest first. */
export const TelemetryViewSchema = z
  .object({ interval_ms: z.number(), points: z.array(TelemetryPointSchema) })
  .meta({ id: "ApiTelemetryView" });
export type TelemetryView = z.output<typeof TelemetryViewSchema>;

/** The samples of the last `minutes` (default 360, held to 1..1440). */
export const telemetry = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/telemetry" })
  .input(z.object({ query: z.object({ minutes: DigitsQuery.optional() }) }))
  .output(TelemetryViewSchema);
