// Her goals and bounties on the member page (docs/design/economy.md §13), through the `economy`
// module: the session's person, and nobody else's.
//
// * `GET /api/member/goals`: the goal she has open and the ones that ended lately (title, what she
//   promises, target, raised, this person's pledge, deadline, status). A stranger reads it too.
// * `POST /api/member/goals/:id/pledge` `{ amount }`: holds coins for the open goal; takes an
//   `Idempotency-Key`. A stranger (and a blocked person) gets 403 in the wallet's words.
// * `GET /api/member/bounties`: the bounties she has open.
//
// Responses are built field by field. The routes are on the route table (`agencyRpc`).

import {
  type BountyView,
  type Economy,
  EconomyError,
  EconomyKey,
  type GoalView,
  type PledgeResult,
} from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

const log = getLogger("api.agency");

const NO_AGENCY = "目標和懸賞現在打不開";

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

/** Runs `fn` against the economy; its refusals become their status and words. */
async function withEconomy<T>(state: ApiState, fn: (economy: Economy) => Promise<T>): Promise<T> {
  const economy = state.optional(EconomyKey);
  if (!economy) throw ApiError.unavailable(NO_AGENCY);
  try {
    return await fn(economy);
  } catch (error) {
    if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
    if (error instanceof ApiError) throw error;
    log.warn({ error: errorMessage(error) }, "the goals failed");
    throw ApiError.unavailable(NO_AGENCY);
  }
}

const goalView = (g: GoalView): GoalView => ({
  id: g.id,
  title: g.title,
  promise: g.promise,
  target: g.target,
  raised: g.raised,
  my_pledge: g.my_pledge,
  deadline: g.deadline,
  status: g.status,
  fulfilled: g.fulfilled,
});

const bountyView = (b: BountyView): BountyView => ({
  id: b.id,
  task: b.task,
  reward: b.reward,
  posted_at: b.posted_at,
  expires_at: b.expires_at,
});

const pledgeResult = (r: PledgeResult): PledgeResult => ({
  pledged: r.pledged,
  raised: r.raised,
  target: r.target,
  reached: r.reached,
  balance: r.balance,
  duplicate: r.duplicate,
});

/** The goal and bounty routes; served only while the public side is on (see `rpc.ts`). */
export const agencyRpc = {
  goals: os.agency.goals.handler(async ({ context: { state, c } }) => {
    const goals = await withEconomy(state, (e) => e.goals(accountOf(c)));
    return { goals: goals.map(goalView) };
  }),
  pledge: os.agency.pledge.handler(async ({ input, context: { state, c } }) => {
    const { amount } = input.body;
    const key = keyOf(input.headers["idempotency-key"]);
    const r = await withEconomy(state, (e) => e.pledge(accountOf(c), input.params.id, amount, key));
    return pledgeResult(r);
  }),
  bounties: os.agency.bounties.handler(async ({ context: { state } }) => {
    const bounties = await withEconomy(state, (e) => e.bounties());
    return { bounties: bounties.map(bountyView) };
  }),
};
