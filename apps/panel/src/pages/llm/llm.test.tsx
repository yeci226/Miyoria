import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LlmCallRecord, LlmCallStats, Thought } from "@/api/types";
import { mockFetch, renderRoute } from "@/test/render";

const CALL: LlmCallRecord = {
  id: "c1",
  at: "2026-11-03T10:00:00.000Z",
  purpose: "mind",
  chain: "mind",
  kind: "mind",
  model: "deepseek:deepseek-v4.1-flash",
  provider: "deepseek",
  status: "ok",
  fallbacks: [{ model: "local:qwen3-4b", error: "HTTP 503", kind: "http_5xx" }],
  retries: ["HTTP 429"],
  thinking: true,
  json_mode: true,
  tools: [],
  max_tokens: 2400,
  temperature: null,
  messages: 2,
  images: 0,
  usage: { prompt_tokens: 10_000, completion_tokens: 1_000, cached_prompt_tokens: 6_000, reasoning_tokens: 400 },
  first_token_ms: 1200,
  total_ms: 3400,
  cost_usd: (10_000 * 0.15 + 1_000 * 0.6) / 1e6,
  pricing: { input_per_mtok: 0.15, cached_input_per_mtok: null, output_per_mtok: 0.6 },
  finish_reason: "stop",
  error: null,
  error_kind: null,
  module: "mind",
  turn: null,
  thought: "t1",
  label: "thought",
  repair: null,
  text_chars: 40,
  reasoning_chars: 12,
  tool_calls: 0,
  has_detail: true,
};

const STATS: LlmCallStats = {
  since: null,
  total: { key: "all", calls: 1, errors: 0, prompt_tokens: 10_000, cached_prompt_tokens: 6_000, completion_tokens: 1_000, reasoning_tokens: 400, cost_usd: CALL.cost_usd ?? 0, p50_ms: 1200, p95_ms: 1200, total_p50_ms: 3400 },
  by_purpose: [{ key: "mind", calls: 1, errors: 0, prompt_tokens: 10_000, cached_prompt_tokens: 6_000, completion_tokens: 1_000, reasoning_tokens: 400, cost_usd: 0.0021, p50_ms: 1200, p95_ms: 1200, total_p50_ms: 3400 }],
  by_model: [{ key: "deepseek:deepseek-v4.1-flash", calls: 1, errors: 0, prompt_tokens: 10_000, cached_prompt_tokens: 6_000, completion_tokens: 1_000, reasoning_tokens: 400, cost_usd: 0.0021, p50_ms: 1200, p95_ms: 1200, total_p50_ms: 3400 }],
  by_module: [],
  by_hour: [],
  latency: [{ le_ms: 2000, count: 1 }],
  errors: [],
  finish_reasons: [{ reason: "stop", count: 1 }],
  expensive: [CALL],
  slowest: [CALL],
  kept: 1,
  oldest: CALL.at,
  prices: { "deepseek:deepseek-v4.1-flash": { input_per_mtok: 0.15, cached_input_per_mtok: null, output_per_mtok: 0.6 } },
};

describe("LLM call inspector", () => {
  it("filters the calls and opens one with its price, fallbacks, reasoning and redacted messages", async () => {
    const asked: URL[] = [];
    mockFetch((_m, url) => {
      if (url.pathname === "/api/llm/stats") return { body: STATS };
      if (url.pathname === "/api/llm/calls") {
        asked.push(url);
        return { body: { items: [CALL], next_cursor: null, matched: 1, kept: 1 } };
      }
      if (url.pathname === "/api/llm/calls/c1")
        return {
          body: {
            call: CALL,
            detail: {
              messages: [{ role: "user", name: null, content: "api_key=[已遮蔽] 在嗎", cut: 0, tool_calls: [], tool_call_id: null }],
              tools: [],
              response: { text: '{"thought":"好"}', reasoning: "先想一下要不要開口", tool_calls: [], cut: 0 },
            },
          },
        };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/llm?tab=calls&purpose=mind");
    const table = await screen.findByRole("table", { name: "LLM 呼叫" });
    expect(within(table).getByText("內心想法")).toBeInTheDocument();
    expect(asked.at(-1)?.searchParams.get("purpose")).toBe("mind");

    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(asked.at(-1)?.searchParams.get("trouble")).toBe("true"));

    const rows = await screen.findByRole("table", { name: "LLM 呼叫" });
    await user.click(within(rows).getByText("內心想法"));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("先想一下要不要開口")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("第 1 則訊息(user)")).toHaveTextContent("api_key=[已遮蔽] 在嗎");
    // Price used: 4,000 uncached at $0.150, 6,000 cached at the input price, 1,000 out at $0.600.
    expect(within(sheet).getByText("輸入(快取命中)").closest("tr")).toHaveTextContent("6,000");
    expect(within(sheet).getAllByText("$0.150").length).toBeGreaterThan(0);
    expect(within(sheet).getByText("換下一個模型")).toBeInTheDocument();
    expect(within(sheet).getByText("重送第 1 次")).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: /她的想法/ })).toHaveAttribute("href", "/inner?tab=thoughts&thought=t1");
  });

  it("shows each call's chain of thought, filtered by kind", async () => {
    const asked: URL[] = [];
    const voice: LlmCallRecord = { ...CALL, id: "c2", kind: "voice", module: "agent", label: "voice", purpose: "chat" };
    mockFetch((_m, url) => {
      if (url.pathname === "/api/llm/thinking") {
        asked.push(url);
        const kind = url.searchParams.get("kind");
        const items = [
          { call: CALL, reasoning: "先想一下要不要開口", answer: '{"thought":"好"}', tool_calls: [], cut: 0 },
          { call: voice, reasoning: "他在問天氣,簡短回就好", answer: "今天會下雨喔", tool_calls: [], cut: 0 },
        ].filter((t) => !kind || t.call.kind === kind);
        return {
          body: {
            items,
            next_cursor: null,
            matched: items.length,
            by_kind: [
              { kind: "mind", calls: 3, reasoned: 1 },
              { kind: "voice", calls: 2, reasoned: 1 },
            ],
            kept: 5,
          },
        };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/llm?tab=thinking");
    const list = await screen.findByRole("list", { name: "思路" });
    expect(within(list).getByText("先想一下要不要開口")).toBeInTheDocument();
    expect(within(list).getByText("他在問天氣,簡短回就好")).toBeInTheDocument();
    expect(asked.at(-1)?.searchParams.get("reasoned")).toBe("true");

    await user.click(screen.getByRole("radio", { name: /語音/ }));
    await waitFor(() => expect(asked.at(-1)?.searchParams.get("kind")).toBe("voice"));
    await waitFor(() => expect(screen.queryByText("先想一下要不要開口")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /看回覆/ }));
    expect(screen.getByLabelText("回覆")).toHaveTextContent("今天會下雨喔");
  });

  it("breaks the calls down with prices per model", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/llm/stats" ? { body: STATS } : undefined));
    renderRoute("/llm");
    const models = await screen.findByRole("table", { name: "依模型" });
    expect(within(models).getByText("$0.150 / $0.600")).toBeInTheDocument();
    expect(screen.getByLabelText("LLM 概況")).toHaveTextContent("60%");
  });
});

