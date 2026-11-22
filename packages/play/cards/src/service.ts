// The cards as the rest of Core uses them (`CardsKey`): issuing a daily card, the odds table, a
// person's pity, dex and wishlist (docs/design/v5-play.md §2, §6.3).
//
// A daily card costs `price` fish coins, the first of the day too, and a person gets at most
// `daily_cap` a day (her local day); a foil finish is paid on top. One person's cards are issued
// one at a time in this process: the cap is checked, the coins are taken through the wallet port
// (`wallet.ts`), the card's and then its foil's, both keyed by the card's serial, then the store
// draws and writes the card in one transaction, checking the cap again. When the card cannot be
// written both go back.
//
// Some cards nobody pays for: a milestone card when a bond enters a tier it had never reached
// (§6.1), the keepsake of someone who came over from the old records (§10.2 P5), a card she drops
// in a channel for the first one to pick up (§6.2, `claimDrop`). Each is issued
// once per person and occasion (the store's `issue_key`), in the same turn as
// that person's other cards, outside the day's cap, at the plain odds and without moving the pity
// (the design says nothing of the pity for it: a free card that moved it would be a way around it).

import { getLogger } from "@miyoria/runtime/kernel";
import type { LegacySnapshot } from "@miyoria/store";
import {
  type AccountRef,
  BOND_LADDER,
  type BondTier,
  type Clock,
  DEFAULT_CURRENCY,
  type PersonId,
} from "@miyoria/types";
import type { Part, Rarity, Slot } from "./catalogue.js";
import { type CardsConfig, drawRules } from "./config.js";
import { type SeriesProgress, seriesProgress, type WishlistProblem } from "./dex.js";
import { type PityView, pityView, type Random } from "./draw.js";
import type { CardFaces, OccasionFace } from "./faces.js";
import { LEGACY_SERIES, type LegacyItem } from "./legacy.js";
import { type OddsTable, oddsTable } from "./odds.js";
import { newSerial } from "./serial.js";
import {
  CardCapError,
  type CardFace,
  type CardKind,
  type CardRecord,
  type CardRelationship,
  type CardStore,
  type CardTitle,
  type DexEntry,
  type IssuedCard,
  issueKey,
  type PendingCard,
} from "./store.js";
import { CARD_REASONS, type CardCharge, type CardPayer, type CardWallet } from "./wallet.js";

const log = getLogger("cards");

const DAY_MS = 86_400_000;

/**
 * What a member reads when a card is refused, and when a wishlist is; `insufficient` names the
 * default coins (`refusalText` names the profile's).
 */
export const CARD_TEXTS = {
  daily_cap: "今天的卡已經發完了,明天再來",
  insufficient: "魚幣不夠",
  no_wallet: "錢包現在不能用",
  no_foil: "現在不賣閃卡",
  too_many: "願望單最多三個",
  duplicate: "願望單裡有重複的部件",
  unknown_part: "沒有這個部件",
  drop_gone: "這張卡不見了",
  drop_expired: "這張卡已經飄走了",
  drop_taken: "被別人先撿走了",
  drop_cap: "今天已經撿過一張了,明天再來",
  drop_skipped: "上一張是你撿的,這張留給別人吧",
} as const;

/** Why a dropped card is not theirs. */
export type DropRefusal =
  | "drop_gone"
  | "drop_expired"
  | "drop_taken"
  | "drop_cap"
  | "drop_skipped"
  | "no_face";

export type DropResult = { ok: true; issued: IssuedCard } | { ok: false; reason: DropRefusal };

/**
 * Why a daily card is not issued now: the day's cards, too few coins for the card and its foil,
 * the day's foils (`capped`), no wallet, no foil on sale, or the wallet's own refusal.
 */
export type DailyRefusal =
  | { ok: false; reason: "daily_cap"; cap: number }
  | { ok: false; reason: "insufficient"; price: number; balance: number | null }
  | { ok: false; reason: "capped"; message: string }
  | { ok: false; reason: "refused"; message: string }
  | { ok: false; reason: "no_wallet" }
  | { ok: false; reason: "no_foil" };

