// `/me auction` and `/me lottery` (docs/design/v5-play.md §11.4): no new top-level command, two
// entries under `/me` beside the wallet, and the routes of the buttons and modals on the notices
// the market posts (`notices.ts`), so people take part by pressing buttons rather than typing.
//
// - `/me auction`: the lot now (public, like the notice); `bid:` bids, `name:` gives the name of a
//   won name lot. 出價 opens a modal for the amount and redraws the lot's card with the new top
//   bid; 取名 opens a modal for the name; 不要了 gives a won name lot up for a full refund.
// - `/me lottery`: the week (only the invoker sees it: their own tickets); `count:` buys. The
//   notice's buy buttons answer only the buyer; who bought is not shown before the draw.
//
// Every answer is a neutral system card. Her own accounts are refused by the service.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  intParam,
  notice,
} from "@miyoria/commands";
import {
  type AccountRef,
  type ContextKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  newId,
} from "@miyoria/types";
import { LOT_TITLE } from "./lots.js";
import { auctionNotice, BUY_COUNTS, lotteryNotice, md, ROUTES } from "./notices.js";
import { withPicture } from "./pictures.js";
import type { MarketRefusal, MarketService } from "./service.js";

export const PATHS = ["me auction", "me lottery", "game lottery"] as const;

/** The wallet's node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
const OFF = "拍賣和樂透現在沒有開";

function refusal(r: MarketRefusal): CommandReply {
  return notice(r.status === 503 ? "warn" : "info", r.message);
}

function result(text: string, muted: string | null = null): CommandReply {
  return cardReply(
    [{ type: "text", text }, ...(muted ? [{ type: "muted" as const, text: muted }] : [])],
    { accent: "neutral" },
  );
}

/**
 * The auction's card now, or a line saying when the next one opens, with the lot's picture above
 * it when one can be drawn. `viewer`: whose own bid the picture shows (`null` for a card everyone
 * sees, such as the channel's notice).
 */
async function auctionCard(
  market: MarketService,
  note: string | null = null,
  viewer: AccountRef | null = null,
): Promise<CommandReply> {
  // A viewer's own bid needs the wallet; after a bid that went through, never fail on it.
  const view = await market.auctionView(viewer).catch(() => market.auctionView(null));
  if (view.lot !== null && view.lot.min_bid !== null) {
    const card = auctionNotice(view.lot, view.currency, note, market.config);
    return withPicture(card, await market.auctionPicture(view));
  }
  if (!view.running) return notice("info", "現在沒有拍賣。");
  return withPicture(lastLotCard(view, note), await market.auctionPicture(view));
}

/** The last lot's result and when the next one opens (no lot taking bids now). */
function lastLotCard(
  view: Awaited<ReturnType<MarketService["auctionView"]>>,
  note: string | null,
): CommandReply {
  const next = view.next;
  const lines: string[] = [];
  if (view.lot !== null && view.lot.winner !== null) {
    lines.push(
      `上一次:${md(view.lot.winner.name)} 以 ${view.lot.winner.price} ${view.currency}得標「${view.lot.name}」。`,
    );
  }
  if (next !== null) {
    const at = `<t:${Math.floor(Date.parse(next.opens_at) / 1000)}:f>`;
    lines.push(
      next.plan === "skip"
        ? `下一次(${at})這週休息。`
        : `下一次拍賣:${at}${next.plan ? `,拍「${LOT_TITLE[next.plan].name}」` : ""}。`,
    );
  }
  return result(lines.join("\n") || "現在沒有在拍賣。", note);
}

/** The market of where a command or a button was used (its Space; a DM's is the primary's). */
type MarketAt = (context: ContextKey | null) => MarketService | null;

