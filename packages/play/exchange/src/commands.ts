// `/me market …` (owner 2026-11-21: no new top-level command; a group under `/me`, browsing with
// components rather than more subcommands). v1: real Taiwan and US stocks and the five local ones.
// Every answer is a neutral card with the exchange's small print, and a picture above it when one
// can be drawn.
//
// - `/me market overview`: the overview picture and, only for the caller, a select of LISTS
//   (新手推薦 · 這裡獨家 first and the default for someone with no positions, 大家都在買, 今天漲跌最多,
//   熱門台股, 熱門美股, 我的持股, 我最近看過, 我的觀察) and a select of the list's tickers (25 a page,
//   ◀ ▶ for more). Picking a ticker turns the message into its quote card (a candle chart) with
//   買 / 賣 / 加入觀察 / 回清單 and a select of the chart's timeframe (當日 / 日線 / 週線 / 月線) that
//   draws the picture again; 買 and 賣 open a modal (coins or shares; 1× or 2× where allowed), then
//   the confirmation, then the message shows the order and the position. The list select also
//   carries the three heat maps (伺服器持股圖, 熱門台股圖, 熱門美股圖), each drawn as a picture.
// - `/me market quote code:` a ticker's quote card (the code has suggestions while typing).
// - `/me market mine`: their own holdings, only to them, with 分享 buttons that post the holdings
//   or the latest trade's receipt publicly with their name, only when pressed.
// - `/me market rich`: the rich list; `範圍` picks this server's members or everyone (in a server
//   the server's by default, in a DM everyone's). Prices and holdings are global either way.
//
// Component hygiene: every control's id carries a tag of the member who opened it and its expiry,
// so a press by someone else gets a neutral refusal, an expired one says how to reopen, and both
// hold across a Core restart (nothing about them lives in memory).

import {
  ArgKind,
  argSpec,
  BOARD_SCOPE_ARG,
  boardScope,
  boardScopeArg,
  type CardBlock,
  type CardButton,
  type CommandRegistry,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  type Invocation,
  type Modal,
} from "@miyoria/commands";
import {
  type AccountRef,
  amountExamples,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  exchangeSmallPrint,
  type Pictures,
  type Places,
  parseOrderAmount,
} from "@miyoria/types";
import {
  bankruptPictureData,
  boardPictureData,
  coinText,
  defaultTimeframe,
  mapPictureData,
  marketLine,
  overviewPictureData,
  portfolioPictureData,
  quotePictureData,
  receiptPictureData,
  sharesText,
  withPicture,
} from "./pictures.js";
import { isTimeframe, TIMEFRAME_WORD, TIMEFRAMES, type Timeframe } from "./real/candles.js";
import type { RealLine, RealOrderLine } from "./real/desk.js";
import { taipeiWhen } from "./real/instruments.js";
import { LIST_KINDS, LIST_LABEL, type ListKind, pageOf } from "./real/lists.js";
import { DEFAULT_LOCAL } from "./real/local.js";
import { isMapKind, MAP_KINDS, MAP_TITLE, type MapKind } from "./real/maps.js";
import type { ExchangeService } from "./service.js";

/** A map's option value in the list select (no new subcommand: the overview's list carries them). */
const MAP_PREFIX = "map:";

export const PATHS = [
  "me market overview",
  "me market quote",
  "me market mine",
  "me market rich",
] as const;

/** The wallet's node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
const OFF = "交易所現在沒有開";
export const EXPIRED = "這個面板過期了:用 /me market overview 重新打開";
export const NOT_YOURS = "這是別人打開的面板:用 /me market overview 打開你自己的";

/** The honest line of every 2× confirmation (owner 2026-11-21). */
export const LEVERAGE_CONFIRM =
  "2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股;跳空時可能沒有預警就被自動賣出。";

const R = {
  list: "xm:list",
  tf: "xm:tf",
  pick: "xm:pick",
  page: "xm:page",
  back: "xm:back",
  buy: "xm:buy",
  sell: "xm:sell",
  order: "xm:order",
  ok: "xm:ok",
  no: "xm:no",
  watch: "xm:watch",
  share: "xm:share",
  open: "xm:open",
  cancel: "xm:cancel",
} as const;

const pct = (x: number | null) => {
  if (x === null) return "";
  const v = Math.round(x * 1000) / 10;
  return v > 0 ? `▲ +${v.toFixed(1)}%` : v < 0 ? `▼ −${Math.abs(v).toFixed(1)}%` : "0.0%";
};

/** A price in its own currency: `TWD 2045`, `101.2 魚幣` (`currency`: the coins' name). */
const nativeText = (l: RealLine, currency: string = DEFAULT_CURRENCY): string =>
  l.price === null
    ? "還沒有價格"
    : l.currency === "COIN"
      ? `${coinText(l.price)} ${currency}`
      : `${l.currency} ${l.price}`;

/**
 * A line of one ticker: its price in its currency and in coins, its change, and what the price is
 * (a quote's age, a close with its date while the market is closed, a local stock's opening
 * reference before its first tick).
 */
