import { z } from "zod";

const coins = z.number().int().nonnegative();

/** A card frame on sale; `id` is what the card stores. */
export const FrameSchema = z.object({
  /** Stored on cards: lower case letters, digits, `-` and `_`. */
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(32),
  price: z.number().int().positive(),
});
export type Frame = z.output<typeof FrameSchema>;

export const DEFAULT_FRAMES: Frame[] = [
  { id: "sakura", label: "櫻花", price: 100 },
  { id: "abyss", label: "深海", price: 150 },
  { id: "gold", label: "金框", price: 300 },
];

/** Rarities of a collectible, most common first (docs/design/cards.md §4). */
export const RARITIES = ["N", "R", "SR", "SSR"] as const;
export type Rarity = (typeof RARITIES)[number];

const slug = z.string().regex(/^[a-z0-9_-]{1,32}$/);

/** One collectible of a series (docs/design/cards.md §3: the traits a card is made of). */
export const CollectibleSchema = z.object({
  id: slug,
  label: z.string().min(1).max(32),
  rarity: z.enum(RARITIES),
});
export type Collectible = z.output<typeof CollectibleSchema>;

/** A set of collectibles; owning all of it earns a title and a one-time reward. */
export const SeriesSchema = z.object({
  id: slug,
  label: z.string().min(1).max(32),
  /** The title the person holds once they own every item. */
  title: z.string().min(1).max(16),
  items: z.array(CollectibleSchema).min(1).max(40),
});
export type Series = z.output<typeof SeriesSchema>;

export const DEFAULT_SERIES: Series[] = [
  {
    id: "glasses",
    label: "眼鏡系列",
    title: "眼鏡收藏家",
    items: [
      { id: "glasses_black", label: "黑框眼鏡", rarity: "N" },
      { id: "glasses_round", label: "圓框眼鏡", rarity: "R" },
      { id: "glasses_monocle", label: "單片眼鏡", rarity: "SR" },
      { id: "glasses_star", label: "星星眼鏡", rarity: "SSR" },
    ],
  },
  {
    id: "hands",
    label: "手上的東西",
    title: "牽手達人",
    items: [
      { id: "hand_none", label: "空著手", rarity: "N" },
      { id: "hand_foxtail", label: "狗尾草", rarity: "N" },
      { id: "hand_finger", label: "豎食指", rarity: "R" },
      { id: "hand_pot", label: "大鋼盆", rarity: "SR" },
    ],
  },
  {
    id: "sky",
    label: "背景系列",
    title: "旅行家",
    items: [
      { id: "bg_dusk", label: "黃昏漸層", rarity: "N" },
      { id: "bg_water", label: "水面", rarity: "R" },
      { id: "bg_stars", label: "星點", rarity: "R" },
      { id: "bg_night", label: "夜空", rarity: "SR" },
      { id: "bg_aurora", label: "極光", rarity: "SSR" },
    ],
  },
];

/** One piece of furniture, a costume or a background the audience funds together. */
export const RoomItemSchema = z.object({
  id: slug,
  label: z.string().min(1).max(32),
  kind: z.enum(["furniture", "outfit", "background"]),
  /** What it costs in all, in coins. */
  price: z.number().int().positive(),
});
export type RoomItem = z.output<typeof RoomItemSchema>;

export const DEFAULT_ROOM: RoomItem[] = [
  { id: "kotatsu", label: "暖桌", kind: "furniture", price: 400 },
  { id: "fish_lamp", label: "魚燈", kind: "furniture", price: 250 },
  { id: "pillow_pile", label: "抱枕山", kind: "furniture", price: 300 },
  { id: "yukata", label: "浴衣", kind: "outfit", price: 800 },
  { id: "bg_sakura", label: "櫻花背景", kind: "background", price: 500 },
];

/** One thing her weekly shop may stock. */
export const ShopStockSchema = z.object({
  id: slug,
  label: z.string().min(1).max(32),
  /** `title` adds a title to the buyer; `collectible` adds an item of a series (`item`). */
  kind: z.enum(["title", "collectible"]),
  price: z.number().int().positive(),
  /** The title's text, or the collectible's id in `collection_series`. */
  item: z.string().min(1).max(32),
});
export type ShopStock = z.output<typeof ShopStockSchema>;

