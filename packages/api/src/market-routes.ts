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
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

function service(state: ApiState): MarketService {
  return state.service(MarketKey, "market module");
}

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

function refused(r: MarketRefusal): never {
  throw new ApiError(r.status, r.message);
}

export const marketRpc = {
  auction: os.market.auction.handler(
    async ({ context: { state, c } }): Promise<AuctionView> =>
      service(state).auctionView(accountOf(c)),
  ),
  bids: os.market.bids.handler(async ({ context: { state, c } }) => ({
    bids: await service(state).myBids(accountOf(c)),
  })),
  lottery: os.market.lottery.handler(
    async ({ context: { state, c } }): Promise<LotteryView> =>
      service(state).lotteryView(accountOf(c)),
  ),
  tickets: os.market.tickets.handler(async ({ context: { state, c } }) => ({
    weeks: await service(state).myTickets(accountOf(c)),
  })),
  bid: os.market.bid.handler(async ({ input, context: { state, c } }) => {
    const r = await service(state).bid(accountOf(c), input.body.amount);
    if (!r.ok) refused(r);
    return { amount: r.amount, ends_at: r.ends_at, extended: r.extended, balance: r.balance };
  }),
  name: os.market.name.handler(async ({ input, context: { state, c } }): Promise<NameResult> => {
    const market = service(state);
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
    const key = `web:${keyOf(input.headers["idempotency-key"])}`;
    const r = await service(state).buyTickets(accountOf(c), input.body.count, key);
    if (!r.ok) refused(r);
    return { count: r.count, mine: r.mine, charged: r.charged, balance: r.balance };
  }),
};

export const marketAdminRpc = {
  history: os.marketAdmin.history.handler(
    async ({ context: { state } }): Promise<MarketHistory> => service(state).history(),
  ),
  plan: os.marketAdmin.plan.handler(async ({ input, context: { state } }): Promise<LotPlan> => {
    const r = await service(state).plan(input.body.lot, input.body.note?.trim() || null);
    if (!r.ok) refused(r);
    return { week: r.week, opens_at: r.opens_at, plan: r.plan };
  }),
  settle: os.marketAdmin.settle.handler(async ({ input, context: { state } }) => {
    const r = await service(state).settleNow(input.body.what);
    if (!r.ok) refused(r);
    return { ok: true as const };
  }),
};