describe("thought in full", () => {
  it("shows what she saw, the reasoning, the changes, each intent's lifecycle and her calls", async () => {
    const thought: Thought = {
      id: "t1",
      at: "2026-11-03T10:00:00.000Z",
      triggers: [{ kind: "suggestion", detail: "#聊天 安靜了", context: null, at: "2026-11-03T10:00:00.000Z" }],
      thought: "去接 Kuro 的話。",
      changes: ["慾望 play +0.05"],
      intents: [
        {
          id: "i1",
          capability: "chat.start",
          args: {},
          why: "接話",
          opening: null,
          context: null,
          about: null,
          expires_at: "2026-11-03T10:10:00.000Z",
          status: "done",
          detail: null,
          turn: "turn1",
          decisions: [{ at: "2026-11-03T10:00:01.000Z", capability: "chat.start", allowed: true, stage: "permission", reason: "ok" }],
          said: "Kuro 你在蓋什麼?",
          history: [
            { at: "2026-11-03T10:00:00.000Z", status: "pending", detail: null },
            { at: "2026-11-03T10:00:01.000Z", status: "started", detail: "her turn is queued" },
            { at: "2026-11-03T10:00:05.000Z", status: "done", detail: null },
          ],
        },
      ],
      tokens: 3000,
      error: null,
      ms: 2500,
      suggestions: [{ source: "initiative", reason: "idle_channel", context: null, hint: "#聊天 安靜了 12 分鐘", about: [] }],
      input: {
        time: "2026-11-03 18:00(星期二,傍晚)",
        night: false,
        self: { mood: { valence: 0.3, arousal: 0.4, energy: 0.6 }, boredom: 0.4, drives: { play: 0.5 }, initiative: 0.5 },
        suggestions: [],
        world: "語音「雜談」:Owen",
        places: [{ ref: "p1", label: "文字頻道 #聊天", note: "最近 3 則", here: false }],
        people: [{ ref: "u1", name: "Kuro", person: null, relation: "認識", feeling: null, doing: "玩 Minecraft" }],
        agenda: [],
        memories: null,
        documents: null,
        lessons: [],
        recap: null,
        digest: null,
        unanswered: [],
        blocked: [],
        idle: { thoughts: 3, minutes: 20 },
        capabilities: ["chat.start"],
        recent: 5,
      },
      reasoning: "Kuro 在玩,接他的話最自然",
      effects: { drives: { play: 0.05 }, talkativeness: [], initiative: null, feelings: [], agenda_added: [], agenda_done: [], agenda_dropped: [], documents: [] },
      calls: ["c1"],
      cost_usd: 0.0021,
      attempts: 1,
      idle: { thoughts: 3, minutes: 20 },
    };
    mockFetch((_m, url) => {
      if (url.pathname === "/api/mind/thoughts/t1") return { body: thought };
      if (url.pathname === "/api/llm/calls") return { body: { items: [CALL], next_cursor: null, matched: 1, kept: 1 } };
      return undefined;
    });
    renderRoute("/inner?tab=thoughts&thought=t1");
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("去接 Kuro 的話。")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("模型的推理")).toHaveTextContent("Kuro 在玩");
    expect(within(sheet).getByText("想玩 +0.05")).toBeInTheDocument();
    expect(within(sheet).getByText("#聊天 安靜了 12 分鐘")).toBeInTheDocument();
    expect(within(sheet).getByText("連續 3 次想了沒行動 · 大約 20 分鐘")).toBeInTheDocument();
    const steps = within(sheet).getByRole("list", { name: "經過" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent?.slice(0, 3))).toEqual(["等待1", "進行中", "完成1"]);
    expect(within(sheet).getByText("Kuro 你在蓋什麼?")).toBeInTheDocument();
    expect(within(sheet).getByText("文字頻道 #聊天")).toBeInTheDocument();
    expect(await within(sheet).findByRole("link", { name: /內心想法/ })).toHaveAttribute("href", "/llm?tab=calls&thought=t1&call=c1");
  });
});
