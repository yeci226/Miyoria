// The weekly market's routes (docs/design/v5-play.md §11.4), over `MarketKey`:
//
// * Member (`market` group, a session, limited per account): `GET /api/member/market/auction`,
//   `.../bids`, `.../lottery`, `.../tickets`; `POST /api/member/market/bid` `{ amount }`,
//   `POST /api/member/market/name` `{ name } | { give_up: true }`, `POST /api/member/market/lottery`
//   `{ count }` with an `Idempotency-Key`. The person is the session's; a refusal is its status and
//   sentence, the same as in Discord. Someone she does not know, or blocked, has no bid and no
//   ticket, and every write answers like the wallet does to a stranger.
// * Admin (`marketAdmin`): `GET /api/market/history`; `POST /api/market/plan` `{ lot, note? }` and
//   `POST /api/market/settle` `{ what }` need `admin.economy.adjust`, like a hand on someone's coins.
//
// Each Space has its own market (phase 6): every route takes `?space=` (`SpaceQuery`). A member's
// default is their own server (preferring the primary; `memberSpace`: `404` for a server she is
// not in, `403` for one they are not a member of); the owner's is the primary (`adminSpace`).
// Without identity's places there is the one market of before.
//
// Without the `market` module every route is a `503` that names it.

import type {
  AuctionView,
  LotPlan,
  LotteryView,
  MarketHistory,
  NameResult,
  TicketResult,
} from "@miyoria/contracts/api";
import { MarketKey, type MarketRefusal, type MarketService } from "@miyoria/play/market";
import { type AccountRef, PlacesKey } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import { adminSpace, memberPerson, memberSpace } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

/** The market of `space` (identity's id; `null`: the default one). */
function marketOf(state: ApiState, space: string | null): MarketService {
  const market = state.service(MarketKey, "market module").of(space);
  if (market === null) throw ApiError.notFound("這個伺服器沒有市集");
  return market;
}

/** The market a member route is about: `?space=` checked against their servers. */
async function memberMarket(
  state: ApiState,
  c: ApiContext,
  requested: string | undefined,
): Promise<MarketService> {
  if (state.optional(PlacesKey) === undefined) return marketOf(state, null);
  const space = memberSpace(state, await memberPerson(state, c), requested);
  return marketOf(state, space.id);
}

/** The market an owner's route is about: `?space=`, else the primary. */
function adminMarket(state: ApiState, requested: string | undefined): MarketService {
  if (state.optional(PlacesKey) === undefined) return marketOf(state, null);
  return marketOf(state, adminSpace(state, requested)?.id ?? null);
}

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

function refused(r: MarketRefusal): never {
  throw new ApiError(r.status, r.message);
}

export const marketRpc = {
  auction: os.market.auction.handler(
    async ({ input, context: { state, c } }): Promise<AuctionView> =>
      (await memberMarket(state, c, input?.query?.space)).auctionView(accountOf(c)),
  ),
  bids: os.market.bids.handler(async ({ input, context: { state, c } }) => ({
    bids: await (await memberMarket(state, c, input?.query?.space)).myBids(accountOf(c)),
  })),
  lottery: os.market.lottery.handler(
    async ({ input, context: { state, c } }): Promise<LotteryView> =>
      (await memberMarket(state, c, input?.query?.space)).lotteryView(accountOf(c)),
  ),
  tickets: os.market.tickets.handler(async ({ input, context: { state, c } }) => ({
    weeks: await (await memberMarket(state, c, input?.query?.space)).myTickets(accountOf(c)),
  })),
  bid: os.market.bid.handler(async ({ input, context: { state, c } }) => {
    const market = await memberMarket(state, c, input?.query?.space);
    const r = await market.bid(accountOf(c), input.body.amount);
    if (!r.ok) refused(r);
    return { amount: r.amount, ends_at: r.ends_at, extended: r.extended, balance: r.balance };
  }),
  name: os.market.name.handler(async ({ input, context: { state, c } }): Promise<NameResult> => {
    const market = await memberMarket(state, c, input?.query?.space);
    const { name, give_up } = input.body;
    if (give_up === true) {
      const r = await market.giveUpName(accountOf(c));
      if (!r.ok) refused(r);
      return { call_name: null, applied_until: null, refunded: "refunded" in r ? r.refunded : 0 };
    }
    if (name === undefined) throw ApiError.badRequest("`name` or `give_up` is needed");
    const r = await market.proposeName(accountOf(c), name);
    if (!r.ok) refused(r);
    if ("refunded" in r) return { call_name: null, applied_until: null, refunded: r.refunded };
    return { call_name: r.call_name, applied_until: r.applied_until, refunded: 0 };
  }),
  buy: os.market.buy.handler(async ({ input, context: { state, c } }): Promise<TicketResult> => {
    const market = await memberMarket(state, c, input?.query?.space);
    const key = `web:${keyOf(input.headers["idempotency-key"])}`;
    const r = await market.buyTickets(accountOf(c), input.body.count, key);
    if (!r.ok) refused(r);
    return { count: r.count, mine: r.mine, charged: r.charged, balance: r.balance };
  }),
};

export const marketAdminRpc = {
  history: os.marketAdmin.history.handler(
    async ({ input, context: { state } }): Promise<MarketHistory> =>
      adminMarket(state, input?.query?.space).history(),
  ),
  plan: os.marketAdmin.plan.handler(async ({ input, context: { state } }): Promise<LotPlan> => {
    const market = adminMarket(state, input?.query?.space);
    const r = await market.plan(input.body.lot, input.body.note?.trim() || null);
    if (!r.ok) refused(r);
    return { week: r.week, opens_at: r.opens_at, plan: r.plan };
  }),
  settle: os.marketAdmin.settle.handler(async ({ input, context: { state } }) => {
    const r = await adminMarket(state, input?.query?.space).settleNow(input.body.what);
    if (!r.ok) refused(r);
    return { ok: true as const };
  }),
};
