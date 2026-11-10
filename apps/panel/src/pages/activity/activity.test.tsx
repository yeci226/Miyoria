import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  ActivitySnapshot,
  ActivityTask,
  ArbiterDecisionView,
  DecisionRecord,
  LedgerView,
  PromptSummary,
  SavedPrompt,
  TurnOutcomeRecord,
} from "@/api/types";
import { mockFetch, renderRoute } from "@/test/render";

const AT = "2026-11-02T12:00:00.000Z";
const CTX = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const VOICE = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;

const SNAPSHOT: ActivitySnapshot = {
  version: 7,
  at: AT,
  presence: { type: "in", channel: VOICE, since: AT },
  broadcast: { type: "live", guild: "g1", golive: true, obs: false, task: null, since: AT },
  activity: { type: "game", target: "minecraft", phase: "running", task: "T1", failure: null, since: AT },
  override: { scene: "Intermission", until: "2026-11-02T12:30:00.000Z", by: "panel" },
  scene: "Intermission",
};

const TASKS: ActivityTask[] = [
  {
    id: "T2",
    resource: "broadcast",
    request: { type: "ensure_live", platform: "discord", guild: "g1", source: null },
    by: "self",
    turn: "TURN1",
    context: CTX,
    status: "failed",
    created_at: AT,
    ended_at: AT,
    failure: { code: "precondition", detail: "OBS 沒開", at: AT },
    detail: null,
  },
  {
    id: "T1",
    resource: "activity",
    request: { type: "start", activity: "game", target: "minecraft", goal: null },
    by: "discord:1",
    turn: null,
    context: null,
    status: "done",
    created_at: AT,
    ended_at: AT,
    failure: null,
    detail: "Minecraft 開好了",
  },
];

const LEDGER: LedgerView = {
  at: AT,
  entries: [
    {
      id: "L1",
      at: AT,
      kind: "impulse",
      source: "plan",
      self_initiated: true,
      context: CTX,
      person: null,
      summary: "找 Owen 聊報告",
      outcome: "denied",
      detail: "今天主動開了 5 次",
      impulse: "I1",
      turn: "TURN1",
      task: null,
      updated_at: AT,
    },
  ],
  limits: {
    initiatives_today: 5,
    initiative_cap: 5,
    unanswered_streak: 2,
    next_initiative_at: "2026-11-02T13:40:00.000Z",
    quiet_hours: { start_hour: 2, end_hour: 8, active: false },
    paused: false,
    blocked: [{ capability: "game.start", reason: "Minecraft 沒開", until: null }],
  },
  unanswered: [{ text: "你們看過鯨魚嗎", context: CTX, at: AT, status: "ignored" }],
};

const DECISIONS: ArbiterDecisionView[] = [
  {
    impulse: "I1",
    source: "plan",
    verdict: "rejected",
    reason: "rate",
    detail: "今天主動開了 5 次,下次 21:40 之後",
    retry_at: null,
    merged_into: null,
    turn: null,
    task: null,
    at: AT,
    context: CTX,
    summary: "找 Owen 聊報告",
  },
  {
    impulse: "I2",
    source: "message",
    verdict: "accepted",
    reason: null,
    detail: "",
    retry_at: null,
    merged_into: null,
    turn: "TURN1",
    task: null,
    at: AT,
    context: null,
    summary: null,
  },
];

const SUMMARY: PromptSummary = {
  turn: "TURN1",
  context: CTX,
  at: AT,
  purpose: "chat",
  reasoning: "low",
  prompt_tokens: 321,
  blocks: 2,
  messages: 2,
  chars: 40,
};

const PROMPT: SavedPrompt = {
  turn: "TURN1",
  context: CTX,
  at: AT,
  purpose: "chat",
  reasoning: "low",
  blocks: [
    { key: "mood", authority: "self", source: "affect", chars_in: 120, chars_out: 80, budget_chars: 100, fate: "truncated" },
    { key: "people", authority: "data", source: "social", chars_in: 30, chars_out: 30, budget_chars: 100, fate: "kept" },
  ],
  messages: [
    { role: "system", text: "你是 Miyoria,一個愛聊天的 VTuber。" },
    { role: "user", text: "Owen:你今天怎麼樣" },
  ],
  prompt_tokens: 321,
};

const OUTCOMES: TurnOutcomeRecord[] = [
  {
    turn: "TURN1",
    context: CTX,
    reason: "addressed",
    outcome: { type: "cancelled", cause: "barge_in", by: "owen" },
    addressed_by: ["owen"],
    focus: [],
    restarts: 1,
    reasoning: "low",
    latency_ms: 850,
    at: AT,
  },
  {
    turn: "TURN2",
    context: CTX,
    reason: "ambient",
    outcome: { type: "sent", parts: 2 },
    addressed_by: [],
    focus: [],
    restarts: 0,
    reasoning: null,
    latency_ms: null,
    at: AT,
  },
];

