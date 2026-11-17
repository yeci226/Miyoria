// Economy 2.0 for the admins: the economy as a whole, never one person's coins (the people routes
// have those), and the goals people filled that she owes a promise for. Every answer of the
// economy routes carries the currency's name.

import { z } from "zod";
import { EmptyRequestSchema } from "./member.js";
import { route } from "./route.js";

/** The permission node of marking a reached goal kept. */
const NODE_ECONOMY_GOALS = "admin.economy.goals";

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

export const CommissionKindSchema = z
  .enum(["poem", "name", "tool", "song", "voice"])
  .meta({ id: "ApiCommissionKind" });
export type CommissionKind = z.output<typeof CommissionKindSchema>;

/** Something a person commissioned. */
export const CommissionViewSchema = z
  .object({
    id: z.string(),
    kind: CommissionKindSchema,
    label: z.string(),
    brief: z.string(),
    price: z.number(),
    status: z.enum(["open", "delivered", "declined", "expired"]),
    created_at: z.string(),
    due_at: z.string(),
    result: z.string().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: "ApiCommissionView" });
export type CommissionView = z.output<typeof CommissionViewSchema>;

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

/** A goal people filled, and whether she kept its promise. */
export const ReachedGoalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    promise: z.string(),
    target: z.number(),
    /** When it was reached. */
    reached_at: z.string().nullable(),
    /** When the promise was marked kept; `null` while it is owed. */
    fulfilled_at: z.string().nullable(),
    fulfilled_by: z.enum(["owner", "self"]).nullable(),
  })
  .meta({ id: "ApiReachedGoal" });
export type ReachedGoal = z.output<typeof ReachedGoalSchema>;

export const economy = {
  health: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/health" })
    .output(EconomyHealthSchema),
  /** What people commissioned that she has not handed in. */
  commissions: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/commissions" })
    .output(z.object({ currency: z.string(), commissions: z.array(CommissionViewSchema) })),
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
  /** The reached goals, newest first, with whether each was kept. */
  goals: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/goals" })
    .output(z.object({ goals: z.array(ReachedGoalSchema) })),
  /**
   * The owner marks a goal kept. `409` when it is not a reached goal or was marked already (by her
   * own `goal_done`, say): the first mark stands.
   */
  fulfill: route
    .meta({ audience: "admin", permission: NODE_ECONOMY_GOALS })
    .route({ method: "POST", path: "/api/economy/goals/{id}/fulfill" })
    .input(z.object({ params: z.object({ id: z.string() }), body: EmptyRequestSchema }))
    .output(z.object({ goal: ReachedGoalSchema })),
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
