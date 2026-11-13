// Collecting (docs/design/cards.md §4 and §7, docs/design/v4-plan.md §10): rarity with public odds,
// an album, drawing, and giving spares away.
//
// * The catalogue is `collection_series`: series of collectibles, each with a rarity. The odds are
//   `rarity_weights` and are the same numbers `odds()` publishes; a rarity with nothing in it is
//   left out and the rest share its weight. `draw_pity` guarantees an SR or better after that many
//   draws without one. Changing a weight is a config change, which is the record cards.md asks for.
// * A draw costs `draw_price` (a sink, nobody gets a share), at most `draws_per_day`, keyed so a
//   retry answers the same draw. The ledger row is the draw's receipt and its id is the item's id,
//   so a crash between the charge and the item is mended by the retry, and an item that cannot be
//   written gives the coins back.
// * Items are documents (docs.ts), owned by an account; a person's album is every account's items.
//   Rarity is only a label: it changes no number about her and no relationship (cards.md §2.4).
// * Giving: only spare copies (the album never loses an entry), only things from a draw or her shop
//   (a portrait card is her view of one person and never moves, cards.md §2.5), to someone else she
//   knows, `item_gifts_per_day` out and in. Coins never move with an item and it cannot be sold.
// * Portrait cards from the card service land here too (`recordCard`): the traits a card was drawn
//   with fill the album, which is what makes the album a picture of the cards a person has had.

import { type AccountRef, sameAccount, toTimestamp } from "@miyoria/types";
import { type Collectible, RARITIES, type Rarity, type Series } from "./config.js";
import { type EconomyDoc, newestFirst } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { NO_RECEIVER, OWN_ACCOUNT } from "./transfer.js";
import { EconomyError } from "./types.js";
import type {
  AlbumView,
  DrawResult,
  GiveItemResult,
  ItemRef,
  OddsRow,
  SeriesView,
} from "./v2-types.js";

const KIND = "item";
const GIFT = "itemgift";
const MAX_ITEMS = 5_000;
const MAX_GIFT_ROWS = 200;
const PITY_LOOKBACK = 500;
/** Where an item came from; only `draw` and `shop` can be given away. */
type Source = "draw" | "shop" | "card" | "gift";
const GIVABLE: readonly Source[] = ["draw", "shop"];

export const NOT_GIVABLE = "這種收藏不能送人";
export const NO_SPARE = "只有重複的才能送人";
export const NO_ITEM = "沒有這個收藏";
export const GIFTS_CLOSED = "現在沒有開放送收藏";
export const COLLECTION_EMPTY = "收藏現在是空的";

/** What an item document holds (`docs.ts` stores it as JSON). */
interface ItemData {
  item: string;
  rarity: Rarity;
  source: Source;
  [key: string]: string;
}

const percent = (part: number, total: number) => Math.round((part / total) * 10_000) / 100;

export class Collection {
  constructor(private readonly e: EconomyService) {}

  // ---- the catalogue ---------------------------------------------------------------------

