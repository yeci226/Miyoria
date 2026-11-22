// Free-form gifts: 送她禮物 on the member page (ask the price, then 確認 or 取消; a fixed food fed at
// once; a refusal said plainly), 她收到的東西 on the public page, and 經濟 / 禮物 for the owner.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AdminGiftItem, GiftAskResult, GiftQuoteView, GiftViewItem, PublicGifts, WalletView } from "@miyoria/contracts/api";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { GiftsCard, GiftsReceived } from "./Gifts";

const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const WALLET: WalletView = {
  currency: "魚幣",
  balance: 200,
  can_earn: true,
  today_earned: 0,
  checked_in_today: true,
  streak: 1,
  earn: [],
  shop: [],
  frames: { owned: [], selected: null },
  hungry: null,
  recent: [],
  on_board: false,
  transfer_fee: 0.05,
};

const gift = (over: Partial<GiftViewItem> = {}): GiftViewItem => ({
  id: "G1",
  item: "一杯珍奶",
  kind: "drink",
  kind_word: "喝的",
  tier: null,
  price: 80,
  twd: 80,
  status: "accepted",
  line: "甜甜的,謝謝你",
  favourite: true,
  answered_by: "her",
  created_at: at(-2 * HOUR),
  expires_at: at(-HOUR),
  answer_due: null,
  answered_at: at(-HOUR),
  ...over,
});

const quote = (over: Partial<GiftQuoteView> = {}): GiftQuoteView => ({
  id: "Q1",
  item: "一杯珍奶",
  kind: "drink",
  kind_word: "喝的",
  twd: 80,
  twd_per_coin: 1,
  band: "有點心意",
  price: 80,
  currency: "魚幣",
  balance: 200,
  balance_after: 120,
  expires_at: at(5 * 60_000),
  big: false,
  fallback: false,
  note: null,
  ...over,
});

interface MemberOptions {
  open?: boolean;
  gifts?: GiftViewItem[];
  ask?: { status?: number; body: GiftAskResult | { error: string } };
}

function member(o: MemberOptions = {}) {
  const posts: { path: string; body: unknown; key: string | null }[] = [];
  mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, key: headers.get("Idempotency-Key") });
    if (path === "/api/member/wallet") return { body: WALLET };
    if (path === "/api/member/gifts") return { body: { open: o.open ?? true, currency: "魚幣", twd_per_coin: 1, big_gift_coins: 1000, gifts: o.gifts ?? [] } };
    if (path === "/api/member/gifts/quote") return o.ask ?? { body: { status: "quote", quote: quote(), item: null, reason: null, message: null } };
    if (path === "/api/member/gifts/Q1/confirm") return { body: { gift: gift({ id: "Q1", status: "confirmed", line: null, favourite: false }), charged: true, balance: 120 } };
    if (path === "/api/member/gifts/Q1/cancel") return { body: gift({ id: "Q1", status: "cancelled", line: null, favourite: false }) };
    if (path === "/api/member/gifts/G1/picture") return { body: { alt: "一杯珍奶,她收下了", png: "iVBORw0KGgo=" } };
    if (path === "/api/member/feed") return { body: { accepted: true, message: "她吃了一碗白飯", charged: 5, balance: 195 } };
    return undefined;
  });
  return posts;
}

const card = async () => (await screen.findByRole("heading", { name: "送她禮物" })).closest("section") as HTMLElement;

async function askFor(name: string) {
  await userEvent.type(await screen.findByLabelText("要送她什麼"), name);
  await userEvent.click(screen.getByRole("button", { name: "問價" }));
}

