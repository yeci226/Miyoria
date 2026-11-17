// Reads `history.jsonl` of the live evaluation: one `EvalLiveRunSchema` record per line, written
// by `pnpm eval --live` (tools/eval), which may be appending while this reads. Nothing here
// throws for what is in the folder: no folder, no file, a line that is not JSON, a line of
// another version and a last line that is only half written are all left out.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type EvalLiveRun, EvalLiveRunSchema } from "@miyoria/contracts/events";

export const EVAL_HISTORY_FILE = "history.jsonl";

/** The records in `text`, in file order. */
export function parseEvalHistory(text: string): EvalLiveRun[] {
  const runs: EvalLiveRun[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = EvalLiveRunSchema.safeParse(value);
    if (parsed.success) runs.push(parsed.data);
  }
  return runs;
}

/** The last `limit` runs in `dir`, oldest first; `[]` when there is no history to read. */
export async function readEvalHistory(dir: string, limit: number): Promise<EvalLiveRun[]> {
  let text: string;
  try {
    text = await readFile(join(dir, EVAL_HISTORY_FILE), "utf8");
  } catch {
    return [];
  }
  const runs = parseEvalHistory(text);
  return limit >= runs.length ? runs : runs.slice(runs.length - limit);
}