export function lineText(l: RealLine, currency: string = DEFAULT_CURRENCY): string {
  if (l.price === null) return `${l.code} ${l.name}:還沒有價格(第一次查詢後就有)`;
  const native =
    l.currency === "COIN"
      ? nativeText(l, currency)
      : `${nativeText(l, currency)}(約 ${l.coin_price === null ? "—" : coinText(l.coin_price)} ${currency})`;
  const what =
    l.basis === "quote"
      ? l.age_minutes === null
        ? ""
        : `,${l.age_minutes} 分鐘前的報價`
      : l.price_note === null
        ? ""
        : `,${l.price_note}`;
  return `${l.code} ${l.name}:${native} ${pct(l.change)}${what}`.replace(/ ,/, ",");
}

/** A select option's description: the price, its move, what it is, the holders. */
function optionText(r: RealLine & { holders: number | null }, currency: string): string {
  const what = r.basis === "close" ? "・收盤價" : r.basis === "reference" ? "・開盤參考價" : "";
  return `${nativeText(r, currency)} ${pct(r.change)}${what}${r.holders === null ? "" : `・${r.holders} 人持有`}`.slice(
    0,
    100,
  );
}

/** A neutral card with the small print under it, always (`currency`: the coins' name in it). */
export function card(
  title: string,
  lines: string[],
  o: { real?: boolean; leverage?: boolean; currency?: string } = {},
  more: CardBlock[] = [],
): CommandReply {
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      ...more,
      { type: "muted", text: exchangeSmallPrint(o) },
    ],
    { accent: "neutral", title },
  );
}

/** `card` under the exchange's own name, with its coin name. */
function xcard(
  x: ExchangeService,
  lines: string[],
  o: { real?: boolean; leverage?: boolean } = {},
  more: CardBlock[] = [],
): CommandReply {
  return card(x.name, lines, { ...o, currency: x.currency }, more);
}

/** What a stranger is told: she does not know them yet (`pronoun`: how texts name her). */
const strangerLine = (pronoun: string) => `${pronoun}還不認識你,先和${pronoun}說說話吧`;

/** The beginners' local stocks' usual price, about their anchors (to ten coins). */
function localPriceWord(x: ExchangeService): number {
  const all = x.real.localCompanies();
  const mean = all.reduce((t, l) => t + l.anchor, 0) / Math.max(1, all.length);
  return Math.round(mean / 10) * 10;
}

// ---- who opened a panel, and until when ------------------------------------------------------

