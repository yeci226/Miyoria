// Subject `attention`: who a line is for, as attention decides it (`directReason` of
// `packages/agent/src/attention.ts`, v4 §7.1). Every recorded line goes through it with what the
// platform said about it (a reply to her, whom it @-mentions, whether it opens with that); the
// verdict replaces the recorded one. Open loop: what she would have said instead is not asked,
// only whether the line would have been answered as if it were said to her.

import { directReason } from "@miyoria/agent";
import { z } from "zod";
import type { TraceEvent } from "../trace.js";
import type { Subject } from "./types.js";

type Message = Parameters<typeof directReason>[0];

const InputSchema = z.object({
  /** Her names, as the profile gives them. */
  names: z.array(z.string()).min(1),
});

/** The platform message a recorded line stands for: only what attention reads of it. */
function message(e: Extract<TraceEvent, { type: "heard" }>, i: number): Message {
  const context = { platform: "eval", scope: "guild", channel: "c", kind: "channel" };
  const others = (e.mentions ?? []).map((name) => ({
    account: { platform: "eval", id: name },
    display_name: name,
    is_bot: false,
  }));
  return {
    id: { context, id: `m${i}` },
    author: { account: { platform: "eval", id: e.who }, display_name: e.who, is_bot: false },
    text: e.text ?? "",
    mentions_self: false,
    reply_to_self: e.reply_to_her === true,
    attachments: [],
    ts: new Date(e.t * 1000).toISOString(),
    mentions_others: others,
    opens_with_other_mention: e.opens_with_mention === true,
  } as unknown as Message;
}

export const attentionSubject: Subject = {
  run(fixture) {
    const { names } = InputSchema.parse(fixture.input);
    const out: TraceEvent[] = [];
    fixture.trace.forEach((e, i) => {
      if (e.type === "addressed") return;
      out.push(e);
      if (e.type !== "heard") return;
      out.push({ type: "addressed", t: e.t, direct: directReason(message(e, i), names) !== null });
    });
    return out;
  },
};
