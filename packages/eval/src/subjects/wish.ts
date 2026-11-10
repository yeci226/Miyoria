// Subject `wish`: one wish, asked once (`WishBook` of `packages/arbiter/src/wishes.ts`, v4 §2.4,
// §7.6). The recorded run goes through the book in order: whatever holds a wish of hers (a
// proposal, a commitment, a goal of her Plan) registers with it, what the person says is the
// observation the book follows ("you asked me already" closes it, an answer after she asked
// closes it), and each time she asked them something the book is asked first whether the wish may
// be raised now (`screen`). A question it would not let her raise is dropped: in the running
// system the turn is refused (`MainTurn.take`) or the proposal is dropped before the Floor.
// Open loop: what she would have said instead is not asked.
//
// The book lives in the arbiter, which this package does not depend on; it is imported from its
// source so the case runs the code that runs live, not a copy of its rules.

import { WishBook } from "../../../arbiter/src/wishes.js";
import type { Trace } from "../trace.js";
import type { Subject } from "./types.js";

type LogEvent = Parameters<WishBook["apply"]>[0];

/** The arbiter's defaults (`[modules.arbiter.wishes]`). */
const CONFIG = { followup_hours: 12, keep_hours: 48 };
/** Where `t = 0` of a fixture is: any fixed time, the book only compares times. */
const BASE = Date.UTC(2026, 10, 10, 1, 7, 0);

/** What the person said, as the fact layer logs a line of theirs. */
function observation(at: number, who: string, text: string, n: number): LogEvent {
  return {
    id: `o${n}`,
    at: new Date(at).toISOString(),
    kind: "observation",
    source: "platform.text",
    cause: null,
    context: null,
    person: who,
    body: {
      observation: {
        source: "platform.text",
        silent: false,
        salience: "normal",
        attention_key: `msg:o${n}`,
        revision: 1,
        summary: `${who}:${text}`,
        addressed_to_her: false,
        from: who,
        context: null,
      },
      buckets: [],
      speech: true,
      origin: null,
    },
  } as unknown as LogEvent;
}

export const wishSubject: Subject = {
  async run(fixture) {
    let now = BASE;
    const book = new WishBook(CONFIG, { now: () => now });
    const out: Trace = [];
    let n = 0;
    for (const e of fixture.trace) {
      now = BASE + e.t * 1000;
      if (e.type === "wish") {
        book.hold(e.person, e.text, e.holder);
      } else if (e.type === "heard") {
        book.apply(observation(now, e.who, e.text ?? "", n++));
      } else if (e.type === "said" && e.to !== undefined) {
        const verdict = await book.screen({ person: e.to, text: e.text });
        if (!verdict.raise) continue;
        if (verdict.wish !== null) book.asked(verdict.wish.key, now);
      }
      out.push(e);
    }
    return out;
  },
};
