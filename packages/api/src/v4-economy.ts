// Economy 2.0 for the admins (docs/design/v4-plan.md §10), read-only, about the whole economy and
// never about one person's coins (`people-wallet.ts` has those):
//
// * `GET /api/economy2/health`: coins issued against recovered per day. `available: false` until a
//   store provides the ledger totals; then there are no days, not made-up ones.
// * `GET /api/economy2/commissions`: what people commissioned that she has not handed in.
// * `GET /api/economy2/predictions`: open predictions and the ones settled lately (without anyone's
//   stake).
// * `GET /api/economy2/room`: her room, every item with how far the audience got.
// * `GET /api/people/{id}/quests`: today's three quests as that person sees them.
//
// Read through `Economy2Key`, which the economy module provides. Every answer carries the
// currency's name.

import { type Economy2, Economy2Key } from "@miyoria/economy";
import { IdentityStoreKey } from "@miyoria/store";
import { isUlid, type PersonId } from "@miyoria/types";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const NO_ECONOMY = "economy module (economy 2.0) is not available";

/** Economy 2.0 of the running economy, or a 503. */
export function economy2(state: ApiState): Economy2 {
  const v2 = state.optional(Economy2Key);
  if (v2 === undefined || typeof v2.health !== "function") throw ApiError.unavailable(NO_ECONOMY);
  return v2;
}

/** Failures of the economy that are not `ApiError` read as an unavailable economy, not a 500. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") throw new ApiError(status, (error as Error).message);
    throw ApiError.unavailable(NO_ECONOMY);
  }
}

async function quests(state: ApiState, c: ApiContext): Promise<Response> {
  const id = param(c, "id");
  const unknown = ApiError.notFound(`unknown person \`${id}\``);
  if (!isUlid(id.toUpperCase())) throw unknown;
  const v2 = economy2(state);
  const identity = state.service(IdentityStoreKey, "identity store");
  const first = (await identity.accountsOf(id.toUpperCase() as PersonId))[0];
  if (!first) throw unknown;
  const view = await guard(() => v2.quests(first.account));
  return json({ currency: v2.currency, ...view });
}

export function economy2Routes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/economy2/health",
      handler: async () => {
        const v2 = economy2(state);
        return json({ currency: v2.currency, ...(await guard(() => v2.health())) });
      },
    },
    {
      method: "GET",
      path: "/api/economy2/commissions",
      handler: async () => {
        const v2 = economy2(state);
        return json({
          currency: v2.currency,
          commissions: await guard(() => v2.commissionsWaiting()),
        });
      },
    },
    {
      method: "GET",
      path: "/api/economy2/predictions",
      handler: async () => {
        const v2 = economy2(state);
        return json({
          currency: v2.currency,
          predictions: await guard(() => v2.predictions(null)),
        });
      },
    },
    {
      method: "GET",
      path: "/api/economy2/room",
      handler: async () => {
        const v2 = economy2(state);
        return json({ currency: v2.currency, room: await guard(() => v2.room()) });
      },
    },
    { method: "GET", path: "/api/people/:id/quests", handler: (c) => quests(state, c) },
  ];
}
