// `GET /api/eval/live`: the live evaluation's history and the nightly run's state, for the
// panel's trend. The runs are read from `history.jsonl` in the `eval` module's out folder on every
// request; the file is small (one line a run). Without the module there is no folder to read.

import type { EvalLiveHistory } from "@miyoria/contracts/api";
import { os } from "../contract.js";
import { clampLimit, countOf } from "../extract.js";
import { readEvalHistory } from "./history.js";
import { EvalNightlyKey } from "./nightly.js";

export const DEFAULT_EVAL_RUNS = 90;
export const MAX_EVAL_RUNS = 1000;

export const evalRpc = {
  live: os.eval.live.handler(async ({ input, context }): Promise<EvalLiveHistory> => {
    const limit = clampLimit(countOf(input.query.limit), DEFAULT_EVAL_RUNS, MAX_EVAL_RUNS);
    const nightly = context.state.optional(EvalNightlyKey);
    if (nightly === undefined) {
      return { runs: [], nightly: { state: "off", time: null, next_at: null, running: false } };
    }
    return { runs: await readEvalHistory(nightly.outDir, limit), nightly: nightly.status() };
  }),
};
