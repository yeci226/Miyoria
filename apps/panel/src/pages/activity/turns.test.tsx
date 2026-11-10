import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { E2eRecord, LogEvent, TurnOutcomeRecord } from "@/api/types";
import { queryKeys } from "@/app/queries";
import { mockFetch, renderRoute } from "@/test/render";

const TURN = "01JC8Z4Q2M9X3V7B5N6R8T0WYA";
const CTX = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const AT = "2026-11-07T14:22:34.000Z";
const t = (s: number) => new Date(Date.parse(AT) + s * 1000).toISOString();

const OUTCOME: TurnOutcomeRecord = {
  turn: TURN,
  context: CTX,
  reason: "addressed",
  outcome: { type: "sent", parts: 2 },
  addressed_by: ["owen"],
  focus: [],
  restarts: 0,
  reasoning: "low",
  latency_ms: 1900,
  at: AT,
};

function ev(id: string, s: number, kind: LogEvent["kind"], source: string, body: unknown, cause: string | null = null): LogEvent {
  return { id, at: t(s), kind, source, cause, context: CTX, person: null, body };
}

const LOG: LogEvent[] = [
  ev("L1", -2, "decision", "agent.focus", { turn: TURN, reason: "addressed" }),
  ev("L2", -1, "action", "gate", { capability: "sing.play", allowed: true, turn: TURN, why: "點歌" }, "L1"),
  ev("L3", -1, "steer", "activity", { phase: "request", owner: "sing", task: "K1", patch: {}, why: "改成先報幕", by: "self" }, "L2"),
  ev("L4", 0, "utterance", "delivery.voice", { said: "那就唱櫻ノ詩", channel: "voice", turn: TURN }, "L1"),
  ev("L5", 2, "delivered", "delivery.voice", { said: "那就唱櫻ノ詩", channel: "voice" }, "L4"),
  ev("L6", 3, "utterance", "delivery.voice", { said: "準備好了嗎", channel: "voice", turn: TURN }, "L1"),
  ev("L7", 4, "result", "delivery.voice", { delivery: "interrupted", reason: null }, "L6"),
  ev("X1", 1, "utterance", "delivery.voice", { said: "別的回合說的話", channel: "text", turn: "OTHER" }),
];

const E2E: E2eRecord = {
  context: CTX,
  turn: TURN,
  utterance: "U1",
  complete: true,
  reason: null,
  total_ms: 4800,
  segments: { endpoint: 600, asr: 1364, prepare: 400, llm_first: 1900, tts_queue: 300, tts_first: 520, playback: 116 },
  unattributed_ms: 0,
  prefetched: false,
  provider: "gpt-sovits",
};

function serve(over?: { log?: LogEvent[] }) {
  return mockFetch((_m, url) => {
    if (url.pathname === "/api/turns/outcomes") return { body: [OUTCOME] };
    if (url.pathname === `/api/prompts/${TURN}`) return { status: 404, body: { error: "no prompt" } };
    if (url.pathname === "/api/facts/events") return over?.log !== undefined ? { body: over.log } : { body: LOG };
    return undefined;
  });
}

