// Free-form gifts (docs/design/economy.md §16): a member names anything (「一杯珍奶」「一把電吉他」),
// the system prices it, the member confirms, and she decides whether she takes it.
//
// * Asking (`ask`) charges nothing. The name is made plain (`giftName`); the fixed foods named in
//   words go to the ordinary feed instead (`fixed`, no confirmation, exactly as before). Rules,
//   moderation, the owner's pins and blocks and the price cache come first; only a name never seen
//   costs one small model call (`GiftPricerKey`), within a per-person and a global daily count. The
//   model only estimates what a plain one costs in NT$ (and a kind), or refuses; the price is that
//   estimate at the economy's one fixed rate (`twd_per_coin`, the exchange's too), rounded and held
//   within `[min_coins, max_coins]`. An estimate kept in NT$ follows the rate when it changes.
//   Without a usable answer the fallback price is used, not kept, and the quote says so. Nothing
//   the member writes is read as a price.
// * Confirming (`confirm`) is the only charge: one `gift` row of the ledger keyed `gift:<id>`, so a
//   second press or a retry charges once. Only the person who asked may confirm, before
//   `confirm_s` runs out; an expired or cancelled gift costs nothing. Food and drink count against
//   the same daily share of her hunger (`feed_hunger_cap`) as rice, checked at both steps.
// * She is told as a silent note in her working context (the name escaped, as data), with what
//   the giver gave her before, and answers with her tool `answer_gift` on a normal turn: she takes
//   it (her line, maybe a favourite) or says no (the charge goes back in full). When she has not
//   answered in `answer_s`, the sweep takes it for her with a plain line, the way feeding never
//   waits for her.
// * Taking it: her share (`her_share`, floored) goes to her purse and the rest is burned, as for
//   feeding; food lowers her hunger; she feels it as the `gift` social event (emotion only); it is
//   kept as a note about the giver (`PersonNoteWriter`). No gift changes bond, trust or anything
//   else of the heart's, at any price: nothing here calls `RelationshipEffects` or writes heart
//   evidence, and no quest or achievement counts these rows.

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type EventPayload,
  Events,
  type JsonValue,
  ModerationKey,
  newId,
  type PersonId,
  PersonNoteWriterKey,
  SelfStateKey,
  safeName,
  serviceKey,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  CANNOT_FEED,
  type EconomyService,
  FULL,
  hungerOf,
  type Member,
  plainName,
  STRANGER,
} from "./economy.js";
import { OLD_TIER_COINS } from "./gift-config.js";
import type { GiftPrice, GiftRecord, GiftSource, GiftStatus, GiftTables } from "./gift-tables.js";
import {
  bandOf,
  coinsOf,
  fixedFood,
  foodHunger,
  GIFT_KINDS,
  GIFT_REASON,
  type GiftKind,
  GiftPricerKey,
  type GiftRefusal,
  type GiftVerdict,
  giftHunger,
  giftKey,
  giftName,
  giftRef,
  isEdible,
  KIND_WORD,
  REFUSAL_TEXT,
  refusalText,
  ruleRefusal,
} from "./gift-words.js";
import { type CoinEntry, PURSE } from "./records.js";
import { EconomyError, type FeedItem } from "./types.js";

/** Below this much of a share left, it is spent (as `#feedLeft`). */
const FEED_EPSILON = 1e-9;
/** Today's gifts of a person read for the caps; far more than a day allows. */
const MAX_TODAY = 200;
/** What the giver gave her before, told to her with a new one. */
const PAST_TOLD = 3;
/** Gifts the sweep settles per pass at most. */
const SWEEP_BATCH = 50;
/** Longest line of hers kept. */
export const MAX_GIFT_LINE = 60;
/** How important a kept gift is as a memory of the giver. */
const NOTE_IMPORTANCE = 0.45;

/** Why a gift was not quoted, beyond what the thing is: she is full for them, or cannot eat now. */
export type GiftNo = GiftRefusal | "full" | "unavailable" | "short";

/** What the member is shown before anything is charged. */
export interface GiftQuote {
  id: string;
  item: string;
  kind: GiftKind;
  /** 「吃的」「小東西」. */
  kind_word: string;
  /** The real-world estimate in NT$ the price came from; `null` for a coin pin or the fallback. */
  twd: number | null;
  /** NT$ a coin (`twd_per_coin`), as it was used. */
  twd_per_coin: number;
  /** 「有點心意」: the price in words (`band_coins`). */
  band: string;
  price: number;
  /** Above `big_gift_coins`: the card says it is a large gift and what is left after. */
  big: boolean;
  currency: string;
  balance: number;
  balance_after: number;
  expires_at: Timestamp;
  /** The price is the fallback: it could not be estimated now. */
  fallback: boolean;
  /** A line for the member, e.g. why it is the fallback price; `null`: none. */
  note: string | null;
}

/** The answer to naming a gift: a quote to confirm, a fixed food (fed at once), or a no. */
export type GiftAsk =
  | { status: "quote"; quote: GiftQuote }
  | { status: "fixed"; item: FeedItem }
  | { status: "refused"; reason: GiftNo; message: string };

