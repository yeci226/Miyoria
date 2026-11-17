// What the host writes for her to read, beside the runner's own texts (`self/src/rules.ts`). The
// owner has not read these yet; each is a candidate for rules.ts, where they move once reviewed.

import { neutralize, safeName } from "@miyoria/types";

/** Why `say` does not DM: DMs go through `message_dm`, whose gate checks consent and limits. */
export const SAY_DM = "私訊不能用 say:用 message_dm 工具(to 填對方的名字)";

// Today's wording, as the old turn writes it (agent/turn.ts, mainline/prompt.ts, self-block.ts).

/** Title of the viewers' wishes (block 6). */
export const VIEWERS_TITLE = "觀眾的要求";
/** Title of the notices that came back (block 6): `noticesBlock`'s own first line. */
export const NOTICES_TITLE = "剛收到的結果(你之前做的事)";
/** The line before the tasks in flight (block 7). */
export const TASKS_HEAD = "手上的任務:";

/** Title of the lines around a replied-to message she cannot see (block 7). */
export const REPLY_AROUND_TITLE = "被回覆的那則和前後的話";
/** Tags of those lines (the old transcript's `前文` / `被回覆` / `後文`). */
export const REPLY_AROUND_TAGS = { before: "前文", after: "後文", replied: "被回覆" } as const;
/** When a replied-to message was, if unknown (only its quote came with the reply). */
export const REPLY_AROUND_UNDATED = "較早";

/** The line before them: whose reply it is. */
export function replyAroundHead(author: string): string {
  return `${safeName(author)} 回覆的那則訊息不在你看得到的對話裡,這是它和當時前後的話:`;
}

/** Why a line of a start of hers repeating what she said there lately was not said (the Floor's). */
export const REPEATED_LINE = "這件事你剛說過了,沒有新進展就不用再提";

/** Characters of the message quoted when someone asks her to answer it (the context menu). */
const ASKED_QUOTE_CHARS = 120;

/** Block 7's last part for a run someone asked for from the message's menu ("要她回這則"). */
export function askedLine(author: string, text: string): string {
  const flat = neutralize(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  const quote =
    chars.length > ASKED_QUOTE_CHARS ? `${chars.slice(0, ASKED_QUOTE_CHARS).join("")}…` : flat;
  return `有人請你回 ${safeName(author)} 的這則訊息:「${quote}」(不一定是對話紀錄最後一句)。當成對你說的回。`;
}
