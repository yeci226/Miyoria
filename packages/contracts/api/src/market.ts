// The weekly market (docs/design/v5-play.md §11.4): the auction and the lottery as a member sees
// them (the lot now, the top bid and its bidder's name, their own bid and bids; the week's lottery,
// the pot so far and their own tickets) and what they do there (bid, name a won name lot or give it
// up, buy tickets), and the owner's side: set or skip the coming week's lot, settle now, history.
// Without the `market` module these are a `503` that names it. Nobody else's tickets are shown
// before a draw; a bid is public, like the notice in Discord.
//
// Every route is about one Space's market (`?space=`, `SpaceQuery`): a member's own server by
// default (preferring the primary), the primary on the owner's side.

import { z } from "zod";
import { IdempotencyHeaders, route } from "./route.js";
import { SpaceQuery } from "./shared.js";

/** The node of the owner's hand on the market (the same as on someone's coins). */
const NODE_MARKET = "admin.economy.adjust";

export const LotKindSchema = z.enum(["call_name", "frame"]).meta({ id: "ApiLotKind" });

/** One lot as people see it. */
export const LotViewSchema = z
  .object({
    id: z.string(),
    /** The local day number it opens on. */
    week: z.number().int(),
    kind: LotKindSchema,
    /** 「這一週她怎麼叫你」, 「只此一件的卡框」. */
    name: z.string(),
    detail: z.string(),
    /** `open`: taking bids; `naming`: the winner's name is awaited; `applied`: the name is in use. */
    state: z.enum(["open", "closing", "naming", "applied", "done", "refunded", "cancelled"]),
    picked_by: z.enum(["owner", "her", "rotation"]),
    opens_at: z.string(),
    ends_at: z.string(),
    extended: z.boolean(),
    opening_bid: z.number().int(),
    step: z.number().int(),
    /** The smallest bid that would lead now; null when it takes no bids. */
    min_bid: z.number().int().nullable(),
    top: z.object({ amount: z.number().int(), name: z.string() }).nullable(),
    bids: z.number().int(),
    bidders: z.number().int(),
    winner: z.object({ name: z.string(), price: z.number().int() }).nullable(),
    call_name: z.string().nullable(),
    name_due: z.string().nullable(),
    applied_until: z.string().nullable(),
  })
  .meta({ id: "ApiLotView" });
export type LotView = z.output<typeof LotViewSchema>;

/** `GET /api/member/market/auction`. */
export const AuctionViewSchema = z
  .object({
    currency: z.string(),
    /** On, with a channel. */
    running: z.boolean(),
    lot: LotViewSchema.nullable(),
    /** The next opening and the owner's plan for it (`null`: she picks; `skip`). */
    next: z
      .object({
        opens_at: z.string(),
        plan: z.union([LotKindSchema, z.literal("skip")]).nullable(),
      })
      .nullable(),
    mine: z.object({ amount: z.number().int(), leading: z.boolean(), won: z.boolean() }).nullable(),
    /** The newest bids, newest first. */
    history: z.array(z.object({ amount: z.number().int(), name: z.string(), at: z.string() })),
  })
  .meta({ id: "ApiAuctionView" });
export type AuctionView = z.output<typeof AuctionViewSchema>;

const WeekStatus = z.enum(["open", "drawing", "drawn", "refunding", "refunded"]);

/** A week that was drawn (or refunded). */
export const LotteryResultSchema = z
  .object({
    week: z.number().int(),
    state: z.enum(["drawn", "refunded"]),
    drawn_at: z.string().nullable(),
    tickets: z.number().int(),
    buyers: z.number().int(),
    pot: z.number().int(),
    prize: z.number().int(),
    burned: z.number().int(),
    /** The winner's display name; null when refunded. */
    winner: z.string().nullable(),
  })
  .meta({ id: "ApiLotteryResult" });
export type LotteryResult = z.output<typeof LotteryResultSchema>;

/** `GET /api/member/market/lottery`. */
export const LotteryViewSchema = z
  .object({
    currency: z.string(),
    running: z.boolean(),
    price: z.number().int(),
    per_person: z.number().int(),
    min_buyers: z.number().int(),
    prize_share: z.number(),
    week: z.number().int(),
    state: WeekStatus,
    draw_at: z.string(),
    tickets: z.number().int(),
    buyers: z.number().int(),
    pot: z.number().int(),
    mine: z.object({ tickets: z.number().int() }).nullable(),
    last: LotteryResultSchema.nullable(),
  })
  .meta({ id: "ApiLotteryView" });
export type LotteryView = z.output<typeof LotteryViewSchema>;

/** `GET /api/member/market/bids`: the lots they bid on, newest first. */
export const MyBidsSchema = z
  .object({
    bids: z.array(
      z.object({
        lot: z.string(),
        week: z.number().int(),
        kind: LotKindSchema,
        name: z.string(),
        amount: z.number().int(),
        state: z.enum(["leading", "outbid", "won", "lost", "cancelled", "refunded"]),
        at: z.string(),
      }),
    ),
  })
  .meta({ id: "ApiMyBids" });
export type MyBids = z.output<typeof MyBidsSchema>;

/** `GET /api/member/market/tickets`: the weeks they bought tickets in, newest first. */
export const MyTicketsSchema = z
  .object({
    weeks: z.array(
      z.object({
        week: z.number().int(),
        draw_at: z.string(),
        tickets: z.number().int(),
        paid: z.number().int(),
        state: WeekStatus,
        won: z.boolean(),
        prize: z.number().int(),
      }),
    ),
  })
  .meta({ id: "ApiMyTickets" });
export type MyTickets = z.output<typeof MyTicketsSchema>;

/** Body of `POST /api/member/market/bid`. */
export const BidRequestSchema = z
  .strictObject({ amount: z.number().int().positive() })
  .meta({ id: "ApiBidRequest" });
