import type { Fixture } from "../fixture.js";
import type { Trace } from "../trace.js";

export interface SubjectContext {
  /** 0 for the first run of a fixture, 1.. for the next ones of pass^k. */
  attempt: number;
  /** `MIYORIA_EVAL_LIVE=1`: a subject that calls a model may do so; the others ignore it. */
  live: boolean;
}

/** A part of the code asked what it does with a fixture's stimulus. */
export interface Subject {
  run(fixture: Fixture, ctx: SubjectContext): Trace;
}
