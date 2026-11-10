import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GoalView,
  IssuedCard,
  IssuedFortune,
  MemberSession,
  MemberView,
  PublicSongs,
  PublicStatus,
  SessionInfo,
  WalletView,
} from "@/api/types";
import { App } from "@/app/App";
import { STORAGE_BASE_URL, STORAGE_TOKEN } from "@/app/connection";
import { createAppRouter } from "@/app/router";
import { CardFace } from "./card";
import { writeStorage } from "@/lib/storage";
import { mockFetch } from "@/test/render";

const STATUS: PublicStatus = {
  state: "singing",
  live: true,
  in_voice: true,
  game: null,
  today: { songs_sung: 3, hours_live: 1.5, hours_in_voice: 2 },
  days: [
    { date: "2026-11-06", songs_sung: 4, hours_live: 2, hours_in_voice: 3 },
    { date: "2026-11-07", songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
    { date: "2026-11-08", songs_sung: 3, hours_live: 1.5, hours_in_voice: 2 },
  ],
};

const SONGS: PublicSongs = {
  playing: { title: "夜に駆ける", artist: "YOASOBI", duration_s: 261 },
  upcoming: [
    { title: "群青", artist: "YOASOBI", duration_s: 248, ready: true },
    { title: null, artist: null, duration_s: null, ready: false },
  ],
  recent: [{ title: "アイドル", artist: "YOASOBI", duration_s: 213 }],
};

const ME: MemberView = {
  card: {
    call_name: "小愛",
    relationship: "好朋友",
    affinity: "很好",
    trust: "信任",
    familiarity: "熟",
    public_feeling: "妳總是記得跟我打招呼。",
  },
  memories: [{ text: "小愛喜歡貓", kind: "fact", date: "2026-11-07" }],
  songs: [{ title: "群青", artist: "YOASOBI", state: "ready", requested_at: "2026-11-07T12:00:00Z" }],
  activity: [
    { date: "2026-11-07", text: 5, voice: 2 },
    { date: "2026-11-08", text: 1, voice: 0 },
  ],
  can_request_song: true,
  forget: { removes: "會刪除:關於你的記憶", keeps: "不會刪除:聊天紀錄" },
};

const STRANGER: MemberView = {
  card: {
    call_name: null,
    relationship: null,
    affinity: null,
    trust: null,
    familiarity: null,
    public_feeling: null,
  },
  memories: [],
  songs: [],
  can_request_song: false,
  forget: ME.forget,
};

const WALLET: WalletView = {
  currency: "魚幣",
  balance: 128,
  can_earn: true,
  today_earned: 20,
  checked_in_today: false,
  streak: 3,
  earn: [
    { reason: "checkin", label: "每日簽到", amount: 10, earned_today: 0, cap: 10 },
    { reason: "talked", label: "今天和她說過話", amount: 10, earned_today: 10, cap: 10 },
    { reason: "voice", label: "在她的語音頻道", amount: 2, earned_today: 4, cap: 20 },
  ],
  shop: [
    { id: "rice", kind: "feed", label: "一碗白飯", price: 10, available: true, why: null },
    { id: "big_bowl", kind: "feed", label: "鋼盆", price: 40, available: true, why: null },
    { id: "dessert", kind: "feed", label: "甜點", price: 25, available: true, why: null },
    { id: "letter", kind: "letter", label: "一封信", price: 15, available: true, why: null },
    { id: "expression:heart", kind: "expression", label: "愛心眼", price: 20, available: true, why: null },
    { id: "expression:blush", kind: "expression", label: "臉紅", price: 20, available: false, why: "直播還沒開" },
    { id: "expression:squint", kind: "expression", label: "＞＜", price: 20, available: true, why: null },
    { id: "frame:sakura", kind: "frame", label: "櫻花", price: 100, available: true, why: null },
    { id: "frame:abyss", kind: "frame", label: "深海", price: 150, available: true, why: null },
    { id: "frame:gold", kind: "frame", label: "金框", price: 300, available: true, why: null },
    { id: "song_ticket", kind: "song", label: "點歌加點券", price: 25, available: true, why: null },
    { id: "dedication", kind: "song", label: "歌曲獻詞", price: 15, available: true, why: null },
    { id: "screen_message", kind: "stream", label: "留言上大螢幕", price: 30, available: true, why: null },
    { id: "fortune", kind: "fortune", label: "今日籤詩", price: 10, available: true, why: null },
  ],
  frames: { owned: ["sakura"], selected: null },
  hungry: "hungry",
  recent: [
    { ts: "2026-11-08T03:00:00Z", delta: 10, label: "每日簽到" },
    { ts: "2026-11-08T02:00:00Z", delta: -10, label: "餵了一碗白飯" },
  ],
  on_board: false,
};

const SLIP: IssuedFortune = {
  id: "f1",
  date: "2026-11-08",
  issued_at: "2026-11-08T03:00:00Z",
  rank: "吉",
  title: "小雨天晴",
  poem: ["雲過月更明", "有人在等你", "慢慢走不急", "今夜有好眠"],
  fields: [{ label: "心情", text: "會變好" }],
  line: "記得喝水",
};

const GOAL: GoalView = {
  id: "g1",
  title: "新的麥克風",
  promise: "唱一整晚的歌",
  target: 500,
  raised: 200,
  my_pledge: 0,
  deadline: "2099-01-01T00:00:00Z",
  status: "open",
};

const OFFERS_FOR_REROLL = {
  poses: [],
  prices: { pose: null, foil: null, reroll: 30 },
  rerolls_left: 2,
};

const USER: MemberSession = { name: "Alice", avatar_url: null };

interface Options {
  discord?: boolean;
  publicOn?: boolean;
  member?: MemberSession | null;
  me?: MemberView;
  session?: SessionInfo | null;
  noCard?: boolean;
  /** `null`: a Core without a wallet. */
  wallet?: WalletView | null;
  /** What the next feed answers. */
  feed?: { status?: number; body: unknown };
  /** Extra fields of `GET /api/member/card` (poses, prices, rerolls). */
  cardInfo?: Record<string, unknown>;
  /** What the check page answers for the card's code. */
  checked?: IssuedCard;
  /** What the next screen message answers. */
  screen?: { status?: number; body: unknown };
  /** Today's slip already drawn. */
  slip?: boolean;
}

const CARD: IssuedCard = {
  serial: "MYR-AB12-CD34-EF56",
  issued_at: "2026-11-08T03:00:00Z",
  name: "Alice",
  avatar_url: null,
  number: 1,
  call_name: "小愛",
  relationship: "好朋友",
  affinity: "很好",
  trust: "信任",
  familiarity: "熟",
  public_feeling: "妳總是記得跟我打招呼。",
  pose: "blush",
};

function core(o: Options = {}) {
  const posts: { path: string; body: unknown }[] = [];
  let latest: IssuedCard | null = o.noCard ? null : CARD;
  let wallet: WalletView = o.wallet ?? WALLET;
  let slip: IssuedFortune | null = o.slip ? SLIP : null;
  let pledged = 0;
  const keys: (string | null)[] = [];
  const fn = mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") {
      posts.push({ path, body });
      keys.push(headers.get("Idempotency-Key"));
    }
    if (path.startsWith("/api/member/") && o.wallet === null) {
      if (["wallet", "checkin", "feed", "letter", "expression", "frame"].includes(path.slice(12))) return undefined;
    }
    if (path === "/api/member/wallet") return { body: wallet };
    if (path === "/api/member/checkin") {
      wallet = { ...wallet, balance: wallet.balance + 10, checked_in_today: true, streak: 4, today_earned: 30 };
      return { body: { gained: 10, streak: 4, balance: wallet.balance } };
    }
    if (path === "/api/member/feed") {
      if (o.feed) return o.feed;
      wallet = { ...wallet, balance: wallet.balance - 10 };
      return { body: { accepted: true, eaten: 1, charged: 10, balance: wallet.balance, message: "她吃得很開心" } };
    }
    if (path === "/api/member/letter") {
      wallet = { ...wallet, balance: wallet.balance - 15 };
      return { body: { accepted: true, charged: 15, balance: wallet.balance, message: "信寄出了" } };
    }
    if (path === "/api/member/frame") {
      const req = body as { buy?: string; select?: string | null };
      const owned = req.buy ? [...wallet.frames.owned, req.buy] : wallet.frames.owned;
      const selected = req.select !== undefined ? req.select : wallet.frames.selected;
      wallet = { ...wallet, balance: wallet.balance - (req.buy ? 150 : 0), frames: { owned, selected } };
      return { body: { owned, selected, balance: wallet.balance } };
    }
    if (path === "/api/member/screen") {
      if (o.screen) return o.screen;
      wallet = { ...wallet, balance: wallet.balance - 30 };
      return { body: { accepted: true, charged: 30, balance: wallet.balance, message: "已經送上螢幕了" } };
    }
    if (path === "/api/member/fortune") {
      if (method === "POST") {
        slip = SLIP;
        wallet = { ...wallet, balance: wallet.balance - 10 };
        return { body: { fortune: SLIP, charged: 10, balance: wallet.balance } };
      }
      return { body: { fortune: slip, price: 10 } };
    }
    if (path === "/api/member/transfer") {
      wallet = { ...wallet, balance: wallet.balance - 20 };
      return { body: { sent: 20, balance: wallet.balance, to: "Bob" } };
    }
    if (path === "/api/member/board") {
      const on = (body as { on: boolean }).on;
      wallet = { ...wallet, on_board: on };
      return { body: { on_board: on } };
    }
    if (path === "/api/public/board") {
      return { body: { entries: [{ rank: 1, name: "小明", spent: 340 }, { rank: 2, name: "匿名", spent: 120 }] } };
    }
    if (path === "/api/member/goals") {
      return {
        body: {
          goals: [
            { ...GOAL, my_pledge: pledged, raised: GOAL.raised + pledged },
            { ...GOAL, id: "g0", title: "舊的耳機", status: "expired" },
          ],
        },
      };
    }
    if (path === "/api/member/goals/g1/pledge") {
      const amount = (body as { amount: number }).amount;
      pledged += amount;
      wallet = { ...wallet, balance: wallet.balance - amount };
      return {
        body: { pledged: amount, raised: 200 + pledged, target: 500, reached: false, balance: wallet.balance, duplicate: false },
      };
    }
    if (path === "/api/member/bounties") {
      return {
        body: {
          bounties: [
            { id: "b1", task: "教她一個新梗", reward: 40, posted_at: "2026-11-08T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
          ],
        },
      };
    }
    if (path === "/api/auth/methods") return { body: { token: true, discord: o.discord ?? true } };
    if (path === "/api/auth/session") {
      return o.session ? { body: o.session } : { status: 401, body: { error: "no" } };
    }
    if (path === "/api/auth/logout") return { status: 204 };
    if (path.startsWith("/api/public/") && o.publicOn === false) return undefined;
    if (path === "/api/public/status") return { body: STATUS };
    if (path === "/api/public/songs") return { body: SONGS };
    if (path === "/api/member/session") {
      return o.member ? { body: o.member } : { status: 401, body: { error: "not logged in" } };
    }
    if (path === "/api/member/me") return { body: o.me ?? ME };
    if (path === "/api/member/forget") {
      return { body: { deleted: 2, about: 2, derived: 0, unverified: 0 } };
    }
    if (path === "/api/member/songs") return { body: { accepted: true } };
    if (path === "/api/member/card/reroll") {
      latest = { ...CARD, serial: "MYR-RR00-0000-0003" };
      return { body: latest };
    }
    if (path === "/api/member/card" && method === "POST") {
      const req = body as { pose?: string; foil?: boolean };
      latest = { ...CARD, serial: "MYR-NEW0-0000-0002", number: 2, pose: req.pose ?? CARD.pose, foil: req.foil === true };
      return { body: latest };
    }
    if (path === "/api/member/card") {
      return { body: { latest, today: latest ? latest.number : 0, per_day: 5, ...o.cardInfo } };
    }
    if (path === `/api/public/card/${CARD.serial}`) return { body: o.checked ?? CARD };
    if (path.startsWith("/api/public/card/")) return { status: 404, body: { error: "這張卡不存在或已經作廢" } };
    return undefined;
  });
  return { fn, posts, keys };
}

