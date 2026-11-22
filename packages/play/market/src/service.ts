// The weekly market (docs/design/v5-play.md §4.5, §11.4): the song priority ticket, the weekly
// auction and the weekly lottery, over the market's tables (`store.ts`) and the economy's wallet
// (`MarketWalletKey`, looked up at each use).
//
// * One service is one Space's market: its rows (`MarketStore.forSpace`) and its config, read at
//   each use (a Space's settings apply without a restart); `markets.ts` keeps one per Space and one
//   more for the song priority ticket, which is everyone's (`trades` / `songs` say which parts run).
// * Everything that writes runs in turn (`#turns`): a bid, a purchase, a name and the periodic
//   pass (`tick`). The times it acts on are derived from the config and the times kept in the
//   tables, so a restart picks up where it was: a lot that should be open opens, one past its end
//   closes, a step that stopped half way (a hold with no bid, a purchase not marked paid, a
//   winner's coins not burned yet) is finished from the rows.
// * The auction: one lot a week in the configured channel, opening at `auction_weekday` /
//   `auction_time` for `auction_hours`. The kind is the owner's plan for the week, else her pick,
//   else the rotation. A bid holds the bidder's coins (a raise of one's own bid holds the
//   difference); an outbid bidder's holds go back at once; a bid in the last `auction_extend_mins`
//   moves the end, never past `auction_extend_max_mins` after the scheduled end. At the end the leader's price is burned and their holds released. A name lot
//   waits for a name she accepts (shape, moderation, and not from someone she cannot stand) for
//   `auction_name_hours`; given up or late, the holds go back and nothing is burned. The name is
//   what she calls them for `auction_call_days`, then the old one is back unless they changed it.
// * The lottery: tickets are sold for the week until the draw; a person holds at most
//   `lottery_per_week`. At the draw, fewer than `lottery_min_buyers` different buyers refunds
//   everyone; else one ticket is drawn with the system CSPRNG (so a person's chance is their share
//   of the tickets), the winner is paid `lottery_prize_share` of the pot and the rest stays burned.
// * She cannot bid, buy a ticket or win: her own accounts are refused before anything is charged.
//   She is told what happened (a lot won, a draw) so she can say something in her own words; the
//   song priority ticket is never mentioned to her.
// * The song priority ticket: each charge is a row (`market_song_tickets`) written before the
//   wallet is asked, marked used when its song starts being sung (`consume`) or given back. The
//   pass gives back a ticket neither used nor held by the singer's set list after a grace period,
//   so a charge that stopped half way, anywhere, goes back.
// * Turning the auction off (or leaving it without a channel) calls off an open lot and gives
//   every hold back; turning the lottery off refunds the open week. `migrations.ts` has the SQL
//   that does the same when the plugin is removed.

import { randomInt } from "node:crypto";
import { errorMessage, type Logger, SerialQueue } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  DEFAULT_CURRENCY,
  MARKET_REASONS,
  type MarketCharge,
  type MarketWallet,
  newId,
  type PersonId,
  type PictureFile,
  type Pictures,
  type SongPriority,
  type SongPriorityTerms,
  type SongTickets,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { type LotKind, lotteryChannel, type MarketConfig } from "./config.js";
import { LOT_TITLE, type LotPicker, rotationKind } from "./lots.js";
import { auctionClosedNote, lotteryNote, nameNote } from "./notes.js";
import {
  auctionNotice,
  type CommandReplyLike,
  lotResultNotice,
  lotteryNotice,
  lotteryResultNotice,
} from "./notices.js";
import {
  auctionPictureData,
  drawPicture,
  drawPictureData,
  lotteryPictureData,
  withPicture,
} from "./pictures.js";
import type { Bid, Lot, LotStatus, LotteryWeek, MarketStore, Ticket, WeekStatus } from "./store.js";
import {
  DAY_MS,
  dayStartMs,
  HOUR_MS,
  lastSlot,
  localDay,
  MINUTE_MS,
  nextSlot,
  type WeeklyAt,
} from "./time.js";

/** A step that stopped this long ago with nothing after it is settled by the pass. */
export const STALE_MS = 2 * MINUTE_MS;
/**
 * How long after its charge a song priority ticket whose song the set list does not hold is given
 * back: a request still between its charge and its listing is not raced.
 */
export const SONG_TICKET_GRACE_MS = 5 * MINUTE_MS;
/** The highest bid anyone can make. */
export const MAX_BID = 1_000_000;
/** How many past lots and weeks the history keeps. */
const HISTORY = 20;
const NOT_KNOWN = "她還不認識你,先和她說說話吧";
const NO_WALLET = "錢包現在打不開";
const HER_OWN = "她自己不能參加";

/** A refusal with a sentence for the person and the HTTP status it maps to. */
export interface MarketRefusal {
  ok: false;
  status: 400 | 402 | 403 | 404 | 409 | 429 | 503;
  message: string;
}

const refuse = (status: MarketRefusal["status"], message: string): MarketRefusal => ({
  ok: false,
  status,
  message,
});

export type BidResult =
  | {
      ok: true;
      amount: number;
      ends_at: Timestamp;
      extended: boolean;
      balance: number | null;
      /** The same bid again (they already lead with it): nothing new was held. */
      again: boolean;
    }
  | MarketRefusal;

export type BuyResult =
  | {
      ok: true;
      count: number;
      mine: number;
      charged: number;
      balance: number | null;
      again: boolean;
    }
  | MarketRefusal;

export type NameResult =
  | { ok: true; call_name: string; applied_until: Timestamp }
  | { ok: true; refunded: number }
  | MarketRefusal;

export interface LotView {
  id: string;
  week: number;
  kind: LotKind;
  name: string;
  detail: string;
  /** `open`: taking bids; `naming`: waiting for the winner's name; `applied`: the name is in use. */
  state: "open" | "closing" | "naming" | "applied" | "done" | "refunded" | "cancelled";
  picked_by: "owner" | "her" | "rotation";
  opens_at: Timestamp;
  ends_at: Timestamp;
  extended: boolean;
  opening_bid: number;
  step: number;
  /** The smallest bid that would lead now; `null` when it takes no bids. */
  min_bid: number | null;
  top: { amount: number; name: string } | null;
  bids: number;
  bidders: number;
  winner: { name: string; price: number } | null;
  call_name: string | null;
  name_due: Timestamp | null;
  applied_until: Timestamp | null;
}

export interface AuctionView {
  currency: string;
  /** On, with a channel. */
  running: boolean;
  lot: LotView | null;
  /** When the next lot opens, and what the owner set for it (`null`: she picks; `skip`). */
  next: { opens_at: Timestamp; plan: LotKind | "skip" | null } | null;
  /** The viewer's own bid on `lot`; `null` when none or for no one in particular. */
  mine: { amount: number; leading: boolean; won: boolean } | null;
  /** The newest bids, newest first. */
  history: { amount: number; name: string; at: Timestamp }[];
}

