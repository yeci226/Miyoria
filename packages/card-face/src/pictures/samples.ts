// Invented data for every template: what the tests lay out and the sample PNGs are drawn from
// (`packages/api/test/pictures.test.ts`). Every name here is made up. `LONG` is the same data
// with the longest names and the biggest numbers a picture has to hold.

import type { ExchangeCandlePoint, PictureDataMap, PictureKind } from "@miyoria/types";

/**
 * 130 made-up daily candles (prices in cents) ending at 2,045.00, with volume: a slow climb with a
 * wobble, deterministic (no random numbers), so the sample picture is the same every time.
 */
const SAMPLE_CANDLES: ExchangeCandlePoint[] = (() => {
  const out: ExchangeCandlePoint[] = [];
  let close = 160_000;
  for (let i = 0; i < 130; i++) {
    const open = close;
    const drift = 330 + Math.round(Math.sin(i / 5) * 2_400 + Math.cos(i / 2.3) * 1_100);
    close = Math.max(1_000, open + drift);
    const high = Math.max(open, close) + 600 + ((i * 37) % 900);
    const low = Math.min(open, close) - 500 - ((i * 53) % 800);
    const day = new Date(Date.UTC(2026, 4, 25) + Math.floor((i * 7) / 5) * 86_400_000);
    out.push({
      o: open,
      h: high,
      l: low,
      c: close,
      v: 18_000_000 + ((i * 7_919_993) % 30_000_000),
      label: `${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
    });
  }
  // The last close is the sample's price.
  const last = out.at(-1) as ExchangeCandlePoint;
  const shift = 204_500 - last.c;
  return out.map((k) => ({ ...k, o: k.o + shift, h: k.h + shift, l: k.l + shift, c: k.c + shift }));
})();

const WEEK =["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"];

export const PICTURE_SAMPLES: { readonly [K in PictureKind]: PictureDataMap[K] } = {
  wallet: {
    name: "小魚乾",
    currency: "魚幣",
    balance: 1280,
    streak: 6,
    days: WEEK.map((date, i) => ({
      date,
      income: [60, 25, 80, 0, 45, 90, 40][i] ?? 0,
      spending: [0, 40, 10, 0, 120, 0, 50][i] ?? 0,
    })),
    income: [
      { label: "簽到", amount: 120 },
      { label: "聊天", amount: 95 },
      { label: "聽完一首歌", amount: 60 },
      { label: "每日任務", amount: 45 },
      { label: "她送的", amount: 20 },
    ],
    spending: [
      { label: "每日卡", amount: 90 },
      { label: "餵她", amount: 80 },
      { label: "籤詩", amount: 30 },
      { label: "大螢幕留言", amount: 20 },
    ],
  },
  profile: {
    variant: "member",
    name: "小魚乾",
    ring: { lap: 2, fraction: 0.45, full: false, below: 0 },
    tier_label: "知心 II",
    next_label: "知心 III",
    tier_progress: 0.55,
    closeness: "心意相通",
    trust: "信任",
    familiarity: "熟",
    call_name: "小魚",
    feeling: "每次唱歌都會來聽到最後，還會記得我上次說想吃什麼。雖然有時候很吵，但是今天也謝謝你。",
  },
  week: {
    name: "小魚乾",
    days: WEEK.map((date, i) => ({
      date,
      text: [12, 0, 30, 8, 0, 41, 17][i] ?? 0,
      voice: [4, 0, 0, 22, 0, 10, 6][i] ?? 0,
    })),
    songs: [
      { title: "夜に駆ける", artist: "YOASOBI" },
      { title: "小幸運", artist: "田馥甄" },
      { title: "打上花火", artist: "DAOKO × 米津玄師" },
    ],
    song_count: 3,
    cards: [
      { rarity: "N", count: 2 },
      { rarity: "R", count: 3 },
      { rarity: "SR", count: 1 },
      { rarity: "SSR", count: 1 },
    ],
    coins: { currency: "魚幣", earned: 340, spent: 220 },
  },
  dex: {
    name: "小魚乾",
    parts: { owned: 34, total: 120 },
    series: [
      { name: "深海", owned: 12, total: 12, title: "深海的住民", complete: true },
      { name: "放學後", owned: 9, total: 15, title: "放學後的約定", complete: false },
      { name: "夏日祭", owned: 4, total: 18, title: "煙火大會", complete: false },
      { name: "雨天", owned: 0, total: 10, title: "雨天的窗邊", complete: false },
    ],
    rarities: [
      { rarity: "N", count: 14 },
      { rarity: "R", count: 7 },
      { rarity: "SR", count: 3 },
      { rarity: "SSR", count: 1 },
    ],
    titles: ["深海的住民"],
    pity: { since: 3, pity: 10, until: 7 },
  },
  odds: {
    currency: "魚幣",
    price: 30,
    per_day: 3,
    pity_after: 10,
    rarities: [
      { rarity: "N", shown: "60.00" },
      { rarity: "R", shown: "30.00" },
      { rarity: "SR", shown: "8.50" },
      { rarity: "SSR", shown: "1.50" },
    ],
    slots: [
      {
        name: "手",
        parts: [
          { name: "比愛心", rarity: "SR", shown: "6.25" },
          { name: "揮手", rarity: "N", shown: "43.75" },
          { name: "比耶", rarity: "R", shown: "25.00" },
          { name: "拿著麥克風", rarity: "R", shown: "25.00" },
        ],
      },
      {
        name: "配件",
        parts: [
          { name: "鯨魚髮夾", rarity: "R", shown: "30.00" },
          { name: "星星耳環", rarity: "SSR", shown: "2.00" },
          { name: "沒有", rarity: "N", shown: "68.00" },
        ],
      },
      {
        name: "背景",
        parts: [
          { name: "深海", rarity: "R", shown: "35.00" },
          { name: "放學後的教室", rarity: "N", shown: "50.00" },
          { name: "夏日祭的夜空", rarity: "SR", shown: "15.00" },
        ],
      },
    ],
  },
  lottery: {
    state: "open",
    currency: "魚幣",
    ticket_price: 10,
    per_person: 20,
    min_players: 3,
    prize_share: 0.7,
    tickets: 46,
    players: 2,
    pot: 460,
    draw_at: "2026-11-22T13:00:00.000Z",
    utc_offset_minutes: 480,
    mine: { tickets: 5 },
    winners: [],
  },
  auction: {
    state: "open",
    item: { name: "這一週她怎麼叫你", detail: "得標的人可以決定這一週她怎麼稱呼你（要過她的檢查）。" },
    currency: "魚幣",
    start_bid: 50,
    step: 5,
    opens_at: "2026-11-21T12:00:00.000Z",
    ends_at: "2026-11-22T12:05:00.000Z",
    extended: true,
    utc_offset_minutes: 480,
    top: { amount: 215, name: "海帶芽" },
    bids: 9,
    bidders: 4,
    mine: { amount: 180, leading: false },
    history: [
      { amount: 215, name: "海帶芽", at: "2026-11-22T11:58:10.000Z" },
      { amount: 180, name: "小魚乾", at: "2026-11-22T11:50:42.000Z" },
      { amount: 150, name: "海帶芽", at: "2026-11-22T09:12:00.000Z" },
      { amount: 120, name: "珊瑚礁的守門員", at: "2026-11-21T20:31:00.000Z" },
    ],
  },
  exchange_quote: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。",
    code: "2330.TW",
    name: "示範半導體",
    sector: "台股",
    blurb: "約 2,045 魚幣一股・資料來源:Yahoo Finance",
    currency: "TWD",
    price: 204_500,
    price_label: "現價",
    ref: 201_000,
    change: 0.0174,
    limit: null,
    timeframe: "daily",
    candles: SAMPLE_CANDLES,
    range: "5/25 – 11/23",
    today: null,
    news: [],
    as_of: "2026-11-23 10:05 的報價",
    coin_line: "約 2,045 魚幣一股",
    market_line: "台股開盤中・報價約 3 分鐘前",
    colors: "tw",
  },
  exchange_portfolio: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。槓桿可能讓你賠光錢包和其他持股。",
    name: "小魚乾",
    currency: "魚幣",
    balance: 812,
    worth: 1_247,
    holdings: [
      { code: "RICE", qty: "1.2250", cost: 98, value: 101 },
      { code: "0050.TW", qty: "0.0150", cost: 197, value: 190 },
    ],
    leveraged: [{ code: "AAPL", margin: 77, equity: 61, ratio: 0.79, price: 34_250, line_price: 23_001 }],
    as_of: "以最新報價計算",
    colors: "tw",
  },
  exchange_overview: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。",
    local: [
      { code: "RICE", name: "白飯食品", price: 10_120, change: 0.012, series: [10_000, 10_040, 9_980, 10_060, 10_120] },
      { code: "WHLE", name: "鯨落唱片", price: 10_610, change: -0.018, series: [10_800, 10_760, 10_700, 10_650, 10_610] },
      { code: "NAPS", name: "打盹床業", price: 8_830, change: 0.002, series: [8_800, 8_810, 8_790, 8_820, 8_830] },
      { code: "CUBE", name: "方塊礦業", price: 11_900, change: 0.031, series: [11_540, 11_600, 11_700, 11_820, 11_900] },
      { code: "DPSK", name: "DipSick AI", price: 9_120, change: -0.045, series: [9_550, 9_400, 9_300, 9_200, 9_120] },
    ],
    popular: [
      { code: "RICE", name: "白飯食品", holders: 12, change: 0.012 },
      { code: "2330.TW", name: "示範半導體", holders: 7, change: 0.0174 },
      { code: "AAPL", name: "示範科技", holders: 3, change: null },
    ],
    markets: [
      { label: "台股", open: true, hours: "09:00–13:30" },
      { label: "美股", open: false, hours: "09:30–16:00" },
      { label: "獨家", open: true, hours: "12:00–23:00" },
    ],
    as_of: "2026-11-23 10:05",
    colors: "tw",
  },
  exchange_rich: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。",
    currency: "魚幣",
    week_start: null,
    rows: [
      { rank: 1, name: "海帶芽", value: 3_420, extra: "NAPS RICE" },
      { rank: 2, name: "小魚乾", value: 1_247, extra: null },
      { rank: 3, name: "珊瑚礁的守門員", value: 980, extra: null },
    ],
    me: { rank: 2, hidden: false },
  },
  exchange_receipt: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。",
    name: "小魚乾",
    side: "buy",
    code: "2330.TW",
    ticker: "示範半導體",
    shares: "0.0490",
    price: "TWD 2,045.00",
    coins: 101,
    fee: 1,
    currency: "魚幣",
    leverage: 1,
    at: "2026-11-23 10:06",
  },
  exchange_bankrupt: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。槓桿可能讓你賠光錢包和其他持股。",
    name: "小魚乾",
    currency: "魚幣",
    written_off: 37,
    since: "2026-11-23",
    until: "2026-11-30",
  },
  exchange_map: {
    small_print: "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。",
    title: "熱門台股圖",
    tiles: [
      { code: "2330.TW", name: "示範半導體", sector: "半導體", weight: 300, change: 0.0174 },
      { code: "2454.TW", name: "示範晶片", sector: "半導體", weight: 23, change: -0.012 },
      { code: "2303.TW", name: "示範晶圓", sector: "半導體", weight: 6, change: 0.004 },
      { code: "2317.TW", name: "示範代工", sector: "科技", weight: 30, change: -0.021 },
      { code: "2308.TW", name: "示範電子", sector: "科技", weight: 20, change: 0.035 },
      { code: "2382.TW", name: "示範電腦", sector: "科技", weight: 11, change: 0 },
      { code: "2881.TW", name: "示範金控", sector: "金融", weight: 12, change: 0.006 },
      { code: "2882.TW", name: "示範保險", sector: "金融", weight: 10, change: -0.003 },
      { code: "2891.TW", name: "示範銀行", sector: "金融", weight: 9, change: null },
      { code: "2412.TW", name: "示範電信", sector: "電信", weight: 10, change: 0.001 },
      { code: "0050.TW", name: "示範五十", sector: "ETF", weight: 6, change: 0.011 },
      { code: "0056.TW", name: "示範高股息", sector: "ETF", weight: 4, change: -0.008 },
      { code: "1301.TW", name: "示範塑膠", sector: "原物料", weight: 3, change: -0.031 },
    ],
    footnote: "格子大小為預設權重,非即時市值;單一格最多占整張圖的 35%,超過的縮到這個大小",
    max_share: 0.35,
    as_of: "2026-11-23 10:05",
    colors: "tw",
  },
  gift: {
    name: "小魚乾",
    item: "一杯珍奶",
    kind: "喝的",
    line: "珍珠好多!你怎麼知道我今天想喝甜的,下次換我請你",
    date: "2026-11-21",
    favourite: true,
  },
};

const LONG_NAME = "超級無敵長的名字的小魚乾是我 The Longest Display Name";

/** The same pictures with names and numbers far past what fits. */
export const LONG_SAMPLES: { readonly [K in PictureKind]: PictureDataMap[K] } = {
  wallet: {
    ...PICTURE_SAMPLES.wallet,
    name: LONG_NAME,
    balance: 987_654_321,
    days: PICTURE_SAMPLES.wallet.days.map((d) => ({ ...d, income: d.income * 99_999, spending: d.spending * 77_777 })),
    income: [
      { label: "一個非常非常長的收入原因名稱會被截斷", amount: 12_345_678 },
      ...PICTURE_SAMPLES.wallet.income.map((i) => ({ ...i, amount: i.amount * 1000 })),
      { label: "第七種", amount: 3 },
      { label: "第八種", amount: 2 },
    ],
  },
  profile: {
    variant: "admin",
    name: LONG_NAME,
    bond: -87.5,
    ring: { lap: 0, fraction: 0, full: false, below: 0.875 },
    tier_label: "很討厭",
    next_label: "討厭",
    tier_progress: 0.1,
    values: {
      trust: 100,
      familiarity: 3.5,
      warmth: -0.92,
      respect: 0.4,
      ease: 0,
      grudge: 1,
      longing: 0.33,
      rapport: 0.71,
    },
    call_name: "名字很長很長很長很長很長很長很長",
    tags: ["owner", "regular", "friend", "very-long-tag-name"],
    interactions: 1_234_567,
  },
  week: {
    ...PICTURE_SAMPLES.week,
    name: LONG_NAME,
    days: PICTURE_SAMPLES.week.days.map((d) => ({ ...d, text: d.text * 999, voice: d.voice * 999 })),
    songs: [
      { title: "一首名字非常非常非常長的歌，長到一行放不下也要能看", artist: "一位名字也非常長的歌手和他的樂團" },
      ...PICTURE_SAMPLES.week.songs,
      { title: "Bohemian Rhapsody", artist: "Queen" },
      { title: "第六首", artist: null },
    ],
    song_count: 42,
    coins: { currency: "魚幣", earned: 12_345_678, spent: 9_876_543 },
  },
  dex: {
    ...PICTURE_SAMPLES.dex,
    name: LONG_NAME,
    parts: { owned: 9999, total: 99_999 },
    series: [
      { name: "一個名字很長很長很長的系列", owned: 99, total: 100, title: "名字也很長很長很長的稱號", complete: true },
      ...PICTURE_SAMPLES.dex.series,
    ],
    rarities: [
      { rarity: "N", count: 123_456 },
      { rarity: "R", count: 0 },
      { rarity: "SR", count: 2 },
      { rarity: "SSR", count: 1 },
    ],
    titles: Array.from({ length: 30 }, (_, i) => `稱號${i + 1}`),
  },
  odds: {
    ...PICTURE_SAMPLES.odds,
    price: 1_000_000,
    slots: [
      {
        name: "一個名字很長的部位",
        parts: [
          { name: "一個名字非常非常長長到放不下的部件", rarity: "SSR", shown: "0.01" },
          { name: "Long Latin Part Name Here", rarity: "N", shown: "99.99" },
        ],
      },
    ],
  },
  lottery: {
    ...PICTURE_SAMPLES.lottery,
    state: "drawn",
    tickets: 123_456,
    players: 9_999,
    pot: 1_234_560,
    mine: { tickets: 20 },
    winners: [
      { name: LONG_NAME, prize: 864_192 },
      { name: "海帶芽", prize: 1 },
    ],
  },
  auction: {
    ...PICTURE_SAMPLES.auction,
    state: "closed",
    item: { name: "只此一件的卡框：深海裡最亮的那一盞燈", detail: "一段很長的說明。".repeat(20) },
    top: { amount: 99_999_999, name: LONG_NAME },
    bids: 12_345,
    bidders: 999,
    mine: { amount: 99_999_999, leading: true },
  },
  exchange_quote: {
    ...PICTURE_SAMPLES.exchange_quote,
    name: LONG_NAME,
    price: 99_999_999,
    price_label: "收盤價(11/20)・休市中",
    change: -0.1,
    limit: "down",
    blurb: "一段很長的介紹。".repeat(20),
    coin_line: "約 999,999,999 魚幣一股".repeat(3),
    market_line: "美股休市・報價約 999 分鐘前".repeat(3),
    timeframe: "intraday",
    candles: SAMPLE_CANDLES.slice(0, 1).map((k) => ({ ...k, h: 99_999_999_999, v: 999_999_999_999 })),
    today: "昨天她被餵了 999 次,比平常多 → 今天開盤 +3.0%".repeat(4),
    colors: "us",
  },
  exchange_portfolio: {
    ...PICTURE_SAMPLES.exchange_portfolio,
    name: LONG_NAME,
    balance: 987_654_321,
    worth: 999_999_999,
    holdings: [...PICTURE_SAMPLES.exchange_portfolio.holdings, { code: "WHLE", qty: "123456.7890", cost: 99_999, value: 1 }],
    leveraged: [{ code: "NVDA", margin: 150, equity: 0, ratio: -0.2, price: 1, line_price: 99_999_999 }],
    colors: "us",
  },
  exchange_overview: {
    ...PICTURE_SAMPLES.exchange_overview,
    local: PICTURE_SAMPLES.exchange_overview.local.map((l) => ({ ...l, name: LONG_NAME, price: 99_999_999, series: [] })),
    popular: Array.from({ length: 12 }, (_, i) => ({ code: `LONG${i}.TWO`, name: LONG_NAME, holders: 99_999, change: -0.0999 })),
  },
  exchange_rich: {
    ...PICTURE_SAMPLES.exchange_rich,
    rows: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, name: i === 0 ? LONG_NAME : `第 ${i + 1} 名`, value: 999_999_999 - i, extra: "2330.TW 0050.TW AAPL NVDA RICE WHLE CUBE NAPS" })),
    me: { rank: null, hidden: true },
  },
  exchange_receipt: { ...PICTURE_SAMPLES.exchange_receipt, name: LONG_NAME, ticker: LONG_NAME, coins: 999_999_999, side: "sell", leverage: 2 },
  exchange_bankrupt: { ...PICTURE_SAMPLES.exchange_bankrupt, name: LONG_NAME, written_off: 999_999_999 },
  exchange_map: {
    ...PICTURE_SAMPLES.exchange_map,
    title: LONG_NAME,
    tiles: Array.from({ length: 50 }, (_, i) => ({
      code: `LONG${i}.TWO`,
      name: LONG_NAME,
      sector: i % 7 === 0 ? "一個名字很長的產業類別" : `類別${i % 5}`,
      weight: 1 + ((i * 37) % 97),
      change: ((i % 11) - 5) / 40,
    })),
    footnote: "很長的說明。".repeat(30),
    colors: "us",
  },
  gift: {
    ...PICTURE_SAMPLES.gift,
    name: LONG_NAME,
    item: "一把會自己彈奏月光奏鳴曲的透明電吉他和一整箱備用的弦",
    line: "一段很長很長的話。".repeat(12),
    kind: "",
  },
};
