// The Spaces (servers) she is in, for the space pickers (docs/design/v5-places.md §6): every one with
// the primary flag for the admin side, and the logged-in person's own for the member pages. A Space
// id here is identity's (`spaces.id`), the one a route's `?space=` takes (`SpaceQuery`).

import { z } from "zod";
import { route } from "./route.js";

/** One Space as a picker shows it. */
export const SpaceSchema = z
  .object({
    /** Identity's id: what `?space=` takes. */
    id: z.string(),
    platform: z.string(),
    /** The platform's id (the Discord guild id). */
    external_id: z.string(),
    name: z.string(),
    /** The install's original server: the default where none is chosen. */
    primary: z.boolean(),
    /**
     * A server she was already in when servers were told apart (the primary always is): it goes on
     * with the cluster's settings. `false`: a server she joined later, quiet until it is set up.
     */
    established: z.boolean(),
  })
  .meta({ id: "ApiSpace" });
export type Space = z.output<typeof SpaceSchema>;

/** A Space on the admin side, with how many people are members there. */
export const AdminSpaceSchema = SpaceSchema.extend({ members: z.number().int() }).meta({
  id: "ApiAdminSpace",
});
export type AdminSpace = z.output<typeof AdminSpaceSchema>;

/**
 * `GET /api/places/spaces`: every Space she is in, primary first. `default` is what an admin page
 * shows with no `?space=`: the primary, else the first one; `null` when she is in none.
 */
export const AdminSpacesSchema = z
  .object({ spaces: z.array(AdminSpaceSchema), default: z.string().nullable() })
  .meta({ id: "ApiAdminSpaces" });
export type AdminSpaces = z.output<typeof AdminSpacesSchema>;

/**
 * `GET /api/member/spaces`: the Spaces the logged-in person is a member of, primary first.
 * `default` is the one a member route uses without `?space=`: the primary if they are in it, else
 * their first; for someone in none, the primary (as before there were several); `null` when she is
 * in no Space at all.
 */
export const MemberSpacesSchema = z
  .object({ spaces: z.array(SpaceSchema), default: z.string().nullable() })
  .meta({ id: "ApiMemberSpaces" });
export type MemberSpaces = z.output<typeof MemberSpacesSchema>;

/** Admin: every Space (in the `places` group, beside the channel picker's rooms). */
export const placesSpaces = {
  spaces: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/places/spaces" })
    .output(AdminSpacesSchema),
};

/** Member: their own Spaces (in the `member` group). */
export const memberSpaces = {
  spaces: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/spaces" })
    .output(MemberSpacesSchema),
};
