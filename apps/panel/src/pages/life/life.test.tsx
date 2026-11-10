import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ActivityView, LifeDayView, ReminderView, SkillView, WorkspaceView } from "@/api/v4-types";
import { mockFetch, renderRoute } from "@/test/render";
import { dayColumns } from "./TodayTab";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const reminder = (over: Partial<ReminderView> = {}): ReminderView => ({
  id: "r1",
  key: "R7XK2P",
  what: "問 Owen 考試考得怎樣",
  due: iso(NOW + 3_600_000),
  daily: false,
  context: null,
  person: "Owen",
  for_account: null,
  fired: 0,
  created_at: iso(NOW - 60_000),
  ...over,
});

const day = (over: Partial<LifeDayView> = {}): LifeDayView => ({
  today: [
    { id: "a", activity: "browse", what: "查了 Minecraft 1.22 的新生物", at: iso(NOW - 600_000), minutes: null, capability: "web.search" },
    { id: "b", activity: "code", what: "寫了一個猜數字的小工具", at: iso(NOW - 300_000), minutes: 25, capability: "workspace.write" },
  ],
  lately: [
    { id: "o", activity: "diary", what: "寫了日記", at: iso(NOW - 2 * 86_400_000), minutes: 15, capability: "diary.write" },
    { id: "a", activity: "browse", what: "查了 Minecraft 1.22 的新生物", at: iso(NOW - 600_000), minutes: null, capability: "web.search" },
    { id: "b", activity: "code", what: "寫了一個猜數字的小工具", at: iso(NOW - 300_000), minutes: 25, capability: "workspace.write" },
  ],
  summary_today: "今天上網查了新生物,還寫了小工具",
  summary_lately: null,
  ...over,
});

const act = (over: Partial<ActivityView>): ActivityView => ({
  id: "browse",
  label: "逛網路",
  does: "查有興趣的東西",
  leaves: "筆記",
  people: "any",
  hours: null,
  per_day: null,
  share: 0.3,
  generic: true,
  capabilities: [{ id: "web.search", registered: true }],
  capability: "web.search",
  available: true,
  done_today: 2,
  ...over,
});

const off = { status: 503, body: { error: "mind module (her timers) is not available" } };

