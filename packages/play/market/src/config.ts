// `[modules.market]` (docs/design/v5-play.md §4.5, §11.1, §11.4): the song priority ticket, the
// weekly auction and the weekly lottery. Every field has a default (the owner's numbers of
// 2026-11-17); the auction runs only in a channel (`auction_channel`), the lottery always (its
// notices need a channel too). Weekdays count from Sunday (0) to Saturday (6), in her local time.
//
// Per Space (phase 6, `scope: "space"`): the two switches, the two channels, the days, the times
// and the time zone may differ per server; the prices, limits and lots are the cluster's. A server
// other than the primary runs an auction or a lottery only with a channel of its own there (a
// channel set for the whole cluster is the primary's), so a server nobody set up runs nothing.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** The lot kinds the auction knows (first batch, owner 2026-11-17). */
export const LOT_KINDS = ["call_name", "frame"] as const;
export type LotKind = (typeof LOT_KINDS)[number];

/**
 * The kinds offered when the config names none (owner 2026-11-18): only the one-of-a-kind frame.
 * "How she calls you this week" sells nothing while anyone can set their name for free with
 * `/me call`; it runs only when an owner adds it to `auction_lots`.
 */
export const DEFAULT_LOTS: readonly LotKind[] = ["frame"];

const clock = () =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour")
    .default("20:00");
const weekday = (d: number) => z.number().int().min(0).max(6).default(d);
/** A Discord channel id (empty: none). */
const channel = () =>
  z
    .string()
    .regex(/^(\d{5,30})?$/, "a channel id")
    .default("");

/**
 * ```toml
 * [modules.market]
 * auction_channel = "123456789012345678"
 * ```
 */
