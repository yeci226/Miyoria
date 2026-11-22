// 深海交易所 on the member page (the lists with the local stocks first, the search with
// suggestions, sortable columns, a ticker with the order ticket and its confirmation, their own
// book, the rich list with the switch to stay off it, the rules and the small print) and
// 經濟 / 交易所 for the owner. Every name and number here is made up.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ExchangeAccount,
  ExchangeAdmin,
  ExchangeBoards,
  ExchangeLine,
  ExchangeMarket,
  ExchangePortfolio,
  ExchangeQuote,
} from "@miyoria/contracts/api";
import { PushProvider } from "@/app/push";
import { TestStream } from "@/test/push-stream";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { change, Exchange, upColor } from "./Exchange";

const BASE = "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。";

const line = (code: string, name: string, chg: number | null, more: Partial<ExchangeLine> = {}): ExchangeLine & { holders: number | null } => ({
  code,
  name,
  market: "local",
  price: 100,
  basis: "quote",
  price_date: "2026-11-23",
  price_note: null,
  next_open: null,
  currency: "COIN",
  local: { what_moves: "大家多餵她,白飯食品就容易漲", today: "昨天她被餵了 14 次,比平常多 → 今天開盤 +1.8%" },
  coin_price: 100,
  age_minutes: 3,
  source: "這裡獨家:價格由程式模擬",
  change: chg,
  at: "2026-11-23T04:00:00.000Z",
  open: true,
  stale: false,
  quotes: "intraday",
  holders: null,
  ...more,
});

const LOCAL = [line("RICE", "白飯食品", 0.012), line("WHLE", "鯨落唱片", -0.03), line("NAPS", "打盹床業", 0.002)];

const MARKET: ExchangeMarket = {
  enabled: true,
  currency: "魚幣",
  colors: "tw",
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  house: { buys_halted: false, net_today: 0, cap_daily: 1500 },
  sessions: [
    { market: "tw", open: true, hours: "09:00–13:30", zone: "Asia/Taipei", stale: false, notice: null },
    { market: "us", open: false, hours: "09:30–16:00", zone: "America/New_York", stale: false, notice: null },
  ],
  lists: [
    { kind: "local", label: "新手推薦 · 這裡獨家" },
    { kind: "popular", label: "大家都在買" },
    { kind: "watch", label: "我的觀察" },
  ],
  default_list: "local",
  rules: {
    fee: 0.01,
    fee_min: 1,
    order_min: 10,
    order_max: 500,
    orders_per_day: 20,
    buy_per_day: 1000,
    limit_total: 1000,
    min_hold_minutes: 10,
    leverage: true,
    leverage_line: 0.2,
    leverage_min_days: 30,
    leverage_min_tier: "朋友",
    margin_cap: 150,
    account_min_days: 7,
    account_min_tier: "認識",
    bankrupt_cooling_days: 7,
    quote_max_age_seconds: 300,
    payout_cap_daily: 1500,
    watch_max: 20,
  },
  small_print: { base: BASE, real: "資料來源:Yahoo Finance,報價可能延遲。", leverage: "槓桿可能讓你賠光錢包和其他持股。" },
  no_dividends: "不發放股息;除息日股價下跌屬正常。",
  no_exchange: "魚幣永遠不能換成真錢或現實中的物品,也不能用真錢或物品買魚幣,在伺服器裡外都一樣。",
};

const ACCOUNT: ExchangeAccount = {
  currency: "魚幣",
  known: true,
  blocked: false,
  opened: true,
  opened_at: "2026-11-01T00:00:00.000Z",
  cannot_open: null,
  leverage: { allowed: true, why: null, opted_in: true },
  limits: { company: 270, total: 1000, mult: 1 },
  today: { orders: 0, bought: 0, orders_left: 20, buy_left: 1000 },
  balance: 900,
  investable: 900,
  hide_boards: false,
  show_holdings: false,
};

const QUOTE: ExchangeQuote = {
  side: "buy",
  code: "RICE",
  price: 100,
  open: true,
  coins: 102,
  margin: 101,
  exposure: 101,
  fee: 1,
  qty: 1_010_000,
  leverage: 1,
  gross: 0,
  net: 0,
  line_price: null,
  price_note: null,
  next_open: null,
  sentence: "付 102 魚幣(含手續費 1),照現價約 1.0100 股,下一筆有效報價成交。",
  warning: null,
};

