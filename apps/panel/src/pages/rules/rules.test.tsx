import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DirectiveRecord, LogEvent } from "@/api/types";
import { blocksOf, blocksPerRule, expiryLabel, inForce } from "@/lib/rules";
import { mockFetch, renderRoute } from "@/test/render";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const rule = (id: string, text: string, over: Partial<DirectiveRecord> = {}): DirectiveRecord => ({
  id,
  issuer: { platform: "discord", id: "1" },
  authority: "owner",
  scope: { activity: "minecraft" },
  effect: "deny",
  text,
  expires: "until_revoked",
  source_event: "panel:owen",
  created_at: "2026-11-07T06:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  ...over,
});

const MINECRAFT = rule("r1", "不要玩 Minecraft", { scope: { capability: "game.*", activity: "minecraft" } });
const NIGHT = rule("r2", "深夜不主動開口", { authority: "moderator", effect: "avoid", scope: {}, expires: FUTURE });

const at = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
const ev = (id: string, secs: number, kind: LogEvent["kind"], source: string, body: unknown): LogEvent => ({
  id,
  at: at(secs),
  kind,
  source,
  cause: null,
  context: null,
  person: null,
  body,
});

const gate = (id: string, secs: number, capability: string, reason: string) =>
  ev(id, secs, "result", "gate", { capability, allowed: false, stage: "directive", reason, why: "想玩", turn: null });

describe("what a rule stopped", () => {
  const events = [
    gate("g1", 10, "game.start", "主人定的規則:不要玩 Minecraft"),
    gate("g2", 20, "game.start", "主人定的規則:不要玩 Minecraft"),
    { ...gate("g3", 30, "chat.dm", "對方未同意"), body: { capability: "chat.dm", allowed: false, stage: "prohibition", reason: "對方未同意" } },
    ev("p1", 40, "directive", "directive", { op: "proposal_dropped", text: "提案作廢:去挖鑽石(主人定的規則:不要玩 Minecraft)", proposal: "x" }),
    ev("d1", 50, "directive", "directive", { op: "add", text: "新增規則", directive: null, by: "console" }),
  ];

  it("reads the gate results of the directive stage and the dropped proposals only", () => {
    const blocks = blocksOf(events);
    expect(blocks.map((b) => [b.id, b.via, b.capability, b.rule?.text ?? null])).toEqual([
      ["g1", "action", "game.start", "不要玩 Minecraft"],
      ["g2", "action", "game.start", "不要玩 Minecraft"],
      ["p1", "proposal", null, "不要玩 Minecraft"],
    ]);
    expect(blocks[2]?.what).toBe("去挖鑽石");
  });

  it("matches a stop to a rule by its authority and words", () => {
    const counts = blocksPerRule([MINECRAFT, NIGHT], blocksOf(events));
    expect(counts.get("r1")).toBe(3);
    expect(counts.get("r2")).toBe(0);
  });

  it("knows when a rule is in force and how to say when it ends", () => {
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    expect(inForce(MINECRAFT, now)).toBe(true);
    expect(inForce({ ...MINECRAFT, revoked_at: "2026-11-07T11:00:00.000Z" }, now)).toBe(false);
    expect(inForce({ ...NIGHT, expires: "2026-11-07T11:59:00.000Z" }, now)).toBe(false);
    expect(expiryLabel(MINECRAFT)).toBe("解除前有效");
  });
});

