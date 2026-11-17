// The heart's rows (`heart_person`, the store's `heart` plugin) for the routes that read or edit
// how she feels about someone: the people routes, the member page, the affect and inner pages.

import { type HeartStore, heartTables } from "@miyoria/heart/person";
import { StoreKey } from "@miyoria/store";
import type { ApiState } from "./state.js";

/** The heart's rows; `null` without a store. */
export function heartRows(state: ApiState): HeartStore | null {
  return state.optional(StoreKey)?.plugin(heartTables).people ?? null;
}
