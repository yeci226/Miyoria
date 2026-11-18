// Picture messages (docs/design/v5-play.md §9, §11.5): what she sends in Discord as a computed
// picture instead of a block of text. A template is a typed function from data to an SVG
// (`@miyoria/card-face/pictures`); the api module draws it to a PNG with the bundled fonts, keeps it
// in the artifact store and hands it back with a one-line summary for the alt text. Any module
// builds the data it owns and asks through `PicturesKey`; the member's own pictures are put together
// from what their member page already shows them (`forMember`). Every call answers `null` when it
// cannot draw (no renderer, a bad picture, a failure), never throws, so a caller always falls back
// to its text.
//
// Numbers follow the member page's rule: a member's own pictures carry no bond, trust or
// familiarity number, only the words and the ring's coarse position. Only the owner's variant of
// the profile has the numbers.

import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** The wallet: this week's coins in and out, by reason and by day, and the balance. */
export interface WalletPictureData {
  /** Whose wallet: their display name. */
  name: string;
  /** The currency's name (`魚幣`). */
  currency: string;
  balance: number;
  /** Consecutive check-in days, today included when done; `null`: not shown. */
  streak: number | null;
  /** The week's local days, oldest first: what came in and what went out (both 0 or more). */
  days: { date: string; income: number; spending: number }[];
  /** What came in this week by reason, any order (the picture sorts it); amounts above 0. */
  income: { label: string; amount: number }[];
  /** What went out this week by reason; amounts above 0. */
  spending: { label: string; amount: number }[];
}

/** The bond ring's position as a member may see it (`publicBond`). */
export interface PictureRing {
  /** The lap being filled, 0..9. */
  lap: number;
  /** How full that lap is, 0..1. */
  fraction: number;
  full: boolean;
  /** How far below 0, 0..1; 0 for a bond of 0 or more. */
  below: number;
}

/** A member's own card: the ring and the words of their member page, no number. */
export interface MemberProfilePicture {
  variant: "member";
  name: string;
  ring: PictureRing;
  /** The tier with its stage: 「知心 II」. */
  tier_label: string;
  /** The next step; `null` at the top. */
  next_label: string | null;
  /** How far into the tier, 0..1 in twentieths. */
  tier_progress: number;
  /** `bondBand`'s words. */
  closeness: string;
  /** `trustBand`'s words. */
  trust: string;
  /** `familiarityBand`'s words. */
  familiarity: string;
  /** What she calls them; `null`: not set. */
  call_name: string | null;
  /** The line she wrote for their page, already checked as the page checks it; `null`: none. */
  feeling: string | null;
}

/** The owner's look at someone: the ring with the bond on it and the eight numbers. */
export interface AdminProfilePicture {
  variant: "admin";
  name: string;
  /** -100..1000. */
  bond: number;
  ring: PictureRing;
  tier_label: string;
  next_label: string | null;
  tier_progress: number;
  values: {
    /** 0..100. */
    trust: number;
    /** 0..100. */
    familiarity: number;
    /** -1..1. */
    warmth: number;
    /** -1..1. */
    respect: number;
    /** 0..1. */
    ease: number;
    /** 0..1. */
    grudge: number;
    /** 0..1. */
    longing: number;
    /** 0..1. */
    rapport: number;
  };
  call_name: string | null;
  tags: string[];
  interactions: number;
}

export type ProfilePictureData = MemberProfilePicture | AdminProfilePicture;

/** Someone's week, from what their member page shows them. */
export interface WeekPictureData {
  name: string;
  /** Their own lines per local day, oldest first (seven days, today last). */
  days: { date: string; text: number; voice: number }[];
  /** Songs they asked for this week, newest first, and how many. */
  songs: { title: string; artist: string | null }[];
  song_count: number;
  /** Cards they got this week by rarity (`N`, `R`, `SR`, `SSR`, or `其他` for older cards). */
  cards: { rarity: string; count: number }[];
  /** Coins this week; `null` without a wallet. */
  coins: { currency: string; earned: number; spent: number } | null;
}

/** Someone's card dex: series, parts, cards by rarity, the pity. */
export interface DexPictureData {
  name: string;
  parts: { owned: number; total: number };
  series: { name: string; owned: number; total: number; title: string; complete: boolean }[];
  /** Cards they have by rarity, lowest first. */
  rarities: { rarity: string; count: number }[];
  titles: string[];
  /** Cards in a row without SR or better, and how many until the next is guaranteed one. */
  pity: { since: number; pity: number; until: number } | null;
}

