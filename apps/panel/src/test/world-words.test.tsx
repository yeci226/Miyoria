// A profile with other words (docs/design/v5-profiles.md): the page carries the Core's tag with
// another coin name, exchange name, pronoun, persona and the plain landing, and the converted
// pages draw those words and never the first character's. The tag is set before any module reads
// it, as a served page would have it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExchangeAccount, ExchangeAdmin, ExchangeBoards, ExchangeLine, ExchangeMarket, ExchangePortfolio, ExchangeQuote } from "@miyoria/contracts/api";

vi.hoisted(() => {
  const world = { currency: "貝殼", exchange_name: "珊瑚交易所", pronoun: "他", persona: "Kuro", landing: "plain" };
  document.head.insertAdjacentHTML(
    "beforeend",
    `<meta property="og:site_name" content="Kuro" /><meta name="miyoria:world" content="${JSON.stringify(world).replace(/"/g, "&quot;")}" />`,
  );
});

import { LandingFirst } from "@/app/LandingFirst";
import { HER_NAME } from "@/components/live-state";
import { WORLD } from "@/lib/world";
import { WalletSection } from "@/pages/character/PersonSheet";
import { Exchange } from "@/pages/public/Exchange";
import { STATE, stateLabel } from "@/pages/public/status";
import { mockFetch, renderPage, renderRoute } from "./render";

const OLD = /魚幣|深海交易所/;
const BASE = "貝殼是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。";

afterEach(() => vi.unstubAllGlobals());

/** Everything the page shows, the text and the names of things. */
function shown(): string {
  const labels = [...document.body.querySelectorAll("[aria-label],[title],[placeholder]")].map((e) =>
    ["aria-label", "title", "placeholder"].map((a) => e.getAttribute(a) ?? "").join(" "),
  );
  return [document.body.textContent ?? "", ...labels].join("\n");
}

const line = (code: string, name: string, more: Partial<ExchangeLine> = {}): ExchangeLine & { holders: number | null } => ({
  code,
  name,
  market: "local",
  price: 100,
  basis: "quote",
  price_date: "2026-11-23",
  price_note: null,
  next_open: null,
  currency: "COIN",
  local: { what_moves: "大家多餵他,海帶食品就容易漲", today: "昨天他被餵了 14 次,比平常多 → 今天開盤 +1.8%" },
  coin_price: 100,
  age_minutes: 3,
  source: "這裡獨家:價格由程式模擬",
  change: 0.01,
  at: "2026-11-23T04:00:00.000Z",
  open: true,
  stale: false,
  quotes: "intraday",
  holders: null,
  ...more,
});

const LOCAL = [line("KELP", "海帶食品"), line("2330.TW", "示範半導體", { market: "tw", currency: "TWD", price: 1000, coin_price: 1000 })];

const MARKET: ExchangeMarket = {
  enabled: true,
  currency: "貝殼",
  colors: "tw",
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  house: { buys_halted: true, net_today: 0, cap_daily: 1500 },
  sessions: [{ market: "tw", open: true, hours: "09:00–13:30", zone: "Asia/Taipei", stale: false, notice: null }],
  lists: [
    { kind: "local", label: "新手推薦 · 這裡獨家" },
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
  no_exchange: "貝殼永遠不能換成真錢或現實中的物品,也不能用真錢或物品買貝殼,在伺服器裡外都一樣。",
};

const ACCOUNT: ExchangeAccount = {
  currency: "貝殼",
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
  code: "KELP",
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
  sentence: "付 102 貝殼(含手續費 1),照現價約 1.0100 股,下一筆有效報價成交。",
  warning: null,
};

const PORTFOLIO: ExchangePortfolio = {
  balance: 798,
  holdings: [
    { id: "p1", code: "KELP", name: "海帶食品", leverage: 1, qty: 1_000_000, cost: 101, margin: 101, loan: 0, price: 100, value: 100, equity: 100, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-23T04:00:00.000Z", can_sell: true },
  ],
  orders: [{ id: "o1", code: "KELP", side: "buy", coins: 50, qty: 0, leverage: 1, position: null, status: "open", why: null, at: "2026-11-23T04:00:00.000Z", next_open: null }],
  fills: [],
  notices: [],
  bankrupt: null,
  totals: { cost: 101, value: 100 },
};

const BOARDS: ExchangeBoards = {
  currency: "貝殼",
  space: null,
  rich: [{ rank: 1, name: "海帶芽", worth: 3420, holdings: null, me: false }],
  me: { rich: null, hidden: false },
};

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
      windows: [{ days: 7, burned: 900, minted: 4_000, net: 3_100, share: 0.062 }],
      circulation: 50_000,
      warn_share: 0.05,
      warning: null,
    },
  },
  tickers: [],
  providers: [],
  refresh_seconds: 60,
  positions: [{ id: "pos9", name: "海帶芽", code: "2330.TW", leverage: 1, qty: 50_000, value: 100 }],
};

