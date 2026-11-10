import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Delivery, LogEvent } from "@/api/types";
import { UNMEASURED } from "@/lib/metrics";
import { mockFetch, renderRoute } from "@/test/render";

const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" as const };
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const ev = (id: string, mins: number, kind: LogEvent["kind"], source: string, body: unknown, context: LogEvent["context"] = VOICE): LogEvent => ({
  id,
  at: ago(mins),
  kind,
  source,
  cause: null,
  context,
  person: null,
  body,
});

const delivery = (line: string, mins: number, key = line): Delivery => ({
  attention_key: key,
  revision: 1,
  channel: "voice",
  context: VOICE,
  said: "x",
  delivered_at: ago(mins),
  audience: [],
  answered_by: ["h"],
  line,
});

const e2e = (id: string, mins: number, total: number) =>
  ev(id, mins, "result", "voice.latency", {
    turn: `t${id}`,
    e2e: { context: VOICE, utterance: "u", complete: true, reason: null, total_ms: total, segments: {}, unattributed_ms: null, prefetched: false, provider: null },
  });

/** The chart block of one measure: its title is the first thing on the page with that text. */
const block = async (label: string) => ((await screen.findAllByText(label))[0] as HTMLElement).closest("section") as HTMLElement;

function core(boots: number[]) {
  return mockFetch((method, url) => {
    if (method !== "GET") return undefined;
    if (url.pathname === "/api/facts/deliveries") {
      // Newest first, as the ledger answers; "again" repeats the key of "u1".
      return { body: [delivery("u3", 20, "k1"), delivery("u2", 40), delivery("u1", 60, "k1")] };
    }
    if (url.pathname === "/api/facts/events") {
      const source = url.searchParams.get("source");
      const kind = url.searchParams.get("kind");
      if (source === "agent.focus") {
        return { body: [ev("f2", 41, "decision", "agent.focus", { turn: "t2", reason: "addressed" }), ev("f1", 61, "decision", "agent.focus", { turn: "t1", reason: "addressed" }), ev("f3", 21, "decision", "agent.focus", { turn: "t3", reason: "addressed" })] };
      }
      if (kind === "utterance") {
        return { body: [ev("u2", 40, "utterance", "delivery.voice", { turn: "t2", channel: "voice" }), ev("u1", 60, "utterance", "delivery.voice", { turn: "t1", channel: "voice" })] };
      }
      if (source === "voice.latency") return { body: [e2e("l2", 30, 3000), e2e("l1", 50, 1000)] };
      if (source === "floor") return { body: [ev("h1", 41, "decision", "floor", { floor_turn: "t2", kind: "addressed" })] };
      if (source === "core.lifecycle") {
        return { body: boots.map((m, i) => ev(`b${i}`, m, "observation", "core.lifecycle", { observation: { attention_key: "system:boot" } }, null)) };
      }
      return { body: [] };
    }
    return undefined;
  });
}

describe("評測", () => {
  it("measures from the log and the ledger and says what it cannot measure", async () => {
    core([45]);
    renderRoute("/eval");

    const addressed = (await block("直接叫她的開口率(語音)")) as HTMLElement;
    // t1 and t2 were answered, t3 was not: 2 of 3.
    // Fixtures on both sides of midnight also show it per day.
    expect(within(addressed).getAllByText("67%")[0]).toBeInTheDocument();
    expect(addressed).toHaveTextContent("目標 > 95%");
    expect(addressed).toHaveTextContent("3 回合");
    expect(within(addressed).getAllByText("未達標")[0]).toBeInTheDocument();

    const latency = await block("語音說完到出聲") as HTMLElement;
    expect(within(latency).getAllByText("2.00 s")[0]).toBeInTheDocument();
    expect(within(latency).getAllByText("達標")[0]).toBeInTheDocument();

    // u3 says the key of u1 again at the same revision: 1 of 3 lines.
    const repeat = await block("重複率") as HTMLElement;
    expect(within(repeat).getAllByText("33%")[0]).toBeInTheDocument();

    // No promise was ever logged: not measured, never zero.
    const broken = await block("「說了沒做」(承諾逾期作廢)") as HTMLElement;
    expect(within(broken).getByText("—")).toBeInTheDocument();
    expect(within(broken).getByText("這段時間沒有量到")).toBeInTheDocument();

    const missing = screen.getByRole("table", { name: "還沒有量的指標" });
    for (const m of UNMEASURED) expect(within(missing).getByText(m.label)).toBeInTheDocument();
    expect(within(missing).getByText(/表演時段/)).toBeInTheDocument();
  });

  it("compares the measures before and after a start of the Core", async () => {
    core([45]);
    renderRoute("/eval");
    const table = await screen.findByRole("table", { name: "啟動前後的指標" });
    const row = within(table).getByText("直接叫她的開口率(語音)").closest("tr") as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    // Before 45 minutes ago: t1 answered. After: t2 answered and t3 not.
    expect(cells[1]).toHaveTextContent("100% (1)");
    expect(cells[2]).toHaveTextContent("50% (2)");
    expect(cells[3]).toHaveTextContent("> 95%");
  });

  it("has nothing to compare when the Core did not restart", async () => {
    core([]);
    renderRoute("/eval");
    expect(await screen.findByText("這段時間 Core 沒有重新啟動過,沒有可以對照的前後")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "啟動前後的指標" })).toBeNull();
  });

  it("is in the 運作 group of the sidebar", async () => {
    core([]);
    renderRoute("/eval");
    const sidebar = await screen.findByRole("complementary", { name: "主選單" });
    expect(within(sidebar).getByRole("link", { name: "評測" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("banner")).toHaveTextContent("運作 / 評測");
  });
});
