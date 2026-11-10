import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AffectSnapshot, DayPlanView, Envelope, Goal, GoalsView, PersonCard, SelfView, WorldView } from "@/api/types";
import { applyCustomEvent } from "@/app/events-store";
import { queryKeys } from "@/app/queries";
import { mockFetch, renderRoute } from "@/test/render";
import { emotionsText } from "./PersonCards";
import { triggerText } from "./GoalsTab";

const AT = "2026-11-02T12:00:00.000Z";

const AFFECT: AffectSnapshot = {
  at: AT,
  drives: { social: 0.7, play: 0.5, attention: 0.3, rest: 0.2, curiosity: 0.6, esteem: 0.3, hunger: 0.35, longing: 0.4 },
  boredom: 0.4,
  top: [
    { name: "missing", intensity: 0.6, cause: "Owen 很久沒上線", at: AT, person: "p1" },
    { name: "joy", intensity: 0.3, cause: "有人稱讚她", at: AT, person: null },
  ],
  mood: { valence: 0.2, arousal: 0.5, energy: 0.7 },
  mood_line: "心情不錯、有點想念",
  shown: { from: "missing", tag: "shy", style: "小聲、有點害羞", masked: true },
  biases: {
    talkativeness: 0.2,
    initiative: -0.1,
    wants: [
      { want: "rest", weight: 0.2, person: null, why: "精神還可以" },
      { want: "chat_with", weight: 0.7, person: "owen", why: "想念 0.6 × 在意 0.8,他在線" },
    ],
  },
};

const CARD: PersonCard = {
  person: "p1",
  handle: "owen",
  call_name: "歐文",
  affinity: 60,
  trust: 50,
  familiarity: 40,
  attachment: 0.5,
  emotions: { missing: 0.6, gratitude: 0.2 },
  feeling: "最近常陪我聊天,有點在意他",
  label: "好朋友",
  owner: true,
  blocked: false,
  last_seen: AT,
  last_together: null,
  updated_at: AT,
};

const SELF: SelfView = {
  at: AT,
  mood: { valence: 0.2, arousal: 0.5, energy: 0.7 },
  boredom: 0.4,
  drives: { social: 0.7, play: 0.5, attention: 0.3, rest: 0.2, curiosity: 0.6 },
  policy: { talkativeness: {}, initiative: 0.5, initiative_why: "" },
  agenda: [],
  feelings: [{ person: "p1", display_name: "Owen", text: "有點在意他", updated_at: AT, by: "self" }],
};

const WORLD: WorldView = {
  at: AT,
  time: { local: "2026-11-02 20:00", weekday: 1, weekend: false, part_of_day: "晚上", utc_offset_minutes: 480 },
  her: { voice: null, voice_name: null, golive: null, streaming: false, scene: null, game: null, singing: "小幸運" },
  people: [],
  voice_channels: [],
  channels: [],
};

const GOAL: Goal = {
  id: "G1",
  what: "找 Owen 問報告結果",
  why: "好幾天沒講話了",
  trigger: { kind: "when_online", person: "owen" },
  steps: ["先打招呼", "再問報告"],
  status: "pending",
  expires: "2026-11-03T12:00:00.000Z",
  person: "owen",
  context: null,
  source: "plan",
  created_at: AT,
  updated_at: AT,
  closed_at: null,
  close_reason: null,
};
const DONE: Goal = { ...GOAL, id: "G0", what: "玩一小時 MC", status: "done", trigger: { kind: "whenever" }, closed_at: AT };

function serve(extra?: Parameters<typeof mockFetch>[0]) {
  return mockFetch((method, url, body, headers) => {
    const custom = extra?.(method, url, body, headers);
    if (custom) return custom;
    switch (url.pathname) {
      case "/api/self":
        return { body: SELF };
      case "/api/world":
        return { body: WORLD };
      case "/api/affect":
        return { body: AFFECT };
      case "/api/affect/people":
        return { body: [CARD] };
      case "/api/mind/plan":
        return { body: { day_plan: "下午玩 MC,晚上陪 Owen 聊天" } satisfies DayPlanView };
      case "/api/mind/goals": {
        const closed = url.searchParams.get("closed") === "true";
        return { body: { goals: closed ? [GOAL, DONE] : [GOAL], closed_included: true } satisfies GoalsView };
      }
    }
    return undefined;
  });
}

