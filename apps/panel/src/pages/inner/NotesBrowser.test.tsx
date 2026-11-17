import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { NoteDocumentEntry, NoteDocumentView, NoteHistory, NoteLineView, NotesList } from "@miyoria/contracts/api";
import { fmtDateTime } from "@/lib/format";
import { mockFetch, renderRoute } from "@/test/render";
import { summarize } from "./NotesBrowser";

const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-11T10:00:00.000Z";
const squash = (s: string | null) => (s ?? "").replace(/\s+/g, "");

function entry(id: string, kind: NoteDocumentEntry["kind"], label: string, over: Partial<NoteDocumentEntry> = {}): NoteDocumentEntry {
  return { id, short_id: `#${id.slice(-6)}`, subject: `${kind}:${id}`, kind, label, lines: 2, version: 3, created_at: AT, updated_at: LATER, ...over };
}

const OWEN = entry("01HOWEN000000000000000001", "person", "Owen");
const MIYORIA = entry("01HSELF000000000000000002", "self", "她自己", { subject: "self", version: 2 });
const RAMEN = entry("01HTOPIC00000000000000003", "topic", "拉麵", { lines: 1 });

const LIST: NotesList = {
  documents: [OWEN, MIYORIA, RAMEN],
  counts: [
    { kind: "person", documents: 1, lines: 2 },
    { kind: "place", documents: 0, lines: 0 },
    { kind: "topic", documents: 1, lines: 1 },
    { kind: "self", documents: 1, lines: 2 },
  ],
};

function line(id: string, text: string, over: Partial<NoteLineView> = {}): NoteLineView {
  return {
    id,
    short_id: `#${id}`,
    text,
    provenance: "told_by_subject",
    told_by: null,
    told_by_name: null,
    scope: { type: "self", label: "她自己" },
    confidence: 0.8,
    author: "segment",
    evidence: [],
    created_at: AT,
    updated_at: AT,
    outdated_at: null,
    outdated_reason: null,
    ...over,
  };
}

const LIVE = line("L1", "喜歡拉麵", {
  told_by: "01HOWEN000000000000000001",
  told_by_name: "Owen",
  scope: { type: "dm", label: "和 Owen 的私訊" },
  evidence: [{ quote: "我最愛拉麵了", person_id: "01HOWEN000000000000000001", person_name: "Owen", at: AT, redacted: false }],
});
const OLD = line("L0", "喜歡烏龍麵", { provenance: "observed", author: "tool", outdated_at: LATER, outdated_reason: "改口了" });

function view(doc: NoteDocumentEntry, outdated: boolean): NoteDocumentView {
  const live = doc.kind === "self" ? [line("S1", "我想少插話", { provenance: "concluded", author: "reflect" })] : [LIVE];
  return {
    document: doc,
    sections: [{ key: "likes", label: "喜好", lines: outdated && doc.kind === "person" ? [LIVE, OLD] : live }],
    outdated: doc.kind === "person" ? 1 : 0,
  };
}

function history(doc: NoteDocumentEntry): NoteHistory {
  return {
    document: doc,
    versions: [
      { version: 1, at: AT, author: "segment", reason: null, changes: [{ op: "add", line_id: "L0", section: "likes", section_label: "喜好", text: "喜歡烏龍麵" }] },
      {
        version: 2,
        at: LATER,
        author: "tool",
        reason: "改口了",
        changes: [
          { op: "outdate", line_id: "L0", section: "likes", section_label: "喜好", text: "喜歡烏龍麵" },
          { op: "add", line_id: "L1", section: "likes", section_label: "喜好", text: "喜歡拉麵" },
        ],
      },
      { version: 3, at: LATER, author: "reflect", reason: null, changes: [{ op: "add", line_id: "L2", section: "likes", section_label: "喜好", text: "x" }] },
    ],
  };
}

function serve(reverts: unknown[] = []) {
  return mockFetch((method, url, body) => {
    const docs = [OWEN, MIYORIA, RAMEN];
    if (url.pathname === "/api/notes/documents") return { body: LIST };
    const m = url.pathname.match(/^\/api\/notes\/documents\/([^/]+)(\/history|\/revert)?$/);
    const doc = m ? docs.find((d) => d.id === m[1]) : undefined;
    if (!doc) return undefined;
    if (m?.[2] === "/history") return { body: history(doc) };
    if (m?.[2] === "/revert" && method === "POST") {
      reverts.push({ id: doc.id, body });
      return { body: { document: doc, version: 4, restored: 1, outdated: 1, gone: 0 } };
    }
    return { body: view(doc, url.searchParams.get("outdated") === "true") };
  });
}

