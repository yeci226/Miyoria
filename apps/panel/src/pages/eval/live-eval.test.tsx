import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EvalLiveHistory, EvalLiveRun, EvalNightly } from "@miyoria/contracts/api";
import { fmtDateTime } from "@/lib/format";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { LIVE_MEASURES, LiveEval } from "./LiveEval";

const OFF: EvalNightly = { state: "off", time: null, next_at: null, running: false };

const suite = (headline: Record<string, number | null>, items = 10) => ({ headline, items, unsupported: 0, stopped: false });

const run = (day: number, over: Partial<EvalLiveRun> = {}): EvalLiveRun => ({
  v: 1,
  at: `2026-11-${String(day).padStart(2, "0")}T20:30:00.000Z`,
  commit: `0d611db5${day}aaaaaaaa`,
  subject: "current",
  repeat: 1,
  suites: {
    persona: suite({ score: 0.909, low_share: 0.1 }, 20),
    tools: suite({ success: 0.4 }),
    relationship: suite({ told_apart: 0.7, line_held: 1 }),
    memory: suite({ "recall@5": 0.8, mrr: 0.63, nothing_returned_rate: 0, leaks: 0 }, 46),
  },
  tokens: { calls: 106, prompt_tokens: 455_000, completion_tokens: 9000, cached_prompt_tokens: 348_000, reasoning_tokens: 0 },
  usd: 0.08,
  duration_ms: 14 * 60_000,
  models: ["opencode:flash"],
  stopped: null,
  ...over,
});

function core(body: EvalLiveHistory | { status: number }) {
  return mockFetch((method, url) => {
    if (method !== "GET" || url.pathname !== "/api/eval/live") return undefined;
    return "status" in body ? { status: body.status, body: { error: "no such endpoint" } } : { body };
  });
}

/** The text without any white space: the date format's space differs between platforms. */
const squeezed = (el: Element | undefined) => (el?.textContent ?? "").replace(/\s/g, "");
const section = () => screen.findByRole("region", { name: "真模型評測" });
/** The header of one measure: its label, then the latest value. */
const latest = (s: HTMLElement, label: string) => (within(s).getAllByText(label)[0] as HTMLElement).parentElement as HTMLElement;