describe("Inner: affect", () => {
  it("shows her mood, emotions, drives and the table from emotions to behaviour", async () => {
    serve();
    renderRoute("/inner?tab=affect");
    expect(await screen.findByLabelText("心情一句話")).toHaveTextContent("心情不錯、有點想念");
    expect(screen.getByText("在掩飾 · shy")).toBeInTheDocument();

    const emotions = screen.getByRole("table", { name: "情緒" });
    expect(within(emotions).getByText("想念")).toBeInTheDocument();
    expect(within(emotions).getByText("Owen 很久沒上線")).toBeInTheDocument();
    expect(within(emotions).getByRole("meter", { name: "想念 0.60" })).toBeInTheDocument();

    const drives = screen.getByLabelText("驅力");
    expect(within(drives).getByRole("meter", { name: "想被肯定 0.30" })).toBeInTheDocument();
    expect(within(drives).getByRole("meter", { name: "想靠近在意的人 0.40" })).toBeInTheDocument();

    const bias = screen.getByLabelText("行為偏移");
    expect(within(bias).getByText("+0.20")).toBeInTheDocument();
    expect(within(bias).getByText("-0.10")).toBeInTheDocument();
    const wants = screen.getByRole("table", { name: "她想做的事" });
    const rows = within(wants).getAllByRole("row").slice(1);
    // Strongest wish first, with the reason.
    expect(within(rows[0] as HTMLElement).getByText("找人聊天")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("想念 0.6 × 在意 0.8,他在線")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("休息")).toBeInTheDocument();
  });

  it("says so when the affect module is not running", async () => {
    serve((_m, url) => (url.pathname === "/api/affect" ? { status: 503, body: { error: "affect module is not available" } } : undefined));
    renderRoute("/inner?tab=affect");
    expect(await screen.findByText("服務未啟動")).toBeInTheDocument();
    expect(screen.getByText(/affect module is not available/)).toBeInTheDocument();
  });
});

describe("Inner: people cards", () => {
  it("shows one card per person above her older notes", async () => {
    serve();
    renderRoute("/inner?tab=feelings");
    const cards = await screen.findByRole("table", { name: "人物卡" });
    const link = within(cards).getByRole("link", { name: "歐文" });
    expect(link).toHaveAttribute("href", "/character?tab=people&person=p1");
    expect(within(cards).getByText("好朋友")).toBeInTheDocument();
    expect(within(cards).getByText("主人")).toBeInTheDocument();
    expect(within(cards).getByRole("meter", { name: "owen 好感 60" })).toBeInTheDocument();
    expect(within(cards).getByRole("meter", { name: "owen 在意 0.50" })).toBeInTheDocument();
    expect(within(cards).getByText("最近常陪我聊天,有點在意他")).toBeInTheDocument();
    expect(within(cards).getByText("想念 0.60 · 感激 0.20")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "感情" })).toBeInTheDocument();
  });

  it("still lists her notes when the cards are not available", async () => {
    serve((_m, url) => (url.pathname === "/api/affect/people" ? { status: 503, body: { error: "affect module is not available" } } : undefined));
    renderRoute("/inner?tab=feelings");
    expect(await screen.findByRole("table", { name: "感情" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "人物卡" })).toBeNull();
  });

  it("orders the emotions toward a person by strength", () => {
    expect(emotionsText({ ...CARD, emotions: { gratitude: 0.2, missing: 0.6, jealousy: 0 } })).toBe("想念 0.60 · 感激 0.20");
    expect(emotionsText({ ...CARD, emotions: {} })).toBe("");
  });
});

