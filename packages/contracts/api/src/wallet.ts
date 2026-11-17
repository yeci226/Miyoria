// Coins on the member page: the wallet of the person logged in, and nobody else's. A stranger (and
// a blocked person) reads an empty wallet and gets 403 for every spend, in the same words.
//
// A spend takes an `Idempotency-Key` header: the same key answers what it answered first. `402` is
// not enough coins, `409` a refusal in the words of the page, `429` a limit.

import { z } from "zod";
import { EmptyRequestSchema } from "./member.js";
import { IdempotencyHeaders, route } from "./route.js";

export const FeedItemSchema = z.enum(["rice", "big_bowl", "dessert"]).meta({ id: "ApiFeedItem" });
export type FeedItem = z.output<typeof FeedItemSchema>;

export const GiftExpressionSchema = z
  .enum(["heart", "blush", "squint"])
  .meta({ id: "ApiGiftExpression" });
export type GiftExpression = z.output<typeof GiftExpressionSchema>;

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
    /** `rice`, `letter`, `expression:heart`, `frame:sakura`, `card_reroll`, ... */
    id: z.string(),
    kind: z.enum(["feed", "letter", "expression", "frame", "card", "song", "stream", "fortune"]),
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

/** One deal as the wallet shows it. */
export const DealViewSchema = z
  .object({
    /** What she said she would do. */
    task: z.string(),
    /** `一碗白飯`, `3 碗白飯`. */
    reward_label: z.string(),
    status: z.enum(["open", "owed", "settled", "broken", "refunded"]),
    /** When the next deadline falls; `null` once it ended. */
    due_at: z.string().nullable(),
  })
  .meta({ id: "ApiDealView" });
export type DealView = z.output<typeof DealViewSchema>;

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
    /** Her deals with this person, newest first, at most 10. */
    deals: z.array(DealViewSchema),
    /** On the sponsor board (on unless they left; `false` for strangers). */
    on_board: z.boolean(),
  })
  .meta({ id: "ApiWalletView" });
export type WalletView = z.output<typeof WalletViewSchema>;

/** `POST /api/member/checkin`. */
export const CheckinResultSchema = z
  .object({ gained: z.number(), streak: z.number(), balance: z.number() })
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

/** Body of `POST /api/member/letter`. */
export const LetterRequestSchema = z
  .strictObject({ text: z.string().max(2_000) })
  .meta({ id: "ApiLetterRequest" });
export type LetterRequest = z.input<typeof LetterRequestSchema>;

/** Body of `POST /api/member/screen`: a message on the stream (`409` when she is not live). */
export const ScreenRequestSchema = z
  .strictObject({ text: z.string().max(500) })
  .meta({ id: "ApiScreenRequest" });
export type ScreenRequest = z.input<typeof ScreenRequestSchema>;

/** Body of `POST /api/member/expression`. */
export const ExpressionRequestSchema = z
  .strictObject({ expression: GiftExpressionSchema })
  .meta({ id: "ApiExpressionRequest" });
export type ExpressionRequest = z.input<typeof ExpressionRequestSchema>;

/** `POST /api/member/letter`, `/screen` and `/expression`. */
export const SpendResultSchema = z
  .object({
    accepted: z.boolean(),
    charged: z.number(),
    balance: z.number(),
    message: z.string(),
  })
  .meta({ id: "ApiSpendResult" });
export type SpendResult = z.output<typeof SpendResultSchema>;

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
    /** What left their wallet (and reached the other's). */
    sent: z.number(),
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
  /** Once a local day (the Discord command counts too); `409` after. */
  checkin: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/checkin" })
    .input(z.object({ body: EmptyRequestSchema }))
    .output(CheckinResultSchema),
  feed: spend("/api/member/feed", FeedRequestSchema).output(FeedResultSchema),
  letter: spend("/api/member/letter", LetterRequestSchema).output(SpendResultSchema),
  screen: spend("/api/member/screen", ScreenRequestSchema).output(SpendResultSchema),
  expression: spend("/api/member/expression", ExpressionRequestSchema).output(SpendResultSchema),
  /** Coins to another member (`403` in the same words for every reason they cannot take them). */
  transfer: spend("/api/member/transfer", TransferRequestSchema).output(TransferResultSchema),
  board: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/board" })
    .input(z.object({ body: BoardRequestSchema }))
    .output(BoardChoiceSchema),
  frame: spend("/api/member/frame", FrameRequestSchema).output(FramesResultSchema),
};
