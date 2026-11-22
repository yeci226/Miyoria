import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EarnReason } from "@/api/types";
import type { EconomyHealth, PredictionView, RoomItem } from "@miyoria/contracts/api";
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
    mockFetch((_m, u) => (u.pathname === "/api/economy/health" ? { body: health() } : undefined));
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
      u.pathname === "/api/economy/health" ? { body: health({ available: false, days: [], week: { issued: 0, recovered: 0, ratio: null } }) } : undefined,
    );
    renderRoute("/economy");
    expect(await screen.findByText(/帳本的資料庫沒有提供每日總數/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "每天的發出與收回" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "這七天回收率" }).closest("section")).toHaveTextContent("—");
  });

  it("shows the inflation warning and what each side counts", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/economy/health" ? { body: health({ warn: "這個禮拜發出去 220,只收回 130,通貨膨脹中" }) } : undefined));
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
    mockFetch((_m, u) => (u.pathname === "/api/economy/health" ? { status: 503, body: { error: "economy module (economy 2.0) is not available" } } : undefined));
    const b = renderRoute("/economy");
    expect(await screen.findByText("經濟(economy 模組)沒有啟動")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/economy/health" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/economy");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("經濟 / 預測、房間", () => {
  it("has empty states for predictions and the room", async () => {
    mockFetch((_m, u) => {
      if (u.pathname === "/api/economy/predictions") return { body: { currency: "魚幣", predictions: [] } };
      if (u.pathname === "/api/economy/room") return { body: { currency: "魚幣", room: [] } };
      return undefined;
    });
    const a = renderRoute("/economy?tab=predictions");
    expect(await screen.findByText("沒有預測")).toBeInTheDocument();
    a.unmount();
    renderRoute("/economy?tab=room");
    expect(await screen.findByText("房間裡還沒有可以集資的東西")).toBeInTheDocument();
  });

  it("shows where the stakes stand and who was right", async () => {
    const open: PredictionView = {
      id: "P1",
      space: null,
      question: "她這場 Minecraft 會怎麼死?",
      options: [
        { label: "岩漿", staked: 300, backers: 3, multiplier: 1.7 },
        { label: "餓死", staked: 100, backers: 1, multiplier: 5.1 },
      ],
      total: 400,
      closes_at: new Date(Date.now() + 3_600_000).toISOString(),
      status: "open",
      winner: null,
      settles: { kind: "her", label: "她公布結果" },
      settled_by: null,
      my_bet: null,
    };
    const done: PredictionView = {
      ...open,
      id: "P0",
      question: "osu 幾分",
      status: "resolved",
      winner: "岩漿",
      options: [{ label: "岩漿", staked: 50, backers: 1, multiplier: 1 }],
      total: 50,
      settled_by: { by: "auto", note: "她做到了目標「蓋房子」", at: "2026-11-08T04:00:00Z", who: null },
    };
    mockFetch((_m, u) => (u.pathname === "/api/economy/predictions" ? { body: { currency: "魚幣", predictions: [open, done] } } : undefined));
    renderRoute("/economy?tab=predictions");
    const list = await screen.findByRole("list", { name: "預測" });
    const first = within(list).getByText("她這場 Minecraft 會怎麼死?").closest("li") as HTMLElement;
    expect(within(first).getByText("可以下注")).toBeInTheDocument();
    expect(first).toHaveTextContent("池 400 魚幣");
    expect(within(first).getByText("岩漿")).toBeInTheDocument();
    const second = within(list).getByText("osu 幾分").closest("li") as HTMLElement;
    expect(within(second).getByText("已結算")).toBeInTheDocument();
    expect(within(second).getByText(/猜中/)).toBeInTheDocument();
    // How each settles, and who settled the one that is done.
    expect(first).toHaveTextContent("她公布結果");
    expect(second).toHaveTextContent("自動結算 · 她做到了目標「蓋房子」");
    expect(within(second).queryByRole("button", { name: /結算為/ })).toBeNull();
  });

  it("asks for one server's predictions with two or more, every server's with one", async () => {
    const asked: string[] = [];
    const spaces = (n: number) =>
      [
        { id: "SA", platform: "discord", external_id: "1", name: "甲服", primary: true, members: 3 },
        { id: "SB", platform: "discord", external_id: "2", name: "乙服", primary: false, members: 2 },
      ].slice(0, n);
    for (const n of [1, 2]) {
      asked.length = 0;
      mockFetch((_m, u) => {
        if (u.pathname === "/api/places/spaces") return { body: { spaces: spaces(n), default: "SA" } };
        if (u.pathname === "/api/economy/predictions") {
          asked.push(u.search);
          return { body: { currency: "魚幣", predictions: [] } };
        }
        return undefined;
      });
      const view = renderRoute("/economy?tab=predictions");
      expect(await screen.findByText("沒有預測")).toBeInTheDocument();
      if (n === 1) {
        expect(asked.every((q) => q === "")).toBe(true);
        expect(screen.queryByText(/的預測:只有那個伺服器的成員/)).toBeNull();
      } else {
        await waitFor(() => expect(asked).toContain("?space=SA"));
        expect(screen.getByText("甲服 的預測:只有那個伺服器的成員看得到、能押。")).toBeInTheDocument();
      }
      view.unmount();
    }
  });

  it("lets the owner settle or call off one still waiting, and says so when the account may not", async () => {
    const waiting: PredictionView = {
      id: "P1",
      space: null,
      question: "這碗湯會被猜中嗎",
      options: [
        { label: "猜中", staked: 30, backers: 1, multiplier: 1.6 },
        { label: "沒猜中", staked: 20, backers: 1, multiplier: 2.4 },
      ],
      total: 50,
      closes_at: new Date(Date.now() - 60_000).toISOString(),
      status: "closed",
      winner: null,
      settles: { kind: "soup", label: "照這碗海龜湯的結果自動結算" },
      settled_by: null,
      my_bet: null,
    };
    const posts: { path: string; body: unknown }[] = [];
    let deny = false;
    mockFetch((m, u, body) => {
      if (m === "POST") {
        posts.push({ path: u.pathname, body });
        if (deny) return { status: 403, body: { error: "forbidden" } };
        const settled = { id: "P1", winner: "猜中", winners: 1, pool: 50, paid: 48, rake: 2, refunded: false };
        return { body: { currency: "魚幣", settled } };
      }
      if (u.pathname === "/api/economy/predictions") return { body: { currency: "魚幣", predictions: [waiting] } };
      return undefined;
    });
    renderRoute("/economy?tab=predictions");
    const list = await screen.findByRole("list", { name: "預測" });
    expect(list).toHaveTextContent("照這碗海龜湯的結果自動結算");
    await userEvent.click(within(list).getByRole("button", { name: "結算為「猜中」" }));
    await userEvent.click(await screen.findByRole("button", { name: "結算" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/api/economy/predictions/P1/resolve", body: { option: "猜中" } }]));
    deny = true;
    await userEvent.click(within(list).getByRole("button", { name: "取消並退回" }));
    await userEvent.click(await screen.findByRole("button", { name: "取消並退回" }));
    await waitFor(() => expect(posts.at(-1)?.path).toBe("/api/economy/predictions/P1/cancel"));
    expect(await screen.findByText(/沒有結算預測的權限/)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "結算為「猜中」" })).toBeDisabled();
  });

  it("shows how far her room is funded", async () => {
    const items: RoomItem[] = [
      { id: "sofa", label: "沙發", kind: "furniture", kind_label: "家具", price: 500, funded: 125, backers: 4, placed: false },
      { id: "bg", label: "星空背景", kind: "background", kind_label: "背景", price: 300, funded: 300, backers: 9, placed: true },
    ];
    mockFetch((_m, u) => (u.pathname === "/api/economy/room" ? { body: { currency: "魚幣", room: items } } : undefined));
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

