// The model call that writes a transcript's summary when it is compacted (`compactIfNeeded`),
// on the router's `summarizer` purpose. The entries are shown the way a request shows them
// (`toMessages`: names and other people's text made inert), inside data blocks.

import { contentText, systemMessage, userMessage } from "@miyoria/llm/llm";
import {
  type SpeakerNames,
  type Summarise,
  type TranscriptEntry,
  toMessages,
} from "@miyoria/memory/transcript";
import { dataBlock } from "@miyoria/types";
import {
  SUMMARY_CALL,
  SUMMARY_ENTRIES,
  SUMMARY_PREVIOUS,
  SUMMARY_RESULT,
  SUMMARY_RULES,
  SUMMARY_SELF,
} from "./rules.js";
import type { RunModel } from "./types.js";

/** One tool result is shown up to this many characters: the summary needs what it said, not all of it. */
const MAX_RESULT_CHARS = 1200;

/** `entries` as plain text, oldest first; people by her handles for them when `names` knows. */
export function summaryText(
  entries: readonly TranscriptEntry[],
  names: SpeakerNames | null = null,
): string {
  const session = entries[0]?.session ?? "";
  const lines: string[] = [];
  const tail = { session, summary: null, entries: [...entries] };
  for (const m of toMessages(tail, { gapMs: 0, names })) {
    const text = contentText(m.content).trim();
    if (m.role === "assistant") {
      if (text !== "") lines.push(`${SUMMARY_SELF}: ${text}`);
      for (const call of m.tool_calls)
        lines.push(`${SUMMARY_CALL} ${call.name}(${call.arguments})`);
    } else if (m.role === "tool") {
      const chars = [...text];
      const shown =
        chars.length > MAX_RESULT_CHARS ? `${chars.slice(0, MAX_RESULT_CHARS).join("")}…` : text;
      lines.push(`${SUMMARY_RESULT}: ${shown}`);
    } else if (text !== "") {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

/** A `Summarise` that asks `model`. An empty answer throws: no summary is better than a blank one. */
export function modelSummarise(model: RunModel, signal?: AbortSignal): Summarise {
  return async (entries, previous, names) => {
    const blocks: string[] = [];
    if (previous !== null && previous.trim() !== "") {
      blocks.push(dataBlock("transcript", SUMMARY_PREVIOUS, previous));
    }
    blocks.push(dataBlock("transcript", SUMMARY_ENTRIES, summaryText(entries, names ?? null)));
    const response = await model.complete(
      "summarizer",
      {
        messages: [systemMessage(SUMMARY_RULES), userMessage(blocks.join("\n\n"))],
        reasoning_purpose: "summarizer",
      },
      signal,
    );
    const text = response.text.trim();
    if (text === "") throw new Error("the summariser gave no text");
    return text;
  };
}