export type BidRequest = z.input<typeof BidRequestSchema>;

export const BidResultSchema = z
  .object({
    amount: z.number().int(),
    ends_at: z.string(),
    extended: z.boolean(),
    balance: z.number().nullable(),
  })
  .meta({ id: "ApiBidResult" });
export type BidResult = z.output<typeof BidResultSchema>;

/** Body of `POST /api/member/market/name`: the name, or giving the won name lot up. */
export const NameRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(40).optional(),
    give_up: z.boolean().optional(),
  })
  .meta({ id: "ApiLotNameRequest" });
export type NameRequest = z.input<typeof NameRequestSchema>;

export const NameResultSchema = z
  .object({
    call_name: z.string().nullable(),
    applied_until: z.string().nullable(),
    /** Coins given back when it was given up. */
    refunded: z.number().int(),
  })
  .meta({ id: "ApiLotNameResult" });
export type NameResult = z.output<typeof NameResultSchema>;

/** Body of `POST /api/member/market/lottery`. */
export const TicketRequestSchema = z
  .strictObject({ count: z.number().int().positive() })
  .meta({ id: "ApiTicketRequest" });
export type TicketRequest = z.input<typeof TicketRequestSchema>;

export const TicketResultSchema = z
  .object({
    count: z.number().int(),
    /** Their tickets this week now. */
    mine: z.number().int(),
    charged: z.number().int(),
    balance: z.number().nullable(),
  })
  .meta({ id: "ApiTicketResult" });
export type TicketResult = z.output<typeof TicketResultSchema>;

/** Body of `POST /api/market/plan`: the coming week's lot, or no lot that week. */
export const LotPlanRequestSchema = z
  .strictObject({
    lot: z.union([LotKindSchema, z.literal("skip")]),
    note: z.string().max(200).optional(),
  })
  .meta({ id: "ApiLotPlanRequest" });
export type LotPlanRequest = z.input<typeof LotPlanRequestSchema>;

export const LotPlanSchema = z
  .object({
    week: z.number().int(),
    opens_at: z.string(),
    plan: z.union([LotKindSchema, z.literal("skip")]),
  })
  .meta({ id: "ApiLotPlan" });
export type LotPlan = z.output<typeof LotPlanSchema>;

/** Body of `POST /api/market/settle`. */
export const SettleRequestSchema = z
  .strictObject({ what: z.enum(["auction", "lottery"]) })
  .meta({ id: "ApiMarketSettleRequest" });
export type SettleRequest = z.input<typeof SettleRequestSchema>;

/** `GET /api/market/history`: the lots that ran and the weeks drawn, newest first. */
export const MarketHistorySchema = z
  .object({
    lots: z.array(
      LotViewSchema.extend({ note: z.string().nullable(), price: z.number().int().nullable() }),
    ),
    weeks: z.array(LotteryResultSchema),
    /** The lot kinds the config offers (`auction_lots`): what a plan may name. */
    offered: z.array(LotKindSchema),
    /** The coming opening and the owner's plan for it, as the member view has it; `null`: off. */
    next: z
      .object({
        opens_at: z.string(),
        plan: z.union([LotKindSchema, z.literal("skip")]).nullable(),
      })
      .nullable(),
  })
  .meta({ id: "ApiMarketHistory" });
export type MarketHistory = z.output<typeof MarketHistorySchema>;

const member = () => route.meta({ audience: "member", permission: null, limited: true });

/** The member's side: needs a session (by cookie), limited per account. */
export const market = {
  auction: member()
    .route({ method: "GET", path: "/api/member/market/auction" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(AuctionViewSchema),
  bids: member()
    .route({ method: "GET", path: "/api/member/market/bids" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(MyBidsSchema),
  lottery: member()
    .route({ method: "GET", path: "/api/member/market/lottery" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(LotteryViewSchema),
  tickets: member()
    .route({ method: "GET", path: "/api/member/market/tickets" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(MyTicketsSchema),
  /** A bid on the open lot (`409` with a sentence when it is too low or nothing is open). */
  bid: member()
    .route({ method: "POST", path: "/api/member/market/bid" })
    .input(z.object({ query: SpaceQuery.optional(), body: BidRequestSchema }))
    .output(BidResultSchema),
  /** The winner of a name lot gives the name (or gives it up for a full refund). */
  name: member()
    .route({ method: "POST", path: "/api/member/market/name" })
    .input(z.object({ query: SpaceQuery.optional(), body: NameRequestSchema }))
    .output(NameResultSchema),
  /** Tickets of this week; the same `Idempotency-Key` is the same purchase. */
  buy: member()
    .route({ method: "POST", path: "/api/member/market/lottery" })
    .input(
      z.object({
        query: SpaceQuery.optional(),
        headers: IdempotencyHeaders,
        body: TicketRequestSchema,
      }),
    )
    .output(TicketResultSchema),
};

/** The owner's side. */
export const marketAdmin = {
  history: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/market/history" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(MarketHistorySchema),
  /** Sets or skips the coming week's lot; `409` when this week's has opened (it is then next week's). */
  plan: route
    .meta({ audience: "admin", permission: NODE_MARKET })
    .route({ method: "POST", path: "/api/market/plan" })
    .input(z.object({ query: SpaceQuery.optional(), body: LotPlanRequestSchema }))
    .output(LotPlanSchema),
  /** Ends the open lot now, or draws this week's lottery now; `409` when there is none. */
  settle: route
    .meta({ audience: "admin", permission: NODE_MARKET })
    .route({ method: "POST", path: "/api/market/settle" })
    .input(z.object({ query: SpaceQuery.optional(), body: SettleRequestSchema }))
    .output(z.object({ ok: z.literal(true) })),
};