describe("規則", () => {
  const server = (state: { rules: DirectiveRecord[] }, extra?: (method: string, path: string, body: unknown) => ReturnType<Parameters<typeof mockFetch>[0]>) =>
    mockFetch((method, url, body) => {
      const custom = extra?.(method, url.pathname, body);
      if (custom) return custom;
      if (method === "GET" && url.pathname === "/api/directives") {
        const history = url.searchParams.get("history") === "1";
        return { body: { healthy: true, directives: history ? state.rules : state.rules.filter((r) => r.revoked_at === null) } };
      }
      if (method === "GET" && url.pathname === "/api/facts/events") {
        return {
          body: [
            gate("g1", 10, "game.start", "主人定的規則:不要玩 Minecraft"),
            gate("g2", 20, "game.start", "主人定的規則:不要玩 Minecraft"),
            ev("p1", 40, "directive", "directive", { op: "proposal_dropped", text: "提案作廢:去挖鑽石(主人定的規則:不要玩 Minecraft)", proposal: "x" }),
          ],
        };
      }
      return undefined;
    });

  it("lists the rules with their authority, effect, scope, source, expiry and today's count, and the recent stops in the rail", async () => {
    server({ rules: [MINECRAFT, NIGHT] });
    renderRoute("/rules");
    const table = await screen.findByRole("table", { name: "生效中的規則" });
    const first = within(table).getByText("不要玩 Minecraft").closest("tr") as HTMLElement;
    expect(within(first).getByText("禁止")).toBeInTheDocument();
    expect(within(first).getByText("game.*")).toBeInTheDocument();
    expect(within(first).getByText("minecraft")).toBeInTheDocument();
    expect(within(first).getByText("解除前有效")).toBeInTheDocument();
    expect(within(first).getByText("3")).toBeInTheDocument();
    const second = within(table).getByText("深夜不主動開口").closest("tr") as HTMLElement;
    expect(within(second).getByText("避免")).toBeInTheDocument();
    expect(within(second).getByText("管理員")).toBeInTheDocument();
    // An advisory rule stops nothing, so it has no count.
    expect(within(second).queryByText("0")).toBeNull();

    const rail = screen.getByRole("complementary", { name: "操作" });
    expect(await within(rail).findAllByText("game.start")).toHaveLength(2);
    expect(within(rail).getByText("去挖鑽石")).toBeInTheDocument();
    expect(screen.getByText("今天擋下 3 次")).toBeInTheDocument();
  });

  it("removes a rule after confirming and posts the delete", async () => {
    const state = { rules: [MINECRAFT, NIGHT] };
    const fetch = server(state, (method, path) => {
      if (method === "DELETE" && path === "/api/directives/r1") {
        state.rules = state.rules.filter((r) => r.id !== "r1");
        return { body: { status: "removed", directive: MINECRAFT } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/rules");
    await user.click(await screen.findByRole("button", { name: "解除「不要玩 Minecraft」" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "解除" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => i?.method === "DELETE" && String(u).endsWith("/api/directives/r1"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("不要玩 Minecraft")).toBeNull());
  });

  it("keeps the form open with the Core's question and sends what was typed", async () => {
    const sent: unknown[] = [];
    let asked = 0;
    server({ rules: [] }, (method, path, body) => {
      if (method === "POST" && path === "/api/directives") {
        sent.push(body);
        asked++;
        return asked === 1
          ? { body: { status: "question", question: "「不要玩」指的是哪個動作或哪個遊戲?" } }
          : { status: 201, body: { status: "added", directive: MINECRAFT, note: null } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/rules");
    await user.click(await screen.findByRole("button", { name: "新增規則" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("規則"), "不要玩");
    await user.click(within(dialog).getByRole("button", { name: "新增" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("指的是哪個動作或哪個遊戲");
    expect(sent[0]).toEqual({ text: "不要玩", effect: "deny", scope: {}, minutes: null });

    await user.type(within(dialog).getByLabelText("活動"), "minecraft");
    await user.click(within(dialog).getByRole("button", { name: "新增" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent[1]).toEqual({ text: "不要玩", effect: "deny", scope: { activity: "minecraft" }, minutes: null });
  });

  it("shows the ended rules with who ended them", async () => {
    server({ rules: [MINECRAFT, rule("r9", "不要唱歌", { revoked_at: "2026-11-07T08:00:00.000Z", revoked_by: "discord:1" })] });
    const user = userEvent.setup();
    renderRoute("/rules");
    await screen.findByRole("table", { name: "生效中的規則" });
    await user.click(screen.getByRole("radio", { name: "已結束" }));
    const table = await screen.findByRole("table", { name: "已結束的規則" });
    expect(within(table).getByText("不要唱歌")).toBeInTheDocument();
    expect(within(table).getByText(/discord:1/)).toBeInTheDocument();
    expect(within(table).queryByText("不要玩 Minecraft")).toBeNull();
  });

  it("is in the sidebar's 她 group and in the command palette, and sits in 總覽's rail", async () => {
    server({ rules: [MINECRAFT] });
    const user = userEvent.setup();
    renderRoute("/");
    const sidebar = await screen.findByRole("complementary", { name: "主選單" });
    expect(within(sidebar).getByRole("link", { name: "規則" })).toHaveAttribute("href", "/rules");
    const rail = await screen.findByRole("list", { name: "生效中的規則" });
    expect(within(rail).getByText("不要玩 Minecraft")).toBeInTheDocument();
    await user.click(within(sidebar).getByRole("button", { name: "搜尋與跳轉" }));
    const palette = await screen.findByRole("dialog");
    expect(within(palette).getByText("規則")).toBeInTheDocument();
    expect(within(palette).getByText("評測")).toBeInTheDocument();
  });
});
