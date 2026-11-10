// Her goals and bounties on the member page (docs/design/economy.md §13), through the `economy`
// module: the session's person, and nobody else's.
//
// * `GET /api/member/goals`: the goal she has open and the ones that ended lately (title, what she
//   promises, target, raised, this person's pledge, deadline, status). A stranger reads it too.
// * `POST /api/member/goals/:id/pledge` `{ amount }`: holds coins for the open goal; takes an
//   `Idempotency-Key`. A stranger (and a blocked person) gets 403 in the wallet's words.
// * `GET /api/member/bounties`: the bounties she has open.
//
// Responses are built field by field.

import {
  type BountyView,
  type Economy,
  EconomyError,
  EconomyKey,
  type GoalView,
  type PledgeResult,
} from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { type AccountRef, accountRefString } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { tooMany } from "./public.js";
import { json, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

const log = getLogger("api.agency");

const NO_AGENCY = "目標和懸賞現在打不開";

const PledgeSchema = z.strictObject({ amount: z.number().int().min(1).max(1_000_000) });

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

/** Runs `handler` unless this account has been asking too much. */
function limited(state: ApiState, handler: (c: ApiContext) => Promise<Response>) {
  return async (c: ApiContext): Promise<Response> => {
    const wait = state.publicSide.admitMember(accountRefString(accountOf(c)));
    return wait !== null ? tooMany(wait) : handler(c);
  };
}

/** The goal and bounty routes; none when `[modules.api.public] enabled` is off. */
export function agencyRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/member/goals",
      handler: limited(state, async (c) => {
        const goals = await withEconomy(state, (e) => e.goals(accountOf(c)));
        return json({ goals: goals.map(goalView) });
      }),
    },
    {
      method: "POST",
      path: "/api/member/goals/:id/pledge",
      handler: limited(state, async (c) => {
        const { amount } = await readJson(c, PledgeSchema);
        const key = keyOf(c);
        const id = c.req.param("id") ?? "";
        const r = await withEconomy(state, (e) => e.pledge(accountOf(c), id, amount, key));
        return json(pledgeResult(r));
      }),
    },
    {
      method: "GET",
      path: "/api/member/bounties",
      handler: limited(state, async () => {
        const bounties = await withEconomy(state, (e) => e.bounties());
        return json({ bounties: bounties.map(bountyView) });
      }),
    },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}
