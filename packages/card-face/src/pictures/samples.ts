// Invented data for every template: what the tests lay out and the sample PNGs are drawn from
// (`packages/api/test/pictures.test.ts`). Every name here is made up. `LONG` is the same data
// with the longest names and the biggest numbers a picture has to hold.

import type { PictureDataMap, PictureKind } from "@miyoria/types";

const WEEK = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"];

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
};
