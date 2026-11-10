import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  ChannelLevelsView,
  ConversationNote,
  KnowledgeView,
  MindView,
  PendingApproval,
  ReflectionView,
  SelfView,
  TelemetryPoint,
  Thought,
  WorldView,
} from "@/api/types";
import { mockFetch, renderRoute } from "@/test/render";

const SELF: SelfView = {
  at: "2026-11-02T12:00:00.000Z",
  mood: { valence: 0.3, arousal: 0.4, energy: 0.8 },
  boredom: 0.62,
  drives: { social: 0.8, play: 0.5, attention: 0.3, rest: 0.2, curiosity: 0.4 },
  policy: {
    talkativeness: {
      "discord:g1:voice:v1": { level: 0.7, until: null, why: "大家在玩遊戲很熱鬧", set_at: "2026-11-02T11:00:00.000Z" },
      "*": { level: 0.4, until: "2026-11-02T13:00:00.000Z", why: "", set_at: "2026-11-02T11:00:00.000Z" },
    },
    initiative: 0.55,
    initiative_why: "今天想多找人聊",
  },
  agenda: [
    {
      id: "a1",
      text: "等 Owen 上線問他報告結果",
      why: "他昨天說今天會交",
      person: "p1",
      context: null,
      created_at: "2026-11-02T11:00:00.000Z",
      due: null,
      expires_at: null,
      status: "open",
      closed_at: null,
    },
    {
      id: "a2",
      text: "去語音看看",
      why: "",
      person: null,
      context: null,
      created_at: "2026-11-02T10:00:00.000Z",
      due: null,
      expires_at: "2026-11-02T10:30:00.000Z",
      status: "expired",
      closed_at: "2026-11-02T10:30:00.000Z",
    },
  ],
  feelings: [
    { person: "p1", display_name: "Owen", text: "最近常陪我聊天,有點在意他", updated_at: "2026-11-02T11:30:00.000Z", by: "self" },
  ],
};

