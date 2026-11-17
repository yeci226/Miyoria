// How she feels and what that does to her, read-only (docs/design/v2-architecture.md §3.5, §3.6):
// `GET /api/affect` (the `AffectState` snapshot: strongest emotions, derived mood, drives, the
// bias table "情緒 → 行為" and what she shows). How she feels about each person is the heart's
// row, served by `GET /api/people`.

import { AffectStateKey } from "@miyoria/types";
import { os } from "./contract.js";

/** The affect routes on the route table. */
export const affectRpc = {
  snapshot: os.affect.snapshot.handler(({ context }) =>
    context.state.service(AffectStateKey, "affect module").snapshot(),
  ),
};
