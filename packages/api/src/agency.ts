// Her bounties on the member page (docs/design/economy.md §13), through the `economy`
// module: the session's person, and nobody else's.
//
// * `GET /api/member/bounties` (`?space=`): the bounties she has open in a server they are in (their
//   own by default; someone who is a member nowhere reads the primary server's).
//
// Responses are built field by field. The routes are on the route table (`agencyRpc`).

import { type BountyView, type Economy, EconomyError, EconomyKey } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { memberSpaces } from "./play-routes.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.agency");

const NO_AGENCY = "懸賞現在打不開";

/** Runs `fn` against the economy; its refusals become their status and words. */
async function withEconomy<T>(state: ApiState, fn: (economy: Economy) => Promise<T>): Promise<T> {
  const economy = state.optional(EconomyKey);
  if (!economy) throw ApiError.unavailable(NO_AGENCY);
  try {
    return await fn(economy);
  } catch (error) {
    if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
    if (error instanceof ApiError) throw error;
    log.warn({ error: errorMessage(error) }, "the bounties failed");
    throw ApiError.unavailable(NO_AGENCY);
  }
}

const bountyView = (b: BountyView): BountyView => ({
  id: b.id,
  task: b.task,
  reward: b.reward,
  posted_at: b.posted_at,
  expires_at: b.expires_at,
});

/** The bounty route; served only while the public side is on (see `rpc.ts`). */
export const agencyRpc = {
  bounties: os.agency.bounties.handler(async ({ input, context: { state, c } }) => {
    const spaces = await memberSpaces(state, c, input?.query.space);
    const bounties = await withEconomy(state, (e) => e.bounties(spaces));
    return { bounties: bounties.map(bountyView) };
  }),
};
