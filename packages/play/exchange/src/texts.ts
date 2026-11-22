// What a member is told about their own positions and orders, in plain words (owner 2026-11-21):
// every line says what the market's rule did and what the numbers were, never that she did
// anything. The same sentences go on their page, in a DM, and in the order's record.

import { DEFAULT_CURRENCY } from "@miyoria/types";
import {
  COMPANIES,
  type CompanySpec,
  companyOf,
  type EndWhy,
  type Notice,
  priceText,
} from "./engine/index.js";

/** The coins' name when none is given (`DEFAULT_CURRENCY`). */
export const CURRENCY = DEFAULT_CURRENCY;

function company(code: string, companies: readonly CompanySpec[]): string {
  const c = companyOf(code, companies);
  return c ? `${c.code}(${c.name})` : code;
}

const pct = (r: number) => `${Math.max(0, Math.round(r * 100))}%`;

/** Her local hour of a round, `14:00`. */
export function hourOf(round: number, roundsPerDay: number, firstHour: number): string {
  const slot = round - Math.floor(round / roundsPerDay) * roundsPerDay;
  return `${String(firstHour + slot).padStart(2, "0")}:00`;
}

/** A margin warning or a liquidation, as the person reads it. */
export function noticeText(
  n: Notice,
  hour: string,
  currency = CURRENCY,
  companies: readonly CompanySpec[] = COMPANIES,
): string {
  const who = company(n.company, companies);
  const line = priceText(n.line_price);
  const now = priceText(n.price);
  switch (n.kind) {
    case "warn_half":
      return `${who} 的槓桿部位:保證金剩 ${pct(n.ratio)}(已經少了一半)。現價 ${now};跌到 ${line} 會依規則自動賣出。可以加保證金,或自己賣掉。`;
    case "warn_near":
      return `${who} 的槓桿部位:保證金剩 ${pct(n.ratio)},接近自動賣出的價格。現價 ${now};跌到 ${line} 會依規則自動賣出。可以加保證金,或自己賣掉。`;
    case "liquidated":
      return n.paid === null
        ? `${who} 的槓桿部位在 ${hour} 那一盤到了自動賣出的價格 ${line},依規則以 ${now} 賣出。金庫這一盤付不出剩下的保證金,會在付得出來時第一個付給你。`
        : `${who} 的槓桿部位在 ${hour} 那一盤到了自動賣出的價格 ${line},依規則以 ${now} 賣出,剩下的保證金扣掉手續費和稅,退回 ${n.paid} ${currency}。你錢包裡的其他${currency}和持股都沒有動。`;
    case "owed_paid":
      return `${who} 那筆自動賣出欠你的 ${n.paid ?? 0} ${currency},金庫付清了。`;
  }
}

/** Why an order ended, in a few words. */
export const END_WHY: Readonly<Record<EndWhy, string>> = {
  filled: "成交",
  day_end: "當天沒有成交,收盤後退回",
  expired: "到期沒有成交,退回",
  skipped: "那一盤因為系統停機沒有撮合,退回",
  halted: "大盤熔斷,當天不再撮合,退回",
  paused: "交易所暫停,退回",
  too_small: "金額太小,買不到任何股數,退回",
  no_holding: "沒有可以賣的持股",
  cancelled: "取消了",
};

/** A buy that went back without filling: the line on their page. */
export function refundText(
  code: string,
  coins: number,
  why: EndWhy,
  currency = CURRENCY,
  companies: readonly CompanySpec[] = COMPANIES,
): string {
  return `${company(code, companies)} 的買單${END_WHY[why]} ${coins} ${currency}(手續費一起退回)。`;
}
