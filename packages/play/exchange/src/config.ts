// `[modules.exchange]` (docs/design/exchange.md, owner 2026-11-21): v1 is paper trading of real
// Taiwan and US stocks (quoted by Yahoo Finance) and five local stocks tied to her, with fish
// coins. The market is off until the owner turns `open` on. Tickers are an open universe: the
// first lookup validates one through the provider and stores it.
//
// The old local market (the closed vault, rounds, news) stays in the package behind
// `local_enabled = false` with nothing reaching it; its numbers are at the end, without a place on
// the panel.
//
// The caps on how much someone may buy or hold, and the house's daily payout cap, are off by
// default (owner 2026-11-21: "otherwise it is unplayable"); a positive number turns each back on.
//
// ```toml
// [modules.exchange]
// open = true
// colors = "tw"
// starters_tw = [{ code = "2330", sector = "半導體", weight = 300 }, "0050"]
// ```

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { BOND_LADDER } from "@miyoria/types";
import { z } from "zod";
import { companiesOf } from "./engine/companies.js";
import { DEFAULT_RULES, type Rules } from "./engine/guards.js";
import { DEFAULT_PARAMS, type EngineParams } from "./engine/params.js";
import type { HouseParams } from "./real/house.js";
import { DEFAULT_SESSIONS, type MarketKind, type Session } from "./real/instruments.js";
import {
  DEFAULT_LOCAL,
  LOCAL_ROLES,
  type LocalCompany,
  type LocalRole,
  resolveLocal,
} from "./real/local.js";

/** The bond tiers a requirement may name, lowest first. */
const TIERS = BOND_LADDER.map((t) => t.label) as [string, ...string[]];

const ratio = (d: number, max = 1) => z.number().min(0).max(max).default(d);
const coins = (d: number) => z.number().int().positive().default(d);
/**
 * A cap that is off by default (owner 2026-11-21: "otherwise it is unplayable"): `0` is no cap,
 * any positive number turns it on at that many coins.
 */
const cap = () => z.number().int().min(0).default(0);

/**
 * One entry of a starter list (熱門台股 / 熱門美股): the code as people type it, its display name
 * (zh-TW for Taiwan, the short name people here use for the US; none: the provider's), its broad
 * sector and its weight on the 熱門 heat map. Yahoo's keyless endpoint gives neither market cap nor
 * sector nor a Chinese name, so these live here: static values, which the owner may edit. A plain
 * code is sector 其他, weight 1, the provider's name.
 */
const starter = z.union([
  z.string().min(1).max(16),
  z.object({
    code: z.string().min(1).max(16),
    name: z.string().trim().min(1).max(60).optional(),
    sector: z.string().min(1).max(12).default("其他"),
    weight: z.number().positive().max(1_000_000).default(1),
  }),
]);
export type StarterInput = z.input<typeof starter>;
export interface StarterEntry {
  code: string;
  /** The display name (`null`: the provider's). */
  name: string | null;
  sector: string;
  weight: number;
}

/** A starter list's entries, each with its sector and weight. */
export function starterEntries(
  list: readonly (
    | string
    | { code: string; name?: string | null | undefined; sector: string; weight: number }
  )[],
): StarterEntry[] {
  return list.map((e) =>
    typeof e === "string"
      ? { code: e, name: null, sector: OTHER_SECTOR, weight: 1 }
      : { code: e.code, name: e.name ?? null, sector: e.sector, weight: e.weight },
  );
}

/** The sector of anything a starter list does not name. */
export const OTHER_SECTOR = "其他";

const S = (code: string, name: string, sector: string, weight: number): StarterEntry => ({
  code,
  name,
  sector,
  weight,
});

/**
 * The shipped starter lists, with names, sectors and weights roughly by size (market cap, or an
 * ETF's assets; late 2025, rounded). The weights are static approximations, never live market
 * caps. Taiwan's names are the usual zh-TW short names (each checked against its code); the US
 * names stay in English, the way people here know them.
 */
