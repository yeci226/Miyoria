// Coins on the member page: the wallet of the person logged in, and nobody else's. A stranger (and
// a blocked person) reads an empty wallet and gets 403 for every spend, in the same words.
//
// A spend takes an `Idempotency-Key` header: the same key answers what it answered first. `402` is
// not enough coins, `409` a refusal in the words of the page, `429` a limit. A danmaku line is
// charged when it is sent and given back by itself when the overlay could not show it.

import { z } from "zod";
import { ListedSpaceSchema, PredictionViewSchema, QuestsViewSchema } from "./economy.js";
import { IssuedFortuneSchema } from "./fortune.js";
import { IdempotencyHeaders, route } from "./route.js";
import { SpaceQuery } from "./shared.js";

export const FeedItemSchema = z.enum(["rice", "big_bowl", "dessert"]).meta({ id: "ApiFeedItem" });
export type FeedItem = z.output<typeof FeedItemSchema>;

/** How hungry she is, in words: never the number. */
export const HungerSchema = z.enum(["full", "ok", "hungry", "starving"]).meta({ id: "ApiHunger" });
export type Hunger = z.output<typeof HungerSchema>;

/** What earns coins, with what is left of today's cap. */
export const EarnLineSchema = z
  .object({
    reason: z.enum(["checkin", "talked", "voice", "song", "her_gift"]),
    label: z.string(),
    amount: z.number(),
    earned_today: z.number(),
    cap: z.number(),
  })
  .meta({ id: "ApiEarnLine" });
export type EarnLine = z.output<typeof EarnLineSchema>;

export const ShopItemSchema = z
  .object({
    /** `rice`, `frame:sakura`, `card_foil`, ... */
    id: z.string(),
    kind: z.enum(["feed", "frame", "card", "stream", "fortune"]),
    label: z.string(),
    price: z.number(),
    available: z.boolean(),
    /** Why it cannot be bought now. */
    why: z.string().nullable(),
  })
  .meta({ id: "ApiShopItem" });
export type ShopItem = z.output<typeof ShopItemSchema>;

export const LedgerLineSchema = z
  .object({ ts: z.string(), delta: z.number(), label: z.string() })
  .meta({ id: "ApiLedgerLine" });
export type LedgerLine = z.output<typeof LedgerLineSchema>;

/** `GET /api/member/wallet`. */
export const WalletViewSchema = z
  .object({
    currency: z.string(),
    balance: z.number(),
    can_earn: z.boolean(),
    today_earned: z.number(),
    checked_in_today: z.boolean(),
    /** Consecutive check-in days, today included when done. */
    streak: z.number(),
    earn: z.array(EarnLineSchema),
    shop: z.array(ShopItemSchema),
    frames: z.object({ owned: z.array(z.string()), selected: z.string().nullable() }),
    /** Words, never the number; `null` for someone she does not know. */
    hungry: HungerSchema.nullable(),
    /** Newest first, at most 20. */
    recent: z.array(LedgerLineSchema),
    /** On the sponsor board (on unless they left; `false` for strangers). */
    on_board: z.boolean(),
    /** What a sender pays on top of a transfer, as a share of it (rounded up, at least 1 coin); burned. */
    transfer_fee: z.number(),
  })
  .meta({ id: "ApiWalletView" });
export type WalletView = z.output<typeof WalletViewSchema>;

/** Body of `POST /api/member/checkin`: `fortune` adds today's fortune slip to the check-in (paid). */
export const CheckinRequestSchema = z
  .strictObject({ fortune: z.boolean().optional() })
  .meta({ id: "ApiCheckinRequest" });
export type CheckinRequest = z.input<typeof CheckinRequestSchema>;

/**
 * `POST /api/member/checkin`. With `fortune` asked: the slip (`fortune`, today's own when one was
 * drawn already, `fortune_charged` 0 then) or why there is none (`fortune_note`; the check-in
 * itself stands). `balance` is after the slip's price.
 */
export const CheckinResultSchema = z
  .object({
    gained: z.number(),
    streak: z.number(),
    balance: z.number(),
    fortune: IssuedFortuneSchema.optional(),
    fortune_charged: z.number().optional(),
    fortune_note: z.string().optional(),
  })
  .meta({ id: "ApiCheckinResult" });
export type CheckinResult = z.output<typeof CheckinResultSchema>;

/** Body of `POST /api/member/feed`. */
export const FeedRequestSchema = z
  .strictObject({ item: FeedItemSchema, count: z.number().int().min(1).max(5).optional() })
  .meta({ id: "ApiFeedRequest" });
export type FeedRequest = z.input<typeof FeedRequestSchema>;

