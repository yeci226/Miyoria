// Economy 2.0 for the admins: the economy as a whole, never one person's coins (the people routes
// have those). Every answer of the economy routes carries the currency's name.

import { z } from "zod";
import { route } from "./route.js";
import { SpaceQuery } from "./shared.js";

/**
 * The server a per-server thing belongs to or a list is narrowed to: identity's id (what `?space=`
 * takes) and its name (`null` once she left it).
 */
export const ListedSpaceSchema = z
  .object({ id: z.string(), name: z.string().nullable() })
  .meta({ id: "ApiListedSpace" });
export type ListedSpace = z.output<typeof ListedSpaceSchema>;

/** One day of coins issued against coins recovered. */
export const HealthDaySchema = z
  .object({
    /** The local day number. */
    day: z.number(),
    /** When it starts. */
    date: z.string(),
    issued: z.number(),
    recovered: z.number(),
    /** `recovered / issued`; `null` on a day nothing was issued. */
    ratio: z.number().nullable(),
  })
  .meta({ id: "ApiHealthDay" });
export type HealthDay = z.output<typeof HealthDaySchema>;

/**
 * `GET /api/economy/health`. `available` is `false` until a store provides the ledger totals; then
 * there are no days, not made-up ones.
 */
export const EconomyHealthSchema = z
  .object({
    currency: z.string(),
    available: z.boolean(),
    days: z.array(HealthDaySchema),
    /** The last seven days together. */
    week: z.object({ issued: z.number(), recovered: z.number(), ratio: z.number().nullable() }),
    /** A sentence when the week recovered too little of what was issued, else `null`. */
    warn: z.string().nullable(),
  })
  .meta({ id: "ApiEconomyHealth" });
export type EconomyHealth = z.output<typeof EconomyHealthSchema>;

/**
 * Who settled a prediction: `auto` (what it was bound to came out, or could not be told), `her`,
 * `admin` (by hand) or `expired` (nobody could tell in time).
 */
export const PredictionSettledBySchema = z
  .object({
    by: z.enum(["auto", "her", "admin", "expired"]),
    note: z.string(),
    at: z.string(),
    who: z.string().nullable(),
  })
  .meta({ id: "ApiPredictionSettledBy" });
export type PredictionSettledBy = z.output<typeof PredictionSettledBySchema>;

/** A prediction people can stake on. `my_bet` is always `null` here: this is not one person's view. */
export const PredictionViewSchema = z
  .object({
    /** The short code people and her tools name it by. */
    id: z.string(),
    /**
     * The server it belongs to: only its members see it and may bet. `null`: of no server (opened
     * while she knew of none), open to everyone she knows.
     */
    space: ListedSpaceSchema.nullable(),
    question: z.string(),
    options: z.array(
      z.object({
        label: z.string(),
        /** Coins staked on it, and by how many people. */
        staked: z.number(),
        backers: z.number(),
        /** What one coin on it would return if it won now; `null` while nobody backs it. */
        multiplier: z.number().nullable(),
      }),
    ),
    /** Everything staked. */
    total: z.number(),
    closes_at: z.string(),
    /** `closed`: betting ended and the result is not called yet. */
    status: z.enum(["open", "closed", "resolved", "cancelled"]),
    winner: z.string().nullable(),
    /** How it is settled: by her, or by itself on the soup or game goal it is bound to. */
    settles: z.object({ kind: z.enum(["her", "soup", "goal"]), label: z.string() }),
    /** Who settled it and how; `null` while it is open. `who`: the operator, for the owner only. */
    settled_by: PredictionSettledBySchema.nullable(),
    my_bet: z
      .object({
        option: z.string(),
        amount: z.number(),
        outcome: z.enum(["open", "won", "lost", "refunded"]),
        payout: z.number(),
      })
      .nullable(),
  })
  .meta({ id: "ApiPredictionView" });
export type PredictionView = z.output<typeof PredictionViewSchema>;

