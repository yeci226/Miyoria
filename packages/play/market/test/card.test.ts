// The market's card on the panel: the open lot's top bid and bidders, the lottery's pot and buyers,
// at most four facts, and the nearest of the lot's end, the next opening and the draw.

import { CARD_MAX_FACTS } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { marketCard } from "../src/card.js";
import { MarketModule } from "../src/module.js";
import { ALICE, BOB, DAY, DRAW, HOUR, OPENS, type Rig, rig, T0 } from "./rig.js";

async function card(r: Rig) {
  const [auction, lottery] = await Promise.all([
    r.service.auctionView(null),
    r.service.lotteryView(null),
  ]);
  return marketCard(auction, lottery, r.clock.at);
}

describe("market card", () => {
  it("before the lot opens: the lottery so far, and the opening as the next thing", async () => {
    const r = await rig({ lottery_price: 10 });
    r.wallet.fund(ALICE, 100);
    expect(await r.service.buyTickets(ALICE, 3, "k1")).toMatchObject({ ok: true });
    const c = await card(r);
    expect(c.facts).toEqual([
      { label: "樂透獎池", value: 30, unit: "魚幣" },
      { label: "樂透人數", value: 1, unit: "人" },
      { label: "樂透賣出", value: 3, unit: "張" },
    ]);
    expect(c.next).toEqual({ label: "開拍", at: new Date(OPENS).toISOString() });
  });

  it("while the lot is open: its top bid and bidders first, four facts, the end next", async () => {
    const r = await rig();
    r.clock.at = OPENS;
    await r.service.tick();
    for (const a of [ALICE, BOB]) r.wallet.fund(a, 1000);
    const opening = r.service.config.auction_opening_bid;
    expect(await r.service.bid(ALICE, opening)).toMatchObject({ ok: true });
    expect(await r.service.bid(BOB, opening + 50)).toMatchObject({ ok: true });
    const c = await card(r);
    expect(c.facts).toHaveLength(CARD_MAX_FACTS);
    expect(c.facts.slice(0, 2)).toEqual([
      { label: "最高出價", value: opening + 50, unit: "魚幣" },
      { label: "出價人數", value: 2, unit: "人" },
    ]);
    expect(c.facts.map((f) => f.label).slice(2)).toEqual(["樂透獎池", "樂透人數"]);
    // The lot ends 24 hours after it opened, the moment of Sunday's draw: the lot's end is told.
    expect(OPENS + 24 * HOUR).toBe(DRAW);
    expect(c.next).toEqual({ label: "結標", at: new Date(DRAW).toISOString() });
  });

  it("after the lot ended: the draw if it is nearer than next week's opening", async () => {
    const r = await rig({ auction: false });
    r.clock.at = OPENS + 2 * HOUR;
    const c = await card(r);
    expect(c.facts.map((f) => f.label)).toEqual(["樂透獎池", "樂透人數", "樂透賣出"]);
    expect(c.next).toEqual({ label: "開獎", at: new Date(DRAW).toISOString() });
  });

  it("has nothing for a market with both off, and nothing before the module runs", async () => {
    const r = await rig({ auction: false, lottery: false });
    r.clock.at = T0 + DAY;
    expect(await card(r)).toEqual({ facts: [] });
    expect(await new MarketModule().card()).toEqual({ facts: [] });
  });
});
