// The market's card on the panel's system page (docs/design/v5-settings.md §3.2): the week's
// auction and lottery on one card, from the same views the commands and the routes read. Facts in
// order of use, the first `CARD_MAX_FACTS` kept: the open lot's top bid and its bidders, the
// lottery's pot and buyers, then the lot's name and the tickets sold. Next: whichever of the lot's
// end, the next opening and the draw comes first.

import { CARD_MAX_FACTS, type ModuleCard, type ModuleCardFact } from "@miyoria/runtime/kernel";
import type { Timestamp } from "@miyoria/types";
import type { AuctionView, LotteryView } from "./service.js";

/** The card for `auction` and `lottery` as they are at `now` (epoch ms). */
export function marketCard(auction: AuctionView, lottery: LotteryView, now: number): ModuleCard {
  const lot = auction.running && auction.lot?.state === "open" ? auction.lot : null;
  const facts: ModuleCardFact[] = [];
  const later: ModuleCardFact[] = [];
  const events: { label: string; at: Timestamp }[] = [];
  if (lot !== null) {
    if (lot.top !== null) {
      facts.push({ label: "最高出價", value: lot.top.amount, unit: auction.currency });
    }
    facts.push({ label: "出價人數", value: lot.bidders, unit: "人" });
    later.push({ label: "這週拍品", value: lot.name });
    events.push({ label: "結標", at: lot.ends_at });
  }
  if (auction.next !== null && auction.next.plan !== "skip") {
    events.push({ label: "開拍", at: auction.next.opens_at });
  }
  if (lottery.running) {
    facts.push({ label: "樂透獎池", value: lottery.pot, unit: lottery.currency });
    facts.push({ label: "樂透人數", value: lottery.buyers, unit: "人" });
    later.push({ label: "樂透賣出", value: lottery.tickets, unit: "張" });
    if (lottery.state === "open") events.push({ label: "開獎", at: lottery.draw_at });
  }
  const next = events
    .filter((e) => Date.parse(e.at) > now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  return {
    facts: [...facts, ...later].slice(0, CARD_MAX_FACTS),
    ...(next === undefined ? {} : { next }),
  };
}