/** `POST /api/member/feed`. Refused (she is full): `accepted` false, nothing charged. */
export const FeedResultSchema = z
  .object({
    accepted: z.boolean(),
    eaten: z.number(),
    charged: z.number(),
    balance: z.number(),
    message: z.string(),
  })
  .meta({ id: "ApiFeedResult" });
export type FeedResult = z.output<typeof FeedResultSchema>;

/** Body of `POST /api/member/screen`: a message on the stream (`409` when she is not live). */
export const ScreenRequestSchema = z
  .strictObject({ text: z.string().max(500) })
  .meta({ id: "ApiScreenRequest" });
export type ScreenRequest = z.input<typeof ScreenRequestSchema>;

/** `POST /api/member/screen`. */
export const SpendResultSchema = z
  .object({
    accepted: z.boolean(),
    charged: z.number(),
    balance: z.number(),
    message: z.string(),
  })
  .meta({ id: "ApiSpendResult" });
export type SpendResult = z.output<typeof SpendResultSchema>;

/**
 * `GET /api/member/danmaku`: what sending a danmaku line (a short line that crosses her stream)
 * costs this member now. `why` says, in the page's words, why they cannot send one right now
 * (`null`: they can); the send answers the same refusals.
 */
export const DanmakuViewSchema = z
  .object({
    /** Danmaku are on (the owner's setting). */
    open: z.boolean(),
    /** She is live and the overlay can take a line. */
    live: z.boolean(),
    currency: z.string(),
    price: z.number(),
    /** Longest line, in characters. */
    max_chars: z.number(),
    /** Seconds between two lines of one person. */
    cooldown_s: z.number(),
    per_day: z.number(),
    /** Lines of theirs today that were not given back. */
    sent_today: z.number(),
    /** Seconds until they may send the next one; `0` now. */
    wait_s: z.number(),
    balance: z.number(),
    why: z.string().nullable(),
  })
  .meta({ id: "ApiDanmakuView" });
export type DanmakuView = z.output<typeof DanmakuViewSchema>;

/** Body of `POST /api/member/danmaku`: one line (`409` when she is not live). */
export const DanmakuRequestSchema = z
  .strictObject({ text: z.string().max(500) })
  .meta({ id: "ApiDanmakuRequest" });
export type DanmakuRequest = z.input<typeof DanmakuRequestSchema>;

/** Body of `POST /api/member/transfer`. */
export const TransferRequestSchema = z
  .strictObject({
    /** The receiver is named by their Discord user id, in the body only. */
    to_discord_id: z.string().regex(/^[0-9]{1,25}$/),
    amount: z.number().int().min(1).max(1_000_000),
  })
  .meta({ id: "ApiTransferRequest" });
export type TransferRequest = z.input<typeof TransferRequestSchema>;

/** `POST /api/member/transfer`. */
export const TransferResultSchema = z
  .object({
    /** What reached the other's wallet. */
    sent: z.number(),
    /** The fee on top of it, taken from them and burned. */
    fee: z.number(),
    balance: z.number(),
    /** The receiver, as their ledger names them. */
    to: z.string(),
  })
  .meta({ id: "ApiTransferResult" });
export type TransferResult = z.output<typeof TransferResultSchema>;

/** Body of `POST /api/member/board`: join or leave the sponsor board. */
export const BoardRequestSchema = z
  .strictObject({ on: z.boolean() })
  .meta({ id: "ApiBoardRequest" });
export type BoardRequest = z.input<typeof BoardRequestSchema>;

/**
 * Which form of a board a member page asks for (the sponsor board, the exchange's rich list):
 * `space` (the default) is one server's members, the server `?space=` names or their own
 * (preferring the primary; someone who is a member nowhere gets everyone); `all` is everyone, as
 * on the public site. Coins and prices are global either way; only who is listed differs.
 */
export const BoardScopeQuery = z
  .object({ ...SpaceQuery.shape, scope: z.enum(["space", "all"]).optional() })
  .meta({ id: "ApiBoardScopeQuery" });
export type BoardScopeQueryIn = z.input<typeof BoardScopeQuery>;

/** `GET /api/member/board`: the sponsor board, of one server's members or of everyone. */
export const MemberBoardSchema = z
  .object({
    /** The server whose members are listed; `null`: everyone. */
    space: ListedSpaceSchema.nullable(),
    entries: z.array(
      z.object({
        rank: z.number(),
        /** The name they show (匿名 when it does not pass moderation). */
        name: z.string(),
        /** Coins spent on her over the board's window. */
        spent: z.number(),
      }),
    ),
  })
  .meta({ id: "ApiMemberBoard" });