describe("送她禮物: two steps", () => {
  it("asks the price with a key, charges nothing until 確認, then says it went", async () => {
    const posts = member();
    renderPage(<GiftsCard />);
    await askFor("一杯珍奶");
    const q = await screen.findByRole("region", { name: "報價" });
    expect(q).toHaveTextContent("一杯珍奶");
    expect(q).toHaveTextContent("約 NT$80 → 80 魚幣");
    expect(q).toHaveTextContent("送出後剩120 魚幣");
    expect(q).toHaveTextContent("她不收會全額退回");
    expect(q).not.toHaveTextContent("這是一份大禮");
    expect(q).not.toHaveTextContent("級");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: "/api/member/gifts/quote", body: { name: "一杯珍奶" } });
    expect(posts[0]?.key).toBeTruthy();
    // Nothing is charged before 確認.
    expect(posts.some((p) => p.path.endsWith("/confirm"))).toBe(false);
    await userEvent.click(within(q).getByRole("button", { name: "確認" }));
    await waitFor(() => expect(posts.at(-1)?.path).toBe("/api/member/gifts/Q1/confirm"));
    expect(await screen.findByRole("status")).toHaveTextContent("送出了,等她回應");
    expect(screen.queryByRole("region", { name: "報價" })).not.toBeInTheDocument();
  });

  it("cancels a quote without charging", async () => {
    const posts = member();
    renderPage(<GiftsCard />);
    await askFor("一杯珍奶");
    const q = await screen.findByRole("region", { name: "報價" });
    await userEvent.click(within(q).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/member/gifts/quote", "/api/member/gifts/Q1/cancel"]));
    expect(await screen.findByRole("status")).toHaveTextContent("取消了,沒有扣錢");
  });

  it("says so on a big gift, with thousands separators and the same 確認", async () => {
    const posts = member({
      ask: {
        body: {
          status: "quote",
          quote: quote({ item: "一台機車", twd: 60_000, price: 60_000, balance: 65_000, balance_after: 5_000, big: true, band: "誇張" }),
          item: null,
          reason: null,
          message: null,
        },
      },
    });
    renderPage(<GiftsCard />);
    await askFor("一台機車");
    const q = await screen.findByRole("region", { name: "報價" });
    expect(q).toHaveTextContent("約 NT$60,000 → 60,000 魚幣");
    expect(q).toHaveTextContent("這是一份大禮:60,000 魚幣,送出後只剩 5,000 魚幣。");
    await userEvent.click(within(q).getByRole("button", { name: "確認" }));
    await waitFor(() => expect(posts.at(-1)?.path).toBe("/api/member/gifts/Q1/confirm"));
  });

  it("shows the fallback note and coins alone, and will not confirm a quote that has expired", async () => {
    member({
      ask: {
        body: {
          status: "quote",
          quote: quote({ twd: null, price: 50, balance_after: 150, fallback: true, note: "現在估不了價,先用預設的 50 魚幣", expires_at: at(-60_000) }),
          item: null,
          reason: null,
          message: null,
        },
      },
    });
    renderPage(<GiftsCard />);
    await askFor("一座城堡");
    const q = await screen.findByRole("region", { name: "報價" });
    expect(q).toHaveTextContent("現在估不了價,先用預設的 50 魚幣");
    expect(q).toHaveTextContent("價錢50 魚幣");
    expect(q).not.toHaveTextContent("NT$");
    expect(within(q).getByRole("button", { name: "確認" })).toBeDisabled();
    expect(q).toHaveTextContent("這個報價過期了");
  });

  it("feeds a fixed food at once, with no confirmation", async () => {
    const posts = member({ ask: { body: { status: "fixed", quote: null, item: "rice", reason: null, message: null } } });
    renderPage(<GiftsCard />);
    await askFor("白飯");
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/member/gifts/quote", "/api/member/feed"]));
    expect(posts[1]).toMatchObject({ body: { item: "rice", count: 1 } });
    expect(posts[1]?.key).toBeTruthy();
    expect(await screen.findByText("她吃了一碗白飯")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "報價" })).not.toBeInTheDocument();
  });

  it("says a refusal plainly, and that nothing was charged", async () => {
    member({ ask: { body: { status: "refused", quote: null, item: null, reason: "unsafe", message: "這個不能送給她" } } });
    renderPage(<GiftsCard />);
    await askFor("奇怪的東西");
    const alert = await within(await card()).findByRole("alert");
    expect(alert).toHaveTextContent("這個不能送給她");
    expect(alert).toHaveTextContent("沒有扣錢");
  });

  it("shows the Core's sentence when it will not quote", async () => {
    member({ ask: { status: 429, body: { error: "今天問價的次數用完了" } } });
    renderPage(<GiftsCard />);
    await askFor("一杯珍奶");
    expect(await within(await card()).findByRole("alert")).toHaveTextContent("今天問價的次數用完了");
  });
});