const PORTFOLIO: ExchangePortfolio = {
  balance: 798,
  holdings: [
    { id: "p1", code: "RICE", name: "白飯食品", leverage: 1, qty: 1_000_000, cost: 101, margin: 101, loan: 0, price: 100, value: 100, equity: 100, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-23T04:00:00.000Z", can_sell: true },
    { id: "p2", code: "AAPL", name: "示範科技", leverage: 2, qty: 20_000, cost: 200, margin: 100, loan: 100, price: 9_000, value: 180, equity: 80, ratio: 0.8, line_price: 6_300, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-23T04:00:00.000Z", can_sell: true },
  ],
  orders: [{ id: "o1", code: "RICE", side: "buy", coins: 50, qty: 0, leverage: 1, position: null, status: "open", why: null, at: "2026-11-23T04:00:00.000Z", next_open: "2026-11-24T04:00:00.000Z" }],
  fills: [],
  notices: [],
  bankrupt: null,
  totals: { cost: 301, value: 180 },
};

const BOARDS: ExchangeBoards = {
  currency: "魚幣",
  space: null,
  rich: [
    { rank: 1, name: "海帶芽", worth: 3420, holdings: null, me: false },
    { rank: 2, name: "小魚乾", worth: 1055, holdings: null, me: true },
  ],
  me: { rich: 2, hidden: false },
};

function exchange(o: { status?: number; line?: Partial<ExchangeLine> } = {}) {
  const shown = { ...LOCAL[0], ...o.line } as ExchangeLine;
  const posts: { path: string; body: unknown; key: string | null }[] = [];
  mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, key: headers.get("Idempotency-Key") });
    if (!path.startsWith("/api/member/exchange")) return undefined;
    if (o.status) return { status: o.status, body: { error: "exchange module is not available" } };
    if (path === "/api/member/exchange") return { body: MARKET };
    if (path === "/api/member/exchange/account") return { body: ACCOUNT };
    if (path === "/api/member/exchange/portfolio") return { body: PORTFOLIO };
    if (path === "/api/member/exchange/boards") return { body: BOARDS };
    if (path === "/api/member/exchange/list/local") return { body: { kind: "local", label: "新手推薦 · 這裡獨家", rows: LOCAL } };
    if (path === "/api/member/exchange/list/popular") return { body: { kind: "popular", label: "大家都在買", rows: [{ ...LOCAL[0], holders: 4 }] } };
    if (path === "/api/member/exchange/suggest") return { body: { items: [{ code: "RICE", name: "白飯食品" }] } };
    if (path === "/api/member/exchange/lookup") return { body: { instrument: LOCAL[0] } };
    if (path.startsWith("/api/member/exchange/ticker/")) return { body: { line: shown, points: [{ at: "2026-11-23T04:00:00.000Z", price: 99 }, { at: "2026-11-23T05:00:00.000Z", price: 100 }], watching: false } };
    if (path === "/api/member/exchange/watch") return { body: { watching: true, count: 1 } };
    if (path === "/api/member/exchange/quote") return { body: QUOTE };
    if (path === "/api/member/exchange/order") return { body: { ...PORTFOLIO.orders[0], id: "o2" } };
    if (path === "/api/member/exchange/visibility") return { body: { ...ACCOUNT, ...(body as object) } };
    return undefined;
  });
  return { posts };
}

