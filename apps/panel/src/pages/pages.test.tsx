import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  ChannelLevelsView,
  ChannelLevelView,
  Envelope,
  ModuleInfo,
  PersonDetail,
  SongsState,
  SongView,
  StageState,
  VoiceState,
  WorldView,
} from "@/api/types";
import { ConnectionProvider, STORAGE_TOKEN } from "@/app/connection";
import { EventStore } from "@/app/events-store";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { EventsTab } from "./activity/EventsTab";
import { MemoryTab } from "./character/MemoryTab";
import { PersonaTab } from "./character/PersonaTab";
import { PersonSheet } from "./character/PersonSheet";
import { NOT_IN_VOICE, SayCard } from "./live/SayCard";
import { TokenGate } from "./login/TokenGate";

const mod = (id: string, over: Partial<ModuleInfo> = {}): ModuleInfo => ({
  id,
  name: id.toUpperCase(),
  description: `${id} module`,
  enabled: true,
  state: "running",
  reason: null,
  recent_restarts: 0,
  ...over,
});

const WORLD_BASE: WorldView = {
  at: "2026-11-03T10:00:00.000Z",
  time: { local: "2026-11-03T18:00", weekday: 2, weekend: false, part_of_day: "傍晚", utc_offset_minutes: 480 },
  her: { voice: null, voice_name: null, golive: null, streaming: false, scene: null, game: null },
  people: [],
  voice_channels: [],
  channels: [],
};

const posts = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET").map(([u, init]) => `${init?.method} ${String(u)}`);

