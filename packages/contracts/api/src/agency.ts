// Her bounties on the member page: the session's person, and nobody else's.

import { z } from "zod";
import { route } from "./route.js";
import { SpaceQuery } from "./shared.js";

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
  /**
   * The bounties she has open in a server: `?space=` (`404` unknown, `403` not theirs), else their
   * own server (preferring the primary). Only a member there can be paid one.
   */
  bounties: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/bounties" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(BountyListSchema),
};