describe("送她禮物: what they gave", () => {
  it("lists gifts in words, her line, the favourite mark, and the picture of a kept one", async () => {
    member({
      gifts: [
        gift(),
        gift({ id: "G2", item: "一束花", status: "refused", line: null, favourite: false, twd: null, tier: 2, price: 30 }),
      ],
    });
    renderPage(<GiftsCard />);
    const list = await screen.findByRole("region", { name: "你送她的東西" });
    const first = (await within(list).findByText("一杯珍奶")).closest("li") as HTMLElement;
    expect(first).toHaveTextContent("她收下了");
    expect(first).toHaveTextContent("約 NT$80 → 80 魚幣");
    expect(first).toHaveTextContent("「甜甜的,謝謝你」");
    expect(within(first).getByText("她最喜歡的")).toBeInTheDocument();
    const second = within(list).getByText("一束花").closest("li") as HTMLElement;
    expect(second).toHaveTextContent("她沒收,已退回");
    // An old gift priced by tier: coins alone, no tier words.
    expect(second).toHaveTextContent("30 魚幣");
    expect(second).not.toHaveTextContent("NT$");
    expect(second).not.toHaveTextContent("級");
    expect(within(second).queryByRole("button")).toBeNull();
    await userEvent.click(within(first).getByRole("button", { name: "一杯珍奶 的圖" }));
    const dialog = await screen.findByRole("dialog");
    const img = await within(dialog).findByRole("img", { name: "一杯珍奶,她收下了" });
    expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(within(dialog).getByRole("link", { name: "存下圖片" })).toHaveAttribute("href", "data:image/png;base64,iVBORw0KGgo=");
    expect(screen.getByText("禮物改變不了她對你的感覺,只是一份心意。")).toBeInTheDocument();
  });

  it("hides the form while gifts are closed, and keeps the list", async () => {
    member({ open: false, gifts: [gift()] });
    renderPage(<GiftsCard />);
    expect(await screen.findByText("一杯珍奶")).toBeInTheDocument();
    expect(screen.queryByLabelText("要送她什麼")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "問價" })).not.toBeInTheDocument();
  });

  it("leaves the block out on a Core without the routes", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/member/wallet" ? { body: WALLET } : undefined));
    renderPage(
      <>
        <p>會員頁</p>
        <GiftsCard />
      </>,
    );
    await screen.findByText("會員頁");
    await waitFor(() => expect(screen.queryAllByLabelText("載入中")).toHaveLength(0));
    expect(screen.queryByRole("heading", { name: "送她禮物" })).not.toBeInTheDocument();
  });
});