describe("評測 / 真模型評測", () => {
  it("says there is no run yet, and that the nightly run is off", async () => {
    core({ runs: [], nightly: OFF });
    renderPage(<LiveEval />);
    const s = await section();
    expect(await within(s).findByText("還沒有跑過真模型評測")).toBeInTheDocument();
    expect(within(s).getByLabelText("每晚排程")).toHaveTextContent("每晚排程沒有開");
    expect(within(s).queryByRole("table", { name: "最近的真模型評測" })).toBeNull();
    for (const m of LIVE_MEASURES) expect(within(s).queryByText(m.label)).toBeNull();
  });

  it("shows one run: every headline number, and the run with its commit, cost and time", async () => {
    core({ runs: [run(16)], nightly: { state: "scheduled", time: "04:30", next_at: "2026-11-17T20:30:00.000Z", running: false } });
    renderPage(<LiveEval />);
    const s = await section();
    await within(s).findByRole("table", { name: "最近的真模型評測" });
    expect(latest(s, "人設分數")).toHaveTextContent("0.91");
    expect(latest(s, "人設低分的比例")).toHaveTextContent("10%");
    expect(latest(s, "工具任務成功率")).toHaveTextContent("40%");
    expect(latest(s, "分得出親疏")).toHaveTextContent("70%");
    expect(latest(s, "界線守住")).toHaveTextContent("100%");
    expect(latest(s, "記憶前 5 筆命中")).toHaveTextContent("80%");
    expect(latest(s, "記憶 MRR")).toHaveTextContent("0.63");
    expect(latest(s, "不該想起時沒想起")).toHaveTextContent("0%");

    const rows = within(within(s).getByRole("table", { name: "最近的真模型評測" })).getAllByRole("row");
    expect(rows).toHaveLength(2);
    const cells = within(rows[1] as HTMLElement).getAllByRole("cell");
    expect(squeezed(cells[0])).toContain(fmtDateTime("2026-11-16T20:30:00.000Z").replace(/\s/g, ""));
    expect(cells[1]).toHaveTextContent(/^0d611db5$/);
    expect(cells[2]).toHaveTextContent("current");
    expect(cells[3]).toHaveTextContent("$0.08");
    expect(cells[4]).toHaveTextContent("14 分");

    const nightly = within(s).getByLabelText("每晚排程");
    expect(nightly).toHaveTextContent("04:30");
    expect(squeezed(nightly)).toContain(fmtDateTime("2026-11-17T20:30:00.000Z").replace(/\s/g, ""));
  });

  it("shows many runs: the latest value of each measure, the ten newest runs, and what is unknown", async () => {
    const runs = Array.from({ length: 14 }, (_, i) => run(i + 1, { suites: { tools: suite({ success: i / 20 }) } }));
    // The newest: stopped at the limit, a model without a price, no commit, three times each.
    runs[13] = run(14, { usd: null, commit: null, repeat: 3, stopped: "budget", duration_ms: 42_000, suites: { tools: suite({ success: 0.65 }), persona: suite({ score: null, low_share: null }, 0) } });
    core({ runs, nightly: { state: "scheduled", time: "04:30", next_at: null, running: true } });
    renderPage(<LiveEval />);
    const s = await section();
    const table = await within(s).findByRole("table", { name: "最近的真模型評測" });
    expect(latest(s, "工具任務成功率")).toHaveTextContent("65%");
    // Nothing could be scored, and a suite that did not run: no number, never zero.
    expect(latest(s, "人設分數")).toHaveTextContent("—");
    expect(latest(s, "記憶 MRR")).toHaveTextContent("—");

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    const first = within(rows[0] as HTMLElement).getAllByRole("cell");
    expect(squeezed(first[0])).toContain(fmtDateTime(runs[13]?.at ?? "").replace(/\s/g, ""));
    expect(first[0]).toHaveTextContent("到上限,沒跑完");
    expect(first[1]).toHaveTextContent("—");
    expect(first[2]).toHaveTextContent("current ×3");
    expect(first[3]).toHaveTextContent("—");
    expect(first[4]).toHaveTextContent("42 秒");
    expect(squeezed(within(rows[9] as HTMLElement).getAllByRole("cell")[0])).toContain(fmtDateTime(runs[4]?.at ?? "").replace(/\s/g, ""));
    expect(within(s).getByLabelText("每晚排程")).toHaveTextContent("正在跑");
  });

  it("keeps two brains apart: the newest run's first, the other on request", async () => {
    core({ runs: [run(10), run(11, { subject: "next", suites: { tools: suite({ success: 0.9 }) } }), run(12)], nightly: OFF });
    renderPage(<LiveEval />);
    const s = await section();
    const table = await within(s).findByRole("table", { name: "最近的真模型評測" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(latest(s, "工具任務成功率")).toHaveTextContent("40%");
    await userEvent.click(within(s).getByRole("radio", { name: "next" }));
    expect(within(within(s).getByRole("table", { name: "最近的真模型評測" })).getAllByRole("row")).toHaveLength(2);
    expect(latest(s, "工具任務成功率")).toHaveTextContent("90%");
  });

  it("says a nightly time needs a repository checkout where there is none", async () => {
    core({ runs: [], nightly: { state: "no_checkout", time: "04:30", next_at: null, running: false } });
    renderPage(<LiveEval />);
    const s = await section();
    expect(await within(s).findByText("需要原始碼的資料夾,這個安裝沒有 tools/eval")).toBeInTheDocument();
  });

  it("says so when the Core does not have the route", async () => {
    core({ status: 404 });
    renderPage(<LiveEval />);
    const s = await section();
    expect(await within(s).findByText("這個 Core 還沒有這項功能")).toBeInTheDocument();
  });

  it("is on the 評測 page", async () => {
    core({ runs: [run(16)], nightly: OFF });
    renderRoute("/eval");
    const s = await section();
    expect(await within(s).findByRole("table", { name: "最近的真模型評測" })).toBeInTheDocument();
  });
});