/**
 * A daily card issued: `charged` is what this call took (the card and its foil; nothing when it
 * answers the card a first try of the same key made).
 */
export type DailyResult =
  | { ok: true; issued: IssuedCard; balance: number | null; charged: number }
  | DailyRefusal;

/**
 * What a card nobody pays for came to: issued (or the one of the same key already there,
 * `issued.again`), or not, because no card should name them now (`no_face`) or the occasion is not
 * one (`not_eligible`).
 */
export type FreeResult =
  | { ok: true; issued: IssuedCard }
  | { ok: false; reason: "no_face" | "not_eligible" };

/**
 * Whether a daily card can be issued now, and what it costs (`price`: the card and, when it is
 * ordered, its foil; `foil`: whether it is).
 */
export type DailyQuote =
  | { ok: true; left: number; cap: number; price: number; foil: boolean; balance: number | null }
  | DailyRefusal;

/** What a daily card is ordered with: a foil finish, and the request's key. */
export interface DailyOrder {
  /** A foil finish, paid on top through the wallet (`CardWallet.foil`). */
  foil?: boolean;
  /** As `DailyOptions.key`. */
  key?: string;
}

/** What a daily card is issued with besides the draw. */
export interface DailyOptions {
  /** The frame they chose. */
  frame?: string | null;
  /**
   * A foil finish, paid on top through the wallet (`CardWallet.foil`) under the card's serial. A
   * try kept under the same key keeps the foil it was asked with: a retry is the same order.
   */
  foil?: boolean;
  /**
   * The relationship to show instead of the heart's (a stranger's for someone she will not say
   * anything about); default: what the heart says now.
   */
  relationship?: CardRelationship;
  /**
   * The request's Idempotency-Key: asked again with it, after a restart too, the answer is the
   * card the first try made and nothing more is charged.
   */
  key?: string;
}

/** The sentence for a refusal; `currency` is the profile's coin name. */
export function refusalText(r: DailyRefusal, currency: string = DEFAULT_CURRENCY): string {
  if (r.reason === "refused" || r.reason === "capped") return r.message;
  if (r.reason === "insufficient") return `${currency}不夠`;
  return CARD_TEXTS[r.reason];
}

/** One part a person has, with what it is. */
export interface DexPart extends DexEntry {
  name: string;
  slot: Slot;
  rarity: Rarity;
  series: string | null;
}

/** A person's dex page: theirs alone unless they say otherwise; nobody is ranked. */
export interface DexView {
  parts: DexPart[];
  series: SeriesProgress[];
  titles: CardTitle[];
  /** The old collectibles they had, as the closed series 舊收藏 (read only). */
  legacy: { series: typeof LEGACY_SERIES; items: LegacyItem[] };
}

export interface CardServiceOptions {
  config: CardsConfig;
  clock: Clock;
  /** The wallet, looked up at each use (the economy may restart); `null`: none now. */
  wallet: () => CardWallet | null;
  /** The relationship a card for `person` shows, now. */
  relationship: (person: PersonId) => CardRelationship;
  /** Default `Math.random`. */
  random?: Random;
  /** Default `newSerial` (`MYR-XXXX-XXXX-XXXX` from the system's CSPRNG). */
  newSerial?: () => string;
  /** Told of every card issued (what she hears of it, `notes.ts`); its errors are logged. */
  onIssued?: (issued: IssuedCard) => void;
  /**
   * Whether `person` came over from the old records (and so has a keepsake card); default
   * nobody.
   */
  migrated?: (person: PersonId) => boolean;
  /**
   * An account of `person` a refund can be paid back through (the wallet is the person's, so any
   * of theirs); `null`: none now. Without it nothing kept is settled (`settlePending`).
   */
  account?: (person: PersonId) => Promise<AccountRef | null>;
}

/** What one pass of `settlePending` did. */
export interface SettleResult {
  /** Kept serials whose card was written after all: the row went. */
  cleared: number;
  /** Kept serials with no card: what was charged under them went back, and the row went. */
  refunded: number;
  /** Kept serials left for a later pass: too young, or the wallet or the account not there. */
  waiting: number;
}