describe("System", () => {
  it("confirms before disabling a module and posts the action", async () => {
    const modules = [mod("api"), mod("voice", { state: "failed", reason: "TTS worker unreachable" })];
    const fetch = mockFetch((method, url) => {
      if (method === "GET" && url.pathname === "/api/modules") return { body: modules };
      if (method === "POST" && url.pathname === "/api/modules/voice/disable") return { body: { ...modules[1], enabled: false, state: "disabled" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/system");

    const row = (await screen.findByText("VOICE")).closest("tr") as HTMLElement;
    expect(within(row).getByText("TTS worker unreachable")).toBeInTheDocument();
    // The API module cannot stop itself: no actions at all.
    const apiRow = screen.getByText("API").closest("tr") as HTMLElement;
    expect(within(apiRow).queryByRole("button", { name: /動作/ })).not.toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "VOICE 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "停用" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("停用「VOICE」?")).toBeInTheDocument();
    expect(posts(fetch)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(posts(fetch)).toEqual(["POST /api/modules/voice/disable"]));
    expect(await screen.findByText("已停用 VOICE")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps the confirm dialog open when the action fails", async () => {
    mockFetch((method, url) => {
      if (url.pathname === "/api/modules") return { body: [mod("voice")] };
      if (method === "POST") return { status: 409, body: { error: "voice is busy" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/system");
    await user.click(await screen.findByRole("button", { name: "VOICE 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "重新啟動" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "重新啟動" }));
    expect(await screen.findByText("重新啟動失敗:voice is busy")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("offers only reconnect for MCP servers and shows their target", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/mcp"
        ? {
            body: [
              {
                name: "fs",
                transport: "stdio",
                target: "npx server-filesystem C:/data",
                enabled: true,
                state: "ready",
                error: null,
                tools: [{ name: "mcp.fs.read", description: "Read" }],
                remote_tool_count: 3,
                permission: null,
                reconnects: 0,
              },
            ],
          }
        : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/system?tab=mcp");
    expect(await screen.findByText("npx server-filesystem C:/data")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "fs 的動作" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["重新連線"]);
  });
});

describe("Overview", () => {
  it("lists what needs attention", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/modules") return { body: [mod("agent"), mod("voice", { state: "failed", reason: "TTS down" })] };
      if (url.pathname === "/api/llm/usage") return { body: {} };
      return undefined;
    });
    renderRoute("/");
    expect(await screen.findByText("VOICE 失敗")).toBeInTheDocument();
    expect(screen.getByText("TTS down")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看 VOICE" })).toHaveAttribute("href", "/system?tab=modules&q=voice");
  });
});

describe("Persona", () => {
  it("edits in a dialog, shows the diff and saves the trimmed body", async () => {
    let saved: unknown;
    const fetch = mockFetch((method, url, body) => {
      if (url.pathname === "/api/persona") return { body: [{ key: "style", body: "short\ncasual" }] };
      if (url.pathname === "/api/persona/style/history") return { body: [] };
      if (method === "PUT" && url.pathname === "/api/persona/style") {
        saved = body;
        return { body: { key: "style", version: 1 } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonaTab />);

    await user.click(await screen.findByRole("button", { name: "編輯" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "檢視變更" })).toBeDisabled();
    const editor = within(dialog).getByLabelText("style 內容");
    await user.clear(editor);
    await user.type(editor, "short\ntsundere  ");
    await user.click(within(dialog).getByRole("button", { name: "檢視變更" }));

    expect(within(dialog).getByText("+1")).toBeInTheDocument();
    expect(within(dialog).getByText("tsundere")).toBeInTheDocument();
    expect(within(dialog).getByText("casual")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(saved).toEqual({ body: "short\ntsundere", edited_by: "panel" }));
    expect(await screen.findByText("已儲存「style」v1")).toBeInTheDocument();
  });
});

const detail = (notes: string): PersonDetail => ({
  person: {
    id: "P1",
    display_name: "Owen",
    created_at: "2026-01-01T00:00:00Z",
    accounts: [{ account: { platform: "discord", id: "1" }, display_name: "Owen", first_seen: "2026-01-01T00:00:00Z", last_seen: "2026-11-01T00:00:00Z" }],
  },
  relationship: {
    profile: "p",
    person: "P1",
    affinity: 40,
    trust: 50,
    familiarity: 60,
    tags: ["常客"],
    notes,
    call_name: null,
    interactions: 3,
    last_interaction: null,
    updated_at: "2026-11-01T00:00:00Z",
  },
  label: "朋友",
  blocked: false,
  history: [],
  memory_count: 2,
});

describe("PersonSheet", () => {
  it("keeps unsaved edits when the person is refetched", async () => {
    let fetches = 0;
    mockFetch((_m, url) => {
      if (url.pathname !== "/api/people/P1") return undefined;
      fetches += 1;
      return { body: detail("喜歡拉麵") };
    });
    const user = userEvent.setup();
    const { queryClient } = renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    const notes = await screen.findByLabelText("備註");
    expect(notes).toHaveValue("喜歡拉麵");
    await user.clear(notes);
    await user.type(notes, "其實比較喜歡烏龍麵");

    // A refetch hands back a new object (new tag array) with the same values.
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(fetches).toBe(2));
    expect(screen.getByLabelText("備註")).toHaveValue("其實比較喜歡烏龍麵");
    expect(screen.getByRole("button", { name: "儲存" })).toBeEnabled();
  });

  const coins = {
    balance: 120,
    ledger: [
      { ts: "2026-11-08T04:00:00Z", delta: 50, label: "管理員調整:活動" },
      { ts: "2026-11-07T04:00:00Z", delta: -20, label: "餵她一碗白飯" },
    ],
  };

  it("shows their coins and posts one confirmed adjustment with a fresh key", async () => {
    const bodies: unknown[] = [];
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/people/P1") return { body: detail("x") };
      if (method === "GET" && url.pathname === "/api/people/P1/wallet") return { body: coins };
      if (method === "POST" && url.pathname === "/api/people/P1/wallet/adjust") {
        bodies.push(body);
        return { body: { balance: 100, entry_id: "e1", duplicate: false } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getByText("管理員調整:活動")).toBeInTheDocument();
    expect(screen.getByText("+50")).toBeInTheDocument();
    expect(screen.getByText("−20")).toBeInTheDocument();

    const adjust = screen.getByRole("button", { name: "調整" });
    expect(adjust).toBeDisabled();
    await user.type(screen.getByLabelText("數量"), "-20");
    await user.type(screen.getByLabelText("原因"), "補扣");
    await user.click(adjust);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/扣 20 魚幣/)).toBeInTheDocument();
    expect(within(dialog).getByText(/補扣/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "調整" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ amount: -20, note: "補扣" });
    expect(typeof (bodies[0] as { key: string }).key).toBe("string");
    expect(await screen.findByText(/現在有 100 魚幣/)).toBeInTheDocument();
  });

  it("disables the adjustment for a read-only account and after a 403", async () => {
    mockFetch((method, url) => {
      if (url.pathname === "/api/people/P1") return { body: detail("x") };
      if (method === "GET" && url.pathname === "/api/people/P1/wallet") return { body: coins };
      if (method === "POST") return { status: 403, body: { error: "this needs `admin.economy.adjust`" } };
      return undefined;
    });
    const readOnly = { session: { method: "token" as const, user: null, permissions: { write: false } }, logout: () => {} };
    const first = renderPage(<PersonSheet personId="P1" onClose={() => {}} />, { session: readOnly });
    await screen.findByText("120");
    expect(screen.getByLabelText("數量")).toBeDisabled();
    expect(screen.getByRole("button", { name: "調整" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "調整" })).toHaveAttribute("title", expect.stringContaining("admin.panel.write"));
    first.unmount();

    const user = userEvent.setup();
    renderPage(<PersonSheet personId="P1" onClose={() => {}} />);
    await screen.findByText("120");
    await user.type(screen.getByLabelText("數量"), "5");
    await user.type(screen.getByLabelText("原因"), "x");
    await user.click(screen.getByRole("button", { name: "調整" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "調整" }));
    await waitFor(() => expect(screen.getByLabelText("數量")).toBeDisabled());
    expect(screen.getAllByText(/admin\.economy\.adjust/).length).toBeGreaterThan(0);
  });
});

const stage = (over: Partial<StageState> = {}): StageState => ({
  vts: { connected: true, error: null },
  obs: { connected: true, error: null },
  scene: "Talk",
  scenes: ["Talk", "Game"],
  expression: null,
  expressions: ["Wave"],
  emotions: ["happy", "neutral"],
  overlay_url: null,
  speaking: false,
  node: "stage",
  streaming: false,
  ...over,
});

const voiceSession: VoiceState = {
  sessions: [
    {
      context: { platform: "discord", scope: "1", channel: "2", kind: "voice" },
      label: "小屋 / 雜談",
      participants: [],
      speaking: [],
      joined_at: "2026-11-01T00:00:00Z",
      latency: {
        asr: { p50_ms: null, p95_ms: null, samples: 0 },
        llm_first_token: { p50_ms: null, p95_ms: null, samples: 0 },
        tts_first_audio: { p50_ms: null, p95_ms: null, samples: 0 },
      },
      last_turn: null,
    },
  ],
};

describe("SayCard", () => {
  it("is disabled, with a reason, while she is not in voice", async () => {
    const fetch = mockFetch((_m, url) => {
      if (url.pathname === "/api/voice") return { body: { sessions: [] } };
      if (url.pathname === "/api/stage") return { body: stage() };
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<SayCard />);
    const text = await screen.findByLabelText("台詞");
    await waitFor(() => expect(text).toBeDisabled());
    expect(screen.getByRole("button", { name: "說出來" })).toBeDisabled();

    await user.hover(screen.getByLabelText(NOT_IN_VOICE));
    expect((await screen.findAllByText(NOT_IN_VOICE)).length).toBeGreaterThan(0);
    expect(fetch.mock.calls.some(([u]) => String(u) === "/api/stage/say")).toBe(false);
  });

  it("speaks with the chosen emotion when she is in voice", async () => {
    let said: unknown;
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/voice") return { body: voiceSession };
      if (url.pathname === "/api/stage") return { body: stage() };
      if (method === "POST" && url.pathname === "/api/stage/say") {
        said = body;
        return { body: { turn: "T1" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(<SayCard />);
    const text = await screen.findByLabelText("台詞");
    await waitFor(() => expect(text).toBeEnabled());
    await user.type(text, "哼。");
    await user.click(screen.getByRole("combobox", { name: "情緒" }));
    await user.click(await screen.findByRole("option", { name: "開心" }));
    await user.click(screen.getByRole("button", { name: "說出來" }));
    await waitFor(() => expect(said).toEqual({ text: "哼。", emotion: "happy" }));
  });
});

describe("Live", () => {
  it("switches OBS scenes from the reported list", async () => {
    let switched: unknown;
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/stage" && method === "GET") return { body: stage() };
      if (url.pathname === "/api/stage/scene") {
        switched = body;
        return { body: stage({ scene: "Game" }) };
      }
      if (url.pathname === "/api/voice") return { body: { sessions: [] } };
      if (url.pathname === "/api/queue") return { body: { paused: false, items: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    const scenes = await screen.findByRole("radiogroup", { name: "場景" });
    expect(within(scenes).getByRole("radio", { name: "Talk" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(scenes).getByRole("radio", { name: "Game" }));
    await waitFor(() => expect(switched).toEqual({ scene: "Game" }));
    expect(await screen.findByText("已切到「Game」")).toBeInTheDocument();
  });

  it("requests, sings and stops songs, and shows a song being prepared", async () => {
    const posted: [string, unknown][] = [];
    const song = (no: number, state: SongView["state"], over: Partial<SongView> = {}): SongView => ({
      no,
      query: `song ${no}`,
      title: null,
      artist: null,
      duration_s: null,
      key: 0,
      requester_name: "Owen",
      state,
      stage: "",
      progress: 1,
      error: null,
      forced: false,
      created_at: "2026-11-03T10:00:00.000Z",
      ready_at: null,
      ...over,
    });
    const list: SongsState = {
      playing: 1,
      paused: null,
      songs: [song(1, "playing", { title: "Lemon" }), song(2, "ready"), song(3, "preparing", { stage: "separate", progress: 0.4 })],
    };
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/songs" && method === "GET") return { body: list };
      if (method === "POST" && url.pathname.startsWith("/api/songs")) {
        posted.push([url.pathname, body]);
        return { body: { ...list, text: "ok" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    const set = await screen.findByRole("list", { name: "歌單" });
    expect(within(set).getByText("Lemon")).toBeInTheDocument();
    expect(within(set).getByRole("progressbar", { name: "#3 準備進度" })).toHaveAttribute("aria-valuenow", "40");
    expect(within(set).getByText("分離人聲")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("歌名、歌手或 YouTube / bilibili 連結"), "アイドル");
    await user.click(screen.getByRole("button", { name: "點歌" }));
    await user.click(within(set).getByRole("button", { name: "唱這首" }));
    await user.click(screen.getByRole("button", { name: "停止這首" }));
    await waitFor(() =>
      expect(posted).toEqual([
        ["/api/songs", { query: "アイドル", key: null }],
        ["/api/songs/play", { song: 2 }],
        ["/api/songs/stop", { all: false }],
      ]),
    );
  });

  it("joins a voice channel from the list, and leaves after a confirmation", async () => {
    let inVoice = false;
    const posted: [string, unknown][] = [];
    const ctx = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" as const };
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/voice")
        return {
          body: {
            sessions: inVoice
              ? [
                  {
                    context: ctx,
                    label: "雜談",
                    participants: [],
                    speaking: [],
                    joined_at: "2026-11-03T10:00:00.000Z",
                    latency: {
                      asr: { p50_ms: null, p95_ms: null, samples: 0 },
                      llm_first_token: { p50_ms: null, p95_ms: null, samples: 0 },
                      tts_first_audio: { p50_ms: null, p95_ms: null, samples: 0 },
                    },
                    last_turn: null,
                  },
                ]
              : [],
          } satisfies VoiceState,
        };
      if (url.pathname === "/api/world")
        return {
          body: {
            ...WORLD_BASE,
            voice_channels: [{ platform: "discord", guild: "g1", channel: "v1", name: "雜談", members: [] }],
          },
        };
      if (method === "POST") {
        posted.push([url.pathname, body]);
        if (url.pathname === "/api/voice/join") inVoice = true;
        if (url.pathname === "/api/voice/leave") inVoice = false;
        return { body: { text: "ok" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    await user.click(await screen.findByRole("button", { name: "加入 雜談" }));
    expect(await screen.findByText("她加入了「雜談」")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "離開" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "離開" }));
    await waitFor(() =>
      expect(posted).toEqual([
        ["/api/voice/join", { guild: "g1", channel: "v1" }],
        ["/api/voice/leave", { guild: "g1" }],
      ]),
    );
  });

  it("sets a text channel's level and mutes it", async () => {
    let level: ChannelLevelsView = {
      levels: [
        { mode: "off", label: "關閉", description: "完全不說話" },
        { mode: "quiet", label: "安靜", description: "很少插話" },
        { mode: "lively", label: "活躍", description: "比較常加入對話" },
      ],
      channels: [
        {
          context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
          label: "Miyoria / 雜談",
          mode: "quiet",
          custom: false,
          default: "quiet",
        },
      ],
    };
    const puts: unknown[] = [];
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/channels/levels") return { body: level };
      if (method === "PUT" && url.pathname === "/api/channels/level") {
        puts.push(body);
        const mode = (body as { mode: string | null }).mode ?? "quiet";
        const row = { ...(level.channels[0] as ChannelLevelView), mode, custom: mode !== "quiet" };
        level = { ...level, channels: [row] };
        return { body: row };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    const select = await screen.findByRole("combobox", { name: "Miyoria / 雜談 的聊天等級" });
    expect(select).toHaveTextContent("安靜");
    expect(screen.getByText("很少插話 · 預設")).toBeInTheDocument();
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "活躍" }));
    expect(await screen.findByText("已將 Miyoria / 雜談 設為「活躍」")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "讓她在 Miyoria / 雜談 閉嘴" }));
    expect(await screen.findByText("她在 Miyoria / 雜談 不會說話了")).toBeInTheDocument();
    expect(puts).toEqual([
      { context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" }, mode: "lively" },
      { context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" }, mode: "off" },
    ]);
  });

  it("stops her autonomy with one click", async () => {
    let paused = false;
    mockFetch((method, url) => {
      if (url.pathname === "/api/mind") return { body: { paused, running: true, accepting: !paused, stats: null, pending_approvals: 0 } };
      if (method === "POST" && url.pathname === "/api/mind/pause") {
        paused = true;
        return { body: { paused, running: true, accepting: false, stats: null, pending_approvals: 0 } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    await user.click(await screen.findByRole("button", { name: "緊急停止" }));
    expect(await screen.findByText("已緊急停止:她閉嘴了,直播、語音和遊戲都關了")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "解除停止" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "已緊急停止" })).toBeInTheDocument();
  });

  it("names the steps that did not work", async () => {
    const steps = [
      { step: "pause", ok: true, detail: "只有指令和面板能讓她行動" },
      { step: "stream", ok: false, detail: "逾時,沒有確認到結果" },
      { step: "game", ok: true, detail: "遊戲已停止" },
    ];
    const emergency = { paused: true, by: "panel:api", at: "2026-11-07T12:00:00.000Z", steps };
    let paused = false;
    const view = () => ({
      paused,
      running: true,
      accepting: !paused,
      stats: null,
      pending_approvals: 0,
      emergency: paused ? emergency : null,
    });
    mockFetch((method, url) => {
      if (url.pathname === "/api/mind") return { body: view() };
      if (method === "POST" && url.pathname === "/api/mind/pause") {
        paused = true;
        return { body: view() };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/live");
    await user.click(await screen.findByRole("button", { name: "緊急停止" }));
    expect(
      await screen.findByText("已緊急停止,但這些沒有成功:直播(逾時,沒有確認到結果)"),
    ).toBeInTheDocument();
  });
});

describe("Memory", () => {
  it("loads the next page with next_cursor as `before`", async () => {
    const record = (id: string, content: string, created_at: string) => ({
      record: {
        id,
        profile: "p",
        kind: "fact",
        scope: { type: "global" },
        subjects: [],
        content,
        importance: 0.5,
        confidence: 1,
        created_at,
        updated_at: created_at,
        last_accessed: null,
        access_count: 0,
        source_context: null,
        due: null,
        done: false,
        superseded_by: null,
        has_embedding: true,
      },
    });
    const seen: (string | null)[] = [];
    mockFetch((_m, url) => {
      if (url.pathname !== "/api/memory") return undefined;
      const before = url.searchParams.get("before");
      seen.push(before);
      return before
        ? { body: { items: [record("M2", "第二頁", "2026-10-01T00:00:00Z")], next_cursor: null } }
        : { body: { items: [record("M1", "第一頁", "2026-11-01T00:00:00Z")], next_cursor: "2026-11-01T00:00:00Z" } };
    });
    const user = userEvent.setup();
    renderPage(<MemoryTab />);
    expect(await screen.findByText("第一頁")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "載入更多" }));
    expect(await screen.findByText("第二頁")).toBeInTheDocument();
    expect(screen.getByText("第一頁")).toBeInTheDocument();
    expect(seen).toEqual([null, "2026-11-01T00:00:00Z"]);
    expect(screen.queryByRole("button", { name: "載入更多" })).not.toBeInTheDocument();
  });
});

describe("Access", () => {
  it("assigns a role to a person picked from the combobox", async () => {
    let assigned: unknown;
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/auth/roles") return { body: [{ name: "moderator", rank: 50, grants: [], denies: [], builtin: false }] };
      if (url.pathname === "/api/auth/assignments" && method === "GET") return { body: [] };
      if (url.pathname === "/api/auth/assignments" && method === "POST") {
        assigned = body;
        return { body: { ...(body as object), granted_by: "api", at: "2026-11-01T00:00:00Z" } };
      }
      if (url.pathname === "/api/people")
        return {
          body: {
            items: [{ ...detail("x"), history: undefined, memory_count: undefined }],
            next_cursor: null,
          },
        };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/access");
    await user.click(await screen.findByRole("button", { name: "指派角色" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "帳號" }));
    await user.click(await screen.findByRole("option", { name: /Owen/ }));
    await user.click(within(dialog).getByRole("button", { name: "指派" }));
    await waitFor(() =>
      expect(assigned).toEqual({ account: { platform: "discord", id: "1" }, role: "moderator", scope: { type: "global" } }),
    );
  });
});

const envelope = (i: number, event: Envelope["event"]): Envelope => ({
  id: `E${String(i).padStart(3, "0")}`,
  ts: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(),
  source: "agent",
  causation: null,
  correlation: null,
  event,
});
const ctx = { platform: "discord", scope: "1", channel: "42", kind: "channel" as const };

describe("Events", () => {
  it("filters by topic, pauses, and opens the details sheet", async () => {
    mockFetch(() => undefined);
    const store = new EventStore(0);
    const user = userEvent.setup();
    renderPage(<EventsTab />, { store });
    expect(await screen.findByText("尚未連線")).toBeInTheDocument();

    act(() => {
      store.push(envelope(1, { type: "agent_turn_completed", data: { turn: "T", context: ctx, text: "哼,拉麵啦" } }));
      store.push(envelope(2, { type: "custom", data: { topic: "voice.latency", payload: { stage: "asr", asr_ms: 200 } } }));
      store.flush();
    });
    expect(screen.getByText("她說:哼,拉麵啦")).toBeInTheDocument();
    expect(screen.getByText("voice.latency")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "voice.*" }));
    expect(screen.queryByText("她說:哼,拉麵啦")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "voice.*" }));

    await user.click(screen.getByRole("button", { name: "暫停" }));
    act(() => {
      store.push(envelope(3, { type: "agent_turn_completed", data: { turn: "T", context: ctx, text: "新的一句" } }));
      store.flush();
    });
    expect(screen.queryByText("她說:新的一句")).not.toBeInTheDocument();
    expect(screen.getByText("暫停期間 +1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "繼續" }));
    expect(screen.getByText("她說:新的一句")).toBeInTheDocument();

    await user.click(screen.getByText("她說:新的一句"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("E003")).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Envelope").textContent).toContain('"agent_turn_completed"');
  });
});

describe("TokenGate", () => {
  it("rejects a bad token and stores a good one", async () => {
    let good = false;
    mockFetch((_m, url) => {
      if (url.pathname === "/api/health") return { body: { status: "ok", version: "0.3.0" } };
      if (url.pathname === "/api/modules") return good ? { body: [] } : { status: 401, body: { error: "missing or invalid bearer token" } };
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
        <TokenGate />
      </ConnectionProvider>,
    );

    await user.click(screen.getByRole("button", { name: "連線" }));
    expect(await screen.findByText("請輸入 token。")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Admin token"), "wrong");
    await user.click(screen.getByRole("button", { name: "連線" }));
    expect(await screen.findByText("Core 拒絕了這個 token。")).toBeInTheDocument();
    expect(screen.getByLabelText("Admin token")).toHaveAttribute("aria-invalid", "true");

    good = true;
    await user.click(screen.getByRole("button", { name: "連線" }));
    await waitFor(() => expect(window.localStorage.getItem(STORAGE_TOKEN)).toBe("wrong"));
  });
});
