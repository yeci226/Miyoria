// Economy 2.0 for the admins (docs/design/v4-plan.md §10), about the whole economy and
// never about one person's coins (`people-wallet.ts` has those):
//
// * `GET /api/economy/health`: coins issued against recovered per day. `available: false` until a
//   store provides the ledger totals; then there are no days, not made-up ones.
// * `GET /api/economy/predictions` (`?space=`): open predictions and the ones settled lately
//   (without anyone's stake), each with its server: of one server, or of every server without it.
// * `POST /api/economy/predictions/{id}/resolve` `{ option }`, `POST .../cancel`: the owner settles
//   or calls off any open prediction by hand, the ones that settle by themselves too
//   (`admin.economy.adjust`); the prediction keeps who did it.
// * `GET /api/economy/room`: her room, every item with how far the audience got.
// * `GET /api/people/{id}/quests`: today's three quests as that person sees them.
//
// Read through `Economy2Key`, which the economy module provides. Every answer carries the
// currency's name.

import {
  type Economy2,
  Economy2Key,
  type PredictionView,
  type ResolveResult,
} from "@miyoria/economy";
import { IdentityStoreKey } from "@miyoria/store";
import { isUlid, type PersonId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { questsView } from "./play-routes.js";
import { adminSpace } from "./space-param.js";
import { type ApiState, actorOf } from "./state.js";

const NO_ECONOMY = "economy module (economy 2.0) is not available";

/** Economy 2.0 of the running economy, or a 503. */
export function economyView(state: ApiState): Economy2 {
  const v2 = state.optional(Economy2Key);
  if (v2 === undefined || typeof v2.health !== "function") throw ApiError.unavailable(NO_ECONOMY);
  return v2;
}

/** A prediction field by field; `who` (the operator who settled it) only for the owner. */
export function predictionView(p: PredictionView, admin: boolean): PredictionView {
  return {
    id: p.id,
    space: p.space == null ? null : { id: p.space.id, name: p.space.name },
    question: p.question,
    options: p.options.map((o) => ({
      label: o.label,
      staked: o.staked,
      backers: o.backers,
      multiplier: o.multiplier,
    })),
    total: p.total,
    closes_at: p.closes_at,
    status: p.status,
    winner: p.winner,
    settles: { kind: p.settles.kind, label: p.settles.label },
    settled_by:
      p.settled_by === null
        ? null
        : {
            by: p.settled_by.by,
            note: p.settled_by.note,
            at: p.settled_by.at,
            who: admin ? p.settled_by.who : null,
          },
    my_bet: p.my_bet === null ? null : { ...p.my_bet },
  };
}

const settledView = (r: ResolveResult): ResolveResult => ({
  id: r.id,
  winner: r.winner,
  winners: r.winners,
  pool: r.pool,
  paid: r.paid,
  rake: r.rake,
  refunded: r.refunded,
});

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
  predictions: os.economy.predictions.handler(async ({ input, context }) => {
    const v2 = economyView(context.state);
    const asked = input?.query.space;
    const space = asked ? adminSpace(context.state, asked) : null;
    const spaces = space ? [space.id] : undefined;
    const list = await guard(() => v2.predictions(null, spaces));
    return { currency: v2.currency, predictions: list.map((p) => predictionView(p, true)) };
  }),
  resolvePrediction: os.economy.resolvePrediction.handler(async ({ input, context }) => {
    const { state, c } = context;
    const v2 = economyView(state);
    const id = input.params.id;
    const settled = await guard(() =>
      v2.resolvePredictionByAdmin(id, input.body.option, actorOf(c)),
    ).catch(async (error: unknown) => {
      await state.audit(c, "economy.prediction.resolve", id, { option: input.body.option }, false);
      throw error;
    });
    await state.audit(c, "economy.prediction.resolve", id, { winner: settled.winner }, true);
    return { currency: v2.currency, settled: settledView(settled) };
  }),
  cancelPrediction: os.economy.cancelPrediction.handler(async ({ input, context }) => {
    const { state, c } = context;
    const v2 = economyView(state);
    const id = input.params.id;
    const settled = await guard(() => v2.cancelPredictionByAdmin(id, actorOf(c))).catch(
      async (error: unknown) => {
        await state.audit(c, "economy.prediction.cancel", id, {}, false);
        throw error;
      },
    );
    await state.audit(c, "economy.prediction.cancel", id, { pool: settled.pool }, true);
    return { currency: v2.currency, settled: settledView(settled) };
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
    // An admin's look does not have her choose today's pick for them.
    const view = await guard(() => v2.quests(first.account, { pick: false }));
    return questsView(v2.currency, view);
  }),
};
