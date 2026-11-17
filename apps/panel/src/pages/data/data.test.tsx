import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataCategoryView, DataInventoryView } from "@miyoria/contracts/api";
import type { SessionValue } from "@/app/session";
import { mockFetch, renderRoute } from "@/test/render";

const cat = (id: DataCategoryView["id"], over: Partial<DataCategoryView> = {}): DataCategoryView => ({
  id,
  count: 0,
  updated_at: null,
  parts: [],
  breakdown: null,
  shared: false,
  kept: false,
  exportable: true,
  confirm: "typed",
  requires: [],
  ...over,
});

const INVENTORY: DataInventoryView = {
  profile: "deepseek-chan",
  at: "2026-11-02T12:00:00.000Z",
  can_manage: true,
  categories: [
    cat("memories", { count: 8, breakdown: { fact: 3, episode: 5 }, updated_at: "2026-11-02T11:00:00.000Z" }),
    cat("relationships", { count: 4 }),
    cat("inner", { count: 2 }),
    cat("decisions", { count: 30, confirm: "simple" }),
    cat("people", { count: 6, shared: true, requires: ["relationships", "inner"] }),
    cat("audit", { count: 120, shared: true, kept: true }),
  ],
};

const RESULT = { deleted: [], counts: {}, failed_modules: [], notes: [] };

const writes = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method && init.method !== "GET")
    .map(([u, init]) => ({ call: `${init?.method} ${new URL(String(u), "http://x").pathname}`, body: init?.body ? JSON.parse(String(init.body)) : undefined }));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:backup");
  URL.revokeObjectURL = vi.fn();
});

describe("Data", () => {
  it("lists every category with counts, grouped, and memories by kind", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/data" ? { body: INVENTORY } : undefined));
    renderRoute("/data");
    const own = await screen.findByRole("table", { name: "她的資料" });
    const memories = within(own).getByText("記憶").closest("tr") as HTMLElement;
    expect(within(memories).getByText("8")).toBeInTheDocument();
    expect(within(memories).getByText("事實 3・經歷 5")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "共用資料" })).getByText("人物與帳號連結")).toBeInTheDocument();
    const kept = screen.getByRole("table", { name: "保留的資料" });
    expect(within(kept).getByText("稽核紀錄")).toBeInTheDocument();
    expect(screen.getByText("deepseek-chan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "危險區" })).toBeInTheDocument();

    // The audit log is never deletable.
    const user = userEvent.setup();
    await user.click(within(kept).getByRole("button", { name: "稽核紀錄 的動作" }));
    expect(await screen.findByRole("menuitem", { name: "匯出 JSON" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "刪除…" })).not.toBeInTheDocument();
  });

  it("a delete needs the typed profile id and names what goes along", async () => {
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/data") return { body: INVENTORY };
      if (method === "POST" && url.pathname === "/api/data/wipe") return { body: { ...RESULT, deleted: ["relationships", "inner", "people"] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/data");
    await user.click(await screen.findByRole("button", { name: "人物與帳號連結 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "刪除…" }));
    const dialog = await screen.findByRole("alertdialog");
    const list = within(dialog).getByRole("list", { name: "會刪除的資料" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["關係4", "內在狀態與感情2", "人物與帳號連結6"]);
    expect(within(dialog).getByText("這份資料由所有角色共用。")).toBeInTheDocument();

    const go = within(dialog).getByRole("button", { name: "刪除" });
    expect(go).toBeDisabled();
    const input = within(dialog).getByLabelText(/輸入 profile id/);
    await user.type(input, "deepseek");
    expect(go).toBeDisabled();
    await user.type(input, "-chan");
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() =>
      expect(writes(fetch)).toEqual([{ call: "POST /api/data/wipe", body: { categories: ["people"], confirm: "deepseek-chan" } }]),
    );
    expect(await screen.findByText("已刪除「人物與帳號連結」")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a simple delete needs one confirmation", async () => {
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/data") return { body: INVENTORY };
      if (method === "POST") return { body: RESULT };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/data");
    await user.click(await screen.findByRole("button", { name: "決策紀錄 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "刪除…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByLabelText(/輸入 profile id/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(writes(fetch)[0]?.body).toEqual({ categories: ["decisions"] }));
  });

  it("factory reset: backup first, then the typed id, then the reset with the backup token", async () => {
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/data") return { body: INVENTORY };
      if (method === "POST" && url.pathname === "/api/data/backup") {
        return {
          body: { format: "miyoria.data" },
          headers: {
            "content-disposition": 'attachment; filename="deepseek-chan-backup-20261102T120000.json"',
            "x-miyoria-backup-token": "tok-123",
          },
        };
      }
      if (method === "POST" && url.pathname === "/api/data/reset") return { body: { ...RESULT, notes: ["restart_core"] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/data");
    await user.click(await screen.findByRole("button", { name: "回到初始狀態…" }));
    const dialog = await screen.findByRole("alertdialog");
    const go = within(dialog).getByRole("button", { name: "回到初始狀態" });
    const input = within(dialog).getByLabelText(/輸入 profile id/);
    // Nothing can be typed before the backup is downloaded.
    expect(input).toBeDisabled();
    expect(go).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "下載備份" }));
    expect(await within(dialog).findByText("deepseek-chan-backup-20261102T120000.json")).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(go).toBeDisabled();
    await user.type(input, "deepseek-chan");
    await user.click(go);
    await waitFor(() =>
      expect(writes(fetch)).toEqual([
        { call: "POST /api/data/backup", body: undefined },
        { call: "POST /api/data/reset", body: { confirm: "deepseek-chan", backup_token: "tok-123" } },
      ]),
    );
    expect(await screen.findByText("已回到初始狀態")).toBeInTheDocument();
  });

  it("read-only and non-owner accounts see no deletes and no reset", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/data" ? { body: INVENTORY } : undefined));
    const viewer: SessionValue = {
      session: { method: "discord", user: { id: "3", name: "viewer", avatar_url: null }, permissions: { write: false } },
      logout: () => {},
    };
    const user = userEvent.setup();
    renderRoute("/data", { session: viewer });
    await user.click(await screen.findByRole("button", { name: "記憶 的動作" }));
    expect(await screen.findByRole("menuitem", { name: "檢視" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "刪除…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "危險區" })).not.toBeInTheDocument();
  });

  it("without owner.data.manage: no export either", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/data" ? { body: { ...INVENTORY, can_manage: false } } : undefined));
    const user = userEvent.setup();
    renderRoute("/data");
    await screen.findByRole("table", { name: "她的資料" });
    expect(screen.queryByRole("button", { name: "匯出全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "危險區" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "決策紀錄 的動作" }));
    expect(await screen.findByRole("menuitem", { name: "檢視" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "匯出 JSON" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "刪除…" })).not.toBeInTheDocument();
  });
});
