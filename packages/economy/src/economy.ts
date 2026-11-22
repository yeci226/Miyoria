// The wallet (docs/design/economy.md): earning, spending, and what a gift does to her.
//
// * The ledger is the store's (`CoinLedgerStore`): rows are appended in one transaction with
//   their checks, the balance is a sum, a refund is a row. Caps are sums of today's rows.
// * A wallet is every account of the person she knows them as. Someone she does not know, or
//   has blocked, has a stranger's wallet: empty, earning nothing, every spend refused alike.
// * A gift lowers her hunger by what she ate and is the `gift` social event toward the giver,
//   weaker for each earlier gift of the same person today. A paid gift also raises
//   affinity and trust by a hair through the social engine (`RelationshipEffects`), within its own
//   daily cap. She learns of it as a silent Observation, read when she next thinks (never a
//   reason to break into a song).
// * Spends of this process take turns, so two clicks cannot both pass a check meant for one.

import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import {
  errorMessage,
  type Logger,
  SerialQueue,
  type ServiceLookup,
} from "@miyoria/runtime/kernel";
import { SingerKey } from "@miyoria/sing";
import { AuditLogKey, PeopleStoreKey, type Person } from "@miyoria/store";
import {
  type AccountRef,
  type AnyEventDefinition,
  AuthorizerKey,
  accountRefString,
  CARD_REASONS,
  type Clock,
  type ContextKey,
  EventLogKey,
  type EventPayload,
  Events,
  EXCHANGE_REASONS,
  HandleDirectoryKey,
  type HeartEvidenceInput,
  HeartKey,
  holdsBack,
  inspectInput,
  type JsonValue,
  KARAOKE_REASONS,
  MARKET_REASONS,
  ModerationKey,
  newId,
  type PersonId,
  type Places,
  PlacesKey,
  Principals,
  type ProfileId,
  type Publish,
  type PublishMetaArgs,
  RelationshipEffectsKey,
  SelfStateKey,
  SocialSignalsKey,
  safeName,
  sameAccount,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { setBoard, sponsorBoard } from "./board.js";
import { BountyBoard } from "./bounties.js";
import type { EconomyConfig } from "./config.js";
import { DanmakuDesk } from "./danmaku.js";
import { type EconomyDocStore, EconomyDocsKey, MemoryDocs } from "./docs.js";
import { GIFT_REASON, giftHunger, giftLabel } from "./gift-words.js";
import { Purse } from "./purse.js";
import {
  type CoinCap,
  type CoinEntry,
  type CoinLedgerStore,
  CoinLedgerStoreKey,
  type CoinRule,
} from "./records.js";
import { MAX_SCREEN_CHARS, screenEvent, screenText, screenWait, waitMinutes } from "./screen.js";
import { spacesToShow } from "./spaces.js";
import { otherName, sendCoins } from "./transfer.js";
import {
  type AdjustResult,
  type BoardLine,
  type BountyView,
  type CheckinResult,
  DANMAKU_REASON,
  DANMAKU_REFUND_REASON,
  type DanmakuView,
  type EarnLine,
  type EarnReason,
  type Economy,
  EconomyError,
  FEED_ITEMS,
  type FeedItem,
  type FeedResult,
  type FramesResult,
  type GiftEvent,
  type GiftItem,
  type Hunger,
  type LedgerLine,
  MAX_ADJUST,
  MAX_ADJUST_NOTE_CHARS,
  PAID_ITEMS,
  type PaidItem,
  type Purchase,
  type ShopItem,
  type SpendResult,
  type TransferResult,
  type WalletExport,
  type WalletView,
} from "./types.js";
import { labelV2, V2 } from "./v2.js";
import type { AchievementUnlocked } from "./v2-types.js";

export const STRANGER = "她還不認識你,先和她說說話吧";
/** Permission node of a wallet (`me.*`): a role without it, like `blocked`, has a stranger's. */
export const WALLET_NODE = "me.wallet";
export const ALREADY_CHECKED_IN = "今天已經簽到過了";
/** A feed refused because this person fed her their share of the day (nothing charged). */
export const FULL = "你今天餵得夠多了,她吃不下";
/** A feed refused because her hunger cannot be read. */
export const CANNOT_FEED = "現在沒辦法餵她";

const DAY_MS = 86_400_000;
/** Below this much of a share left, it is spent (floats of 0.15 steps never land exactly). */
const FEED_EPSILON = 1e-9;
const VOICE_WINDOW_MS = 10 * 60_000;
/** Feeds per request at most. */
export const MAX_FEED_COUNT = 5;
/** How long the big bowl's face shows. */
export const BIG_BOWL_SECONDS = 5;
const RECENT_LINES = 20;
const MAX_EXPORTED = 10_000;
/** Today's rows read for caps and gifts; a day of one person is far less. */
const MAX_DAY_ROWS = 2_000;
/** Check-ins read for the streak: more than a year. */
const MAX_CHECKINS = 400;
/** Kept in her working context: the latest gifts. */
const MAX_CONTEXT_ENTRIES = 8;

/** How much hunger one of each takes away. */
export const HUNGER_OF: Readonly<Record<FeedItem, number>> = {
  rice: 0.15,
  big_bowl: 0.5,
  dessert: 0.05,
};

const FEED_NAME: Readonly<Record<FeedItem, [string, string]>> = {
  rice: ["一碗白飯", "碗白飯"],
  big_bowl: ["一大碗白飯", "大碗白飯"],
  dessert: ["一份甜點", "份甜點"],
};

const EARN_LABEL: Readonly<Record<EarnReason, string>> = {
  checkin: "每日簽到",
  talked: "和她說話",
  voice: "在語音陪她",
  song: "點的歌她唱完了",
  her_gift: "她送你的",
};

/** The `[modules.economy]` key of each paid thing's daily limit. */
const PER_DAY = {
  card_foil: "card_foils_per_day",
  screen_message: "screen_messages_per_day",
  fortune: "fortunes_per_day",
} as const satisfies Record<PaidItem, keyof EconomyConfig>;

/** How a paid thing reads in the shop and the ledger, and its shop kind. */
export const PAID_NAME: Readonly<Record<PaidItem, { label: string; kind: ShopItem["kind"] }>> = {
  card_foil: { label: "閃卡加工", kind: "card" },
  screen_message: { label: "留言上大螢幕", kind: "stream" },
  fortune: { label: "今日籤詩", kind: "fortune" },
};

/** What ledger rows of things that are not sold any more say (old rows stay in statements). */
const RETIRED_LABEL: Readonly<Record<string, string>> = {
  letter: "寫信給她",
  expression: "送她表情",
  deal_escrow: "先付給她的約定",
  commission: "委託她",
  commission_pay: "委託做完了",
  shop: "她的小店",
  shop_pay: "小店的收入",
  goal_pledge: "投給她的目標",
  song_ticket: "點歌加點券",
  dedication: "歌曲獻詞",
  card_reroll: "重抽卡片",
  card_pose: "指定立繪",
  draw: "抽收藏",
};

/** What the weekly market's rows say (docs/design/v5-play.md §11.4). */
const MARKET_LABEL: Readonly<Record<string, string>> = {
  [MARKET_REASONS.songPriority]: "點歌優先券",
  [MARKET_REASONS.songPriorityRefund]: "點歌優先券退回",
  [MARKET_REASONS.lotteryTicket]: "每週樂透彩券",
  [MARKET_REASONS.lotteryRefund]: "每週樂透退回",
  [MARKET_REASONS.lotteryPrize]: "每週樂透中獎",
  [MARKET_REASONS.auctionHold]: "拍賣出價(押著)",
  [MARKET_REASONS.auctionRelease]: "拍賣出價退回",
};

/** What the deep-sea exchange's rows say (docs/design/exchange.md). */
const EXCHANGE_LABEL: Readonly<Record<string, string>> = {
  [EXCHANGE_REASONS.in]: "交易所:買進",
  [EXCHANGE_REASONS.out]: "交易所:賣出或退回",
  [EXCHANGE_REASONS.fee]: "交易所:手續費和稅(燒掉)",
  [EXCHANGE_REASONS.feeBack]: "交易所:沒成交,手續費退回",
  [EXCHANGE_REASONS.burn]: "交易所:買進(真實行情)",
  [EXCHANGE_REASONS.burnBack]: "交易所:沒成交,退回",
  [EXCHANGE_REASONS.mint]: "交易所:賣出(真實行情)",
  [EXCHANGE_REASONS.loss]: "交易所:槓桿賠超過保證金的部分",
};

/** What karaoke rooms' rows say (docs/design/karaoke.md 「做了什麼第四步」). */
const KARAOKE_LABEL: Readonly<Record<string, string>> = {
  [KARAOKE_REASONS.room]: "開唱 K 房間",
  [KARAOKE_REASONS.roomRefund]: "唱 K 房間退費",
  [KARAOKE_REASONS.prize]: "唱 K 第一名",
  [KARAOKE_REASONS.finish]: "唱 K 唱完一首",
};

/** A won lot's ref: `<lot kind>:<lot id>`. */
const WON_LOT: Readonly<Record<string, string>> = {
  call_name: "這一週她怎麼叫你",
  frame: "只此一件的卡框",
};

/** `拍賣得標:只此一件的卡框`, from an `auction_won` row's ref. */
export function marketWonLabel(ref: string | null): string {
  const what = WON_LOT[(ref ?? "").split(":")[0] ?? ""];
  return what === undefined ? "拍賣得標" : `拍賣得標:${what}`;
}

/** The one-of-a-kind frame a won `frame` lot gives: `one-<lot id>` (`auction_won` ref `frame:<lot id>`). */
export function uniqueFrameOf(entry: Pick<CoinEntry, "reason" | "ref">): string | null {
  if (entry.reason !== MARKET_REASONS.auctionWon) return null;
  const [kind, lot] = (entry.ref ?? "").split(":");
  return kind === "frame" && lot ? `one-${lot}` : null;
}

/** Ledger reasons that are gifts to her (they diminish each other). */
const GIFT_REASONS = ["feed"];
const EARN_REASONS: readonly EarnReason[] = ["checkin", "talked", "voice", "song", "her_gift"];

/** `一碗白飯`, `3 碗白飯`. */
export function feedLabel(item: FeedItem, count: number): string {
  const [one, unit] = FEED_NAME[item];
  return count === 1 ? one : `${count} ${unit}`;
}

/**
 * Her hunger in words: a number on a page is something to farm. Never "full": that is what a
 * person who fed her their share of the day sees (`feedLeft`).
 */
export function hungerWord(hunger: number): Hunger {
  if (hunger < 0.4) return "ok";
  if (hunger < 0.7) return "hungry";
  return "starving";
}

/** What one `feed` row took off her hunger (`rice:2` is two bowls). */
export function hungerOf(entry: CoinEntry): number {
  const { item, eaten } = fedOf(entry);
  return item === null ? 0 : HUNGER_OF[item] * eaten;
}

/** The local day number of `ms`. */
export function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms + offsetMinutes * 60_000) / DAY_MS);
}