export const STARTERS_TW: readonly StarterEntry[] = [
  S("2330", "台積電", "半導體", 300),
  S("2317", "鴻海", "科技", 30),
  S("2454", "聯發科", "半導體", 23),
  S("2308", "台達電", "科技", 20),
  S("2382", "廣達", "科技", 11),
  S("2412", "中華電", "電信", 10),
  S("2881", "富邦金", "金融", 12),
  S("2882", "國泰金", "金融", 10),
  S("2891", "中信金", "金融", 9),
  S("2303", "聯電", "半導體", 6),
  S("1301", "台塑", "原物料", 3),
  S("2002", "中鋼", "原物料", 3),
  S("0050", "元大台灣50", "ETF", 6),
  S("0056", "元大高股息", "ETF", 4),
  S("00878", "國泰永續高股息", "ETF", 4),
  S("006208", "富邦台50", "ETF", 2),
];
export const STARTERS_US: readonly StarterEntry[] = [
  S("AAPL", "Apple", "科技", 38),
  S("MSFT", "Microsoft", "科技", 38),
  S("NVDA", "NVIDIA", "半導體", 45),
  S("AMZN", "Amazon", "消費", 24),
  S("GOOGL", "Google", "科技", 30),
  S("META", "Meta", "科技", 18),
  S("TSLA", "Tesla", "消費", 14),
  S("BRK-B", "Berkshire Hathaway", "金融", 10),
  S("JPM", "JPMorgan", "金融", 8),
  S("V", "Visa", "金融", 7),
  S("SPY", "SPDR S&P 500", "ETF", 7),
  S("QQQ", "Invesco QQQ", "ETF", 4),
  S("VOO", "Vanguard S&P 500", "ETF", 7),
  S("VTI", "Vanguard Total Stock", "ETF", 5),
  S("DIA", "SPDR Dow Jones", "ETF", 1),
];
/** A shipped entry as config input (a `null` name is left out: the provider's). */
const starterInput = ({ name, ...e }: StarterEntry) => (name === null ? e : { ...e, name });
const tier = (d: string) => z.enum(TIERS).default(d);
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A local stock's anchor price in coins. */
const anchorPrice = () => z.number().min(10).max(1000);

/**
 * One local stock as the profile names it (docs/design/v5-profiles.md): its ticker, zh-TW name and
 * anchor; what moves it and the old market's line are written from the name unless given. Today's
 * five by default. A code is keyed into the store (holdings, orders, price history): changing it on
 * a database that has rows under the old one is refused at start (`localCodeConflicts`).
 */
const localCompany = (role: LocalRole) =>
  z
    .object({
      code: z
        .string()
        .trim()
        .regex(/^[A-Z]{4}$/, "four capital letters, like RICE")
        .default(DEFAULT_LOCAL[role].code),
      name: z.string().trim().min(1).max(24).default(DEFAULT_LOCAL[role].name),
      /** Unset: the legacy `local_anchors` entry, else today's. */
      anchor: anchorPrice().optional(),
      what_moves: z.string().trim().min(1).max(60).optional(),
      blurb: z.string().trim().min(1).max(40).optional(),
    })
    .prefault({});

/**
 * How one local stock's count becomes its signal (`real/signals.ts`): a full signal (the whole
 * ±3% gap) needs the day at least `floor` above or below the usual count, and the signal is held
 * within `up` and `down` (shares of the full one).
 */
const localMapping = (floor: number) =>
  z.object({
    floor: z.number().positive().max(1000).default(floor),
    up: ratio(1),
    down: ratio(1),
  });
export type LocalMapping = z.output<ReturnType<typeof localMapping>>;

/** Each role's floor when its table is not given. */
export const LOCAL_FLOORS: Readonly<Record<LocalRole, number>> = {
  feeding: 10,
  songs: 3,
  silence: 3,
  game: 3,
  model: 10,
};