/** How old a kept serial must be before it is settled: a try still going is not raced. */
export const SETTLE_GRACE_MS = 2 * 60_000;

/** The start (epoch ms) of the local day of `now` at `offsetMinutes` from UTC. */
export function dayStart(now: number, offsetMinutes: number): number {
  const offset = offsetMinutes * 60_000;
  return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
}

export class CardService {
  readonly #store: CardStore;
  readonly #o: CardServiceOptions;
  readonly #random: Random;
  readonly #serial: () => string;
  readonly #turns = new Map<PersonId, Promise<unknown>>();

  constructor(store: CardStore, options: CardServiceOptions) {
    this.#store = store;
    this.#o = options;
    this.#random = options.random ?? Math.random;
    this.#serial = options.newSerial ?? newSerial;
  }

  get config(): CardsConfig {
    return this.#o.config;
  }

  /**
   * Whether `payer` may be given a daily card now: under the day's cap, and able to pay for the
   * card and, when `order.foil`, its foil. Asked before she writes anything, so a refused card
   * costs no model call. A try kept under `order.key` is the order it was asked with (its foil),
   * and may be paid already (the wallet answers its charges again), so its balance is not asked.
   */
  async quote(payer: CardPayer, order: DailyOrder = {}): Promise<DailyQuote> {
    const { config } = this.#o;
    const left = this.dailyLeft(payer.person);
    const cap = config.daily_cap;
    if (left <= 0) return { ok: false, reason: "daily_cap", cap };
    const kept =
      order.key === undefined || order.key === ""
        ? null
        : this.#store.pendingOf(payer.person, issueKey.daily(order.key));
    const foil = kept?.foil ?? order.foil === true;
    if (config.price === 0 && !foil) return { ok: true, left, cap, price: 0, foil, balance: null };
    const wallet = this.#o.wallet();
    if (wallet === null) return { ok: false, reason: "no_wallet" };
    const shine = foil ? wallet.foilPrice() : 0;
    if (shine === null) return { ok: false, reason: "no_foil" };
    const price = config.price + shine;
    const balance = await wallet.balance(payer);
    if (balance === null) return { ok: false, reason: "refused", message: CARD_TEXTS.no_wallet };
    if (kept === null && balance < price) {
      return { ok: false, reason: "insufficient", price, balance };
    }
    return { ok: true, left, cap, price, foil, balance };
  }

  /**
   * Issues `payer` a daily card: refused when they have had `daily_cap` today or cannot pay
   * `price`. `face` (her words, which may take a model call) is asked for only once the card is
   * paid; if it fails, the coins go back. Their relationship decides her expression on it.
   *
   * With `options.key` (a request's Idempotency-Key) it is the one card of that key: asked again,
   * a restart in between too, the answer is that card as it was (with or without its foil),
   * charged nothing. The serial is kept under the key, with the foil asked for, before the coins
   * are taken, and the wallet keys both charges by the serial, so a retry after a stop between the
   * charges and the card is the same order and the same charges, and gets the card. When no card
   * follows, both charges go back and the kept serial goes, so the next try is a new order with
   * new charges: a foil is never on a card whose foil charge was given back.
   */
  issueDaily(
    payer: CardPayer,
    face: () => Promise<CardFace>,
    options: DailyOptions = {},
  ): Promise<DailyResult> {
    return this.#inTurn(payer.person, () => this.#issueDaily(payer, face, options));
  }

