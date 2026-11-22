import { CurrencySchema, setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";
import { DEFAULT_FREE_GIFTS, FreeGiftConfigSchema } from "./gift-config.js";

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

const slug = z.string().regex(/^[a-z0-9_-]{1,32}$/);

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
export const EconomyConfigSchema = z
  .object({
    /** Shown everywhere the coins are named. */
    currency: CurrencySchema,
    /** Daily check-in, once per local day (the panel and Discord together). */
    checkin: coins.default(10),
    /** Extra on every 7th consecutive check-in day. */
    streak_bonus: coins.default(20),
    /** Once per local day she saw them say something (text or voice). */
    talked: coins.default(5),
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
    /** An expression on her own face, bought from her purse while the stage is up (`buy_for_self`). */
    expression: coins.default(20),
    /**
     * The most hunger one person may take off her in a local day (rice −0.15, a big bowl −0.5,
     * dessert −0.05): past it a feed from them is refused and nothing is charged, whatever her own
     * hunger. 0.85 is what the old limit allowed for her as a whole (from starving at 1 down to full
     * at 0.15), now for each person.
     */
    feed_hunger_cap: z.number().min(0).max(1).default(0.85),
    /** Gift emotion multiplier per earlier gift of the same person today. */
    diminish: z.number().min(0).max(1).default(0.6),
    /**
     * What one paid gift (a feed) adds to affinity and trust before
     * the social engine's own diminishing returns: a hair, never a way to buy a friend.
     */
    gift_affinity: z.number().nonnegative().default(0.4),
    gift_trust: z.number().nonnegative().default(0.1),
    /** The most gifts alone add per person per day (they also count toward the overall caps). */
    gift_affinity_cap: z.number().nonnegative().default(1.5),
    gift_trust_cap: z.number().nonnegative().default(0.5),
    // Paid things beyond food and gifts (docs/design/economy.md §13): a price, and how many one
    // person may buy per local day (refunded ones do not count); `0` per day takes it off sale.
    /** A foil finish on the next card; looks only, like a frame. */
    card_foil: coins
      .default(50)
      .meta(
        setting({ kind: "coins", label: "閃卡加工", help: "下一張卡做成閃卡", group: "prices" }),
      ),
    card_foils_per_day: coins.default(5),
    /** A short message shown on the stream overlay (she may read it out). */
    screen_message: coins.default(30).meta(
      setting({
        kind: "coins",
        label: "直播留言",
        help: "顯示在直播畫面上的一句話",
        group: "prices",
      }),
    ),
    screen_messages_per_day: coins.default(10),
    /** One screen message per person per this many seconds. */
    screen_message_cooldown_s: coins.default(600),
    // Danmaku (docs/design/v5-play.md §11.6): a short line that crosses the stream overlay while she
    // is live. Charged when sent, given back by itself when the overlay did not show it. She is
    // never asked about each line: at most one note per `danmaku_note_s` with a few of them.
    /** Members may send danmaku. */
    danmaku_on: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "直播彈幕",
          help: "直播時會員可以花魚幣發一則從畫面右邊飄過的短句",
          group: "danmaku",
        }),
      ),
    /** What one line costs. */
    danmaku: coins.default(5).meta(setting({ kind: "coins", label: "一則彈幕", group: "danmaku" })),
    /** Longest line, in characters. */
    danmaku_max_chars: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .meta(setting({ kind: "number", label: "最多幾個字", group: "danmaku" })),
    /** One line per person per this many seconds. */
    danmaku_cooldown_s: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .default(20)
      .meta(
        setting({ kind: "duration", unit: "s", label: "每個人隔多久能再發", group: "danmaku" }),
      ),
    /** Lines one person may send per local day (given-back ones do not count). */
    danmaku_per_day: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .meta(setting({ kind: "number", label: "每個人一天最多幾則", group: "danmaku" })),
    /** Lines on the screen at once; the rest wait their turn. */
    danmaku_max_on_screen: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(12)
      .meta(setting({ kind: "number", label: "畫面上最多幾則", group: "danmaku" })),
    /** The sender's name small before the line. */
    danmaku_show_names: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "顯示名字",
          help: "彈幕前面用小字寫發的人",
          group: "danmaku",
        }),
      ),
    /** How often she gets one note with a few of the lines (seconds); none when nothing came. */
    danmaku_note_s: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(60)
      .meta(
        setting({
          kind: "duration",
          unit: "s",
          label: "多久告訴她一次",
          help: "她不會每一則都被問,每隔這麼久收到一則摘要,裡面有幾則彈幕",
          group: "danmaku",
        }),
      ),
    /** Lines that may wait for a lane on the overlay; one more is given back at once. */
    danmaku_queue_max: z.number().int().min(0).max(200).default(20),
    /** A line that waited this long for a lane is dropped and given back (seconds). */
    danmaku_max_wait_s: z.number().int().min(1).max(600).default(30),
    /** A fortune slip she writes for them. */
    fortune: coins
      .default(10)
      .meta(setting({ kind: "coins", label: "籤詩", help: "她寫的一張籤", group: "prices" })),
    fortunes_per_day: coins.default(1),
    // People with each other (docs/design/economy.md §13). `transfer_max = 0` or either daily limit
    // `0` closes transfers.
    /** The most one transfer may carry. */
    transfer_max: coins.default(50),
    /**
     * The fee on a transfer, as a share of the amount sent: rounded up, at least 1 coin, paid by the
     * sender on top of the amount and burned (it goes to nobody). `0` charges none.
     */
    transfer_fee: z.number().min(0).max(1).default(0.05),
    /** What one person may send in a local day, and what one person may receive. */
    transfer_out_per_day: coins.default(100),
    transfer_in_per_day: coins.default(100),
    /** The sponsor board counts what was spent on her over this many days. */
    board_days: z.number().int().positive().max(365).default(30),
    // Her own purse (docs/design/economy.md §13): a share of every paid gift to her is hers.
    /** The share of a paid gift (feed, screen message) she keeps. */
    her_share: z.number().min(0).max(1).default(0.2),
    /** What she may treat one person to from her purse per day, and everyone together. */
    treat_per_person: coins.default(30),
    treat_total: coins.default(100),
    /** Expressions she may buy for herself per day (the price is `expression`). */
    self_expressions_per_day: coins.default(3),
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
    /**
     * The "with others" quest: how many people (her not counted) a game or a song heard to its end
     * needs, them included. 2: at least one other person.
     */
    quest_together_min_people: z.number().int().min(2).default(2),
    /**
     * The quest she thinks of for each person from her memories of them: `false` gives everyone
     * one of the plain ones instead (no model call). She gets `quest_pick_secs` to write it.
     */
    quest_pick_by_her: z.boolean().default(true),
    quest_pick_secs: z.number().int().positive().max(60).default(20),
    // Achievements and titles (achievements.ts): a one-time reward by size, and the day's most.
    achievement_small: z.number().int().positive().default(10),
    achievement_big: z.number().int().positive().default(30),
    achievement_cap: coins.default(60),
    // Predictions (predictions.ts): the most one person may stake on one and in a day, how long
    // betting may stay open at most (minutes), how many may be open, and how long an unresolved one
    // waits after it closed before every stake is given back (hours).
    bet_max: coins.default(50),
    bet_daily_max: coins.default(100),
    prediction_max_minutes: z.number().int().positive().default(120),
    predictions_open: z.number().int().positive().default(3),
    prediction_expire_hours: z.number().int().positive().default(24),
    /**
     * The cut of the pool a prediction with winners burns (v5-play §4.2: 5% to 10%); nothing is
     * taken when every stake goes back.
     */
    prediction_rake: z.number().min(0).max(0.1).default(0.05),
    /**
     * Predictions that settle by themselves (prediction-watch.ts): betting closes at most this many
     * minutes after opening (the result may come at any moment), and one whose result has not come
     * this many minutes after betting closed gives every stake back.
     */
    prediction_auto_close_minutes: z.number().int().positive().default(5),
    prediction_auto_wait_minutes: z.number().int().positive().default(120),
    // Her room (room.ts): what the audience can fund together, and the most one person puts in one.
    room_items: z
      .array(RoomItemSchema)
      .max(100)
      .default(DEFAULT_ROOM)
      .refine((list) => new Set(list.map((i) => i.id)).size === list.length, {
        message: "room item ids must be unique",
      }),
    room_pledge_max: z.number().int().positive().default(100),
    // The health table (health.ts): how many days it shows, and under what share of the coins issued
    // that were taken back in a week the table says "inflating".
    health_days: z.number().int().positive().max(90).default(14),
    health_warn_ratio: z.number().min(0).max(1).default(0.6),
    /**
     * The one fixed rate between New Taiwan dollars and coins (owner 2026-11-21): one coin is this
     * many NT$, about one (a bowl of rice is 10). Never fetched, never floating. Free-form gifts
     * price by it, and the exchange reads this same key through its wallet (it has no rate of its
     * own for coins, only `[modules.exchange] twd_per_usd`).
     */
    twd_per_coin: z.number().positive().default(1),
    /**
     * Gifts a member names in their own words (`[modules.economy.free_gifts]`, gift-config.ts,
     * docs/design/economy.md §16): a real-world estimate in NT$ turned into coins at
     * `twd_per_coin`, confirmed by the member, taken or refused by her.
     */
    free_gifts: FreeGiftConfigSchema.default(DEFAULT_FREE_GIFTS),
    /** Where "today" starts. */
    utc_offset_minutes: z.number().int().min(-720).max(840).default(480),
    frames: z
      .array(FrameSchema)
      .max(50)
      .default(DEFAULT_FRAMES)
      .refine((list) => new Set(list.map((f) => f.id)).size === list.length, {
        message: "frame ids must be unique",
      }),
  })
  .meta(
    settingGroups([
      { id: "prices", label: "價格" },
      { id: "danmaku", label: "直播彈幕" },
    ]),
  );
export type EconomyConfig = z.output<typeof EconomyConfigSchema>;
