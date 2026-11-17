// The live evaluation's history for the panel's trend: `GET /api/eval/live`. The runs are the
// lines of `history.jsonl` in the `eval` module's out folder (`EvalLiveRunSchema`, written by
// `pnpm eval --live`); the nightly state is the module's.

import { z } from "zod";
import { EvalLiveRunSchema } from "../../events/src/eval.js";
import { TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { DigitsQuery } from "./shared.js";

/**
 * Where the nightly run stands. `off`: no time is set (`[modules.eval] nightly`), or the module is
 * not running. `scheduled`: it runs at `time`. `no_checkout`: a time is set, but this install has
 * no `tools/eval` (the eval tool is only in a repository checkout), so nothing runs.
 */
export const EvalNightlyStateSchema = z
  .enum(["off", "scheduled", "no_checkout"])
  .meta({ id: "ApiEvalNightlyState" });
export type EvalNightlyState = z.output<typeof EvalNightlyStateSchema>;

export const EvalNightlySchema = z
  .object({
    state: EvalNightlyStateSchema,
    /** The configured local time, `HH:MM` (`null`: none). */
    time: z.string().nullable(),
    /** When it runs next (`null` unless `scheduled`). */
    next_at: TimestampSchema.nullable(),
    /** A run is going on now. */
    running: z.boolean(),
  })
  .meta({ id: "ApiEvalNightly" });
export type EvalNightly = z.output<typeof EvalNightlySchema>;

/** `GET /api/eval/live`. */
export const EvalLiveHistorySchema = z
  .object({
    /** The newest runs, oldest first. Lines that are not a run of a known version are left out. */
    runs: z.array(EvalLiveRunSchema),
    nightly: EvalNightlySchema,
  })
  .meta({ id: "ApiEvalLiveHistory" });
export type EvalLiveHistory = z.output<typeof EvalLiveHistorySchema>;

export const evalRoutes = {
  /** The last `limit` live runs (default 90, held to 1..1000) and the nightly run's state. */
  live: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/eval/live" })
    .input(z.object({ query: z.object({ limit: DigitsQuery.optional() }) }))
    .output(EvalLiveHistorySchema),
};
