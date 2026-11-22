// 市集 on the member page (this week's auction and lottery, their bids and tickets), the song
// priority ticket on the song form, a won one-of-a-kind frame in the shop, and 經濟 / 市集 for the owner.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionView, LotteryView, LotView, MarketHistory, MyBids, MyTickets, WalletView } from "@miyoria/contracts/api";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { Market } from "./Market";
import { MemberActions } from "./Member";
import { WalletMain } from "./Wallet";

const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const lot = (over: Partial<LotView> = {}): LotView => ({
  id: "L1",
  week: 20_410,
  kind: "frame",
  name: "只此一件的卡框",
  detail: "得標的人有一個只有他有的卡框",
  state: "open",
  picked_by: "her",
  opens_at: at(-20 * HOUR),
  ends_at: at(3 * HOUR + 60_000),
  extended: true,
  opening_bid: 50,
  step: 5,
  min_bid: 125,
  top: { amount: 120, name: "小魚乾" },
  bids: 4,
  bidders: 3,
  winner: null,
  call_name: null,
  name_due: null,
  applied_until: null,
  ...over,
});

const auction = (over: Partial<AuctionView> = {}): AuctionView => ({
  currency: "魚幣",
  running: true,
  lot: lot(),
  next: { opens_at: "2026-11-21T12:00:00Z", plan: null },
  mine: { amount: 120, leading: true, won: false },
  history: [
    { amount: 120, name: "小魚乾", at: at(-HOUR) },
    { amount: 100, name: "阿貓", at: at(-2 * HOUR) },
  ],
  ...over,
});

const lottery = (over: Partial<LotteryView> = {}): LotteryView => ({
  currency: "魚幣",
  running: true,
  price: 10,
  per_person: 20,
  min_buyers: 3,
  prize_share: 0.7,
  week: 20_411,
  state: "open",
  draw_at: at(3 * 24 * HOUR + HOUR),
  tickets: 23,
  buyers: 5,
  pot: 230,
  mine: { tickets: 3 },
  last: { week: 20_404, state: "drawn", drawn_at: "2026-11-15T12:00:00Z", tickets: 40, buyers: 7, pot: 400, prize: 280, burned: 120, winner: "阿貓" },
  ...over,
});

const BIDS: MyBids = {
  bids: [
    { lot: "L1", week: 20_410, kind: "frame", name: "只此一件的卡框", amount: 120, state: "leading", at: at(-HOUR) },
    { lot: "L0", week: 20_403, kind: "call_name", name: "這一週她怎麼叫你", amount: 80, state: "outbid", at: at(-170 * HOUR) },
    { lot: "L-1", week: 20_396, kind: "frame", name: "只此一件的卡框", amount: 60, state: "won", at: at(-340 * HOUR) },
  ],
};

const TICKETS: MyTickets = {
  weeks: [
    { week: 20_411, draw_at: at(48 * HOUR), tickets: 3, paid: 30, state: "open", won: false, prize: 0 },
    { week: 20_404, draw_at: "2026-11-15T12:00:00Z", tickets: 5, paid: 50, state: "drawn", won: true, prize: 280 },
  ],
};

interface MarketOptions {
  auction?: AuctionView;
  lottery?: LotteryView;
  /** Every market route answers this status (503: the module is off). */
  status?: number;
  bid?: { status?: number; body: unknown };
  buy?: { status?: number; body: unknown };
  name?: { status?: number; body: unknown };
  wallet?: WalletView;
}

function market(o: MarketOptions = {}) {
  const posts: { path: string; body: unknown; key: string | null }[] = [];
  const fn = mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, key: headers.get("Idempotency-Key") });
    if (path === "/api/member/wallet" && o.wallet) return { body: o.wallet };
    if (!path.startsWith("/api/member/market/")) return undefined;
    if (o.status) return { status: o.status, body: { error: o.status === 503 ? "market module is not available" : "boom" } };
    if (path === "/api/member/market/auction") return { body: o.auction ?? auction() };
    if (path === "/api/member/market/lottery" && method === "GET") return { body: o.lottery ?? lottery() };
    if (path === "/api/member/market/bids") return { body: BIDS };
    if (path === "/api/member/market/tickets") return { body: TICKETS };
    if (path === "/api/member/market/bid") return o.bid ?? { body: { amount: (body as { amount: number }).amount, ends_at: at(3 * HOUR), extended: false, balance: 0 } };
    if (path === "/api/member/market/lottery" && method === "POST") return o.buy ?? { body: { count: 5, mine: 8, charged: 50, balance: 0 } };
    if (path === "/api/member/market/name") return o.name ?? { body: { call_name: "小魚", applied_until: at(7 * 24 * HOUR), refunded: 0 } };
    return undefined;
  });
  return { fn, posts };
}

