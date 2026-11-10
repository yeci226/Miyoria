import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TurnMetrics, TurnMetricsBucket } from "@/api/types";
import { mockFetch, renderRoute } from "@/test/render";

const ratio = (sent: number, total: number) => ({ sent, total, rate: total === 0 ? null : sent / total });

const bucket = (over: Partial<TurnMetricsBucket> = {}): TurnMetricsBucket => ({
  turns: 0,
  followup: ratio(0, 0),
  ambient: ratio(0, 0),
  addressed: ratio(0, 0),
  voice_latency: { p50_ms: null, p90_ms: null, samples: 0 },
  voice_origin: { self_started: 0, answering: 0 },
  outcomes: { sent: 0, silence: 0, cancelled: 0, error: 0 },
  followup_stopped: { anti_spam: 0, low_score: 0, lost_roll: 0, floor: 0, passed_silent: 0, other: 0 },
  ...over,
});

const busy = bucket({
  turns: 50,
  followup: ratio(3, 10),
  ambient: ratio(1, 20),
  addressed: ratio(19, 20),
  voice_latency: { p50_ms: 6000, p90_ms: 8500, samples: 8 },
  voice_origin: { self_started: 28, answering: 10 },
  outcomes: { sent: 30, silence: 15, cancelled: 3, error: 2 },
  followup_stopped: { anti_spam: 5, low_score: 1, lost_roll: 0, floor: 0, passed_silent: 1, other: 0 },
});

function metrics(overall: TurnMetricsBucket): TurnMetrics {
  return {
    days: 7,
    from: "2026-11-04T00:00:00.000Z",
    truncated: false,
    overall,
    daily: ["04", "05", "06", "07", "08", "09", "10"].map((d, i) => ({ day: `2026-11-${d}`, ...(i < 5 ? bucket() : overall) })),
  };
}

function core(body: TurnMetrics | undefined) {
  return mockFetch((method, url) => {
    if (method !== "GET") return undefined;
    if (url.pathname === "/api/turns/metrics") {
      return body ? { body } : { status: 500, body: { error: "boom" } };
    }
    if (url.pathname === "/api/voice") return { body: { sessions: [] } };
    return undefined;
  });
}

const section = () => screen.findByRole("region", { name: "參與度指標" });
/** The chart block of one measure: the chart repeats its title in the legend and the table. */
const block = async (s: HTMLElement, title: string) => (await within(s).findByRole("heading", { name: title })).closest("section") as HTMLElement;

describe("評測 / 參與度", () => {
  it("shows each measure with its target and says whether it is met", async () => {
    core(metrics(busy));
    renderRoute("/eval");
    const s = await section();
    const followup = await block(s, "接話率(別人接她的話)");
    expect(followup).toHaveTextContent("30%");
    expect(followup).toHaveTextContent("目標 > 60%");
    expect(within(followup).getByText("未達標")).toBeInTheDocument();

    const latency = await block(s, "語音延遲 p50(被叫到)");
    expect(latency).toHaveTextContent("6.00 s");
    expect(latency).toHaveTextContent("p90 8.50 s");

    const origin = await block(s, "語音自己發起的比例");
    expect(origin).toHaveTextContent("2.8 : 1");

    const why = within(s).getByRole("list", { name: "沒接話的原因" });
    expect(within(why).getByText("發言佔比上限擋下")).toBeInTheDocument();
  });

  it("does not turn a missing measure into a zero", async () => {
    core(metrics(bucket({ turns: 4, outcomes: { sent: 4, silence: 0, cancelled: 0, error: 0 }, addressed: ratio(4, 4) })));
    renderRoute("/eval");
    const s = await section();
    const ambient = await block(s, "閒聊參與(沒人叫她時)");
    expect(ambient).toHaveTextContent("—");
    expect(within(ambient).getByText("這段時間沒有量到")).toBeInTheDocument();
    expect(within(s).getByText("這段時間別人接她的話,她都回了,或沒有人接")).toBeInTheDocument();
  });

  it("shows the corrections of her output by kind and channel, with the turns they were counted over", async () => {
    const counted = (events: number, turns: number) => ({ events, turns });
    const none = counted(0, 0);
    const corrections = {
      measured: { voice: 100, text: 900 },
      kinds: {
        claim_held: { voice: none, text: counted(5, 3) },
        wait_line: { voice: counted(2, 2), text: counted(1, 1) },
      },
    };
    const day = { ...busy, corrections };
    core({ ...metrics(busy), overall: day, daily: metrics(busy).daily.map((d, i) => (i < 5 ? d : { ...d, corrections })) } as TurnMetrics);
    renderRoute("/eval");
    const s = await screen.findByRole("region", { name: "事後修正" });
    expect(s).toHaveTextContent("1000");
    expect(s).toHaveTextContent("語音 100 · 文字 900");
    const kinds = within(s).getByRole("table", { name: "每一種修正" });
    // Most frequent first; a share of the measured turns reads "fired on 0.3% of replies".
    const rows = within(kinds).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("說了做到的事,先扣住");
    expect(rows[0]).toHaveTextContent("5次 · 3 回合");
    expect(rows[0]).toHaveTextContent("0.3%");
    expect(within(kinds).getByText("推理寫進回覆,擋下")).toBeInTheDocument();
    // Per day, for the kind picked (the most frequent), with the day's measured turns beside it.
    const daily = within(s).getByRole("table", { name: "說了做到的事,先扣住的每天次數" });
    expect(within(daily).getAllByRole("row")[1]).toHaveTextContent("語音 100 · 文字 900");
  });

  it("an older Core that counts no corrections shows no block for them", async () => {
    core(metrics(busy));
    renderRoute("/eval");
    await section();
    expect(screen.queryByRole("region", { name: "事後修正" })).toBeNull();
  });

  it("has an empty state and an error state", async () => {
    core(metrics(bucket()));
    const first = renderRoute("/eval");
    expect(await screen.findByText(/這 7 天沒有回合紀錄/)).toBeInTheDocument();
    first.unmount();

    core(undefined);
    renderRoute("/eval");
    const s = await section();
    expect(await within(s).findByRole("alert")).toHaveTextContent("讀取失敗");
  });
});
