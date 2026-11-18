// What the market posts in Discord (docs/design/v5-play.md §11.4): neutral system cards, never
// her words, with buttons (and modals for an amount or a name) that `/me auction` and
// `/me lottery` route (`commands.ts`), so nobody has to type a command to take part.
//
// - the lot when it opens (出價 opens a modal for the amount; the card is redrawn with each bid);
// - the result when it closes (a name lot: 取名 opens a modal, 不要了 refunds);
// - the lottery's week (buy buttons) and its draw.
//
// Each goes out with its picture above it when one can be drawn (`pictures.ts`); these cards are
// the text under it, and all there is without one.
//
// Names are people's display names: Markdown in them is escaped.

import { type CardBlock, type CommandReply, cardReply, componentId } from "@miyoria/commands";
import type { MarketConfig } from "./config.js";
import type { LotteryView, LotView } from "./service.js";
import type { LotteryWeek } from "./store.js";

export type CommandReplyLike = CommandReply;

/** The routes of the market's controls (declared by `/me auction` and `/me lottery`). */
export const ROUTES = {
  bid: "market:auction:bid",
  bidForm: "market:auction:bidform",
  auctionRefresh: "market:auction:refresh",
  name: "market:auction:name",
  nameForm: "market:auction:nameform",
  giveUp: "market:auction:giveup",
  buy: "market:lottery:buy",
  lotteryRefresh: "market:lottery:refresh",
} as const;

/** The ticket counts the lottery's buttons buy. */
export const BUY_COUNTS = [1, 5] as const;

/** Display names and titles come from people: no Markdown in them. */
export function md(text: string): string {
  return text.replace(/[\\*_`~|>#[\]()<@]/g, (c) => `\\${c}`);
}

/** A Discord timestamp, shown in the reader's own time zone. */
function when(iso: string, style: "R" | "f" = "R"): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : iso;
}

/** How the end moves, in one sentence; empty when it never does. */
export function extensionRule(
  config: Pick<MarketConfig, "auction_extend_mins" | "auction_extend_max_mins">,
): string {
  const mins = config.auction_extend_mins;
  if (mins === 0 || config.auction_extend_max_mins === 0) return "";
  return `最後 ${mins} 分鐘有人出價就延長 ${mins} 分鐘,最多延到原本結束後 ${config.auction_extend_max_mins} 分鐘。`;
}

/** The lot while it takes bids (and after, without the bid button). */
export function auctionNotice(
  view: LotView,
  currency: string,
  note: string | null,
  config: Pick<MarketConfig, "auction_extend_mins" | "auction_extend_max_mins">,
): CommandReply {
  const open = view.min_bid !== null;
  const lines = [`**${view.name}**`, view.detail];
  lines.push(
    view.top === null
      ? `還沒有人出價,起標 ${view.opening_bid} ${currency}`
      : `目前最高:${md(view.top.name)} ${view.top.amount} ${currency}(${view.bidders} 人出過價)`,
  );
  lines.push(
    open
      ? `${view.extended ? "延長到" : "結束"}:${when(view.ends_at, "f")}(${when(view.ends_at)})`
      : "已經結束",
  );
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  if (note) blocks.push({ type: "muted", text: note });
  blocks.push({
    type: "buttons",
    buttons: [
      ...(open
        ? [
            {
              id: componentId(ROUTES.bid),
              label: `出價(至少 ${view.min_bid})`,
              style: "primary" as const,
            },
          ]
        : []),
      { id: componentId(ROUTES.auctionRefresh), label: "重新整理", style: "secondary" as const },
    ],
  });
  blocks.push({
    type: "muted",
    text: `出價會先押住你的${currency},被別人超過就馬上退回;得標的${currency}會燒掉。每次至少加 ${view.step}。${extensionRule(config)}`,
  });
  return cardReply(blocks, { accent: "neutral", title: "每週拍賣" });
}

/** The lot's result. */
export function lotResultNotice(view: LotView, currency: string): CommandReply {
  const blocks: CardBlock[] = [];
  if (view.winner === null) {
    blocks.push({ type: "text", text: `這週的「${view.name}」沒有人出價,下週再來。` });
    return cardReply(blocks, { accent: "neutral", title: "拍賣結果" });
  }
  blocks.push({
    type: "text",
    text: `${md(view.winner.name)} 以 ${view.winner.price} ${currency}得標「${view.name}」。`,
  });
  if (view.kind === "frame") {
    blocks.push({ type: "muted", text: "這個卡框只有得標的人有,可以在會員頁的卡框裡選來用。" });
  } else if (view.state === "naming") {
    blocks.push({
      type: "muted",
      text: `請得標的人按「取名」給她一個稱呼${view.name_due ? `(${when(view.name_due)}之前)` : ""};不雅的她會拒絕,可以換一個,也可以按「不要了」全額退回。`,
    });
    blocks.push({
      type: "buttons",
      buttons: [
        { id: componentId(ROUTES.name), label: "取名", style: "primary" },
        { id: componentId(ROUTES.giveUp), label: "不要了", style: "secondary" },
      ],
    });
  }
  return cardReply(blocks, { accent: "neutral", title: "拍賣結果" });
}

/** The lottery's week: what a ticket costs, how it is drawn, the buy buttons. */
export function lotteryNotice(view: LotteryView, config: MarketConfig): CommandReply {
  const share = Math.round(view.prize_share * 100);
  const lines = [
    `一張 ${view.price} ${view.currency},一個人一週最多 ${view.per_person} 張。`,
    `開獎:${when(view.draw_at, "f")}(${when(view.draw_at)})`,
    `目前 ${view.buyers} 人買了 ${view.tickets} 張,獎池 ${Math.floor(view.pot * view.prize_share)} ${view.currency}`,
  ];
  if (view.mine !== null) lines.push(`你有 ${view.mine.tickets} 張`);
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  blocks.push({
    type: "muted",
    text: `賣出的${share}% 是獎金,其餘燒掉;依張數抽一個人。少於 ${config.lottery_min_buyers} 個人買就不開獎、全額退回。`,
  });
  blocks.push({
    type: "buttons",
    buttons: [
      ...BUY_COUNTS.filter((n) => n <= view.per_person).map((n, i) => ({
        id: componentId(ROUTES.buy, n),
        label: `買 ${n} 張`,
        style: i === 0 ? ("primary" as const) : ("secondary" as const),
        disabled: !view.running || view.state !== "open",
      })),
      { id: componentId(ROUTES.lotteryRefresh), label: "重新整理", style: "secondary" as const },
    ],
  });
  return cardReply(blocks, { accent: "neutral", title: "每週樂透" });
}

/** The week's draw. */
export function lotteryResultNotice(
  w: LotteryWeek,
  config: MarketConfig,
  currency: string,
): CommandReply {
  if (w.status === "refunded") {
    return cardReply(
      [
        {
          type: "text",
          text: `這週的樂透只有 ${w.buyers} 個人買(要 ${config.lottery_min_buyers} 個人),不開獎,${w.tickets} 張全額退回。`,
        },
      ],
      { accent: "neutral", title: "每週樂透" },
    );
  }
  return cardReply(
    [
      {
        type: "text",
        text: `這週的樂透開獎了:${md(w.winner?.name ?? "")} 抽中,獎金 ${w.prize} ${currency}。`,
      },
      {
        type: "muted",
        text: `一共 ${w.buyers} 人、${w.tickets} 張,賣出 ${w.pot},燒掉 ${w.burned}。`,
      },
    ],
    { accent: "neutral", title: "每週樂透" },
  );
}
