// Economy 2.0 for the admins: the economy as a whole, never one person's coins (the people routes
// have those). Every answer of the economy routes carries the currency's name.

import { z } from "zod";
import { route } from "./route.js";

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

/** A prediction people can stake on. `my_bet` is always `null` here: this is not one person's view. */
export const PredictionViewSchema = z
  .object({
    /** The short code people and her tools name it by. */
    id: z.string(),
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

/** Today's three quests as one person sees them (empty for a stranger). */
export const QuestsViewSchema = z
  .object({
    currency: z.string(),
    quests: z.array(
      z.object({
        id: z.enum(["new_topic", "play_game", "listen_song"]),
        label: z.string(),
        done: z.boolean(),
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
  /** The open predictions and the ones settled lately. */
  predictions: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/predictions" })
    .output(z.object({ currency: z.string(), predictions: z.array(PredictionViewSchema) })),
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
