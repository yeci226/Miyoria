// The picture templates (docs/design/v5-play.md §9, §11.5): typed functions from data to a laid-out
// picture (`Drawn`) and the one-line summary that goes with it as alt text. Each reads like a page
// of the panel: the frame with `分類 / 頁面`, then blocks with a title and their data, a chart block
// with its 24 px headline where there is a trend, strips of facts, hairline rows. Only what the data
// has is drawn; an empty block is one plain line.

import type {
  AdminProfilePicture,
  AuctionPictureData,
  DexPictureData,
  LotteryPictureData,
  MemberProfilePicture,
  OddsPictureData,
  PictureDataMap,
  PictureKind,
  ProfilePictureData,
  WalletPictureData,
  WeekPictureData,
} from "@miyoria/types";
import { BOND_BAND_WORDS } from "@miyoria/types/bond";
import {
  type BarRow,
  barList,
  baseline,
  bipolar,
  blockTitle,
  CHART,
  type Canvas,
  CONTENT,
  columnChart,
  type Drawn,
  facts,
  finish,
  legend,
  localTime,
  meter,
  num,
  page,
  paragraph,
  plainLine,
  ring,
  rows,
  SECONDARY_LINE,
  SPACE,
  segmentBar,
  shortDate,
  signed,
  stepMeter,
  T,
  TYPE,
  X0,
} from "./draw.js";
import {
  exchangeBankruptPicture,
  exchangeMapPicture,
  exchangeOverviewPicture,
  exchangePortfolioPicture,
  exchangeQuotePicture,
  exchangeReceiptPicture,
  exchangeRichPicture,
} from "./exchange.js";
import { giftPicture } from "./gift.js";
import { textWidth } from "./measure.js";

/** A template's result: the layout and the summary. */
export type Template<D> = (data: D) => { drawn: Drawn; alt: string };

/** The member page's words for trust and familiarity, lowest first (`trustBand`, `familiarityBand`). */
export const TRUST_WORDS = ["還不信任", "有點信任", "信任", "很信任"] as const;
export const FAMILIARITY_WORDS = ["陌生", "見過幾次", "有點熟", "熟", "很熟"] as const;

/** Rarities lowest first, and their colours in a segment bar (quiet, light neutral, the two accents). */
const RARITY_COLORS: Readonly<Record<string, string>> = {
  N: T.chartQuiet,
  R: T.chart3,
  SR: T.chart2,
  SSR: T.chart1,
};
const rarityColor = (r: string): string => RARITY_COLORS[r] ?? T.chartFaint;

/** Rows past `limit` folded into one 其他 row. */
function topRows(items: readonly { label: string; amount: number }[], limit: number): BarRow[] {
  const sorted = [...items].filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
  const shown: BarRow[] = sorted.slice(0, limit).map((i) => ({ label: i.label, value: i.amount }));
  const rest = sorted.slice(limit).reduce((t, i) => t + i.amount, 0);
  if (rest > 0) shown.push({ label: "其他", value: rest, color: T.chartQuiet });
  return shown;
}

const sum = (xs: readonly number[]): number => xs.reduce((t, x) => t + x, 0);

/** `M/D – M/D` of a run of days. */
function rangeOf(days: readonly { date: string }[]): string | null {
  const first = days[0];
  const last = days[days.length - 1];
  return first && last ? `${shortDate(first.date)} – ${shortDate(last.date)}` : null;
}

/**
 * A chart block's head (DESIGN.md `ChartBlock`): the title 13 muted, the headline 24 bold with its
 * unit, one muted aside on the right. Answers the bottom.
 */
function chartHead(
  c: Canvas,
  top: number,
  title: string,
  value: string,
  unit: string | null,
  aside: string | null,
): number {
  c.text(X0, baseline(top, TYPE.label), title, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
  const y = baseline(top + TYPE.label + 6, TYPE.headline);
  const asideW = aside === null ? 0 : Math.min(textWidth(aside, TYPE.label) + 16, CONTENT * 0.5);
  const w = c.text(X0, y, value, {
    size: TYPE.headline,
    weight: 700,
    max: CONTENT - asideW - (unit === null ? 0 : 40),
  });
  if (unit !== null) {
    c.text(X0 + w + 6, y, unit, { size: TYPE.body, fill: T.sheetMuted, max: CONTENT - asideW - w - 6 });
  }
  if (aside !== null) {
    c.text(X0 + CONTENT, y, aside, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: asideW - 8 });
  }
  return top + TYPE.label + 6 + TYPE.headline + 10;
}