const WORLD: WorldView = {
  at: "2026-11-02T12:00:00.000Z",
  time: { local: "2026-11-02 20:00", weekday: 1, weekend: false, part_of_day: "晚上", utc_offset_minutes: 480 },
  her: {
    voice: { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
    voice_name: "雜談",
    golive: null,
    streaming: true,
    scene: "Gaming",
    game: "Minecraft",
  },
  people: [
    {
      account: { platform: "discord", id: "1" },
      person: "p1",
      display_name: "Owen",
      status: "online",
      activities: [
        { type: "playing", name: "Minecraft", details: null, state: null, started_at: null, url: null },
        { type: "listening", name: "Spotify", details: "Song", state: "Artist", started_at: null, url: null },
      ],
      voice: { platform: "discord", guild: "g1", channel: "v1", channel_name: "雜談" },
      online_since: null,
      updated_at: "2026-11-02T11:00:00.000Z",
    },
    {
      account: { platform: "discord", id: "2" },
      person: null,
      display_name: "Bob",
      status: null,
      activities: [],
      voice: { platform: "discord", guild: "g1", channel: "v1", channel_name: "雜談" },
      online_since: null,
      updated_at: "2026-11-02T11:00:00.000Z",
    },
  ],
  voice_channels: [
    {
      platform: "discord",
      guild: "g1",
      channel: "v1",
      name: "雜談",
      members: [
        { account: { platform: "discord", id: "1" }, person: "p1", display_name: "Owen", is_self: false, muted: true, deafened: false, video: false, streaming: true, since: "2026-11-02T11:00:00.000Z" },
        { account: { platform: "discord", id: "7" }, person: null, display_name: "DeepSeek-chan", is_self: true, muted: false, deafened: false, video: false, streaming: false, since: "2026-11-02T11:00:00.000Z" },
      ],
    },
  ],
  channels: [
    {
      context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
      label: "Miyoria / 雜談",
      recent_messages: 12,
      per_minute: 1.2,
      last_at: "2026-11-02T11:59:00.000Z",
      recent_authors: ["Owen", "Bob"],
      topic: ["鯨魚", "minecraft"],
      lively: true,
      her_last_at: null,
    },
  ],
};

const THOUGHT: Thought = {
  id: "t1",
  at: "2026-11-02T11:59:00.000Z",
  triggers: [{ kind: "salient", detail: "Owen 進了語音頻道「雜談」", context: null, at: "2026-11-02T11:59:00.000Z" }],
  thought: "Owen 進語音了耶……就說我剛好路過。",
  changes: ["多話程度 voice 0.80(30 分鐘)"],
  intents: [
    {
      id: "i1",
      capability: "voice.join",
      args: { channel: "v1" },
      why: "想找 Owen 聊天",
      opening: "假裝路過",
      context: { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
      about: { platform: "discord", id: "1" },
      expires_at: "2026-11-02T12:01:00.000Z",
      status: "done",
      detail: "joined voice channel v1",
      turn: "turn1",
      decisions: [
        { at: "2026-11-02T11:59:01.000Z", capability: "voice.join", allowed: true, stage: "rate", reason: "within limits" },
      ],
      said: "我只是剛好路過喔。",
    },
    {
      id: "i2",
      capability: "chat.dm",
      args: { to: "2" },
      why: "",
      opening: null,
      context: null,
      about: { platform: "discord", id: "2" },
      expires_at: "2026-11-02T12:01:00.000Z",
      status: "denied",
      detail: "the person opted out of DMs from her",
      turn: "turn2",
      decisions: [
        {
          at: "2026-11-02T11:59:01.000Z",
          capability: "chat.dm",
          allowed: false,
          stage: "consent",
          reason: "the person opted out of DMs from her",
        },
      ],
      said: null,
    },
  ],
  tokens: 1500,
  error: null,
  ms: 4200,
};

const APPROVAL: PendingApproval = {
  id: "ap1",
  capability: "tool.propose",
  summary: "寫一個小工具",
  principal: "self",
  args: {},
  why: "想幫大家算分數",
  review: "不確定會不會被濫用",
  requested_at: "2026-11-02T11:58:00.000Z",
  expires_at: "2026-11-02T12:08:00.000Z",
};

function mindView(paused: boolean, approvals: number): MindView {
  return {
    paused,
    running: true,
    accepting: !paused,
    stats: {
      calls_last_hour: 3,
      max_calls_per_hour: 12,
      calls_total: 40,
      tokens_total: 52_000,
      last_at: "2026-11-02T11:59:00.000Z",
      next_heartbeat_at: "2026-11-02T12:10:00.000Z",
      idle_reason: paused ? "paused" : null,
    },
    pending_approvals: approvals,
  };
}

const LEVEL_INFO: ChannelLevelsView["levels"] = [
  { mode: "off", label: "關閉", description: "完全不說話" },
  { mode: "mention-only", label: "只回提及", description: "只在被提及時回覆" },
  { mode: "quiet", label: "安靜", description: "很少插話" },
  { mode: "normal", label: "一般", description: "有時會自己加入對話" },
  { mode: "lively", label: "活躍", description: "比較常加入對話" },
];

function levels(mode: string, custom: boolean): ChannelLevelsView {
  return {
    levels: LEVEL_INFO,
    channels: [
      {
        context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
        label: "Miyoria / 雜談",
        mode,
        custom,
        default: "quiet",
      },
    ],
  };
}

function serve() {
  let level = levels("quiet", false);
  const fetch = mockFetch((method, url, body) => {
    if (url.pathname === "/api/self") return { body: SELF };
    if (url.pathname === "/api/world") return { body: WORLD };
    if (url.pathname === "/api/channels/levels") return { body: level };
    if (method === "PUT" && url.pathname === "/api/channels/level") {
      const mode = (body as { mode: string | null }).mode;
      level = levels(mode ?? "quiet", mode !== null);
      return { body: level.channels[0] };
    }
    return undefined;
  });
  return fetch;
}

describe("Inner", () => {
  it("shows her state, policy and agenda with what she is doing", async () => {
    serve();
    renderRoute("/inner");
    // Without telemetry (an older Core) the state shows as current values.
    await screen.findByRole("meter", { name: "想聊天 0.80" });
    const list = screen.getByLabelText("她的狀態");
    expect(within(list).getByText("心情")).toBeInTheDocument();
    expect(within(list).getByText("想聊天")).toBeInTheDocument();
    expect(within(list).getByRole("meter", { name: "想聊天 0.80" })).toBeInTheDocument();
    expect(within(list).getByRole("meter", { name: "無聊 0.62" })).toBeInTheDocument();

    const talk = screen.getByRole("table", { name: "多話程度" });
    expect(within(talk).getByText("語音 v1")).toBeInTheDocument();
    expect(within(talk).getByText("所有地方")).toBeInTheDocument();
    expect(within(talk).getByText("大家在玩遊戲很熱鬧")).toBeInTheDocument();
    expect(screen.getByText("今天想多找人聊")).toBeInTheDocument();

    const agenda = screen.getByRole("table", { name: "議程" });
    expect(within(agenda).getByText("等 Owen 上線問他報告結果")).toBeInTheDocument();
    expect(within(agenda).getByText("過期")).toBeInTheDocument();

    expect(await screen.findByText("直播中")).toBeInTheDocument();
    expect(screen.getByText("玩 Minecraft")).toBeInTheDocument();
    expect(screen.getByText("在語音「雜談」")).toBeInTheDocument();
    expect(screen.getByText("星期一 晚上 20:00")).toBeInTheDocument();
  });

  it("lists her feelings and the world on their tabs", async () => {
    serve();
    const user = userEvent.setup();
    renderRoute("/inner");
    await user.click(await screen.findByRole("tab", { name: "感情" }));
    const feelings = await screen.findByRole("table", { name: "感情" });
    expect(within(feelings).getByRole("link", { name: "Owen" })).toHaveAttribute(
      "href",
      "/character?tab=people&person=p1",
    );
    expect(within(feelings).getByText("最近常陪我聊天,有點在意他")).toBeInTheDocument();
    expect(within(feelings).getByText("她")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "世界" }));
    const people = await screen.findByRole("table", { name: "在線的人" });
    const owen = within(people).getByText("Owen").closest("tr") as HTMLElement;
    expect(within(owen).getByText("在線")).toBeInTheDocument();
    expect(within(owen).getByText("玩 Minecraft、聽 Song — Artist")).toBeInTheDocument();
    // No presence for Bob (opted out): a dash.
    const bob = within(people).getByText("Bob").closest("tr") as HTMLElement;
    expect(within(bob).getAllByText("—").length).toBeGreaterThan(0);

    const voice = screen.getByRole("region", { name: "雜談" });
    expect(within(voice).getByText("她")).toBeInTheDocument();
    expect(within(voice).getByLabelText("分享螢幕")).toBeInTheDocument();
    expect(within(voice).getByLabelText("靜音")).toBeInTheDocument();

    const channels = screen.getByRole("table", { name: "文字頻道" });
    expect(within(channels).getByText("Miyoria / 雜談")).toBeInTheDocument();
    expect(within(channels).getByText("熱鬧")).toBeInTheDocument();
    expect(within(channels).getByText("鯨魚、minecraft")).toBeInTheDocument();
  });

  it("charts her state over time from the telemetry, ending at the live values", async () => {
    const now = Date.now();
    const point = (minsAgo: number, social: number): TelemetryPoint => ({
      at: new Date(now - minsAgo * 60_000).toISOString(),
      mood: { valence: 0.1, arousal: 0.4, energy: 0.6 },
      boredom: 0.3,
      drives: { social, play: 0.5, attention: 0.3, rest: 0.2, curiosity: 0.4 },
      initiative: 0.5,
      llm: { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0, cost_usd: 0, errors: 0, first_token: { count: 0, sum_s: 0, buckets: [] } },
      mind: null,
      voice_sessions: 0,
      speaking: false,
      events: {},
    });
    const live = { ...SELF, at: new Date(now).toISOString() };
    mockFetch((_m, url) => {
      if (url.pathname === "/api/self") return { body: live };
      if (url.pathname === "/api/world") return { body: WORLD };
      if (url.pathname === "/api/telemetry") return { body: { interval_ms: 60_000, points: [point(30, 0.1), point(10, 0.4)] } };
      return undefined;
    });
    renderRoute("/inner");
    const state = await screen.findByRole("region", { name: "她的狀態" });
    // The newest value is the live one (0.80), not the last sample (0.40).
    const [social] = await within(state).findAllByText("想聊天");
    expect(social?.parentElement).toHaveTextContent("0.80");
    // Each chart carries its values as a table for screen readers.
    const table = within(state).getByRole("table", { name: "想聊天走勢" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(state).getByRole("radiogroup", { name: "時間範圍" })).toBeInTheDocument();
  });

  it("says when the modules are not running", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/self" || url.pathname === "/api/world"
        ? { status: 503, body: { error: "self module is not available" } }
        : undefined,
    );
    renderRoute("/inner");
    expect(await screen.findByText("服務未啟動")).toBeInTheDocument();
    expect(screen.getByText(/self module is not available/)).toBeInTheDocument();
  });

  it("shows her thoughts with intents and gate outcomes, approvals and the pause switch", async () => {
    let paused = false;
    let pending: PendingApproval[] = [APPROVAL];
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/mind") return { body: mindView(paused, pending.length) };
      if (url.pathname === "/api/mind/thoughts") return { body: [THOUGHT] };
      if (url.pathname === "/api/mind/approvals") return { body: pending };
      if (method === "POST" && url.pathname === "/api/mind/pause") {
        paused = true;
        return { body: mindView(true, pending.length) };
      }
      if (method === "POST" && url.pathname === `/api/mind/approvals/${APPROVAL.id}/approve`) {
        pending = [];
        return { body: [] };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/inner?tab=thoughts");

    const timeline = await screen.findByRole("list", { name: "想法時間軸" });
    expect(within(timeline).getByText("Owen 進語音了耶……就說我剛好路過。")).toBeInTheDocument();
    expect(within(timeline).getByText("周遭變化")).toBeInTheDocument();
    expect(within(timeline).getByText("多話程度 voice 0.80(30 分鐘)")).toBeInTheDocument();
    const intents = within(timeline).getByRole("list", { name: "意圖" });
    expect(within(intents).getByText("voice.join")).toBeInTheDocument();
    expect(within(intents).getByText("完成")).toBeInTheDocument();
    expect(within(intents).getByText("我只是剛好路過喔。")).toBeInTheDocument();
    expect(within(intents).getAllByText("擋下").length, "badge and gate line").toBe(2);
    expect(within(intents).getByText(/對方意願 · the person opted out of DMs/)).toBeInTheDocument();

    const status = await screen.findByLabelText("心智迴圈");
    expect(within(status).getByText("3 / 12")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("運作中")).toBeInTheDocument();

    const approvals = screen.getByRole("table", { name: "等待確認" });
    expect(within(approvals).getByText("寫一個小工具")).toBeInTheDocument();
    expect(within(approvals).getByText("想幫大家算分數")).toBeInTheDocument();
    await user.click(within(approvals).getByRole("button", { name: "允許" }));
    expect(await screen.findByText("沒有等待確認的動作")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "緊急停止" }));
    expect(await within(screen.getByRole("main")).findByText("已緊急停止")).toBeInTheDocument();
    const posts = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([input]) => new URL(String(input), "http://panel.test").pathname);
    expect(posts).toEqual([`/api/mind/approvals/${APPROVAL.id}/approve`, "/api/mind/pause"]);
  });

  it("is in the navigation", async () => {
    serve();
    renderRoute("/inner?tab=world");
    expect(await screen.findByRole("link", { name: "內心" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "在線的人" })).toBeInTheDocument();
  });

  it("shows her documents of any shape, grouped by subject, with where fields came from", async () => {
    const source = (kind: "self" | "said", name: string | null, confidence = 0.8) => ({
      kind,
      account: null,
      name,
      origin: null,
      confidence,
      at: "2026-11-02T11:00:00.000Z",
    });
    const KNOWLEDGE: KnowledgeView = {
      documents: [
        {
          id: "01JC00000000000000000ABC12",
          subject: { type: "person", person: "p1" },
          kind: "人物卡",
          title: "Owen",
          content: { 喜歡: ["拉麵", "貓"], 最近在忙: "期末考\n**週三**考數學", 怎麼相處: { 稱呼: "歐文" } },
          sources: { "": source("self", null), "/喜歡/1": source("said", "Owen") },
          created_at: "2026-11-01T00:00:00.000Z",
          updated_at: "2026-11-02T11:00:00.000Z",
          version: 3,
          history: [{ version: 3, at: "2026-11-02T11:00:00.000Z", by: "said", name: "Owen", why: "他說的", ops: ["add /喜歡/1"] }],
          short_id: "#abc12",
          subject_label: "Owen",
        },
        {
          id: "01JC00000000000000000DEF34",
          subject: { type: "topic", name: "Minecraft 建築計畫" },
          kind: "計畫",
          title: "城堡",
          content: { 進度: [{ 階段: "地基", 完成: true }] },
          sources: { "": source("self", null) },
          created_at: "2026-11-01T00:00:00.000Z",
          updated_at: "2026-11-02T10:00:00.000Z",
          version: 1,
          history: [],
          short_id: "#def34",
          subject_label: "Minecraft 建築計畫",
        },
      ],
    };
    const NOTES: ConversationNote[] = [
      {
        context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
        updated_at: "2026-11-02T11:50:00.000Z",
        folded_up_to: null,
        folds: 2,
        lines: 32,
        recap: "大家在聊海豚,Owen 週三要考試。",
        notes: { 待回答: ["Amy 問她喜不喜歡海豚"] },
        label: "Miyoria / 雜談",
      },
    ];
    mockFetch((_m, url) => {
      if (url.pathname === "/api/knowledge") return { body: KNOWLEDGE };
      if (url.pathname === "/api/knowledge/conversations") return { body: NOTES };
      return undefined;
    });
    renderRoute("/inner?tab=knowledge");
    const owen = await screen.findByRole("region", { name: "Owen" });
    const card = within(owen).getByRole("article", { name: "人物卡「Owen」" });
    expect(within(card).getByText("拉麵")).toBeInTheDocument();
    expect(within(card).getByText("(Owen 說)")).toBeInTheDocument();
    expect(within(card).getByText("稱呼")).toBeInTheDocument();
    expect(within(card).getByText(/週三/)).toBeInTheDocument();
    expect(within(card).getByText("#abc12")).toBeInTheDocument();
    expect(within(card).getByText("改過 1 次")).toBeInTheDocument();
    const topic = screen.getByRole("region", { name: "Minecraft 建築計畫" });
    expect(within(topic).getByText("地基")).toBeInTheDocument();
    expect(within(topic).getByText("是")).toBeInTheDocument();
    const notes = await screen.findByRole("list", { name: "對話筆記" });
    expect(within(notes).getByText("Miyoria / 雜談")).toBeInTheDocument();
    expect(within(notes).getByText("大家在聊海豚,Owen 週三要考試。")).toBeInTheDocument();
    expect(within(notes).getByText("Amy 問她喜不喜歡海豚")).toBeInTheDocument();
  });

  it("shows her reflections, lessons and feedback", async () => {
    const REFLECTION: ReflectionView = {
      stats: { calls_today: 1, max_calls_per_day: 6, last_daily_at: "2026-11-02T05:00:00.000Z", last_light_at: null, idle_reason: null },
      runs: [
        {
          id: "r1",
          at: "2026-11-02T05:00:00.000Z",
          kind: "daily",
          context: null,
          summary: "今天插話太多次了。",
          insights: 2,
          superseded: 1,
          lessons: ["Owen 講話時不要插嘴"],
          goals: ["學會拉麵店的名字"],
          documents: ["人物卡「Owen」"],
          feelings: ["Owen"],
          error: null,
          tokens: 3000,
          ms: 9000,
        },
      ],
      lessons: [
        {
          id: "l1",
          text: "Owen 講話時不要插嘴",
          person: "p1",
          scope: null,
          talk: -0.8,
          created_at: "2026-11-02T05:00:00.000Z",
          expires_at: "2026-11-12T05:00:00.000Z",
          source: "daily",
          display_name: "Owen",
        },
      ],
      feedback: [
        {
          subject: "person:p1",
          label: "Owen",
          reactions_pos: 2,
          reactions_neg: 0,
          replies: 3,
          started: 0,
          answered: 0,
          ignored: 0,
          positive: 1,
          negative: 1,
          denied: 0,
          examples: ["你好吵"],
        },
      ],
    };
    mockFetch((_m, url) => (url.pathname === "/api/reflection" ? { body: REFLECTION } : undefined));
    renderRoute("/inner?tab=reflection");
    const lessons = await screen.findByRole("table", { name: "學到的事" });
    expect(within(lessons).getByText("Owen 講話時不要插嘴")).toBeInTheDocument();
    expect(within(lessons).getByText("安靜一點 -0.8")).toBeInTheDocument();
    const feedback = screen.getByRole("table", { name: "回饋" });
    expect(within(feedback).getByText(/反應 \+2 \/ -0/)).toBeInTheDocument();
    const runs = screen.getByRole("list", { name: "反思紀錄" });
    expect(within(runs).getByText("今天插話太多次了。")).toBeInTheDocument();
    expect(within(runs).getByText(/整理記憶 2/)).toBeInTheDocument();
    expect(within(screen.getByLabelText("反思狀態")).getByText("1 / 6")).toBeInTheDocument();
  });
});