const tab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("深海交易所 on the member page", () => {
  it("shows the local stocks first with the explainer, signed moves in the convention's colour and the small print", async () => {
    exchange();
    renderPage(<Exchange />);
    expect(await screen.findByText("白飯食品")).toBeInTheDocument();
    expect(screen.getByText(/第一次來/)).toBeInTheDocument();
    expect(screen.getByText(/紅漲綠跌/)).toBeInTheDocument();
    const up = screen.getByText("▲ +1.2%");
    expect(up).toHaveStyle({ color: upColor("tw") });
    expect(screen.getAllByText(new RegExp(BASE.slice(0, 10))).length).toBeGreaterThan(0);
    expect(change(-0.012)).toBe("▼ −1.2%");
  });

  it("moves a list's prices as they are pushed, without asking again", async () => {
    exchange();
    const stream = new TestStream();
    const polled = globalThis.fetch;
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("/api/member/stream") ? Promise.resolve(stream.response) : polled(input, init),
    );
    vi.stubGlobal("fetch", fetch);
    renderPage(
      <PushProvider audience="member">
        <Exchange />
      </PushProvider>,
    );
    expect(await screen.findByText("▲ +1.2%")).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => decodeURIComponent(String(u)).includes("exchange_list~local"))).toBe(true));
    const list = { kind: "local", label: "新手推薦 · 這裡獨家", rows: LOCAL };
    stream.send({ kind: "value", topic: "exchange_list", param: "local", data: list });
    stream.send({ kind: "ready" }, "r.1.h");
    stream.send(
      { kind: "value", topic: "exchange_list", param: "local", data: { ...list, rows: [{ ...LOCAL[0], change: 0.05 }, ...LOCAL.slice(1)] } },
      "r.2.h",
    );
    expect(await screen.findByText("▲ +5.0%")).toBeInTheDocument();
    expect(screen.queryByText("▲ +1.2%")).toBeNull();
  });

  it("sorts the columns, and 大家都在買 shows counts only", async () => {
    exchange();
    renderPage(<Exchange />);
    await screen.findByText("白飯食品");
    await userEvent.click(screen.getByRole("button", { name: /漲跌/ }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("WHLE")).toBeInTheDocument();
    await tab("大家都在買");
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "持有人數" })).toBeInTheDocument();
  });

  it("suggests while typing, opens a ticker, watches it and buys by shares once with a key", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await userEvent.type(await screen.findByLabelText(/找股票/), "ri");
    await userEvent.click(await screen.findByRole("button", { name: "RICE 白飯食品" }));
    expect(await screen.findByRole("button", { name: "加入觀察" })).toBeInTheDocument();
    // What moved today's open, from her day, in numbers.
    expect(screen.getByText("昨天她被餵了 14 次,比平常多 → 今天開盤 +1.8%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加入觀察" }));
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/watch", body: { code: "RICE", on: true } })));
    // One amount for every stock: a bare number is shares (the ticket starts at 1); no 2x here.
    expect(screen.getByText("3 = 3 股(約 300 魚幣)・$200 = 花 200 魚幣(約 2 股)")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "2 倍" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "試算並確認" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("約 1.0100 股");
    expect(dialog).toHaveTextContent(BASE.slice(0, 10));
    await userEvent.click(within(dialog).getByRole("button", { name: "送出委託" }));
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/exchange/order")).toHaveLength(1));
    const order = posts.find((p) => p.path === "/api/member/exchange/order");
    expect(order?.body).toEqual({ side: "buy", code: "RICE", shares: 1 });
    expect(order?.key).toBeTruthy();
  });

  it("takes one amount: $ is coins, garbage gets the line with both forms and asks nothing", async () => {
    const { posts } = exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const amount = await screen.findByLabelText(/買多少/);
    await userEvent.clear(amount);
    await userEvent.type(amount, "三股");
    await userEvent.click(screen.getByRole("button", { name: "試算並確認" }));
    expect(await screen.findByText("看不懂這個數量:寫數字是股數(例如 3、0.5),前面加 $ 是魚幣(例如 $200)")).toHaveAttribute("role", "alert");
    expect(posts.some((p) => p.path === "/api/member/exchange/quote")).toBe(false);
    await userEvent.clear(amount);
    await userEvent.type(amount, "＄1,200");
    await userEvent.click(screen.getByRole("button", { name: "試算並確認" }));
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/quote", body: { side: "buy", code: "RICE", coins: 1200 } })));
  });

  it("says a closed market's price is its last close and when a waiting order fills", async () => {
    exchange({ line: { basis: "close", price_note: "收盤價(11/22)・休市中", open: false, next_open: "2026-11-24T04:00:00.000Z", age_minutes: null } });
    renderPage(<Exchange initialCode="RICE" />);
    expect(await screen.findByText("收盤價(11/22)・休市中")).toBeInTheDocument();
    expect(screen.getByText("休市・下一個開盤 11/24(二)12:00")).toBeInTheDocument();
    expect(screen.getAllByText(/下一個開盤 11\/24\(二\)12:00\(台北時間\)後/).length).toBeGreaterThan(0);
  });

  it("shows their own book with the 2x line and says only they see it", async () => {
    exchange();
    renderPage(<Exchange />);
    await tab("我的");
    expect(await screen.findByText("只有你自己看得到這裡;她也看不到任何人的持股。")).toBeInTheDocument();
    expect(screen.getByText(/跌到 6,300 自動賣出/)).toBeInTheDocument();
    expect(screen.getAllByText(/槓桿可能讓你賠光錢包和其他持股/).length).toBeGreaterThan(0);
  });

  it("lists the rich list with the switch to stay off, and the rules' lines", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await tab("富人榜");
    expect(await screen.findByText("海帶芽")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "我要上榜" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/exchange/visibility", body: { hide_boards: true } }));
    await tab("規則");
    expect(await screen.findByText(MARKET.no_dividends)).toBeInTheDocument();
    expect(screen.getByText(MARKET.no_exchange)).toBeInTheDocument();
  });

  it("is one line when the module is off", async () => {
    exchange({ status: 503 });
    renderPage(<Exchange />);
    expect(await screen.findByText("交易所現在沒有開")).toBeInTheDocument();
  });
});

