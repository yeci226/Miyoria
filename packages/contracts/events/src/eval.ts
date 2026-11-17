// The live evaluation on the record (docs/design/v5-brain.md, B1): one run of the live suites
// (`pnpm eval --live`) as its summary. The same shape is one line of `history.jsonl` in the run's
// out folder, which stays the source of truth: the file is written by the eval tool, read by the
// API for the panel's trend, and published by the `eval` module as `eval.run` after a nightly run.
//
// A run names commits, models and what it cost: for the owner (`owner`). It is small, there is one
// a day at most, and the trend is read over months (`keep`).

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** The model calls of a run, added up: the subject's and the judge's. */
export const EvalLiveTokensSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    reasoning_tokens: z.number(),
  })
  .meta({ id: "EventsEvalLiveTokens" });
export type EvalLiveTokens = z.output<typeof EvalLiveTokensSchema>;

/** One suite of a run. */
export const EvalLiveSuiteSchema = z
  .object({
    /** The suite's numbers, each between 0 and 1 (`null`: nothing could be scored). */
    headline: z.record(z.string(), z.number().nullable()),
    /** Items that ran (an item run `repeat` times counts that often). */
    items: z.number(),
    /** Items the subject could not be shown; never counted as pass or fail. */
    unsupported: z.number(),
    /** The run's limit was reached in or before this suite: its numbers are of what finished. */
    stopped: z.boolean(),
  })
  .meta({ id: "EventsEvalLiveSuite" });
export type EvalLiveSuite = z.output<typeof EvalLiveSuiteSchema>;

/** The version of `EvalLiveRunSchema` a line is written with. */
export const EVAL_LIVE_RUN_VERSION = 1;

/** One live run: a line of `history.jsonl`, and the data of `eval.run`. */
export const EvalLiveRunSchema = z
  .object({
    v: z.literal(EVAL_LIVE_RUN_VERSION),
    /** When the run started. */
    at: TimestampSchema,
    /** The git commit the run is of (`null`: unknown). */
    commit: z.string().nullable(),
    /** Which brain was measured (`current`). */
    subject: z.string(),
    /** How many times every item was run. */
    repeat: z.number(),
    /** The suites that ran, by name (`persona`, `tools`, `relationship`, `memory`). */
    suites: z.record(z.string(), EvalLiveSuiteSchema),
    tokens: EvalLiveTokensSchema,
    /** Estimated cost in USD (`null`: a model that answered has no price, so it is unknown). */
    usd: z.number().nullable(),
    duration_ms: z.number(),
    /**
     * The `chat` chain the run was routed through, first choice first (`provider:model`); for a
     * run that did not record it, the models that answered.
     */
    models: z.array(z.string()),
    /** `budget`: the run's limit was reached and what is here is partial. */
    stopped: z.enum(["budget"]).nullable(),
  })
  .meta({ id: "EventsEvalLiveRun" });
export type EvalLiveRun = z.output<typeof EvalLiveRunSchema>;

/** A live run finished and its line is in `history.jsonl`: `eval.run`. */
export const EvalRun = defineEvent({
  type: "eval.run",
  v: 1,
  data: EvalLiveRunSchema,
  scope: "owner",
  tier: "keep",
});

/** Every evaluation type. */
export const EVAL_EVENTS = [EvalRun] as const;