// ---- wallet ---------------------------------------------------------------------------------

export const walletPicture: Template<WalletPictureData> = (d) => {
  const { canvas: c, top } = page("錢包", d.name, rangeOf(d.days));
  const income = sum(d.income.map((i) => i.amount));
  const spending = sum(d.spending.map((i) => i.amount));
  const aside = [`這一週 ${signed(income)} / ${signed(-spending)}`];
  if (d.streak !== null && d.streak > 0) aside.push(`連續簽到 ${d.streak} 天`);
  let y = chartHead(c, top, "餘額", num(d.balance), d.currency, aside.join("・"));
  y = legend(c, y, [
    { label: "收入", color: CHART[0] },
    { label: "支出", color: CHART[1] },
  ]);
  y = columnChart(
    c,
    y + 8,
    d.days.map((x) => shortDate(x.date)),
    [
      { label: "收入", color: CHART[0], values: d.days.map((x) => x.income) },
      { label: "支出", color: CHART[1], values: d.days.map((x) => x.spending), down: true },
    ],
    104,
  );
  for (const [title, items, color, total] of [
    ["收入", d.income, CHART[0], income],
    ["支出", d.spending, CHART[1], spending],
  ] as const) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, title, total > 0 ? `${num(total)} ${d.currency}` : null);
    const list = topRows(items, 5);
    y = list.length === 0 ? plainLine(c, y, `這一週沒有${title}`) : barList(c, y, list, color);
  }
  const topIn = topRows(d.income, 1)[0];
  const topOut = topRows(d.spending, 1)[0];
  const most = [
    topIn ? `收入最多的是${topIn.label} ${num(topIn.value)}` : null,
    topOut ? `支出最多的是${topOut.label} ${num(topOut.value)}` : null,
  ].filter((x) => x !== null);
  const alt = `${d.name}的錢包：餘額 ${num(d.balance)} ${d.currency}；這一週收入 ${num(income)}、支出 ${num(spending)}${most.length > 0 ? `（${most.join("，")}）` : ""}。`;
  return { drawn: finish(c, y), alt };
};

// ---- the profile ----------------------------------------------------------------------------

const RING = 132;

/** The ring with the tier beside it; answers the bottom. */
function standing(
  c: Canvas,
  top: number,
  d: ProfilePictureData,
  value: number | undefined,
): number {
  ring(c, X0, top, RING, { ...d.ring, ...(value === undefined ? {} : { value }) }, d.tier_label);
  const x = X0 + RING + 28;
  const w = CONTENT - RING - 28;
  let y = top + 14;
  c.text(x, baseline(y, TYPE.small), "關係", { size: TYPE.small, fill: T.sheetMuted });
  y += TYPE.small + 6;
  c.text(x, baseline(y, TYPE.headline), d.tier_label, { size: TYPE.headline, weight: 700, max: w });
  y += TYPE.headline + 10;
  const next = d.next_label === null ? "已經是最高的一級" : `離「${d.next_label}」還有一段`;
  c.text(x, baseline(y, TYPE.label), next, { size: TYPE.label, fill: T.sheetMuted, max: w });
  y += TYPE.label + 10;
  meter(c, x, y, w, d.tier_progress, T.primary);
  y += 4 + 18;
  c.text(x, baseline(y, TYPE.small), "她怎麼叫你", { size: TYPE.small, fill: T.sheetMuted });
  y += TYPE.small + 6;
  c.text(x, baseline(y, TYPE.body), d.call_name === null ? "還沒有設定" : `「${d.call_name}」`, {
    max: w,
    ...(d.call_name === null ? { fill: T.sheetMuted } : {}),
  });
  y += TYPE.body;
  return Math.max(top + RING, y);
}

/** A band in words over its step meter, in a column of a strip. */
function band(c: Canvas, x: number, top: number, w: number, label: string, word: string, words: readonly string[]): void {
  c.text(x, baseline(top, TYPE.small), label, { size: TYPE.small, fill: T.sheetMuted, max: w });
  c.text(x, baseline(top + TYPE.small + 6, TYPE.body), word, { weight: 700, max: w });
  const lit = words.indexOf(word) + 1;
  if (words.length > 0 && lit > 0) stepMeter(c, x, top + TYPE.small + 6 + TYPE.body + 8, Math.min(w, 120), words.length, lit);
}

