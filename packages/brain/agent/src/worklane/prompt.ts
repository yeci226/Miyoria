// How a work-lane task's end is told (v4 §4.3 "回報": how it ended, its conclusion and what it
// did), as the detail of its task event.
//
// Text people read is Traditional Chinese with half-width punctuation.

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** The label of how it ended, as she is told. */
export const END_LABEL = {
  done: "做完了",
  gave_up: "放棄了",
  stopped: "停掉了",
  out_of_budget: "預算用完了",
} as const;

/** How a task ended: the end, the conclusion, what it did, in a few lines. */
export function report(input: {
  goal: string;
  end: keyof typeof END_LABEL;
  result: string | null;
  did: readonly string[];
  resultChars: number;
  didLines: number;
}): string {
  const lines = [`任務「${cut(input.goal, 60)}」${END_LABEL[input.end]}`];
  const result = input.result?.trim() ?? "";
  if (result !== "") {
    const label =
      input.end === "done" ? "結論" : input.end === "out_of_budget" ? "目前的成果" : "原因";
    lines.push(`${label}:${cut(result, input.resultChars)}`);
  }
  const did = [...new Set(input.did)];
  if (did.length > 0) {
    const shown = did.slice(-input.didLines);
    const more = did.length > shown.length ? `等 ${did.length} 件` : "";
    lines.push(`做了:${shown.join(";")}${more}`);
  }
  return lines.join("\n");
}
