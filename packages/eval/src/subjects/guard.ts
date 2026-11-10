// Subject `guard`: the method guard of the game director (`packages/game/src/methods.ts`, v4
// plan §11.2 item 5), asked about the decisions she actually made. A method (action and item)
// that failed the same way twice is held; a later decision of a held method never runs
// (`blocked`). A success of the same method ends its hold. Open loop: the recorded decisions after
// a block would have been different, so this answers "which of her retries would the code have
// let through", not "what she would have done instead".
//
// The recorded steps carry the game's answer as text, not its failure code, so the code is read
// back from that text (`failureCode`).

import { defaultGameConfig, MethodGuard, methodKey } from "@miyoria/game";
import { ofType, type Trace } from "../trace.js";
import type { Subject } from "./types.js";

/** The failure code the game's answer text stands for (the incidents were logged without it). */
export function failureCode(detail: string | undefined): string {
  if (detail === undefined) return "failed";
  if (detail.startsWith("參數不對")) return "invalid";
  if (detail.startsWith("材料不夠")) return "precondition";
  if (/took longer|timeout|逾時/i.test(detail)) return "timeout";
  if (/no path|找不到/i.test(detail)) return "not_found";
  return "failed";
}

export const guardSubject: Subject = {
  run(fixture) {
    const guard = new MethodGuard(defaultGameConfig());
    const out: Trace = [];
    const steps = ofType(fixture.trace, "game_step");
    steps.forEach((step, i) => {
      const now = step.t * 1000;
      const method = methodKey(step.action, step.target === undefined ? {} : { item: step.target });
      if (guard.held(method, now)) {
        out.push({ ...step, blocked: true });
        return;
      }
      out.push(step);
      // The failure is reported with her next decision.
      const reported = (steps[i + 1]?.t ?? step.t + 1) * 1000;
      if (step.failed) guard.failed(method, failureCode(step.detail), step.detail ?? "", reported);
      else guard.progressed(method);
    });
    return out;
  },
};
