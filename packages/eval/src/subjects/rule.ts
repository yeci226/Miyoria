// Subject `rule`: the owner's rule as the directive service matches it (`covers`). Given the rule
// that 「不要玩 Minecraft」 becomes, every request of the recorded run is asked again: a request the
// rule covers is denied from the moment the owner said it. This is the enforcement layer only;
// whether the rule is written at all is the main line's choice (fixture
// `mc-owner-rule-never-written`).

import { covers, isStopping, subjectsOf } from "@miyoria/directive";
import { z } from "zod";
import { ofType, type TraceEvent } from "../trace.js";
import type { Subject } from "./types.js";

const InputSchema = z.object({
  scope: z.object({ capability: z.string().optional(), activity: z.string().optional() }),
});

export const ruleSubject: Subject = {
  run(fixture) {
    const { scope } = InputSchema.parse(fixture.input);
    const from = ofType(fixture.trace, "heard").find((h) => h.intent === "prohibition")?.t ?? 0;
    return fixture.trace.map((e): TraceEvent => {
      if (e.type !== "gate" || e.t < from) return e;
      const denied = covers(scope, {
        names: [e.capability],
        subjects: subjectsOf(e.args),
        context: null,
        people: [],
        stopping: isStopping(e.capability),
      });
      return denied ? { ...e, allowed: false } : e;
    });
  },
};