export const ExchangeConfigSchema = z
  .object({
    /** The master switch. Off: nothing is traded, open orders go back, holdings stay. */
    open: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "交易所開關",
          help: "關著時不成交也不能下單;關掉時掛著的委託全部退回。持股留著",
          group: "market",
        }),
      ),
    /** Her local time zone as a UTC offset: what a day is (the daily caps and report). */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),

    // ---- what is traded ----
    // The universe is open (owner 2026-11-21): any Taiwan listed or TPEx, or US-listed, common stock
    // or ETF a member looks up, validated through the provider the first time.
    /** Which provider each market's tickers use: `yahoo`, or the id of a `providers` entry. */
    provider_tw: z.string().min(1).default("yahoo"),
    provider_us: z.string().min(1).default("yahoo"),
    /** Exchanges and instrument types allowed, as the provider reports them. */
    allowed_exchanges_tw: z.array(z.string()).default(["TAI", "TWO"]),
    allowed_exchanges_us: z
      .array(z.string())
      .default(["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"]),
    allowed_types: z.array(z.string()).default(["EQUITY", "ETF"]),
    /** The owner's block list (sell only), and an optional allow-only list (empty: open). */
    blocked: z.array(z.string()).default([]),
    allow_only: z.array(z.string()).default([]),
    /** A person may look up this many new tickers an hour; a ticker that did not validate is not asked again for this long. */
    lookups_per_hour: z.number().int().min(1).max(500).default(20),
    negative_cache_minutes: z.number().int().min(1).max(10_080).default(60),
    /** A ticker viewed this recently is kept fresh (besides held or ordered ones). */
    view_minutes: z.number().int().min(1).max(120).default(5),
    /** Symbols per request at most. */
    batch_size: z.number().int().min(1).max(50).default(20),
    /** Trading days without a valid quote before a held ticker is suspended (the owner settles it). */
    suspend_after_days: z.number().int().min(1).max(30).default(3),
    /**
     * Fixed exchange rates (owner 2026-11-21): never fetched, never floating. NT$ per coin is the
     * economy's one rate (`[modules.economy] twd_per_coin`, default 1: a coin is about NT$1, a bowl
     * of rice is 10); this is NT$ per US$. A coin price is TWD ÷ twd_per_coin, or USD × twd_per_usd ÷
     * twd_per_coin. Holdings are shares, so changing a rate re-values everyone's holdings at once.
     */
    twd_per_usd: z
      .number()
      .positive()
      .default(30)
      .meta(
        setting({
          kind: "number",
          label: "一美元等於幾台幣",
          help: "固定匯率,不會自動更新",
          danger: "改匯率會讓所有美股持股的市值一起變動(股數不變)。確定要改嗎?",
          group: "market",
        }),
      ),
    /**
     * Yahoo Finance (the owner's choice for both markets): an unofficial public endpoint, data for
     * personal use per Yahoo's terms, which can change or break without notice. Switch a market to
     * another source by giving its instruments another `provider` from `providers`.
     */
    yahoo: z
      .object({
        host: z
          .string()
          .regex(/^[a-z0-9.-]+$/i)
          .default("query1.finance.yahoo.com"),
        daily_budget: z.number().int().min(10).max(100_000).default(3000),
        timeout_ms: z.number().int().min(1000).max(30_000).default(8000),
        max_backoff_seconds: z.number().int().min(15).max(86_400).default(1800),
      })
      .prefault({}),
    /** Other quote providers: each a JSON endpoint (the generic one). */
    providers: z
      .array(
        z.object({
          id: z.string().min(1),
          url: z.string().regex(/^https:\/\/[^/{}?#]+[/?]/, "https:// with a fixed host"),
          separator: z.string().default(","),
          price_path: z.string().min(1),
          time_path: z.string().nullable().default(null),
          time_unit: z.enum(["s", "ms", "iso"]).default("s"),
          prev_close_path: z.string().nullable().default(null),
          rate_per_minute: z.number().int().positive().default(30),
          cache_seconds: z.number().int().min(0).default(30),
          timeout_ms: z.number().int().min(500).max(30_000).default(5_000),
          max_backoff_seconds: z.number().int().min(1).default(600),
          api_key_env: z.string().nullable().default(null),
          api_key_header: z.string().nullable().default(null),
          api_key_param: z.string().nullable().default(null),
        }),
      )
      .default([]),
    /** What each market's provider gives: quotes during the session, or only each day's close. */
    quotes_us: z.enum(["intraday", "close"]).default("intraday"),
    quotes_tw: z.enum(["intraday", "close"]).default("intraday"),
    /** Closed dates in the market's own zone (holidays). */
    holidays_us: z.array(date()).default([]),
    holidays_tw: z.array(date()).default([]),
    /** How often quotes are asked for. */
    quote_poll_seconds: z.number().int().min(10).max(3600).default(60),
    /** A quote older than this is not traded at (an intraday market). */
    quote_max_age_seconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(300)
      .meta(
        setting({ kind: "duration", unit: "s", label: "報價最久多舊還能成交", group: "market" }),
      ),
    /** A closing price stamped up to this long after the close still counts as that day's close. */
    close_grace_minutes: z.number().int().min(0).max(720).default(180),

    // ---- accounts and orders ----
    account_min_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RULES.min_days)
      .meta(setting({ kind: "number", label: "開戶:認識滿幾天", group: "account" })),
    account_min_tier: tier("認識").meta(
      setting({ kind: "select", label: "開戶:羈絆至少", group: "account" }),
    ),
    // Real prices hold nothing an owner or admin can see ahead of the members, so they may
    // trade; `false` keeps them out (the local stocks' seeds are theirs to read).
    staff_may_trade: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "owner 和管理員也能交易",
          help: "關掉:看得到市場內部數字的人不能開戶和下單",
          group: "account",
        }),
      ),
    order_min: coins(DEFAULT_RULES.order_min).meta(
      setting({ kind: "coins", label: "一筆最少", group: "account" }),
    ),
    /** The most one buy may be; `0` (the default): no maximum. */
    order_max: cap().meta(
      setting({ kind: "coins", label: "一筆最多", help: "0 = 不限", group: "account" }),
    ),
    orders_per_day: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_RULES.orders_per_day)
      .meta(setting({ kind: "number", label: "一天最多幾筆委託", group: "account" })),
    /** The daily buy cap (coins bought a day, fee included); `0` (the default): none. */
    buy_per_day: cap().meta(
      setting({ kind: "coins", label: "一天最多買多少", help: "0 = 不限", group: "account" }),
    ),
    /** Coins received by transfer this recently cannot be put in. */
    transfer_lock_hours: z
      .number()
      .int()
      .min(0)
      .max(168)
      .default(DEFAULT_RULES.transfer_lock_hours)
      .meta(
        setting({ kind: "duration", unit: "h", label: "轉來的錢多久後才能投入", group: "account" }),
      ),
    /** A holding can be sold this long after it was bought (the one anti-churn rule). */
    min_hold_minutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(10)
      .meta(
        setting({ kind: "duration", unit: "min", label: "買進後多久才能賣", group: "account" }),
      ),
    /** The one fee on every trade, burned (rounded up, at least `fee_min`). */
    fee: ratio(0.01, 0.2).meta(
      setting({
        kind: "number",
        step: 0.001,
        label: "手續費(比例)",
        help: "每一筆買賣都收,無條件進位,最少 1 魚幣,燒掉",
        group: "account",
      }),
    ),
    fee_min: z.number().int().min(0).default(1),

    // ---- the holding cap, by cost (one cap for everything held); `0` (the default): none ----
    limit_total: cap().meta(
      setting({
        kind: "coins",
        label: "持有上限",
        help: "0 = 不限。照成本算;槓桿照全部部位算;隨羈絆和認識的時間放寬",
        group: "limits",
      }),
    ),
    /** Each tier above the account's tier widens the cap by this share. */
    limit_bond_step: ratio(DEFAULT_RULES.limit_bond_step),
    /** Each `limit_age_days` she has known them widens it by this share. */
    limit_age_step: ratio(DEFAULT_RULES.limit_age_step),
    limit_age_days: z.number().int().min(1).default(DEFAULT_RULES.limit_age_days),
    /** It widens to at most this many times. */
    limit_max_mult: z.number().min(1).max(10).default(DEFAULT_RULES.limit_max_mult),

    // ---- the house ----
    /**
     * Net coins the house may pay out per local day; reached: no new buys today, sales paid in
     * full. `0` (the default): no cap, so in a rising market the exchange adds coins to the economy
     * without bound; the owner page reports it and warns past `mint_warn_share`.
     */
    payout_cap_daily: cap().meta(
      setting({
        kind: "coins",
        label: "每天最多淨發出",
        help: "0 = 不限(漲的市場會讓魚幣變多)。設了之後,到了當天停止買進;賣出照常全額付",
        group: "market",
      }),
    ),
    /**
     * The owner page warns (never halts) when the exchange's net coins of the last 7 days are more
     * than this share of all coins in wallets.
     */
    mint_warn_share: ratio(0.05).meta(
      setting({
        kind: "number",
        step: 0.01,
        label: "7 天淨發出超過流通量幾成時提醒",
        help: "只是提醒,不會停止交易",
        group: "market",
      }),
    ),
    /** The 伺服器持股圖 merges a ticker held by fewer people than this into 其他. */
    map_min_holders: z.number().int().min(1).max(20).default(2),
    /**
     * No tile of a heat map takes more than this share of the map (2330 alone is two thirds of
     * the Taiwan list's weights): a bigger one is cut to it and the rest grow in proportion, the
     * same in the panel and the picture, and the footnote says so. `1`: off.
     */
    map_max_share: z.number().min(0.1).max(1).default(0.35),

    // ---- leverage: 1x or 2x, cross margin ----
    leverage: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "槓桿開關",
          help: "2 倍可能賠超過保證金,最壞賠光錢包和其他持股;關掉時不能開新的槓桿部位",
          group: "leverage",
        }),
      ),
    leverage_line: ratio(DEFAULT_PARAMS.leverage.line, 0.9),
    leverage_warn_half: ratio(DEFAULT_PARAMS.leverage.warn_half, 0.95),
    leverage_warn_near: ratio(DEFAULT_PARAMS.leverage.warn_near, 0.95),
    /** Burned per day from a leveraged position, as a share of what is borrowed (0: none). */
    leverage_carry_daily: ratio(0, 0.05),
    /** 2x only on a ticker at least this many coins a share, with a previous close. */
    leverage_min_coin_price: z.number().min(0).default(50),
    leverage_min_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RULES.leverage_min_days)
      .meta(setting({ kind: "number", label: "槓桿:認識滿幾天", group: "leverage" })),
    leverage_min_tier: tier("朋友").meta(
      setting({ kind: "select", label: "槓桿:羈絆至少", group: "leverage" }),
    ),
    /** All of a member's 2x margin together at most; `0` (the default): no cap. */
    leverage_margin_cap: cap().meta(
      setting({ kind: "coins", label: "每人保證金合計上限", help: "0 = 不限", group: "leverage" }),
    ),
    /** A bankrupt member waits this long before trading again. */
    bankrupt_cooling_days: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(7)
      .meta(setting({ kind: "number", label: "破產後幾天不能交易", group: "leverage" })),

    /** The five local stocks tied to her (新手推薦 · 這裡獨家), priced by the simulator in coins, 1x only. */
    local_stocks: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "新手推薦的獨家股票",
          help: "她的五家公司:價格由程式模擬,跟她的生活有關,不開放槓桿",
          group: "market",
        }),
      ),

    /**
     * The five local stocks as this profile names them, by role (docs/design/v5-profiles.md):
     * `feeding` (RICE 白飯食品), `songs` (WHLE 鯨落唱片), `silence` (NAPS 打盹床業), `game` (CUBE
     * 方塊礦業), `model` (DPSK DipSick AI). What moves each is fixed by its role; its code, name,
     * anchor (its first price and the level its walk returns to, about 100 a share: owner
     * 2026-11-21) and words are the profile's. Soft bounds keep a price within 0.5×–2× of it.
     */
    local_companies: z
      .object({
        feeding: localCompany("feeding"),
        songs: localCompany("songs"),
        silence: localCompany("silence"),
        game: localCompany("game"),
        model: localCompany("model"),
      })
      .prefault({})
      .superRefine((companies, ctx) => {
        const seen = new Map<string, string>();
        for (const role of LOCAL_ROLES) {
          const code = companies[role].code;
          const other = seen.get(code);
          if (other !== undefined)
            ctx.addIssue({
              code: "custom",
              path: [role, "code"],
              message: `${role} and ${other} have the same code ${code}`,
            });
          seen.set(code, role);
        }
      }),

    /**
     * Legacy: each local stock's anchor keyed by the first character's codes (`RICE = 100`), read as
     * that role's when `local_companies.<role>.anchor` is not set. `local_companies` replaces it.
     */
    local_anchors: z
      .object({
        RICE: anchorPrice().optional(),
        WHLE: anchorPrice().optional(),
        NAPS: anchorPrice().optional(),
        CUBE: anchorPrice().optional(),
        DPSK: anchorPrice().optional(),
      })
      .prefault({}),

    /**
     * How her real things move the local stocks (`real/signals.ts`, docs/design/exchange.md §9).
     * Each day's count is compared with the same company's previous `baseline_days` completed
     * days: their median, and their spread (the median distance from it, ×1.4826). The day's
     * distance from the median, over the larger of `spread` spreads, `relative` × the median and
     * the company's `floor`, is its signal, held within [-1, 1] and the company's `up` / `down`:
     * a full signal is the whole ±3% gap at the next day's 12:00 tick. Fewer than
     * `min_history_days` days on record (a new instance), or no record of the day: no signal.
     *
     * Directions are fixed in code, by role: more feedings, songs, silent hours, goals (fewer
     * deaths) push the `feeding`, `songs`, `silence`, `game` stocks up; more model errors and slow
     * calls push the `model` stock down, and never up (a quiet day gives it nothing), with its fall
     * held below one round trip's fees (`fee` × 2), so nobody gains by causing errors and buying
     * the dip. The floors are the anti-gaming numbers: `test/signals.test.ts` shows that feeding
     * her as much as the caps allow, buying the feeding stock before the day ends and selling
     * after the next open loses money once the feedings and fees count. The per-role tables are
     * keyed by role; the first character's codes (`RICE = {…}`) are still read as their roles.
     */
    local_signals: z
      .object({
        baseline_days: z.number().int().min(3).max(60).default(14),
        min_history_days: z.number().int().min(1).max(60).default(7),
        spread: z.number().min(0).max(20).default(3),
        relative: z.number().min(0).max(10).default(0.5),
        /** The model stock: a call that answered but took longer than this counts as slow. */
        slow_call_seconds: z.number().min(1).max(600).default(30),
        /** Feedings (fixed foods by bowl, and food or drink gifts she took). Floor 10. */
        feeding: localMapping(LOCAL_FLOORS.feeding).optional(),
        /** Songs she sang to the end. Floor 3. */
        songs: localMapping(LOCAL_FLOORS.songs).optional(),
        /** Hours of the Taipei day with no line of hers delivered and no failed model call. Floor 3. */
        silence: localMapping(LOCAL_FLOORS.silence).optional(),
        /** Game goals reached less deaths. Floor 3. */
        game: localMapping(LOCAL_FLOORS.game).optional(),
        /** Failed model calls plus slow ones; `up` is ignored (always 0). Floor 10. */
        model: localMapping(LOCAL_FLOORS.model).optional(),
        /** Legacy keys (the first character's codes), read as their roles when those are not set. */
        RICE: localMapping(LOCAL_FLOORS.feeding).optional(),
        WHLE: localMapping(LOCAL_FLOORS.songs).optional(),
        NAPS: localMapping(LOCAL_FLOORS.silence).optional(),
        CUBE: localMapping(LOCAL_FLOORS.game).optional(),
        DPSK: localMapping(LOCAL_FLOORS.model).optional(),
      })
      .prefault({}),

    /** Which colour means up on every chart (one for the whole product), stated in a legend. */
    colors: z
      .enum(["tw", "us"])
      .default("tw")
      .meta(
        setting({
          kind: "select",
          label: "漲跌顏色",
          labels: { tw: "紅漲綠跌", us: "綠漲紅跌" },
          help: "tw:紅漲綠跌(台股習慣,預設);us:綠漲紅跌(美股習慣)。每張圖都會標示",
          group: "market",
        }),
      ),
    /**
     * The starter lists (熱門台股 / 熱門美股): codes as people type them, each with its broad
     * sector and its weight on the 熱門 heat map (`{ code, sector, weight }`; a plain code is
     * sector 其他, weight 1). Each is validated through the provider like any ticker, a few per
     * pass; one that fails is dropped silently. The weights are static approximations by size, not
     * live market caps (the map says so).
     */
    starters_tw: z
      .array(starter)
      .max(50)
      .default(() => STARTERS_TW.map(starterInput)),
    starters_us: z
      .array(starter)
      .max(50)
      .default(() => STARTERS_US.map(starterInput)),
    /** A member's watch list holds at most this many tickers. */
    watch_max: z.number().int().min(1).max(50).default(20),
    /**
     * Watched tickers count as in use for polling only while their market is open and the member
     * used the exchange within this many days (a forgotten watch list spends nothing).
     */
    watch_active_days: z.number().int().min(1).max(30).default(3),
    /** Ticker suggestions while typing: per person per minute (answers are cached). */
    suggest_per_minute: z.number().int().min(1).max(600).default(60),
    /** How long the market's Discord controls work before they ask to be reopened. */
    component_minutes: z.number().int().min(1).max(60).default(15),

    // ---- the old local market (closed vault, rounds): off, no panel ----
    local_enabled: z.boolean().default(false),
    round_grace_minutes: z.number().int().min(1).max(59).default(10),
    limit_company: coins(DEFAULT_RULES.limit_company),
    limit_days_max: z.number().int().min(1).max(20).default(DEFAULT_RULES.limit_days_max),
    concentration: ratio(DEFAULT_RULES.concentration),
    concentration_floor: coins(DEFAULT_RULES.concentration_floor),
    fee_buy: ratio(DEFAULT_PARAMS.fee_buy, 0.2),
    fee_sell: ratio(DEFAULT_PARAMS.fee_sell, 0.2),
    tax_sell: ratio(DEFAULT_PARAMS.tax_sell, 0.2),
    daily_limit: ratio(DEFAULT_PARAMS.daily_limit, 0.5),
    round_limit: ratio(DEFAULT_PARAMS.round_limit, 0.5),
    breaker: ratio(DEFAULT_PARAMS.breaker, 0.5),
    vault_burn_level: z.number().min(1).max(10).default(DEFAULT_PARAMS.vault_burn_level),
    local_leverage: z.boolean().default(DEFAULT_PARAMS.leverage.enabled),
    market_sigma: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.market_sigma),
    sector_sigma: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.sector_sigma),
    reversion: ratio(DEFAULT_PARAMS.reversion),
    fundamental_sigma: z.number().min(0).max(0.1).default(DEFAULT_PARAMS.fundamental_sigma),
    level_pull: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.level_pull),
    level_floor: z.number().int().min(0).default(DEFAULT_PARAMS.level_floor),
    impact: z.number().min(0).max(0.2).default(DEFAULT_PARAMS.impact),
    impact_decay: ratio(DEFAULT_PARAMS.impact_decay),
    mood_drift: z.number().min(0).max(0.01).default(DEFAULT_PARAMS.mood_drift),
    mood_switch: ratio(DEFAULT_PARAMS.mood_switch),
    event_rate: ratio(DEFAULT_PARAMS.event_rate),
    event_min: ratio(DEFAULT_PARAMS.event_min, 0.2),
    event_max: ratio(DEFAULT_PARAMS.event_max, 0.2),
    earnings_sigma: ratio(DEFAULT_PARAMS.earnings_sigma, 0.2),
  })
  .meta(
    settingGroups([
      { id: "market", label: "市場" },
      { id: "account", label: "開戶和委託" },
      { id: "limits", label: "持有上限" },
      { id: "leverage", label: "槓桿" },
    ]),
  );

