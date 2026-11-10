// The party games for the admin panel (docs/design/v4-plan.md §9.1), read-only:
//
// * `GET /api/party`: the games running now (with players and scores) and how the last ones ended.
//   Without the `party` module it is a 503 that names it, which is how the panel tells "party off"
//   from "no games right now" (an empty list).
//
// Nothing here reaches a game: what a game keeps hidden (an answer, the turtle-soup bottom) is
// not in the snapshot.

import { PartyOverviewKey } from "@miyoria/types";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";

export function partyRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/party",
      handler: async () => {
        const party = state.service(PartyOverviewKey, "party module");
        return json(party.snapshot());
      },
    },
  ];
}
