// Her reached goals for the owner (docs/design/economy.md §13): a goal people filled is a promise
// she owes until it is marked kept.
//
// * `GET /api/economy/goals`: the reached goals, newest first, with whether each was kept.
// * `POST /api/economy/goals/{id}/fulfill` `{}`: the owner marks one kept. Needs
//   `admin.economy.goals` (the bearer token has every right). 409 when it is not a reached goal or
//   was marked already (by her `goal_done`, say): the first mark stands.
//
// Through the economy module's `Economy`; without it, 503.

import type { ReachedGoalView } from "@miyoria/economy";
import { AuthorizerKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { json, param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";
import { withWallet } from "./wallet.js";

export const NODE_ECONOMY_GOALS = "admin.economy.goals";

const NoBody = z.strictObject({});

function requireNode(state: ApiState, c: ApiContext): void {
  const principal = c.get("principal");
  if (principal.kind === "token") return;
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer?.allows(principal.record.account, NODE_ECONOMY_GOALS)) {
    throw new ApiError(403, `this needs \`${NODE_ECONOMY_GOALS}\``);
  }
}

async function fulfill(state: ApiState, c: ApiContext): Promise<Response> {
  requireNode(state, c);
  await readJson(c, NoBody);
  const id = param(c, "id");
  let goal: ReachedGoalView;
  try {
    goal = await withWallet(state, (economy) => economy.fulfillGoal(id, "owner"));
  } catch (error) {
    await state.audit(c, "economy.goal.fulfill", id, {}, false);
    throw error;
  }
  await state.audit(c, "economy.goal.fulfill", id, { title: goal.title }, true);
  return json({ goal });
}

export function goalAdminRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/economy/goals",
      handler: async () => json({ goals: await withWallet(state, (e) => e.reachedGoals()) }),
    },
    { method: "POST", path: "/api/economy/goals/:id/fulfill", handler: (c) => fulfill(state, c) },
  ];
}
