// Rough token counts, for deciding when to compact. There is no tokenizer here: the ratios are the
// ones DeepSeek publishes for its tokenizer, about 0.6 a Chinese character and 0.3 any other. The
// same estimate is `estimateTokens` of `packages/brain/agent/src/mainline/prompt.ts`; it is
// repeated here because `brain` depends on `memory`, not the other way round.

import type { EntryInput } from "./types.js";

/** Tokens of `text`, roughly. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const c of text) {
    if (/\p{Script=Han}|[　-ヿ＀-￯]/u.test(c)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

/** What a message costs beyond its text (role, separators), roughly. */
const MESSAGE_OVERHEAD = 4;

/** Tokens an entry adds to a prompt, roughly: its name, text, calls and reasoning. */
export function entryTokens(entry: EntryInput): number {
  let text = `${entry.author ?? ""}${entry.content ?? ""}${entry.reasoning ?? ""}`;
  for (const call of entry.tool_calls ?? []) text += `${call.id}${call.name}${call.arguments}`;
  for (const image of entry.images ?? []) text += image.alt ?? "";
  return estimateTokens(text) + MESSAGE_OVERHEAD;
}
