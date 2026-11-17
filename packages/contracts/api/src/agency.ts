// Her goals and bounties on the member page: the session's person, and nobody else's. A stranger
// reads the goals too; a pledge from a stranger (or a blocked person) gets 403 in the wallet's words.

import { z } from "zod";
import { IdempotencyHeaders, route } from "./route.js";

/** One of her goals. */
export const GoalViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    /** What she will do when it is reached. */
    promise: z.string(),
    target: z.number(),
    raised: z.number(),
    /** What this person put in. */
    my_pledge: z.number(),
    /** When it ends if it has not been reached. */
    deadline: z.string(),
    status: z.enum(["open", "reached", "expired", "cancelled"]),
    /** A reached goal whose promise she kept. */
    fulfilled: z.boolean(),
  })
  .meta({ id: "ApiGoalView" });
export type GoalView = z.output<typeof GoalViewSchema>;

/** `GET /api/member/goals`: the goal she has open and the ones that ended lately. */
export const GoalListSchema = z
  .object({ goals: z.array(GoalViewSchema) })
  .meta({ id: "ApiGoalList" });
export type GoalList = z.output<typeof GoalListSchema>;

/** Body of `POST /api/member/goals/{id}/pledge`. */
export const PledgeRequestSchema = z
  .strictObject({ amount: z.number().int().min(1).max(1_000_000) })
  .meta({ id: "ApiPledgeRequest" });
export type PledgeRequest = z.input<typeof PledgeRequestSchema>;

/** What a pledge did. */
export const PledgeResultSchema = z
  .object({
    /** What was held (less than asked when the goal needed less). */
    pledged: z.number(),
    raised: z.number(),
    target: z.number(),
    /** This pledge met the target. */
    reached: z.boolean(),
    balance: z.number(),
    /** The key was used before: nothing new was held. */
    duplicate: z.boolean(),
  })
  .meta({ id: "ApiPledgeResult" });
export type PledgeResult = z.output<typeof PledgeResultSchema>;

/** One bounty she has open. */
export const BountyViewSchema = z
  .object({
    id: z.string(),
    task: z.string(),
    reward: z.number(),
    posted_at: z.string(),
    expires_at: z.string(),
  })
  .meta({ id: "ApiBountyView" });
export type BountyView = z.output<typeof BountyViewSchema>;

/** `GET /api/member/bounties`. */
export const BountyListSchema = z
  .object({ bounties: z.array(BountyViewSchema) })
  .meta({ id: "ApiBountyList" });
export type BountyList = z.output<typeof BountyListSchema>;

export const agency = {
  goals: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/goals" })
    .output(GoalListSchema),
  /** Holds coins for the open goal. */
  pledge: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/goals/{id}/pledge" })
    .input(
      z.object({
        params: z.object({ id: z.string() }),
        headers: IdempotencyHeaders,
        body: PledgeRequestSchema,
      }),
    )
    .output(PledgeResultSchema),
  bounties: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/bounties" })
    .output(BountyListSchema),
};