export type ExchangeConfig = z.output<typeof ExchangeConfigSchema>;

/** The defaults, optionally overridden. */
export function exchangeConfig(overrides: Partial<ExchangeConfig> = {}): ExchangeConfig {
  return { ...ExchangeConfigSchema.parse({}), ...overrides };
}

/** The mapping of a role's signal: its own table, else its legacy code's, else the defaults. */
export function localMappingOf(c: ExchangeConfig, role: LocalRole): LocalMapping {
  const s = c.local_signals;
  const legacy = DEFAULT_LOCAL[role].code as "RICE" | "WHLE" | "NAPS" | "CUBE" | "DPSK";
  return s[role] ?? s[legacy] ?? localMapping(LOCAL_FLOORS[role]).parse({});
}

/** The five local stocks of `c`, in role order; `pronoun` is how their words name her. */
export function localCompaniesOf(c: ExchangeConfig, pronoun = "她"): LocalCompany[] {
  return resolveLocal(c.local_companies, c.local_anchors, pronoun);
}

/** A tier's place on the ladder (0: 認識). */
export function tierIndex(label: string): number {
  return BOND_LADDER.findIndex((t) => t.label === label);
}

/** The local engine's numbers from the config (the local market is off in v1). */
export function engineParams(c: ExchangeConfig): EngineParams {
  return {
    ...DEFAULT_PARAMS,
    companies: companiesOf(localCompaniesOf(c)),
    daily_limit: c.daily_limit,
    round_limit: c.round_limit,
    breaker: c.breaker,
    fee_buy: c.fee_buy,
    fee_sell: c.fee_sell,
    tax_sell: c.tax_sell,
    fee_min: c.fee_min,
    market_sigma: c.market_sigma,
    sector_sigma: c.sector_sigma,
    reversion: c.reversion,
    fundamental_sigma: c.fundamental_sigma,
    level_pull: c.level_pull,
    level_floor: c.level_floor,
    impact: c.impact,
    impact_decay: c.impact_decay,
    mood_drift: c.mood_drift,
    mood_switch: c.mood_switch,
    event_rate: c.event_rate,
    event_min: c.event_min,
    event_max: Math.max(c.event_min, c.event_max),
    earnings_sigma: c.earnings_sigma,
    vault_burn_level: c.vault_burn_level,
    leverage: {
      enabled: c.local_leverage,
      max: 2,
      line: c.leverage_line,
      warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
      warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
      carry_daily: 0.002,
    },
  };
}

