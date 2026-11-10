// Subject `guard`: the failure guard of the game director (`packages/game/src/guard.ts`), asked
// about the decisions she actually made. A failure starts the guard; a later decision whose
// action it withholds never runs (`blocked`). Open loop: the recorded decisions after a block
// would have been different, so this answers "which of her retries would the code have let
// through", not "what she would have done instead".

import {
  activeGuard,
  afterSuccess,
  defaultGameConfig,
  type FailureGuard,
  guardAfter,
} from "@miyoria/game";
import { ofType, type Trace } from "../trace.js";
import type { Subject } from "./types.js";

export const guardSubject: Subject = {
  run(fixture) {
    const cfg = defaultGameConfig();
    const steps = ofType(fixture.trace, "game_step");
    const out: Trace = [];
    let guard: FailureGuard | null = null;
    steps.forEach((step, i) => {
      const now = step.t * 1000;
      const held = activeGuard(guard, now)?.actions.includes(step.action) ?? false;
      if (held) {
        out.push({ ...step, blocked: true });
        return;
      }
      out.push(step);
      // The failure is reported with her next decision.
      const reported = (steps[i + 1]?.t ?? step.t + 1) * 1000;
      guard = step.failed
        ? guardAfter(cfg, step.detail ?? "failed", reported)
        : afterSuccess(guard, step.action, now);
    });
    return out;
  },
};