/** A gift as its giver (and the owner) sees it. */
export interface GiftView {
  id: string;
  item: string;
  kind: GiftKind | null;
  kind_word: string | null;
  /** The old scheme's tier, on gifts priced before the NT$ estimates. */
  tier: number | null;
  price: number;
  /** The NT$ estimate the price came from, if any. */
  twd: number | null;
  status: GiftStatus;
  /** Her line; `null` when she said nothing or it was taken for her. */
  line: string | null;
  favourite: boolean;
  /** `her`, `system` (taken for her), `admin`; `null` while unanswered. */
  answered_by: "her" | "system" | "admin" | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  answer_due: Timestamp | null;
  answered_at: Timestamp | null;
}

/** What confirming did. */
export interface GiftConfirmed {
  gift: GiftView;
  /** Charged by this call (false: an earlier press did). */
  charged: boolean;
  balance: number;
}

/** One gift in her public collection: the giver only when they stay on public boards. */
export interface PublicGift {
  id: string;
  item: string;
  kind: GiftKind | null;
  kind_word: string | null;
  line: string | null;
  favourite: boolean;
  at: Timestamp;
  /** The giver's name; `null` when they left the boards, were forgotten, or are unknown. */
  from: string | null;
}

/** A gift on the owner's page. */
export interface AdminGift extends GiftView {
  /** The giver's display name (`""` once forgotten). */
  giver: string;
  person: PersonId | null;
  priced_by: GiftRecord["priced_by"];
  reason: string | null;
  source: GiftSource;
  refunded_by: string | null;
}

/** The free-form gifts (`GiftDesk`), for the member routes and the Discord commands. */
export const FreeGiftsKey = serviceKey<GiftDesk>("FreeGifts");

/** The plain line when she did not say one. */
export const TAKEN_FOR_HER = "她收下了";

/** What a gift's ledger key is. */
export const giftKeyOf = (id: string) => `gift:${id}`;

export class GiftDesk {
  constructor(
    private readonly e: EconomyService,
    private readonly tablesOf: () => GiftTables | null,
  ) {}

