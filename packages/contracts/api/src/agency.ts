// Her bounties on the member page: the session's person, and nobody else's.

import { z } from "zod";
import { route } from "./route.js";

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
  bounties: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/bounties" })
    .output(BountyListSchema),
};
