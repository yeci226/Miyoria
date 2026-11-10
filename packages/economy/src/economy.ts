// The wallet (docs/design/economy.md): earning, spending, and what a gift does to her.
//
// * The ledger is the store's (`CoinLedgerStore`): rows are appended in one transaction with
//   their checks, the balance is a sum, a refund is a row. Caps are sums of today's rows.
// * A wallet is every account of the person she knows them as. Someone she does not know, or
//   has blocked, has a stranger's wallet: empty, earning nothing, every spend refused alike.
// * A gift lowers her hunger by what she ate and is the `gift` social event toward the giver,
//   weaker for each earlier gift of the same person today. A paid gift (not a letter) also raises
//   affinity and trust by a hair through the social engine (`RelationshipEffects`), within its own
//   daily cap. She learns of it as a silent Observation, read when she next thinks (never a
//   reason to break into a song).
// * Deals (deals.ts) are someone's promise of a snack for a task; payment is read off this ledger.
// * Spends of this process take turns, so two clicks cannot both pass a check meant for one.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { errorMessage, type Logger, SerialQueue, type ServiceLookup } from "@miyoria/kernel";
import { SingerKey } from "@miyoria/sing";
import {
  AuditLogKey,
  type CoinCap,
  type CoinEntry,
  type CoinLedgerStore,
  CoinLedgerStoreKey,
  type CoinRule,
  PeopleStoreKey,
  type Person,
} from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  accountRefString,
  type Clock,
  customEvent,
  type Event,
  EventLogKey,
  HandleDirectoryKey,
  holdsBack,
  inspectInput,
  type JsonValue,
  ModerationKey,
  NOTICE_TOPIC,
  newId,
  type PersonId,
  Principals,
  type ProfileId,
  RelationshipEffectsKey,
  SelfStateKey,
  SOCIAL_EVENT_TOPIC,
  SocialSignalsKey,
  safeName,
  sameAccount,
  type Timestamp,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { setBoard, sponsorBoard } from "./board.js";
import { BountyBoard } from "./bounties.js";
import type { EconomyConfig } from "./config.js";
import { DealDesk } from "./deals.js";
import { type EconomyDocStore, EconomyDocsKey, MemoryDocs } from "./docs.js";
import { GoalDesk } from "./goals.js";
import { Purse } from "./purse.js";
import { MAX_SCREEN_CHARS, screenEvent, screenText, screenWait, waitMinutes } from "./screen.js";
import { otherName, sendCoins } from "./transfer.js";
import {
  type AdjustResult,
  type BoardLine,
  type BountyView,
  type CheckinResult,
  type EarnLine,
  type EarnReason,
  type Economy,
  EconomyError,
  FEED_ITEMS,
  type FeedItem,
  type FeedResult,
  type FramesResult,
  GIFT_EXPRESSIONS,
  GIFT_TOPIC,
  type GiftEvent,
  type GiftExpression,
  type GiftItem,
  type GoalView,
  type Hunger,
  type LedgerLine,
  MAX_ADJUST,
  MAX_ADJUST_NOTE_CHARS,
  PAID_ITEMS,
  type PaidItem,
  type PledgeResult,
  type Purchase,
  SCREEN_TOPIC,
  type ShopItem,
  type SpendResult,
  type TransferResult,
  type WalletExport,
  type WalletView,
} from "./types.js";
import { labelV2, V2 } from "./v2.js";

export const STRANGER = "她還不認識你,先和她說說話吧";
/** Permission node of a wallet (`me.*`): a role without it, like `blocked`, has a stranger's. */
export const WALLET_NODE = "me.wallet";
export const ALREADY_CHECKED_IN = "今天已經簽到過了";
/** A feed refused because she is full (nothing charged). */
export const FULL = "她吃飽了,吃不下";
/** A feed refused because her hunger cannot be read. */
export const CANNOT_FEED = "現在沒辦法餵她";

const DAY_MS = 86_400_000;
const VOICE_WINDOW_MS = 10 * 60_000;
/** Feeds per request at most. */
export const MAX_FEED_COUNT = 5;
export const MAX_LETTER_CHARS = 120;
/** How long a bought expression shows, and the big bowl's. */
export const EXPRESSION_SECONDS = 8;
export const BIG_BOWL_SECONDS = 5;
const RECENT_LINES = 20;
const MAX_EXPORTED = 10_000;
/** Today's rows read for caps and gifts; a day of one person is far less. */
const MAX_DAY_ROWS = 2_000;
/** Check-ins read for the streak: more than a year. */
const MAX_CHECKINS = 400;
/** Letters she has not read yet stay this long when there is no EventLog. */
const LETTER_TTL_MS = 6 * 3_600_000;
/** Kept in her working context: the latest gifts and letters. */
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

