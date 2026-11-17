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
import { os } from "./contract.js";

import { withWallet } from "./wallet.js";

export const NODE_ECONOMY_GOALS = "admin.economy.goals";

/** The reached-goal routes on the route table (`@miyoria/contracts/api`). */
export const goalAdminRpc = {
  goals: os.economy.goals.handler(async ({ context }) => ({
    goals: await withWallet(context.state, (e) => e.reachedGoals()),
  })),
  /** Needs `admin.economy.goals` (the route's permission). */
  fulfill: os.economy.fulfill.handler(async ({ input, context }) => {
    const { state, c } = context;
    const id = input.params.id;
    let goal: ReachedGoalView;
    try {
      goal = await withWallet(state, (economy) => economy.fulfillGoal(id, "owner"));
    } catch (error) {
      await state.audit(c, "economy.goal.fulfill", id, {}, false);
      throw error;
    }
    await state.audit(c, "economy.goal.fulfill", id, { title: goal.title }, true);
    return { goal };
  }),
};
