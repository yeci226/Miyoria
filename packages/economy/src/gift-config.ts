// `[modules.economy.free_gifts]` (docs/design/economy.md §16): gifts a member names in their own
// words. The system estimates what a typical one costs in the real world, in New Taiwan dollars
// (one small model call, never a number the member writes), turns it into coins at the economy's
// one fixed rate (`[modules.economy] twd_per_coin`, the same one the exchange uses), the member
// confirms the price, and she decides whether she takes it.

import { z } from "zod";

/** The old scheme's tier prices (before 2026-11-21), for its cached and pinned rows. */
export const OLD_TIER_COINS = [5, 20, 50, 150] as const;

const coins = z.number().int().min(0);

export const FreeGiftConfigSchema = z
  .object({
    /** Members may name a gift in their own words (the fixed foods are not affected). */
    on: z.boolean().default(true),
    /** The cheapest a gift is (a candy rounds up to it). */
    min_coins: z.number().int().min(1).default(1),
    /**
     * A sanity ceiling only: an expensive thing is meant to be expensive, and a member can give
     * what their wallet holds. An estimate above this many coins is no answer (the fallback).
     */
    max_coins: z.number().int().min(1).max(100_000_000).default(1_000_000),
    /** The price when it cannot be estimated (no model, a failure, an absurd answer); not kept. */
    fallback_coins: z.number().int().min(1).default(50),
    /** Above this many coins the confirmation says it is a large gift and the balance after. */
    big_gift_coins: z.number().int().min(1).default(1_000),
    /**
     * Where the words she reads for the price change, in coins: up to the first 隨手的小東西 (about
     * two days of what being around earns), up to the second 有點心意 (weeks of it), up to the
     * third 很貴重 (months), above it 誇張. Tone only: no price moves bond.
     */
    band_coins: z
      .array(z.number().int().positive())
      .length(3)
      .default([100, 1_000, 10_000])
      .refine((b) => (b[0] ?? 0) < (b[1] ?? 0) && (b[1] ?? 0) < (b[2] ?? 0), {
        message: "band_coins go up",
      }),
    /**
     * How much hunger food takes off her, from its price in coins: `food_hunger_max` ×
     * coins ÷ (coins + `food_hunger_half_coins`), so a snack is a little and a feast is near the
     * most; a drink half of it. Never more than the giver's share left of `feed_hunger_cap`. Per
     * coin it is at most `food_hunger_max` ÷ `food_hunger_half_coins` (0.005), below a bowl of
     * rice's (0.015 for 10): a NT$60 drink takes about 0.09.
     */
    food_hunger_max: z.number().min(0).max(1).default(0.5),
    food_hunger_half_coins: z.number().positive().default(100),
    /** Longest gift name, in characters. */
    max_chars: z.number().int().min(4).max(40).default(24),
    /** How long the member has to press 確認 (seconds); after that it costs nothing and is gone. */
    confirm_s: z.number().int().min(30).max(1800).default(180),
    /**
     * How long she has to answer once it is confirmed (seconds); after that it is taken on her
     * behalf with a plain line, the way feeding never waits for her.
     */
    answer_s: z.number().int().min(30).max(3600).default(300),
    /** Gifts one person may give her in a local day (food and things together; `0`: none). */
    per_day: z.number().int().min(0).max(50).default(3),
    /** Coins one person may spend on these gifts in a local day; `0`: no cap. */
    coins_per_day: coins.default(0),
    /** Gifts that are not food or drink, per person per local day. */
    objects_per_day: z.number().int().min(0).max(50).default(2),
    /** Price questions to the model one person may cause in a local day (cached names are free). */
    price_calls_per_person: z.number().int().min(0).max(100).default(5),
    /** Price questions to the model for everyone together in a local day. */
    price_calls_per_day: z.number().int().min(0).max(10_000).default(200),
    /** Longest wait for the price (seconds); then the fallback price is used. */
    price_timeout_s: z.number().int().min(1).max(60).default(15),
  })
  .refine((c) => c.min_coins <= c.max_coins, { message: "min_coins is above max_coins" });
export type FreeGiftConfig = z.output<typeof FreeGiftConfigSchema>;

/** The defaults, for `EconomyConfigSchema`. */
export const DEFAULT_FREE_GIFTS: FreeGiftConfig = FreeGiftConfigSchema.parse({});