const EXPRESSION_NAME: Readonly<Record<GiftExpression, string>> = {
  heart: "愛心眼",
  blush: "臉紅",
  squint: "＞＜",
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
  card_reroll: "card_rerolls_per_day",
  card_pose: "card_poses_per_day",
  card_foil: "card_foils_per_day",
  song_ticket: "song_tickets_per_day",
  dedication: "dedications_per_day",
  screen_message: "screen_messages_per_day",
  fortune: "fortunes_per_day",
} as const satisfies Record<PaidItem, keyof EconomyConfig>;

/** How a paid thing reads in the shop and the ledger, and its shop kind. */
export const PAID_NAME: Readonly<Record<PaidItem, { label: string; kind: ShopItem["kind"] }>> = {
  card_reroll: { label: "抽卡重製券", kind: "card" },
  card_pose: { label: "指定立繪", kind: "card" },
  card_foil: { label: "閃卡加工", kind: "card" },
  song_ticket: { label: "點歌加點券", kind: "song" },
  dedication: { label: "歌曲獻詞", kind: "song" },
  screen_message: { label: "留言上大螢幕", kind: "stream" },
  fortune: { label: "今日籤詩", kind: "fortune" },
};

/** Ledger reasons that are gifts to her (they diminish each other). */
const GIFT_REASONS = ["feed", "letter", "expression"];
const EARN_REASONS: readonly EarnReason[] = ["checkin", "talked", "voice", "song", "her_gift"];

/** `一碗白飯`, `3 碗白飯`. */
export function feedLabel(item: FeedItem, count: number): string {
  const [one, unit] = FEED_NAME[item];
  return count === 1 ? one : `${count} ${unit}`;
}