  get #c() {
    return this.e.config.free_gifts;
  }

  /** How long a quote may be confirmed, in seconds. */
  get confirmWindowS(): number {
    return this.#c.confirm_s;
  }

  get currency(): string {
    return this.e.config.currency;
  }

  /** NT$ a coin: the economy's one fixed rate. */
  get rate(): number {
    return this.e.config.twd_per_coin;
  }

  /** Above this many coins a gift is a large one. */
  get bigGiftCoins(): number {
    return this.#c.big_gift_coins;
  }

  /** Members may name gifts now. */
  get open(): boolean {
    return this.#c.on && this.#c.per_day > 0;
  }

  #tables(): GiftTables {
    const t = this.tablesOf();
    if (t === null) throw new EconomyError(503, "送禮現在打不開");
    return t;
  }

  #now(): number {
    return this.e.now();
  }

  #open(): void {
    const c = this.#c;
    if (!c.on || c.per_day === 0) throw new EconomyError(409, "現在不收自己取名的禮物");
  }

  // ---- asking ---------------------------------------------------------------------------

  /**
   * Names a gift: a quote to confirm (nothing charged), the fixed food it names, or why it cannot
   * be given. The same `key` asks once. `EconomyError`: 400 an empty or long name, 403 a stranger,
   * 409 off, 429 a day's limit or the price questions used up, 503 no tables or the day's price
   * questions of everyone used up.
   */
  async ask(
    account: AccountRef,
    text: string,
    key: string,
    source: GiftSource,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<GiftAsk> {
    this.#open();
    const c = this.#c;
    const item = giftName(text, c.max_chars);
    if (item === null) throw new EconomyError(400, `禮物的名字要 1 到 ${c.max_chars} 個字`);
    const fixed = fixedFood(item);
    if (fixed !== null) return { status: "fixed", item: fixed };
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const tables = this.#tables();
    const persons = [who.person.id];
    const again = tables.byKey(persons, key);
    if (again !== null) return this.#asked(who, again);
    const today = this.#today(tables, persons);
    this.#roomLeft(today, null);
    const itemKey = giftKey(item);
    const base = { who, item, itemKey, key, source };

    const rule = ruleRefusal(item, this.e.config.currency);
    if (rule !== null) return this.#reject(tables, base, rule, "rule", false);
    if (!this.e.passes(who, item)) return this.#reject(tables, base, "unfit", "rule", false);

    // The owner's word, then what the model said before.
    let priced: Priced | null = null;
    let pricedBy: GiftRecord["priced_by"] = "cache";
    let asked = false;
    const cached = tables.price(itemKey);
    if (cached?.source === "blocked") return this.#reject(tables, base, "blocked", "pinned", false);
    if (cached !== null) {
      pricedBy = cached.source === "pinned" ? "pinned" : "cache";
      priced = this.#fromPrice(cached);
    }
    if (priced === null) {
      const pricer = this.e.services.get(GiftPricerKey);
      if (pricer) {
        const since = this.e.todayStart();
        if (tables.asked(since, persons) >= c.price_calls_per_person) {
          throw new EconomyError(429, "今天問價的次數用完了,明天再試;沒有扣錢");
        }
        if (tables.asked(since, null) >= c.price_calls_per_day) {
          throw new EconomyError(503, "現在估不了價,晚點再試;沒有扣錢");
        }
        asked = true;
        const verdict = validVerdict(await this.#priceOf(pricer, item, signal));
        // An estimate is kept only when it gives a price (an absurd one is no answer).
        const estimate = verdict !== null && "twd" in verdict ? this.#coins(verdict.twd) : null;
        if (verdict !== null && ("refuse" in verdict || estimate !== null)) {
          tables.putPrice({
            item_key: itemKey,
            item,
            kind: "kind" in verdict ? verdict.kind : null,
            tier: null,
            twd: "twd" in verdict ? verdict.twd : null,
            coins: null,
            refuse: "refuse" in verdict ? verdict.refuse : null,
            source: "model",
            by: null,
            at: toTimestamp(this.#now()),
          });
          pricedBy = "model";
          priced =
            "refuse" in verdict
              ? { refuse: verdict.refuse }
              : { kind: verdict.kind, coins: estimate as number, twd: verdict.twd };
        }
      }
    }
    if (priced !== null && "refuse" in priced) {
      return this.#reject(tables, base, priced.refuse, pricedBy, asked);
    }
    const fallback = priced === null;
    const kind: GiftKind = priced?.kind ?? "small_object";
    if (fallback) pricedBy = "fallback";
    const price = priced?.coins ?? c.fallback_coins;
    const twd = priced?.twd ?? null;
    const full = isEdible(kind)
      ? foodHunger(
          price,
          kind as "food" | "drink",
          c.food_hunger_max,
          c.food_hunger_half_coins,
          this.e.config.feed_hunger_cap,
        )
      : 0;

    return this.e.serial(async (): Promise<GiftAsk> => {
      const same = tables.byKey(persons, key);
      if (same !== null) return this.#asked(who, same);
      const rows = this.#today(tables, persons);
      const no = this.#capNo(rows, null, kind, price);
      const row = { ...base, kind, twd, price, pricedBy, asked };
      if (no !== null) throw no;
      let hunger = 0;
      if (isEdible(kind)) {
        const left = await this.#feedLeft(who);
        if (left === null) return this.#reject(tables, row, "unavailable", pricedBy, asked);
        if (left <= FEED_EPSILON) return this.#reject(tables, row, "full", pricedBy, asked);
        hunger = Math.min(full, left);
      }
      const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
      if (balance < price) return this.#reject(tables, row, "short", pricedBy, asked);
      const now = this.#now();
      const gift = tables.insert({
        id: newId(),
        person: who.person.id,
        account: who.account,
        name: who.name,
        item,
        item_key: itemKey,
        kind,
        tier: null,
        price,
        twd,
        priced_by: pricedBy,
        asked_model: asked,
        hunger,
        status: "pending",
        reason: null,
        source,
        request_key: key,
        created_at: toTimestamp(now),
        expires_at: toTimestamp(now + c.confirm_s * 1000),
      });
      return { status: "quote", quote: this.#quote(gift, balance) };
    });
  }

  /** Coins for an estimate in NT$ at the economy's rate, within the bounds; `null`: absurd. */
  #coins(twd: number): number | null {
    const c = this.#c;
    return coinsOf(twd, this.e.config.twd_per_coin, c.min_coins, c.max_coins);
  }

  /**
   * What a kept price says now: a refusal, a coin pin, an NT$ estimate or pin at today's rate,
   * or an old tier's coins; `null` when it gives no price (no kind, or absurd at today's rate).
   */
  #fromPrice(p: GiftPrice): Priced | null {
    if (p.refuse !== null) return { refuse: p.refuse };
    if (p.kind === null) return null;
    const c = this.#c;
    if (p.coins !== null) {
      return {
        kind: p.kind,
        coins: Math.min(Math.max(p.coins, c.min_coins), c.max_coins),
        twd: null,
      };
    }
    if (p.twd !== null) {
      const coins = this.#coins(p.twd);
      return coins === null ? null : { kind: p.kind, coins, twd: p.twd };
    }
    const old = p.tier === null ? undefined : OLD_TIER_COINS[p.tier - 1];
    return old === undefined ? null : { kind: p.kind, coins: old, twd: null };
  }

  /** The price of a name, or `null` (logged) when it cannot be asked now. */
  async #priceOf(
    pricer: { price(item: string, signal: AbortSignal): Promise<GiftVerdict | null> },
    item: string,
    signal: AbortSignal,
  ): Promise<GiftVerdict | null> {
    try {
      const timeout = AbortSignal.timeout(this.#c.price_timeout_s * 1000);
      return await pricer.price(item, AbortSignal.any([signal, timeout]));
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot price a gift");
      return null;
    }
  }

  /** The answer an earlier ask with the same key gave, as far as it can be told again. */
  async #asked(who: Member, gift: GiftRecord): Promise<GiftAsk> {
    if (gift.status === "rejected") {
      const reason = (gift.reason ?? "unfit") as GiftNo;
      return { status: "refused", reason, message: this.#noText(reason, gift.price) };
    }
    const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
    return { status: "quote", quote: this.#quote(gift, balance) };
  }

  #quote(gift: GiftRecord, balance: number): GiftQuote {
    const kind = gift.kind ?? "small_object";
    const fallback = gift.priced_by === "fallback";
    const cur = this.e.config.currency;
    return {
      id: gift.id,
      item: gift.item,
      kind,
      kind_word: KIND_WORD[kind],
      twd: gift.twd,
      twd_per_coin: this.e.config.twd_per_coin,
      band: bandOf(gift.price, this.#c.band_coins),
      price: gift.price,
      big: gift.price > this.#c.big_gift_coins,
      currency: this.e.config.currency,
      balance,
      balance_after: balance - gift.price,
      expires_at: gift.expires_at,
      fallback,
      note: fallback ? `現在估不了價,先用預設的 ${gift.price} ${cur};確認了才扣。` : null,
    };
  }

  #noText(reason: GiftNo, price: number): string {
    switch (reason) {
      case "full":
        return FULL;
      case "unavailable":
        return CANNOT_FEED;
      case "short":
        return `${this.e.config.currency}不夠:這份要 ${price}`;
      default:
        return refusalText(reason, this.e.config.currency);
    }
  }

  /** A gift that cannot be given, kept so the owner sees it and a price question is counted. */
  #reject(
    tables: GiftTables,
    row: {
      who: Member;
      item: string;
      itemKey: string;
      key: string;
      source: GiftSource;
      kind?: GiftKind;
      twd?: number | null;
      price?: number;
    },
    reason: GiftNo,
    pricedBy: GiftRecord["priced_by"],
    asked: boolean,
  ): GiftAsk {
    const now = this.#now();
    try {
      tables.insert({
        id: newId(),
        person: row.who.person.id,
        account: row.who.account,
        name: row.who.name,
        item: row.item,
        item_key: row.itemKey,
        kind: row.kind ?? null,
        tier: null,
        price: row.price ?? 0,
        twd: row.twd ?? null,
        priced_by: pricedBy,
        asked_model: asked,
        hunger: 0,
        status: "rejected",
        reason,
        source: row.source,
        request_key: row.key,
        created_at: toTimestamp(now),
        expires_at: toTimestamp(now),
      });
    } catch (error) {
      // A second ask with the same key raced this one: the first row stands.
      this.e.log.warn({ err: errorMessage(error) }, "cannot keep a refused gift");
    }
    return { status: "refused", reason, message: this.#noText(reason, row.price ?? 0) };
  }

  // ---- caps -----------------------------------------------------------------------------

  #today(tables: GiftTables, persons: readonly PersonId[]): GiftRecord[] {
    return tables.mine(persons, MAX_TODAY, this.e.todayStart());
  }

  /** The day's gifts that count: charged and not given back. */
  #counted(rows: readonly GiftRecord[], except: string | null): GiftRecord[] {
    return rows.filter(
      (g) => g.id !== except && (g.status === "confirmed" || g.status === "accepted"),
    );
  }

  /** Whether one more gift of any kind fits today (before the price is known). */
  #roomLeft(rows: readonly GiftRecord[], except: string | null): void {
    const c = this.#c;
    const kept = this.#counted(rows, except);
    if (kept.length >= c.per_day) throw new EconomyError(429, `今天最多送 ${c.per_day} 份`);
    if (c.coins_per_day === 0) return;
    const spent = kept.reduce((n, g) => n + g.price, 0);
    if (c.coins_per_day - spent < c.min_coins) {
      throw new EconomyError(429, `今天送禮最多花 ${c.coins_per_day} ${this.e.config.currency}`);
    }
  }

  /** Why this gift does not fit today, or `null`. */
  #capNo(
    rows: readonly GiftRecord[],
    except: string | null,
    kind: GiftKind,
    price: number,
  ): EconomyError | null {
    const c = this.#c;
    const cur = this.e.config.currency;
    try {
      this.#roomLeft(rows, except);
    } catch (error) {
      return error as EconomyError;
    }
    const kept = this.#counted(rows, except);
    const spent = kept.reduce((n, g) => n + g.price, 0);
    if (c.coins_per_day > 0 && spent + price > c.coins_per_day) {
      return new EconomyError(
        429,
        `今天送禮最多花 ${c.coins_per_day} ${cur},還剩 ${c.coins_per_day - spent}`,
      );
    }
    if (!isEdible(kind) && kept.filter((g) => !isEdible(g.kind)).length >= c.objects_per_day) {
      return new EconomyError(429, `吃喝以外的禮物今天最多送 ${c.objects_per_day} 份`);
    }
    return null;
  }

  /**
   * How much hunger this person may still take off her today (`feed_hunger_cap` less their feeds
   * and their gifts of food today, given-back ones not counted); `null` when her hunger cannot
   * be read.
   */
  async #feedLeft(who: Member): Promise<number | null> {
    const self = this.e.services.get(SelfStateKey);
    try {
      if (!self || typeof self.drives().hunger !== "number") return null;
    } catch {
      return null;
    }
    const rows = await this.e.rowsToday(who);
    const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
    const taken = rows
      .filter((r) => !refunded.has(r.id))
      .reduce((n, r) => n + (r.reason === "feed" ? hungerOf(r) : giftHunger(r)), 0);
    const left = this.e.config.feed_hunger_cap - taken;
    return left > FEED_EPSILON ? left : 0;
  }

  // ---- confirming -----------------------------------------------------------------------

  /** The gift if it is this person's; `EconomyError` 403 when it is someone else's or nothing. */
  #theirs(tables: GiftTables, who: Member, id: string): GiftRecord {
    const gift = tables.get(id);
    if (gift === null || gift.person !== who.person.id) {
      throw new EconomyError(403, "這不是你要送的禮物");
    }
    return gift;
  }

  /**
   * 確認: charges the quoted price once and tells her. A second press (or a retry) answers what
   * the first did and charges nothing. `EconomyError`: 402 short, 403 not theirs or a stranger,
   * 409 cancelled, expired or refused before, 429 a day's limit, 503 no tables.
   */
  async confirm(account: AccountRef, id: string): Promise<GiftConfirmed> {
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const tables = this.#tables();
    const done = await this.e.serial(async (): Promise<GiftConfirmed> => {
      let gift = this.#theirs(tables, who, id);
      const balanceNow = () => this.e.ledger().balance(this.e.profile, who.wallet);
      if (gift.status !== "pending") {
        if (
          gift.status === "cancelled" ||
          gift.status === "expired" ||
          gift.status === "rejected"
        ) {
          throw new EconomyError(409, "這份禮物已經取消或過期了,沒有扣錢");
        }
        return { gift: this.#view(gift), charged: false, balance: await balanceNow() };
      }
      const now = this.#now();
      if (Date.parse(gift.expires_at) <= now) {
        tables.move(id, ["pending"], { status: "expired" });
        throw new EconomyError(409, "等太久了,這份禮物已經過期,沒有扣錢;要送就再選一次");
      }
      const no = this.#capNo(
        this.#today(tables, [who.person.id]),
        id,
        gift.kind ?? "small_object",
        gift.price,
      );
      if (no !== null) throw no;
      let hunger = 0;
      if (isEdible(gift.kind)) {
        const left = await this.#feedLeft(who);
        if (left === null) throw new EconomyError(503, CANNOT_FEED);
        if (left <= FEED_EPSILON) throw new EconomyError(409, FULL);
        hunger = Math.min(gift.hunger, left);
      }
      const entry: CoinEntry = this.e.entryFor(
        who,
        -gift.price,
        GIFT_REASON,
        giftRef(gift.id, hunger, gift.item),
        giftKeyOf(gift.id),
      );
      const post = await this.e.ledger().post(entry, { covered: true });
      if (post.status === "short") {
        throw new EconomyError(402, `${this.e.config.currency}不夠:這份要 ${gift.price}`);
      }
      if (post.status === "capped") throw new EconomyError(429, "今天到上限了");
      const moved = tables.move(id, ["pending"], {
        status: "confirmed",
        entry_id: post.entry.id,
        hunger,
        confirmed_at: toTimestamp(now),
        answer_due: toTimestamp(now + this.#c.answer_s * 1000),
      });
      gift = moved ?? (tables.get(id) as GiftRecord);
      return { gift: this.#view(gift), charged: post.status === "posted", balance: post.balance };
    });
    if (done.charged) {
      const gift = tables.get(id);
      if (gift !== null) {
        this.#tellHer(who, gift, tables);
        this.e.record(who, "economy.gift.confirm", {
          gift: id,
          item: gift.item,
          twd: gift.twd,
          price: gift.price,
        });
      }
    }
    return done;
  }

  /** 取消: a gift not confirmed yet is dropped, nothing charged. Others are answered as they are. */
  async cancel(account: AccountRef, id: string): Promise<GiftView> {
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const tables = this.#tables();
    return this.e.serial(async () => {
      const gift = this.#theirs(tables, who, id);
      if (gift.status !== "pending") return this.#view(gift);
      return this.#view(tables.move(id, ["pending"], { status: "cancelled" }) ?? gift);
    });
  }

  /** What she reads: who wants to give her what, escaped, with what they gave her before. */
  #tellHer(who: Member, gift: GiftRecord, tables: GiftTables): void {
    const cur = this.e.config.currency;
    const minutes = Math.max(1, Math.round(this.#c.answer_s / 60));
    const kind = gift.kind ?? "small_object";
    const past = tables
      .mine([who.person.id], 20)
      .filter((g) => g.id !== gift.id && g.status === "accepted")
      .slice(0, PAST_TOLD)
      .map((g) => `「${safeName(g.item, 40)}」(${dayWord(Date.parse(g.created_at), this.#now())})`);
    const eat =
      gift.kind === "food" ? "收下就是吃掉。" : gift.kind === "drink" ? "收下就是喝掉。" : "";
    const parts = [
      `${safeName(who.name)}想送你「${safeName(gift.item, 40)}」` +
        `(${KIND_WORD[kind]},${bandOf(gift.price, this.#c.band_coins)},${gift.price} ${cur},已經付了;禮物代號 ${gift.id})。`,
      eat,
      past.length > 0 ? `他之前也送過你:${past.join("、")}。` : "",
      `收不收由你決定,照你現在的心情和你對他的感覺:用 answer_gift 回答,一句你自己的話。` +
        `${minutes} 分鐘內沒回答就當你收下了。`,
    ];
    this.e.tell(who, "economy.gift", `gift:${gift.id}`, parts.join(""));
  }

  // ---- her answer -----------------------------------------------------------------------

  /**
   * Her answer to a confirmed gift (`answer_gift`), or the sweep's for her (`system`). Taking it
   * gives her share to her purse, lowers her hunger for food and keeps it as a note of the giver;
   * a no gives the coins back in full. `null`: not a gift waiting for her (answered already,
   * given back, someone's mistyped id).
   */
  async answer(
    id: string,
    take: boolean,
    line: string | null,
    favourite: boolean,
    by: "her" | "system",
  ): Promise<GiftRecord | null> {
    const tables = this.#tables();
    const said = line === null ? null : this.#screenLine(line);
    const now = toTimestamp(this.#now());
    const gift = await this.e.serial(async (): Promise<GiftRecord | null> => {
      const g = tables.get(id);
      if (g === null || g.status !== "confirmed" || g.person === null) return null;
      if (!take) {
        await this.#giveBack(g);
        return tables.move(id, ["confirmed"], {
          status: "refused",
          line: said,
          answered_by: by,
          answered_at: now,
        });
      }
      const moved = tables.move(id, ["confirmed"], {
        status: "accepted",
        line: said,
        favourite: by === "her" && favourite,
        answered_by: by,
        answered_at: now,
      });
      if (moved === null) return null;
      const entry = await this.#entryOf(moved);
      if (entry !== null) await this.e.purse.share(entry);
      return moved;
    });
    if (gift === null) return null;
    if (gift.status === "accepted") await this.#taken(gift);
    this.e.record(this.#asMember(gift), "economy.gift.answer", {
      gift: gift.id,
      take,
      by,
      item: gift.item,
      price: gift.price,
    });
    return gift;
  }

  /** Her line, if it passes the screen her written words pass; `null` otherwise. */
  #screenLine(line: string): string | null {
    const flat = line.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (flat === "") return null;
    const cut = [...flat].slice(0, MAX_GIFT_LINE).join("");
    const moderation = this.e.services.get(ModerationKey);
    if (!moderation) return null;
    try {
      return moderation.screen({ path: "other", visible: cut }).ok ? cut : null;
    } catch {
      return null;
    }
  }

  /** What a kept gift does to her: hunger for food, the feeling, and a note of the giver. */
  async #taken(gift: GiftRecord): Promise<void> {
    const s = this.e.services;
    if (gift.hunger > 0) {
      try {
        s.get(SelfStateKey)?.adjust({ hunger: -gift.hunger }, "fed");
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error) }, "cannot lower her hunger for a gift");
      }
    }
    if (gift.person === null) return;
    // How it feels: the `gift` social event (her emotions only), weaker for each earlier gift of
    // theirs today, like feeding.
    const tables = this.#tables();
    const n = Math.max(
      tables
        .mine([gift.person], MAX_TODAY, this.e.todayStart())
        .filter((g) => g.status === "accepted").length,
      1,
    );
    const payload: JsonValue = {
      person: gift.person,
      name: gift.name,
      kind: "gift",
      source: "economy",
      scale: this.e.config.diminish ** (n - 1),
      context: null,
      hunger: 0,
    };
    this.e.publish(Events.SocialEvent, payload as EventPayload<typeof Events.SocialEvent>);
    const notes = s.get(PersonNoteWriterKey);
    if (!notes) return;
    const said = gift.line === null ? "" : `,我說:「${gift.line}」`;
    const fav = gift.favourite ? "我很喜歡。" : "";
    try {
      await notes.note(
        gift.person,
        `${plainName(gift.name)}送了我「${gift.item}」,我收下了${said}。${fav}`,
        { importance: NOTE_IMPORTANCE, at: gift.answered_at ?? toTimestamp(this.#now()) },
      );
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot keep a gift as a note");
    }
  }

  /** The gift's charge row, or `null` when it cannot be found. */
  async #entryOf(gift: GiftRecord): Promise<CoinEntry | null> {
    if (gift.person === null) return null;
    return this.e.ledger().byKey(this.e.profile, gift.person, giftKeyOf(gift.id));
  }

  /** The giver as the ledger knows them: the wallet is all a refund needs. */
  #asMember(gift: GiftRecord): Member {
    const account = gift.account ?? { platform: "forgotten", id: gift.id };
    return {
      account,
      person: { id: gift.person ?? PURSE } as Member["person"],
      wallet: gift.person ?? PURSE,
      accounts: [account],
      name: gift.name,
    };
  }

  /** Gives the charge back in full (her share with it, when she had one). */
  async #giveBack(gift: GiftRecord): Promise<boolean> {
    const entry = await this.#entryOf(gift);
    if (entry === null) return false;
    return this.e.refundOnce(this.#asMember(gift), entry);
  }

  // ---- the sweep ------------------------------------------------------------------------

  /**
   * What ran out: quotes not confirmed in time expire (nothing was charged), gifts she did not
   * answer in time are taken for her, and the gifts of forgotten people that were waiting go back.
   */
  async sweep(): Promise<{ expired: number; taken: number; refunded: number }> {
    const tables = this.tablesOf();
    if (tables === null) return { expired: 0, taken: 0, refunded: 0 };
    const now = toTimestamp(this.#now());
    let expired = 0;
    for (const g of tables.due("pending", now, SWEEP_BATCH)) {
      if (tables.move(g.id, ["pending"], { status: "expired" }) !== null) expired += 1;
    }
    let taken = 0;
    for (const g of tables.due("confirmed", now, SWEEP_BATCH)) {
      try {
        if ((await this.answer(g.id, true, null, false, "system")) !== null) taken += 1;
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), gift: g.id }, "cannot take a gift for her");
      }
    }
    let refunded = 0;
    for (const g of tables.due("refund_due", now, SWEEP_BATCH)) {
      try {
        const done = await this.e.serial(async () => {
          await this.#giveBack(g);
          return tables.move(g.id, ["refund_due"], {
            status: "refunded",
            refunded_by: "forget",
            refunded_at: now,
          });
        });
        if (done !== null) {
          tables.anonymise(g.id);
          refunded += 1;
        }
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), gift: g.id }, "cannot give a gift back");
      }
    }
    return { expired, taken, refunded };
  }

  // ---- reads ----------------------------------------------------------------------------

  #view(g: GiftRecord): GiftView {
    return {
      id: g.id,
      item: g.item,
      kind: g.kind,
      kind_word: g.kind === null ? null : KIND_WORD[g.kind],
      tier: g.tier,
      price: g.price,
      twd: g.twd,
      status: g.status,
      line: g.line,
      favourite: g.favourite,
      answered_by: g.answered_by,
      created_at: g.created_at,
      expires_at: g.expires_at,
      answer_due: g.answer_due,
      answered_at: g.answered_at,
    };
  }

  /** One gift of this person's (`null` when it is not theirs). */
  async one(account: AccountRef, id: string): Promise<GiftView | null> {
    const who = await this.e.member(account);
    const tables = this.tablesOf();
    if (!who || tables === null) return null;
    const g = tables.get(id);
    return g !== null && g.person === who.person.id ? this.#view(g) : null;
  }

  /** What this person named for her, newest first (refused names too); empty for a stranger. */
  async mine(account: AccountRef, limit = 30): Promise<GiftView[]> {
    const who = await this.e.member(account);
    const tables = this.tablesOf();
    if (!who || tables === null) return [];
    return tables.mine([who.person.id], clamp(limit, 1, 100)).map((g) => this.#view(g));
  }

  /**
   * Her collection for everyone: the gifts she kept, newest first, and her favourites. A giver is
   * named only while they stay on the public boards (the sponsor board's opt-out).
   */
  async collection(limit = 20): Promise<{ recent: PublicGift[]; favourites: PublicGift[] }> {
    const tables = this.tablesOf();
    if (tables === null) return { recent: [], favourites: [] };
    const n = clamp(limit, 1, 50);
    const recent = tables.recent(n, ["accepted"]);
    const favourites = tables.favourites(n);
    let off = new Set<string>();
    try {
      off = new Set(await this.e.ledger().offBoard(this.e.profile, 5_000));
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot read who left the boards");
      return {
        recent: recent.map((g) => publicGift(g, false)),
        favourites: favourites.map((g) => publicGift(g, false)),
      };
    }
    const shown = (g: GiftRecord) => g.person !== null && g.name !== "" && !off.has(g.person);
    return {
      recent: recent.map((g) => publicGift(g, shown(g))),
      favourites: favourites.map((g) => publicGift(g, shown(g))),
    };
  }

  /** The owner's list: the newest gifts of everyone, every status. */
  adminList(limit = 50): AdminGift[] {
    const tables = this.tablesOf();
    if (tables === null) return [];
    return tables.recent(clamp(limit, 1, 200)).map((g) => ({
      ...this.#view(g),
      giver: g.name,
      person: g.person,
      priced_by: g.priced_by,
      reason: g.reason,
      source: g.source,
      refunded_by: g.refunded_by,
    }));
  }

  /**
   * The owner gives a charged gift back (confirmed or kept): the full price to the giver, her share
   * taken back from her purse as far as she still has it. Bond and memory are not touched.
   * `false`: nothing to give back (not charged, or given back already).
   */
  async refund(id: string, by: string): Promise<boolean> {
    const tables = this.#tables();
    const done = await this.e.serial(async () => {
      const g = tables.get(id);
      if (g === null || (g.status !== "confirmed" && g.status !== "accepted")) return null;
      await this.#giveBack(g);
      return tables.move(id, ["confirmed", "accepted"], {
        status: "refunded",
        refunded_by: by,
        refunded_at: toTimestamp(this.#now()),
        ...(g.status === "confirmed" ? { answered_by: "admin" as const } : {}),
      });
    });
    if (done === null) return false;
    this.e.record(this.#asMember(done), "economy.gift.refund", {
      gift: id,
      item: done.item,
      price: done.price,
      by,
    });
    return true;
  }

  /**
   * The owner fixes a name's price and kind, in coins (stays put when the rate changes) or in NT$
   * (follows the rate), or blocks it (`null`).
   */
  pin(
    name: string,
    choice: { kind: GiftKind; coins?: number | null; twd?: number | null } | null,
    by: string,
  ): { item: string; item_key: string } {
    const c = this.#c;
    const item = giftName(name, c.max_chars);
    if (item === null) throw new EconomyError(400, `名字要 1 到 ${c.max_chars} 個字`);
    const coins = choice?.coins ?? null;
    const twd = choice?.twd ?? null;
    if (choice !== null) {
      if ((coins === null) === (twd === null)) {
        throw new EconomyError(400, `要給${this.e.config.currency}價錢或台幣估價其中一個`);
      }
      if (
        coins !== null &&
        (!Number.isSafeInteger(coins) || coins < c.min_coins || coins > c.max_coins)
      ) {
        throw new EconomyError(400, `價錢要是 ${c.min_coins} 到 ${c.max_coins} 的整數`);
      }
      if (twd !== null && this.#coins(twd) === null) {
        throw new EconomyError(400, "台幣估價要是正整數,換算後不能超過上限");
      }
    }
    if (choice !== null && !GIFT_KINDS.includes(choice.kind)) {
      throw new EconomyError(400, "沒有這種禮物");
    }
    const itemKey = giftKey(item);
    this.#tables().putPrice({
      item_key: itemKey,
      item,
      kind: choice?.kind ?? null,
      tier: null,
      twd,
      coins,
      refuse: choice === null ? "blocked" : null,
      source: choice === null ? "blocked" : "pinned",
      by,
      at: toTimestamp(this.#now()),
    });
    return { item, item_key: itemKey };
  }

  /** Takes a name's pin, block or cached price out; `false` when there was none. */
  unpin(name: string): boolean {
    const item = giftName(name, this.#c.max_chars);
    if (item === null) return false;
    return this.#tables().dropPrice(giftKey(item));
  }

  /** The owner's pins and blocks, newest first. */
  overrides(limit = 100): (GiftPrice & { price: number | null })[] {
    return (this.tablesOf()?.overrides(clamp(limit, 1, 500)) ?? []).map((o) => {
      const now = this.#fromPrice(o);
      return { ...o, price: now !== null && "coins" in now ? now.coins : null };
    });
  }

  /** A kept gift of theirs as the picture draws it; `null` when it is not theirs or not kept. */
  async picture(
    account: AccountRef,
    id: string,
  ): Promise<{
    name: string;
    item: string;
    kind: string;
    line: string;
    date: string;
    favourite: boolean;
  } | null> {
    const who = await this.e.member(account);
    const tables = this.tablesOf();
    if (!who || tables === null) return null;
    const g = tables.get(id);
    if (g === null || g.person !== who.person.id || g.status !== "accepted") return null;
    return {
      name: plainName(who.name),
      item: g.item,
      kind: g.kind === null ? "" : KIND_WORD[g.kind],
      line: g.line ?? TAKEN_FOR_HER,
      date: localDate(Date.parse(g.answered_at ?? g.created_at), this.e.config.utc_offset_minutes),
      favourite: g.favourite,
    };
  }

  /** Their newest kept gift's id, for `/me gifts`'s picture. */
  async newestKept(account: AccountRef): Promise<string | null> {
    return (await this.mine(account, 30)).find((g) => g.status === "accepted")?.id ?? null;
  }
}

