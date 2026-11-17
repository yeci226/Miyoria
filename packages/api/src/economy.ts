// Economy 2.0 for the admins (docs/design/v4-plan.md §10), read-only, about the whole economy and
// never about one person's coins (`people-wallet.ts` has those):
//
// * `GET /api/economy/health`: coins issued against recovered per day. `available: false` until a
//   store provides the ledger totals; then there are no days, not made-up ones.
// * `GET /api/economy/commissions`: what people commissioned that she has not handed in.
// * `GET /api/economy/predictions`: open predictions and the ones settled lately (without anyone's
//   stake).
// * `GET /api/economy/room`: her room, every item with how far the audience got.
// * `GET /api/people/{id}/quests`: today's three quests as that person sees them.
//
// Read through `Economy2Key`, which the economy module provides. Every answer carries the
// currency's name.

import { type Economy2, Economy2Key } from "@miyoria/economy";
import { IdentityStoreKey } from "@miyoria/store";
import { isUlid, type PersonId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { ApiState } from "./state.js";

const NO_ECONOMY = "economy module (economy 2.0) is not available";

/** Economy 2.0 of the running economy, or a 503. */
export function economyView(state: ApiState): Economy2 {
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

/** The economy routes on the route table (`@miyoria/contracts/api`). */
export const economyRpc = {
  health: os.economy.health.handler(async ({ context }) => {
    const v2 = economyView(context.state);
    return { currency: v2.currency, ...(await guard(() => v2.health())) };
  }),
  commissions: os.economy.commissions.handler(async ({ context }) => {
    const v2 = economyView(context.state);
    return { currency: v2.currency, commissions: await guard(() => v2.commissionsWaiting()) };
  }),
  predictions: os.economy.predictions.handler(async ({ context }) => {
    const v2 = economyView(context.state);
    return { currency: v2.currency, predictions: await guard(() => v2.predictions(null)) };
  }),
  room: os.economy.room.handler(async ({ context }) => {
    const v2 = economyView(context.state);
    return { currency: v2.currency, room: await guard(() => v2.room()) };
  }),
};

/** `GET /api/people/{id}/quests`: joins the people group. */
export const personQuestsRpc = {
  quests: os.people.quests.handler(async ({ input, context }) => {
    const { state } = context;
    const id = input.params.id;
    const unknown = ApiError.notFound(`unknown person \`${id}\``);
    if (!isUlid(id.toUpperCase())) throw unknown;
    const v2 = economyView(state);
    const identity = state.service(IdentityStoreKey, "identity store");
    const first = (await identity.accountsOf(id.toUpperCase() as PersonId))[0];
    if (!first) throw unknown;
    const view = await guard(() => v2.quests(first.account));
    return { currency: v2.currency, ...view };
  }),
};