/** A short tag of an account (FNV-1a), carried in every control id. */
export function ownerTag(a: AccountRef): string {
  let h = 0x811c9dc5;
  for (const ch of `${a.platform}:${a.id}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

interface Stamp {
  o: string;
  e: string;
}

function stampFor(x: ExchangeService, who: AccountRef): Stamp {
  const until = Math.ceil((x.nowMs() + x.config.component_minutes * 60_000) / 60_000);
  return { o: ownerTag(who), e: until.toString(36) };
}

const cid = (route: string, s: Stamp, ...params: (string | number)[]) =>
  componentId(route, s.o, s.e, ...params);

/** The refusal of a press by someone else or after expiry; `null` when it may go on. */
function refusal(x: ExchangeService, inv: ComponentInvocation): ComponentResult | null {
  const [o, e] = inv.params;
  if (o !== ownerTag(inv.invoker))
    return ComponentResult.reply({ ...xcard(x, [NOT_YOURS]), ephemeral: true });
  const until = Number.parseInt(e ?? "", 36) * 60_000;
  if (!Number.isFinite(until) || until < x.nowMs())
    return ComponentResult.update(xcard(x, [EXPIRED]));
  return null;
}

/** A reply only the caller sees, its controls bound to them until they expire. */
function privately(x: ExchangeService, reply: CommandReply): CommandReply {
  return {
    ...reply,
    ephemeral: true,
    session: { ttlMs: x.config.component_minutes * 60_000, initiatorOnly: true },
  };
}

// ---- the overview: lists and tickers ---------------------------------------------------------

/**
 * The select of lists, with the three heat maps after them; `current` is shown chosen. A list and
 * a map may share a name (`tw`, `us`), so which of the two it is has to be said: Discord refuses a
 * select with two chosen options.
 */
function listSelect(s: Stamp, current: { list: ListKind } | { map: MapKind }): CardBlock {
  const list = "list" in current ? current.list : null;
  const map = "map" in current ? current.map : null;
  return {
    type: "select",
    select: {
      id: cid(R.list, s),
      placeholder: "選一個清單或熱力圖",
      options: [
        ...LIST_KINDS.map((k) => ({
          label: LIST_LABEL[k],
          value: k,
          ...(k === "local" ? { description: "新手先看這裡" } : {}),
          default: k === list,
        })),
        ...MAP_KINDS.map((k) => ({
          label: `熱力圖:${MAP_TITLE[k]}`,
          value: `${MAP_PREFIX}${k}`,
          description:
            k === "holdings" ? "大家持有多少(不顯示是誰),今天的漲跌" : "預設權重,今天的漲跌",
          default: k === map,
        })),
      ],
    },
  };
}

/** A heat map as a card: its biggest tiles in words, the list select, and the map as a picture. */
async function mapCard(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  kind: MapKind,
): Promise<CommandReply> {
  const s = stampFor(x, who);
  const map = x.real.map(kind);
  const top = [...map.tiles].sort((a, b) => b.weight - a.weight).slice(0, 6);
  const lines = [
    `${map.title}${map.tiles.length === 0 ? ":還沒有可以畫的股票" : `(${map.tiles.length} 格)`}`,
    ...top.map((t) => `${t.code} ${t.name}・${t.sector} ${pct(t.change) || "—"}`),
    map.footnote,
  ];
  const reply = privately(x, xcard(x, lines, { real: true }, [listSelect(s, { map: kind })]));
  return withPicture(pictures, "exchange_map", mapPictureData(x, map, x.nowMs()), reply);
}

async function overview(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  kind: ListKind | null,
  page: number,
  withOverviewPicture: boolean,
): Promise<CommandReply> {
  const person = await x.personOf(who);
  const list = kind ?? x.lists.defaultList(person);
  const s = stampFor(x, who);
  const rows = x.lists.rows(list, person);
  const p = pageOf(rows, page);
  const firstTime = person === null || x.real.portfolio(person).holdings.length === 0;
  const opened = await hasAccount(x, who);
  const view = opened === false ? await x.accountView(who) : null;
  const lines = [
    ...(firstTime && list === "local"
      ? [
          `第一次來?這裡用${x.currency}買賣股票,只是遊戲:`,
          `・新手推薦的五檔是這裡獨家,一股約 ${localPriceWord(x)} ${x.currency}、單日漲跌最多 ±10%`,
          "・台股和美股照真實報價,可以買零股;每筆收 1% 手續費",
        ]
      : []),
    `${LIST_LABEL[list]}${rows.length === 0 ? ":這裡還沒有東西" : `(${rows.length} 檔)`}`,
    ...p.items.slice(0, 5).map((l) => lineText(l, x.currency)),
    ...(p.items.length > 5 ? [`……還有 ${rows.length - 5} 檔,在下面選`] : []),
  ];
  const blocks: CardBlock[] = [listSelect(s, { list })];
  if (opened === false) {
    lines.push("", ...accountLines(x, view?.cannot_open ?? null));
    blocks.push(accountButton(s, { to: "o" }));
  }
  if (p.items.length > 0)
    blocks.push({
      type: "select",
      select: {
        id: cid(R.pick, s, list),
        placeholder: "選一檔看報價",
        options: p.items.map((r) => ({
          label: `${r.code} ${r.name}`.slice(0, 100),
          value: r.code,
          description: optionText(r, x.currency),
        })),
      },
    });
  if (p.pages > 1)
    blocks.push({
      type: "buttons",
      buttons: [
        {
          id: cid(R.page, s, list, Math.max(0, p.page - 1)),
          label: "◀",
          style: "secondary",
          disabled: p.page === 0,
        },
        {
          id: cid(R.page, s, list, p.page + 1),
          label: "▶",
          style: "secondary",
          disabled: p.page >= p.pages - 1,
        },
      ],
    });
  const reply = privately(
    x,
    xcard(
      x,
      [...lines, ...(p.pages > 1 ? [`第 ${p.page + 1} / ${p.pages} 頁`] : [])],
      { real: list !== "local" },
      blocks,
    ),
  );
  return withOverviewPicture
    ? withPicture(pictures, "exchange_overview", overviewPictureData(x, x.nowMs()), reply)
    : reply;
}

// ---- a ticker's card -------------------------------------------------------------------------

async function quoteCard(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  line: RealLine,
  back: ListKind,
  note: string | null,
  /** The chart's timeframe (from the switch); none: the session in progress, else daily. */
  chosen: Timeframe | null = null,
): Promise<CommandReply> {
  const person = await x.personOf(who);
  if (person !== null) x.real.noteView(person, line.code);
  const s = stampFor(x, who);
  const watching = person !== null && x.lists.watching(person, line.code);
  const held =
    person === null ? [] : x.real.portfolio(person).holdings.filter((h) => h.code === line.code);
  const lines = [
    ...(note === null ? [] : [note, ""]),
    lineText(line, x.currency),
    marketLine(line),
    ...(line.local
      ? [line.local.what_moves, ...(line.local.today ? [line.local.today] : [])]
      : [line.source]),
    ...held.map(
      (h) =>
        `你持有 ${sharesText(h.qty)} 股${h.leverage > 1 ? "(2 倍)" : ""}:市值 ${h.value === null ? "—" : coinText(h.value)} ${x.currency}`,
    ),
  ];
  const buttons: CardButton[] = [
    { id: cid(R.buy, s, line.code, back), label: "買", style: "primary", disabled: !x.config.open },
    {
      id: cid(R.sell, s, line.code, back),
      label: "賣",
      style: "secondary",
      disabled: held.length === 0,
    },
    {
      id: cid(R.watch, s, line.code, back, watching ? 0 : 1),
      label: watching ? "取消觀察" : "加入觀察",
      style: "secondary",
    },
    { id: cid(R.back, s, back), label: "回清單", style: "secondary" },
  ];
  const leverage = held.some((h) => h.leverage > 1);
  // The chart: the chosen timeframe, or the session in progress (daily before it has two bars).
  let set = await x.real.candles(line.code, chosen ?? defaultTimeframe(line));
  if (chosen === null && set && set.tf === "intraday" && set.candles.length < 2)
    set = await x.real.candles(line.code, "daily");
  const tf = set?.tf ?? chosen ?? "daily";
  const timeframes: CardBlock = {
    type: "select",
    select: {
      id: cid(R.tf, s, line.code, back),
      placeholder: "K 線:當日 / 日線 / 週線 / 月線",
      options: TIMEFRAMES.map((k) => ({
        label: `K 線:${TIMEFRAME_WORD[k]}`,
        value: k,
        default: k === tf,
      })),
    },
  };
  const text = privately(
    x,
    card(
      `${line.code} ${line.name}`,
      lines,
      { real: line.local === null, leverage, currency: x.currency },
      [{ type: "buttons", buttons }, timeframes],
    ),
  );
  return set ? withPicture(pictures, "exchange_quote", quotePictureData(x, set), text) : text;
}

function lineOf(x: ExchangeService, code: string): RealLine | null {
  return x.real.view().instruments.find((i) => i.code === code) ?? null;
}

// ---- orders ----------------------------------------------------------------------------------

export type Amount = { unit: "c" | "s" | "a"; value: number };

/**
 * What a modal's amount says (owner 2026-11-22, the same rule everywhere): a bare number is shares,
 * `$` and a number is coins, 全部 on a sale is everything; else the one line with both forms.
 */
export function parseAmount(
  raw: string,
  side: "buy" | "sell",
  currency: string = DEFAULT_CURRENCY,
): Amount | { error: string } {
  const r = parseOrderAmount(raw, side, currency);
  if (!r.ok) return { error: r.message };
  const a = r.amount;
  return a.unit === "all"
    ? { unit: "a", value: 0 }
    : { unit: a.unit === "coins" ? "c" : "s", value: a.value };
}

function orderModal(
  x: ExchangeService,
  s: Stamp,
  side: "buy" | "sell",
  line: RealLine,
  back: ListKind,
): Modal {
  const fields: Modal["fields"] = [
    {
      id: "amount",
      label:
        side === "buy"
          ? `買多少:數字是股數,$ 開頭是${x.currency}`
          : `賣多少:數字是股數,$ 開頭是${x.currency}`,
      placeholder: amountExamples(line.coin_price, side, x.currency).slice(0, 100),
      maxLength: 24,
    },
  ];
  if (side === "buy" && line.local === null && x.config.leverage)
    fields.push({
      id: "leverage",
      label: "倍數:1 或 2(2 倍要先在會員頁同意風險)",
      placeholder: "1",
      required: false,
      maxLength: 1,
    });
  return {
    id: cid(R.order, s, side, line.code, back),
    title: `${side === "buy" ? "買進" : "賣出"} ${line.code}`.slice(0, 45),
    fields,
  };
}

/** A sale's request from what they typed: plain shares or all; a leveraged-only holding closes whole. */
function saleRequest(
  x: ExchangeService,
  person: string | null,
  code: string,
  amount: Amount,
): {
  side: "sell";
  code: string;
  shares?: number;
  coins?: number;
  all?: boolean;
  position?: string;
} {
  const held =
    person === null ? [] : x.real.portfolio(person).holdings.filter((h) => h.code === code);
  const plain = held.filter((h) => h.leverage <= 1);
  const lev = held.find((h) => h.leverage > 1);
  if (plain.length === 0 && lev) return { side: "sell", code, position: lev.id };
  return amount.unit === "s"
    ? { side: "sell", code, shares: amount.value }
    : amount.unit === "c"
      ? { side: "sell", code, coins: amount.value }
      : { side: "sell", code, all: true };
}

async function requestOf(
  x: ExchangeService,
  who: AccountRef,
  side: "buy" | "sell",
  code: string,
  amount: Amount,
  lev: number,
) {
  if (side === "buy")
    return {
      side,
      code,
      ...(amount.unit === "s" ? { shares: amount.value } : { coins: amount.value }),
      leverage: lev,
    } as const;
  return saleRequest(x, await x.personOf(who), code, amount);
}

async function confirmCard(
  x: ExchangeService,
  inv: ComponentInvocation,
  side: "buy" | "sell",
  code: string,
  back: ListKind,
  amount: Amount,
  lev: number,
): Promise<CommandReply> {
  const s = stampFor(x, inv.invoker);
  const q = await x.real.quote(
    inv.invoker,
    await requestOf(x, inv.invoker, side, code, amount, lev),
  );
  if (!q.ok)
    return privately(
      x,
      xcard(x, [q.message], { real: true }, [
        {
          type: "buttons",
          buttons: [{ id: cid(R.back, s, back), label: "回清單", style: "secondary" }],
        },
      ]),
    );
  const amt = amount.unit === "a" ? "all" : String(amount.value);
  const leverage = q.quote.leverage > 1;
  return privately(
    x,
    card(
      `確認${side === "buy" ? "買進" : "賣出"} ${code}`,
      [q.quote.sentence, ...(leverage ? [LEVERAGE_CONFIRM] : [])],
      { real: lineOf(x, code)?.local === null, leverage, currency: x.currency },
      [
        {
          type: "buttons",
          buttons: [
            {
              id: cid(R.ok, s, side, code, amt, amount.unit, lev, back),
              label: leverage ? "我了解風險,確認" : "確認",
              style: leverage ? "danger" : "primary",
            },
            { id: cid(R.no, s, code, back), label: "取消", style: "secondary" },
          ],
        },
      ],
    ),
  );
}

async function placeOrder(
  x: ExchangeService,
  pictures: Pictures | null,
  inv: ComponentInvocation,
  side: "buy" | "sell",
  code: string,
  amount: Amount,
  lev: number,
  back: ListKind,
): Promise<CommandReply> {
  // The same press (message and control) is the same order. The prefix is the invoker's platform:
  // `discord` on Discord, so a key written before stays the same key (no second order on a retry).
  const key = `${inv.context.platform}:${inv.messageId ?? "none"}:${inv.customId}`;
  const r = await x.real.place(
    inv.invoker,
    await requestOf(x, inv.invoker, side, code, amount, lev),
    key,
  );
  const line = lineOf(x, code);
  if (!line) return privately(x, xcard(x, ["沒有這個標的"]));
  const note = r.ok
    ? `委託已送出:${side === "buy" ? "買進" : "賣出"} ${code}${r.order.status === "open" ? `,${orderWhen(r.order)}` : ""}。`
    : r.message;
  return quoteCard(x, pictures, inv.invoker, line, back, note);
}

/** When a waiting order fills, in words (Taipei time while its market is closed). */
export function orderWhen(o: Pick<RealOrderLine, "next_open">): string {
  return o.next_open === null
    ? "下一筆有效報價成交(成交前可以在會員頁或 /me market mine 取消)"
    : `現在休市,下一個開盤 ${taipeiWhen(Date.parse(o.next_open))}(台北時間)後第一筆有效報價成交;之前可以在會員頁或 /me market mine 取消`;
}

// ---- opening an account from Discord ---------------------------------------------------------

/** Where an opened account goes on: the overview, their holdings, or buying a ticker. */
type Then = { to: "o" } | { to: "m" } | { to: "b"; code: string; back: ListKind };

const thenParams = (t: Then): string[] => (t.to === "b" ? [t.to, t.code, t.back] : [t.to]);

/**
 * The rules in a few lines (free, who may open, the small print under the card) and a 開戶 button
 * bound to this member; `why` is the reason they cannot yet, when it is known.
 */
function accountLines(x: ExchangeService, why: string | null): string[] {
  const c = x.config;
  return [
    `還沒開戶:開戶不花錢,開了之後才能買賣(只是遊戲,${x.currency}不能換成錢)。`,
    `條件:${x.pronoun}認識你滿 ${c.account_min_days} 天、羈絆到「${c.account_min_tier}」以上。`,
    ...(why === null ? [] : [`現在還不行:${why}`]),
  ];
}

function accountButton(s: Stamp, then: Then): CardBlock {
  return {
    type: "buttons",
    buttons: [{ id: cid(R.open, s, ...thenParams(then)), label: "開戶", style: "primary" }],
  };
}

/** A whole card asking them to open an account first (`/me market mine`, 買 without one). */
async function accountCard(
  x: ExchangeService,
  who: AccountRef,
  then: Then,
  back: ListKind = "local",
): Promise<CommandReply> {
  const s = stampFor(x, who);
  const view = await x.accountView(who);
  return privately(
    x,
    card(
      "開戶",
      accountLines(x, view?.cannot_open ?? null),
      { real: false, currency: x.currency },
      [
        accountButton(s, then),
        {
          type: "buttons",
          buttons: [{ id: cid(R.back, s, back), label: "先逛逛:新手推薦", style: "secondary" }],
        },
      ],
    ),
  );
}

/** Whether `who` has an account (`null`: she does not know them). */
async function hasAccount(x: ExchangeService, who: AccountRef): Promise<boolean | null> {
  const view = await x.accountView(who);
  return view === null ? null : view.opened;
}

/** `/me market mine` and its 分享 buttons, for someone with an account. */
async function mineCard(
  x: ExchangeService,
  pictures: Pictures | null,
  who: AccountRef,
  displayName: string,
  note: string | null = null,
): Promise<CommandReply> {
  const p = await x.portfolio(who);
  if (!p) return { ...xcard(x, [strangerLine(x.pronoun)]), ephemeral: true };
  if (!p.account.opened) return accountCard(x, who, { to: "m" });
  const real = x.real.portfolio((await x.personOf(who)) ?? "");
  const lines = real.holdings.map(
    (h) =>
      `${h.code} ${h.name} ${sharesText(h.qty)} 股${h.leverage > 1 ? "・2 倍" : ""}:市值 ${h.value === null ? "—" : coinText(h.value)} ${x.currency},成本 ${h.cost}`,
  );
  if (real.bankrupt) lines.unshift("破產冷靜期中:所有持股已經結清,不會欠錢");
  if (lines.length === 0) lines.push("沒有持股");
  const waiting = real.orders.filter((o) => o.status === "open");
  if (waiting.length > 0) {
    lines.push("", "等待中的委託:");
    for (const o of waiting)
      lines.push(
        `・${o.side === "buy" ? `買進 ${o.code} ${o.coins} ${x.currency}` : `賣出 ${o.code} ${sharesText(o.qty)} 股`}:${orderWhen(o)}`,
      );
  }
  const leverage = real.holdings.some((h) => h.leverage > 1);
  const s = stampFor(x, who);
  const latest = real.fills[0];
  // Nothing to share: no share button, a way to the beginners' list instead (owner 2026-11-22).
  const buttons: CardButton[] =
    real.holdings.length > 0
      ? [{ id: cid(R.share, s, "p", "0"), label: "分享持股", style: "secondary" }]
      : [{ id: cid(R.back, s, "local"), label: "去看新手推薦", style: "primary" }];
  if (latest)
    buttons.push({
      id: cid(R.share, s, "r", latest.id),
      label: "分享最近一筆成交",
      style: "secondary",
    });
  const blocks: CardBlock[] = [{ type: "buttons", buttons }];
  if (waiting.length > 0)
    blocks.push({
      type: "buttons",
      buttons: waiting.slice(0, 5).map((o) => ({
        id: cid(R.cancel, s, o.id),
        label: `取消 ${o.side === "buy" ? "買" : "賣"} ${o.code}`.slice(0, 80),
        style: "secondary" as const,
      })),
    });
  const text = privately(
    x,
    card(
      "你的持股",
      [
        ...(note === null ? [] : [note, ""]),
        ...lines,
        `只有你看得到;按「分享」才會用你的名字貼出來。${x.pronoun}也看不到任何人的持股。`,
      ],
      { real: true, leverage, currency: x.currency },
      blocks,
    ),
  );
  if (real.bankrupt)
    return withPicture(
      pictures,
      "exchange_bankrupt",
      bankruptPictureData(x, displayName, real.bankrupt),
      text,
    );
  return withPicture(
    pictures,
    "exchange_portfolio",
    portfolioPictureData(x, displayName, real, p.account.balance),
    text,
  );
}

// ---- registration ----------------------------------------------------------------------------

export function registerCommands(
  registry: CommandRegistry,
  service: () => ExchangeService | null,
  pictures: () => Pictures | null,
  /** The exchange's name in this profile (`[character] exchange_name`). */
  title: () => string = () => DEFAULT_CHARACTER.exchange_name,
  /** Identity's servers and members, for the per-server rich list; none: one list. */
  places: () => Places | undefined = () => undefined,
  /** The coins' name when no service answers (`CurrencyKey`). */
  currency: () => string = () => DEFAULT_CURRENCY,
  /** How texts name her (`[character] pronoun`) when no service answers. */
  pronoun: () => string = () => DEFAULT_CHARACTER.pronoun,
): void {
  /** A card under the exchange's name, in the coins' name of whatever answers. */
  const titled = (
    lines: string[],
    o: { real?: boolean; leverage?: boolean } = {},
    more: CardBlock[] = [],
  ): CommandReply =>
    card(title(), lines, { ...o, currency: service()?.currency ?? currency() }, more);
  const her = () => service()?.pronoun ?? pronoun();
  registry.setGroupDescription("me market", `${title()}:新手推薦、台股美股行情、你的持股、富人榜`);
  const open = (): ExchangeService | null => {
    const x = service();
    return x === null || !x.config.open ? null : x;
  };
  const run = async (fn: (x: ExchangeService) => Promise<CommandReply>): Promise<CommandReply> => {
    const x = open();
    if (x === null) return titled([OFF]);
    return fn(x);
  };
  /** A control's handler: the market must be open, the press the opener's and in time. */
  const press =
    (
      fn: (
        x: ExchangeService,
        inv: ComponentInvocation,
        rest: readonly (string | undefined)[],
      ) => Promise<ComponentResult>,
    ) =>
    async (inv: ComponentInvocation): Promise<ComponentResult> => {
      const x = open();
      if (x === null) return ComponentResult.update(titled([OFF]));
      const no = refusal(x, inv);
      if (no) return no;
      return fn(x, inv, inv.params.slice(2));
    };
  const listOf = (raw: string | undefined): ListKind =>
    (LIST_KINDS as readonly string[]).includes(raw ?? "") ? (raw as ListKind) : "local";
  const gone = () => ComponentResult.update(titled(["沒有這個標的"]));

  const routes = [
    defineRoute({
      route: R.list,
      handle: press(async (x, inv) => {
        const value = inv.values[0] ?? "";
        const map = value.startsWith(MAP_PREFIX) ? value.slice(MAP_PREFIX.length) : null;
        if (map !== null && isMapKind(map))
          return ComponentResult.update(await mapCard(x, pictures(), inv.invoker, map));
        return ComponentResult.update(
          await overview(x, pictures(), inv.invoker, listOf(value), 0, false),
        );
      }),
    }),
    defineRoute({
      route: R.tf,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        const tf = inv.values[0];
        return ComponentResult.update(
          await quoteCard(
            x,
            pictures(),
            inv.invoker,
            line,
            listOf(kind),
            null,
            isTimeframe(tf) ? tf : null,
          ),
        );
      }),
    }),
    defineRoute({
      route: R.page,
      handle: press(async (x, inv, [kind, page]) =>
        ComponentResult.update(
          await overview(x, pictures(), inv.invoker, listOf(kind), Number(page) || 0, false),
        ),
      ),
    }),
    defineRoute({
      route: R.back,
      handle: press(async (x, inv, [kind]) =>
        ComponentResult.update(await overview(x, pictures(), inv.invoker, listOf(kind), 0, true)),
      ),
    }),
    defineRoute({
      route: R.pick,
      handle: press(async (x, inv, [kind]) => {
        const line = lineOf(x, inv.values[0] ?? "");
        if (!line)
          return ComponentResult.update(
            await overview(x, pictures(), inv.invoker, listOf(kind), 0, false),
          );
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), null),
        );
      }),
    }),
    defineRoute({
      route: R.watch,
      handle: press(async (x, inv, [code, kind, on]) => {
        const person = await x.personOf(inv.invoker);
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        if (!person) return ComponentResult.update(titled([strangerLine(her())]));
        const r = x.lists.setWatch(person, line.code, on === "1");
        const note = r.ok ? (r.watching ? `已加入觀察(${r.count} 檔)` : "已取消觀察") : r.message;
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), note),
        );
      }),
    }),
    defineRoute({
      route: R.buy,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        // No account yet: the rules and a 開戶 button that comes back to this buy.
        if ((await hasAccount(x, inv.invoker)) === false)
          return ComponentResult.update(
            await accountCard(
              x,
              inv.invoker,
              { to: "b", code: line.code, back: listOf(kind) },
              listOf(kind),
            ),
          );
        return ComponentResult.modal(
          orderModal(x, stampFor(x, inv.invoker), "buy", line, listOf(kind)),
        );
      }),
    }),
    defineRoute({
      route: R.sell,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line) return gone();
        return ComponentResult.modal(
          orderModal(x, stampFor(x, inv.invoker), "sell", line, listOf(kind)),
        );
      }),
    }),
    defineRoute({
      route: R.order,
      handle: press(async (x, inv, [side, code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line || (side !== "buy" && side !== "sell")) return gone();
        const amount = parseAmount(inv.field("amount"), side, x.currency);
        if ("error" in amount) {
          return ComponentResult.update(
            await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), amount.error),
          );
        }
        const lev = inv.field("leverage") === "2" ? 2 : 1;
        return ComponentResult.update(
          await confirmCard(x, inv, side, line.code, listOf(kind), amount, lev),
        );
      }),
    }),
    defineRoute({
      route: R.ok,
      handle: press(async (x, inv, [side, code, amt, unit, lev, kind]) => {
        if (
          (side !== "buy" && side !== "sell") ||
          !code ||
          !amt ||
          (unit !== "c" && unit !== "s" && unit !== "a")
        )
          return ComponentResult.update(titled([EXPIRED]));
        const amount: Amount = { unit, value: unit === "a" ? 0 : Number(amt) };
        return ComponentResult.update(
          await placeOrder(
            x,
            pictures(),
            inv,
            side,
            code,
            amount,
            lev === "2" ? 2 : 1,
            listOf(kind),
          ),
        );
      }),
    }),
    defineRoute({
      route: R.no,
      handle: press(async (x, inv, [code, kind]) => {
        const line = lineOf(x, code ?? "");
        if (!line)
          return ComponentResult.update(
            await overview(x, pictures(), inv.invoker, listOf(kind), 0, true),
          );
        return ComponentResult.update(
          await quoteCard(x, pictures(), inv.invoker, line, listOf(kind), "已取消,沒有下單。"),
        );
      }),
    }),
    defineRoute({
      route: R.open,
      // Opens their account through the same call the member page uses, then goes on to what they
      // were doing (the overview, their holdings, or the buy they pressed).
      handle: press(async (x, inv, [to, code, kind]) => {
        const r = await x.openAccount(inv.invoker);
        const s = stampFor(x, inv.invoker);
        if (!r.ok)
          return ComponentResult.update(
            privately(
              x,
              card(
                "開戶",
                [`還不能開戶:${r.message}`, ...accountLines(x, null).slice(1)],
                { currency: x.currency },
                [
                  {
                    type: "buttons",
                    buttons: [
                      { id: cid(R.back, s, "local"), label: "先逛逛:新手推薦", style: "secondary" },
                    ],
                  },
                ],
              ),
            ),
          );
        if (to === "b") {
          const line = lineOf(x, code ?? "");
          if (line) return ComponentResult.modal(orderModal(x, s, "buy", line, listOf(kind)));
        }
        if (to === "m")
          return ComponentResult.update(
            await mineCard(x, pictures(), inv.invoker, inv.invoker_display_name, "開好戶了。"),
          );
        return ComponentResult.update(await overview(x, pictures(), inv.invoker, null, 0, false));
      }),
    }),
    defineRoute({
      route: R.cancel,
      handle: press(async (x, inv, [id]) => {
        const r = await x.real.cancel(inv.invoker, id ?? "");
        const note = r.ok
          ? r.refunded > 0
            ? `取消了,退回 ${r.refunded} ${x.currency}。`
            : "取消了。"
          : r.message;
        return ComponentResult.update(
          await mineCard(x, pictures(), inv.invoker, inv.invoker_display_name, note),
        );
      }),
    }),
    defineRoute({
      route: R.share,
      // Posted where the command was used, with their name, only when they press it.
      handle: press(async (x, inv, [what, ref]) => {
        const person = await x.personOf(inv.invoker);
        if (!person)
          return ComponentResult.reply({
            ...titled([strangerLine(her())]),
            ephemeral: true,
          });
        const name = inv.invoker_display_name;
        const p = x.real.portfolio(person);
        if (what === "r") {
          const fill = p.fills.find((f) => f.id === ref) ?? p.fills[0];
          if (!fill)
            return ComponentResult.reply({
              ...titled(["還沒有成交紀錄"]),
              ephemeral: true,
            });
          const data = receiptPictureData(x, name, fill);
          const text = card(
            `${name} 的成交`,
            [
              `${fill.side === "sell" ? "賣出" : "買進"} ${fill.code} ${data.shares} 股,成交價 ${data.price}`,
            ],
            {
              real: lineOf(x, fill.code)?.local === null,
              leverage: fill.leverage > 1,
              currency: x.currency,
            },
          );
          return ComponentResult.reply({
            ...(await withPicture(pictures(), "exchange_receipt", data, text)),
            ephemeral: false,
          });
        }
        const account = await x.portfolio(inv.invoker);
        const balance = account?.account.balance ?? null;
        const leverage = p.holdings.some((h) => h.leverage > 1);
        const text = card(
          `${name} 的持股`,
          p.holdings.map(
            (h) => `${h.code} ${sharesText(h.qty)} 股${h.leverage > 1 ? "(2 倍)" : ""}`,
          ),
          { real: true, leverage, currency: x.currency },
        );
        return ComponentResult.reply({
          ...(await withPicture(
            pictures(),
            "exchange_portfolio",
            portfolioPictureData(x, name, p, balance),
            text,
          )),
          ephemeral: false,
        });
      }),
    }),
  ];

  registry.register(
    commandSpec("me market overview", `${title()}:市場總覽,從清單挑股票看報價、買賣`, {
      permission: NODE,
    }),
    async (inv) => {
      const x = open();
      if (x === null) return { ...titled([OFF]), ephemeral: true };
      return overview(x, pictures(), inv.invoker, null, 0, true);
    },
    { components: routes },
  );

  registry.register(
    commandSpec("me market quote", `${title()}:一檔股票的報價和走勢(圖)`, {
      args: [
        argSpec(
          "code",
          `代號或名稱:台股 2330、0050,美股 AAPL,或獨家的 ${service()?.real.localCompanies()[0]?.code ?? DEFAULT_LOCAL.feeding.code}`,
          ArgKind.string,
        ),
      ],
      permission: NODE,
    }),
    (inv) =>
      run(async (x) => {
        const typed = (inv.str("code") ?? "").trim().toUpperCase();
        let line = lineOf(x, typed);
        if (!line) {
          const found = await x.real.lookup(inv.invoker, typed);
          if (!found.ok) return { ...titled([found.message], { real: true }), ephemeral: true };
          line = found.instrument;
        }
        return quoteCard(x, pictures(), inv.invoker, line, "recent", null);
      }),
    {
      autocomplete: {
        code: (inv: Invocation, value: string) => {
          const x = open();
          if (x === null) return [];
          return x.lists
            .suggest(ownerTag(inv.invoker), value)
            .map((s) => ({ name: `${s.code} ${s.name}`.slice(0, 100), value: s.code }));
        },
      },
    },
  );

  registry.register(
    commandSpec("me market mine", `${title()}:你的持股(只有你看得到)`, { permission: NODE }),
    (inv) =>
      run(async (x) => {
        return mineCard(x, pictures(), inv.invoker, inv.invoker_display_name);
      }),
  );

  registry.register(
    commandSpec("me market rich", `${title()}:富人榜(圖)`, {
      args: [boardScopeArg()],
      permission: NODE,
    }),
    (inv) =>
      run(async (x) => {
        const where = boardScope(places(), inv.context, inv.str(BOARD_SCOPE_ARG));
        const b = await x.boards(inv.invoker, where.members);
        const rows = b.rich.slice(0, 10).map((r) => `${r.rank}. ${r.name} ${r.worth}`);
        const text = card(
          "富人榜",
          [
            ...(rows.length === 0 ? ["還沒有人上榜"] : rows),
            ...(where.label === "" ? [] : [where.label]),
            "預設會上榜;會員頁可以設定不上榜。",
          ],
          { real: true, currency: b.currency },
        );
        // The board is posted where anyone sees it: nobody's own place is on the picture.
        return withPicture(pictures(), "exchange_rich", { ...boardPictureData(b), me: null }, text);
      }),
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