function memberProfile(d: MemberProfilePicture): { drawn: Drawn; alt: string } {
  const { canvas: c, top } = page("她眼中的你", d.name, null);
  let y = standing(c, top, d, undefined) + SPACE.stage;
  const col = CONTENT / 3;
  band(c, X0, y, col - 16, "親近", d.closeness, BOND_BAND_WORDS);
  band(c, X0 + col, y, col - 16, "信任", d.trust, TRUST_WORDS);
  band(c, X0 + col * 2, y, col - 16, "熟悉", d.familiarity, FAMILIARITY_WORDS);
  y += TYPE.small + 6 + TYPE.body + 8 + 4;
  if (d.feeling !== null && d.feeling.trim() !== "") {
    y += SPACE.stage;
    y = blockTitle(c, y, "她寫給你的話");
    y = paragraph(c, y, d.feeling, 4);
  }
  const alt = [
    `她眼中的${d.name}：${d.tier_label}`,
    d.next_label === null ? "已經是最高的一級" : `離「${d.next_label}」還有一段`,
    `親近「${d.closeness}」、信任「${d.trust}」、熟悉「${d.familiarity}」`,
    d.call_name === null ? null : `她叫你「${d.call_name}」`,
  ]
    .filter((x) => x !== null)
    .join("；");
  return { drawn: finish(c, y), alt: `${alt}。` };
}

/** The eight numbers as the person sheet names and draws them. */
const VALUES: readonly {
  key: keyof AdminProfilePicture["values"];
  label: string;
  scale: "hundred" | "unit" | "signed";
}[] = [
  { key: "trust", label: "信任", scale: "hundred" },
  { key: "familiarity", label: "熟悉", scale: "hundred" },
  { key: "warmth", label: "好感", scale: "signed" },
  { key: "respect", label: "敬意", scale: "signed" },
  { key: "ease", label: "自在", scale: "unit" },
  { key: "grudge", label: "心結", scale: "unit" },
  { key: "longing", label: "想念", scale: "unit" },
  { key: "rapport", label: "默契", scale: "unit" },
];

const fixed = (n: number, digits: number): string =>
  (Number.isFinite(n) ? n : 0).toFixed(digits).replace("-", "−");

function adminProfile(d: AdminProfilePicture): { drawn: Drawn; alt: string } {
  const { canvas: c, top } = page("人", d.name, null);
  let y = standing(c, top, d, d.bond) + SPACE.stage;
  y = facts(c, y, [
    { label: "羈絆", value: fixed(d.bond, 1) },
    { label: "互動", value: num(d.interactions), unit: "次" },
    { label: "標籤", value: d.tags.length === 0 ? "無" : d.tags.join("、") },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "數值");
  const colW = (CONTENT - 32) / 2;
  const rowH = 30;
  VALUES.forEach((v, i) => {
    const x = X0 + (i % 2) * (colW + 32);
    const ry = y + Math.floor(i / 2) * rowH;
    const value = d.values[v.key];
    c.text(x, baseline(ry, TYPE.label), v.label, { size: TYPE.label, fill: T.sheetMuted });
    const shown = v.scale === "hundred" ? fixed(value, 1) : fixed(value, 2);
    c.text(x + colW, baseline(ry, TYPE.label), shown, { size: TYPE.label, anchor: "end" });
    const mx = x + 40;
    const mw = colW - 40 - 52;
    if (v.scale === "signed") bipolar(c, mx, ry + 6, mw, value);
    else meter(c, mx, ry + 6, mw, v.scale === "hundred" ? value / 100 : value);
  });
  y += rowH * 4 - 10;
  const alt = `${d.name}：羈絆 ${fixed(d.bond, 1)}（${d.tier_label}）；${VALUES.map((v) => `${v.label} ${v.scale === "hundred" ? fixed(d.values[v.key], 1) : fixed(d.values[v.key], 2)}`).join("、")}；互動 ${num(d.interactions)} 次。`;
  return { drawn: finish(c, y), alt };
}

export const profilePicture: Template<ProfilePictureData> = (d) =>
  d.variant === "admin" ? adminProfile(d) : memberProfile(d);

// ---- the week -------------------------------------------------------------------------------

export const weekPicture: Template<WeekPictureData> = (d) => {
  const { canvas: c, top } = page("這一週", d.name, rangeOf(d.days));
  const talked = d.days.filter((x) => x.text + x.voice > 0).length;
  const lines = sum(d.days.map((x) => x.text + x.voice));
  let y = chartHead(c, top, "聊天的天數", String(talked), `/ ${d.days.length} 天`, `說了 ${num(lines)} 句`);
  y = legend(c, y, [
    { label: "文字", color: CHART[0] },
    { label: "語音", color: CHART[1] },
  ]);
  y = columnChart(
    c,
    y + 8,
    d.days.map((x) => shortDate(x.date)),
    [
      { label: "文字", color: CHART[0], values: d.days.map((x) => x.text) },
      { label: "語音", color: CHART[1], values: d.days.map((x) => x.voice) },
    ],
    96,
  );
  const cardCount = sum(d.cards.map((x) => x.count));
  y += SPACE.stage - 8;
  y = facts(c, y, [
    { label: "點的歌", value: num(d.song_count), unit: "首" },
    { label: "抽的卡", value: num(cardCount), unit: "張" },
    ...(d.coins === null
      ? []
      : [
          { label: `賺的${d.coins.currency}`, value: signed(d.coins.earned) },
          { label: `花的${d.coins.currency}`, value: signed(-d.coins.spent) },
        ]),
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "點的歌", d.song_count > d.songs.slice(0, 5).length ? `還有 ${d.song_count - Math.min(d.songs.length, 5)} 首` : null);
  y =
    d.songs.length === 0
      ? plainLine(c, y, "這一週沒有點歌")
      : rows(
          c,
          y - SPACE.rowY,
          d.songs.slice(0, 5).map((s) => ({ text: s.title, aside: s.artist })),
        ) - 4;
  if (cardCount > 0) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "抽的卡");
    y = segmentBar(
      c,
      y,
      d.cards.map((x) => ({ label: x.rarity, count: x.count, color: rarityColor(x.rarity) })),
    );
  }
  const coins =
    d.coins === null ? "" : `、${d.coins.currency}賺 ${num(d.coins.earned)} 花 ${num(d.coins.spent)}`;
  const alt = `${d.name}的這一週：${d.days.length} 天裡聊了 ${talked} 天（${num(lines)} 句）、點了 ${num(d.song_count)} 首歌、抽了 ${num(cardCount)} 張卡${coins}。`;
  return { drawn: finish(c, y), alt };
};