function registerAll(
  registry: CommandRegistry,
  service: MarketAt,
  coin: string,
  her: string,
): void {
  const run = async (
    inv: { context: ContextKey },
    fn: (market: MarketService) => Promise<CommandReply>,
  ): Promise<CommandReply> => {
    const market = service(inv.context);
    return market === null ? notice("info", OFF) : fn(market);
  };
  const runComponent = async (
    inv: { context: ContextKey },
    fn: (market: MarketService) => Promise<ComponentResult>,
  ): Promise<ComponentResult> => {
    const market = service(inv.context);
    return market === null ? ComponentResult.reply(notice("info", OFF)) : fn(market);
  };

  const auctionRoutes: AnyComponentRoute[] = [
    {
      route: ROUTES.bid,
      ephemeral: true,
      handle: (inv) =>
        runComponent(inv, async (market) => {
          const view = await market.auctionView(null);
          const min = view.lot?.min_bid ?? null;
          if (min === null) return ComponentResult.reply(notice("info", "現在沒有在拍賣。"));
          return ComponentResult.modal({
            id: componentId(ROUTES.bidForm),
            title: "出價",
            fields: [
              {
                id: "amount",
                label: `出價(至少 ${min} ${view.currency})`,
                value: String(min),
                minLength: 1,
                maxLength: 7,
              },
            ],
          });
        }),
    },
    {
      route: ROUTES.bidForm,
      ephemeral: true,
      handle: (inv) =>
        runComponent(inv, async (market) => {
          const raw = inv.field("amount").replace(/[,\s]/g, "");
          const amount = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
          const r = await market.bid(inv.invoker, amount);
          if (!r.ok) return ComponentResult.reply(refusal(r));
          // The bid stands; the card (and its picture) is drawn after. An edited notice is
          // everyone's, so it shows nobody's own bid.
          const card = await auctionCard(market, null, inv.messageId === null ? inv.invoker : null);
          return inv.messageId === null
            ? ComponentResult.reply(card)
            : ComponentResult.update(card);
        }),
    },
    {
      route: ROUTES.auctionRefresh,
      handle: (inv) =>
        runComponent(inv, async (market) => ComponentResult.update(await auctionCard(market))),
    },
    {
      route: ROUTES.name,
      ephemeral: true,
      handle: (inv) =>
        runComponent(inv, async () =>
          ComponentResult.modal({
            id: componentId(ROUTES.nameForm),
            title: "她怎麼叫你",
            fields: [{ id: "name", label: "想讓她這一週怎麼叫你", minLength: 1, maxLength: 20 }],
          }),
        ),
    },
    {
      route: ROUTES.nameForm,
      ephemeral: true,
      handle: (inv) =>
        runComponent(inv, async (market) =>
          ComponentResult.reply(await name(market, inv.invoker, inv.field("name"))),
        ),
    },
    {
      route: ROUTES.giveUp,
      ephemeral: true,
      handle: (inv) =>
        runComponent(inv, async (market) => {
          const r = await market.giveUpName(inv.invoker);
          if (!r.ok) return ComponentResult.reply(refusal(r));
          const back = "refunded" in r ? r.refunded : 0;
          return ComponentResult.reply(result(`好,這次不取名了,${back} 已經全額退回。`));
        }),
    },
  ];

  registry.register(
    commandSpec("me auction", "每週拍賣:看現在拍什麼、出價,或幫得標的稱呼取名", {
      args: [
        argSpec("bid", `出價(會先押住你的${coin},被超過就退回)`, ArgKind.integer, {
          required: false,
        }),
        argSpec("name", `得標「${her}怎麼叫你」之後,想讓${her}怎麼叫你`, ArgKind.string, {
          required: false,
        }),
      ],
      permission: NODE,
    }),
    (inv) =>
      run(inv, async (market) => {
        const typed = inv.str("name")?.trim() ?? "";
        if (typed !== "") return { ...(await name(market, inv.invoker, typed)), ephemeral: true };
        const amount = inv.int("bid");
        if (amount !== null && amount !== undefined) {
          const r = await market.bid(inv.invoker, amount);
          if (!r.ok) return refusal(r);
          return auctionCard(market, `${inv.invoker_display_name} 出價 ${amount}。`, inv.invoker);
        }
        return auctionCard(market, null, inv.invoker);
      }),
    { components: auctionRoutes },
  );

  const lotteryRoutes: AnyComponentRoute[] = [
    defineRoute<number>({
      route: ROUTES.buy,
      ephemeral: true,
      parse: (p) => {
        const n = intParam(p[0]);
        return n !== null && (BUY_COUNTS as readonly number[]).includes(n) ? n : null;
      },
      handle: (inv, count) =>
        runComponent(inv, async (market) =>
          ComponentResult.reply(await buy(market, inv.invoker, count, inv.context.platform)),
        ),
    }),
    {
      route: ROUTES.lotteryRefresh,
      handle: (inv) =>
        runComponent(inv, async (market) =>
          ComponentResult.update(await lotteryCard(market, null)),
        ),
    },
  ];

  registry.register(
    commandSpec("me lottery", "每週樂透:看這週的獎池和你的張數,或買彩券", {
      args: [argSpec("count", "要買幾張(一個人一週有上限)", ArgKind.integer, { required: false })],
      permission: NODE,
      ephemeral: true,
    }),
    (inv) =>
      run(inv, async (market) => {
        const count = inv.int("count");
        if (count !== null && count !== undefined) {
          return buy(market, inv.invoker, count, inv.context.platform);
        }
        return lotteryCard(market, inv.invoker);
      }),
    { components: lotteryRoutes },
  );

  // The week's pot for everyone in the channel (owner 2026-11-18): the same card as the weekly
  // notice, with nobody's own tickets on it. Its buttons are the routes `/me lottery` declares,
  // so a purchase from it is still answered only to the buyer.
  registry.register(
    commandSpec("game lottery", "每週樂透:把這週的獎池和開獎時間貼在這個頻道(大家都看得到)", {
      permission: NODE,
    }),
    (inv) => run(inv, async (market) => lotteryCard(market, null)),
  );
}