export interface LotteryView {
  currency: string;
  running: boolean;
  price: number;
  per_person: number;
  min_buyers: number;
  prize_share: number;
  week: number;
  state: WeekStatus;
  draw_at: Timestamp;
  tickets: number;
  buyers: number;
  pot: number;
  mine: { tickets: number } | null;
  last: {
    week: number;
    state: "drawn" | "refunded";
    drawn_at: Timestamp | null;
    tickets: number;
    buyers: number;
    pot: number;
    prize: number;
    burned: number;
    winner: string | null;
  } | null;
}

export interface MyBid {
  lot: string;
  week: number;
  kind: LotKind;
  name: string;
  amount: number;
  /** `leading` / `outbid` while open; `won` / `lost` after; `cancelled`, `refunded`. */
  state: "leading" | "outbid" | "won" | "lost" | "cancelled" | "refunded";
  at: Timestamp;
}

export interface MyTickets {
  week: number;
  draw_at: Timestamp;
  tickets: number;
  paid: number;
  state: WeekStatus;
  won: boolean;
  prize: number;
}

export interface MarketHistory {
  lots: (LotView & { note: string | null; price: number | null })[];
  weeks: NonNullable<LotteryView["last"]>[];
  /** The lot kinds the config offers (`auction_lots`). */
  offered: LotKind[];
  /** The coming opening and the owner's plan for it, as `AuctionView.next`. */
  next: AuctionView["next"];
}

/** What she would call someone, and setting it (the heart's `call_name`). */
export interface CallNames {
  get(person: PersonId): string | null;
  set(person: PersonId, name: string | null): void;
  /** She will not take a name from them now (she cannot stand them). */
  refuses(person: PersonId): boolean;
}

export interface MarketDeps {
  /** The config, or where to read it at each use (a Space's settings apply without a restart). */
  config: MarketConfig | (() => MarketConfig);
  /** The tables, as seen from the Space this market runs in (`MarketStore.forSpace`). */
  store: MarketStore;
  /**
   * Its lottery runs only with a channel of its own: every Space but the primary, and the primary
   * too when the cluster names a lottery channel (it is then some server's, and runs there). So a
   * server where nobody set the market up sells nothing, and the one lottery of before runs once
   * (the primary without a channel only when none was ever set).
   */
  secondary?: boolean;
  /** Whether this market runs the auction and the lottery (default true). */
  trades?: boolean;
  /** Whether this market sells and settles the song priority tickets (default true). */
  songs?: boolean;
  /** The economy's wallet, looked up at each use (the economy may restart). */
  wallet: () => MarketWallet | null;
  now: () => number;
  /** Her own accounts: she cannot bid, buy or win. */
  isSelf: (account: AccountRef) => boolean;
  /** `null`: no heart, so no name lot can be applied. */
  names: CallNames | null;
  /** Why a name will not do (its shape, moderation), else `null`. */
  screenName: (name: string) => Promise<string | null>;
  /** Her pick of the week's lot; `null`: no model, the rotation decides. */
  picker: LotPicker | null;
  /** Posts a notice in a channel; the message id, or `null` when it could not. */
  post: (channel: string, reply: CommandReplyLike) => Promise<string | null>;
  /** Something she hears, as a note she may react to. */
  tell: (summary: string, key: string, person: PersonId | null) => void;
  log: Pick<Logger, "info" | "warn">;
  /** An integer in [0, n) (the system CSPRNG unless a test pins it). */
  randomInt?: (n: number) => number;
  /** The picture renderer (`PicturesKey`), looked up at each use; absent: text cards only. */
  pictures?: () => Pictures | null;
  /**
   * The singer's set list (`SongTicketsKey`), looked up at each use; absent or `null`: no song
   * priority ticket is given back by the pass (it cannot tell which are still waiting).
   */
  songTickets?: () => SongTickets | null;
}

/** Throws when a ledger call did not go through, so the pass tries again. */
class Unsettled extends Error {}

export class MarketService {
  readonly #d: MarketDeps;
  readonly #turns = new SerialQueue();

  constructor(deps: MarketDeps) {
    this.#d = deps;
  }

  /** The config in force now. */
  get config(): MarketConfig {
    return this.#c();
  }