// ---- the dex --------------------------------------------------------------------------------

export const dexPicture: Template<DexPictureData> = (d) => {
  const { canvas: c, top } = page("圖鑑", d.name, null);
  const cards = sum(d.rarities.map((r) => r.count));
  const done = d.series.filter((s) => s.complete).length;
  let y = facts(c, top, [
    { label: "部件", value: `${num(d.parts.owned)} / ${num(d.parts.total)}` },
    { label: "卡", value: num(cards), unit: "張" },
    { label: "完成的系列", value: `${done} / ${d.series.length}` },
    {
      label: "保底",
      value: d.pity === null ? "—" : d.pity.until === 0 ? "下一張" : `再 ${num(d.pity.until)} 張`,
    },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "系列");
  if (d.series.length === 0) y = plainLine(c, y, "還沒有系列");
  for (const s of d.series) {
    const valueW = 64;
    const nameW = CONTENT * 0.42;
    const ty = baseline(y, TYPE.label);
    const w = c.text(X0, ty, s.name, { size: TYPE.label, max: nameW });
    // The title only where it has room to be read.
    if (s.complete && s.title !== "" && nameW - w - 8 >= TYPE.small * 4) {
      c.text(X0 + w + 8, ty, `「${s.title}」`, { size: TYPE.small, fill: T.primary, max: nameW - w - 8 });
    }
    meter(c, X0 + nameW + 10, y + 6, CONTENT - nameW - 10 - valueW, s.total > 0 ? s.owned / s.total : 0, s.complete ? T.primary : SECONDARY_LINE);
    c.text(X0 + CONTENT, ty, `${num(s.owned)} / ${num(s.total)}`, { size: TYPE.label, anchor: "end" });
    y += 26;
  }
  y += SPACE.stage - 16;
  y = blockTitle(c, y, "稀有度");
  y = segmentBar(
    c,
    y,
    d.rarities.map((r) => ({ label: r.rarity, count: r.count, color: rarityColor(r.rarity) })),
  );
  if (d.titles.length > 0) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "稱號");
    y = paragraph(c, y, d.titles.join("、"), 2);
  }
  const alt = `${d.name}的圖鑑：部件 ${num(d.parts.owned)} / ${num(d.parts.total)}；${d.series.map((s) => `${s.name} ${s.owned} / ${s.total}`).join("、") || "還沒有系列"}；${num(cards)} 張卡（${d.rarities.map((r) => `${r.rarity} ${r.count}`).join("、")}）${d.pity === null ? "" : d.pity.until === 0 ? "；下一張保證 SR 以上" : `；再 ${d.pity.until} 張保證 SR 以上`}。`;
  return { drawn: finish(c, y), alt };
};

