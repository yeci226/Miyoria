// Her weekly shop (docs/design/v4-plan.md §10): a small shelf she restocks every week with titles and
// collectibles that coins can buy, a pure sink with a share that goes to her own purse.
//
// * `shop_catalog` is what she may stock; each local week `shop_slots` of it are on the shelf, picked
//   by a hash of the week and the item so the shelf is the same for everybody all week and needs no
//   storage (and no dice). Prices are config, no discount for anyone.
// * A title is added to the buyer's titles once; a collectible goes in the album (a spare can be
//   given on, collection.ts). Buying never changes how she feels about anyone.
// * `shop_her_share` of the price goes to her purse (reason `shop_pay`, keyed on the sale); the rest
//   leaves the economy. The sale is the ledger row (`shop`), the goods are documents with
//   deterministic ids, so the same key twice answers the same purchase and a crash is finished once.

import { type AccountRef, toTimestamp } from "@miyoria/types";
import type { ShopStock } from "./config.js";
import type { EconomyDoc } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { EconomyError } from "./types.js";
import type { ShopBuyResult, ShopView } from "./v2-types.js";

const TITLE = "title";
const WEEK_DAYS = 7;

export const NOT_ON_SHELF = "這個這個禮拜沒有上架";
export const HAVE_TITLE = "這個稱號你已經有了";

/** A stable, spread-out number for a string (FNV-1a), so a shelf needs no storage. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class ShopDesk {
  constructor(private readonly e: EconomyService) {}

  #week(): number {
    return Math.floor(this.e.today() / WEEK_DAYS);
  }

  /** What is on the shelf this local week. */
  stock(): ShopStock[] {
    const week = this.#week();
    return [...this.e.config.shop_catalog]
      .sort((a, b) => hash(`${week}:${a.id}`) - hash(`${week}:${b.id}`) || (a.id < b.id ? -1 : 1))
      .slice(0, this.e.config.shop_slots);
  }

  async #titles(who: Member): Promise<EconomyDoc[]> {
    return this.e.docs().list(this.e.profile, TITLE, { owners: who.wallet, limit: 100 });
  }

  /** The titles a person bought. */
  async titles(who: Member): Promise<string[]> {
    return (await this.#titles(who)).map((d) =>
      String((d.data as { title?: unknown }).title ?? ""),
    );
  }

  async view(account: AccountRef): Promise<ShopView> {
    const who = await this.e.member(account);
    const have = new Set(who ? await this.titles(who) : []);
    const owned = who ? (await this.e.v2.collection.owned(who)).items : new Map<string, number>();
    return {
      member: who !== null,
      renews_at: this.e.dayStart((this.#week() + 1) * WEEK_DAYS),
      items: this.stock().map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        price: s.price,
        owned: s.kind === "title" ? have.has(s.item) : (owned.get(s.item) ?? 0),
      })),
    };
  }

  async buy(account: AccountRef, ref: string, key: string): Promise<ShopBuyResult> {
    const want = ref.trim();
    const item = this.stock().find((s) => s.id === want || s.label === want);
    if (!item) throw new EconomyError(409, NOT_ON_SHELF);
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `shop:${key}`;
    const done = await this.e.serial(async () => {
      const first = await this.e.byKey(who, idem);
      if (first) {
        // Charged before: make sure the goods exist (a crash may have come between), once.
        if ((await this.e.byKey(who, `refund:${first.id}`)) !== null) {
          throw new EconomyError(409, "這筆沒有成立，已經退回，再買一次");
        }
        await this.#give(who, item, first.id);
        return { entry: first, fresh: false };
      }
      if (item.kind === "title" && (await this.titles(who)).includes(item.item)) {
        throw new EconomyError(409, HAVE_TITLE);
      }
      const spent = await this.e.spend(who, item.price, "shop", item.id, idem);
      try {
        await this.#give(who, item, spent.entry.id);
      } catch (error) {
        await this.e.refundOnce(who, spent.entry);
        throw error;
      }
      const mine = Math.floor(item.price * this.e.config.shop_her_share);
      if (mine > 0) {
        await this.e.purse.credit(mine, "shop_pay", spent.entry.id, `shop-pay:${spent.entry.id}`);
        this.e.purse.news(
          `shop:${spent.entry.id}`,
          `{who}在你的小店買了「${item.label}」`,
          who.name,
        );
      }
      return { entry: spent.entry, fresh: true };
    });
    if (done.fresh) {
      this.e.record(who, "economy.shop.buy", { item: item.id, price: item.price });
      await this.e.purse.refresh();
      await this.e.v2.afterEarn(who);
    }
    return {
      item: { id: item.id, label: item.label, kind: item.kind },
      charged: item.price,
      balance: await this.e.ledger().balance(this.e.profile, who.wallet),
      duplicate: !done.fresh,
    };
  }

  /** Puts the goods with the buyer; ids come from the sale so it is the same goods every time. */
  async #give(who: Member, item: ShopStock, entry: string): Promise<void> {
    if (item.kind === "collectible") {
      await this.e.v2.collection.grant(who, item.item, "shop", `shop:${entry}`);
      return;
    }
    const at = toTimestamp(this.e.now());
    await this.e.docs().create({
      id: `title:${who.person.id}:${item.id}`,
      profile: this.e.profile,
      kind: TITLE,
      owner: who.account,
      status: "held",
      version: 1,
      data: { title: item.item, source: entry },
      created_at: at,
      updated_at: at,
    });
  }
}