/** What settling or calling off a prediction did. */
export const PredictionSettledSchema = z
  .object({
    id: z.string(),
    /** The winning option; `null` when every stake went back. */
    winner: z.string().nullable(),
    winners: z.number(),
    pool: z.number(),
    /** What went back to people. */
    paid: z.number(),
    /** The cut burned. */
    rake: z.number(),
    refunded: z.boolean(),
  })
  .meta({ id: "ApiPredictionSettled" });
export type PredictionSettled = z.output<typeof PredictionSettledSchema>;

/** Body of `POST /api/economy/predictions/{id}/resolve`: the winning option, by number from 1 or words. */
export const PredictionResolveRequestSchema = z
  .strictObject({ option: z.string().trim().min(1).max(24) })
  .meta({ id: "ApiPredictionResolveRequest" });
export type PredictionResolveRequest = z.input<typeof PredictionResolveRequestSchema>;

/** One item of her room, with how far the audience got. */
export const RoomItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["furniture", "outfit", "background"]),
    kind_label: z.string(),
    price: z.number(),
    funded: z.number(),
    /** How many people gave; never who, and never ranked. */
    backers: z.number(),
    placed: z.boolean(),
  })
  .meta({ id: "ApiRoomItem" });
export type RoomItem = z.output<typeof RoomItemSchema>;

/**
 * Today's three quests as one person sees them (empty for a stranger): one with her, one with
 * other people, one she thought of for them from what she remembers.
 */
export const QuestsViewSchema = z
  .object({
    currency: z.string(),
    quests: z.array(
      z.object({
        id: z.enum(["new_topic", "together", "her_pick"]),
        /** What to do; for `her_pick` her own words once she wrote today's. */
        label: z.string(),
        /** How it gets done (who ticks it). */
        hint: z.string(),
        done: z.boolean(),
        /**
         * `her_pick` only: `her` (from her memories of them), `fallback` (one of the plain ones),
         * `null` while today's is not chosen yet (the person has not looked).
         */
        by: z.enum(["her", "fallback"]).nullable(),
      }),
    ),
    /** What each pays, and what finishing all three adds. */
    reward: z.number(),
    bonus: z.number(),
    bonus_done: z.boolean(),
    earned_today: z.number(),
    cap: z.number(),
  })
  .meta({ id: "ApiQuestsView" });
export type QuestsView = z.output<typeof QuestsViewSchema>;

export const economy = {
  health: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/health" })
    .output(EconomyHealthSchema),
  /**
   * The open predictions and the ones settled lately: of the server `?space=` names, or of every
   * server without it.
   */
  predictions: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/predictions" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(z.object({ currency: z.string(), predictions: z.array(PredictionViewSchema) })),
  /**
   * Settles an open prediction by hand, the ones that settle by themselves too (`409`: it is not
   * open any more). Needs `admin.economy.adjust`, like a hand on someone's coins.
   */
  resolvePrediction: route
    .meta({ audience: "admin", permission: "admin.economy.adjust" })
    .route({ method: "POST", path: "/api/economy/predictions/{id}/resolve" })
    .input(z.object({ params: z.object({ id: z.string() }), body: PredictionResolveRequestSchema }))
    .output(z.object({ currency: z.string(), settled: PredictionSettledSchema })),
  /** Calls an open prediction off by hand: every stake goes back. */
  cancelPrediction: route
    .meta({ audience: "admin", permission: "admin.economy.adjust" })
    .route({ method: "POST", path: "/api/economy/predictions/{id}/cancel" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(z.object({ currency: z.string(), settled: PredictionSettledSchema })),
  /** Her room, every item with how far the audience got. */
  room: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/room" })
    .output(z.object({ currency: z.string(), room: z.array(RoomItemSchema) })),
};

/** The one economy route that is about a person; it joins the `people` group. */
export const peopleEconomy = {
  /** Today's three quests as that person sees them; `404` for someone she does not know. */
  quests: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}/quests" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(QuestsViewSchema),
};
