// What she knows of the exchange (owner 2026-11-21): facts, never instructions. Who is bankrupt now
// and this week's notable wins and losses, only of people who have not hidden themselves from the
// boards; someone who hides is never named to her. She may tease or keep her distance in her own
// voice: this changes her TONE only. Coins never buy bond and nothing here touches bond; she gives
// no ratings, no price predictions and never answers "should I buy X".

import type { ExchangeService } from "./service.js";

/** What her note says she does not do, every time. */
export const HER_RULES =
  "這些只是遊戲裡的事實,不是要你做什麼:你不評等股票、不預測價格、不回答「該不該買」,也不因為誰賺賠就改變你和他的關係。";

/** Her note of the exchange's facts, or `null` when there is nothing to say. */
export async function herNote(service: ExchangeService): Promise<string | null> {
  const shown = new Set(
    service.store
      .accounts()
      .filter((a) => !a.hide_boards)
      .map((a) => a.person),
  );
  const f = service.real.facts(shown);
  if (f.bankrupt.length === 0 && f.wins.length === 0 && f.losses.length === 0) return null;
  const name = async (p: string) => (await service.nameOf(p)) ?? "某人";
  const parts: string[] = [];
  if (f.bankrupt.length > 0)
    parts.push(
      `交易所裡破產(冷靜期中)的人:${(await Promise.all(f.bankrupt.map(name))).join("、")}`,
    );
  if (f.wins.length > 0)
    parts.push(
      `這週賺最多:${(await Promise.all(f.wins.map(async (w) => `${await name(w.person)} +${w.result}`))).join("、")}`,
    );
  if (f.losses.length > 0)
    parts.push(
      `這週賠最多:${(await Promise.all(f.losses.map(async (w) => `${await name(w.person)} ${w.result}`))).join("、")}`,
    );
  return `${parts.join("。")}。${HER_RULES}`;
}