const DECISION_RECORD: DecisionRecord = {
  id: "D1",
  profile: "p",
  ts: AT,
  trace: { turn: "TURN1", context: CTX, respond: true, score: 0.82, reasons: ["有人叫她的名字"] },
};

function serve(extra?: Parameters<typeof mockFetch>[0]) {
  return mockFetch((method, url, body, headers) => {
    const custom = extra?.(method, url, body, headers);
    if (custom) return custom;
    switch (url.pathname) {
      case "/api/activity":
        return { body: SNAPSHOT };
      case "/api/activity/tasks":
        return { body: TASKS };
      case "/api/arbiter/ledger":
        return { body: LEDGER };
      case "/api/arbiter/decisions": {
        const verdict = url.searchParams.get("verdict");
        return { body: { decisions: verdict ? DECISIONS.filter((d) => d.verdict === verdict) : DECISIONS } };
      }
      case "/api/prompts":
        return { body: [SUMMARY, { ...SUMMARY, turn: "TURN2", prompt_tokens: null, chars: 900 }] };
      case "/api/prompts/TURN1":
        return { body: PROMPT };
      case "/api/prompts/TURN2":
        return { status: 404, body: { error: "no saved prompt for that turn (too old or not kept)" } };
      case "/api/turns/outcomes":
        return { body: OUTCOMES };
      case "/api/decisions":
        return { body: [DECISION_RECORD] };
    }
    return undefined;
  });
}

describe("Activity: what she is doing", () => {
  it("shows presence, broadcast, activity and scene with the recent tasks", async () => {
    serve();
    renderRoute("/activity?tab=body");
    const state = await screen.findByRole("group", { name: "她現在的狀態" }).catch(() => screen.findByLabelText("她現在的狀態"));
    expect(within(state).getByText("在語音")).toBeInTheDocument();
    expect(within(state).getByText("語音 v1")).toBeInTheDocument();
    expect(within(state).getByText("直播中")).toBeInTheDocument();
    expect(within(state).getByText("Go Live · OBS 未開")).toBeInTheDocument();
    expect(within(state).getByText("玩遊戲")).toBeInTheDocument();
    expect(within(state).getByText("進行中 · minecraft")).toBeInTheDocument();
    expect(within(state).getByText("Intermission")).toBeInTheDocument();
    expect(within(state).getByText(/暫時切換到/)).toBeInTheDocument();

    const tasks = await screen.findByRole("table", { name: "活動任務" });
    expect(within(tasks).getByText("開台")).toBeInTheDocument();
    expect(within(tasks).getByText("條件不足:OBS 沒開")).toBeInTheDocument();
    expect(within(tasks).getByText("開始玩遊戲(minecraft)")).toBeInTheDocument();
    expect(within(tasks).getByText("Minecraft 開好了")).toBeInTheDocument();
    expect(within(tasks).getByRole("link", { name: "那回合的提示詞" })).toHaveAttribute(
      "href",
      "/activity?tab=prompts&turn=TURN1",
    );
  });

  it("says so when the activity module is not running", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/activity" || url.pathname === "/api/activity/tasks"
        ? { status: 503, body: { error: "activity manager is not available" } }
        : undefined,
    );
    renderRoute("/activity?tab=body");
    expect((await screen.findAllByText("服務未啟動")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/activity manager is not available/).length).toBeGreaterThan(0);
  });
});

