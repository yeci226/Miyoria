// The deep-sea exchange's routes (docs/design/exchange.md), v1, over `ExchangeKey`:
//
// * Member (`exchange` group, a session, limited per account): the market, the browsing lists,
//   suggestions while typing, a lookup, a ticker's page, its candles in four timeframes (with the
//   member's own cost and 2× lines), the heat maps, the watch list, their account (open it,
//   take 2x's risks, hide from the rich list), a quote, a market order (with an
//   `Idempotency-Key`), a cancel, their own portfolio, the rich list (one server's members or everyone, `BoardScopeQuery`). The person is the
//   session's; a refusal is its status and sentence, the same as in Discord. Nobody sees anybody
//   else's holdings or orders here (大家都在買 is counts only).
// * Admin (`exchangeAdmin`): `GET /api/exchange`; blocking or removing a ticker, naming one,
//   confirming a split, settling a suspended ticker and a sale by hand need
//   `admin.economy.adjust` and are written to the audit log.
//
// Without the `exchange` module every route is a `503` that names it.

import type {
  ExchangeAccount,
  ExchangeAdmin,
  ExchangeBoards,
  ExchangeCandles,
  ExchangeList,
  ExchangeMap,
  ExchangeMarket,
  ExchangeOrder,
  ExchangePortfolio,
  ExchangeQuote,
  ExchangeTicker,
} from "@miyoria/contracts/api";
import {
  ExchangeKey,
  type ExchangeService,
  LIST_KINDS,
  LIST_LABEL,
  NO_DIVIDENDS,
  type RealOrderRequest,
  type Refusal,
} from "@miyoria/play/exchange";
import {
  type AccountRef,
  accountRefString,
  EXCHANGE_DISCLAIMER_LEVERAGE,
  EXCHANGE_DISCLAIMER_REAL,
} from "@miyoria/types";
import { memberBoardScope } from "./board.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import { keyOf } from "./wallet.js";
import type { Watch } from "./watch.js";

function service(state: ApiState): ExchangeService {
  return state.service(ExchangeKey, "exchange module");
}

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

function refused(r: Refusal): never {
  throw new ApiError(r.status, r.message);
}

/** The request as the desk takes it (absent fields left out). */
function orderOf(body: {
  side: "buy" | "sell";
  code: string;
  coins?: number | undefined;
  shares?: number | undefined;
  all?: boolean | undefined;
  leverage?: number | undefined;
  position?: string | undefined;
}): RealOrderRequest {
  const out: RealOrderRequest = { side: body.side, code: body.code.toUpperCase() };
  if (body.coins !== undefined) out.coins = body.coins;
  if (body.shares !== undefined) out.shares = body.shares;
  if (body.all !== undefined) out.all = body.all;
  if (body.leverage !== undefined) out.leverage = body.leverage;
  if (body.position !== undefined) out.position = body.position;
  return out;
}

/** What a stranger is told: she does not know them yet (`pronoun`: how texts name her). */
const stranger = (pronoun: string) => `${pronoun}還不認識你,先和${pronoun}說說話吧`;

async function personOf(x: ExchangeService, c: ApiContext): Promise<string> {
  const person = await x.personOf(accountOf(c));
  if (!person) throw new ApiError(403, stranger(x.pronoun));
  return person;
}

/**
 * `GET /api/member/exchange/list/{kind}` as a view (also the `exchange_list` push topic): the
 * rows as this member sees them (their holdings, their watch list).
 */
export async function exchangeListWatch(
  state: ApiState,
  c: ApiContext,
  kind: ExchangeList["kind"],
): Promise<Watch<ExchangeList>> {
  const x = service(state);
  const account = accountOf(c);
  const person = await x.personOf(account);
  return {
    key: `${kind}:${person ?? accountRefString(account)}`,
    build: () => ({ kind, label: LIST_LABEL[kind], rows: x.lists.rows(kind, person) }),
  };
}

/**
 * `GET /api/member/exchange/ticker/{code}` as a view (also the `exchange_ticker` push topic):
 * `404` for a ticker nobody looked up; each build counts as a view of it, as each poll did.
 */
