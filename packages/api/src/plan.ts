// What she wants to do, read-only (docs/design/v2-architecture.md §3.7): `GET
// /api/mind/goals?closed=false` (her structured agenda, soonest trigger first; `closed=true`
// adds the ones that are done or dropped when the agenda keeps them). The agenda service is
// looked up for the optional getter `all()` that its contract does not list.

import type { GoalsView } from "@miyoria/contracts/api";
import { type Goal, GoalAgendaKey } from "@miyoria/types";
import { os } from "./contract.js";

/** `GoalBook.all()`, when the agenda is one. */
function allGoals(agenda: object): (() => Goal[]) | null {
  const all = (agenda as { all?: unknown }).all;
  return typeof all === "function" ? (all as () => Goal[]).bind(agenda) : null;
}

/** The plan routes, which join the `mind` group of the route table. */
export const planRpc = {
  goals: os.mind.goals.handler(({ input, context }): GoalsView => {
    const closed = input.query.closed === "true";
    const agenda = context.state.service(GoalAgendaKey, "goal agenda");
    const all = allGoals(agenda);
    const open = agenda.goals();
    if (!closed || all === null) return { goals: open, closed_included: false };
    const openIds = new Set(open.map((g) => g.id));
    const shut = all().filter((g) => !openIds.has(g.id));
    return { goals: [...open, ...shut], closed_included: true };
  }),
};
