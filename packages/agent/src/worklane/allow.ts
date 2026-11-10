// What a work-lane task may call (docs/design/v4-plan.md §4.3 "能用的" / "不能做的").
//
// The allowance is decided once, when the task starts, by code and never by the model: the tools
// configured for the lane (`[modules.agent.work] tools`), of those the ones registered now, of
// those the ones the Directives' filter offers in the place the task was started from, and of those
// the ones she asked for. Anything that says something to someone is never in it, whatever the
// config lists: a task has no mouth (§3 item 7, §15). A call outside the allowance is answered with
// a refusal and never runs.

import { CapabilityTool } from "@miyoria/actions";
import type { Tool } from "@miyoria/tools";
import type { ContextKey, Directives } from "@miyoria/types";

/**
 * Tools that talk, post, spend, perform or move her somewhere, by name: never a task's. Kept as
 * prefixes so a new tool of the same family (`party_*`, `voice_*`) is covered the day it appears.
 */
const TALKING = [
  "react",
  "keep_note",
  "drop_note",
  "message_",
  "chat_",
  "voice_",
  "sing_",
  "stream_",
  "stage_",
  "party_",
  "game_",
  "work_",
  "remind_",
  "give_",
  "treat_",
  "buy_",
  "draw_",
  "fund_",
  "post_",
  "award_",
  "place_",
  "open_",
  "resolve_",
  "cancel_",
  "accept_",
  "make_",
  "deal_",
  "commission_",
  "deliver_",
  "decline_",
  "checkin_",
  "complete_",
  "channel_",
];

/** Whether `tool` says something to someone (or acts where people are): never a task's. */
export function talks(name: string, tool?: Tool): boolean {
  if (TALKING.some((p) => (p.endsWith("_") ? name.startsWith(p) : name === p))) return true;
  if (tool instanceof CapabilityTool) {
    const c = tool.capability;
    // Directed at a person, or something a person can withdraw consent for: it reaches someone.
    if (c.consent != null || typeof c.target === "function") return true;
  }
  return false;
}

export interface AllowanceInput {
  /** `[modules.agent.work] tools`. */
  configured: readonly string[];
  /** The registry's tools now. */
  tool(name: string): Tool | undefined;
  directives: Directives | null;
  context: ContextKey | null;
  /** What she asked for (`null`: everything she may have). */
  wanted: readonly string[] | null;
}

/** The tools a task started in `context` may call, sorted. */
export function allowance(input: AllowanceInput): string[] {
  const wanted = input.wanted === null ? null : new Set(input.wanted);
  const candidates = input.configured.filter((name) => {
    const tool = input.tool(name);
    return tool !== undefined && !talks(name, tool) && (wanted === null || wanted.has(name));
  });
  const specs = candidates.map((name) => ({ name }));
  const offered = input.directives?.filterTools(specs, input.context) ?? specs;
  return [...new Set(offered.map((s) => s.name))].sort();
}