describe("Inner: goals", () => {
  it("shows today's plan and her goals, with the closed ones on request", async () => {
    const fetch = serve();
    const user = userEvent.setup();
    renderRoute("/inner?tab=goals");
    expect(await screen.findByText("下午玩 MC,晚上陪 Owen 聊天")).toBeInTheDocument();
    const goals = await screen.findByRole("table", { name: "目標" });
    expect(within(goals).getByText("找 Owen 問報告結果")).toBeInTheDocument();
    expect(within(goals).getByText("好幾天沒講話了")).toBeInTheDocument();
    expect(within(goals).getByText("owen 上線時")).toBeInTheDocument();
    expect(within(goals).getByText("先打招呼")).toBeInTheDocument();
    expect(within(goals).getByText("等待")).toBeInTheDocument();
    expect(within(goals).queryByText("玩一小時 MC")).toBeNull();

    await user.click(screen.getByRole("switch", { name: "含已結束的" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "目標" })).getByText("玩一小時 MC")).toBeInTheDocument());
    expect(fetch.mock.calls.some((c) => String(c[0]).includes("closed=true"))).toBe(true);
    expect(within(screen.getByRole("table", { name: "目標" })).getByText("有空就做")).toBeInTheDocument();
  });

  it("describes every kind of trigger", () => {
    expect(triggerText({ kind: "after_activity", activity: "game:minecraft" })).toBe("game:minecraft 結束後");
    expect(triggerText({ kind: "whenever" })).toBe("有空就做");
    expect(triggerText({ kind: "at", time: AT })).toMatch(/之後$/);
  });

  it("shows the day plan as missing without hiding the goals", async () => {
    serve((_m, url) => (url.pathname === "/api/mind/plan" ? { body: { day_plan: null } } : undefined));
    renderRoute("/inner?tab=goals");
    expect(await screen.findByText("今天還沒寫計畫")).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "目標" })).toBeInTheDocument();
  });
});

describe("Inner: what she is doing", () => {
  it("shows the song she is singing next to the game and the stream", async () => {
    serve();
    renderRoute("/inner");
    expect(await screen.findByText("唱 小幸運")).toBeInTheDocument();
  });
});

describe("live updates", () => {
  const custom = (topic: string, payload: unknown): Envelope =>
    ({ id: "E1", ts: AT, source: "test", event: { type: "custom", data: { topic, payload } } }) as unknown as Envelope;

  it("writes the new body and affect state straight into the cache", () => {
    const qc = new QueryClient();
    applyCustomEvent(qc, custom("activity.changed", { version: 9 }));
    expect(qc.getQueryData(queryKeys.activity)).toEqual({ version: 9 });
    applyCustomEvent(qc, custom("affect.changed", AFFECT));
    expect(qc.getQueryData(queryKeys.affect)).toEqual(AFFECT);
  });

  it("marks the lists stale for the other topics and ignores unknown ones", () => {
    const qc = new QueryClient();
    const stale = (key: readonly unknown[]) => {
      qc.setQueryData(key, []);
      return () => qc.getQueryState(key)?.isInvalidated === true;
    };
    const ledger = stale(queryKeys.ledger(undefined));
    const decisions = stale(queryKeys.arbiterDecisions({}));
    const goals = stale([...queryKeys.goals, false]);
    const outcomes = stale(queryKeys.turnOutcomes({}));
    const prompts = stale([...queryKeys.prompts, "list", 30]);
    const tasks = stale(queryKeys.activityTasks);
    applyCustomEvent(qc, custom("arbiter.decision", {}));
    applyCustomEvent(qc, custom("plan.goal", GOAL));
    applyCustomEvent(qc, custom("agent.turn.outcome", {}));
    applyCustomEvent(qc, custom("agent.prompt", {}));
    applyCustomEvent(qc, custom("activity.done", {}));
    applyCustomEvent(qc, custom("something.else", {}));
    expect([ledger(), decisions(), goals(), outcomes(), prompts(), tasks()]).toEqual([true, true, true, true, true, true]);
  });
});