// ---- the odds -------------------------------------------------------------------------------

const pct = (shown: string): string => (shown.endsWith("%") ? shown : `${shown}%`);
const pctValue = (shown: string): number => Number.parseFloat(shown) || 0;

export const oddsPicture: Template<OddsPictureData> = (d) => {
  const { canvas: c, top } = page("機率表", "每日卡", null);
  let y = facts(c, top, [
    { label: "一張", value: num(d.price), unit: d.currency },
    { label: "一天", value: num(d.per_day), unit: "張" },
    { label: "保底", value: d.pity_after === null ? "沒有" : `連續 ${num(d.pity_after)} 張` },
  ]);
  const valueWidth = 56;
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "稀有度");
  y = barList(
    c,
    y,
    d.rarities.map((r) => ({ label: "", value: pctValue(r.shown), shown: pct(r.shown), rarity: r.rarity })),
    SECONDARY_LINE,
    { max: Math.max(...d.rarities.map((r) => pctValue(r.shown)), 0), labelShare: 0.1, valueWidth },
  );
  for (const slot of d.slots) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, slot.name);
    y =
      slot.parts.length === 0
        ? plainLine(c, y, "沒有部件")
        : barList(
            c,
            y,
            slot.parts.map((p) => ({ label: p.name, value: pctValue(p.shown), shown: pct(p.shown), rarity: p.rarity })),
            SECONDARY_LINE,
            { max: Math.max(...slot.parts.map((p) => pctValue(p.shown))), labelShare: 0.42, valueWidth },
          );
  }
  const alt = `每日卡的機率：一張 ${num(d.price)} ${d.currency}，一天最多 ${num(d.per_day)} 張；${d.rarities.map((r) => `${r.rarity} ${pct(r.shown)}`).join("、")}${d.pity_after === null ? "" : `；連續 ${d.pity_after} 張沒有 SR 以上，下一張保證有`}。`;
  return { drawn: finish(c, y), alt };
};

// ---- lottery and auction (their features come later; the data is theirs to fill) --------------

const LOTTERY_STATE: Readonly<Record<LotteryPictureData["state"], string>> = {
  open: "這一週",
  drawn: "開獎了",
  cancelled: "這一週不開獎",
};

export const lotteryPicture: Template<LotteryPictureData> = (d) => {
  const when = localTime(d.draw_at, d.utc_offset_minutes);
  const { canvas: c, top } = page("樂透", LOTTERY_STATE[d.state], `開獎 ${when}`);
  const prize = Math.floor(d.pot * d.prize_share);
  let y = chartHead(
    c,
    top,
    d.state === "drawn" ? "這一期的獎金" : "目前的獎金",
    num(prize),
    d.currency,
    `${num(d.tickets)} 張・${num(d.players)} 人`,
  );
  const share = Math.round(d.prize_share * 100);
  y = facts(c, y + 14, [
    { label: "一張", value: num(d.ticket_price), unit: d.currency },
    { label: "每人每週", value: num(d.per_person), unit: "張" },
    { label: "獎金 / 燒掉", value: `${share}% / ${100 - share}%` },
    ...(d.mine === null ? [] : [{ label: "你買了", value: num(d.mine.tickets), unit: "張" }]),
  ]);
  y += SPACE.stage - 8;
  if (d.state === "open") {
    y = blockTitle(c, y, "人數", `${num(d.players)} / ${num(d.min_players)}`);
    meter(c, X0, y, CONTENT, d.min_players > 0 ? d.players / d.min_players : 1);
    y += 4 + 14;
    y = plainLine(
      c,
      y,
      d.players >= d.min_players
        ? `人數夠了，${when} 開獎`
        : `再 ${num(d.min_players - d.players)} 個人買就會開獎；不到 ${num(d.min_players)} 個人全額退回`,
    );
  } else if (d.state === "cancelled") {
    y = plainLine(c, y, `買的人不到 ${num(d.min_players)} 個，這一週不開獎，買的全額退回`);
  } else {
    y = blockTitle(c, y, "中獎");
    y =
      d.winners.length === 0
        ? plainLine(c, y, "沒有人中獎")
        : rows(c, y - SPACE.rowY, d.winners.slice(0, 5).map((w) => ({ text: w.name, aside: `${num(w.prize)} ${d.currency}` }))) - 4;
  }
  const head =
    d.state === "cancelled"
      ? `這一週的樂透不開獎（${num(d.players)} 人，不到 ${num(d.min_players)} 人），全額退回`
      : d.state === "drawn"
        ? `樂透開獎：獎金 ${num(prize)} ${d.currency}，${d.winners.map((w) => `${w.name} ${num(w.prize)}`).join("、") || "沒有人中獎"}`
        : `這一週的樂透：獎金 ${num(prize)} ${d.currency}，${num(d.tickets)} 張、${num(d.players)} 人，${when} 開獎`;
  const mine = d.mine === null ? "" : `；你買了 ${num(d.mine.tickets)} 張`;
  return { drawn: finish(c, y), alt: `${head}${mine}。` };
};