  #c(): MarketConfig {
    const c = this.#d.config;
    return typeof c === "function" ? c() : c;
  }

  /** Whether the lottery sells tickets: on, and for a secondary Space with its own channel. */
  lotteryRunning(): boolean {
    const c = this.#c();
    return c.lottery && (this.#d.secondary !== true || lotteryChannel(c) !== "");
  }

  #now(): number {
    return this.#d.now();
  }

  #wallet(): MarketWallet | null {
    return this.#d.wallet();
  }

  #currency(): string {
    return this.#wallet()?.currency ?? DEFAULT_CURRENCY;
  }

  #offset(): number {
    return this.#c().utc_offset_minutes;
  }

  #refusal(charge: Exclude<MarketCharge, { ok: true }>, what: string): MarketRefusal {
    switch (charge.reason) {
      case "insufficient": {
        const have = charge.balance === null ? "" : `,你有 ${charge.balance}`;
        return refuse(402, `${this.#currency()}不夠${what}${have}`);
      }
      case "capped":
        return refuse(429, charge.message);
      case "refused":
        return refuse(charge.message === NOT_KNOWN ? 403 : 409, charge.message);
    }
  }

  // ---- the song priority ticket -------------------------------------------------------------

  /** The port the singer asks (`SongPriorityKey`). */
  readonly songPriority: SongPriority = {
    terms: (): SongPriorityTerms | null => {
      const c = this.#c();
      if (c.song_priority_per_day === 0) return null;
      return {
        price: c.song_priority,
        per_day: c.song_priority_per_day,
        currency: this.#currency(),
      };
    },
    // The row goes in before the wallet is asked, so a charge that stopped half way (Core stopped,
    // the singer never listed the song) is found by the pass (`#songTicketPass`) and given back.
    // The price and the day's limit are everyone's; the row records the Space whose queue the
    // ticket is used in.
    charge: async (account, key, ref, space) => {
      const c = this.#c();
      if (c.song_priority_per_day === 0) return { ok: false, message: "現在沒有賣點歌優先券" };
      if (this.#d.isSelf(account)) return { ok: false, message: HER_OWN };
      const wallet = this.#wallet();
      if (wallet === null) return { ok: false, message: NO_WALLET };
      const who = await wallet.member(account);
      if (who === null) return { ok: false, message: NOT_KNOWN };
      const now = this.#now();
      this.#d.store.addSongTicket(
        { key, person: who.person, account, amount: c.song_priority },
        now,
        space ?? null,
      );
      const since = toTimestamp(dayStartMs(localDay(now, this.#offset()), this.#offset()));
      const charge = await wallet.charge(
        account,
        c.song_priority,
        MARKET_REASONS.songPriority,
        key,
        ref,
        { since, limit: c.song_priority_per_day },
      );
      if (charge.ok) {
        this.#d.store.setSongTicket(key, "charged", ["charging"], this.#now());
        return { ok: true, balance: charge.balance };
      }
      this.#d.store.setSongTicket(key, "void", ["charging"], this.#now());
      if (charge.reason === "capped") {
        return { ok: false, message: `點歌優先券一天最多用 ${c.song_priority_per_day} 張` };
      }
      return { ok: false, message: this.#refusal(charge, `(優先券要 ${c.song_priority})`).message };
    },
    // Without the wallet nothing went back: it throws, so the singer keeps the key and tries again
    // (answering 0 would read as "nothing to give back" and the ticket would be lost).
    refund: async (account, key) => {
      const wallet = this.#wallet();
      if (wallet === null) throw new Unsettled(NO_WALLET);
      const coins = await wallet.refund(account, MARKET_REASONS.songPriority, key);
      this.#d.store.setSongTicket(key, "refunded", ["charging", "charged"], this.#now());
      return coins;
    },
    // A ticket of before the table (no row) has nothing to mark: the singer's own refunds cover it.
    consume: (key) => {
      if (!this.#d.store.setSongTicket(key, "consumed", ["charging", "charged"], this.#now())) {
        const was = this.#d.store.songTicket(key)?.status ?? null;
        if (was === "refunded") {
          this.#d.log.warn({ key }, "market: a song was sung after its ticket was given back");
        }
      }
    },
  };

  /**
   * The song priority tickets neither used nor given back, `SONG_TICKET_GRACE_MS` after they were
   * charged: given back when the singer's set list does not hold their song (it was never listed,
   * it ended without being sung, it left the history with its refund due). Without the singer, or
   * before it read its set list back, nothing is decided. What went back is kept as `refunded`; a
   * charge that never happened gives back nothing and is kept so too.
   */
  async #songTicketPass(signal?: AbortSignal): Promise<void> {
    const store = this.#d.store;
    const open = store.openSongTickets(this.#now() - SONG_TICKET_GRACE_MS);
    if (open.length === 0) return;
    const songs = this.#d.songTickets?.() ?? null;
    if (songs === null) return;
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    for (const t of open) {
      if (signal?.aborted) return;
      const held = songs.holds(t.key);
      if (held !== false) continue;
      const coins = await wallet.refund(t.account, MARKET_REASONS.songPriority, t.key);
      store.setSongTicket(t.key, "refunded", ["charging", "charged"], this.#now());
      this.#d.log.info(
        { key: t.key, person: t.person, coins },
        "market: a song priority ticket with no song was given back",
      );
    }
  }

  // ---- times --------------------------------------------------------------------------------

  #auctionAt(): WeeklyAt {
    return { weekday: this.#c().auction_weekday, time: this.#c().auction_time };
  }

  #drawAt(): WeeklyAt {
    return { weekday: this.#c().lottery_weekday, time: this.#c().lottery_time };
  }

  /** Whether the auction runs: on, with a channel. */
  auctionRunning(): boolean {
    return this.#c().auction && this.#c().auction_channel !== "";
  }

  /** The latest opening at or before `now`, its week and end. */
  #slot(now: number): { opens: number; ends: number; week: number } {
    const opens = lastSlot(this.#auctionAt(), now, this.#offset());
    return {
      opens,
      ends: opens + this.#c().auction_hours * HOUR_MS,
      week: localDay(opens, this.#offset()),
    };
  }

  /** The lottery week being sold now: the next draw strictly after `now`. */
  #lotteryWeek(now: number): { week: number; drawAt: number } {
    const drawAt = nextSlot(this.#drawAt(), now, this.#offset());
    return { week: localDay(drawAt, this.#offset()), drawAt };
  }

  // ---- the auction: bids --------------------------------------------------------------------

  /** A bid of `amount` by `account` on the open lot. */
  bid(account: AccountRef, amount: number): Promise<BidResult> {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BID) {
      return Promise.resolve(refuse(400, `出價要是 1 到 ${MAX_BID} 的整數`));
    }
    if (this.#d.isSelf(account)) return Promise.resolve(refuse(403, HER_OWN));
    return this.#turns.run(async (): Promise<BidResult> => {
      const wallet = this.#wallet();
      if (wallet === null) return refuse(503, NO_WALLET);
      const now = this.#now();
      const lot = this.#d.store.lotsIn(["open"])[0];
      if (lot === undefined || lot.kind === null || now >= Date.parse(lot.ends_at)) {
        return refuse(409, "現在沒有在拍賣");
      }
      const who = await wallet.member(account);
      if (who === null) return refuse(403, NOT_KNOWN);
      const c = this.#c();
      const leading = this.#d.store.leading(lot.id);
      const top = Math.max(0, ...leading.map((b) => b.amount));
      const mine = leading.length > 0 && leading[0]?.person === who.person;
      if (mine && amount === top) {
        const balance = await wallet.balance(account);
        return {
          ok: true,
          amount,
          ends_at: lot.ends_at,
          extended: lot.extended,
          balance,
          again: true,
        };
      }
      const min = leading.length === 0 ? c.auction_opening_bid : top + c.auction_step;
      if (amount < min) return refuse(409, `出價至少要 ${min}`);
      const id = newId();
      const hold = mine ? amount - top : amount;
      this.#d.store.addBid(
        { id, lot: lot.id, person: who.person, account, name: who.name, amount, hold },
        now,
      );
      const held = await wallet.hold(account, hold, id, `lot:${lot.id}`);
      if (!held.ok) {
        this.#d.store.setBid(id, { status: "void", released_at: now });
        return this.#refusal(held, "");
      }
      const extend = this.#extendedEnd(lot, now);
      const outbid = this.#d.store.lead(id, extend);
      // An outbid bidder's coins go back at once; a release that fails is retried by the pass.
      for (const b of outbid) await this.#release(b).catch(() => undefined);
      return {
        ok: true,
        amount,
        ends_at: extend === null ? lot.ends_at : toTimestamp(extend),
        extended: extend !== null || lot.extended,
        balance: held.balance,
        again: false,
      };
    });
  }

  /**
   * The lot's new end after a bid at `now`, or `null` when it stays: a bid in the last
   * `auction_extend_mins` moves the end that much after it, but never past
   * `auction_extend_max_mins` after the scheduled end (the lot's opening plus `auction_hours`).
   */
  #extendedEnd(lot: Lot, now: number): number | null {
    const c = this.#c();
    const window = c.auction_extend_mins * MINUTE_MS;
    const ends = Date.parse(lot.ends_at);
    if (window <= 0 || ends - now >= window) return null;
    const scheduled = Date.parse(lot.opens_at) + c.auction_hours * HOUR_MS;
    const latest = scheduled + c.auction_extend_max_mins * MINUTE_MS;
    const moved = Math.min(now + window, latest);
    return moved > ends ? moved : null;
  }

  /** Gives a bid's hold back and marks it released. */
  async #release(bid: Bid): Promise<void> {
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    if (bid.hold > 0) await wallet.release(bid.account, bid.id);
    this.#d.store.setBid(bid.id, { released_at: this.#now() });
  }

  // ---- the auction: the winner's name -------------------------------------------------------

  /** The lot `account` won and still has to name, if any. */
  #naming(person: PersonId): Lot | null {
    for (const lot of this.#d.store.lotsIn(["naming"])) {
      const bid = lot.winner_bid === null ? null : this.#d.store.bid(lot.winner_bid);
      if (bid?.person === person) return lot;
    }
    return null;
  }

  /** The winner of a name lot gives the name she will call them. */
  proposeName(account: AccountRef, raw: string): Promise<NameResult> {
    return this.#turns.run(async (): Promise<NameResult> => {
      const wallet = this.#wallet();
      if (wallet === null) return refuse(503, NO_WALLET);
      const who = await wallet.member(account);
      if (who === null) return refuse(403, NOT_KNOWN);
      const found = this.#naming(who.person);
      if (found === null) return refuse(404, "你沒有要取名的拍賣");
      const names = this.#d.names;
      if (names === null) return refuse(503, "現在沒辦法設定稱呼");
      // A name taken before a stop: finish that one (its price may be burned already).
      if (found.call_name !== null) {
        const done = await this.#applyName(found);
        return { ok: true, call_name: done.call_name ?? "", applied_until: done.applied_until };
      }
      const name = raw.trim();
      if (name === "") return refuse(400, "要寫一個稱呼");
      const why = await this.#d.screenName(name);
      if (why !== null) return refuse(409, `她不想這樣叫你:${why} 換一個,或選不要了退款。`);
      if (names.refuses(who.person)) return refuse(409, "她現在不想幫你換稱呼。可以選不要了退款。");
      const until = this.#now() + this.#c().auction_call_days * DAY_MS;
      // Taken: written before anything is burned, so a stop after this finishes applying it and
      // never refunds a price that was burned.
      const taken = {
        call_name: name,
        previous_call_name: names.get(who.person),
        applied_until: toTimestamp(until),
      };
      if (!this.#d.store.setLot(found.id, ["naming"], taken)) {
        return refuse(409, "這場拍賣已經結束了");
      }
      const done = await this.#applyName({ ...found, ...taken });
      this.#d.tell(
        nameNote(who.name, name, this.#c().auction_call_days),
        `market:name:${found.id}`,
        who.person,
      );
      return { ok: true, call_name: name, applied_until: done.applied_until };
    });
  }

  /**
   * A name the winner gave that she took (`call_name` on a `naming` lot): the price burned, the
   * holds released, the name set, the lot `applied`. Each step once, so it is finished from any
   * point it stopped at.
   */
  async #applyName(lot: Lot): Promise<{ call_name: string | null; applied_until: Timestamp }> {
    const names = this.#d.names;
    if (names === null) throw new Unsettled("no heart to set the name in");
    const winner = lot.winner_bid === null ? null : this.#d.store.bid(lot.winner_bid);
    await this.#settleWin(lot, `call_name:${lot.id}`);
    if (winner !== null && lot.call_name !== null) names.set(winner.person, lot.call_name);
    const until = lot.applied_until ?? toTimestamp(this.#now());
    this.#d.store.setLot(lot.id, ["naming"], {
      status: "applied",
      applied_until: until,
      settled_at: toTimestamp(this.#now()),
    });
    return { call_name: lot.call_name, applied_until: until };
  }

  /** The winner of a name lot gives it up: their coins go back, nothing is burned. */
  giveUpName(account: AccountRef): Promise<NameResult> {
    return this.#turns.run(async (): Promise<NameResult> => {
      const wallet = this.#wallet();
      if (wallet === null) return refuse(503, NO_WALLET);
      const who = await wallet.member(account);
      if (who === null) return refuse(403, NOT_KNOWN);
      const lot = this.#naming(who.person);
      if (lot === null) return refuse(404, "你沒有要取名的拍賣");
      if (lot.call_name !== null) {
        // She took a name already and its price may be burned: that name is finished instead.
        await this.#applyName(lot);
        return refuse(409, `她已經收下「${lot.call_name}」這個稱呼了,不能退款`);
      }
      const back = await this.#refundLot(lot, ["naming"]);
      return { ok: true, refunded: back };
    });
  }

  /** Burns a won lot's price and releases the winner's holds (each step once). */
  async #settleWin(lot: Lot, ref: string): Promise<void> {
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    const winners = this.#d.store
      .bids(lot.id)
      .filter((b) => b.status === "leading" || b.status === "won");
    const head = winners[0];
    if (head === undefined || lot.price === null) return;
    if (!(await wallet.burn(head.account, lot.price, lot.id, ref))) {
      throw new Unsettled("the price was not burned");
    }
    for (const b of winners) {
      if (b.released_at !== null) continue;
      if (b.hold > 0) await wallet.release(b.account, b.id);
      this.#d.store.setBid(b.id, { status: "won", released_at: this.#now() });
    }
  }

  /** Gives every hold of a lot back and marks it `refunded`; the coins given back. */
  async #refundLot(
    lot: Lot,
    from: readonly LotStatus[],
    status: LotStatus = "refunded",
  ): Promise<number> {
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    let back = 0;
    for (const b of this.#d.store.bids(lot.id)) {
      if (b.released_at !== null || b.status === "void") continue;
      if (b.hold > 0) back += await wallet.release(b.account, b.id);
      this.#d.store.setBid(b.id, { status: "outbid", released_at: this.#now() });
    }
    this.#d.store.setLot(lot.id, [...from], { status, settled_at: toTimestamp(this.#now()) });
    return back;
  }

  // ---- the lottery: buying ------------------------------------------------------------------

  /** `count` tickets of this week for `account`; `key` makes a retry the same purchase. */
  buyTickets(account: AccountRef, count: number, key: string): Promise<BuyResult> {
    const c = this.#c();
    if (!Number.isSafeInteger(count) || count < 1 || count > c.lottery_per_week) {
      return Promise.resolve(refuse(400, `一次可以買 1 到 ${c.lottery_per_week} 張`));
    }
    if (!this.lotteryRunning()) return Promise.resolve(refuse(409, "現在沒有樂透"));
    if (this.#d.isSelf(account)) return Promise.resolve(refuse(403, HER_OWN));
    return this.#turns.run(async (): Promise<BuyResult> => {
      const wallet = this.#wallet();
      if (wallet === null) return refuse(503, NO_WALLET);
      const who = await wallet.member(account);
      if (who === null) return refuse(403, NOT_KNOWN);
      const store = this.#d.store;
      let ticket = store.ticketByKey(who.person, key);
      const now = this.#now();
      if (ticket?.status === "refunded") return refuse(409, "這筆已經退回了,請再試一次");
      if (ticket?.status === "paid") {
        const balance = await wallet.balance(account);
        const mine = store.ticketCount(ticket.week, who.person);
        return { ok: true, count: ticket.count, mine, charged: 0, balance, again: true };
      }
      if (ticket === null) {
        const { week, drawAt } = this.#lotteryWeek(now);
        const open = store.ensureWeek(week, drawAt);
        if (open.status !== "open") return refuse(409, "這週的樂透已經開過了,下週再來");
        ticket = store.addTicket(
          {
            id: newId(),
            week,
            person: who.person,
            account,
            name: who.name,
            key,
            count,
            amount: count * c.lottery_price,
          },
          c.lottery_per_week,
          now,
        );
        if (ticket === null) {
          const have = store.ticketCount(week, who.person);
          return refuse(429, `一個人一週最多 ${c.lottery_per_week} 張,你已經有 ${have} 張`);
        }
      }
      const charge = await wallet.charge(
        account,
        ticket.amount,
        MARKET_REASONS.lotteryTicket,
        ticket.id,
        `lottery:${ticket.week}:${ticket.count}`,
      );
      if (!charge.ok) {
        store.dropTicket(ticket.id);
        return this.#refusal(charge, `(${ticket.count} 張要 ${ticket.amount})`);
      }
      store.setTicket(ticket.id, "paid", now);
      return {
        ok: true,
        count: ticket.count,
        mine: store.ticketCount(ticket.week, who.person),
        charged: ticket.amount,
        balance: charge.balance,
        again: false,
      };
    });
  }

  // ---- views --------------------------------------------------------------------------------

  #lotView(lot: Lot): LotView | null {
    if (lot.kind === null) return null;
    const c = this.#c();
    const bids = this.#d.store
      .bids(lot.id)
      .filter((b) => b.status !== "pending" && b.status !== "void");
    const leading = bids.filter((b) => b.status === "leading" || b.status === "won");
    const top =
      leading.length === 0 ? null : leading.reduce((a, b) => (b.amount > a.amount ? b : a));
    const open = lot.status === "open" && this.#now() < Date.parse(lot.ends_at);
    const winner =
      lot.winner_bid === null || lot.price === null ? null : this.#d.store.bid(lot.winner_bid);
    return {
      id: lot.id,
      week: lot.week,
      kind: lot.kind,
      name: LOT_TITLE[lot.kind].name,
      detail: LOT_TITLE[lot.kind].detail,
      state: lot.status as LotView["state"],
      picked_by: lot.picked_by,
      opens_at: lot.opens_at,
      ends_at: lot.ends_at,
      extended: lot.extended,
      opening_bid: c.auction_opening_bid,
      step: c.auction_step,
      min_bid: open ? (top === null ? c.auction_opening_bid : top.amount + c.auction_step) : null,
      top: top === null ? null : { amount: top.amount, name: top.name },
      bids: bids.length,
      bidders: new Set(bids.map((b) => b.person)).size,
      winner:
        winner === null || lot.price === null ? null : { name: winner.name, price: lot.price },
      call_name: lot.call_name,
      name_due: lot.name_due,
      applied_until: lot.applied_until,
    };
  }

  /** The lot people see now: the open one, else the latest that ran. */
  #currentLot(): Lot | null {
    const live = this.#d.store.lotsIn(["open", "closing", "naming"]);
    return live.at(-1) ?? this.#d.store.history(1)[0] ?? null;
  }

  async auctionView(account: AccountRef | null): Promise<AuctionView> {
    const lot = this.#currentLot();
    const view = lot === null ? null : this.#lotView(lot);
    let mine: AuctionView["mine"] = null;
    if (account !== null && lot !== null) {
      const who = await this.#wallet()?.member(account);
      if (who) {
        const own = this.#d.store
          .bids(lot.id)
          .filter((b) => b.person === who.person && b.status !== "pending" && b.status !== "void");
        if (own.length > 0) {
          const best = Math.max(...own.map((b) => b.amount));
          const leading = own.some((b) => b.status === "leading");
          mine = {
            amount: best,
            leading,
            won: own.some((b) => b.status === "won") || (leading && lot.status !== "open"),
          };
        }
      }
    }
    const history = lot === null ? [] : this.#bidHistory(lot.id);
    return {
      currency: this.#currency(),
      running: this.auctionRunning(),
      lot: view,
      next: this.#next(),
      mine,
      history,
    };
  }

  /** The coming opening and the owner's plan for it; `null` while the auction does not run. */
  #next(): AuctionView["next"] {
    if (!this.auctionRunning()) return null;
    const now = this.#now();
    const slot = this.#slot(now);
    const opens = now < slot.opens ? slot.opens : nextSlot(this.#auctionAt(), now, this.#offset());
    const plan = this.#d.store.lotOfWeek(localDay(opens, this.#offset()));
    return {
      opens_at: toTimestamp(opens),
      plan: plan?.status === "skipped" ? "skip" : plan?.status === "planned" ? plan.kind : null,
    };
  }

  /** A lot's newest bids, newest first. */
  #bidHistory(lot: string): AuctionView["history"] {
    return this.#d.store
      .bids(lot)
      .filter((b) => b.status !== "pending" && b.status !== "void")
      .reverse()
      .slice(0, 10)
      .map((b) => ({ amount: b.amount, name: b.name, at: b.created_at }));
  }

  // ---- pictures (best-effort, never part of a money step) ---------------------------------

  /** The auction's picture for `view` (its `mine` included); `null` without a lot or a picture. */
  async auctionPicture(view: AuctionView): Promise<PictureFile | null> {
    if (view.lot === null) return null;
    return drawPicture(
      this.#d.pictures?.(),
      "auction",
      auctionPictureData(view.lot, view, this.#c()),
    );
  }

  /** The lottery week's picture for `view` (its `mine` included); `null` without a picture. */
  lotteryPicture(view: LotteryView): Promise<PictureFile | null> {
    return drawPicture(this.#d.pictures?.(), "lottery", lotteryPictureData(view, this.#c()));
  }

  /**
   * Posts a notice with its picture above it; when the post with the picture does not go (the
   * channel takes no files, say), the text card alone. The message id, or `null`.
   */
  async #postNotice(
    channel: string,
    reply: CommandReplyLike,
    picture: PictureFile | null,
  ): Promise<string | null> {
    if (picture !== null) {
      const id = await this.#d.post(channel, withPicture(reply, picture));
      if (id !== null) return id;
    }
    return this.#d.post(channel, reply);
  }

  #lastWeek(): LotteryView["last"] {
    const w = this.#d.store
      .pastWeeks(5)
      .find((x) => x.status === "drawn" || x.status === "refunded");
    if (w === undefined) return null;
    return {
      week: w.week,
      state: w.status as "drawn" | "refunded",
      drawn_at: w.drawn_at,
      tickets: w.tickets,
      buyers: w.buyers,
      pot: w.pot,
      prize: w.prize,
      burned: w.burned,
      winner: w.winner?.name ?? null,
    };
  }

  async lotteryView(account: AccountRef | null): Promise<LotteryView> {
    const c = this.#c();
    const now = this.#now();
    const { week, drawAt } = this.#lotteryWeek(now);
    const row = this.#d.store.week(week);
    const tickets = this.#d.store.tickets(week);
    let mine: LotteryView["mine"] = null;
    if (account !== null) {
      const who = await this.#wallet()?.member(account);
      if (who) mine = { tickets: this.#d.store.ticketCount(week, who.person) };
    }
    return {
      currency: this.#currency(),
      running: this.lotteryRunning(),
      price: c.lottery_price,
      per_person: c.lottery_per_week,
      min_buyers: c.lottery_min_buyers,
      prize_share: c.lottery_prize_share,
      week,
      state: row?.status ?? "open",
      draw_at: row?.draw_at ?? toTimestamp(drawAt),
      tickets: tickets.reduce((n, t) => n + t.count, 0),
      buyers: new Set(tickets.map((t) => t.person)).size,
      pot: tickets.reduce((n, t) => n + t.amount, 0),
      mine,
      last: this.#lastWeek(),
    };
  }

  /** The lots `account` bid on, newest first. */
  async myBids(account: AccountRef, limit = 10): Promise<MyBid[]> {
    const who = await this.#wallet()?.member(account);
    if (!who) return [];
    const out: MyBid[] = [];
    const lots = [
      ...this.#d.store.lotsIn(["open", "closing", "naming"]).reverse(),
      ...this.#d.store.history(HISTORY),
    ];
    const seen = new Set<string>();
    for (const lot of lots) {
      if (seen.has(lot.id) || lot.kind === null) continue;
      seen.add(lot.id);
      const own = this.#d.store
        .bids(lot.id)
        .filter((b) => b.person === who.person && b.status !== "pending" && b.status !== "void");
      if (own.length === 0) continue;
      const best = own.reduce((a, b) => (b.amount > a.amount ? b : a));
      const won = own.some((b) => b.status === "won") || own.some((b) => b.id === lot.winner_bid);
      const state: MyBid["state"] =
        lot.status === "cancelled"
          ? "cancelled"
          : lot.status === "open"
            ? own.some((b) => b.status === "leading")
              ? "leading"
              : "outbid"
            : won
              ? lot.status === "refunded"
                ? "refunded"
                : "won"
              : "lost";
      out.push({
        lot: lot.id,
        week: lot.week,
        kind: lot.kind,
        name: LOT_TITLE[lot.kind].name,
        amount: best.amount,
        state,
        at: best.created_at,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The weeks `account` bought tickets in, newest first. */
  async myTickets(account: AccountRef, limit = 10): Promise<MyTickets[]> {
    const who = await this.#wallet()?.member(account);
    if (!who) return [];
    const { week: current, drawAt } = this.#lotteryWeek(this.#now());
    const weeks = [this.#d.store.week(current), ...this.#d.store.pastWeeks(HISTORY)].filter(
      (w): w is LotteryWeek => w !== null,
    );
    const out: MyTickets[] = [];
    const seen = new Set<number>();
    for (const w of weeks) {
      if (seen.has(w.week)) continue;
      seen.add(w.week);
      const own = this.#d.store
        .tickets(w.week, ["paid", "refunded"])
        .filter((t) => t.person === who.person);
      if (own.length === 0) continue;
      const won = w.winner?.person === who.person && w.status === "drawn";
      out.push({
        week: w.week,
        draw_at: w.week === current ? toTimestamp(drawAt) : w.draw_at,
        tickets: own.reduce((n, t) => n + t.count, 0),
        paid: own.filter((t) => t.status === "paid").reduce((n, t) => n + t.amount, 0),
        state: w.status,
        won,
        prize: won ? w.prize : 0,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- the owner ----------------------------------------------------------------------------

  /**
   * Sets the coming week's lot (`kind`) or skips it. The coming week is the one whose lot has not
   * opened yet: this week's while it has not, else the next. A refusal when it has already opened,
   * or for a kind `auction_lots` does not offer.
   */
  plan(
    choice: LotKind | "skip",
    note: string | null = null,
  ): Promise<
    { ok: true; week: number; opens_at: Timestamp; plan: LotKind | "skip" } | MarketRefusal
  > {
    if (choice !== "skip" && !this.#c().auction_lots.includes(choice)) {
      return Promise.resolve(
        refuse(409, `「${LOT_TITLE[choice].name}」現在沒有開放拍賣(auction_lots 裡沒有它)`),
      );
    }
    return this.#turns.run(async () => {
      const now = this.#now();
      const slot = this.#slot(now);
      const current = this.#d.store.lotOfWeek(slot.week);
      const thisWeek =
        now < slot.ends && (current === null || ["planned", "skipped"].includes(current.status));
      const opens = thisWeek ? slot.opens : slot.opens + 7 * DAY_MS;
      const week = localDay(opens, this.#offset());
      const ends = opens + this.#c().auction_hours * HOUR_MS;
      const put = this.#d.store.putLot({
        id: newId(),
        week,
        kind: choice === "skip" ? null : choice,
        status: choice === "skip" ? "skipped" : "planned",
        picked_by: "owner",
        opens_at: opens,
        ends_at: ends,
        channel: null,
        note,
        now,
      });
      if (put === null) return refuse(409, "這週的拍賣已經開始了");
      return { ok: true as const, week, opens_at: toTimestamp(opens), plan: choice };
    });
  }

  /**
   * Settles now: `auction` ends the open lot at once (and settles it), `lottery` draws the week
   * being sold. What was done, or a refusal when there is nothing to settle.
   */
  async settleNow(what: "auction" | "lottery"): Promise<{ ok: true } | MarketRefusal> {
    const now = this.#now();
    const done = await this.#turns.run(async () => {
      if (what === "auction") {
        const lot = this.#d.store.lotsIn(["open"])[0];
        if (lot === undefined) return false;
        return this.#d.store.setLot(lot.id, ["open"], { ends_at: toTimestamp(now) });
      }
      const { week } = this.#lotteryWeek(now);
      if (this.#d.store.week(week)?.status !== "open") return false;
      // Drawn by the next pass as if its time had come.
      this.#early.add(week);
      return true;
    });
    if (!done) return refuse(409, what === "auction" ? "現在沒有在拍賣" : "這週的樂透沒有在賣");
    await this.tick();
    return { ok: true };
  }

  /** Weeks the owner asked to draw now, before their time. */
  readonly #early = new Set<number>();

  history(): MarketHistory {
    const lots = this.#d.store
      .history(HISTORY)
      .map((l) => {
        const v = this.#lotView(l);
        return v === null ? null : { ...v, note: l.note, price: l.price };
      })
      .filter((v): v is LotView & { note: string | null; price: number | null } => v !== null);
    const weeks = this.#d.store
      .pastWeeks(HISTORY)
      .filter((w) => w.status === "drawn" || w.status === "refunded")
      .map((w) => ({
        week: w.week,
        state: w.status as "drawn" | "refunded",
        drawn_at: w.drawn_at,
        tickets: w.tickets,
        buyers: w.buyers,
        pot: w.pot,
        prize: w.prize,
        burned: w.burned,
        winner: w.winner?.name ?? null,
      }));
    return { lots, weeks, offered: [...this.#c().auction_lots], next: this.#next() };
  }

  // ---- the pass -----------------------------------------------------------------------------

  /** Everything that is due now: the lottery's draw and notices, the auction's lots and holds. */
  tick(signal?: AbortSignal): Promise<void> {
    return this.#turns.run(async () => {
      const trades = this.#d.trades !== false;
      const songs = this.#d.songs !== false;
      for (const [name, step] of [
        ...(trades
          ? ([
              ["lottery", () => this.#lotteryPass(signal)],
              ["auction", () => this.#auctionPass(signal)],
            ] as const)
          : []),
        ...(songs ? ([["song tickets", () => this.#songTicketPass(signal)]] as const) : []),
      ]) {
        try {
          await step();
        } catch (error) {
          this.#d.log.warn(
            { err: errorMessage(error), step: name },
            "market: a pass failed; the next one tries again",
          );
        }
      }
    });
  }

  // ---- the lottery's pass -------------------------------------------------------------------

  async #lotteryPass(signal?: AbortSignal): Promise<void> {
    const store = this.#d.store;
    const now = this.#now();
    // A purchase that stopped between its row and its charge: paid if the charge stands.
    for (const t of store.staleTickets(now - STALE_MS)) await this.#settleTicket(t);
    if (!this.lotteryRunning()) {
      // Turned off: the weeks not drawn give every ticket back.
      for (const w of store.weeksIn(["open"])) {
        store.setWeek(w.week, ["open"], { status: "refunding" });
      }
    }
    for (const w of store.weeksIn(["open", "drawing", "refunding"])) {
      if (signal?.aborted) return;
      const due = Date.parse(w.draw_at) <= now || this.#early.has(w.week);
      if (w.status === "open" && !due) continue;
      await this.#draw(w);
    }
    for (const w of store.weeksIn(["drawn", "refunded"])) {
      if (w.announced_at === null) await this.#announceDraw(w);
    }
    if (this.lotteryRunning()) await this.#weekNotice(now);
  }

  /**
   * A purchase left `pending`: paid when its charge stands, else forgotten. When its week was
   * already settled without it (drawn, or being refunded), it was in no draw: its coins go back.
   */
  async #settleTicket(t: Ticket): Promise<void> {
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    if (!(await wallet.charged(t.account, MARKET_REASONS.lotteryTicket, t.id))) {
      this.#d.store.dropTicket(t.id);
      return;
    }
    if ((this.#d.store.week(t.week)?.status ?? "open") === "open") {
      this.#d.store.setTicket(t.id, "paid", this.#now());
      return;
    }
    await wallet.refund(t.account, MARKET_REASONS.lotteryTicket, t.id);
    this.#d.store.setTicket(t.id, "refunded", this.#now());
  }

  async #draw(w: LotteryWeek): Promise<void> {
    const c = this.#c();
    const store = this.#d.store;
    const wallet = this.#wallet();
    if (wallet === null) throw new Unsettled("no wallet");
    const now = this.#now();
    if (w.status === "open") {
      for (const t of store.tickets(w.week, ["pending"])) await this.#settleTicket(t);
      const paid = store.tickets(w.week);
      const tickets = paid.reduce((n, t) => n + t.count, 0);
      const pot = paid.reduce((n, t) => n + t.amount, 0);
      const buyers = new Set(paid.map((t) => t.person)).size;
      if (buyers < c.lottery_min_buyers || !this.lotteryRunning()) {
        store.setWeek(w.week, ["open"], { status: "refunding", tickets, buyers, pot });
      } else {
        const pick = (this.#d.randomInt ?? randomInt)(tickets);
        let left = pick;
        let winner = paid[0] as Ticket;
        for (const t of paid) {
          if (left < t.count) {
            winner = t;
            break;
          }
          left -= t.count;
        }
        const prize = Math.floor(pot * c.lottery_prize_share);
        store.setWeek(w.week, ["open"], {
          status: "drawing",
          tickets,
          buyers,
          pot,
          prize,
          burned: pot - prize,
          pick,
          winner_person: winner.person,
          winner_platform: winner.account.platform,
          winner_account_id: winner.account.id,
          winner_name: winner.name,
          winner_tickets: paid
            .filter((t) => t.person === winner.person)
            .reduce((n, t) => n + t.count, 0),
        });
      }
      this.#early.delete(w.week);
      w = store.week(w.week) as LotteryWeek;
    }
    if (w.status === "refunding") {
      // A purchase that stopped half way (turned off before it was settled) goes back too.
      for (const t of store.tickets(w.week, ["pending"])) await this.#settleTicket(t);
      for (const t of store.tickets(w.week)) {
        await wallet.refund(t.account, MARKET_REASONS.lotteryTicket, t.id);
        store.setTicket(t.id, "refunded", now);
      }
      store.finishWeek(
        w.week,
        "refunding",
        { status: "refunded", drawn_at: toTimestamp(now) },
        {
          week: w.week,
          tickets: w.tickets,
          buyers: w.buyers,
          pot: w.pot,
          prize: 0,
          burned: 0,
          winner: null,
          refunded: true,
        },
      );
      return;
    }
    if (w.status === "drawing" && w.winner !== null) {
      if (
        w.prize > 0 &&
        !(await wallet.pay(w.winner.account, w.prize, `lottery:${w.week}`, `week:${w.week}`))
      ) {
        throw new Unsettled("the prize was not paid");
      }
      store.finishWeek(
        w.week,
        "drawing",
        { status: "drawn", drawn_at: toTimestamp(now), paid_at: toTimestamp(now) },
        {
          week: w.week,
          tickets: w.tickets,
          buyers: w.buyers,
          pot: w.pot,
          prize: w.prize,
          burned: w.burned,
          winner: w.winner.person,
          refunded: false,
        },
      );
    }
  }

  /** The draw's notice in the channel and her note, once. */
  async #announceDraw(w: LotteryWeek): Promise<void> {
    const channel = lotteryChannel(this.#c());
    if (channel !== "") {
      const currency = this.#currency();
      const picture = await drawPicture(
        this.#d.pictures?.(),
        "lottery",
        drawPictureData(w, this.#c(), currency),
      );
      await this.#postNotice(channel, lotteryResultNotice(w, this.#c(), currency), picture);
    }
    this.#d.tell(
      lotteryNote(w, this.#currency()),
      `market:lottery:${w.week}`,
      w.winner?.person ?? null,
    );
    this.#d.store.setWeek(w.week, [w.status], { announced_at: toTimestamp(this.#now()) });
  }

  /** The week's notice with its buy buttons, once a week, when there is a channel. */
  async #weekNotice(now: number): Promise<void> {
    const channel = lotteryChannel(this.#c());
    if (channel === "") return;
    const { week, drawAt } = this.#lotteryWeek(now);
    const row = this.#d.store.ensureWeek(week, drawAt);
    if (row.status !== "open" || row.notice_at !== null) return;
    // Marked first: a notice that failed is not posted again and again.
    this.#d.store.setWeek(week, ["open"], { notice_at: toTimestamp(now) });
    const view = await this.lotteryViewUnlocked();
    const id = await this.#postNotice(
      channel,
      lotteryNotice(view, this.#c()),
      await this.lotteryPicture(view),
    );
    if (id !== null) this.#d.store.setWeek(week, ["open"], { notice_message: id });
  }

  /** `lotteryView(null)` for the pass (it already runs in turn). */
  lotteryViewUnlocked(): Promise<LotteryView> {
    return this.lotteryView(null);
  }

  // ---- the auction's pass -------------------------------------------------------------------

  async #auctionPass(signal?: AbortSignal): Promise<void> {
    const store = this.#d.store;
    const now = this.#now();
    // A bid that stopped between its row and its hold: what was held goes back.
    for (const b of store.stalePending(now - STALE_MS)) {
      const wallet = this.#wallet();
      if (wallet === null) throw new Unsettled("no wallet");
      if (b.hold > 0) await wallet.release(b.account, b.id);
      store.setBid(b.id, { status: "void", released_at: now });
    }
    for (const b of store.unreleased()) await this.#release(b);
    if (!this.auctionRunning()) {
      // Off, or no channel: an open lot is called off and a name not given yet is refunded (a
      // name she took is finished below).
      for (const lot of store.lotsIn(["open"])) await this.#refundLot(lot, ["open"], "cancelled");
      for (const lot of store.lotsIn(["naming"])) {
        if (lot.call_name === null) await this.#refundLot(lot, ["naming"]);
      }
    } else {
      await this.#open(now, signal);
    }
    for (const lot of store.lotsIn(["open"])) {
      if (Date.parse(lot.ends_at) <= now) await this.#close(lot, now);
    }
    for (const lot of store.lotsIn(["closing"])) await this.#settle(lot, now);
    for (const lot of store.lotsIn(["naming"])) {
      // A name she took when the Core stopped half way through applying it.
      if (lot.call_name !== null) {
        await this.#applyName(lot);
        continue;
      }
      if (lot.name_due !== null && Date.parse(lot.name_due) <= now) {
        await this.#refundLot(lot, ["naming"]);
        this.#d.log.info({ lot: lot.id }, "market: no name was given in time; refunded");
      }
    }
    for (const lot of store.lotsIn(["applied"])) {
      if (lot.applied_until !== null && Date.parse(lot.applied_until) <= now) this.#restore(lot);
    }
  }

  /** Opens this week's lot when it is time and it is not there. */
  async #open(now: number, signal?: AbortSignal): Promise<void> {
    const c = this.#c();
    const slot = this.#slot(now);
    if (now >= slot.ends) return;
    const found = this.#d.store.lotOfWeek(slot.week);
    if (found !== null && found.status !== "planned") return;
    let kind: LotKind;
    let picked: "owner" | "her" | "rotation";
    let note: string | null = found?.note ?? null;
    if (found?.kind != null && c.auction_lots.includes(found.kind)) {
      kind = found.kind;
      picked = "owner";
    } else {
      const pick = await this.#pick(slot.week, signal);
      kind = pick.kind;
      picked = pick.by;
      note = pick.why;
    }
    const lot = this.#d.store.putLot({
      id: newId(),
      week: slot.week,
      kind,
      status: "open",
      picked_by: picked,
      opens_at: slot.opens,
      ends_at: slot.ends,
      channel: c.auction_channel,
      note,
      now,
    });
    if (lot === null) return;
    this.#d.log.info({ lot: lot.id, kind, picked }, "market: a lot opened");
    const view = this.#lotView(lot);
    if (view === null) return;
    const currency = this.#currency();
    const picture = await drawPicture(
      this.#d.pictures?.(),
      "auction",
      auctionPictureData(view, { currency, mine: null, history: [] }, c),
    );
    const id = await this.#postNotice(
      c.auction_channel,
      auctionNotice(view, currency, null, c),
      picture,
    );
    if (id !== null) this.#d.store.setLot(lot.id, ["open"], { message_id: id });
  }

  async #pick(
    week: number,
    signal?: AbortSignal,
  ): Promise<{ kind: LotKind; by: "her" | "rotation"; why: string | null }> {
    const kinds = this.#c().auction_lots;
    if (this.#d.picker !== null && kinds.length > 1) {
      try {
        const pick = await this.#d.picker.pick(kinds, this.#d.store.recentKinds(4), signal);
        return { kind: pick.kind, by: "her", why: pick.why };
      } catch (error) {
        this.#d.log.info(
          { err: errorMessage(error) },
          "market: she could not pick; the rotation does",
        );
      }
    }
    return { kind: rotationKind(kinds, week), by: "rotation", why: null };
  }

  async #close(lot: Lot, now: number): Promise<void> {
    if (lot.kind === null) return;
    const bids = this.#d.store
      .bids(lot.id)
      .filter((b) => b.status !== "pending" && b.status !== "void");
    const leading = bids.filter((b) => b.status === "leading");
    const top =
      leading.length === 0 ? null : leading.reduce((a, b) => (b.amount > a.amount ? b : a));
    this.#d.store.closeLot(lot.id, now, {
      lot: lot.id,
      week: lot.week,
      kind: lot.kind,
      winner_bid: top?.id ?? null,
      winner: top?.person ?? null,
      price: top?.amount ?? null,
      bids: bids.length,
      bidders: new Set(bids.map((b) => b.person)).size,
      extended: lot.extended,
    });
    if (top === null) {
      const closed = this.#d.store.lot(lot.id) as Lot;
      await this.#announceLot(closed);
    }
  }

  /** A closed lot with a winner: a frame is theirs now; a name waits for them. */
  async #settle(lot: Lot, now: number): Promise<void> {
    if (lot.kind === "frame") {
      await this.#settleWin(lot, `frame:${lot.id}`);
      this.#d.store.setLot(lot.id, ["closing"], { status: "done", settled_at: toTimestamp(now) });
    } else {
      const due = now + this.#c().auction_name_hours * HOUR_MS;
      this.#d.store.setLot(lot.id, ["closing"], { status: "naming", name_due: toTimestamp(due) });
    }
    await this.#announceLot(this.#d.store.lot(lot.id) as Lot);
  }

  /** The result in the channel and her note. */
  async #announceLot(lot: Lot): Promise<void> {
    const view = this.#lotView(lot);
    if (view === null) return;
    const channel = lot.channel ?? this.#c().auction_channel;
    if (channel !== "") {
      const currency = this.#currency();
      const picture = await drawPicture(
        this.#d.pictures?.(),
        "auction",
        auctionPictureData(
          view,
          { currency, mine: null, history: this.#bidHistory(lot.id) },
          this.#c(),
        ),
      );
      await this.#postNotice(channel, lotResultNotice(view, currency), picture);
    }
    const winner = lot.winner_bid === null ? null : this.#d.store.bid(lot.winner_bid);
    this.#d.tell(
      auctionClosedNote(view, this.#currency()),
      `market:lot:${lot.id}`,
      winner?.person ?? null,
    );
  }

  /** A name's week is over: the old name is back, unless they changed it themselves since. */
  #restore(lot: Lot): void {
    const names = this.#d.names;
    const winner = lot.winner_bid === null ? null : this.#d.store.bid(lot.winner_bid);
    if (names !== null && winner !== null && names.get(winner.person) === lot.call_name) {
      names.set(winner.person, lot.previous_call_name);
    }
    this.#d.store.setLot(lot.id, ["applied"], { status: "done" });
  }
}