/** Her hunger in words: a number on a page is something to farm. */
export function hungerWord(hunger: number, fullBelow: number): Hunger {
  if (hunger < fullBelow) return "full";
  if (hunger < 0.4) return "ok";
  if (hunger < 0.7) return "hungry";
  return "starving";
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
function plainName(name: string): string {
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
  /** Every account of the person, `account` included. */
  wallet: AccountRef[];
  /** The display name of `account` (untrusted). */
  name: string;
}

export interface EconomyDeps {
  config: EconomyConfig;
  services: ServiceLookup;
  profile: ProfileId;
  clock: Clock;
  publish: (event: Event) => void;
  log: Logger;
  /** A number in [0, 1) for draws; `Math.random` unless a test pins it. */
  random?: () => number;
}

export class EconomyService implements Economy {
  readonly #d: EconomyDeps;
  readonly #turns = new SerialQueue();
  /** Deals she accepted (deals.ts). */
  readonly deals: DealDesk;
  /** Her own coins (purse.ts), her crowdfunding goals (goals.ts) and her bounties (bounties.ts). */
  readonly purse: Purse;
  readonly goalDesk: GoalDesk;
  readonly bountyDesk: BountyBoard;
  /** Economy 2.0 (docs/design/v4-plan.md §10): play, quests, collection, predictions, ... */
  readonly v2: V2;
  /** Used when no store provides `EconomyDocsKey` (what is kept there is gone on restart). */
  #fallbackDocs: MemoryDocs | null = null;

  constructor(deps: EconomyDeps) {
    this.#d = deps;
    this.deals = new DealDesk(this);
    this.purse = new Purse(this);
    this.goalDesk = new GoalDesk(this);
    this.bountyDesk = new BountyBoard(this);
    this.v2 = new V2(this);
  }

  // ---- what economy 2.0 uses ---------------------------------------------------------------

  /** Whether the documents (collection, bets, commissions, room) outlive a restart. */
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
        accounts: who.wallet,
        reasons: cap.reasons,
        since: this.#dayStart(this.#today()),
        limit: cap.limit,
      },
    ];
    const post = await this.#ledger().post(this.#entry(who, amount, reason, ref, key), {
      wallet: who.wallet,
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

  // ---- what deals.ts uses -----------------------------------------------------------------

  get services(): ServiceLookup {
    return this.#d.services;
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

  publish(event: Event): void {
    this.#d.publish(event);
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

  /** Whether the text passes the screen a letter passes (moderation, input and output). */
  passes(who: Pick<Member, "account">, text: string): boolean {
    return this.#passes(who, text);
  }

  // ---- her goals and bounties (§13) -------------------------------------------------------

  goals(account: AccountRef): Promise<GoalView[]> {
    return this.goalDesk.view(account);
  }

  pledge(account: AccountRef, goal: string, amount: number, key: string): Promise<PledgeResult> {
    return this.goalDesk.pledge(account, goal, amount, key);
  }

  bounties(): Promise<BountyView[]> {
    return this.bountyDesk.view();
  }

  /**
   * Escrow released to her: she eats what the deal's reward is, then it is an ordinary gift
   * (`gift` event, a hair of affinity, the overlay). Nothing is charged: the escrow already was.
   */
  async release(who: Member, entry: CoinEntry, item: FeedItem, count: number): Promise<void> {
    const label = feedLabel(item, count);
    this.#d.services.get(SelfStateKey)?.adjust({ hunger: -HUNGER_OF[item] * count }, "fed");
    await this.#gift(who, entry, item, count, label);
    await this.purse.share(entry, true);
    if (item === "big_bowl") this.#bigBowl();
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
    const social = s.get(SocialSignalsKey);
    const affect = s.get(AffectStateKey);
    const authorizer = s.get(AuthorizerKey);
    if ((!social && !affect) || !authorizer?.allows(account, WALLET_NODE)) return null;
    if (social?.attitude(account)?.blocked || affect?.card(person.id)?.blocked) return null;
    const wallet = person.accounts.map((a) => a.account);
    if (!wallet.some((a) => sameAccount(a, account))) wallet.push(account);
    const own = person.accounts.find((a) => sameAccount(a.account, account));
    return { account, person, wallet, name: own?.display_name ?? person.display_name };
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
      profile: this.#d.profile,
      account: who.account,
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
      accounts: who.wallet,
      reasons: [reason],
      since,
      limit: this.#cap(reason, false),
    };
    const post = await this.#turns.run(() =>
      this.#ledger().post(this.#entry(who, amount, reason, ref, key), {
        wallet: who.wallet,
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
      reasons: ["frame"],
      limit: 1_000,
    });
    const known = new Set(this.#d.config.frames.map((f) => f.id));
    const bought = new Set(rows.map((r) => r.ref ?? ""));
    const owned = this.#d.config.frames.map((f) => f.id).filter((id) => bought.has(id));
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

  #cooldownMinutes(): number {
    return Math.max(Math.round(this.#d.config.expression_cooldown_s / 60), 1);
  }

  /** The last bought expression not refunded, within the cooldown. */
  #cooling(today: readonly CoinEntry[]): boolean {
    const refunded = new Set(today.filter((r) => r.reason === "refund").map((r) => r.ref));
    const since = this.#d.clock.now() - this.#d.config.expression_cooldown_s * 1000;
    return today.some(
      (r) => r.reason === "expression" && !refunded.has(r.id) && Date.parse(r.ts) > since,
    );
  }

  #label(r: CoinEntry): string {
    const c = this.#d.config;
    switch (r.reason) {
      case "feed": {
        const { item, eaten } = fedOf(r);
        return item === null ? "餵她" : `餵她${feedLabel(item, eaten)}`;
      }
      case "letter":
        return "寫信給她";
      case "expression": {
        const name = Object.hasOwn(EXPRESSION_NAME, r.ref ?? "")
          ? EXPRESSION_NAME[r.ref as GiftExpression]
          : null;
        return name === null ? "送她表情" : `送她表情「${name}」`;
      }
      case "frame": {
        const frame = c.frames.find((f) => f.id === r.ref);
        return `買卡框${frame ? `「${frame.label}」` : ""}`;
      }
      case "deal_escrow":
        return "先付給她的約定";
      case "goal_pledge":
        return "投給她的目標";
      case "purse_gift":
        return "她請你的";
      case "bounty":
        return "領到她的懸賞";
      case "card_reroll":
      case "card_pose":
      case "card_foil":
      case "song_ticket":
      case "dedication":
      case "screen_message":
      case "fortune":
        return PAID_NAME[r.reason].label;
      case "transfer_out":
        return `轉給 ${otherName(r.ref) ?? "朋友"}`;
      case "transfer_in":
        return `${otherName(r.ref) ?? "朋友"} 轉給你`;
      case "refund":
        return "退回";
      case "admin_adjust":
        return r.ref ? `管理員調整:${r.ref}` : "管理員調整";
      case "checkin":
        return r.delta > c.checkin ? "每日簽到(連續 7 天)" : EARN_LABEL.checkin;
      default:
        return labelV2(r, c) ?? EARN_LABEL[r.reason as EarnReason] ?? r.reason;
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
      deals: [],
      on_board: false,
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
      singing: boolean;
      stage: boolean;
      cooling: boolean;
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
        state?.hunger == null ? "現在沒辦法餵她" : state.hunger < c.full_below ? "她吃飽了" : null;
      add(item, "feed", FEED_NAME[item][0], c[item], why);
    }
    add("letter", "letter", "一封信", c.letter, null);
    for (const e of GIFT_EXPRESSIONS) {
      const why = !state?.stage
        ? "她現在沒有開台"
        : state.singing
          ? "她正在唱歌"
          : state.cooling
            ? `每 ${this.#cooldownMinutes()} 分鐘只能送一次`
            : null;
      add(`expression:${e}`, "expression", EXPRESSION_NAME[e], c.expression, why);
    }
    for (const f of c.frames) {
      add(`frame:${f.id}`, "frame", f.label, f.price, state?.owned.has(f.id) ? "已經有了" : null);
    }
    // Whether one can be used right now (a card to re-draw, a song to dedicate) is the seller's.
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
    const [balance, today, days, frames, recent, deals] = await Promise.all([
      this.#balance(who),
      this.#todayRows(who),
      this.#checkinDays(who),
      this.#frames(who),
      ledger.entries(this.#d.profile, who.wallet, { limit: RECENT_LINES }),
      this.deals.view(who),
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
        singing: this.#singing(),
        stage: this.#stageUp(),
        cooling: this.#cooling(today),
        owned: new Set(frames.owned),
      }),
      frames,
      hungry: hunger === null ? null : hungerWord(hunger, c.full_below),
      recent: recent.map((r) => this.#line(r)),
      deals,
      on_board: await ledger.onBoard(this.#d.profile, who.wallet),
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

  board(limit?: number): Promise<BoardLine[]> {
    return sponsorBoard(this, limit);
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
        { wallet: who.wallet },
      );
      if (post.status !== "posted") throw new EconomyError(409, ALREADY_CHECKED_IN);
      return { gained, streak, balance: post.balance };
    });
    await this.v2.afterEarn(who);
    return done;
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
      wallet: who.wallet,
      partial: true,
      caps: [
        { accounts: who.wallet, reasons: ["her_gift"], since, limit: c.her_gift_per_person },
        { accounts: null, reasons: ["her_gift"], since, limit: c.her_gift_total },
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
      wallet: who.wallet,
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
      { wallet: who.wallet },
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
      // She eats one at a time while she is still hungry; what she cannot eat is not bought.
      let eaten = 0;
      for (let h = hunger; eaten < count && h >= c.full_below; h -= HUNGER_OF[item]) eaten += 1;
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
    if (spent.fresh && ate !== null) {
      await this.#gift(who, spent.entry, ate, eaten, label);
      if (ate === "big_bowl") this.#bigBowl();
      this.#audit(who, "economy.feed", { item: ate, eaten, charged: -spent.entry.delta });
      // A feed may be what someone owed her for a deal.
      await this.deals.paid(who).catch((error: unknown) => {
        this.#d.log.warn({ err: errorMessage(error) }, "cannot check a deal against a feed");
      });
      await this.v2.afterEarn(who);
    }
    return {
      accepted: true,
      eaten,
      charged: -spent.entry.delta,
      balance: spent.balance,
      message: `她吃了${label}`,
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
        wallet: who.wallet,
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
    const wallet = person.accounts.map((a) => a.account);
    if (!wallet.some((a) => sameAccount(a, account))) wallet.push(account);
    const own = person.accounts.find((a) => sameAccount(a.account, account));
    return { account, person, wallet, name: own?.display_name ?? person.display_name };
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

  async letter(account: AccountRef, text: string, key: string): Promise<SpendResult> {
    const body = text.trim();
    const length = [...body].length;
    if (length < 1 || length > MAX_LETTER_CHARS) {
      throw new EconomyError(400, `信要 1 到 ${MAX_LETTER_CHARS} 個字`);
    }
    const who = await this.#known(account);
    const c = this.#d.config;
    const idem = `letter:${key}`;
    const spent = await this.#turns.run(async (): Promise<Spent | SpendResult> => {
      const first = await this.#first(who, idem);
      if (first) return first;
      if (!this.#passes(who, body)) return this.#refused(who, "這封信沒辦法送出");
      return this.#spend(who, c.letter, "letter", null, idem);
    });
    if (!("entry" in spent)) return spent;
    if (spent.fresh) {
      this.#deliverLetter(who, body, spent.entry);
      this.#announce(who, "letter", 1, "一封信");
      this.#audit(who, "economy.letter", { charged: c.letter, chars: length });
    }
    return {
      accepted: true,
      charged: -spent.entry.delta,
      balance: spent.balance,
      message: "信送出去了,她有空會看",
    };
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
      this.#d.publish(customEvent(SCREEN_TOPIC, screenEvent(name, body) as unknown as JsonValue));
      // Silent, like a letter: she may read it out when free, and a song is not interrupted.
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

  /** Moderation reads a letter as input and as text on a page; without it nothing passes. */
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

  async expression(
    account: AccountRef,
    expression: GiftExpression,
    key: string,
  ): Promise<SpendResult> {
    if (!GIFT_EXPRESSIONS.includes(expression)) throw new EconomyError(400, "沒有這個表情");
    const who = await this.#known(account);
    const c = this.#d.config;
    const idem = `expression:${key}`;
    const minutes = this.#cooldownMinutes();
    const spent = await this.#turns.run(async (): Promise<Spent | SpendResult> => {
      const first = await this.#first(who, idem);
      if (first) return first;
      if (this.#cooling(await this.#todayRows(who))) {
        throw new EconomyError(429, `每 ${minutes} 分鐘只能送一次表情`);
      }
      if (!this.#stageUp()) return this.#refused(who, "她現在沒有開台");
      if (this.#singing()) return this.#refused(who, "她正在唱歌,等她唱完再送");
      return this.#spend(who, c.expression, "expression", expression, idem);
    });
    if (!("entry" in spent)) return spent;
    const failed = "表情沒有送出去,已經退回";
    if (!spent.fresh) {
      if (await this.#refunded(who, spent.entry)) return this.#refused(who, failed);
      return {
        accepted: true,
        charged: -spent.entry.delta,
        balance: spent.balance,
        message: "她收到了",
      };
    }
    // The stage is asked outside the turns: it holds the face for seconds.
    const shown = !this.#singing() && (await this.#expressOnStage(expression, EXPRESSION_SECONDS));
    if (!shown) {
      const balance = await this.#turns.run(() => this.#refund(who, spent.entry));
      return { accepted: false, charged: 0, balance, message: failed };
    }
    await this.#gift(who, spent.entry, null, 1, `表情「${EXPRESSION_NAME[expression]}」`);
    this.#audit(who, "economy.expression", { expression, charged: c.expression });
    return {
      accepted: true,
      charged: c.expression,
      balance: await this.#balance(who),
      message: "她收到了",
    };
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
    if (typeof req.select === "string") named(req.select);
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
          who.account,
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
    item: FeedItem | null,
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
    this.#d.publish(customEvent(SOCIAL_EVENT_TOPIC, payload));
    await this.#bond(who);
    this.#perceive(who, entry, `${safeName(who.name)}送了你${label}`);
    this.#announce(who, item ?? "expression", count, label);
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
    this.#d.publish(customEvent(GIFT_TOPIC, gift as unknown as JsonValue));
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

  /**
   * A letter is hers to read when she is free: an Observation in her working context, or,
   * without the EventLog, a notice for wherever she talks next. Neither opens a turn.
   */
  #deliverLetter(who: Member, text: string, entry: CoinEntry): void {
    const summary = `${safeName(who.name)}寫了一封信給你:「${text}」`;
    if (this.#perceive(who, entry, summary)) return;
    const now = this.#d.clock.now();
    this.#d.publish(
      v2Event(NOTICE_TOPIC, {
        id: newId(),
        at: toTimestamp(now),
        source: "economy",
        task: null,
        turn: null,
        context: null,
        ok: true,
        code: null,
        text: summary,
        expires_at: toTimestamp(now + LETTER_TTL_MS),
      }),
    );
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