describe("生活 / 今天", () => {
  it("shows what she did today, the week as a chart and what she remembers", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/life/today" ? { body: day() } : undefined));
    renderRoute("/life");
    const today = await screen.findByRole("table", { name: "今天做的事" });
    expect(within(today).getByText("查了 Minecraft 1.22 的新生物")).toBeInTheDocument();
    const code = within(today).getByText("寫了一個猜數字的小工具").closest("tr") as HTMLElement;
    expect(within(code).getByText("25 分鐘")).toBeInTheDocument();
    const strip = screen.getByLabelText("今天", { selector: "dl" });
    expect(strip).toHaveTextContent("做了2 件");
    expect(strip).toHaveTextContent("花的時間25 分鐘");
    expect(screen.getByText("最近七天做的事")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "每天做的事" })).toBeInTheDocument();
    expect(screen.getByText("今天上網查了新生物,還寫了小工具")).toBeInTheDocument();
  });

  it("says plainly when there is nothing", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/life/today" ? { body: day({ today: [], lately: [], summary_today: null }) } : undefined));
    renderRoute("/life");
    expect(await screen.findByText("今天還沒做任何事")).toBeInTheDocument();
    expect(screen.getByText("這幾天沒有紀錄")).toBeInTheDocument();
  });

  it("reads as module off on a 503 and as an error on a 500", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/life/today" ? { status: 503, body: { error: "mind module (her life log) is not available" } } : undefined));
    const first = renderRoute("/life");
    expect(await screen.findByText("她的生活(mind 模組)沒有啟動")).toBeInTheDocument();
    first.unmount();
    mockFetch((_m, url) => (url.pathname === "/api/life/today" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/life");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("shows the loading state first", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    renderRoute("/life");
    expect((await screen.findAllByLabelText("載入中")).length).toBeGreaterThan(0);
  });

  it("buckets the last days by local day with the most common activities named", () => {
    const entries = day().lately;
    const { columns, series } = dayColumns(entries, NOW, 7);
    expect(columns).toHaveLength(7);
    expect(series.map((s) => s.key).sort()).toEqual(["browse", "code", "diary"]);
    const total = columns.reduce((n, c) => n + Object.values(c.values).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(3);
    expect(Object.values(columns[6]?.values ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("生活 / 提醒", () => {
  const url = "/life?tab=reminders";

  it("lists the timers with who they are for and when they are due", async () => {
    mockFetch((_m, u) =>
      u.pathname === "/api/life/reminders"
        ? { body: { reminders: [reminder(), reminder({ id: "r2", key: "R9", what: "看一下烤箱", person: null, daily: true, due: iso(NOW - 120_000) })] } }
        : undefined,
    );
    renderRoute(url);
    const table = await screen.findByRole("table", { name: "提醒" });
    const first = within(table).getByText("問 Owen 考試考得怎樣").closest("tr") as HTMLElement;
    expect(within(first).getByText("Owen")).toBeInTheDocument();
    expect(within(first).getByText("一次")).toBeInTheDocument();
    const second = within(table).getByText("看一下烤箱").closest("tr") as HTMLElement;
    expect(within(second).getByText("她自己")).toBeInTheDocument();
    expect(within(second).getByText("每天")).toBeInTheDocument();
  });

  it("cancels one after a confirmation", async () => {
    const user = userEvent.setup();
    let open = [reminder()];
    const fetch = mockFetch((m, u) => {
      if (u.pathname === "/api/life/reminders" && m === "GET") return { body: { reminders: open } };
      if (u.pathname === "/api/life/reminders/R7XK2P" && m === "DELETE") {
        open = [];
        return { body: { cancelled: true, key: "R7XK2P" } };
      }
      return undefined;
    });
    renderRoute(url);
    await screen.findByRole("table", { name: "提醒" });
    await user.click(screen.getByRole("button", { name: "提醒 R7XK2P 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "取消提醒" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("問 Owen 考試考得怎樣");
    await user.click(within(dialog).getByRole("button", { name: "取消提醒" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, init]) => String(u).endsWith("/api/life/reminders/R7XK2P") && init?.method === "DELETE")).toBe(true));
    expect(await screen.findByText("沒有還沒到的提醒")).toBeInTheDocument();
  });

  it("disables cancel for a read-only account", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/life/reminders" ? { body: { reminders: [reminder()] } } : undefined));
    renderRoute(url, { session: { session: { method: "token", user: null, permissions: { write: false } }, logout: () => {} } });
    expect(await screen.findByRole("button", { name: "提醒 R7XK2P 的動作" })).toBeDisabled();
  });

  it("has empty and module-off states", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/life/reminders" ? { body: { reminders: [] } } : undefined));
    const first = renderRoute(url);
    expect(await screen.findByText("沒有還沒到的提醒")).toBeInTheDocument();
    first.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/life/reminders" ? off : undefined));
    renderRoute(url);
    expect(await screen.findByText("提醒(mind 模組)沒有啟動")).toBeInTheDocument();
  });
});

describe("生活 / 能做的事", () => {
  it("marks the activities skipped because their capability is missing", async () => {
    mockFetch((_m, u) =>
      u.pathname === "/api/life/activities"
        ? {
            body: {
              activities: [
                act({}),
                act({ id: "diary", label: "寫日記", capabilities: [{ id: "diary.write", registered: false }], capability: null, available: false, done_today: 0 }),
                act({ id: "care", label: "關心人", generic: false, capabilities: [{ id: "chat.start", registered: true }], capability: "chat.start" }),
              ],
            },
          }
        : undefined,
    );
    renderRoute("/life?tab=activities");
    const table = await screen.findByRole("table", { name: "活動" });
    const browse = within(table).getByText("逛網路").closest("tr") as HTMLElement;
    expect(within(browse).getByText("可以做")).toBeInTheDocument();
    const diary = within(table).getByText("寫日記").closest("tr") as HTMLElement;
    expect(within(diary).getByText("功能沒開,略過")).toBeInTheDocument();
    expect(within(diary).getByText("沒有")).toBeInTheDocument();
    const care = within(table).getByText("關心人").closest("tr") as HTMLElement;
    expect(within(care).getByText("只記錄")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "活動的狀態" })).toHaveTextContent("功能沒開,略過1");
  });

  it("says when the module is off", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/life/activities" ? off : undefined));
    renderRoute("/life?tab=activities");
    expect(await screen.findByText("她的生活(mind 模組)沒有啟動")).toBeInTheDocument();
  });
});

const SKILL: SkillView = {
  name: "fishing",
  description: "釣魚的順序",
  body: "先看天氣。\n再選餌。",
  truncated: false,
  files: [
    { path: "skills/fishing/cast.py", size: 14, script: "approved" },
    { path: "skills/fishing/stray.py", size: 11, script: "unapproved" },
  ],
};

describe("生活 / 技能與工作區", () => {
  it("lists the skills and opens one with its files", async () => {
    const user = userEvent.setup();
    mockFetch((_m, u) => {
      if (u.pathname === "/api/skills") return { body: { skills: [{ name: "fishing", description: "釣魚的順序" }, { name: "raw", description: "(沒有說明)" }] } };
      if (u.pathname === "/api/skills/fishing") return { body: SKILL };
      if (u.pathname === "/api/skills/raw") return { body: { ...SKILL, name: "raw", description: "(沒有說明)", body: "沒有說明行", files: [] } };
      return undefined;
    });
    renderRoute("/life?tab=skills");
    const article = await screen.findByRole("article", { name: "技能 fishing" });
    expect(article).toHaveTextContent("先看天氣。");
    expect(within(article).getByText("審過,能執行")).toBeInTheDocument();
    expect(within(article).getByText("沒審過,不會執行")).toBeInTheDocument();
    await user.click(within(screen.getByRole("list", { name: "技能索引" })).getByRole("button", { name: /raw/ }));
    expect(await screen.findByRole("article", { name: "技能 raw" })).toHaveTextContent("沒有說明行");
  });

  it("has empty and workspace-off states", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/skills" ? { body: { skills: [] } } : undefined));
    const first = renderRoute("/life?tab=skills");
    expect(await screen.findByText("她還沒有技能")).toBeInTheDocument();
    first.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/skills" ? { status: 503, body: { error: "her workspace is turned off" } } : undefined));
    renderRoute("/life?tab=skills");
    expect(await screen.findByText("技能(sandbox 模組的工作區)沒有啟動")).toBeInTheDocument();
    expect(screen.getByText(/her workspace is turned off/)).toBeInTheDocument();
  });

  it("shows the files with sizes, how full the workspace is, and filters", async () => {
    const user = userEvent.setup();
    const ws: WorkspaceView = {
      files: [
        { path: "notes/a.txt", size: 5 },
        { path: "skills/fishing/SKILL.md", size: 2048 },
      ],
      truncated: false,
      usage: { files: 2, bytes: 2053, overflow: false },
      limits: { max_bytes: 1_048_576, max_files: 100, max_file_bytes: 65_536 },
    };
    mockFetch((_m, u) => (u.pathname === "/api/workspace" ? { body: ws } : undefined));
    renderRoute("/life?tab=workspace");
    const table = await screen.findByRole("table", { name: "工作區的檔案" });
    const row = within(table).getByText("skills/fishing/SKILL.md").closest("tr") as HTMLElement;
    expect(within(row).getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "檔案數" })).toHaveAttribute("aria-valuenow", "0.02");
    await user.type(screen.getByRole("searchbox", { name: "找檔案" }), "zzz");
    expect(await screen.findByText("沒有符合的檔案")).toBeInTheDocument();
  });

  it("says when the workspace is empty", async () => {
    mockFetch((_m, u) =>
      u.pathname === "/api/workspace"
        ? { body: { files: [], truncated: false, usage: { files: 0, bytes: 0, overflow: false }, limits: { max_bytes: 100, max_files: 10, max_file_bytes: 10 } } }
        : undefined,
    );
    renderRoute("/life?tab=workspace");
    expect(await screen.findByText("工作區是空的")).toBeInTheDocument();
  });
});