export const MarketConfigSchema = z
  .object({
    /**
     * The server's local time zone as a UTC offset: what a day and a week of its auction and
     * lottery are. The song priority ticket's day is the cluster's, the same for everyone.
     */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60)
      .meta(
        setting({
          kind: "number",
          scope: "space",
          label: "時區(和 UTC 差幾分鐘)",
          help: "這個伺服器的拍賣和樂透用哪個時區的日子;台灣是 480",
          group: "auction",
        }),
      ),

    // ---- the song priority ticket (點歌優先券) ----
    /** Coins per ticket. */
    song_priority: z
      .number()
      .int()
      .positive()
      .default(40)
      .meta(setting({ kind: "coins", label: "一張的價格", group: "song" })),
    /** Tickets one person may use per local day; 0: not on sale. */
    song_priority_per_day: z
      .number()
      .int()
      .nonnegative()
      .default(2)
      .meta(setting({ kind: "number", label: "每人每天幾張", help: "0 是不賣", group: "song" })),

    // ---- the weekly auction (每週拍賣) ----
    /** Off: no new lot opens, and an open one is called off with every bid given back. */
    auction: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "拍賣開關",
          help: "關掉時不再開新的拍品,正在拍的會取消並退回每一筆出價",
          scope: "space",
          group: "auction",
        }),
      ),
    /** Where the lot is posted and bid on; empty: the auction does not run. */
    auction_channel: channel().meta(
      setting({
        kind: "channel",
        room: "text",
        ref: "id",
        scope: "space",
        label: "拍賣頻道",
        help: "拍品貼在這個頻道;沒設就不開拍",
        group: "auction",
      }),
    ),
    /** The day and time a lot opens (default Saturday 20:00). */
    auction_weekday: weekday(6).meta(
      setting({ kind: "weekday", scope: "space", label: "星期幾開拍", group: "auction" }),
    ),
    auction_time: clock().meta(
      setting({ kind: "time", scope: "space", label: "幾點開拍", group: "auction" }),
    ),
    /** How long a lot is open. */
    auction_hours: z
      .number()
      .int()
      .min(1)
      .max(144)
      .default(24)
      .meta(setting({ kind: "duration", unit: "h", label: "拍多久", group: "auction" })),
    /** The smallest first bid. */
    auction_opening_bid: z
      .number()
      .int()
      .positive()
      .default(50)
      .meta(setting({ kind: "coins", label: "起標", group: "auction" })),
    /** The smallest raise over the top bid. */
    auction_step: z
      .number()
      .int()
      .positive()
      .default(5)
      .meta(setting({ kind: "coins", label: "每次至少加", group: "auction" })),
    /** A bid this close to the end moves the end this much later. */
    auction_extend_mins: z
      .number()
      .int()
      .min(0)
      .max(60)
      .default(5)
      .meta(
        setting({
          kind: "duration",
          unit: "min",
          label: "延長",
          help: "最後這段時間有人出價,結標就往後延這麼久",
          group: "auction",
        }),
      ),
    /**
     * The latest the extensions may take the end: this many minutes after the scheduled end
     * (`auction_time` + `auction_hours`); 0: never past it.
     */
    auction_extend_max_mins: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(30)
      .meta(
        setting({
          kind: "duration",
          unit: "min",
          label: "最多延長",
          help: "延長加起來最多超過原本結標這麼久;0 是不延長",
          group: "auction",
        }),
      ),
    /**
     * The lot kinds she picks from (and the rotation goes through); with one kind there is nothing
     * to pick and no model call. Default: the frame only (`DEFAULT_LOTS`).
     */
    auction_lots: z
      .array(z.enum(LOT_KINDS))
      .min(1)
      .default([...DEFAULT_LOTS]),
    /** How long the won name is what she calls the winner. */
    auction_call_days: z.number().int().min(1).max(30).default(7),
    /** How long the winner of a name has to give one she accepts; after that it is refunded. */
    auction_name_hours: z.number().int().min(1).max(168).default(72),
    /** The model chain she picks the week's lot with (`[llm.purposes]`; unset: the chat chain). */
    auction_purpose: z.string().default("market"),

    // ---- the weekly lottery (每週樂透) ----
    /** Off: no tickets are sold, and the open week is refunded. */
    lottery: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "樂透開關",
          help: "關掉時不再賣票,這週已賣的會退回",
          scope: "space",
          group: "lottery",
        }),
      ),
    /** Where the week's notice and the draw go; empty: the auction's channel. */
    lottery_channel: channel().meta(
      setting({
        kind: "channel",
        room: "text",
        ref: "id",
        scope: "space",
        label: "樂透頻道",
        help: "沒設就用拍賣頻道",
        group: "lottery",
      }),
    ),
    /** Coins per ticket. */
    lottery_price: z
      .number()
      .int()
      .positive()
      .default(10)
      .meta(setting({ kind: "coins", label: "一張的價格", group: "lottery" })),
    /** Tickets one person may buy per week. */
    lottery_per_week: z
      .number()
      .int()
      .positive()
      .default(20)
      .meta(setting({ kind: "number", label: "每人每週幾張", group: "lottery" })),
    /** The prize's share of the week's sales; the rest is burned. */
    lottery_prize_share: z.number().min(0).max(1).default(0.7),
    /** The day and time of the draw (default Sunday 20:00). */
    lottery_weekday: weekday(0).meta(
      setting({ kind: "weekday", scope: "space", label: "星期幾開獎", group: "lottery" }),
    ),
    lottery_time: clock().meta(
      setting({ kind: "time", scope: "space", label: "幾點開獎", group: "lottery" }),
    ),
    /** Fewer different buyers than this: no draw, every ticket refunded. */
    lottery_min_buyers: z
      .number()
      .int()
      .min(1)
      .default(3)
      .meta(
        setting({
          kind: "number",
          label: "最少幾人",
          help: "買的人比這少就不開獎,全部退回",
          group: "lottery",
        }),
      ),
  })
  .meta(
    settingGroups([
      { id: "auction", label: "每週拍賣" },
      { id: "lottery", label: "每週樂透" },
      { id: "song", label: "點歌優先券" },
    ]),
  );

export type MarketConfig = z.output<typeof MarketConfigSchema>;

/** The defaults, optionally overridden. */
export function marketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return { ...MarketConfigSchema.parse({}), ...overrides };
}

/** Where the lottery's notices go: its own channel, else the auction's; empty: nowhere. */
export function lotteryChannel(config: MarketConfig): string {
  return config.lottery_channel || config.auction_channel;
}