/** A price the desk can use: a refusal, or a kind with coins (and the NT$ it came from). */
type Priced = { refuse: GiftRefusal } | { kind: GiftKind; coins: number; twd: number | null };

/**
 * A verdict the engine can use: a refusal it knows, or a known kind with a whole NT$ estimate
 * above zero (whether it is absurd is for the rate to say, `coinsOf`).
 */
export function validVerdict(v: GiftVerdict | null): GiftVerdict | null {
  if (v === null || typeof v !== "object") return null;
  if ("refuse" in v) {
    return (REFUSAL_TEXT as Record<string, string>)[v.refuse] === undefined ? null : v;
  }
  if (!GIFT_KINDS.includes(v.kind)) return null;
  if (!Number.isSafeInteger(v.twd) || v.twd <= 0) return null;
  return { kind: v.kind, twd: v.twd };
}

function publicGift(g: GiftRecord, named: boolean): PublicGift {
  return {
    id: g.id,
    item: g.item,
    kind: g.kind,
    kind_word: g.kind === null ? null : KIND_WORD[g.kind],
    line: g.line,
    favourite: g.favourite,
    at: g.answered_at ?? g.created_at,
    from: named ? plainName(g.name) : null,
  };
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.trunc(n) || lo, lo), hi);

/** 「今天」「3 天前」. */
function dayWord(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  return days <= 0 ? "今天" : `${days} 天前`;
}

/** `2026-11-21`, in the economy's local day. */
function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}