export async function exchangeTickerWatch(
  state: ApiState,
  c: ApiContext,
  asked: string,
): Promise<Watch<ExchangeTicker>> {
  const x = service(state);
  const code = asked.toUpperCase();
  const account = accountOf(c);
  const person = await x.personOf(account);
  const build = (): ExchangeTicker => {
    const h = x.real.history(code);
    if (!h) throw ApiError.notFound("沒有這個標的(先查詢代號)");
    if (person) x.real.noteView(person, code);
    return {
      line: h.line,
      points: h.points,
      watching: person ? x.lists.watching(person, code) : false,
    };
  };
  return { key: `${code}:${person ?? accountRefString(account)}`, build };
}

export const exchangeRpc = {
  market: os.exchange.market.handler(async ({ context: { state, c } }): Promise<ExchangeMarket> => {
    const x = service(state);
    const v = x.real.view();
    const person = await x.personOf(accountOf(c));
    return {
      enabled: v.enabled,
      currency: v.currency,
      colors: x.config.colors,
      rates: v.rates,
      house: v.house,
      sessions: v.sessions,
      lists: LIST_KINDS.map((kind) => ({ kind, label: LIST_LABEL[kind] })),
      default_list: x.lists.defaultList(person),
      rules: { ...v.rules, watch_max: x.config.watch_max },
      // The same wording as every other surface, in this profile's coin name.
      small_print: {
        base: v.disclaimer,
        real: EXCHANGE_DISCLAIMER_REAL,
        leverage: EXCHANGE_DISCLAIMER_LEVERAGE,
      },
      no_dividends: NO_DIVIDENDS,
      no_exchange: v.no_exchange,
    };
  }),
  list: os.exchange.list.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeList> =>
      (await exchangeListWatch(state, c, input.params.kind)).build(),
  ),
  suggest: os.exchange.suggest.handler(async ({ input, context: { state, c } }) => ({
    items: service(state).lists.suggest(accountRefString(accountOf(c)), input.query.q),
  })),
  lookup: os.exchange.lookup.handler(async ({ input, context: { state, c } }) => {
    const r = await service(state).real.lookup(accountOf(c), input.body.code);
    if (!r.ok) refused(r);
    return { instrument: r.instrument };
  }),
  ticker: os.exchange.ticker.handler(async ({ input, context: { state, c } }) => {
    const view = await exchangeTickerWatch(state, c, input.params.code);
    return view.build();
  }),
  candles: os.exchange.candles.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeCandles> => {
      const x = service(state);
      const code = input.params.code.toUpperCase();
      const set = await x.real.candles(code, input.query.tf);
      if (!set) throw ApiError.notFound("沒有這個標的(先查詢代號)");
      const person = await x.personOf(accountOf(c));
      return {
        code,
        tf: set.tf,
        zone: set.zone,
        currency: set.line.currency,
        candles: set.candles.map((k) => ({ t: k.at, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v })),
        volume: set.volume,
        source: set.source,
        stale: set.stale,
        marks: person ? x.real.marks(person, code) : { avg_cost: null, liquidation: [] },
      };
    },
  ),
  map: os.exchange.map.handler(
    async ({ input, context: { state } }): Promise<ExchangeMap> =>
      service(state).real.map(input.params.kind),
  ),
  watch: os.exchange.watch.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = x.lists.setWatch(await personOf(x, c), input.body.code.toUpperCase(), input.body.on);
    if (!r.ok) throw new ApiError(409, r.message);
    return { watching: r.watching, count: r.count };
  }),
  account: os.exchange.account.handler(
    async ({ context: { state, c } }): Promise<ExchangeAccount> => {
      const x = service(state);
      const view = await x.accountView(accountOf(c));
      if (!view) throw new ApiError(403, stranger(x.pronoun));
      return view;
    },
  ),
  open: os.exchange.open.handler(async ({ context: { state, c } }): Promise<ExchangeAccount> => {
    const r = await service(state).openAccount(accountOf(c));
    if (!r.ok) refused(r);
    return r.account;
  }),
  leverage: os.exchange.leverage.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeAccount> => {
      const r = await service(state).optInLeverage(accountOf(c), input.body.accept);
      if (!r.ok) refused(r);
      return r.account;
    },
  ),
  visibility: os.exchange.visibility.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeAccount> => {
      const patch: { hide_boards?: boolean; show_holdings?: boolean } = {};
      if (input.body.hide_boards !== undefined) patch.hide_boards = input.body.hide_boards;
      if (input.body.show_holdings !== undefined) patch.show_holdings = input.body.show_holdings;
      const r = await service(state).setVisibility(accountOf(c), patch);
      if (!r.ok) refused(r);
      return r.account;
    },
  ),
  quote: os.exchange.quote.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeQuote> => {
      const r = await service(state).real.quote(accountOf(c), orderOf(input.body));
      if (!r.ok) refused(r);
      return r.quote;
    },
  ),
  order: os.exchange.order.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeOrder> => {
      const key = `web:${keyOf(input.headers["idempotency-key"])}`;
      const r = await service(state).real.place(accountOf(c), orderOf(input.body), key);
      if (!r.ok) refused(r);
      return r.order;
    },
  ),
  cancel: os.exchange.cancel.handler(async ({ input, context: { state, c } }) => {
    const r = await service(state).real.cancel(accountOf(c), input.body.order);
    if (!r.ok) refused(r);
    return { refunded: r.refunded };
  }),
  portfolio: os.exchange.portfolio.handler(
    async ({ context: { state, c } }): Promise<ExchangePortfolio> => {
      const x = service(state);
      const person = await personOf(x, c);
      const view = await x.accountView(accountOf(c));
      return { ...x.real.portfolio(person), balance: view?.balance ?? null };
    },
  ),
  boards: os.exchange.boards.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeBoards> => {
      const x = service(state);
      const { space, members } = await memberBoardScope(state, c, input?.query ?? {});
      const b = await x.boards(accountOf(c), members);
      return {
        currency: b.currency,
        space,
        rich: b.rich,
        me: b.me === null ? null : { rich: b.me.rich, hidden: b.me.hidden },
      };
    },
  ),
};