function exchangeCore() {
  mockFetch((_method, url) => {
    const path = url.pathname;
    if (path === "/api/member/exchange") return { body: MARKET };
    if (path === "/api/member/exchange/account") return { body: ACCOUNT };
    if (path === "/api/member/exchange/portfolio") return { body: PORTFOLIO };
    if (path === "/api/member/exchange/boards") return { body: BOARDS };
    if (path === "/api/member/exchange/list/local") return { body: { kind: "local", label: "新手推薦 · 這裡獨家", rows: LOCAL } };
    if (path.startsWith("/api/member/exchange/ticker/")) return { body: { line: LOCAL[0], points: [{ at: "2026-11-23T04:00:00.000Z", price: 99 }], watching: false } };
    if (path === "/api/member/exchange/quote") return { body: QUOTE };
    if (path === "/api/exchange") return { body: ADMIN };
    if (path === "/api/people/P1/wallet") return { body: { balance: 120, ledger: [{ ts: "2026-11-08T04:00:00Z", delta: 50, label: "管理員調整:活動" }] } };
    return undefined;
  });
}

const tab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("a profile with other words", () => {
  it("reads them from the page the Core served", () => {
    expect(WORLD).toEqual({ currency: "貝殼", exchange_name: "珊瑚交易所", pronoun: "他", persona: "Kuro", landing: "plain" });
    expect(HER_NAME).toBe("Kuro");
    expect(STATE.idle.label).toBe("他現在閒著");
    expect(stateLabel({ state: "playing", game: "minecraft" } as never)).toBe("他在玩 Minecraft");
  });

  it("names the exchange, the coins and him on every tab of the exchange", async () => {
    exchangeCore();
    const list = renderPage(<Exchange />);
    expect(await screen.findByRole("heading", { name: "珊瑚交易所" })).toBeInTheDocument();
    await screen.findByText("海帶食品");
    const texts = [shown()];
    list.unmount();
    renderPage(<Exchange initialCode="KELP" />);
    expect(await screen.findByText(/\$200 = 花 200 貝殼/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "試算並確認" }));
    await screen.findByRole("alertdialog");
    texts.push(shown());
    await userEvent.keyboard("{Escape}");
    for (const name of ["我的", "富人榜", "規則"]) {
      await tab(name);
      await waitFor(() => expect(document.body.textContent).not.toMatch(/讀取中$/));
      texts.push(shown());
    }
    const all = texts.join("\n");
    expect(all).not.toMatch(OLD);
    expect(all).toMatch(/貝殼一股/);
    expect(all).toMatch(/第一次來\?這裡用貝殼買賣股票/);
    expect(all).toMatch(/今天交易所發出的貝殼到上限了/);
    expect(all).toMatch(/他也看不到任何人的持股/);
    expect(all).toMatch(/買進的貝殼燒掉/);
    expect(all).toContain(BASE);
  });

  it("names the coins on the owner's exchange page", async () => {
    exchangeCore();
    renderRoute("/economy?tab=exchange");
    expect(await screen.findByRole("region", { name: "貝殼發出" })).toBeInTheDocument();
    await screen.findByText(/流通中的貝殼/);
    expect(shown()).not.toMatch(OLD);
    expect(shown()).toMatch(/1 貝殼 = NT\$1/);
  });

  it("names the coins on a person's wallet", async () => {
    exchangeCore();
    renderPage(<WalletSection personId="P1" name="阿哲" />);
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getAllByText("貝殼").length).toBeGreaterThan(0);
    expect(shown()).not.toMatch(OLD);
  });

  it("shows the plain front page with his name instead of the first character's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://panel.test").pathname;
        const body = path === "/api/auth/methods" ? { token: true, discord: false } : { error: "missing or invalid bearer token" };
        return new Response(JSON.stringify(body), { status: path === "/api/auth/methods" ? 200 : 401, headers: { "content-type": "application/json" } });
      }),
    );
    render(<LandingFirst onHandOff={() => {}} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Kuro");
    expect(screen.getByText("Kuro 是住在 Discord 和直播裡的 AI VTuber。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看他直播" })).toBeInTheDocument();
    expect(shown()).not.toMatch(/Miyoria|鯨魚|女僕/);
  });
});

/** The panel's own sources, comments aside: no page spells the first character's words itself. */
describe("the panel's sources", () => {
  const root = join(__dirname, "..");
  // The first character's own landing page and art, the exchange's dev-only demo data (it stands
  // in for the Core, with the first character's data), and the karaoke pages (not converted here).
  const left = [/^pages[\\/]public[\\/]landing[\\/]Landing\.tsx$/, /^pages[\\/]public[\\/]exchange[\\/]demo\.tsx$/, /^pages[\\/]public[\\/]karaoke[\\/]/, /^lib[\\/]world\.ts$/, /\.test\.tsx?$/, /^test[\\/]/];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });

  it("spell no coin name and no exchange name outside a comment", () => {
    const found: string[] = [];
    for (const file of files(root)) {
      const rel = relative(root, file);
      if (left.some((r) => r.test(rel))) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, i) => {
          const t = text.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
          if (OLD.test(t)) found.push(`${rel}:${i + 1}: ${t}`);
        });
    }
    expect(found).toEqual([]);
  });
});
