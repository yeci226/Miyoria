// What she hears of the market (docs/design/v5-play.md §11.4), the way she hears of a card worth a
// word: one short line as a note she may react to in her own words. Names are untrusted. Nothing
// here asks her to treat anyone differently, and the song priority ticket is never mentioned.

import { safeName } from "@miyoria/types";
import type { LotView } from "./service.js";
import type { LotteryWeek } from "./store.js";

export function auctionClosedNote(view: LotView, currency: string): string {
  if (view.winner === null) return `這週的拍賣「${view.name}」結束了,沒有人出價。`;
  const who = safeName(view.winner.name);
  const then =
    view.kind === "call_name" ? "他會再給你一個想被叫的稱呼。" : "那個只此一件的卡框是他的了。";
  return `這週的拍賣「${view.name}」結束了:${who} 以 ${view.winner.price} ${currency}得標。${then}`;
}

export function nameNote(name: string, call: string, days: number): string {
  return `${safeName(name)} 拍到了「這一週你怎麼叫他」:接下來 ${days} 天,叫他「${safeName(call, 20)}」。`;
}

export function lotteryNote(w: LotteryWeek, currency: string): string {
  if (w.status === "refunded" || w.winner === null) {
    return `這週的樂透只有 ${w.buyers} 個人買,沒有開獎,錢都退回去了。`;
  }
  return `這週的樂透開獎了:${safeName(w.winner.name)} 抽中,獎金 ${w.prize} ${currency}(一共 ${w.buyers} 個人、${w.tickets} 張)。`;
}