describe("回合", () => {
  it("lists the recent turns and opens one", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/activity");
    const list = await screen.findByRole("list", { name: "回合列表" });
    await user.click(within(list).getByRole("button", { name: /owen/ }));
    expect(await screen.findByRole("list", { name: "她說的話" })).toBeInTheDocument();
  });

  it("shows what she said, did and whether it arrived, from the turn's own lines", async () => {
    const fetch = serve();
    renderRoute(`/activity?tab=turns&turn=${TURN}`);

    const said = await screen.findByRole("list", { name: "她說的話" });
    expect(within(said).getByText("那就唱櫻ノ詩")).toBeInTheDocument();
    expect(within(said).getByText("準備好了嗎")).toBeInTheDocument();
    expect(screen.queryByText("別的回合說的話")).not.toBeInTheDocument();

    const actions = screen.getByRole("list", { name: "這回合的動作" });
    expect(within(actions).getByText("sing.play")).toBeInTheDocument();
    expect(within(actions).getByText("改方向")).toBeInTheDocument();
    expect(within(actions).getByText("已要求")).toBeInTheDocument();
    expect(within(actions).getByText("改成先報幕")).toBeInTheDocument();

    const delivery = screen.getByRole("list", { name: "送達狀況" });
    expect(within(delivery).getByText("已送達")).toBeInTheDocument();
    expect(within(delivery).getByText("被打斷")).toBeInTheDocument();
    // 0 s to 2 s after the line opened.
    expect(within(delivery).getByText(/2\.00 s/)).toBeInTheDocument();

    // How the turn ended sits above, with the time from the last input to the first output.
    expect(within(await screen.findByRole("dialog")).getByText("1,900 ms")).toBeInTheDocument();
    const asked = fetch.mock.calls.map(([u]) => new URL(String(u), "http://x")).find((u) => u.pathname === "/api/facts/events");
    expect(asked?.searchParams.get("order")).toBe("asc");
    // The window starts at the turn id's own time, long before this fixture's lines: nothing
    // is invented to fill it, and the lines found are the ones that name the turn.
    expect(Number(asked?.searchParams.get("limit"))).toBe(500);
  });

  it("asks the Core for the turn itself, and shows the latency it logged for a past turn", async () => {
    const { stage: _s, ...measurement } = { stage: "e2e", ...E2E };
    const logged = ev("L8", 5, "result", "voice.latency", { turn: TURN, e2e: measurement }, "L1");
    const fetch = mockFetch((_m, url) => {
      if (url.pathname === "/api/turns/outcomes") return { body: [OUTCOME] };
      if (url.pathname === `/api/prompts/${TURN}`) return { status: 404, body: { error: "no prompt" } };
      // A Core that knows `turn`: only that turn's lines, and no time window is needed.
      if (url.pathname === "/api/facts/events") return { body: url.searchParams.get("turn") === TURN ? [...LOG.filter((e) => e.id !== "X1"), logged] : [] };
      return undefined;
    });
    renderRoute(`/activity?tab=turns&turn=${TURN}`);
    const bars = await screen.findByRole("list", { name: "各段延遲" });
    expect(within(bars).getAllByRole("listitem")).toHaveLength(7);
    const asked = fetch.mock.calls.map(([u]) => new URL(String(u), "http://x")).filter((u) => u.pathname === "/api/facts/events");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.searchParams.get("turn")).toBe(TURN);
    expect(asked[0]?.searchParams.get("since")).toBeNull();
    // The measurement is not an action of the turn.
    expect(within(screen.getByRole("list", { name: "這回合的動作" })).queryByText("voice.latency")).not.toBeInTheDocument();
  });

  it("falls back to the time window when the answer names nothing of the turn", async () => {
    const fetch = serve({ log: LOG.filter((e) => e.id === "X1") });
    renderRoute(`/activity?tab=turns&turn=${TURN}`);
    await screen.findByText("這回合沒有說出任何話");
    const asked = fetch.mock.calls.map(([u]) => new URL(String(u), "http://x")).filter((u) => u.pathname === "/api/facts/events");
    expect(asked.map((u) => u.searchParams.get("turn"))).toEqual([TURN, null]);
    expect(asked[1]?.searchParams.get("since")).not.toBeNull();
  });

  it("shows the segments of a reply the panel measured", async () => {
    serve();
    const { queryClient } = renderRoute(`/activity?tab=turns&turn=${TURN}`);
    await screen.findByRole("list", { name: "她說的話" });
    expect(screen.getByText("沒有這回合的語音延遲")).toBeInTheDocument();

    queryClient.setQueryData(queryKeys.turnE2e(TURN), E2E);

    const bars = await screen.findByRole("list", { name: "各段延遲" });
    const rows = within(bars).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "判斷說完600 ms",
      "辨識1.36 s",
      "準備400 ms",
      "LLM 首字1.90 s",
      "TTS 排隊300 ms",
      "TTS 合成520 ms",
      "播放116 ms",
    ]);
    expect(screen.getByText("4.80 s")).toBeInTheDocument();
    expect(screen.getByText(/gpt-sovits/)).toBeInTheDocument();
  });

  it("says why a measurement is incomplete instead of drawing segments", async () => {
    serve();
    const { queryClient } = renderRoute(`/activity?tab=turns&turn=${TURN}`);
    await screen.findByRole("list", { name: "她說的話" });
    queryClient.setQueryData(queryKeys.turnE2e(TURN), { ...E2E, complete: false, reason: "barge_in", total_ms: null });
    expect(await screen.findByText("沒有量完:被打斷")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "各段延遲" })).not.toBeInTheDocument();
  });

  it("has honest empty lines when the log holds nothing of the turn", async () => {
    serve({ log: LOG.filter((e) => e.id === "X1") });
    renderRoute(`/activity?tab=turns&turn=${TURN}`);
    expect(await screen.findByText("這回合沒有說出任何話")).toBeInTheDocument();
    expect(screen.getByText("這回合沒有動作")).toBeInTheDocument();
    expect(screen.getByText("沒有要送達的話")).toBeInTheDocument();
    expect(screen.getByText("這回合的提示詞沒有留下(太舊,或沒有存)")).toBeInTheDocument();
  });

  it("shows the log's failure with a retry, leaving the rest of the turn", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/turns/outcomes") return { body: [OUTCOME] };
      if (url.pathname === "/api/facts/events") return { status: 500, body: { error: "log is down" } };
      return undefined;
    });
    renderRoute(`/activity?tab=turns&turn=${TURN}`);
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/log is down/).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("dialog")).getByText("說了 2 則")).toBeInTheDocument();
  });

  it("says there are no turns yet", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/turns/outcomes" ? { body: [] } : undefined));
    renderRoute("/activity?tab=turns");
    expect(await screen.findByText("還沒有回合")).toBeInTheDocument();
  });
});
