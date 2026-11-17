// Tool calls and their results travel together: a provider rejects an assistant message whose
// calls are not all answered by the messages right after it, and a result that answers nothing.
// A crash between a call and its result, or a cut in the wrong place, would otherwise leave a
// transcript no request can be built from.

import type { TranscriptEntry } from "./types.js";

type Paired = Pick<TranscriptEntry, "kind" | "seq" | "tool_calls" | "tool_call_id">;

/**
 * `entries` (in order) with every call that has no result after it, and every result whose call
 * is not before it, taken out. A `tool_calls` entry left with no call becomes her plain line
 * (`self`) when it has text, and goes otherwise.
 */
export function pairedEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const e of entries) {
    if (e.kind === "tool_calls") for (const c of e.tool_calls) called.add(c.id);
    else if (e.kind === "tool_result" && e.tool_call_id !== null && called.has(e.tool_call_id)) {
      answered.add(e.tool_call_id);
    }
  }
  const out: TranscriptEntry[] = [];
  const kept = new Set<string>();
  for (const e of entries) {
    if (e.kind === "tool_result") {
      // One result per call: a second answer to the same call is as unusable as an orphan.
      if (e.tool_call_id === null || !answered.has(e.tool_call_id) || kept.has(e.tool_call_id)) {
        continue;
      }
      kept.add(e.tool_call_id);
      out.push(e);
    } else if (e.kind === "tool_calls") {
      const calls = e.tool_calls.filter((c) => answered.has(c.id));
      if (calls.length === e.tool_calls.length) out.push(e);
      else if (calls.length > 0) out.push({ ...e, tool_calls: calls });
      else if (e.content.trim() !== "") out.push({ ...e, kind: "self", tool_calls: [] });
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Whether cutting `entries` (in order) after sequence `upto` parts a call from its result: a call
 * at or before `upto` answered after it.
 */
export function splitsPair(entries: readonly Paired[], upto: number): boolean {
  const before = new Set<string>();
  for (const e of entries) {
    if (e.kind === "tool_calls" && e.seq <= upto) for (const c of e.tool_calls) before.add(c.id);
  }
  return entries.some(
    (e) =>
      e.kind === "tool_result" &&
      e.seq > upto &&
      e.tool_call_id !== null &&
      before.has(e.tool_call_id),
  );
}