/** The guards' rules from the config; `paused` is the owner's pause, kept by the module. */
export function rulesOf(c: ExchangeConfig, paused: boolean): Rules {
  return {
    enabled: c.open,
    paused,
    min_days: c.account_min_days,
    min_tier: Math.max(0, tierIndex(c.account_min_tier)),
    order_min: c.order_min,
    // 0 stays 0: no maximum.
    order_max: c.order_max === 0 ? 0 : Math.max(c.order_min, c.order_max),
    orders_per_day: c.orders_per_day,
    buy_per_day: c.buy_per_day,
    limit_company: c.limit_company,
    limit_total: c.limit_total,
    limit_bond_step: c.limit_bond_step,
    limit_age_step: c.limit_age_step,
    limit_age_days: c.limit_age_days,
    limit_max_mult: c.limit_max_mult,
    concentration: c.concentration,
    concentration_floor: c.concentration_floor,
    transfer_lock_hours: c.transfer_lock_hours,
    limit_days_max: c.limit_days_max,
    leverage_min_days: c.leverage_min_days,
    leverage_min_tier: Math.max(0, tierIndex(c.leverage_min_tier)),
    leverage_margin_cap: c.leverage_margin_cap,
  };
}

/** The house's numbers from the config. */
export function houseParams(c: ExchangeConfig): HouseParams {
  return {
    fee: c.fee,
    fee_min: c.fee_min,
    cap_daily: c.payout_cap_daily,
    leverage_max: c.leverage ? 2 : 1,
    line: c.leverage_line,
    warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
    warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
    carry_daily: c.leverage_carry_daily,
    min_hold_ms: c.min_hold_minutes * 60_000,
    cooling_ms: c.bankrupt_cooling_days * 86_400_000,
  };
}

/** The sessions of each market, holidays from the config. */
export function sessionsOf(c: ExchangeConfig): Record<MarketKind, Session> {
  return {
    us: { ...DEFAULT_SESSIONS.us, holidays: c.holidays_us },
    tw: { ...DEFAULT_SESSIONS.tw, holidays: c.holidays_tw },
    crypto: DEFAULT_SESSIONS.crypto,
    local: DEFAULT_SESSIONS.local,
  };
}