/** Consecutive days of `days` ending today, or yesterday when today is not in it yet. */
export function streakOf(days: ReadonlySet<number>, today: number): number {
  let day = days.has(today) ? today : today - 1;
  let n = 0;
  while (days.has(day)) {
    n += 1;
    day -= 1;
  }
  return n;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A display name for the overlay: one line, at most 32 characters. */
/**
 * Something that happened between her and someone, for her nightly reflection on them
 * (`HeartKey.evidence`); nothing when the heart does not run. Never throws.
 */
export function heartEvidence(
  services: ServiceLookup,
  log: Pick<Logger, "warn">,
  input: HeartEvidenceInput,
): void {
  try {
    services.get(HeartKey)?.evidence?.(input);
  } catch (error) {
    log.warn({ err: errorMessage(error), kind: input.kind }, "cannot record evidence");
  }
}

/** A display name for the overlay: one line, at most 32 characters (`有人` when nothing is left). */
export function plainName(name: string): string {
  const flat = name.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const cut = [...flat].slice(0, 32).join("");
  return cut === "" ? "有人" : cut;
}

/** What a `feed` row says she ate (`rice:2`). */
export function fedOf(entry: CoinEntry): { item: FeedItem | null; eaten: number } {
  const [item = "", n] = (entry.ref ?? "").split(":");
  const eaten = Number(n);
  return {
    item: (FEED_ITEMS as readonly string[]).includes(item) ? (item as FeedItem) : null,
    eaten: Number.isInteger(eaten) && eaten > 0 ? eaten : 1,
  };
}

/** A spend that went through; `fresh` when this call wrote it, not a repeat of its key. */
export interface Spent {
  entry: CoinEntry;
  balance: number;
  fresh: boolean;
}

/** Someone she knows, with their wallet. */
export interface Member {
  account: AccountRef;
  person: Person;
  /** Their wallet in the ledger: the person (`records.ts`). */
  wallet: PersonId;
  /** Every account of the person, `account` included. */
  accounts: AccountRef[];
  /** The display name of `account` (untrusted). */
  name: string;
}

/**
 * `account` as a member of `person` (the person identity resolved it to): the wallet is the
 * person, the accounts every account of theirs.
 */
export function memberOf(account: AccountRef, person: Person): Member {
  const accounts = person.accounts.map((a) => a.account);
  if (!accounts.some((a) => sameAccount(a, account))) accounts.push(account);
  const own = person.accounts.find((a) => sameAccount(a.account, account));
  return {
    account,
    person,
    wallet: person.id,
    accounts,
    name: own?.display_name ?? person.display_name,
  };
}

export interface EconomyDeps {
  config: EconomyConfig;
  services: ServiceLookup;
  profile: ProfileId;
  clock: Clock;
  publish: Publish;
  log: Logger;
  /** A number in [0, 1) for draws; `Math.random` unless a test pins it. */
  random?: () => number;
}

export class EconomyService implements Economy {
  readonly #d: EconomyDeps;
  readonly #turns = new SerialQueue();
  /** Her own coins (purse.ts) and her bounties (bounties.ts). */
  readonly purse: Purse;
  readonly bountyDesk: BountyBoard;
  /** Danmaku on the stream overlay (danmaku.ts, docs/design/v5-play.md §11.6). */
  readonly danmakuDesk: DanmakuDesk;
  /** Economy 2.0 (docs/design/v4-plan.md §10): play, quests, predictions, her room, ... */
  readonly v2: V2;
  /** Used when no store provides `EconomyDocsKey` (what is kept there is gone on restart). */
  #fallbackDocs: MemoryDocs | null = null;

  constructor(deps: EconomyDeps) {
    this.#d = deps;
    this.purse = new Purse(this);
    this.bountyDesk = new BountyBoard(this);
    this.danmakuDesk = new DanmakuDesk(this);
    this.v2 = new V2(this);
  }

  // ---- what economy 2.0 uses ---------------------------------------------------------------

  /** Whether the documents (bets, room) outlive a restart. */
  get docsAreDurable(): boolean {
    return this.#d.services.get(EconomyDocsKey) !== undefined;
  }

  /** The document store: the real one, else an in-memory one. */
  docs(): EconomyDocStore {
    const real = this.#d.services.get(EconomyDocsKey);
    if (real) return real;
    this.#fallbackDocs ??= new MemoryDocs();
    return this.#fallbackDocs;
  }

  random(): number {
    return (this.#d.random ?? Math.random)();
  }

  /** The local day number of now. */
  today(): number {
    return this.#today();
  }

  /** Where the local day `day` starts. */
  dayStart(day: number): Timestamp {
    return this.#dayStart(day);
  }

  /** A ledger row for `who` (not posted). */
  entryFor(
    who: Member,
    delta: number,
    reason: string,
    ref: string | null,
    key: string | null,
  ): CoinEntry {
    return this.#entry(who, delta, reason, ref, key);
  }

  /** Someone she knows, blocked or not (what is owed to them is still theirs). */
  holder(account: AccountRef): Promise<Member> {
    return this.#holder(account);
  }

  /**
   * Coins earned for taking part in something, within a daily cap summed over `cap.reasons`. Run it
   * inside `serial` together with whatever count it depends on. `capped` posts nothing.
   */
  async faucet(
    who: Member,
    reason: string,
    amount: number,
    key: string,
    ref: string | null,
    cap: { reasons: readonly string[]; limit: number },
    partial: boolean,
  ): Promise<{ status: "paid" | "duplicate" | "capped"; entry: CoinEntry | null; paid: number }> {
    if (amount <= 0) return { status: "capped", entry: null, paid: 0 };
    const caps: CoinCap[] = [
      {
        wallet: who.wallet,
        reasons: cap.reasons,
        since: this.#dayStart(this.#today()),
        limit: cap.limit,
      },
    ];
    const post = await this.#ledger().post(this.#entry(who, amount, reason, ref, key), {
      caps,
      partial,
    });
    if (post.status === "posted")
      return { status: "paid", entry: post.entry, paid: post.entry.delta };
    if (post.status === "duplicate") return { status: "duplicate", entry: post.entry, paid: 0 };
    return { status: "capped", entry: null, paid: 0 };
  }

  /** The first row of this wallet under `key`, or `null`. */
  byKey(who: Member, key: string): Promise<CoinEntry | null> {
    return this.#ledger().byKey(this.#d.profile, who.wallet, key);
  }

  /** Today's rows of the wallet (what the caps count). */
  rowsToday(who: Member): Promise<CoinEntry[]> {
    return this.#todayRows(who);
  }

  get config(): EconomyConfig {
    return this.#d.config;
  }

  // ---- what the other files of the economy use -----------------------------------------------------------------

  get services(): ServiceLookup {
    return this.#d.services;
  }

  /** Identity's places (servers and their members); `undefined` without Core's identity. */
  places(): Places | undefined {
    return this.#d.services.get(PlacesKey);
  }

  /**
   * The servers a list shown in `ctx` covers (`spaces.ts`): that server, or in a DM the ones the
   * person of `account` is a member of. `undefined`: no filter.
   */
  async spacesFor(
    ctx: ContextKey | null | undefined,
    account: AccountRef | null,
  ): Promise<string[] | undefined> {
    const places = this.places();
    if (!places) return undefined;
    const who = account === null ? null : await this.member(account);
    return spacesToShow(places, ctx, who?.person.id ?? null);
  }

  get profile(): ProfileId {
    return this.#d.profile;
  }

  get log(): Logger {
    return this.#d.log;
  }

  now(): number {
    return this.#d.clock.now();
  }

  /** The start of today (the local day), as the caps count it. */
  todayStart(): Timestamp {
    return this.#dayStart(this.#today());
  }

  /** Publishes on the bus as the economy module. */
  publish<D extends AnyEventDefinition>(
    definition: D,
    data: EventPayload<D>,
    ...meta: PublishMetaArgs<D>
  ): void {
    this.#d.publish(definition, data, ...meta);
  }

  /** Runs `fn` in turn with every other spend of this process. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.#turns.run(fn);
  }

  ledger(): CoinLedgerStore {
    return this.#ledger();
  }

  /** A charge of `price` under `key` (throws `EconomyError`: 402 short, 429 capped). */
  spend(
    who: Member,
    price: number,
    reason: string,
    ref: string | null,
    key: string,
  ): Promise<Spent> {
    return this.#spend(who, price, reason, ref, key);
  }

  /** Gives back what `entry` charged, once (the refund is keyed on the row). */
  async refundOnce(who: Member, entry: CoinEntry): Promise<boolean> {
    if (await this.#refunded(who, entry)) return false;
    await this.#refund(who, entry);
    return true;
  }

  /** Whether the text passes the screen a paid message passes (moderation, input and output). */
  passes(who: Pick<Member, "account">, text: string): boolean {
    return this.#passes(who, text);
  }

  /** The stage link runs (its `stage.expression` is registered), as the screen message asks. */
  stageUp(): boolean {
    return this.#stageUp();
  }

  // ---- her bounties (§13) -------------------------------------------------------

  bounties(spaces?: readonly string[]): Promise<BountyView[]> {
    return this.bountyDesk.view(spaces);
  }

  /** Something she knows from now on, silently; `writer` is the working-context bucket. */
  tell(
    who: Member,
    source: string,
    key: string,
    summary: string,
    writer = "economy",
    max = MAX_CONTEXT_ENTRIES,
  ): boolean {
    return this.#tell(who, source, key, summary, writer, max);
  }

  handleOf(person: PersonId): string | null {
    return this.#handle(person);
  }

  record(who: Member, action: string, detail: JsonValue): void {
    this.#audit(who, action, detail);
  }

  // ---- who ------------------------------------------------------------------------------

  /**
   * The person behind `account` when she knows them and has not blocked them (the social tag,
   * her card of them, or a role without `me.wallet`), else `null`. When nothing can tell whether
   * they are blocked, they are a stranger.
   */
  async member(account: AccountRef): Promise<Member | null> {
    const s = this.#d.services;
    const people = s.get(PeopleStoreKey);
    if (!people) return null;
    const person = await people.personByAccount(account);
    if (!person) return null;
    // Whether she blocked them: their heart row (`SocialSignalsKey`, by account or by person).
    const social = s.get(SocialSignalsKey);
    const authorizer = s.get(AuthorizerKey);
    if (!social || !authorizer?.allows(account, WALLET_NODE)) return null;
    if (social.attitude(account)?.blocked || social.attitudeOf?.(person.id)?.blocked) return null;
    return memberOf(account, person);
  }

  async #known(account: AccountRef): Promise<Member> {
    const who = await this.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    return who;
  }

  // ---- time -----------------------------------------------------------------------------

  #today(): number {
    return localDay(this.#d.clock.now(), this.#d.config.utc_offset_minutes);
  }

  #dayStart(day: number): string {
    return toTimestamp(day * DAY_MS - this.#d.config.utc_offset_minutes * 60_000);
  }

  // ---- the ledger -----------------------------------------------------------------------

  #ledger(): CoinLedgerStore {
    const store = this.#d.services.get(CoinLedgerStoreKey);
    if (!store) throw new EconomyError(503, "錢包現在打不開");
    return store;
  }

  #entry(
    who: Member,
    delta: number,
    reason: string,
    ref: string | null,
    key: string | null,
  ): CoinEntry {
    return {
      id: newId(),
      person: who.wallet,
      delta,
      reason,
      ref,
      idem_key: key,
      ts: toTimestamp(this.#d.clock.now()),
    };
  }

  async #balance(who: Member): Promise<number> {
    return this.#ledger().balance(this.#d.profile, who.wallet);
  }

  async #todayRows(who: Member): Promise<CoinEntry[]> {
    return this.#ledger().entries(this.#d.profile, who.wallet, {
      since: this.#dayStart(this.#today()),
      limit: MAX_DAY_ROWS,
    });
  }

  /**
   * How much hunger this person may still take off her today: their share (`feed_hunger_cap`)
   * less what their feed rows of the day took, the refunded ones not counted. At `0` she is full
   * for them.
   */
  #feedLeft(rows: readonly CoinEntry[]): number {
    const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
    // Food named as a gift (gifts.ts) counts against the same share as rice.
    const taken = rows
      .filter((r) => (r.reason === "feed" || r.reason === GIFT_REASON) && !refunded.has(r.id))
      .reduce((n, r) => n + (r.reason === "feed" ? hungerOf(r) : giftHunger(r)), 0);
    const left = this.#d.config.feed_hunger_cap - taken;
    return left > FEED_EPSILON ? left : 0;
  }

  /** What a cap of `reason` allows per day, for this person. */
  #cap(reason: EarnReason, streakDay: boolean): number {
    const c = this.#d.config;
    switch (reason) {
      case "checkin":
        return c.checkin + (streakDay ? c.streak_bonus : 0);
      case "talked":
        return c.talked;
      case "voice":
        return c.voice_cap;
      case "song":
        return c.song_finished * c.song_cap;
      case "her_gift":
        return c.her_gift_per_person;
    }
  }

  /**
   * Earns `amount` of `reason` for someone she knows, within today's cap of it (what still fits
   * is paid). `null`: a stranger, the cap is reached, or the key was used.
   */
  async earn(
    account: AccountRef,
    reason: Exclude<EarnReason, "checkin" | "her_gift">,
    amount: number,
    key: string,
    ref: string | null = null,
  ): Promise<CoinEntry | null> {
    if (amount <= 0) return null;
    const who = await this.member(account);
    if (!who) return null;
    const since = this.#dayStart(this.#today());
    const cap: CoinCap = {
      wallet: who.wallet,
      reasons: [reason],
      since,
      limit: this.#cap(reason, false),
    };
    const post = await this.#turns.run(() =>
      this.#ledger().post(this.#entry(who, amount, reason, ref, key), {
        caps: [cap],
        partial: true,
      }),
    );
    return post.status === "posted" ? post.entry : null;
  }

  // ---- reads ----------------------------------------------------------------------------

  async #checkinDays(who: Member): Promise<Set<number>> {
    const rows = await this.#ledger().entries(this.#d.profile, who.wallet, {
      reasons: ["checkin"],
      limit: MAX_CHECKINS,
    });
    const offset = this.#d.config.utc_offset_minutes;
    return new Set(rows.map((r) => localDay(Date.parse(r.ts), offset)));
  }

  async #frames(who: Member): Promise<{ owned: string[]; selected: string | null }> {
    const ledger = this.#ledger();
    const rows = await ledger.entries(this.#d.profile, who.wallet, {
      reasons: ["frame", MARKET_REASONS.auctionWon],
      limit: 1_000,
    });
    const bought = new Set(rows.filter((r) => r.reason === "frame").map((r) => r.ref ?? ""));
    // A one-of-a-kind frame won at the weekly auction is theirs alone, oldest first.
    const unique = rows
      .map((r) => uniqueFrameOf(r))
      .filter((id): id is string => id !== null)
      .reverse();
    const owned = [
      ...this.#d.config.frames.map((f) => f.id).filter((id) => bought.has(id)),
      ...new Set(unique),
    ];
    const known = new Set([...this.#d.config.frames.map((f) => f.id), ...unique]);
    const selected = await ledger.selectedFrame(this.#d.profile, who.wallet);
    return { owned, selected: selected !== null && known.has(selected) ? selected : null };
  }

  #hunger(): number | null {
    const self = this.#d.services.get(SelfStateKey);
    if (!self) return null;
    try {
      return self.drives().hunger;
    } catch {
      return null;
    }
  }

  #singing(): boolean {
    try {
      return this.#d.services.get(SingerKey)?.playing() != null;
    } catch {
      return false;
    }
  }

  #stageUp(): boolean {
    return this.#d.services.get(ActuatorRegistryKey)?.get("stage.expression") !== undefined;
  }

  #label(r: CoinEntry): string {
    const c = this.#d.config;
    switch (r.reason) {
      case "feed": {
        const { item, eaten } = fedOf(r);
        return item === null ? "餵她" : `餵她${feedLabel(item, eaten)}`;
      }
      case "frame": {
        const frame = c.frames.find((f) => f.id === r.ref);
        return `買卡框${frame ? `「${frame.label}」` : ""}`;
      }
      case "purse_gift":
        return "她請你的";
      case "bounty":
        return "領到她的懸賞";
      case "card_foil":
      case "screen_message":
      case "fortune":
        return PAID_NAME[r.reason].label;
      case "transfer_out":
        return `轉給 ${otherName(r.ref) ?? "朋友"}`;
      case "transfer_fee":
        return "轉帳手續費";
      case "transfer_in":
        return `${otherName(r.ref) ?? "朋友"} 轉給你`;
      case "refund":
        return "退回";
      case DANMAKU_REASON:
        return "直播彈幕";
      case DANMAKU_REFUND_REASON:
        return "彈幕沒顯示,退回";
      case CARD_REASONS.daily:
        return "每日卡";
      case CARD_REASONS.refund:
        return "每日卡退回";
      case "admin_adjust":
        return r.ref ? `管理員調整:${r.ref}` : "管理員調整";
      case MARKET_REASONS.auctionWon:
        return marketWonLabel(r.ref);
      case MARKET_REASONS.songPriority:
      case MARKET_REASONS.songPriorityRefund:
      case MARKET_REASONS.lotteryTicket:
      case MARKET_REASONS.lotteryRefund:
      case MARKET_REASONS.lotteryPrize:
      case MARKET_REASONS.auctionHold:
      case MARKET_REASONS.auctionRelease:
        return MARKET_LABEL[r.reason] ?? r.reason;
      case EXCHANGE_REASONS.in:
      case EXCHANGE_REASONS.out:
      case EXCHANGE_REASONS.fee:
      case EXCHANGE_REASONS.feeBack:
      case EXCHANGE_REASONS.burn:
      case EXCHANGE_REASONS.burnBack:
      case EXCHANGE_REASONS.mint:
      case EXCHANGE_REASONS.loss:
        return EXCHANGE_LABEL[r.reason] ?? r.reason;
      case KARAOKE_REASONS.room:
      case KARAOKE_REASONS.roomRefund:
      case KARAOKE_REASONS.prize:
      case KARAOKE_REASONS.finish:
        return KARAOKE_LABEL[r.reason] ?? r.reason;
      case "checkin":
        return r.delta > c.checkin ? "每日簽到(連續 7 天)" : EARN_LABEL.checkin;
      default:
        return (
          labelV2(r, c) ??
          giftLabel(r) ??
          RETIRED_LABEL[r.reason] ??
          EARN_LABEL[r.reason as EarnReason] ??
          r.reason
        );
    }
  }

  #line(r: CoinEntry): LedgerLine {
    return { ts: r.ts, delta: r.delta, label: this.#label(r) };
  }

  #strangerView(): WalletView {
    const c = this.#d.config;
    return {
      currency: c.currency,
      balance: 0,
      can_earn: false,
      today_earned: 0,
      checked_in_today: false,
      streak: 0,
      earn: EARN_REASONS.map((reason) => ({
        reason,
        label: EARN_LABEL[reason],
        amount: this.#amount(reason),
        earned_today: 0,
        cap: this.#cap(reason, false),
      })),
      shop: this.#shop(null),
      frames: { owned: [], selected: null },
      hungry: null,
      recent: [],
      on_board: false,
      transfer_fee: this.#d.config.transfer_fee,
    };
  }

  #amount(reason: EarnReason): number {
    const c = this.#d.config;
    switch (reason) {
      case "checkin":
        return c.checkin;
      case "talked":
        return c.talked;
      case "voice":
        return c.voice_per_10min;
      case "song":
        return c.song_finished;
      case "her_gift":
        return 0;
    }
  }

  /** The shop as this person sees it; `null`: a stranger, for whom nothing is available. */
  #shop(
    state: {
      balance: number;
      hunger: number | null;
      /** What this person may still feed her today (`#feedLeft`). */
      feedLeft: number;
      owned: ReadonlySet<string>;
    } | null,
  ): ShopItem[] {
    const c = this.#d.config;
    const out: ShopItem[] = [];
    const add = (
      id: string,
      kind: ShopItem["kind"],
      label: string,
      price: number,
      why: string | null,
    ) => {
      const reason =
        state === null ? STRANGER : (why ?? (state.balance < price ? `${c.currency}不夠` : null));
      out.push({ id, kind, label, price, available: reason === null, why: reason });
    };
    for (const item of FEED_ITEMS) {
      const why =
        state?.hunger == null ? "現在沒辦法餵她" : state.feedLeft <= 0 ? "你今天餵夠了" : null;
      add(item, "feed", FEED_NAME[item][0], c[item], why);
    }
    for (const f of c.frames) {
      add(`frame:${f.id}`, "frame", f.label, f.price, state?.owned.has(f.id) ? "已經有了" : null);
    }
    // Whether one can be used right now (a card to make shiny) is the seller's.
    for (const item of PAID_ITEMS) {
      const { price, per_day } = this.price(item);
      if (per_day === 0) continue;
      add(item, PAID_NAME[item].kind, PAID_NAME[item].label, price, null);
    }
    return out;
  }

  /** Every shop item and its price, for nobody in particular (nothing is marked buyable). */
  shop(): ShopItem[] {
    return this.#shop(null);
  }

  async wallet(account: AccountRef): Promise<WalletView> {
    const who = await this.member(account);
    if (!who) return this.#strangerView();
    const c = this.#d.config;
    const ledger = this.#ledger();
    const [balance, today, days, frames, recent] = await Promise.all([
      this.#balance(who),
      this.#todayRows(who),
      this.#checkinDays(who),
      this.#frames(who),
      ledger.entries(this.#d.profile, who.wallet, { limit: RECENT_LINES }),
    ]);
    const day = this.#today();
    const streak = streakOf(days, day);
    const checked = days.has(day);
    const earnedOf = (reason: string) =>
      today.filter((r) => r.reason === reason).reduce((n, r) => n + r.delta, 0);
    const earn: EarnLine[] = EARN_REASONS.map((reason) => ({
      reason,
      label: EARN_LABEL[reason],
      amount: this.#amount(reason),
      earned_today: earnedOf(reason),
      // The 7th day's cap is what that check-in pays (or would pay).
      cap: this.#cap(reason, (checked ? streak : streak + 1) % 7 === 0),
    }));
    const hunger = this.#hunger();
    const feedLeft = this.#feedLeft(today);
    return {
      currency: c.currency,
      balance,
      can_earn: true,
      today_earned: today
        .filter((r) => (EARN_REASONS as readonly string[]).includes(r.reason))
        .reduce((n, r) => n + r.delta, 0),
      checked_in_today: checked,
      streak,
      earn,
      shop: this.#shop({
        balance,
        hunger,
        feedLeft,
        owned: new Set(frames.owned),
      }),
      frames,
      hungry: hunger === null ? null : feedLeft <= 0 ? "full" : hungerWord(hunger),
      recent: recent.map((r) => this.#line(r)),
      on_board: await ledger.onBoard(this.#d.profile, who.wallet),
      transfer_fee: c.transfer_fee,
    };
  }

  async exportWallet(account: AccountRef): Promise<WalletExport> {
    const who = await this.member(account);
    if (!who) return { balance: 0, ledger: [] };
    const rows = await this.#ledger().entries(this.#d.profile, who.wallet, {
      limit: MAX_EXPORTED,
    });
    return { balance: await this.#balance(who), ledger: rows.map((r) => this.#line(r)) };
  }

  // ---- between people (§13) --------------------------------------------------------------

  transfer(from: AccountRef, to: AccountRef, amount: number, key: string): Promise<TransferResult> {
    return sendCoins(this, from, to, amount, key);
  }

  board(limit?: number, members?: ReadonlySet<PersonId>): Promise<BoardLine[]> {
    return sponsorBoard(this, limit, members);
  }

  setOnBoard(account: AccountRef, on: boolean): Promise<boolean> {
    return setBoard(this, account, on);
  }

  async selectedFrame(account: AccountRef): Promise<string | null> {
    const who = await this.member(account);
    if (!who) return null;
    return (await this.#frames(who)).selected;
  }

  // ---- earning --------------------------------------------------------------------------

  async checkin(account: AccountRef): Promise<CheckinResult> {
    const who = await this.#known(account);
    const c = this.#d.config;
    const done = await this.#turns.run(async () => {
      const day = this.#today();
      const days = await this.#checkinDays(who);
      if (days.has(day)) throw new EconomyError(409, ALREADY_CHECKED_IN);
      const streak = streakOf(days, day) + 1;
      const gained = c.checkin + (streak % 7 === 0 ? c.streak_bonus : 0);
      const post = await this.#ledger().post(
        this.#entry(
          who,
          gained,
          "checkin",
          streak % 7 === 0 ? `streak:${streak}` : null,
          `checkin:${day}`,
        ),
        {},
      );
      if (post.status !== "posted") throw new EconomyError(409, ALREADY_CHECKED_IN);
      return { gained, streak, balance: post.balance };
    });
    const unlocked = await this.v2.afterEarn(who);
    if (unlocked.length === 0) return done;
    // What an achievement paid is in the balance too.
    return { ...done, balance: await this.#balance(who), unlocked };
  }

  /**
   * Her own gift (`give_coins`): to someone she knows, within what she may give one person and
   * everyone today. Returns what was given (less than asked when a cap is near), `0` at a cap.
   */
  async give(
    account: AccountRef,
    amount: number,
    reason: string,
  ): Promise<{ given: number; balance: number }> {
    const who = await this.#known(account);
    const c = this.#d.config;
    const since = this.#dayStart(this.#today());
    const rule: CoinRule = {
      partial: true,
      caps: [
        { wallet: who.wallet, reasons: ["her_gift"], since, limit: c.her_gift_per_person },
        { wallet: null, reasons: ["her_gift"], since, limit: c.her_gift_total },
      ],
    };
    const ref = [...reason.trim()].slice(0, 100).join("") || null;
    const post = await this.#turns.run(() =>
      this.#ledger().post(this.#entry(who, amount, "her_gift", ref, null), rule),
    );
    if (post.status !== "posted") return { given: 0, balance: post.balance };
    return { given: post.entry.delta, balance: post.balance };
  }

  // ---- spending -------------------------------------------------------------------------

  /** A spend of `price` under `key` (the first row of the key when it was used). */
  async #spend(
    who: Member,
    price: number,
    reason: string,
    ref: string | null,
    key: string,
  ): Promise<Spent> {
    const post = await this.#ledger().post(this.#entry(who, -price, reason, ref, key), {
      covered: true,
    });
    if (post.status === "short") throw new EconomyError(402, `${this.#d.config.currency}不夠`);
    if (post.status === "capped") throw new EconomyError(429, "今天到上限了");
    // A share of a paid gift is hers (once per row: the key is the row's).
    if (post.status === "posted") await this.purse.share(post.entry);
    return { entry: post.entry, balance: post.balance, fresh: post.status === "posted" };
  }

  async #first(who: Member, key: string): Promise<Spent | null> {
    const entry = await this.#ledger().byKey(this.#d.profile, who.wallet, key);
    return entry ? { entry, balance: await this.#balance(who), fresh: false } : null;
  }

  async #refunded(who: Member, entry: CoinEntry): Promise<boolean> {
    return (await this.#ledger().byKey(this.#d.profile, who.wallet, `refund:${entry.id}`)) !== null;
  }

  async #refund(who: Member, entry: CoinEntry): Promise<number> {
    const post = await this.#ledger().post(
      this.#entry(who, -entry.delta, "refund", entry.id, `refund:${entry.id}`),
      {},
    );
    // What she was given of it goes back too.
    await this.purse.claw(entry);
    return post.balance;
  }

  async #refused(who: Member, message: string): Promise<SpendResult> {
    return { accepted: false, charged: 0, balance: await this.#balance(who), message };
  }

  async feed(account: AccountRef, item: FeedItem, count: number, key: string): Promise<FeedResult> {
    if (!FEED_ITEMS.includes(item)) throw new EconomyError(400, "沒有這種食物");
    if (!Number.isInteger(count) || count < 1 || count > MAX_FEED_COUNT) {
      throw new EconomyError(400, `一次最多餵 ${MAX_FEED_COUNT} 份`);
    }
    const who = await this.#known(account);
    const c = this.#d.config;
    const idem = `feed:${key}`;
    const spent = await this.#turns.run(async (): Promise<Spent | FeedResult> => {
      const first = await this.#first(who, idem);
      if (first) return first;
      const self = this.#d.services.get(SelfStateKey);
      const hunger = this.#hunger();
      if (!self || hunger === null) throw new EconomyError(503, CANNOT_FEED);
      // She eats one at a time while this person's share of the day lasts; what she cannot eat
      // is not bought. Her own hunger does not stop it (one person cannot fill her for the rest).
      let eaten = 0;
      let left = this.#feedLeft(await this.#todayRows(who));
      for (; eaten < count && left > FEED_EPSILON; left -= HUNGER_OF[item]) eaten += 1;
      if (eaten === 0) {
        const balance = await this.#balance(who);
        return { accepted: false, eaten: 0, charged: 0, balance, message: FULL };
      }
      const out = await this.#spend(who, c[item] * eaten, "feed", `${item}:${eaten}`, idem);
      if (out.fresh) self.adjust({ hunger: -HUNGER_OF[item] * eaten }, "fed");
      return out;
    });
    if (!("entry" in spent)) return spent;
    const { item: ate, eaten } = fedOf(spent.entry);
    const label = ate === null ? "東西" : feedLabel(ate, eaten);
    let unlocked: AchievementUnlocked[] = [];
    if (spent.fresh && ate !== null) {
      await this.#gift(who, spent.entry, ate, eaten, label);
      if (ate === "big_bowl") this.#bigBowl();
      this.#audit(who, "economy.feed", { item: ate, eaten, charged: -spent.entry.delta });
      unlocked = await this.v2.afterEarn(who);
    }
    return {
      accepted: true,
      eaten,
      charged: -spent.entry.delta,
      balance: unlocked.length > 0 ? await this.#balance(who) : spent.balance,
      message: `她吃了${label}`,
      ...(unlocked.length > 0 ? { unlocked } : {}),
    };
  }

  /** The 钢盆 face for a moment when the stage is up; nothing is refunded for it. */
  #bigBowl(): void {
    if (!this.#stageUp() || this.#singing()) return;
    void this.#expressOnStage("big_bowl", BIG_BOWL_SECONDS).catch(() => false);
  }

  // ---- paid things other parts sell (§13) ----------------------------------------------

  price(item: PaidItem): { price: number; per_day: number } {
    if (!PAID_ITEMS.includes(item)) return { price: 0, per_day: 0 };
    const c = this.#d.config;
    return { price: c[item], per_day: c[PER_DAY[item]] };
  }

  async purchase(
    account: AccountRef,
    item: PaidItem,
    key: string,
    ref: string | null = null,
  ): Promise<Purchase> {
    const { price, per_day } = this.price(item);
    if (per_day === 0) throw new EconomyError(400, "現在不賣這個");
    const who = await this.#known(account);
    const idem = `${item}:${key}`;
    return this.#turns.run(async () => {
      const first = await this.#first(who, idem);
      if (first) {
        return {
          entry_id: first.entry.id,
          charged: -first.entry.delta,
          balance: first.balance,
          duplicate: true,
        };
      }
      if ((await this.#boughtToday(who, item)) >= per_day) {
        throw new EconomyError(429, `今天最多 ${per_day} 次`);
      }
      const spent = await this.#spend(who, price, item, ref, idem);
      this.#audit(who, "economy.purchase", { item, price, ref });
      return { entry_id: spent.entry.id, charged: price, balance: spent.balance, duplicate: false };
    });
  }

  async adjust(
    account: AccountRef,
    amount: number,
    note: string,
    by: string,
    key: string,
  ): Promise<AdjustResult> {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUST) {
      throw new EconomyError(400, `數量要是 1 到 ${MAX_ADJUST} 的整數`);
    }
    const text = [...note.trim()].slice(0, MAX_ADJUST_NOTE_CHARS).join("");
    if (text === "") throw new EconomyError(400, "要寫備註");
    const who = await this.#holder(account);
    const idem = `admin_adjust:${key}`;
    return this.#turns.run(async () => {
      const first = await this.#first(who, idem);
      if (first) return { entry_id: first.entry.id, balance: first.balance, duplicate: true };
      const post = await this.#ledger().post(this.#entry(who, amount, "admin_adjust", text, idem), {
        covered: amount < 0,
      });
      if (post.status === "short") {
        const have = await this.#balance(who);
        throw new EconomyError(402, `只有 ${have} ${this.#d.config.currency},扣不了 ${-amount}`);
      }
      if (post.status !== "posted") throw new EconomyError(409, "這筆調整沒有成功");
      this.#audit(who, "economy.adjust", { amount, note: text, by });
      return { entry_id: post.entry.id, balance: post.balance, duplicate: false };
    });
  }

  async statement(account: AccountRef, limit = 20): Promise<WalletExport> {
    let who: Member;
    try {
      who = await this.#holder(account);
    } catch {
      return { balance: 0, ledger: [] };
    }
    const rows = await this.#ledger().entries(this.#d.profile, who.wallet, {
      limit: Math.min(Math.max(Math.floor(limit), 1), MAX_EXPORTED),
    });
    return { balance: await this.#balance(who), ledger: rows.map((r) => this.#line(r)) };
  }

  /** Someone she knows, blocked or not (an admin may need to take coins from them). */
  async #holder(account: AccountRef): Promise<Member> {
    const people = this.#d.services.get(PeopleStoreKey);
    const person = people ? await people.personByAccount(account) : null;
    if (!person) throw new EconomyError(403, STRANGER);
    return memberOf(account, person);
  }

  async refund(account: AccountRef, entryId: string): Promise<boolean> {
    const who = await this.member(account);
    if (!who) return false;
    return this.#turns.run(async () => {
      const rows = await this.#ledger().entries(this.#d.profile, who.wallet, {
        reasons: PAID_ITEMS,
        limit: MAX_DAY_ROWS,
      });
      const entry = rows.find((r) => r.id === entryId);
      if (!entry || entry.delta >= 0 || (await this.#refunded(who, entry))) return false;
      await this.#refund(who, entry);
      this.#audit(who, "economy.refund", { item: entry.reason, ref: entry.ref });
      return true;
    });
  }

  /** How many of `item` they bought today and kept (refunded ones do not count). */
  async #boughtToday(who: Member, item: PaidItem): Promise<number> {
    const today = await this.#todayRows(who);
    const refunded = new Set(today.filter((r) => r.reason === "refund").map((r) => r.ref));
    return today.filter((r) => r.reason === item && !refunded.has(r.id)).length;
  }

  async screenMessage(account: AccountRef, text: string, key: string): Promise<SpendResult> {
    const body = screenText(text);
    if (body === null) throw new EconomyError(400, `留言要 1 到 ${MAX_SCREEN_CHARS} 個字`);
    const { price, per_day } = this.price("screen_message");
    if (per_day === 0) throw new EconomyError(400, "現在不賣這個");
    const who = await this.#known(account);
    const idem = `screen_message:${key}`;
    const cooldown = this.#d.config.screen_message_cooldown_s * 1000;
    const spent = await this.#turns.run(async (): Promise<Spent | SpendResult> => {
      const first = await this.#first(who, idem);
      if (first) return first;
      const now = this.#d.clock.now();
      const rows = await this.#ledger().entries(this.#d.profile, who.wallet, {
        reasons: ["screen_message", "refund"],
        since: toTimestamp(now - cooldown),
        limit: MAX_DAY_ROWS,
      });
      const wait = screenWait(rows, cooldown, now);
      if (wait > 0) {
        const every = waitMinutes(cooldown);
        throw new EconomyError(429, `每 ${every} 分鐘只能留一則,還要等 ${waitMinutes(wait)} 分鐘`);
      }
      if (!this.#stageUp()) throw new EconomyError(409, "她現在沒有開台");
      if (!this.#passes(who, body)) return this.#refused(who, "這則留言沒辦法上螢幕");
      if ((await this.#boughtToday(who, "screen_message")) >= per_day) {
        throw new EconomyError(429, `今天最多 ${per_day} 次`);
      }
      return this.#spend(who, price, "screen_message", null, idem);
    });
    if (!("entry" in spent)) return spent;
    if (spent.fresh) {
      const name = plainName(who.name);
      this.#d.publish(Events.EconomyScreen, screenEvent(name, body));
      // Silent: she may read it out when free, and a song is not interrupted.
      this.#perceive(who, spent.entry, `${safeName(who.name)}把一則留言放上了大螢幕:「${body}」`);
      this.#audit(who, "economy.screen_message", { charged: price, chars: [...body].length });
    }
    return {
      accepted: true,
      charged: -spent.entry.delta,
      balance: spent.balance,
      message: "留言上螢幕了,她看得到",
    };
  }

  danmaku(account: AccountRef, text: string, key: string): Promise<SpendResult> {
    return this.danmakuDesk.send(account, text, key);
  }

  danmakuView(account: AccountRef): Promise<DanmakuView> {
    return this.danmakuDesk.view(account);
  }

  /** Moderation reads a text as input and as text on a page; without it nothing passes. */
  #passes(who: Pick<Member, "account">, text: string): boolean {
    const s = this.#d.services;
    const moderation = s.get(ModerationKey);
    if (!moderation) return false;
    try {
      const verdict = inspectInput(s, { text, source: "web", author: who.account });
      if (verdict === null || holdsBack(verdict) || verdict.action !== "pass") return false;
      return moderation.screen({ path: "other", visible: text }).ok;
    } catch {
      return false;
    }
  }

  /** `stage.expression` through the gate; `false` when it is not there or did not run. */
  async #expressOnStage(expression: string, seconds: number): Promise<boolean> {
    const actuators = this.#d.services.get(ActuatorRegistryKey);
    if (!actuators?.get("stage.expression")) return false;
    try {
      const outcome = await actuators.invoke({
        principal: Principals.panel("economy"),
        capability: "stage.expression",
        args: { expression, seconds },
        why: "觀眾送的表情",
        turn: null,
      });
      return outcome.status === "done";
    } catch (error) {
      this.#d.log.warn({ err: errorMessage(error) }, "the stage did not take an expression");
      return false;
    }
  }

  async frame(
    account: AccountRef,
    req: { buy?: string; select?: string | null },
    key: string,
  ): Promise<FramesResult> {
    const who = await this.#known(account);
    const frames = this.#d.config.frames;
    const named = (id: string) => {
      const frame = frames.find((f) => f.id === id);
      if (!frame) throw new EconomyError(400, "沒有這個卡框");
      return frame;
    };
    const buy = req.buy === undefined ? null : named(req.buy);
    // A one-of-a-kind frame is never sold; whether it is theirs is checked below.
    if (typeof req.select === "string" && !req.select.startsWith("one-")) named(req.select);
    return this.#turns.run(async () => {
      let state = await this.#frames(who);
      if (buy !== null && !state.owned.includes(buy.id)) {
        const spent = await this.#spend(who, buy.price, "frame", buy.id, `frame:${key}`);
        if (spent.fresh) this.#audit(who, "economy.frame", { frame: buy.id, charged: buy.price });
        state = await this.#frames(who);
      }
      if (req.select !== undefined) {
        if (req.select !== null && !state.owned.includes(req.select)) {
          throw new EconomyError(409, "還沒有這個卡框");
        }
        await this.#ledger().selectFrame(
          this.#d.profile,
          who.wallet,
          req.select,
          toTimestamp(this.#d.clock.now()),
        );
        state = { ...state, selected: req.select };
      }
      return { owned: state.owned, selected: state.selected, balance: await this.#balance(who) };
    });
  }

  // ---- what she feels -------------------------------------------------------------------

  /**
   * An accepted gift: the `gift` social event toward the giver, weaker for each earlier gift of
   * theirs today (`diminish^(n-1)`), an Observation for her and `economy.gift` for the overlay.
   * Her hunger was already lowered by what she ate, so the event takes none.
   */
  async #gift(
    who: Member,
    entry: CoinEntry,
    item: FeedItem,
    count: number,
    label: string,
  ): Promise<void> {
    let n = 1;
    try {
      const today = await this.#todayRows(who);
      const refunded = new Set(today.filter((r) => r.reason === "refund").map((r) => r.ref));
      n = Math.max(
        today.filter((r) => GIFT_REASONS.includes(r.reason) && !refunded.has(r.id)).length,
        1,
      );
    } catch (error) {
      this.#d.log.warn({ err: errorMessage(error) }, "cannot count today's gifts");
    }
    const scale = this.#d.config.diminish ** (n - 1);
    const payload: JsonValue = {
      person: who.person.id,
      name: who.name,
      kind: "gift",
      source: "economy",
      scale,
      context: null,
      hunger: 0,
    };
    this.#d.publish(Events.SocialEvent, payload as EventPayload<typeof Events.SocialEvent>);
    await this.#bond(who);
    heartEvidence(this.#d.services, this.#d.log, {
      person: who.person.id,
      kind: "gift",
      detail: `送了你${label}`,
      weight: Math.abs(entry.delta),
      at: this.#d.clock.now(),
    });
    this.#perceive(who, entry, `${safeName(who.name)}送了你${label}`);
    this.#announce(who, item, count, label);
  }

  /**
   * A hair of affinity and trust for a paid gift, through the social engine: it diminishes with
   * the person's earlier gifts today and stops at the gifts' own daily cap (and the overall ones).
   * The engine publishes no emotion for it; the `gift` event above is her reaction.
   */
  async #bond(who: Member): Promise<void> {
    const c = this.#d.config;
    if (c.gift_affinity <= 0 && c.gift_trust <= 0) return;
    const effects = this.#d.services.get(RelationshipEffectsKey);
    if (!effects) return;
    try {
      await effects.gain(
        who.person.id,
        {
          kind: "treat",
          affinity: c.gift_affinity,
          trust: c.gift_trust,
          kind_cap: { affinity: c.gift_affinity_cap, trust: c.gift_trust_cap },
        },
        this.#d.clock.now(),
      );
    } catch (error) {
      this.#d.log.warn({ err: errorMessage(error) }, "cannot add a gift to the relationship");
    }
  }

  #announce(who: Member, item: GiftItem, count: number, label: string): void {
    const gift: GiftEvent = { name: plainName(who.name), item, count, label };
    this.#d.publish(Events.EconomyGift, gift);
  }

  /** Something she knows from now on, silently (her working context, as data). */
  #perceive(who: Member, entry: CoinEntry, summary: string): boolean {
    return this.#tell(
      who,
      `economy.${entry.reason}`,
      `economy:${entry.id}`,
      summary,
      "economy",
      MAX_CONTEXT_ENTRIES,
    );
  }

  #tell(
    who: Member,
    source: string,
    key: string,
    summary: string,
    writer: string,
    max: number,
  ): boolean {
    const log = this.#d.services.get(EventLogKey);
    if (!log) return false;
    const handle = this.#handle(who.person.id);
    try {
      log.observe(
        {
          source,
          silent: true,
          salience: "notable",
          attention_key: key,
          revision: 1,
          summary,
          addressed_to_her: true,
          from: handle,
          context: null,
        },
        {
          buckets: [
            { op: "append-self", writer, owner: "economy", untrusted: true, max_entries: max },
          ],
          person: handle,
        },
      );
      return true;
    } catch (error) {
      this.#d.log.warn({ err: errorMessage(error) }, "cannot tell her about a gift");
      return false;
    }
  }

  #handle(person: PersonId): string | null {
    try {
      return this.#d.services.get(HandleDirectoryKey)?.ofPerson(person) ?? null;
    } catch {
      return null;
    }
  }

  #audit(who: Member, action: string, detail: JsonValue): void {
    const audit = this.#d.services.get(AuditLogKey);
    if (!audit) return;
    const actor = accountRefString(who.account);
    void audit
      .append({
        id: newId(),
        at: toTimestamp(this.#d.clock.now()),
        actor,
        action,
        target: actor,
        detail,
        ok: true,
      })
      .catch((error: unknown) => {
        this.#d.log.warn({ err: errorMessage(error), action }, "cannot write audit entry");
      });
  }
}

/** The window number of `ms` for voice time. */
export function voiceWindow(ms: number): number {
  return Math.floor(ms / VOICE_WINDOW_MS);
}

export { VOICE_WINDOW_MS };
