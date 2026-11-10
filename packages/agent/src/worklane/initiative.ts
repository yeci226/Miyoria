// Her own initiative as work (docs/design/v4-plan.md §8.2, §8.1 "每個活動都是工作車道上的一個任務").
//
// Her mind picks a row of her activity table and proposes the capability that does it: `web.search`
// for browsing, `workspace.write` or `code.run` for a program, `notebook.write` for tidying her
// notes, `skill.run` for a skill. Proposed as it is, that becomes one call in one turn: one search,
// then nothing. A proposal of hers whose capability is work becomes a proposal to start a work-lane
// task instead (`work.start`), with the same id, what and why, so it is the same wish on the same
// board: the Directives screen it, the Arbiter and the Floor decide when a turn takes it up, and
// that turn decides whether to start it. Only the capability and its arguments change.

import type { NewProposal, ProposalBoard, ProposalOutcome } from "@miyoria/types";
import { isJsonObject, WORK_START } from "@miyoria/types";

/** Capabilities that are work, and the row of her activity table each one is. */
export const WORK_ACTIVITIES: Readonly<Record<string, string>> = {
  "web.search": "browse",
  "web.read": "browse",
  "code.run": "code",
  "workspace.write": "code",
  "workspace.run": "code",
  "skill.run": "code",
  "skill.write": "code",
  "notebook.write": "recap",
};

/** The tools a task of each row wants (the allowance still decides what it gets). */
export const ACTIVITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  browse: ["web_search", "web_read", "recall", "notebook_read", "notebook_write"],
  code: [
    "code_run",
    "workspace_list",
    "workspace_read",
    "workspace_write",
    "workspace_run",
    "workspace_save_script",
    "skill_list",
    "skill_read",
    "skill_write",
    "web_search",
    "web_read",
  ],
  recap: ["notebook_read", "notebook_write", "recall"],
};

/** Writers whose proposals are her own wishes (not a game's draft, not a memory followup). */
const OWN_SOURCES = new Set(["plan", "agenda"]);

/** `proposal` as a work-lane task when it is a wish of hers to do work, else as it is. */
export function asWork(proposal: NewProposal): NewProposal {
  const capability = proposal.capability;
  if (capability === undefined || !OWN_SOURCES.has(proposal.source)) return proposal;
  const activity = WORK_ACTIVITIES[capability];
  if (activity === undefined) return proposal;
  const raw = proposal.args ?? null;
  // What the one call would have looked up becomes part of the goal.
  const query = isJsonObject(raw) && typeof raw.query === "string" ? raw.query.trim() : "";
  const about = query === "" ? "" : `(從「${query}」開始)`;
  return {
    ...proposal,
    capability: WORK_START,
    args: {
      goal: `${proposal.what}${about}`,
      activity,
      tools: [...(ACTIVITY_TOOLS[activity] ?? [])],
    },
  };
}

/** The board her mind writes to, turning her wishes to work into work-lane tasks. */
export function workBoard(board: ProposalBoard, enabled: () => boolean): ProposalBoard {
  return {
    propose(proposal: NewProposal, signal?: AbortSignal): Promise<ProposalOutcome> {
      return board.propose(enabled() ? asWork(proposal) : proposal, signal);
    },
    open: (context) => board.open(context),
  };
}
