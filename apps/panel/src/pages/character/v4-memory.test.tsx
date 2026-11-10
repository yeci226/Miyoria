import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { NotebookPage, RecentView } from "@/api/v4-types";
import { mockFetch, renderRoute } from "@/test/render";
import { splitPath } from "./NotebookTab";

const AT = "2026-11-10T10:00:00.000Z";

const PAGES: NotebookPage[] = [
  { path: "自己/想做的事", chars: 6, updated_at: AT, created_at: AT, about: null, body: "學做蛋糕\n寫一個小遊戲" },
  { path: "人/Owen", chars: 9, updated_at: "2026-11-09T10:00:00.000Z", created_at: AT, about: "P1", body: "考試在週五" },
];

function notebook(pages: NotebookPage[]) {
  return mockFetch((_m, u) => {
    if (u.pathname === "/api/notebook") return { body: { pages: pages.map(({ body: _b, created_at: _c, ...e }) => e) } };
    if (u.pathname === "/api/notebook/page") {
      const page = pages.find((p) => p.path === u.searchParams.get("path"));
      return page ? { body: page } : { status: 404, body: { error: "no page" } };
    }
    return undefined;
  });
}

describe("角色 / 筆記本", () => {
  it("lists her own pages and opens one", async () => {
    const user = userEvent.setup();
    notebook(PAGES);
    renderRoute("/character?tab=notebook");
    const article = await screen.findByRole("article", { name: "筆記 自己/想做的事" });
    expect(article).toHaveTextContent("學做蛋糕");
    expect(article).toHaveTextContent("6 字");
    await user.click(within(screen.getByRole("list", { name: "筆記索引" })).getByRole("button", { name: /Owen/ }));
    expect(await screen.findByRole("article", { name: "筆記 人/Owen" })).toHaveTextContent("考試在週五");
  });

  it("splits a path into folder and name", () => {
    expect(splitPath("人/Owen")).toEqual({ folder: "人", name: "Owen" });
    expect(splitPath("a/b/c")).toEqual({ folder: "a/b", name: "c" });
    expect(splitPath("solo")).toEqual({ folder: null, name: "solo" });
  });

  it("has empty, off and error states", async () => {
    notebook([]);
    const a = renderRoute("/character?tab=notebook");
    expect(await screen.findByText("她還沒有寫任何自己的筆記")).toBeInTheDocument();
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/notebook" ? { status: 503, body: { error: "memory module (her notebook) is not available" } } : undefined));
    const b = renderRoute("/character?tab=notebook");
    expect(await screen.findByText("筆記本(memory 模組)沒有啟動")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/notebook" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/character?tab=notebook");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

const VOICE = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const TEXT = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

const levels = {
  levels: [],
  channels: [
    { context: TEXT, label: "雜談", mode: "normal", custom: false, default: "normal" },
    { context: VOICE, label: "語音", mode: "normal", custom: false, default: "normal" },
  ],
};

describe("角色 / 剛才", () => {
  it("reads the timeline from the voice channel first and hides what came from a DM", async () => {
    const recent: RecentView = {
      entries: [
        { at: AT, kind: "song", place: { kind: "voice", label: "語音", context: VOICE }, text: "唱了〈Song〉", private: false },
        { at: "2026-11-10T10:05:00.000Z", kind: "talk", place: { kind: "text", label: "別的文字頻道", context: TEXT }, text: "Owen 對你說:「晚安」", private: false },
      ],
      private_hidden: 2,
    };
    const asked: string[] = [];
    mockFetch((_m, u) => {
      if (u.pathname === "/api/channels/levels") return { body: levels };
      if (u.pathname === "/api/recent") {
        asked.push(u.searchParams.get("context") ?? "");
        return { body: recent };
      }
      return undefined;
    });
    renderRoute("/character?tab=recent");
    const list = await screen.findByRole("list", { name: "剛才" });
    const items = within(list).getAllByRole("listitem");
    // Newest first.
    expect(items[0]).toHaveTextContent("Owen 對你說:「晚安」");
    expect(items[1]).toHaveTextContent("唱了〈Song〉");
    expect(screen.getByText("另有 2 筆來自私訊,這裡不顯示")).toBeInTheDocument();
    expect(JSON.parse(asked[0] as string)).toEqual(VOICE);
  });

  it("has empty, no-channel and off states", async () => {
    mockFetch((_m, u) => {
      if (u.pathname === "/api/channels/levels") return { body: levels };
      if (u.pathname === "/api/recent") return { body: { entries: [], private_hidden: 0 } };
      return undefined;
    });
    const a = renderRoute("/character?tab=recent");
    expect(await screen.findByText("這個頻道看出去,剛才沒有發生什麼事")).toBeInTheDocument();
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/channels/levels" ? { body: { levels: [], channels: [] } } : undefined));
    const b = renderRoute("/character?tab=recent");
    expect(await screen.findByText("她還沒有認得的頻道")).toBeInTheDocument();
    b.unmount();
    mockFetch((_m, u) => {
      if (u.pathname === "/api/channels/levels") return { body: levels };
      if (u.pathname === "/api/recent") return { status: 503, body: { error: "memory module (the just-now timeline) is not available" } };
      return undefined;
    });
    renderRoute("/character?tab=recent");
    expect(await screen.findByText("「剛才」時間軸(memory 模組)沒有啟動")).toBeInTheDocument();
  });
});
