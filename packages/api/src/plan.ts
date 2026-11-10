// What she wants to do, read-only (docs/design/v2-architecture.md §3.7): `GET
// /api/mind/goals?closed=false` (her structured agenda, soonest trigger first; `closed=true`
// adds the ones that are done or dropped when the agenda keeps them) and `GET /api/mind/plan`
// (today's plan in her words). The agenda service and the mind loop are looked up for the
// optional getters `all()` and `dayPlan()` that their contract does not list.

import { type Goal, GoalAgendaKey, MindKey } from "@miyoria/types";
import { z } from "zod";
import { boolParam, readQuery } from "./extract.js";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";
import type { DayPlanView, GoalsView } from "./types.js";

const GoalsQuerySchema = z.object({ closed: boolParam.optional() });

/** `GoalBook.all()`, when the agenda is one. */
function allGoals(agenda: object): (() => Goal[]) | null {
  const all = (agenda as { all?: unknown }).all;
  return typeof all === "function" ? (all as () => Goal[]).bind(agenda) : null;
}

export function planRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/mind/goals",
      handler: (c) => {
        const q = readQuery(c, GoalsQuerySchema);
        const agenda = state.service(GoalAgendaKey, "goal agenda");
        const all = allGoals(agenda);
        const open = agenda.goals();
        if (!q.closed || all === null) {
          const body: GoalsView = { goals: open, closed_included: false };
          return json(body);
        }
        const openIds = new Set(open.map((g) => g.id));
        const closed = all().filter((g) => !openIds.has(g.id));
        const body: GoalsView = { goals: [...open, ...closed], closed_included: true };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/mind/plan",
      handler: () => {
        const mind = state.service(MindKey, "mind module") as { dayPlan?: () => string | null };
        const body: DayPlanView = {
          day_plan: typeof mind.dayPlan === "function" ? mind.dayPlan() : null,
        };
        return json(body);
      },
    },
  ];
}