describe("內心 / 知識 / 她的筆記", () => {
  it("says so when she has written nothing", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/notes/documents" ? { body: { documents: [], counts: [] } } : undefined));
    renderRoute("/inner?tab=knowledge");
    expect(await screen.findByText("她還沒有寫下任何筆記")).toBeInTheDocument();
  });

  it("has off and error states", async () => {
    mockFetch((_m, u) => (u.pathname === "/api/notes/documents" ? { status: 503, body: { error: "her documents are not available" } } : undefined));
    const a = renderRoute("/inner?tab=knowledge");
    expect(await screen.findByText("筆記沒有啟動")).toBeInTheDocument();
    a.unmount();
    mockFetch((_m, u) => (u.pathname === "/api/notes/documents" ? { status: 500, body: { error: "boom" } } : undefined));
    renderRoute("/inner?tab=knowledge");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("boom"))).toBe(true);
  });

  it("lists documents by kind with counts and opens one with its lines by section", async () => {
    const user = userEvent.setup();
    serve();
    renderRoute("/inner?tab=knowledge");
    const article = await screen.findByRole("article", { name: "文件 Owen" });
    const section = within(article).getByRole("region", { name: "喜好" });
    expect(within(section).getByText("喜歡拉麵")).toBeInTheDocument();
    expect(within(section).getByText("本人說的(Owen)")).toBeInTheDocument();
    expect(within(section).getByText("和 Owen 的私訊")).toBeInTheDocument();
    expect(within(section).getByText("整理對話")).toBeInTheDocument();
    // The quote the line rests on is there, behind its summary.
    expect(within(section).getByText("原話 1")).toBeInTheDocument();
    expect(within(section).getByText(/我最愛拉麵了/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "人物 1" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "地點 0" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "主題 1" }));
    expect(await screen.findByRole("article", { name: "文件 拉麵" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "地點 0" }));
    expect(await screen.findByText("這一類還沒有文件")).toBeInTheDocument();
  });

  it("keeps outdated lines behind a toggle", async () => {
    const user = userEvent.setup();
    const fetch = serve();
    renderRoute("/inner?tab=knowledge");
    const article = await screen.findByRole("article", { name: "文件 Owen" });
    expect(within(article).queryByText("喜歡烏龍麵")).not.toBeInTheDocument();
    await user.click(within(article).getByRole("switch", { name: "含過時的行 1" }));
    const old = await screen.findByText("喜歡烏龍麵");
    expect(old.closest("li")).toHaveAttribute("data-outdated", "true");
    expect(squash(old.closest("li")?.textContent ?? "")).toContain(squash(`過時於 ${fmtDateTime(LATER)} · 改口了`));
    const asked = fetch.mock.calls.map(([input]) => new URL(String(input), "http://panel.test")).filter((u) => u.pathname === `/api/notes/documents/${OWEN.id}`);
    expect(asked.some((u) => u.searchParams.get("outdated") === "true")).toBe(true);
  });

  it("shows the history and reverts after a confirmation", async () => {
    const user = userEvent.setup();
    const reverts: unknown[] = [];
    serve(reverts);
    renderRoute("/inner?tab=knowledge");
    const article = await screen.findByRole("article", { name: "文件 Owen" });
    await user.click(within(article).getByText("歷史"));
    const versions = await within(article).findByRole("list", { name: "版本" });
    const rows = within(versions).getAllByRole("listitem");
    // Newest first; the one in use has no revert.
    expect(rows[0]).toHaveTextContent("v3");
    expect(within(rows[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(rows[1]).toHaveTextContent("作廢 1、新增 1 · 改口了");
    expect(squash(rows[2]?.textContent ?? "")).toContain(squash(fmtDateTime(AT)));
    await user.click(within(article).getByRole("button", { name: "還原到 v1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("還原「Owen」到 v1?");
    expect(dialog).not.toHaveTextContent("這是她自己的文件");
    expect(reverts).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "還原" }));
    await waitFor(() => expect(reverts).toEqual([{ id: OWEN.id, body: { version: 1 } }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("已還原,存成 v4")).toBeInTheDocument();
  });

  it("warns before reverting her self document, and a cancel writes nothing", async () => {
    const user = userEvent.setup();
    const reverts: unknown[] = [];
    serve(reverts);
    renderRoute("/inner?tab=knowledge");
    await user.click(await screen.findByRole("radio", { name: "她自己 1" }));
    const article = await screen.findByRole("article", { name: "文件 她自己" });
    await user.click(within(article).getByText("歷史"));
    await user.click(await within(article).findByRole("button", { name: "還原到 v1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("這是她自己的文件。她改寫它不需要你同意");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(reverts).toEqual([]);
  });

  it("sums a change set by what it did", () => {
    expect(
      summarize([
        { op: "add", line_id: "a", section: "x", section_label: "x", text: "" },
        { op: "add", line_id: "b", section: "x", section_label: "x", text: "" },
        { op: "outdate", line_id: "c", section: "x", section_label: "x", text: "" },
      ]),
    ).toBe("新增 2、作廢 1");
  });
});
