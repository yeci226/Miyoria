// How she feels and what that does to her, read-only (docs/design/v2-architecture.md §3.5, §3.6):
// `GET /api/affect` (the `AffectState` snapshot: strongest emotions, derived mood, drives, the
// bias table "情緒 → 行為" and what she shows) and `GET /api/affect/people` (one card per
// person, highest attachment first). Bond changes stay with her own reflection and the people
// routes (`/api/people/{id}/adjust`).

import { AffectStateKey } from "@miyoria/types";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";

export function affectRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/affect",
      handler: () => json(state.service(AffectStateKey, "affect module").snapshot()),
    },
    {
      method: "GET",
      path: "/api/affect/people",
      handler: () => json(state.service(AffectStateKey, "affect module").cards()),
    },
  ];
}