async function name(
  market: MarketService,
  account: Parameters<MarketService["proposeName"]>[0],
  raw: string,
): Promise<CommandReply> {
  const r = await market.proposeName(account, raw);
  if (!r.ok) return refusal(r);
  if ("refunded" in r) return result(`已退回 ${r.refunded}。`);
  const days = market.config.auction_call_days;
  return result(`好,接下來 ${days} 天她會叫你「${r.call_name}」。`);
}

async function buy(
  market: MarketService,
  account: Parameters<MarketService["buyTickets"]>[0],
  count: number,
  platform: string,
): Promise<CommandReply> {
  // The platform does not hand a command its interaction id, so a press is its own key.
  const r = await market.buyTickets(account, count, `${platform}:${newId()}`);
  if (!r.ok) return refusal(r);
  const left = r.balance === null ? "" : `,剩 ${r.balance}`;
  const done = result(`買了 ${r.count} 張,這週你一共 ${r.mine} 張。花了 ${r.charged}${left}。`);
  // Paid already: the week's picture with their tickets is drawn after, best-effort.
  const picture = await market
    .lotteryView(account)
    .then((view) => market.lotteryPicture(view))
    .catch(() => null);
  return withPicture(done, picture);
}

/**
 * The lottery's week, with its picture above it when one can be drawn. `viewer`: whose own tickets
 * it shows (`null` for the channel's notice, which everyone sees).
 */
async function lotteryCard(
  market: MarketService,
  viewer: AccountRef | null,
): Promise<CommandReply> {
  const view = await market.lotteryView(viewer);
  return withPicture(lotteryNotice(view, market.config), await market.lotteryPicture(view));
}

/** `coin` and `her`: the profile's coin name and pronoun (the first character's by default). */
export function registerCommands(
  registry: CommandRegistry,
  service: MarketAt,
  coin: string = DEFAULT_CURRENCY,
  her: string = DEFAULT_CHARACTER.pronoun,
): void {
  registerAll(registry, service, coin, her);
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
