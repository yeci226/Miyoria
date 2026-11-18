// The cards module's card on the panel: today's cards, coins, drops and pity hits, counted over her
// local day, and the day's reset as the next thing.

import { heartTables } from "@miyoria/heart/person";
import { CARD_MAX_FACTS, Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardsKey,
  CardsModule,
  type CardWallet,
  CardWalletKey,
  cardsTables,
} from "../src/index.js";

// 10:00 on 2026-11-17 at UTC+8.
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const DAY = 86_400_000;
let now = T0;
const clock = { now: () => now };

const FACE = {
  name: "小明",
  avatar_url: null,
  call_name: null,
  line: null,
  stamp: null,
  fields: [],
  number: 1,
};
const face = async () => FACE;
const payer = (person: string) => ({ person, account: { platform: "discord", id: person } });

const wallet: CardWallet = {
  async balance() {
    return 1_000;
  },
  async spend(_payer, _amount) {
    return { ok: true, receipt: "r", balance: 1_000 };
  },
  foilPrice() {
    return null;
  },
  async foil() {
    return { ok: false, reason: "refused", message: "not on sale" };
  },
  async refund() {
    return 0;
  },
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  now = T0;
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(config: JsonObject | null = null) {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables, cardsTables], clock });
  cleanup.push(() => store.close());
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", StoreKey, store);
  sup.services.provide("economy", CardWalletKey, wallet);
  const module = new CardsModule({ clock });
  await sup.register(module, config, true);
  await sup.startAll();
  return { store, sup, module };
}

describe("cards card", () => {
  it("counts today's cards, coins and drops, and not yesterday's", async () => {
    const { store, sup, module } = await start({ price: 12, daily_cap: 3 });
    const cards = sup.services.get(CardsKey);
    now = T0 - DAY;
    expect((await cards?.issueDaily(payer("p1"), face))?.ok).toBe(true);
    now = T0;
    expect((await cards?.issueDaily(payer("p1"), face))?.ok).toBe(true);
    expect((await cards?.issueDaily(payer("p2"), face))?.ok).toBe(true);
    store.plugin(cardsTables).addDrop("d1", "discord:g1:c1", T0, T0 + 60_000);
    const card = await module.card();
    expect(card.facts.length).toBeLessThanOrEqual(CARD_MAX_FACTS);
    expect(card.facts).toEqual([
      { label: "今天發出", value: 2, unit: "張" },
      { label: "今天收入", value: 24, unit: "魚幣" },
      { label: "今天掉落", value: 1, unit: "次" },
      { label: "保底觸發", value: 0, unit: "次" },
    ]);
    // Her next midnight at UTC+8.
    expect(card.next).toEqual({ label: "每日重置", at: "2026-11-17T16:00:00.000Z" });
  });

  it("follows the configured offset for the day's reset", async () => {
    const { module } = await start({ utc_offset_minutes: 0 });
    expect((await module.card()).next?.at).toBe("2026-11-18T00:00:00.000Z");
  });

  it("has nothing to show before it runs, or without a store", async () => {
    expect(await new CardsModule({ clock }).card()).toEqual({ facts: [] });
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    const module = new CardsModule({ clock });
    await sup.register(module, null, true);
    await sup.startAll();
    expect(await module.card()).toEqual({ facts: [] });
  });
});