const AUCTION_STATE: Readonly<Record<AuctionPictureData["state"], string>> = {
  upcoming: "還沒開始",
  open: "進行中",
  closed: "結束了",
  cancelled: "取消了",
};

export const auctionPicture: Template<AuctionPictureData> = (d) => {
  const at = (iso: string) => localTime(iso, d.utc_offset_minutes);
  const { canvas: c, top } = page("拍賣", d.item.name, AUCTION_STATE[d.state]);
  const closed = d.state === "closed";
  let y =
    d.top === null
      ? chartHead(c, top, "起標", num(d.start_bid), d.currency, "還沒有人出價")
      : chartHead(c, top, closed ? "得標" : "目前最高", num(d.top.amount), d.currency, d.top.name);
  y = facts(c, y + 14, [
    { label: "起標", value: num(d.start_bid), unit: d.currency },
    { label: "每次至少加", value: num(d.step) },
    { label: "出價", value: num(d.bids), unit: "次" },
    { label: "人數", value: num(d.bidders), unit: "人" },
  ]);
  y += 16;
  y = facts(c, y, [
    { label: "開始", value: at(d.opens_at) },
    { label: d.extended ? "結束（延長了）" : "結束", value: at(d.ends_at) },
    ...(d.mine === null
      ? []
      : [
          {
            label: "你出的",
            value: num(d.mine.amount),
            unit: d.mine.leading ? (closed ? "得標" : "最高") : "被超過了",
          },
        ]),
  ]);
  if (d.item.detail !== null && d.item.detail.trim() !== "") {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "拍品");
    y = paragraph(c, y, d.item.detail, 3);
  }
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "最近的出價");
  y =
    d.history.length === 0
      ? plainLine(c, y, "還沒有人出價")
      : rows(c, y - SPACE.rowY, d.history.slice(0, 5).map((b) => ({ text: b.name, aside: `${num(b.amount)}・${at(b.at)}` }))) - 4;
  const lead =
    d.top === null
      ? `還沒有人出價，起標 ${num(d.start_bid)} ${d.currency}`
      : `${closed ? "得標" : "目前最高"} ${num(d.top.amount)} ${d.currency}（${d.top.name}）`;
  const mine =
    d.mine === null ? "" : `；你出了 ${num(d.mine.amount)}${d.mine.leading ? "，是最高" : "，被超過了"}`;
  const alt = `拍賣「${d.item.name}」${AUCTION_STATE[d.state]}：${lead}，${num(d.bids)} 次出價、${num(d.bidders)} 人，${at(d.ends_at)} 結束${d.extended ? "（延長了）" : ""}${mine}。`;
  return { drawn: finish(c, y), alt };
};

/** Every template by kind. */
export const TEMPLATES: { readonly [K in PictureKind]: Template<PictureDataMap[K]> } = {
  wallet: walletPicture,
  profile: profilePicture,
  week: weekPicture,
  dex: dexPicture,
  odds: oddsPicture,
  lottery: lotteryPicture,
  auction: auctionPicture,
  exchange_quote: exchangeQuotePicture,
  exchange_portfolio: exchangePortfolioPicture,
  exchange_overview: exchangeOverviewPicture,
  exchange_rich: exchangeRichPicture,
  exchange_receipt: exchangeReceiptPicture,
  exchange_bankrupt: exchangeBankruptPicture,
  exchange_map: exchangeMapPicture,
  gift: giftPicture,
};