describe("她收到的東西", () => {
  const pub = (over: Partial<PublicGifts["recent"][number]>) => ({
    id: "P1",
    item: "一杯珍奶",
    kind: "drink" as const,
    kind_word: "喝的",
    line: "甜甜的",
    favourite: false,
    at: "2026-11-20T10:00:00Z",
    from: "小魚乾",
    ...over,
  });

  it("lists favourites first and marked, then the rest, and a giver only when named", async () => {
    const body: PublicGifts = {
      favourites: [pub({ id: "P2", item: "一束花", line: "好香", favourite: true, from: null })],
      recent: [pub({}), pub({ id: "P2", item: "一束花", line: "好香", favourite: true, from: null })],
    };
    mockFetch((_m, url) => (url.pathname === "/api/public/gifts" ? { body } : undefined));
    renderPage(<GiftsReceived />);
    const list = await screen.findByRole("list", { name: "她收到的東西" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("一束花");
    expect(within(rows[0] as HTMLElement).getByText("她最喜歡的")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("「好香」");
    expect(rows[0]).not.toHaveTextContent("—");
    expect(rows[1]).toHaveTextContent("一杯珍奶");
    expect(rows[1]).toHaveTextContent("— 小魚乾");
    expect(rows[1]).toHaveTextContent("2026.11.20");
  });

  it("says so when she has nothing yet", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/public/gifts" ? { body: { recent: [], favourites: [] } } : undefined));
    renderPage(<GiftsReceived />);
    expect(await screen.findByText("她還沒有收到東西")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// the owner's side

const adminGift = (over: Partial<AdminGiftItem> = {}): AdminGiftItem => ({
  ...gift(),
  giver: "小魚乾",
  person: "p1",
  priced_by: "model",
  reason: null,
  source: "web",
  refunded_by: null,
  ...over,
});

function admin(o: { refund?: { status?: number; body: unknown } } = {}) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockFetch((method, url, body) => {
    const path = url.pathname;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/economy/gifts") {
      return {
        body: {
          currency: "魚幣",
          twd_per_coin: 1,
          big_gift_coins: 1000,
          gifts: [
            adminGift({ twd: 6000, price: 6000 }),
            adminGift({ id: "G2", item: "一束花", status: "cancelled", line: null, favourite: false, priced_by: "pinned", twd: null, price: 30, tier: 2 }),
          ],
        },
      };
    }
    if (path === "/api/economy/gifts/G1/refund") return o.refund ?? { body: { ok: true } };
    if (path === "/api/economy/gifts/prices" && method === "GET") {
      return {
        body: {
          overrides: [
            { item_key: "珍奶", item: "珍奶", kind: "drink", twd: null, coins: 30, price: 30, refuse: null, source: "pinned", by: "owner", at: "2026-11-20T10:00:00Z" },
            { item_key: "機車", item: "機車", kind: "big_object", twd: 60_000, coins: null, price: 60_000, refuse: null, source: "pinned", by: "owner", at: "2026-11-20T10:00:00Z" },
            { item_key: "炸彈", item: "炸彈", kind: null, twd: null, coins: null, price: null, refuse: null, source: "blocked", by: "owner", at: "2026-11-20T10:00:00Z" },
          ],
        },
      };
    }
    if (path === "/api/economy/gifts/prices" && method === "DELETE") return { body: { removed: true } };
    if (path === "/api/economy/gifts/prices" && method === "PUT") return { body: { item: "城堡", item_key: "城堡" } };
    return undefined;
  });
  return writes;
}

describe("經濟 / 禮物", () => {
  it("lists every gift with giver, the NT$ estimate and the coins, status in words, how it was priced and her line", async () => {
    admin();
    renderRoute("/economy?tab=gifts");
    const table = await screen.findByRole("table", { name: "最近的禮物" });
    const first = within(table).getByText("一杯珍奶").closest("tr") as HTMLElement;
    expect(first).toHaveTextContent("小魚乾");
    expect(first).toHaveTextContent("NT$6,000 → 6,000");
    expect(first).toHaveTextContent("收下了");
    expect(first).toHaveTextContent("模型估的");
    expect(first).toHaveTextContent("「甜甜的,謝謝你」");
    const second = within(table).getByText("一束花").closest("tr") as HTMLElement;
    expect(second).toHaveTextContent("你指定的");
    // An old row priced by tier: the coins alone.
    expect(second).toHaveTextContent("30");
    expect(second).not.toHaveTextContent("NT$");
    expect(second).not.toHaveTextContent("級");
    expect(within(second).queryByRole("button", { name: /退款/ })).toBeNull();
    expect(screen.getByText("匯率是 1 魚幣 = NT$1;台幣估價和以台幣指定的價錢跟著匯率變,以魚幣指定的不變。")).toBeInTheDocument();
    const pins = await screen.findByRole("table", { name: "指定與封鎖" });
    const coins = within(pins).getByText("珍奶").closest("tr") as HTMLElement;
    expect(coins).toHaveTextContent("喝的");
    expect(coins).toHaveTextContent("—3030");
    const twd = within(pins).getByText("機車").closest("tr") as HTMLElement;
    expect(twd).toHaveTextContent("NT$60,000—60,000");
    expect(within(pins).getByText("炸彈").closest("tr")).toHaveTextContent("封鎖");
  });

  it("pins a name in coins or in NT$, with its kind", async () => {
    const writes = admin();
    const user = userEvent.setup();
    renderRoute("/economy?tab=gifts");
    const block = await screen.findByRole("region", { name: "指定價錢與封鎖" });
    await user.type(within(block).getByLabelText("名字"), "城堡");
    await user.click(within(block).getByRole("combobox", { name: "種類" }));
    await user.click(await screen.findByRole("option", { name: "大東西" }));
    await user.type(within(block).getByLabelText("價錢(魚幣)"), "500");
    await user.click(within(block).getByRole("button", { name: "指定價錢" }));
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({ method: "PUT", path: "/api/economy/gifts/prices", body: { name: "城堡", kind: "big_object", coins: 500 } }),
    );
    await user.type(within(block).getByLabelText("名字"), "遊艇");
    await user.click(within(block).getByRole("radio", { name: "台幣估價" }));
    await user.type(within(block).getByLabelText("台幣估價(NT$)"), "3000000");
    await user.click(within(block).getByRole("button", { name: "指定價錢" }));
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({ method: "PUT", path: "/api/economy/gifts/prices", body: { name: "遊艇", kind: "big_object", twd: 3_000_000 } }),
    );
  });

  it("refunds only after asking", async () => {
    const writes = admin();
    renderRoute("/economy?tab=gifts");
    await userEvent.click(await screen.findByRole("button", { name: "退款 一杯珍奶(小魚乾)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("6,000 魚幣全部還給 小魚乾");
    expect(writes).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "退款" }));
    await waitFor(() => expect(writes).toEqual([{ method: "POST", path: "/api/economy/gifts/G1/refund", body: undefined }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("blocks a name and removes a pin", async () => {
    const writes = admin();
    renderRoute("/economy?tab=gifts");
    const block = await screen.findByRole("region", { name: "指定價錢與封鎖" });
    await userEvent.type(within(block).getByLabelText("名字"), "城堡");
    await userEvent.click(within(block).getByRole("button", { name: "封鎖這個名字" }));
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: "PUT", path: "/api/economy/gifts/prices", body: { name: "城堡", block: true } }));
    await userEvent.click(await within(block).findByRole("button", { name: "拿掉 珍奶" }));
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: "DELETE", path: "/api/economy/gifts/prices", body: { name: "珍奶" } }));
  });

  it("says why when the account may not refund", async () => {
    admin({ refund: { status: 403, body: { error: "this needs `admin.economy.adjust`" } } });
    renderRoute("/economy?tab=gifts");
    await userEvent.click(await screen.findByRole("button", { name: "退款 一杯珍奶(小魚乾)" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "退款" }));
    expect(await screen.findByText(/你的帳號沒有禮物的權限/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退款 一杯珍奶(小魚乾)" })).toBeDisabled();
  });
});