export type MemberBoard = z.output<typeof MemberBoardSchema>;

/** `POST /api/member/board`. */
export const BoardChoiceSchema = z.object({ on_board: z.boolean() }).meta({ id: "ApiBoardChoice" });
export type BoardChoice = z.output<typeof BoardChoiceSchema>;

/** Body of `POST /api/member/frame`: buy a frame, select one (`null`: none), or both. */
export const FrameRequestSchema = z
  .strictObject({
    buy: z.string().max(64).optional(),
    select: z.string().max(64).nullable().optional(),
  })
  .meta({ id: "ApiFrameRequest" });
export type FrameRequest = z.input<typeof FrameRequestSchema>;

/** `POST /api/member/frame`. */
export const FramesResultSchema = z
  .object({ owned: z.array(z.string()), selected: z.string().nullable(), balance: z.number() })
  .meta({ id: "ApiFramesResult" });
export type FramesResult = z.output<typeof FramesResultSchema>;

/** Body of `POST /api/member/bet`: which prediction (its code), which option (number from 1 or words), how much. */
export const BetRequestSchema = z
  .strictObject({
    prediction: z.string().trim().min(1).max(32),
    option: z.string().trim().min(1).max(24),
    amount: z.number().int().min(1),
  })
  .meta({ id: "ApiBetRequest" });
export type BetRequest = z.input<typeof BetRequestSchema>;

/** `POST /api/member/bet`. */
export const BetResultSchema = z
  .object({
    prediction: z.string(),
    question: z.string(),
    option: z.string(),
    amount: z.number(),
    balance: z.number(),
    /** The key was used before: nothing new was staked. */
    duplicate: z.boolean(),
  })
  .meta({ id: "ApiBetResult" });
export type BetResult = z.output<typeof BetResultSchema>;

const spend = <B extends z.ZodType>(path: `/${string}`, body: B) =>
  route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path })
    .input(z.object({ headers: IdempotencyHeaders, body }));

export const wallet = {
  /** Their balance, what they can still earn today, the shop and their frames. */
  view: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/wallet" })
    .output(WalletViewSchema),
  /** Once a local day (the Discord command counts too); `409` after. Optionally with a paid fortune slip, which a day already checked in can still buy alone (`gained` 0). */
  checkin: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/checkin" })
    .input(z.object({ body: CheckinRequestSchema }))
    .output(CheckinResultSchema),
  feed: spend("/api/member/feed", FeedRequestSchema).output(FeedResultSchema),
  screen: spend("/api/member/screen", ScreenRequestSchema).output(SpendResultSchema),
  /** What a danmaku line costs this member now, and why they cannot send one (if so). */
  danmakuView: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/danmaku" })
    .output(DanmakuViewSchema),
  /**
   * A danmaku line on her stream (`409` when she is not live, `429` a limit): charged now, given
   * back by itself when the overlay could not show it.
   */
  danmaku: spend("/api/member/danmaku", DanmakuRequestSchema).output(SpendResultSchema),
  /** Coins to another member (`403` in the same words for every reason they cannot take them). */
  transfer: spend("/api/member/transfer", TransferRequestSchema).output(TransferResultSchema),
  board: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/board" })
    .input(z.object({ body: BoardRequestSchema }))
    .output(BoardChoiceSchema),
  /**
   * The sponsor board on the member page: one server's members (`404` an unknown server, `403`
   * one they are not in) or everyone (`scope=all`).
   */
  boardView: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/board" })
    .input(z.object({ query: BoardScopeQuery }).optional())
    .output(MemberBoardSchema),
  frame: spend("/api/member/frame", FrameRequestSchema).output(FramesResultSchema),
  /**
   * Today's three quests (`quests` is empty for someone she does not know). The first look of the
   * day has her think of the one she picks for them, so it may take a few seconds.
   */
  quests: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/quests" })
    .output(QuestsViewSchema),
  /**
   * The predictions open now and the ones settled lately, with their own stake (`my_bet`): of the
   * server `?space=` names (`404` unknown, `403` not theirs), else their own (preferring the
   * primary). Only that server's members may bet.
   */
  predictions: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/predictions" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(z.object({ currency: z.string(), predictions: z.array(PredictionViewSchema) })),
  /**
   * A stake on an option of an open prediction (`409` closed or already staked, `402` short, `429`
   * the day's limit, `403` someone she does not know or not a member of the prediction's server,
   * with the reason). The same `Idempotency-Key` is the same stake.
   */
  bet: spend("/api/member/bet", BetRequestSchema).output(BetResultSchema),
};