/** The public odds of a daily card. */
export interface OddsPictureData {
  currency: string;
  price: number;
  per_day: number;
  /** After this many cards without SR or better the next one is; `null`: no pity. */
  pity_after: number | null;
  /** `shown` is a percentage with two decimals, without the sign (`"12.50"`). */
  rarities: { rarity: string; shown: string }[];
  slots: { name: string; parts: { name: string; rarity: string; shown: string }[] }[];
}

/**
 * The week's lottery (docs/design/v5-play.md §11.4), filled by the market (`@miyoria/play/market`).
 * Times are ISO 8601; they are drawn in `utc_offset_minutes`.
 */
export interface LotteryPictureData {
  /** `open`: selling tickets; `drawn`: the result is in; `cancelled`: too few came, all refunded. */
  state: "open" | "drawn" | "cancelled";
  currency: string;
  ticket_price: number;
  /** Most tickets one person may buy this week. */
  per_person: number;
  /** Fewer players than this and the draw is cancelled. */
  min_players: number;
  /** Share of the pot paid out (0.7); the rest is burned. */
  prize_share: number;
  tickets: number;
  players: number;
  /** Every coin paid in this week. */
  pot: number;
  draw_at: string;
  utc_offset_minutes: number;
  /** The viewer's own tickets; `null` when the picture is for no one in particular. */
  mine: { tickets: number } | null;
  /** After the draw: who won what; empty when cancelled. */
  winners: { name: string; prize: number }[];
}

/** One auction (docs/design/v5-play.md §11.4), filled by the market (`@miyoria/play/market`). */
export interface AuctionPictureData {
  state: "upcoming" | "open" | "closed" | "cancelled";
  /** What is sold: 「這一週她怎麼叫你」, 「只此一件的卡框」. */
  item: { name: string; detail: string | null };
  currency: string;
  start_bid: number;
  /** The smallest step over the top bid. */
  step: number;
  opens_at: string;
  ends_at: string;
  /** The end moved because someone bid in the last minutes. */
  extended: boolean;
  utc_offset_minutes: number;
  /** The highest bid so far and who made it (a display name); `null`: none yet. */
  top: { amount: number; name: string } | null;
  bids: number;
  bidders: number;
  /** The viewer's own highest bid; `null` when none or for no one in particular. */
  mine: { amount: number; leading: boolean } | null;
  /** The newest bids, newest first (at most a few are drawn). */
  history: { amount: number; name: string; at: string }[];
}

/** Every template and its data. */
export interface PictureDataMap {
  wallet: WalletPictureData;
  profile: ProfilePictureData;
  week: WeekPictureData;
  dex: DexPictureData;
  odds: OddsPictureData;
  lottery: LotteryPictureData;
  auction: AuctionPictureData;
}

export type PictureKind = keyof PictureDataMap;

/** The pictures of a member that the api puts together from their page's data. */
export type MemberPictureKind = "profile" | "wallet" | "week" | "dex" | "odds";

/** A drawn picture, ready to attach. */
export interface PictureFile {
  /** A file name for the attachment (`miyoria-wallet.png`). */
  name: string;
  data: Uint8Array;
  contentType: "image/png";
  /** One line with the important numbers: the alt text, and the text where pictures cannot go. */
  alt: string;
  /** The artifact it is kept as; `null` when the store was not there. */
  artifact_id: string | null;
}

/** Who a member picture is for: the account asking and the name to put on it. */
export interface PictureWho {
  account: AccountRef;
  name: string;
}

/** A member's picture: its summary always, the picture when it could be drawn. */
export interface MemberPictureResult {
  /** The one-line summary with the important numbers (the text when there is no picture). */
  alt: string;
  file: PictureFile | null;
}

export interface Pictures {
  /** Draws `kind` from data the caller put together. `null` when it cannot; never throws. */
  render<K extends PictureKind>(kind: K, data: PictureDataMap[K]): Promise<PictureFile | null>;
  /**
   * A member's own picture, from what their member page shows them (`odds` is the same for
   * everyone). `null` for someone she does not know or will not show, or with nothing to put
   * together; `file` is `null` when only the drawing failed, or when `draw: false` asked for the
   * summary alone (a panel's status line). Never throws.
   */
  forMember(
    who: PictureWho,
    kind: MemberPictureKind,
    options?: { draw?: boolean },
  ): Promise<MemberPictureResult | null>;
}

export const PicturesKey = serviceKey<Pictures>("Pictures");