  #series(): readonly Series[] {
    return this.e.config.collection_series;
  }

  /** The collectible `id` and the series it is in, or `null`. */
  find(id: string): { item: Collectible; series: Series } | null {
    for (const series of this.#series()) {
      const item = series.items.find((i) => i.id === id);
      if (item) return { item, series };
    }
    return null;
  }

  #byLabel(label: string): { item: Collectible; series: Series } | null {
    const want = label.trim();
    for (const series of this.#series()) {
      const item = series.items.find((i) => i.label === want);
      if (item) return { item, series };
    }
    return null;
  }

  /** Every collectible of one rarity. */
  #pool(rarity: Rarity): { item: Collectible; series: Series }[] {
    return this.#series().flatMap((series) =>
      series.items.filter((i) => i.rarity === rarity).map((item) => ({ item, series })),
    );
  }

  /** The weights as configured, rarity by rarity. */
  #weights(): Record<Rarity, number> {
    return this.e.config.rarity_weights;
  }

  /**
   * The odds of one draw as published: each rarity that has something in it, its share in percent,
   * and what is in it.
   */
  odds(): OddsRow[] {
    const w = this.#weights();
    const live = RARITIES.filter((r) => w[r] > 0 && this.#pool(r).length > 0);
    const total = live.reduce((n, r) => n + w[r], 0);
    return live.map((rarity) => ({
      rarity,
      percent: percent(w[rarity], total),
      items: this.#pool(rarity).map((p) => ({ id: p.item.id, label: p.item.label })),
    }));
  }

  /** The configured odds of a rarity alone, for things that are not a collectible (a card). */
  rarityOdds(): { rarity: Rarity; percent: number }[] {
    const w = this.#weights();
    const total = RARITIES.reduce((n, r) => n + w[r], 0);
    return RARITIES.map((rarity) => ({ rarity, percent: percent(w[rarity], total) }));
  }

  /** A rarity by the configured weights; the card service rolls its cards with this. */
  rollRarity(): Rarity {
    const w = this.#weights();
    const total = RARITIES.reduce((n, r) => n + w[r], 0);
    let at = this.e.random() * total;
    for (const rarity of RARITIES) {
      at -= w[rarity];
      if (at < 0 && w[rarity] > 0) return rarity;
    }
    return RARITIES.findLast((r) => w[r] > 0) ?? "N";
  }

  /** One collectible by the published odds; `better` leaves only SR and above (the pity). */
  #roll(better: boolean): { item: Collectible; series: Series } {
    const w = this.#weights();
    let live = RARITIES.filter((r) => w[r] > 0 && this.#pool(r).length > 0);
    if (better && live.some((r) => r === "SR" || r === "SSR")) {
      live = live.filter((r) => r === "SR" || r === "SSR");
    }
    const total = live.reduce((n, r) => n + w[r], 0);
    if (live.length === 0 || total <= 0) throw new EconomyError(503, COLLECTION_EMPTY);
    let at = this.e.random() * total;
    let rarity: Rarity = live[live.length - 1] ?? "N";
    for (const r of live) {
      at -= w[r];
      if (at < 0) {
        rarity = r;
        break;
      }
    }
    const pool = this.#pool(rarity);
    const pick = pool[Math.min(Math.floor(this.e.random() * pool.length), pool.length - 1)];
    if (!pick) throw new EconomyError(503, COLLECTION_EMPTY);
    return pick;
  }

  // ---- what a person owns ----------------------------------------------------------------

  async #held(who: Member): Promise<EconomyDoc[]> {
    return this.e.docs().list(this.e.profile, KIND, {
      owners: who.wallet,
      statuses: ["held"],
      limit: MAX_ITEMS,
    });
  }

  /** The distinct collectibles of the catalogue owned, with copies, and the series complete. */
  async owned(who: Member): Promise<{
    items: Map<string, number>;
    series: Set<string>;
  }> {
    const items = new Map<string, number>();
    for (const doc of await this.#held(who)) {
      const id = String((doc.data as { item?: unknown }).item ?? "");
      if (this.find(id)) items.set(id, (items.get(id) ?? 0) + 1);
    }
    const series = new Set(
      this.#series()
        .filter((s) => s.items.every((i) => items.has(i.id)))
        .map((s) => s.id),
    );
    return { items, series };
  }

  /** Puts a collectible in someone's album (a draw, her shop, a card). `true` when it is new. */
  async grant(who: Member, id: string, source: Source, docId: string): Promise<boolean> {
    const found = this.find(id);
    if (!found) throw new EconomyError(400, NO_ITEM);
    const now = toTimestamp(this.e.now());
    const data: ItemData = { item: id, rarity: found.item.rarity, source };
    return this.e.docs().create({
      id: docId,
      profile: this.e.profile,
      kind: KIND,
      owner: who.account,
      status: "held",
      version: 1,
      data,
      created_at: now,
      updated_at: now,
    });
  }

  async album(account: AccountRef): Promise<AlbumView> {
    const c = this.e.config;
    const who = await this.e.member(account);
    const owned = who
      ? await this.owned(who)
      : { items: new Map<string, number>(), series: new Set<string>() };
    const series: SeriesView[] = this.#series().map((s) => {
      const items = s.items.map((i) => ({
        id: i.id,
        label: i.label,
        rarity: i.rarity,
        owned: owned.items.get(i.id) ?? 0,
      }));
      return {
        id: s.id,
        label: s.label,
        title: s.title,
        items,
        owned_distinct: items.filter((i) => i.owned > 0).length,
        total: items.length,
        complete: owned.series.has(s.id),
      };
    });
    let drawsToday = 0;
    let sinceBest = 0;
    if (who) {
      const rows = await this.e.rowsToday(who);
      const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
      drawsToday = rows.filter((r) => r.reason === "draw" && !refunded.has(r.id)).length;
      sinceBest = await this.#sinceBest(who);
    }
    return {
      member: who !== null,
      series,
      odds: this.odds(),
      price: c.draw_price,
      draws_today: drawsToday,
      draws_per_day: c.draws_per_day,
      pity: c.draw_pity,
      since_best: sinceBest,
    };
  }

  /** Draws since the last SR or better one (draws only: a gift or her shop does not count). */
  async #sinceBest(who: Member): Promise<number> {
    const docs = await this.e.docs().list(this.e.profile, KIND, {
      owners: who.wallet,
      limit: PITY_LOOKBACK,
    });
    // Items that left (given away) keep counting for their drawer, so look at every status.
    const draws = docs
      .filter((d) => (d.data as { source?: unknown }).source === "draw")
      .sort(newestFirst);
    const at = draws.findIndex((d) => {
      const rarity = (d.data as { rarity?: unknown }).rarity;
      return rarity === "SR" || rarity === "SSR";
    });
    return at < 0 ? draws.length : at;
  }

  // ---- drawing ---------------------------------------------------------------------------

  async draw(account: AccountRef, key: string): Promise<DrawResult> {
    const c = this.e.config;
    if (c.draw_price <= 0 || c.draws_per_day <= 0) throw new EconomyError(400, "現在不開放抽收藏");
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `draw:${key}`;
    return this.e
      .serial(async (): Promise<DrawResult> => {
        const first = await this.e.byKey(who, idem);
        if (first) {
          // Given back when the item could not be written: that draw never happened.
          if ((await this.e.byKey(who, `refund:${first.id}`)) !== null) {
            throw new EconomyError(409, "這次沒有抽成，已經退回，再抽一次");
          }
          // The charge went through before: finish what it was for, once.
          const id = first.ref ?? "";
          await this.grant(who, id, "draw", first.id).catch(() => false);
          return this.#result(id, first.id, -first.delta, true, false);
        }
        const rows = await this.e.rowsToday(who);
        const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
        const today = rows.filter((r) => r.reason === "draw" && !refunded.has(r.id)).length;
        if (today >= c.draws_per_day) {
          throw new EconomyError(429, `今天最多抽 ${c.draws_per_day} 次`);
        }
        const since = await this.#sinceBest(who);
        const pity = c.draw_pity > 0 && since + 1 >= c.draw_pity;
        const pick = this.#roll(pity);
        const before = await this.owned(who);
        const spent = await this.e.spend(who, c.draw_price, "draw", pick.item.id, idem);
        try {
          await this.grant(who, pick.item.id, "draw", spent.entry.id);
        } catch (error) {
          await this.e.refundOnce(who, spent.entry);
          throw error;
        }
        return this.#result(
          pick.item.id,
          spent.entry.id,
          c.draw_price,
          false,
          !before.items.has(pick.item.id),
          pity && (pick.item.rarity === "SR" || pick.item.rarity === "SSR"),
        );
      })
      .then(async (r) => {
        const unlocked = await this.e.v2.afterEarn(who);
        const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
        return unlocked.length > 0 ? { ...r, balance, unlocked } : { ...r, balance };
      });
  }

  #result(
    id: string,
    entry: string,
    charged: number,
    duplicate: boolean,
    isNew: boolean,
    byPity = false,
  ): DrawResult {
    const found = this.find(id);
    return {
      entry_id: entry,
      item: found
        ? { id, label: found.item.label, rarity: found.item.rarity, series: found.series.label }
        : { id, label: id, rarity: "N", series: "" },
      charged,
      balance: 0,
      duplicate,
      new: isNew,
      by_pity: byPity,
    };
  }

  // ---- the traits of a portrait card -------------------------------------------------------

  /**
   * The card service tells the album what a card was drawn with: every trait that is a collectible
   * of the catalogue goes in the owner's album (once per card and trait). Returns how many were
   * new to the person. A stranger's cards are not recorded.
   */
  async recordCard(
    account: AccountRef,
    serial: string,
    traits: readonly string[],
  ): Promise<number> {
    const who = await this.e.member(account);
    if (!who) return 0;
    const before = await this.owned(who);
    let fresh = 0;
    for (const trait of new Set(traits)) {
      if (!this.find(trait)) continue;
      const added = await this.grant(who, trait, "card", `card:${serial}:${trait}`);
      if (added && !before.items.has(trait)) fresh += 1;
    }
    if (fresh > 0) await this.e.v2.afterEarn(who);
    return fresh;
  }

  // ---- giving ----------------------------------------------------------------------------

  async #giftsToday(who: Member, dir: "out" | "in"): Promise<number> {
    const since = this.e.todayStart();
    const docs = await this.e.docs().list(this.e.profile, GIFT, {
      owners: who.wallet,
      limit: MAX_GIFT_ROWS,
    });
    return docs.filter((d) => d.created_at >= since && (d.data as { dir?: unknown }).dir === dir)
      .length;
  }

  /**
   * One spare copy of collectible `id` from `from` to `to` (another person she knows). Keyed: the
   * same key answers the same gift. Everything that keeps the receiver from receiving answers in
   * the same words as a transfer's.
   */
  async give(from: AccountRef, to: AccountRef, name: string, key: string): Promise<GiveItemResult> {
    const c = this.e.config;
    if (c.item_gifts_per_day <= 0) throw new EconomyError(400, GIFTS_CLOSED);
    // The id, or the label as the album shows it.
    const found = this.find(name) ?? this.#byLabel(name);
    if (!found) throw new EconomyError(400, NO_ITEM);
    const id = found.item.id;
    const sender = await this.e.member(from);
    if (!sender) throw new EconomyError(403, STRANGER);
    const receiver = await this.e.member(to);
    if (!receiver) throw new EconomyError(403, NO_RECEIVER);
    if (
      receiver.person.id === sender.person.id ||
      sender.wallet.some((a) => sameAccount(a, receiver.account))
    ) {
      throw new EconomyError(400, OWN_ACCOUNT);
    }
    const given = await this.e.serial(async (): Promise<GiveItemResult> => {
      const docs = this.e.docs();
      const outId = `gift:${key}`;
      const label = this.find(id)?.item.label ?? id;
      const done = await docs.get(this.e.profile, GIFT, outId);
      if (done) return { item: id, label, to: receiver.name, duplicate: true };
      const held = (await this.#held(sender)).filter(
        (d) => (d.data as { item?: unknown }).item === id,
      );
      const givable = held
        .filter((d) => GIVABLE.includes((d.data as { source?: Source }).source as Source))
        .sort(newestFirst);
      if (held.length === 0) throw new EconomyError(409, NO_ITEM);
      if (held.length < 2) throw new EconomyError(409, NO_SPARE);
      const copy = givable[0];
      if (!copy) throw new EconomyError(409, NOT_GIVABLE);
      if ((await this.#giftsToday(sender, "out")) >= c.item_gifts_per_day) {
        throw new EconomyError(429, `今天最多送 ${c.item_gifts_per_day} 個`);
      }
      if ((await this.#giftsToday(receiver, "in")) >= c.item_gifts_per_day) {
        throw new EconomyError(403, NO_RECEIVER);
      }
      const at = toTimestamp(this.e.now());
      const moved = await docs.update(this.e.profile, KIND, copy.id, copy.version, {
        status: "held",
        data: { ...copy.data, source: "gift" },
        owner: receiver.account,
        at,
      });
      if (!moved) throw new EconomyError(409, NO_ITEM);
      const note = (owner: AccountRef, dir: "out" | "in", id2: string) =>
        docs.create({
          id: id2,
          profile: this.e.profile,
          kind: GIFT,
          owner,
          status: "done",
          version: 1,
          data: { dir, item: id },
          created_at: at,
          updated_at: at,
        });
      await note(sender.account, "out", outId);
      await note(receiver.account, "in", `${outId}~in`);
      this.e.record(sender, "economy.item_gift", { item: id, to: receiver.person.id });
      return { item: id, label, to: receiver.name, duplicate: false };
    });
    // Outside the turn: the check pays, and paying takes a turn.
    if (!given.duplicate) await this.e.v2.afterEarn(receiver);
    return given;
  }

  /** The label and rarity of an item, for the tools. */
  describe(ref: string): ItemRef | null {
    const found = this.find(ref);
    return found ? { id: ref, label: found.item.label, rarity: found.item.rarity } : null;
  }
}