const block = async () => (await screen.findByRole("heading", { name: "市集" })).closest("section") as HTMLElement;
const part = (name: string) => screen.getByRole("region", { name });

describe("市集: the auction", () => {
  it("shows the lot, the top bid and who, the time left with the extension, their own bid and the newest bids", async () => {
    market();
    renderPage(<Market />);
    await block();
    const a = await waitFor(() => {
      const p = part("這一週的拍賣");
      expect(p).toHaveTextContent("只此一件的卡框");
      return p;
    });
    expect(a).toHaveTextContent("得標的人有一個只有他有的卡框");
    expect(a).toHaveTextContent("120 · 小魚乾");
    expect(a).toHaveTextContent("3 小時後");
    expect(a).toHaveTextContent("延長過");
    expect(a).toHaveTextContent("4 次 · 3 人");
    expect(a).toHaveTextContent("120 · 領先中");
    expect(within(a).getByText("阿貓")).toBeInTheDocument();
    // Prefilled with the smallest bid that would lead.
    expect(within(a).getByLabelText(/出價\(至少 125 魚幣/)).toHaveValue(125);
  });

  it("bids the amount typed and reads the views again", async () => {
    const { fn, posts } = market();
    renderPage(<Market />);
    const input = await screen.findByLabelText(/出價\(至少/);
    await userEvent.clear(input);
    await userEvent.type(input, "130");
    const calls = fn.mock.calls.length;
    await userEvent.click(within(part("這一週的拍賣")).getByRole("button", { name: "出價" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/member/market/bid", body: { amount: 130 }, key: null }]));
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(calls + 1));
  });

  it("shows the Core's sentence under the form when it will not take the bid", async () => {
    market({ bid: { status: 409, body: { error: "出價至少要 125" } } });
    renderPage(<Market />);
    await screen.findByLabelText(/出價\(至少/);
    await userEvent.click(within(part("這一週的拍賣")).getByRole("button", { name: "出價" }));
    expect(await within(part("這一週的拍賣")).findByRole("alert")).toHaveTextContent("出價至少要 125");
  });

  it("says plainly when there is no lot this week, with when the next opens", async () => {
    market({ auction: auction({ lot: null, mine: null, history: [] }) });
    renderPage(<Market />);
    expect(await screen.findByText("這一週沒有拍賣")).toBeInTheDocument();
    expect(screen.getByText(/下一場 .* 開始/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/出價\(至少/)).not.toBeInTheDocument();
  });

  it("says the auction is off when the Core does not run it", async () => {
    market({ auction: auction({ running: false, lot: null, mine: null, history: [] }) });
    renderPage(<Market />);
    expect(await screen.findByText("拍賣現在沒有開")).toBeInTheDocument();
  });

  it("lets the winner of a name lot give the name, or give it up after asking", async () => {
    const won = auction({
      lot: lot({ kind: "call_name", name: "這一週她怎麼叫你", state: "naming", min_bid: null, winner: { name: "Alice", price: 90 }, name_due: at(70 * HOUR) }),
      mine: { amount: 90, leading: true, won: true },
    });
    const { posts } = market({ auction: won });
    renderPage(<Market />);
    const input = await screen.findByLabelText(/這一週要她怎麼叫你/);
    await userEvent.type(input, "小魚");
    await userEvent.click(screen.getByRole("button", { name: "就叫這個" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/market/name", body: { name: "小魚" } }));
    await userEvent.click(screen.getByRole("button", { name: "不要了" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "不要了" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/market/name", body: { give_up: true } }));
  });
});

describe("市集: the lottery", () => {
  it("shows the price, their tickets of the most, the pot and the prize share, the draw and the last result", async () => {
    market();
    renderPage(<Market />);
    await block();
    const l = await waitFor(() => {
      const p = part("這一週的樂透");
      expect(p).toHaveTextContent("3 / 20 張");
      return p;
    });
    expect(l).toHaveTextContent("10 魚幣");
    expect(l).toHaveTextContent("230 魚幣");
    expect(l).toHaveTextContent("中獎拿(70%)");
    expect(l).toHaveTextContent("161 魚幣");
    expect(l).toHaveTextContent("23 張 · 5 人");
    expect(l).toHaveTextContent("3 天後");
    expect(l).toHaveTextContent("阿貓 中了 280 魚幣");
    expect(l).toHaveTextContent("少於 3 個人買就不開");
  });

  it("buys five with a fresh key per press, and shows the Core's sentence on a refusal", async () => {
    const { posts } = market();
    renderPage(<Market />);
    await waitFor(() => expect(part("這一週的樂透")).toHaveTextContent("3 / 20 張"));
    await userEvent.click(screen.getByRole("button", { name: /買 5 張/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /買 1 張/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((p) => p.body)).toEqual([{ count: 5 }, { count: 1 }]);
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
  });

  it("puts a refusal under the buttons", async () => {
    market({ buy: { status: 402, body: { error: "魚幣不夠,你有 4" } } });
    renderPage(<Market />);
    await waitFor(() => expect(part("這一週的樂透")).toHaveTextContent("3 / 20 張"));
    await userEvent.click(screen.getByRole("button", { name: /買 1 張/ }));
    expect(await within(part("這一週的樂透")).findByRole("alert")).toHaveTextContent("魚幣不夠,你有 4");
  });

  it("offers nothing more once they bought the most this week", async () => {
    market({ lottery: lottery({ mine: { tickets: 20 } }) });
    renderPage(<Market />);
    await waitFor(() => expect(part("這一週的樂透")).toHaveTextContent("20 / 20 張"));
    expect(screen.getByRole("button", { name: /買 1 張/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /買 5 張/ })).toBeDisabled();
  });
});

describe("市集: what they did, and its states", () => {
  it("lists their bids and tickets in words", async () => {
    market();
    renderPage(<Market />);
    await block();
    const bids = await waitFor(() => {
      const p = part("你的出價");
      expect(p).toHaveTextContent("領先中");
      return p;
    });
    expect(bids).toHaveTextContent("被超過");
    expect(bids).toHaveTextContent("得標");
    const tickets = part("你的彩券");
    expect(tickets).toHaveTextContent("還沒開獎");
    expect(tickets).toHaveTextContent("中了 280 魚幣");
  });

  it("has loading, module-off, error and no-route states", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const a = renderPage(<Market />);
    expect((await screen.findAllByLabelText("載入中")).length).toBeGreaterThan(0);
    a.unmount();
    market({ status: 503 });
    const b = renderPage(<Market />);
    expect(await screen.findByText("市集現在沒有開")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新檢查" })).toBeInTheDocument();
    b.unmount();
    market({ status: 500 });
    const c = renderPage(<Market />);
    // A failure that is not the module or the route is asked again twice before it shows.
    expect((await screen.findAllByRole("alert", undefined, { timeout: 8000 }))[0]).toHaveTextContent("boom");
    c.unmount();
    // An older Core without the routes: no block at all.
    mockFetch(() => undefined);
    renderPage(
      <>
        <p>會員頁</p>
        <Market />
      </>,
    );
    await screen.findByText("會員頁");
    await waitFor(() => expect(screen.queryAllByLabelText("載入中")).toHaveLength(0));
    expect(screen.queryByRole("heading", { name: "市集" })).not.toBeInTheDocument();
  });
});

const WALLET: WalletView = {
  currency: "魚幣",
  balance: 128,
  can_earn: true,
  today_earned: 0,
  checked_in_today: true,
  streak: 1,
  earn: [],
  shop: [{ id: "frame:sakura", kind: "frame", label: "櫻花", price: 100, available: true, why: null }],
  frames: { owned: ["sakura", "one-L-1"], selected: null },
  hungry: null,
  recent: [],
  on_board: false,
  transfer_fee: 0.05,
};

describe("a won one-of-a-kind frame", () => {
  it("is listed by its name in the shop's frames, theirs to put on", async () => {
    const { posts } = market({ wallet: WALLET });
    renderPage(<WalletMain />);
    const row = (await screen.findByText("只此一件")).closest("li") as HTMLElement;
    expect(row).not.toHaveTextContent("one-L-1");
    await userEvent.click(within(row).getByRole("button", { name: "使用 只此一件" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/frame", body: { select: "one-L-1" } }));
  });
});

describe("the song priority ticket", () => {
  const me = {
    card: { call_name: null, relationship: "朋友", affinity: null, trust: null, familiarity: null, public_feeling: null },
    bond: null,
    memories: [],
    songs: [],
    activity: [],
    can_request_song: true,
    forget: { removes: "", keeps: "" },
  };

  it("is offered while the market answers, and asked for with the request", async () => {
    const posts: unknown[] = [];
    mockFetch((method, url, body) => {
      if (method === "POST") posts.push(body);
      if (url.pathname === "/api/member/me") return { body: me };
      if (url.pathname === "/api/member/market/auction") return { body: auction() };
      if (url.pathname === "/api/member/songs") return { body: { accepted: true } };
      return undefined;
    });
    renderPage(<MemberActions />);
    const box = await screen.findByRole("checkbox", { name: /用點歌優先券/ });
    await userEvent.type(screen.getByLabelText("歌名或 YouTube / bilibili 連結"), "群青");
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "點歌" }));
    await waitFor(() => expect(posts).toEqual([{ query: "群青", priority: true }]));
  });

  it("is not offered without the market", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/member/me" ? { body: me } : undefined));
    renderPage(<MemberActions />);
    await screen.findByRole("button", { name: "點歌" });
    expect(screen.queryByRole("checkbox", { name: /用點歌優先券/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// the owner's side

const HISTORY: MarketHistory = {
  lots: [
    { ...lot({ state: "done", winner: { name: "小魚乾", price: 150 }, picked_by: "owner" }), note: "週年", price: 150 },
    { ...lot({ id: "L0", kind: "call_name", name: "這一週她怎麼叫你", state: "applied", call_name: "魚魚", extended: false }), note: null, price: 80 },
  ],
  weeks: [
    { week: 20_404, state: "drawn", drawn_at: "2026-11-15T12:00:00Z", tickets: 40, buyers: 7, pot: 400, prize: 280, burned: 120, winner: "阿貓" },
    { week: 20_397, state: "refunded", drawn_at: null, tickets: 4, buyers: 2, pot: 40, prize: 0, burned: 0, winner: null },
  ],
  offered: ["frame"],
  next: { opens_at: "2026-11-21T12:00:00Z", plan: null },
};

function admin(o: { history?: MarketHistory; status?: number; plan?: { status?: number; body: unknown } } = {}) {
  const posts: { path: string; body: unknown }[] = [];
  // What the Core answers for the coming week after a plan went through.
  let planned: MarketHistory["next"] | null = null;
  mockFetch((method, url, body) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body });
    if (path === "/api/market/history") {
      if (o.status) return { status: o.status, body: { error: "market module is not available" } };
      const h = o.history ?? HISTORY;
      return { body: planned ? { ...h, next: planned } : h };
    }
    if (path === "/api/market/plan") {
      if (o.plan) return o.plan;
      const lot = (body as { lot: "frame" | "skip" }).lot;
      planned = { opens_at: "2026-11-21T12:00:00Z", plan: lot };
      return { body: { week: 20_417, opens_at: "2026-11-21T12:00:00Z", plan: lot } };
    }
    if (path === "/api/market/settle") return { body: { ok: true } };
    return undefined;
  });
  return posts;
}

describe("經濟 / 市集", () => {
  it("lists the lots and the lottery weeks", async () => {
    admin();
    renderRoute("/economy?tab=market");
    const lots = await screen.findByRole("table", { name: "拍賣紀錄" });
    expect(lots).toHaveTextContent("週年");
    expect(lots).toHaveTextContent("你指定的");
    expect(lots).toHaveTextContent("結束了");
    expect(lots).toHaveTextContent("小魚乾 150");
    expect(lots).toHaveTextContent("「魚魚」");
    const weeks = screen.getByRole("table", { name: "樂透紀錄" });
    expect(weeks).toHaveTextContent("阿貓");
    expect(weeks).toHaveTextContent("已退回");
    expect(screen.getByRole("tab", { name: "市集" })).toBeInTheDocument();
  });

  it("has empty and module-off states", async () => {
    admin({ history: { lots: [], weeks: [], offered: ["frame"], next: null } });
    const a = renderRoute("/economy?tab=market");
    expect(await screen.findByText("還沒有拍賣紀錄")).toBeInTheDocument();
    expect(screen.getByText("還沒有開過獎")).toBeInTheDocument();
    a.unmount();
    admin({ status: 503 });
    renderRoute("/economy?tab=market");
    expect(await screen.findByText("市集(market 模組)沒有啟動")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拍賣現在結束" })).not.toBeInTheDocument();
  });

  it("sets the coming week's lot and says which week it is", async () => {
    const posts = admin();
    renderRoute("/economy?tab=market");
    const next = await screen.findByRole("region", { name: "下一場拍賣" });
    expect(within(next).getByText("由她挑")).toBeInTheDocument();
    // Only the kinds the config offers: the frame alone by default.
    expect(within(next).queryByRole("radio", { name: "這一週她怎麼叫你" })).not.toBeInTheDocument();
    await userEvent.click(within(next).getByRole("radio", { name: "這一週不拍" }));
    await userEvent.click(within(next).getByRole("button", { name: "設定" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/market/plan", body: { lot: "skip" } }]));
    expect(await within(next).findByText("不拍")).toBeInTheDocument();
  });

  it("offers the name lot when the config does", async () => {
    admin({ history: { ...HISTORY, offered: ["call_name", "frame"] } });
    renderRoute("/economy?tab=market");
    const next = await screen.findByRole("region", { name: "下一場拍賣" });
    expect(within(next).getByRole("radio", { name: "這一週她怎麼叫你" })).toBeInTheDocument();
  });

  it("says why when the account may not touch the market", async () => {
    admin({ plan: { status: 403, body: { error: "this needs `admin.economy.adjust`" } } });
    renderRoute("/economy?tab=market");
    const next = await screen.findByRole("region", { name: "下一場拍賣" });
    await userEvent.click(within(next).getByRole("radio", { name: "只此一件的卡框" }));
    await userEvent.click(within(next).getByRole("button", { name: "設定" }));
    expect(await screen.findByText(/你的帳號沒有市集的權限/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拍賣現在結束" })).toBeDisabled();
  });

  it("draws the lottery now only after asking", async () => {
    const posts = admin();
    renderRoute("/economy?tab=market");
    await userEvent.click(await screen.findByRole("button", { name: "樂透現在開獎" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(posts).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "開獎" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/market/settle", body: { what: "lottery" } }]));
  });
});

describe("市集: one per server", () => {
  afterEach(() => window.localStorage.clear());

  it("someone in two servers picks which; every view and bid then goes to that server", async () => {
    const user = userEvent.setup();
    const spaces = [
      { id: "A", platform: "discord", external_id: "gA", name: "本來的伺服器", primary: true },
      { id: "B", platform: "discord", external_id: "gB", name: "第二個伺服器", primary: false },
    ];
    const asked: string[] = [];
    const posts: { path: string; space: string | null }[] = [];
    mockFetch((method, url) => {
      const path = url.pathname;
      const space = url.searchParams.get("space");
      if (path === "/api/member/spaces") return { body: { spaces, default: "A" } };
      if (!path.startsWith("/api/member/market/")) return undefined;
      if (method === "POST") posts.push({ path, space });
      else asked.push(`${path.slice("/api/member/market/".length)}:${space ?? "-"}`);
      const top = space === "B" ? { amount: 300, name: "第二家的人" } : { amount: 120, name: "小魚乾" };
      if (path === "/api/member/market/auction") return { body: auction({ lot: lot({ top }) }) };
      if (path === "/api/member/market/lottery" && method === "GET") return { body: lottery() };
      if (path === "/api/member/market/bids") return { body: BIDS };
      if (path === "/api/member/market/tickets") return { body: TICKETS };
      if (path === "/api/member/market/bid") return { body: { amount: 310, ends_at: at(HOUR), extended: false, balance: 0 } };
      return undefined;
    });
    renderPage(<Market />);
    await waitFor(() => expect(part("這一週的拍賣")).toHaveTextContent("120 · 小魚乾"));
    // The default (the original server) is asked for by its id once the servers are known.
    expect(asked).toContain("auction:A");
    await user.click(screen.getByRole("radio", { name: "第二個伺服器" }));
    await waitFor(() => expect(part("這一週的拍賣")).toHaveTextContent("300 · 第二家的人"));
    expect(asked).toEqual(expect.arrayContaining(["auction:B", "lottery:B", "bids:B", "tickets:B"]));
    await user.click(within(part("這一週的拍賣")).getByRole("button", { name: "出價" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/member/market/bid", space: "B" }]));
  });

  it("someone in one server sees no picker, and the page asks as it always did", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/member/spaces") return { body: { spaces: [], default: null } };
      if (url.pathname === "/api/member/market/auction") {
        expect(url.searchParams.has("space")).toBe(false);
        return { body: auction() };
      }
      return url.pathname === "/api/member/market/lottery" ? { body: lottery() } : undefined;
    });
    renderPage(<Market />);
    await waitFor(() => expect(part("這一週的拍賣")).toHaveTextContent("120 · 小魚乾"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