const paths = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.map(([input]) => new URL(String(input), "http://panel.test").pathname);

/** The app at the address the test set (`window.location`), as the browser would open it. */
const renderApp = () =>
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: [`${window.location.pathname}${window.location.search}`] }),
      )}
    />,
  );

afterEach(() => {
  window.history.replaceState(null, "", "/");
  writeStorage(STORAGE_TOKEN, null);
  writeStorage(STORAGE_BASE_URL, null);
});

describe("an anonymous visitor", () => {
  it("gets the login screen, Discord first, and nothing of hers", async () => {
    core();
    renderApp();
    const link = await screen.findByRole("link", { name: "使用 Discord 登入" });
    expect(link).toHaveAttribute("href", "/api/auth/oauth/login?next=%2F");
    expect(screen.queryByLabelText("Admin token")).toBeNull();
    expect(screen.queryByRole("region", { name: "現在" })).toBeNull();
    expect(screen.queryByText("她眼中的你")).toBeNull();
    for (const name of ["總覽", "直播", "內心", "權限", "資料", "設定", "緊急停止"]) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("calls nothing but the routes that say who is asking", async () => {
    const { fn } = core();
    renderApp();
    await screen.findByRole("link", { name: "使用 Discord 登入" });
    expect([...new Set(paths(fn))].sort()).toEqual([
      "/api/auth/methods",
      "/api/auth/session",
      "/api/member/session",
      "/api/public/status",
    ]);
  });

  it("can open the token form, for the owner", async () => {
    core();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "管理員用 token 登入" }));
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("gets the token form at once when the Core has no public side", async () => {
    core({ publicOn: false });
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("reaches the token form at /login", async () => {
    window.history.replaceState(null, "", "/login");
    core();
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("gets the token form when Discord login is off", async () => {
    core({ discord: false });
    renderApp();
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
  });

  it("sees why a Discord login failed, on the login screen", async () => {
    window.history.replaceState(null, "", "/login?error=cancelled");
    core();
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("已取消 Discord 授權");
    expect(screen.getByRole("link", { name: "使用 Discord 登入" })).toBeInTheDocument();
  });
});

describe("a member", () => {
  it("sees her view of them, in words", async () => {
    core({ member: USER });
    renderApp();
    const view = await screen.findByRole("region", { name: "她眼中的你" });
    expect(await within(view).findByText("小愛")).toBeInTheDocument();
    expect(within(view).getByText("好朋友")).toBeInTheDocument();
    expect(within(view).getByText("很好")).toBeInTheDocument();
    expect(within(view).getByText("妳總是記得跟我打招呼。")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一起的回憶" })).toHaveTextContent("小愛喜歡貓");
    expect(screen.getByRole("region", { name: "你點的歌" })).toHaveTextContent("群青");
    expect(within(view).getByRole("heading", { name: "Alice" })).toBeInTheDocument();
  });

  it("sees how much they talked to her and what she did, as charts", async () => {
    core({ member: USER });
    renderApp();
    const talk = await screen.findByRole("region", { name: "你和她說的話" });
    expect(await within(talk).findByText("8")).toBeInTheDocument();
    expect(within(talk).getByText("近 2 天,有 2 天說過話")).toBeInTheDocument();
    const her = await screen.findByRole("region", { name: "她這兩週" });
    expect(await within(her).findByText("7")).toBeInTheDocument();
    await userEvent.click(within(her).getByRole("radio", { name: "直播" }));
    expect(within(her).getByText("3.5")).toBeInTheDocument();
  });

  it("sees what she is doing and today's numbers", async () => {
    core({ member: USER });
    renderApp();
    const now = await screen.findByRole("region", { name: "現在" });
    expect(await within(now).findByText("她在唱歌")).toBeInTheDocument();
    expect(within(now).getByText("3 首")).toBeInTheDocument();
    const songs = screen.getByRole("region", { name: "歌單" });
    expect(await within(songs).findByText("歌名還不知道")).toBeInTheDocument();
  });

  it("never touches an admin route", async () => {
    const { fn } = core({ member: USER });
    renderApp();
    await screen.findByRole("region", { name: "她眼中的你" });
    const seen = new Set(paths(fn));
    seen.delete("/api/auth/session");
    seen.delete("/api/auth/methods");
    expect([...seen].filter((p) => !/^\/api\/(public|member)\//.test(p))).toEqual([]);
  });

  it("links to their data", async () => {
    core({ member: USER });
    renderApp();
    const link = await screen.findByRole("link", { name: "下載我的資料" });
    expect(link).toHaveAttribute("href", "/api/member/export");
  });

  it("is asked before forgetting, and told what stays", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "請她忘記我" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("不會刪除:聊天紀錄");
    expect(posts).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "全部忘記" }));
    await waitFor(() => {
      expect(posts).toEqual([{ path: "/api/member/forget", body: { confirm: true } }]);
    });
    expect(await screen.findByText("已讓她忘記關於你的 2 件事")).toBeInTheDocument();
  });

  it("can back out of forgetting", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "請她忘記我" }));
    await userEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posts).toEqual([]);
  });

  it("requests a song with nothing but the query", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.type(await screen.findByLabelText("歌名或 YouTube / bilibili 連結"), "群青");
    await userEvent.click(screen.getByRole("button", { name: "點歌" }));
    await waitFor(() => {
      expect(posts).toEqual([{ path: "/api/member/songs", body: { query: "群青" } }]);
    });
  });

  it("logs out to the public page", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "登出" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/auth/logout"));
  });
});