  async #issueDaily(
    payer: CardPayer,
    face: () => Promise<CardFace>,
    options: DailyOptions,
  ): Promise<DailyResult> {
    const { config, clock } = this.#o;
    const key =
      options.key === undefined || options.key === "" ? null : issueKey.daily(options.key);
    if (key !== null) {
      const again = this.#store.byKey(payer.person, key);
      if (again !== null) {
        const pity = this.pity(payer.person);
        const issued = { card: again, pity, new_parts: [], titles: [], again: true };
        return { ok: true, issued, balance: null, charged: 0 };
      }
    }
    const quote = await this.quote(payer, {
      foil: options.foil === true,
      ...(options.key === undefined ? {} : { key: options.key }),
    });
    if (!quote.ok) return quote;
    const { foil, price } = quote;
    // Under a key the serial is kept before the charges: a retry after a restart is the same order.
    const fresh = this.#serial();
    const serial =
      key === null ? fresh : this.#store.reserve(payer.person, key, fresh, clock.now(), foil);
    const unkeep = () => {
      if (key !== null) this.#store.unreserve(payer.person, key, serial);
    };
    let paid: CardWallet | null = null;
    let balance: number | null = null;
    if (price > 0) {
      const wallet = this.#o.wallet();
      if (wallet === null) {
        unkeep();
        return { ok: false, reason: "no_wallet" };
      }
      paid = wallet;
      const charges: (() => Promise<CardCharge>)[] = [];
      if (config.price > 0) {
        charges.push(() => wallet.spend(payer, config.price, CARD_REASONS.daily, serial));
      }
      if (foil) charges.push(() => wallet.foil(payer, serial));
      let taken = 0;
      for (const take of charges) {
        const charge = await take();
        if (charge.ok) {
          balance = charge.balance;
          taken += 1;
          continue;
        }
        // What was taken before it goes back with the serial.
        if (taken > 0) await this.#giveBack(payer, wallet, serial, unkeep);
        else unkeep();
        if (charge.reason === "insufficient") {
          return { ok: false, reason: "insufficient", price, balance: charge.balance };
        }
        return { ok: false, reason: charge.reason, message: charge.message };
      }
    }
    try {
      const words = await face();
      const now = clock.now();
      const issued = this.#store.issue({
        person: payer.person,
        kind: "daily",
        serial,
        price: config.price,
        face: words,
        relationship: options.relationship ?? this.#o.relationship(payer.person),
        rules: drawRules(config),
        random: this.#random,
        now,
        cap: { max: config.daily_cap, since: dayStart(now, config.utc_offset_minutes) },
        frame: options.frame ?? null,
        foil,
        key,
      });
      this.#told(issued);
      return { ok: true, issued, balance, charged: issued.again ? 0 : price };
    } catch (error) {
      if (paid !== null) await this.#giveBack(payer, paid, serial, unkeep);
      else unkeep();
      if (error instanceof CardCapError) {
        return { ok: false, reason: "daily_cap", cap: config.daily_cap };
      }
      throw error;
    }
  }

  /**
   * Gives back what was charged for `serial` (the card and its foil) and forgets the kept serial,
   * so a retry is a new order. When the refund fails the serial stays kept and `settlePending`
   * gives the coins back later.
   */
  async #giveBack(
    payer: CardPayer,
    wallet: CardWallet,
    serial: string,
    unkeep: () => void,
  ): Promise<void> {
    try {
      await wallet.refund(payer, serial, CARD_REASONS.refund);
      unkeep();
    } catch (error) {
      log.error(
        { person: payer.person, serial, err: String(error) },
        "cards: a card was not written and its coins could not be given back",
      );
    }
  }

  /**
   * The milestone card of `tier` for `person` (docs/design/v5-play.md §6.1, P4): the bond entered
   * a tier it had never reached. One per tier per person, whatever happens after (down and up again
   * gives nothing new), so at most one per tier above 認識: 15. A tier given a card before whose
   * card is gone (they asked her to forget them, and the heart's tier floor went with it) gives
   * none: `not_eligible`. Free, outside the day's cap, drawn at the plain odds without moving the
   * pity. `face` is asked for only when there is no such card yet.
   */
  issueMilestone(
    person: PersonId,
    tier: BondTier,
    face: () => Promise<OccasionFace | null>,
  ): Promise<FreeResult> {
    const known = BOND_LADDER.some((t) => t.min === tier.min && t.label === tier.label);
    if (!known || tier.min <= 0) {
      return Promise.resolve({ ok: false, reason: "not_eligible" });
    }
    return this.#issueFree(person, "milestone", issueKey.milestone(tier.min), face, () =>
      this.#store.milestoneGiven(person, tier.min),
    );
  }

  /**
   * The keepsake card of someone who came over from the old records (P5): one each, whatever tier
   * they were at (no milestone is given backwards), issued the first time they open their cards.
   * Free like a milestone card. `not_eligible` for anyone else, and for someone given one before
   * whose card is gone (they asked her to forget them); nobody is sent anything for it.
   */
  keepsake(person: PersonId, face: () => Promise<OccasionFace | null>): Promise<FreeResult> {
    if (this.#o.migrated?.(person) !== true) {
      return Promise.resolve({ ok: false, reason: "not_eligible" });
    }
    return this.#issueFree(person, "keepsake", issueKey.keepsake, face, () =>
      this.#store.keepsakeGiven(person),
    );
  }

  /**
   * `person` picks up the card she dropped as `id` (§6.2): theirs if nobody took it yet, it has
   * not expired, they picked up fewer than `drops_per_person_day` today and they did not pick up
   * the last one in that channel (it is left for someone else). The drop is taken before her
   * words are asked for, so nobody who is too late costs a model call; when no card follows it is
   * put back. A drop card is free, outside the daily cap and the pity, and has one part only a
   * drop can give. Asked again by its taker, it answers their card.
   */
  claimDrop(
    person: PersonId,
    id: string,
    face: () => Promise<OccasionFace | null>,
  ): Promise<DropResult> {
    return this.#inTurn(person, async (): Promise<DropResult> => {
      const { config, clock } = this.#o;
      const drop = this.#store.drop(id);
      if (drop === null) return { ok: false, reason: "drop_gone" };
      if (drop.claimed_by !== null) {
        const mine =
          drop.claimed_by === person ? this.#store.byKey(person, issueKey.drop(id)) : null;
        if (mine === null) return { ok: false, reason: "drop_taken" };
        return {
          ok: true,
          issued: { card: mine, pity: this.pity(person), new_parts: [], titles: [], again: true },
        };
      }
      const now = clock.now();
      if (Date.parse(drop.expires_at) <= now) return { ok: false, reason: "drop_expired" };
      const today = dayStart(now, config.utc_offset_minutes);
      if (this.#store.countSince(person, "drop", today) >= config.drops_per_person_day) {
        return { ok: false, reason: "drop_cap" };
      }
      if (this.#store.lastClaimer(drop.channel) === person) {
        return { ok: false, reason: "drop_skipped" };
      }
      const serial = this.#serial();
      if (!this.#store.claimDrop(id, person, serial, now)) {
        return { ok: false, reason: "drop_taken" };
      }
      try {
        const words = await face();
        if (words === null) {
          this.#store.releaseDrop(id, person);
          return { ok: false, reason: "no_face" };
        }
        const issued = this.#store.issue({
          person,
          kind: "drop",
          serial,
          price: 0,
          face: words.face,
          relationship: words.relationship,
          rules: drawRules(config),
          random: this.#random,
          now: clock.now(),
          key: issueKey.drop(id),
          pity: false,
          dropPart: true,
        });
        this.#told(issued);
        return { ok: true, issued };
      } catch (error) {
        this.#store.releaseDrop(id, person);
        throw error;
      }
    });
  }

  /** What the import from the V4 database kept of `person` (D4); `null`: it did not bring them. */
  importedLegacy(person: PersonId): LegacySnapshot | null {
    return this.#store.importedLegacy(person);
  }

  /**
   * Settles every serial kept for a paid card (`cards_pending`) older than `graceMs`: a try that
   * was charged and then stopped (Core stopped, or the refund failed) and that nobody retried with
   * the same key. When the card was written after all the row just goes; otherwise what was charged
   * under the serial goes back through the wallet (keyed by the charge, so never twice) and then
   * the row goes, so a later retry with that key is a new try. Each row is settled in its person's
   * turn, after any card of theirs still being issued in this process. A row whose wallet or
   * account is not there now stays for a later pass. Safe to run again at any time.
   */
  async settlePending(graceMs = SETTLE_GRACE_MS): Promise<SettleResult> {
    const result: SettleResult = { cleared: 0, refunded: 0, waiting: 0 };
    const before = this.#o.clock.now() - graceMs;
    for (const row of this.#store.pending()) {
      if (Date.parse(row.created_at) > before) {
        result.waiting += 1;
        continue;
      }
      const done = await this.#inTurn(row.person, () => this.#settle(row));
      if (done === "waiting") result.waiting += 1;
      else if (done !== "gone") result[done] += 1;
    }
    return result;
  }

  async #settle(row: PendingCard): Promise<"cleared" | "refunded" | "waiting" | "gone"> {
    const { person, key, serial } = row;
    // Settled meanwhile, or written by a retry in this turn's queue.
    if (this.#store.pendingOf(person, key)?.serial !== serial) return "gone";
    // Its own card, by the serial: a card of the same key with another serial (a merged person's)
    // was not paid by this charge.
    if (this.#store.card(serial) !== null) {
      this.#store.unreserve(person, key, serial);
      log.info({ person, serial }, "cards: a kept serial's card was written; the row is cleared");
      return "cleared";
    }
    const wallet = this.#o.wallet();
    const account = wallet === null ? null : await this.#o.account?.(person);
    if (wallet === null || account === null || account === undefined) return "waiting";
    try {
      const coins = await wallet.refund({ person, account }, serial, CARD_REASONS.refund);
      this.#store.unreserve(person, key, serial);
      log.info(
        { person, serial, coins },
        "cards: a card was charged and never written; what was charged went back",
      );
      return "refunded";
    } catch (error) {
      log.warn(
        { person, serial, err: String(error) },
        "cards: cannot give back a card that was never written; the next pass tries again",
      );
      return "waiting";
    }
  }

  /**
   * Her line for up to `limit` keepsake cards that have none (issued with facts only, so opening
   * one's cards never waits on a model), oldest first, each in its person's turn: asked for through
   * `faces` (the api's writer, with its moderation and its no-other-names filter), told what the
   * card already says, and put on the card if it still has no line. A card she wrote nothing for
   * that passed is tried again on a later pass, at most `KEEPSAKE_LINE_TRIES` times. `rewritten` is
   * told of each card that got its line (its kept pictures go). Safe to run again at any time, and
   * after a restart: what is done is on the cards.
   */
  async writeKeepsakeLines(
    faces: CardFaces,
    limit: number,
  ): Promise<{ written: number; tried: number }> {
    const result = { written: 0, tried: 0 };
    for (const candidate of this.#store.keepsakesWithoutLine(limit)) {
      const done = await this.#inTurn(candidate.person, async () => {
        const card = this.#store.card(candidate.serial);
        if (card === null || card.face.line !== null) return null;
        const face = await faces.face(card.person, { kind: "keepsake", facts: card.face.fields });
        const line = face?.face.line ?? null;
        return this.#store.setKeepsakeLine(card.serial, line);
      });
      if (done === null) continue;
      result.tried += 1;
      if (!done) continue;
      result.written += 1;
      try {
        faces.rewritten?.(candidate.serial);
      } catch (error) {
        log.warn(
          { serial: candidate.serial, err: String(error) },
          "cards: cannot drop a rewritten card's pictures",
        );
      }
    }
    return result;
  }

  /**
   * A free card of `kind` for `key`, once per person; the one already there when it exists.
   * `given`: whether one was given before and is gone, so none is given now.
   */
  #issueFree(
    person: PersonId,
    kind: CardKind,
    key: string,
    face: () => Promise<OccasionFace | null>,
    given?: () => boolean,
  ): Promise<FreeResult> {
    return this.#inTurn(person, async (): Promise<FreeResult> => {
      const { config, clock } = this.#o;
      const found = this.#store.byKey(person, key);
      if (found !== null) {
        const pity = this.pity(person);
        return { ok: true, issued: { card: found, pity, new_parts: [], titles: [], again: true } };
      }
      if (given?.() === true) return { ok: false, reason: "not_eligible" };
      const words = await face();
      if (words === null) return { ok: false, reason: "no_face" };
      const issued = this.#store.issue({
        person,
        kind,
        serial: this.#serial(),
        price: 0,
        face: words.face,
        relationship: words.relationship,
        rules: drawRules(config),
        random: this.#random,
        now: clock.now(),
        key,
        pity: false,
      });
      if (!issued.again) this.#told(issued);
      return { ok: true, issued };
    });
  }

  /** Tells `onIssued` of a card; its errors are logged. */
  #told(issued: IssuedCard): void {
    try {
      this.#o.onIssued?.(issued);
    } catch (error) {
      log.warn(
        { person: issued.card.person, serial: issued.card.serial, err: String(error) },
        "cards: cannot tell her about a card",
      );
    }
  }

  /** The daily card `person` was issued for the request key `key`; `null`: none. */
  dailyByKey(person: PersonId, key: string): CardRecord | null {
    return key === "" ? null : this.#store.byKey(person, issueKey.daily(key));
  }

  /** Daily cards `person` may still get today. */
  dailyLeft(person: PersonId): number {
    const { config, clock } = this.#o;
    const since = dayStart(clock.now(), config.utc_offset_minutes);
    return Math.max(config.daily_cap - this.#store.countSince(person, "daily", since), 0);
  }

  /** The public odds of a daily card. */
  odds(): OddsTable {
    return oddsTable(this.#store.catalogue(), drawRules(this.#o.config));
  }

  catalogue(): Part[] {
    return this.#store.catalogue();
  }

  pity(person: PersonId): PityView {
    return pityView(this.#store.pitySince(person), this.#o.config.pity);
  }

  card(serial: string): CardRecord | null {
    return this.#store.card(serial);
  }

  cards(person: PersonId, options: { limit?: number; before?: string } = {}): CardRecord[] {
    return this.#store.cards(person, options);
  }

  dex(person: PersonId): DexView {
    const catalogue = this.#store.catalogue();
    const byId = new Map(catalogue.map((p) => [p.id, p]));
    const entries = this.#store.dex(person);
    const parts: DexPart[] = entries.flatMap((e) => {
      const p = byId.get(e.part);
      return p === undefined
        ? []
        : [{ ...e, name: p.name, slot: p.slot, rarity: p.rarity, series: p.series }];
    });
    return {
      parts,
      series: seriesProgress(catalogue, new Set(entries.map((e) => e.part))),
      titles: this.#store.titles(person),
      legacy: { series: LEGACY_SERIES, items: this.#store.legacy(person) },
    };
  }

  wishlist(person: PersonId): string[] {
    return this.#store.wishlist(person);
  }

  /**
   * Makes one of their titles shown to others or theirs alone (private when earned); the title as
   * it is now, `null` when they have none of `series`.
   */
  setTitlePublic(person: PersonId, series: string, value: boolean): CardTitle | null {
    return this.#store.setTitlePublic(person, series, value);
  }

  /** The titles `person` chose to show others, earliest first: all anyone else may see of them. */
  publicTitles(person: PersonId): CardTitle[] {
    return this.#store.titles(person).filter((t) => t.public);
  }

  /** Replaces the wishlist (at most three parts); why not, or `null` once written. */
  setWishlist(person: PersonId, parts: readonly string[]): WishlistProblem | null {
    return this.#store.setWishlist(person, parts, this.#o.clock.now());
  }

  clearWishlist(person: PersonId): void {
    this.#store.clearWishlist(person);
  }

  /** How many cards `person` has. */
  count(person: PersonId): number {
    return this.#store.countOf(person);
  }

  /**
   * Deletes the cards of `person` (when they ask her to forget them, like the member cards were):
   * no card of theirs checks out any more. Their dex and titles go with the plugin's own hook.
   */
  deleteCards(person: PersonId): number {
    return this.#store.deleteCards(person);
  }

  /** Runs `fn` after every earlier call of `person`'s in this process. */
  async #inTurn<T>(person: PersonId, fn: () => Promise<T>): Promise<T> {
    const before = this.#turns.get(person) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#turns.set(person, tail);
    try {
      return await run;
    } finally {
      if (this.#turns.get(person) === tail) this.#turns.delete(person);
    }
  }
}
