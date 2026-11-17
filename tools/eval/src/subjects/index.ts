import type { Harness } from "../fixture.js";
import { attentionSubject } from "./attention.js";
import { guardSubject } from "./guard.js";
import { parserSubject } from "./parser.js";
import { ruleSubject } from "./rule.js";
import type { Subject } from "./types.js";
import { wishSubject } from "./wish.js";

export type { Subject, SubjectContext } from "./types.js";
export { attentionSubject, guardSubject, parserSubject, ruleSubject, wishSubject };

/** `trace` has no subject: there is no code to ask, only a recording to judge. */
export const SUBJECTS: Record<Exclude<Harness, "trace">, Subject> = {
  parser: parserSubject,
  guard: guardSubject,
  rule: ruleSubject,
  attention: attentionSubject,
  wish: wishSubject,
};