describe("someone she has nothing to show for", () => {
  it("sees the normal page, with one plain line and no form", async () => {
    core({ member: USER, me: STRANGER });
    renderApp();
    const view = await screen.findByRole("region", { name: "她眼中的你" });
    expect(await within(view).findByText("她還不認識你")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一起的回憶" })).toHaveTextContent("還沒有一起的回憶");
    expect(screen.queryByLabelText("歌名或 YouTube / bilibili 連結")).toBeNull();
    expect(document.body.textContent).not.toMatch(/封鎖|blocked/i);
  });
});

describe("an admin", () => {
  it("still gets the admin panel, not the public site", async () => {
    core({
      session: { method: "token", user: null, permissions: { write: true } },
    });
    writeStorage(STORAGE_TOKEN, "t0ken");
    renderApp();
    await waitFor(() => expect(screen.queryByRole("region", { name: "歌單" })).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-slot="stage"]')).not.toBeNull());
  });
  it("as a Discord admin, has a page of their own at /me and a way back", async () => {
    core({
      session: { method: "discord", user: { id: "1", name: "Alice", avatar_url: null }, permissions: { write: true } },
      member: USER,
    });
    window.history.replaceState(null, "", "/me");
    renderApp();
    expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "回到管理面板" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "她眼中的你" })).toBeNull());
  });
});

