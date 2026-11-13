import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EarnReason } from "@/api/types";
import type { EconomyHealth, PredictionView, ReachedGoal, RoomItem } from "@/api/v4-types";
import { mockFetch, renderRoute } from "@/test/render";
import { EARN_REASON_LABEL, ISSUED_REASONS, reasonLabel, RECOVERED_REASONS } from "./labels";

const day = (n: number, issued: number, recovered: number) => ({
  day: 20_400 + n,
  date: new Date(Date.UTC(2026, 10, 1 + n)).toISOString(),
  issued,
  recovered,
  ratio: issued > 0 ? Math.round((recovered / issued) * 100) / 100 : null,
});

const health = (over: Partial<EconomyHealth> = {}): EconomyHealth => ({
  currency: "魚幣",
  available: true,
  days: [day(0, 100, 40), day(1, 120, 90), day(2, 0, 0)],
  week: { issued: 220, recovered: 130, ratio: 0.59 },
  warn: null,
  ...over,
});

describe("經濟 / 健康度", () => {
  it("draws issued against recovered per day with the week's ratio", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/economy2/health" ? { body: health() } : undefined));
    renderRoute("/economy");
    const block = (await screen.findByRole("heading", { name: "這七天回收率" })).closest("section") as HTMLElement;
    expect(block).toHaveTextContent("59%");
    expect(block).toHaveTextContent("發出 220、收回 130 魚幣");
    const sr = screen.getByRole("table", { name: /每天發出與收回的魚幣/ });
    expect(sr).toBeInTheDocument();
    const days = screen.getByRole("table", { name: "每天的發出與收回" });
    const first = within(days).getByText("11/2").closest("tr") as HTMLElement;
    expect(within(first).getByText("75%")).toBeInTheDocument();
    // A day nothing was issued has no ratio, not 0%.
    expect(within(within(days).getByText("11/3").closest("tr") as HTMLElement).getByText("—")).toBeInTheDocument();
  });

  it("says why there is no chart while no store provides the totals", async () => {
    mockFetch((_m, u) =>
      u.pathname === "/api/economy2/health" ? { body: health({ available: false, days: [], week: { issued: 0, recovered: 0, ratio: null } }) } : undefined,
    );
    renderRoute("/economy");
    expect(await screen.findByText(/帳本的資料庫沒有提供每日總數/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "每天的發出與收回" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "這七天回收率" }).closest("section")).toHaveTextContent("—");
  });

  it("shows the inflation warning and what each side counts", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/economy2/health" ? { body: health({ warn: "這個禮拜發出去 220,只收回 130,通貨膨脹中" }) } : undefined));
    renderRoute("/economy");
    expect(await screen.findByRole("alert")).toHaveTextContent("通貨膨脹中");
    const how = screen.getByLabelText("怎麼算");
    expect(how).toHaveTextContent("每日任務");
    expect(how).toHaveTextContent("抽收藏");
  });

  it("has loading, module-off and error states", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const a = renderRoute("/economy");
    expect((await screen.findAllByLabelText("載入中")).length).toBeGreaterThan(0);
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/economy2/health" ? { status: 503, body: { error: "economy module (economy 2.0) is not available" } } : undefined));
    const b = renderRoute("/economy");
    expect(await screen.findByText("經濟(economy 模組)沒有啟動")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/economy2/health" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/economy");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("經濟 / 委託、預測、房間", () => {
  it("lists the commissions that wait for her", async () => {
    mockFetch((_m, u) =>
      u.pathname === "/api/economy2/commissions"
        ? {
            body: {
              currency: "魚幣",
              commissions: [
                { id: "C1", kind: "poem", label: "寫詩", brief: "寫一首關於下雨的詩", price: 80, status: "open", created_at: new Date().toISOString(), due_at: new Date(Date.now() + 86_400_000).toISOString(), result: null, note: null },
              ],
            },
          }
        : undefined,
    );
    renderRoute("/economy?tab=commissions");
    const table = await screen.findByRole("table", { name: "委託" });
    const row = within(table).getByText("寫一首關於下雨的詩").closest("tr") as HTMLElement;
    expect(within(row).getByText("寫詩")).toBeInTheDocument();
    expect(row).toHaveTextContent("80 魚幣");
  });

  it("has empty states for commissions, predictions and the room", async () => {
    mockFetch((_m, u) => {
      if (u.pathname === "/api/economy2/commissions") return { body: { currency: "魚幣", commissions: [] } };
      if (u.pathname === "/api/economy2/predictions") return { body: { currency: "魚幣", predictions: [] } };
      if (u.pathname === "/api/economy2/room") return { body: { currency: "魚幣", room: [] } };
      return undefined;
    });
    const a = renderRoute("/economy?tab=commissions");
    expect(await screen.findByText("沒有等她做的委託")).toBeInTheDocument();
    a.unmount();
    const b = renderRoute("/economy?tab=predictions");
    expect(await screen.findByText("沒有預測")).toBeInTheDocument();
    b.unmount();
    renderRoute("/economy?tab=room");
    expect(await screen.findByText("房間裡還沒有可以集資的東西")).toBeInTheDocument();
  });

  it("shows where the stakes stand and who was right", async () => {
    const open: PredictionView = {
      id: "P1",
      question: "她這場 Minecraft 會怎麼死?",
      options: [
        { label: "岩漿", staked: 300, backers: 3, multiplier: 1.7 },
        { label: "餓死", staked: 100, backers: 1, multiplier: 5.1 },
      ],
      total: 400,
      closes_at: new Date(Date.now() + 3_600_000).toISOString(),
      status: "open",
      winner: null,
    };
    const done: PredictionView = { ...open, id: "P0", question: "osu 幾分", status: "resolved", winner: "岩漿", options: [{ label: "岩漿", staked: 50, backers: 1, multiplier: 1 }], total: 50 };
    mockFetch((_m, u) => (u.pathname === "/api/economy2/predictions" ? { body: { currency: "魚幣", predictions: [open, done] } } : undefined));
    renderRoute("/economy?tab=predictions");
    const list = await screen.findByRole("list", { name: "預測" });
    const first = within(list).getByText("她這場 Minecraft 會怎麼死?").closest("li") as HTMLElement;
    expect(within(first).getByText("可以下注")).toBeInTheDocument();
    expect(first).toHaveTextContent("池 400 魚幣");
    expect(within(first).getByText("岩漿")).toBeInTheDocument();
    const second = within(list).getByText("osu 幾分").closest("li") as HTMLElement;
    expect(within(second).getByText("已結算")).toBeInTheDocument();
    expect(within(second).getByText(/猜中/)).toBeInTheDocument();
  });

  it("shows how far her room is funded", async () => {
    const items: RoomItem[] = [
      { id: "sofa", label: "沙發", kind: "furniture", kind_label: "家具", price: 500, funded: 125, backers: 4, placed: false },
      { id: "bg", label: "星空背景", kind: "background", kind_label: "背景", price: 300, funded: 300, backers: 9, placed: true },
    ];
    mockFetch((_m, u) => (u.pathname === "/api/economy2/room" ? { body: { currency: "魚幣", room: items } } : undefined));
    renderRoute("/economy?tab=room");
    const table = await screen.findByRole("table", { name: "房間的東西" });
    const sofa = within(table).getByText("沙發").closest("tr") as HTMLElement;
    expect(sofa).toHaveTextContent("125 / 500 魚幣");
    expect(within(sofa).getByRole("meter", { name: "沙發 的集資" })).toHaveAttribute("aria-valuenow", "0.25");
    expect(within(sofa).getByText("集資中")).toBeInTheDocument();
    expect(within(within(table).getByText("星空背景").closest("tr") as HTMLElement).getByText("已擺上")).toBeInTheDocument();
  });
});

describe("ledger reason labels", () => {
  it("know the reasons economy 2.0 added, next to the original five", () => {
    const original: EarnReason[] = ["checkin", "talked", "voice", "song", "her_gift"];
    for (const r of original) expect(EARN_REASON_LABEL[r]).toBeTruthy();
    expect(reasonLabel("quest")).toBe("每日任務");
    expect(reasonLabel("play")).toBe("一起玩");
    expect(reasonLabel("achievement")).toBe("達成成就");
    expect(reasonLabel("bet_win")).toBe("預測猜中了");
    expect(reasonLabel("commission_pay")).toBe("委託做完了");
    expect(reasonLabel("something_new")).toBe("something_new");
  });

  it("name every reason the health table counts", () => {
    for (const r of [...ISSUED_REASONS, ...RECOVERED_REASONS]) expect(reasonLabel(r), r).not.toBe(r);
  });
});

const reached = (over: Partial<ReachedGoal> = {}): ReachedGoal => ({
  id: "g1",
  title: "新麥克風",
  promise: "學三種貓叫",
  target: 50,
  reached_at: "2026-11-10T00:00:00.000Z",
  fulfilled_at: null,
  fulfilled_by: null,
  ...over,
});

describe("經濟 / 目標", () => {
  it("lists the filled goals and marks one kept after a confirmation", async () => {
    const user = userEvent.setup();
    let goals = [reached(), reached({ id: "g0", title: "唱歌", fulfilled_at: "2026-11-09T00:00:00.000Z", fulfilled_by: "self" })];
    const fetch = mockFetch((m, u) => {
      if (u.pathname === "/api/economy/goals" && m === "GET") return { body: { goals } };
      if (u.pathname === "/api/economy/goals/g1/fulfill" && m === "POST") {
        goals = goals.map((g) => (g.id === "g1" ? { ...g, fulfilled_at: "2026-11-12T00:00:00.000Z", fulfilled_by: "owner" } : g));
        return { body: { goal: goals[0] } };
      }
      return undefined;
    });
    renderRoute("/economy?tab=goals");
    const table = await screen.findByRole("table", { name: "湊滿的目標" });
    expect(screen.getByText("1 個還沒做到")).toBeInTheDocument();
    const kept = within(table).getByText("唱歌").closest("tr") as HTMLElement;
    expect(within(kept).getByText("做到了")).toBeInTheDocument();
    expect(within(kept).getByText(/她自己說做到了/)).toBeInTheDocument();
    const owed = within(table).getByText("新麥克風").closest("tr") as HTMLElement;
    await user.click(within(owed).getByRole("button", { name: "記成做到了" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("學三種貓叫");
    await user.click(within(dialog).getByRole("button", { name: "記成做到了" }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u, init]) => String(u).endsWith("/api/economy/goals/g1/fulfill") && init?.method === "POST")).toBe(true),
    );
    await waitFor(() => expect(within(screen.getByRole("table", { name: "湊滿的目標" })).getByText(/主人記的/)).toBeInTheDocument());
  });

  it("keeps the button disabled for a read-only account, and has an empty state", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/economy/goals" ? { body: { goals: [reached()] } } : undefined));
    renderRoute("/economy?tab=goals", { session: { session: { method: "token", user: null, permissions: { write: false } }, logout: () => {} } });
    expect(await screen.findByRole("button", { name: "記成做到了" })).toBeDisabled();
  });

  it("says when no goal was filled yet", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/economy/goals" ? { body: { goals: [] } } : undefined));
    renderRoute("/economy?tab=goals");
    expect(await screen.findByText("還沒有湊滿的目標")).toBeInTheDocument();
  });
});