export const DEFAULT_SHOP: ShopStock[] = [
  { id: "title_regular", label: "稱號「常客」", kind: "title", price: 60, item: "常客" },
  { id: "title_fishfan", label: "稱號「魚粉」", kind: "title", price: 60, item: "魚粉" },
  { id: "title_nightowl", label: "稱號「夜貓子」", kind: "title", price: 80, item: "夜貓子" },
  { id: "item_foxtail", label: "狗尾草", kind: "collectible", price: 45, item: "hand_foxtail" },
  { id: "item_water", label: "水面背景", kind: "collectible", price: 70, item: "bg_water" },
  { id: "item_round", label: "圓框眼鏡", kind: "collectible", price: 70, item: "glasses_round" },
  { id: "item_stars", label: "星點背景", kind: "collectible", price: 70, item: "bg_stars" },
];

/**
 * `[modules.economy]` (docs/design/economy.md): what people earn by being with her and what
 * feeding her and small gifts cost. A paid gift raises affinity by a hair (`gift_affinity`, capped
 * per day); it is mostly something she feels.
 *
 * ```toml
 * [modules.economy]
 * currency = "魚幣"
 * rice = 10
 * ```
 */
export const EconomyConfigSchema = z.object({
  /** Shown everywhere the coins are named. */
  currency: z.string().trim().min(1).max(16).default("魚幣"),
  /** Daily check-in, once per local day (the panel and Discord together). */
  checkin: coins.default(10),
  /** Extra on every 7th consecutive check-in day. */
  streak_bonus: coins.default(20),
  /** Once per local day she saw them say something (text or voice). */
  talked: coins.default(10),
  /** Per 10 minutes in her voice channel, when they spoke in that window. */
  voice_per_10min: coins.default(2),
  voice_cap: coins.default(20),
  /** A song they requested that she finished. */
  song_finished: coins.default(5),
  /** Finished songs paid per day. */
  song_cap: coins.default(3),
  /** Her `give_coins` tool: per person per day. */
  her_gift_per_person: coins.default(30),
  /** Her `give_coins` tool: everyone together per day. */
  her_gift_total: coins.default(100),
  /** A bowl of rice: hunger −0.15. */
  rice: coins.default(10),
  /** A big bowl (鋼盆): hunger −0.5, the 钢盆 expression a few seconds when the stage is up. */
  big_bowl: coins.default(40),
  /** Dessert: joy, hunger −0.05. */
  dessert: coins.default(25),
  /** A letter of up to 120 characters, read when she is free. */
  letter: coins.default(15),
  /** An expression (heart, blush, squint) while the stage is up and she is not singing. */
  expression: coins.default(20),
  /** One bought expression per person per this many seconds. */
  expression_cooldown_s: coins.default(600),
  /** Under this hunger she is full: a feed is refused and nothing is charged. */
  full_below: z.number().min(0).max(1).default(0.15),
  /** Gift emotion multiplier per earlier gift of the same person today. */
  diminish: z.number().min(0).max(1).default(0.6),
  /**
   * What one paid gift (a feed or an expression, not a letter) adds to affinity and trust before
   * the social engine's own diminishing returns: a hair, never a way to buy a friend.
   */
  gift_affinity: z.number().nonnegative().default(0.4),
  gift_trust: z.number().nonnegative().default(0.1),
  /** The most gifts alone add per person per day (they also count toward the overall caps). */
  gift_affinity_cap: z.number().nonnegative().default(1.5),
  gift_trust_cap: z.number().nonnegative().default(0.5),
  /** A deal (docs/design/economy.md §12): how long they have to pay after she says she did it. */
  deal_due_s: z.number().int().positive().default(600),
  /** A deal she has not done by then ends; escrow is refunded. */
  deal_timeout_s: z.number().int().positive().default(900),
  /** Deals one person may make per day. */
  deals_per_day: coins.default(5),
  /** How often unpaid deals expire and escrow times out. */
  deal_sweep_s: z.number().int().positive().default(30),
  /** Trust a deal that was paid adds (it counts toward the daily caps). */
  deal_kept_trust: z.number().nonnegative().default(0.3),
  /**
   * A broken promise (she did the task, they did not pay): what it takes off, outside the gain
   * caps. Each later one by the same person costs `broken_growth` times more, up to
   * `broken_cap` times the first.
   */
  broken_trust: z.number().nonnegative().default(4),
  broken_affinity: z.number().nonnegative().default(1.5),
  broken_growth: z.number().min(1).default(1.5),
  broken_cap: z.number().min(1).default(3),
  // Paid things beyond food and gifts (docs/design/economy.md §13): a price, and how many one
  // person may buy per local day (refunded ones do not count); `0` per day takes it off sale.
  /** Re-draw today's newest card: it is voided and she issues a new one (same day's count). */
  card_reroll: coins.default(30),
  card_rerolls_per_day: coins.default(2),
  /** Pick which picture of her goes on the next card, from the ones its affinity band allows. */
  card_pose: coins.default(20),
  card_poses_per_day: coins.default(5),
  /** A foil finish on the next card; looks only, like a frame. */
  card_foil: coins.default(50),
  card_foils_per_day: coins.default(5),
  /** One more song past the per-person limit; refunded when she does not sing it. */
  song_ticket: coins.default(25),
  song_tickets_per_day: coins.default(3),
  /** A dedication with a requested song: she says who it is for before singing; on the overlay. */
  dedication: coins.default(15),
  dedications_per_day: coins.default(3),
  /** A short message shown on the stream overlay (she may read it out). */
  screen_message: coins.default(30),
  screen_messages_per_day: coins.default(10),
  /** One screen message per person per this many seconds. */
  screen_message_cooldown_s: coins.default(600),
  /** A fortune slip she writes for them. */
  fortune: coins.default(10),
  fortunes_per_day: coins.default(1),
  // People with each other (docs/design/economy.md §13). `transfer_max = 0` or either daily limit
  // `0` closes transfers.
  /** The most one transfer may carry. */
  transfer_max: coins.default(50),
  /** What one person may send in a local day, and what one person may receive. */
  transfer_out_per_day: coins.default(100),
  transfer_in_per_day: coins.default(100),
  /** The sponsor board counts what was spent on her over this many days. */
  board_days: z.number().int().positive().max(365).default(30),
  // Her own purse (docs/design/economy.md §13): a share of every paid gift to her is hers.
  /** The share of a paid gift (feed, letter, expression, screen message, dedication) she keeps. */
  her_share: z.number().min(0).max(1).default(0.2),
  /** What she may treat one person to from her purse per day, and everyone together. */
  treat_per_person: coins.default(30),
  treat_total: coins.default(100),
  /** Expressions she may buy for herself per day (the price is `expression`). */
  self_expressions_per_day: coins.default(3),
  /** Crowdfunding goals: the most one may ask for, the longest it may run, one person's share. */
  goal_max_target: z.number().int().positive().default(2000),
  goal_max_days: z.number().int().positive().default(7),
  goal_pledge_max: z.number().int().positive().default(500),
  /** How long a finished goal stays on the list (and a reached one in her mind), in days. */
  goal_keep_days: z.number().int().positive().default(3),
  /** Bounties: the most one pays, how many may be open, how long one stays open (days). */
  bounty_max: z.number().int().positive().default(50),
  bounties_open: z.number().int().positive().default(3),
  bounty_days: z.number().int().positive().default(3),
  /** How often ended goals and bounties are settled. */
  agency_sweep_s: z.number().int().positive().default(60),
  // ---- economy 2.0 (docs/design/v4-plan.md §10) -----------------------------------------------
  // Playing and taking part (play.ts): what each activity pays, how often one activity may pay one
  // person a day, and the most all play together pays one person a day. `0` takes one off.
  play_rewards: z.record(z.string().regex(/^[a-z0-9_]{1,32}$/), coins).default({
    game_join: 5,
    game_finish: 10,
    game_win: 5,
    sing_along: 5,
    headpat: 1,
    web_reaction: 1,
    prediction_join: 3,
  }),
  play_per_activity_per_day: coins.default(10),
  play_cap: coins.default(40),
  // Three small daily quests (quests.ts): what each pays, what finishing all three adds, and the
  // day's most (the three plus the bonus).
  quest_reward: coins.default(10),
  quest_bonus: coins.default(15),
  quest_cap: coins.default(45),
  /** Days a topic may not repeat for the "talk about something new" quest. */
  quest_topic_days: z.number().int().positive().default(14),
  // Achievements and titles (achievements.ts): a one-time reward by size, and the day's most.
  achievement_small: z.number().int().positive().default(10),
  achievement_big: z.number().int().positive().default(30),
  achievement_cap: coins.default(60),
  // Collection (collection.ts): what a draw costs, how many a day, the odds (weights, public), and
  // after how many draws without an SR or better one is guaranteed (`0`: no pity).
  draw_price: coins.default(30),
  draws_per_day: coins.default(10),
  rarity_weights: z
    .object({
      N: z.number().nonnegative(),
      R: z.number().nonnegative(),
      SR: z.number().nonnegative(),
      SSR: z.number().nonnegative(),
    })
    .default({ N: 70, R: 22, SR: 7, SSR: 1 })
    .refine((w) => w.N + w.R + w.SR + w.SSR > 0, { message: "the weights must not all be 0" }),
  draw_pity: coins.default(30),
  /** Items one person may give away per day, and receive. `0` closes gifting. */
  item_gifts_per_day: coins.default(3),
  collection_series: z
    .array(SeriesSchema)
    .max(30)
    .default(DEFAULT_SERIES)
    .refine(
      (list) => {
        const items = list.flatMap((s) => s.items);
        return (
          new Set(list.map((s) => s.id)).size === list.length &&
          new Set(items.map((i) => i.id)).size === items.length
        );
      },
      { message: "series and item ids must be unique" },
    ),
  // Commissions (commissions.ts): prices by kind (`0` takes a kind off), how many one person may
  // ask a day, how many may wait for her at once, after how many days an untouched one is given
  // back, and the share of a delivered price she keeps (the rest leaves the economy).
  commission_prices: z
    .partialRecord(z.enum(["poem", "name", "tool", "song", "voice"]), coins)
    .default({ poem: 40, name: 30, tool: 120, song: 80, voice: 60 }),
  commissions_per_day: coins.default(3),
  commissions_open: z.number().int().positive().default(10),
  commission_days: z.number().int().positive().default(3),
  commission_share: z.number().min(0).max(1).default(0.5),
  // Predictions (predictions.ts): the most one person may stake on one and in a day, how long
  // betting may stay open at most (minutes), how many may be open, and how long an unresolved one
  // waits after it closed before every stake is given back (hours).
  bet_max: coins.default(50),
  bet_daily_max: coins.default(100),
  prediction_max_minutes: z.number().int().positive().default(120),
  predictions_open: z.number().int().positive().default(3),
  prediction_expire_hours: z.number().int().positive().default(24),
  // Her room (room.ts): what the audience can fund together, and the most one person puts in one.
  room_items: z
    .array(RoomItemSchema)
    .max(100)
    .default(DEFAULT_ROOM)
    .refine((list) => new Set(list.map((i) => i.id)).size === list.length, {
      message: "room item ids must be unique",
    }),
  room_pledge_max: z.number().int().positive().default(100),
  // Her weekly shop (shop.ts): what it may stock, how many things are on the shelf in a week, and
  // the share of a sale that goes in her purse (the rest leaves the economy).
  shop_catalog: z
    .array(ShopStockSchema)
    .max(100)
    .default(DEFAULT_SHOP)
    .refine((list) => new Set(list.map((i) => i.id)).size === list.length, {
      message: "shop item ids must be unique",
    }),
  shop_slots: z.number().int().positive().max(20).default(4),
  shop_her_share: z.number().min(0).max(1).default(0.5),
  /** How many days a broken deal counts as "owes her a meal" until they feed her. */
  owe_days: z.number().int().positive().default(14),
  // The health table (health.ts): how many days it shows, and under what share of the coins issued
  // that were taken back in a week the table says "inflating".
  health_days: z.number().int().positive().max(90).default(14),
  health_warn_ratio: z.number().min(0).max(1).default(0.6),
  /** Where "today" starts. */
  utc_offset_minutes: z.number().int().min(-720).max(840).default(480),
  frames: z
    .array(FrameSchema)
    .max(50)
    .default(DEFAULT_FRAMES)
    .refine((list) => new Set(list.map((f) => f.id)).size === list.length, {
      message: "frame ids must be unique",
    }),
});
export type EconomyConfig = z.output<typeof EconomyConfigSchema>;