describe("Activity: the arbiter ledger", () => {
  it("shows her limits, why things are blocked, the ledger and the verdicts", async () => {
    const fetch = serve();
    const user = userEvent.setup();
    renderRoute("/activity?tab=ledger");

    const limits = await screen.findByLabelText("限制");
    expect(within(limits).getByText("今天主動開的次數")).toBeInTheDocument();
    expect(within(limits).getByText("上限 5 次")).toBeInTheDocument();
    expect(within(limits).getByText("現在不是")).toBeInTheDocument();

    const blocked = screen.getByRole("table", { name: "被擋住的能力" });
    expect(within(blocked).getByText("game.start")).toBeInTheDocument();
    expect(within(blocked).getByText("Minecraft 沒開")).toBeInTheDocument();

    const topics = screen.getByRole("list", { name: "沒人接的話題" });
    expect(within(topics).getByText("你們看過鯨魚嗎")).toBeInTheDocument();

    const ledger = screen.getByRole("table", { name: "帳本" });
    expect(within(ledger).getByText("找 Owen 聊報告")).toBeInTheDocument();
    expect(within(ledger).getByText("被擋下")).toBeInTheDocument();
    expect(within(ledger).getByRole("link", { name: "看這回合" })).toHaveAttribute("href", "/activity?tab=prompts&turn=TURN1");

    const verdicts = await screen.findByRole("table", { name: "裁決" });
    expect(within(verdicts).getByText("擋下")).toBeInTheDocument();
    expect(within(verdicts).getByText("次數上限")).toBeInTheDocument();
    expect(within(verdicts).getByText(/下次 21:40 之後/)).toBeInTheDocument();
    expect(within(verdicts).getByText("通過")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "裁決結果" }));
    await user.click(await screen.findByRole("option", { name: "擋下" }));
    await waitFor(() => {
      const calls = fetch.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/arbiter/decisions") && u.includes("verdict=rejected"))).toBe(true);
    });
    await waitFor(() => expect(within(screen.getByRole("table", { name: "裁決" })).queryByText("通過")).toBeNull());
  });
});

describe("Activity: the prompt of each turn", () => {
  it("lists the turns with how they ended and opens the prompt next to the outcome", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/activity?tab=prompts");

    const list = await screen.findByRole("list", { name: "提示詞列表" });
    await waitFor(() => expect(within(list).getByText("被打斷(owen)")).toBeInTheDocument());
    expect(within(list).getByText("說了 2 則")).toBeInTheDocument();
    expect(within(list).getByText("321 tok")).toBeInTheDocument();

    await user.click(within(list).getByText("被打斷(owen)"));
    const sheet = await screen.findByRole("dialog");
    // The decision trace, the outcome and the prompt of the same turn.
    expect(await within(sheet).findByText("有人叫她的名字")).toBeInTheDocument();
    const outcome = within(sheet).getByRole("region", { name: "這回合的結果" });
    expect(within(outcome).getByText("取消")).toBeInTheDocument();
    expect(within(outcome).getByText("被叫到")).toBeInTheDocument();
    expect(within(outcome).getByText("850 ms")).toBeInTheDocument();
    const prompt = await within(sheet).findByRole("region", { name: "這回合的提示詞" });
    const blocks = await within(prompt).findByRole("table", { name: "提示詞區塊" });
    expect(within(blocks).getByText("mood")).toBeInTheDocument();
    expect(within(blocks).getByText("截斷")).toBeInTheDocument();
    expect(within(blocks).getByText("她自己的狀態")).toBeInTheDocument();
    expect(within(prompt).getByText("你是 Miyoria,一個愛聊天的 VTuber。")).toBeInTheDocument();
    expect(within(prompt).getByText("Owen:你今天怎麼樣")).toBeInTheDocument();
  });

  it("filters the turns by outcome", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/activity?tab=prompts");
    const list = await screen.findByRole("list", { name: "提示詞列表" });
    await waitFor(() => expect(within(list).getByText("說了 2 則")).toBeInTheDocument());
    await user.click(screen.getByRole("combobox", { name: "結果" }));
    await user.click(await screen.findByRole("option", { name: "取消" }));
    expect(within(screen.getByRole("list", { name: "提示詞列表" })).queryByText("說了 2 則")).toBeNull();
    expect(within(screen.getByRole("list", { name: "提示詞列表" })).getByText("被打斷(owen)")).toBeInTheDocument();
  });

  it("opens a turn from a link and says when its prompt was not kept", async () => {
    serve();
    renderRoute("/activity?turn=TURN2");
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("這回合的提示詞沒有留下(太舊,或沒有存)")).toBeInTheDocument();
    expect(await within(sheet).findByText("說了 2 則")).toBeInTheDocument();
  });

  it("shows the outcome and the prompt inside a decision, too", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/activity?tab=decisions");
    await user.click(await screen.findByRole("button", { name: /有人叫她的名字/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("有人叫她的名字")).toBeInTheDocument();
    expect(await within(sheet).findByText("被打斷(owen)")).toBeInTheDocument();
    expect(await within(sheet).findByRole("table", { name: "提示詞區塊" })).toBeInTheDocument();
  });

  it("keeps working on a Core without the new routes", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/decisions" ? { body: [DECISION_RECORD] } : undefined));
    const user = userEvent.setup();
    renderRoute("/activity?tab=decisions");
    await user.click(await screen.findByRole("button", { name: /有人叫她的名字/ }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("沒有這回合的結果紀錄")).toBeInTheDocument();
    expect(await within(sheet).findByText("這個 Core 還沒有提供提示詞")).toBeInTheDocument();
  });
});