describe("a card she gives", () => {
  it("is on their page, and they can draw a new one", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(section).findByRole("img", { name: /MYR-AB12-CD34-EF56/ })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: /抽一張新卡/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/card"));
    expect(posts.find((p) => p.path === "/api/member/card")?.body).toEqual({});
    expect(await within(section).findByRole("img", { name: /MYR-NEW0-0000-0002/ })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "下載" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "分享" })).toBeInTheDocument();
    // The new card's digital face is a link away, the same page its code leads to.
    const open = within(section).getByRole("link", { name: "打開數位卡面" });
    expect(open.getAttribute("href")).toContain("/card/MYR-NEW0-0000-0002");
    expect(open.getAttribute("href")).not.toContain("#");
    expect(open.getAttribute("target")).toBe("_blank");
  });

  const OFFERS = {
    poses: [
      { id: "blush", label: "害羞臉紅" },
      { id: "hand", label: "揮手" },
    ],
    prices: { pose: 20, foil: 50, reroll: 30 },
    rerolls_left: 2,
  };

  it("lets them pay for a picture and a foil finish, with a key for the charge", async () => {
    const { posts, keys } = core({ member: USER, cardInfo: OFFERS });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    await userEvent.click(await within(section).findByRole("button", { name: "揮手" }));
    await userEvent.click(within(section).getByRole("button", { name: "閃卡" }));
    expect(within(section).getByRole("button", { name: /抽一張新卡.*70/ })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: /抽一張新卡/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/card"));
    expect(posts.find((p) => p.path === "/api/member/card")?.body).toEqual({ pose: "hand", foil: true });
    expect(keys.at(-1)).toBeTruthy();
    expect(await within(section).findByRole("img", { name: /MYR-NEW0-0000-0002.*閃卡|閃卡.*MYR-NEW0-0000-0002/ })).toBeInTheDocument();
  });

  it("offers a reroll of today's card with its price and what is left", async () => {
    const { posts, keys } = core({ member: USER, cardInfo: OFFERS });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    await userEvent.click(await within(section).findByRole("button", { name: /重抽這張.*30.*2 次/ }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重抽" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/card/reroll"));
    expect(keys.at(-1)).toBeTruthy();
    expect(await within(section).findByRole("img", { name: /MYR-RR00-0000-0003/ })).toBeInTheDocument();
  });

  it("has no reroll or extras to offer when none is on sale", async () => {
    core({ member: USER, cardInfo: { poses: OFFERS.poses, prices: { pose: null, foil: null, reroll: null }, rerolls_left: 0 } });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    await within(section).findByRole("button", { name: /抽一張新卡/ });
    expect(within(section).queryByRole("button", { name: "閃卡" })).toBeNull();
    expect(within(section).queryByRole("button", { name: /重抽/ })).toBeNull();
  });

  it("says a rerolled card's code is void", async () => {
    core({ checked: { ...CARD, voided_at: "2026-11-08T05:00:00Z" } });
    window.history.replaceState(null, "", `/card/${CARD.serial}`);
    renderApp();
    expect(await screen.findByText("這張卡已作廢")).toBeInTheDocument();
    expect(screen.queryByText("這張卡是真的")).toBeNull();
  });

  it("says plainly when there is none yet", async () => {
    core({ member: USER, noCard: true });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    expect(await within(section).findByText("還沒有卡,抽一張看看她怎麼看你")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "下載" })).toBeNull();
  });

  it("can be checked by anyone from its code, without logging in", async () => {
    const { fn } = core();
    window.history.replaceState(null, "", `/card/${CARD.serial}`);
    renderApp();
    expect(await screen.findByText("這張卡是真的")).toBeInTheDocument();
    expect(screen.getByText(/發給 Alice 的第 1 張卡/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /好朋友/ })).toBeInTheDocument();
    expect(paths(fn)).toContain(`/api/public/card/${CARD.serial}`);
    expect(screen.queryByRole("link", { name: "使用 Discord 登入" })).toBeNull();
  });

  it("shows the card to turn in the light, with what it says beside it", async () => {
    core({ checked: { ...CARD, frame: "gold", foil: true } });
    window.history.replaceState(null, "", `/card/${CARD.serial}`);
    const { container } = renderApp();
    const info = await screen.findByRole("region", { name: "卡片資訊" });
    expect(within(info).getByText("金框 · 閃卡")).toBeInTheDocument();
    expect(within(info).getByText(CARD.serial)).toBeInTheDocument();
    expect(within(info).getByRole("button", { name: "下載圖片" })).toBeInTheDocument();
    expect(within(info).getByRole("button", { name: "複製連結" })).toBeInTheDocument();
    // Foil and a lit frame each put their light over the card; the plain card has only the glare.
    expect(container.querySelector(".holo-foil")).not.toBeNull();
    expect(container.querySelector(".holo-band-gold")).not.toBeNull();
    expect(container.querySelector(".holo-glare")).not.toBeNull();
  });

  it("says a made-up or revoked code is not a card", async () => {
    core();
    window.history.replaceState(null, "", "/card/MYR-0000-0000-0000");
    renderApp();
    expect(await screen.findByText("這張卡不存在或已經作廢")).toBeInTheDocument();
  });
});
describe("the wallet", () => {
  it("shows the balance, today, her hunger and the earning lines", async () => {
    core({ member: USER });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    expect(await within(wallet).findByText("128")).toBeInTheDocument();
    expect(within(wallet).getByText("魚幣")).toBeInTheDocument();
    expect(within(wallet).getByText("今天 +20")).toBeInTheDocument();
    expect(within(wallet).getByText("她現在:有點餓")).toBeInTheDocument();
    expect(within(wallet).getByText("連續簽到 3 天")).toBeInTheDocument();
    const earn = await screen.findByRole("region", { name: "怎麼賺" });
    expect(within(earn).getByText("每日簽到")).toBeInTheDocument();
    expect(within(earn).getByText("4 / 20")).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "最近" });
    expect(within(recent).getByText("餵了一碗白飯")).toBeInTheDocument();
    expect(within(recent).getByText("−10")).toBeInTheDocument();
  });

  it("checks in with an empty body, then cannot again today", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    await userEvent.click(await within(wallet).findByRole("button", { name: /簽到/ }));
    await waitFor(() => expect(posts.find((p) => p.path === "/api/member/checkin")?.body).toEqual({}));
    expect(await within(wallet).findByText("138")).toBeInTheDocument();
    expect(within(wallet).getByRole("button", { name: "今天已簽到" })).toBeDisabled();
    expect(within(wallet).getByText("連續簽到 4 天")).toBeInTheDocument();
  });

  it("feeds her with the item, a count and a fresh Idempotency-Key each click", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    await userEvent.click(await within(wallet).findByRole("button", { name: /一碗白飯/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/feed"));
    expect(posts.find((p) => p.path === "/api/member/feed")?.body).toEqual({ item: "rice", count: 1 });
    expect(await screen.findByText("她吃得很開心")).toBeInTheDocument();
    expect(await within(wallet).findByText("118")).toBeInTheDocument();
    await userEvent.click(within(wallet).getByRole("button", { name: /鋼盆/ }));
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/feed")).toHaveLength(2));
    const sent = keys.filter((_, i) => posts[i]?.path === "/api/member/feed");
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBeTruthy();
    expect(sent[0]).not.toBe(sent[1]);
  });

  it("shows her refusal as a plain notice and keeps the balance", async () => {
    core({
      member: USER,
      feed: { body: { accepted: false, eaten: 0, charged: 0, balance: 128, message: "她吃飽了,先不用" } },
    });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    await userEvent.click(await within(wallet).findByRole("button", { name: /甜點/ }));
    expect(await screen.findByText("她吃飽了,先不用")).toBeInTheDocument();
    expect(within(wallet).getByText("128")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a stranger one plain line, with no buttons and no shop", async () => {
    core({
      member: USER,
      wallet: { ...WALLET, can_earn: false, balance: 0, hungry: null, earn: [], shop: [], recent: [] },
    });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    expect(await within(wallet).findByText("她還不認識你,先和她說說話吧")).toBeInTheDocument();
    expect(within(wallet).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region", { name: "商店" })).toBeNull();
    expect(screen.queryByRole("region", { name: "怎麼賺" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/封鎖|blocked/i);
  });

  it("says an older Core has no wallet, and the rest of the page still works", async () => {
    core({ member: USER, wallet: null });
    renderApp();
    const wallet = await screen.findByRole("region", { name: "錢包" });
    expect(await within(wallet).findByText("這個 Core 還沒有錢包")).toBeInTheDocument();
    expect(within(wallet).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region", { name: "商店" })).toBeNull();
    expect(await screen.findByRole("region", { name: "她給你的卡" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一起的回憶" })).toBeInTheDocument();
  });
});

describe("the shop", () => {
  it("counts a letter to 120, then posts it", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    const box = await within(shop).findByLabelText("寫信給她");
    const send = within(shop).getByRole("button", { name: /寄出/ });
    expect(send).toBeDisabled();
    expect(within(shop).getByText("0/120")).toBeInTheDocument();
    await userEvent.type(box, "謝謝妳");
    expect(within(shop).getByText("3/120")).toBeInTheDocument();
    await userEvent.click(box);
    await userEvent.paste("字".repeat(118));
    expect(within(shop).getByText("121/120")).toBeInTheDocument();
    expect(send).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "謝謝妳");
    await userEvent.click(send);
    await waitFor(() =>
      expect(posts.find((p) => p.path === "/api/member/letter")?.body).toEqual({ text: "謝謝妳" }),
    );
    expect(keys.at(-1)).toBeTruthy();
    expect(await screen.findByText("信寄出了")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("lists the expressions and says why one is not available", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    expect(within(shop).getByText("直播還沒開")).toBeInTheDocument();
    expect(await within(shop).findByRole("button", { name: "送出 臉紅" })).toBeDisabled();
    await userEvent.click(within(shop).getByRole("button", { name: "送出 愛心眼" }));
    await waitFor(() =>
      expect(posts.find((p) => p.path === "/api/member/expression")?.body).toEqual({ expression: "heart" }),
    );
  });

  it("buys a frame after asking, and selects an owned one", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    expect(await within(shop).findByText("已擁有")).toBeInTheDocument();
    await userEvent.click(within(shop).getByRole("button", { name: "購買 深海" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(posts.filter((p) => p.path === "/api/member/frame")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "購買" }));
    const frames = () => posts.filter((p) => p.path === "/api/member/frame");
    await waitFor(() => expect(frames()[0]?.body).toEqual({ buy: "abyss" }));
    await userEvent.click(await within(shop).findByRole("button", { name: "使用 深海" }));
    await waitFor(() => expect(frames()[1]?.body).toEqual({ select: "abyss" }));
    expect(await within(shop).findByText("使用中")).toBeInTheDocument();
    await userEvent.click(within(shop).getByRole("button", { name: "卸下 深海" }));
    await waitFor(() => expect(frames()[2]?.body).toEqual({ select: null }));
  });
});

describe("foil cards", () => {
  it("draws the foil layer only on a foil card", () => {
    const draw = (foil: boolean) => {
      const { container, unmount } = render(
        <CardFace card={{ ...CARD, foil }} art={null} avatar={null} colors={{ primary: "#f29dc4", secondary: "#7355e8" }} verifyUrl="https://x.test/card/1" />,
      );
      const markup = container.innerHTML;
      unmount();
      return markup;
    };
    expect(draw(true)).toContain("myr-foil-glint");
    expect(draw(false)).not.toContain("myr-foil-glint");
  });
});

describe("card frames", () => {
  it("draws its own border for each known frame and the default for others", () => {
    const draw = (frame: string | null | undefined) => {
      const { container, unmount } = render(
        <CardFace
          card={{ ...CARD, frame }}
          art={null}
          avatar={null}
          colors={{ primary: "#f29dc4", secondary: "#7355e8" }}
          verifyUrl="https://x.test/card/1"
        />,
      );
      const markup = container.innerHTML;
      unmount();
      return markup;
    };
    const plain = draw(null);
    const gold = draw("gold");
    expect(new Set([plain, draw("sakura"), draw("abyss"), gold]).size).toBe(4);
    expect(draw("unknown")).toBe(plain);
    expect(draw(undefined)).toBe(plain);
    expect(gold).toContain("#d7a93f");
    // A bought frame is a band with glitter in it, which the plain border is not.
    expect(gold).toContain("glitter-");
    expect(plain).not.toContain("glitter-");
  });
});

describe("the newer places to spend", () => {
  it("sends a screen message with a key, counting to 60", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    const box = await within(shop).findByLabelText("留言上大螢幕");
    const send = within(shop).getByRole("button", { name: /送上螢幕/ });
    expect(send).toBeDisabled();
    await userEvent.click(box);
    await userEvent.paste("字".repeat(61));
    expect(within(shop).getByText("61/60")).toBeInTheDocument();
    expect(send).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "晚安");
    await userEvent.click(send);
    await waitFor(() =>
      expect(posts.find((p) => p.path === "/api/member/screen")?.body).toEqual({ text: "晚安" }),
    );
    expect(keys.at(-1)).toBeTruthy();
    expect(await screen.findByText("已經送上螢幕了")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("tells why a screen message did not go, and keeps the text", async () => {
    core({ member: USER, screen: { status: 409, body: { error: "她現在沒有開台" } } });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    const box = await within(shop).findByLabelText("留言上大螢幕");
    await userEvent.type(box, "晚安");
    await userEvent.click(within(shop).getByRole("button", { name: /送上螢幕/ }));
    expect(await screen.findByText(/她現在沒有開台/)).toBeInTheDocument();
    expect(box).toHaveValue("晚安");
  });

  it("lists the song extras as information for Discord, without a buy button", async () => {
    core({ member: USER });
    renderApp();
    const shop = await screen.findByRole("region", { name: "商店" });
    expect(await within(shop).findByText(/在 Discord 點歌時用/)).toBeInTheDocument();
    expect(within(shop).getByText("歌曲獻詞")).toBeInTheDocument();
    expect(within(shop).queryByRole("button", { name: /歌曲獻詞|點歌加點券/ })).toBeNull();
  });

  it("draws the day's fortune once, then shows the slip", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "今日籤詩" });
    await userEvent.click(await within(section).findByRole("button", { name: /抽籤.*10/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/fortune"));
    expect(posts.find((p) => p.path === "/api/member/fortune")?.body).toEqual({});
    expect(keys.at(-1)).toBeTruthy();
    expect(await within(section).findByRole("button", { name: "下載" })).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /抽籤/ })).toBeNull();
  });

  it("shows a slip already drawn today without offering another", async () => {
    core({ member: USER, slip: true });
    renderApp();
    const section = await screen.findByRole("region", { name: "今日籤詩" });
    expect(await within(section).findByRole("button", { name: "下載" })).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /抽籤/ })).toBeNull();
  });

  it("asks before a transfer and sends it only after the answer", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "轉給朋友" });
    const send = within(section).getByRole("button", { name: "轉出" });
    expect(send).toBeDisabled();
    await userEvent.type(within(section).getByLabelText("對方的 Discord 使用者 ID"), "123456789");
    await userEvent.type(within(section).getByLabelText(/數量/), "51");
    expect(send).toBeDisabled();
    await userEvent.clear(within(section).getByLabelText(/數量/));
    await userEvent.type(within(section).getByLabelText(/數量/), "20");
    await userEvent.click(send);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/123456789/)).toBeInTheDocument();
    expect(posts.filter((p) => p.path === "/api/member/transfer")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "轉出" }));
    await waitFor(() =>
      expect(posts.find((p) => p.path === "/api/member/transfer")?.body).toEqual({
        to_discord_id: "123456789",
        amount: 20,
      }),
    );
    expect(keys.at(-1)).toBeTruthy();
    expect(await screen.findByText(/已轉 20.*Bob/)).toBeInTheDocument();
  });

  it("does not send a transfer when they back out", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "轉給朋友" });
    await userEvent.type(within(section).getByLabelText("對方的 Discord 使用者 ID"), "123456789");
    await userEvent.type(within(section).getByLabelText(/數量/), "5");
    await userEvent.click(within(section).getByRole("button", { name: "轉出" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(posts.filter((p) => p.path === "/api/member/transfer")).toEqual([]);
  });

  it("shows the board and joins or leaves it with one switch", async () => {
    const { posts } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "贊助排行榜" });
    expect(await within(section).findByText("小明")).toBeInTheDocument();
    expect(within(section).getByText(/只顯示你近 30 天/)).toBeInTheDocument();
    const toggle = within(section).getByRole("switch", { name: "上贊助排行榜" });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(posts.find((p) => p.path === "/api/member/board")?.body).toEqual({ on: true }));
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/board")[1]?.body).toEqual({ on: false }));
  });

  it("shows her goal with its progress and pledges to it", async () => {
    const { posts, keys } = core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "她的目標" });
    expect(await within(section).findByText("新的麥克風")).toBeInTheDocument();
    expect(within(section).getByText(/唱一整晚的歌/)).toBeInTheDocument();
    expect(within(section).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "200");
    expect(within(section).getByText("舊的耳機")).toBeInTheDocument();
    await userEvent.type(within(section).getByLabelText("投多少"), "50");
    await userEvent.click(within(section).getByRole("button", { name: "投入" }));
    await waitFor(() =>
      expect(posts.find((p) => p.path === "/api/member/goals/g1/pledge")?.body).toEqual({ amount: 50 }),
    );
    expect(keys.at(-1)).toBeTruthy();
    expect(await within(section).findByText(/你已經投了 50/)).toBeInTheDocument();
  });

  it("lists her open bounties and says she judges them", async () => {
    core({ member: USER });
    renderApp();
    const section = await screen.findByRole("region", { name: "她的懸賞" });
    expect(await within(section).findByText("教她一個新梗")).toBeInTheDocument();
    expect(within(section).getByText(/由她判定/)).toBeInTheDocument();
  });

  it("asks before a reroll voids the old card", async () => {
    const { posts, keys } = core({ member: USER, cardInfo: OFFERS_FOR_REROLL });
    renderApp();
    const section = await screen.findByRole("region", { name: "她給你的卡" });
    await userEvent.click(await within(section).findByRole("button", { name: /重抽這張/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/舊卡會作廢/)).toBeInTheDocument();
    expect(posts.filter((p) => p.path === "/api/member/card/reroll")).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(posts.filter((p) => p.path === "/api/member/card/reroll")).toEqual([]);
    await userEvent.click(within(section).getByRole("button", { name: /重抽這張/ }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "重抽" }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain("/api/member/card/reroll"));
    expect(keys.at(-1)).toBeTruthy();
    expect(await within(section).findByRole("img", { name: /MYR-RR00-0000-0003/ })).toBeInTheDocument();
  });
});