const ADMIN: ExchangeAdmin = {
  enabled: true,
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  report: {
    today: { day: 20_780, date: "2026-11-23", burned: 20, minted: 12, net: -8, written_off: 0, buys_halted: false },
    days: [],
    cap_daily: 1500,
    bankrupt: [],
    quotes: [],
    books: { postings: 4, lines: 4, pending: 0 },
    mint: {
      windows: [
        { days: 1, burned: 20, minted: 12, net: -8, share: -0.0002 },
        { days: 7, burned: 900, minted: 4_000, net: 3_100, share: 0.062 },
        { days: 30, burned: 2_000, minted: 6_000, net: 4_000, share: 0.08 },
      ],
      circulation: 50_000,
      warn_share: 0.05,
      warning: "過去 7 天交易所淨發出 3,100 魚幣,是現在所有錢包合計的 6.2%,超過提醒線 5.0%。",
    },
  },
  tickers: [
    { code: "2330.TW", name: "示範半導體", provider_name: "Demo Semiconductor Manufacturing Company Limited", name_override: null, market: "tw", exchange: "TAI", type: "EQUITY", status: "paused", reason: null, added_at: "2026-11-23T02:00:00.000Z", missing_days: 0, holders: 2 },
  ],
  providers: [{ id: "yahoo", last_error: "沒有讀到:2330.TW" }],
  refresh_seconds: 60,
  positions: [{ id: "pos9", name: "海帶芽", code: "2330.TW", leverage: 1, qty: 50_000, value: 100 }],
};

describe("經濟 / 交易所 for the owner", () => {
  it("shows the day, the provider's problem, confirms a split and sells a position after asking", async () => {
    const posts: { path: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      if (method === "POST") posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/exchange") return { body: ADMIN };
      if (url.pathname === "/api/exchange/split") return { body: { positions: 2 } };
      if (url.pathname === "/api/exchange/sell") return { body: { paid: 100 } };
      if (url.pathname === "/api/exchange/name") return { body: { name: "台積電" } };
      return undefined;
    });
    renderRoute("/economy?tab=exchange");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("沒有讀到"))).toBe(true);
    expect(screen.getByText("對得上")).toBeInTheDocument();
    // What the exchange minted, with the warning past the line (nothing halted by it).
    expect(alerts.some((a) => a.textContent?.includes("過去 7 天交易所淨發出 3,100 魚幣"))).toBe(true);
    const mint = screen.getByRole("region", { name: "魚幣發出" });
    expect(within(mint).getByText("淨發出 +3,100")).toBeInTheDocument();
    expect(within(mint).getByText("占流通 6.2%")).toBeInTheDocument();
    expect(within(mint).getByText(/流通中的魚幣\(所有錢包合計\):50,000/)).toBeInTheDocument();
    // The owner's display name for a ticker, with the provider's beside it.
    await userEvent.click(screen.getByRole("button", { name: "改名稱" }));
    const naming = await screen.findByRole("alertdialog");
    expect(naming).toHaveTextContent("Demo Semiconductor Manufacturing Company Limited");
    await userEvent.type(within(naming).getByLabelText(/顯示名稱/), "台積電");
    await userEvent.click(within(naming).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/name", body: { code: "2330.TW", name: "台積電" } }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "確認分割" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/每一股變成幾股/), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/split", body: { code: "2330.TW", ratio: 4 } }));
    await userEvent.click(screen.getByRole("button", { name: "賣掉" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/sell", body: { position: "pos9" } }));
  });
});