export const exchangeAdminRpc = {
  view: os.exchangeAdmin.view.handler(async ({ context: { state } }): Promise<ExchangeAdmin> => {
    const x = service(state);
    const report = x.real.report();
    const mint = await x.real.mintReport();
    const holders = x.real.holderCounts();
    const name = async (p: string) => (await x.nameOf(p)) ?? "某人";
    return {
      enabled: x.config.open,
      rates: x.real.rates,
      report: {
        today: report.today,
        days: report.days,
        cap_daily: report.cap_daily,
        bankrupt: await Promise.all(
          report.bankrupt.map(async (b) => ({
            name: await name(b.person),
            since: b.since,
            until: b.until,
            written_off: b.written_off,
          })),
        ),
        quotes: report.quotes,
        books: report.books,
        mint,
      },
      tickers: x.real.tickers().map((t) => ({ ...t, holders: holders.get(t.code) ?? 0 })),
      providers: x.real.providerStatus(),
      refresh_seconds: x.real.effectiveInterval(),
      positions: await Promise.all(
        x.real.allPositions().map(async (p) => ({
          id: p.id,
          name: await name(p.person),
          code: p.code,
          leverage: p.leverage,
          qty: p.qty,
          value: p.value,
        })),
      ),
    };
  }),
  ticker: os.exchangeAdmin.ticker.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = x.real.setTicker(input.body.code.toUpperCase(), input.body.action);
    if (!r.ok) refused(r);
    x.audit("exchange.ticker", input.body.code, { action: input.body.action }, actorOf(c));
    return { ok: true };
  }),
  split: os.exchangeAdmin.split.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = x.real.confirmSplit(input.body.code.toUpperCase(), input.body.ratio);
    if (!r.ok) refused(r);
    x.audit("exchange.split", input.body.code, { ratio: input.body.ratio }, actorOf(c));
    return { positions: r.positions };
  }),
  settle: os.exchangeAdmin.settle.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = await x.real.settle(input.body.code.toUpperCase(), input.body.at, actorOf(c));
    if (!r.ok) refused(r);
    x.audit("exchange.settle", input.body.code, { at: input.body.at, paid: r.paid }, actorOf(c));
    return { paid: r.paid };
  }),
  name: os.exchangeAdmin.name.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = x.real.setName(input.body.code.toUpperCase(), input.body.name);
    if (!r.ok) refused(r);
    x.audit("exchange.name", input.body.code, { name: input.body.name }, actorOf(c));
    return { name: r.name };
  }),
  sell: os.exchangeAdmin.sell.handler(async ({ input, context: { state, c } }) => {
    const x = service(state);
    const r = await x.real.adminSell(input.body.position, actorOf(c));
    if (!r.ok) refused(r);
    x.audit("exchange.sell", input.body.position, { paid: r.paid }, actorOf(c));
    return { paid: r.paid };
  }),
};
