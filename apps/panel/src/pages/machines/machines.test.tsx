import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ClusterEndpoints, ClusterHostInfo, ClusterHostView } from "@miyoria/contracts/api";
import { mockFetch, renderRoute } from "@/test/render";
import { fmtCountdown, fmtDuration, parseCapabilities } from "./labels";
import type { ClusterRouting } from "./Routing";

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const host = (name: string, over: Partial<ClusterHostView> = {}): ClusterHostView => ({
  id: `h-${name}`,
  name,
  status: "approved",
  capabilities: [],
  platform: "win32",
  version: "5.0.0",
  created_at: iso(86_400_000),
  last_seen_at: iso(60_000),
  connected: false,
  connected_since: null,
  ...over,
});

const service = (name: string, over: Partial<ClusterHostInfo["services"][number]> = {}): ClusterHostInfo["services"][number] => ({
  name,
  kind: "worker",
  provides: [],
  state: "running",
  since: Date.now() - 3 * 60_000,
  healthy: true,
  restarts: 0,
  ...over,
});

const info = (over: Partial<ClusterHostInfo> = {}): ClusterHostInfo => ({
  name: "atlas",
  version: "5.0.0",
  platform: "win32",
  protocol: 1,
  gpu: null,
  services: [],
  link: "connected",
  ...over,
});

const ATLAS = host("atlas", { capabilities: ["asr", "tts"], connected: true, connected_since: iso(2 * 3_600_000) });
const PENDING = host("studio-pc", { status: "pending", connected: false, last_seen_at: null, platform: null, version: null });
const LAPTOP = host("laptop", { capabilities: ["sing"], last_seen_at: iso(5 * 60_000) });

const ALL_STATES = info({
  gpu: { name: "RTX 4070 SUPER", total_mb: 12_288, used_mb: 6_246, reserve_mb: 2_048 },
  services: [
    service("asr", { provides: ["asr"], port: 8003, pid: 4120 }),
    service("tts", { provides: ["tts"], state: "starting" }),
    service("sing", { provides: ["sing"], state: "failed", reason: "CUDA out of memory", restarts: 3 }),
    service("turn", { provides: ["turn"], state: "backoff", reason: "exited with code 1", restarts: 2 }),
    service("vad", { provides: ["vad"], state: "running", healthy: false }),
    service("lyrics", { provides: ["lyrics"], state: "stopped" }),
    service("imagegen", { provides: ["imagegen"], state: "foreign", port: 8188 }),
    service("voice", { kind: "node", state: "disabled", reason: "no GPU on this machine" }),
    service("obs", { kind: "external", state: "external", provides: ["stage"] }),
    service("llm", { state: "stopping" }),
  ],
  name: "atlas",
});

const ENDPOINTS: ClusterEndpoints = {
  capabilities: [
    {
      capability: "asr",
      candidates: [
        { host: "atlas", service: "asr", via: "direct", healthy: true, version: "0.6B", url: "http://127.0.0.1:8003" },
        { host: "laptop", service: "asr", via: "link", healthy: true, version: null },
      ],
    },
    { capability: "sing", candidates: [{ host: "atlas", service: "sing", via: "link", healthy: false, version: null }] },
    { capability: "imagegen", candidates: [] },
  ],
};

type EndpointRouting = ClusterRouting["capabilities"][number]["endpoints"][number];
type ServiceRouting = NonNullable<ClusterHostInfo["services"][number]["routing"]>;

const svcRouting = (over: Partial<ServiceRouting> = {}): ServiceRouting => ({
  class: "job",
  latency: "batch",
  concurrency: 1,
  queue: true,
  yields_to: [],
  ready: true,
  accept: true,
  ...over,
});

const ep = (h: string, s: string, over: Partial<EndpointRouting> = {}): EndpointRouting => ({
  host: h,
  service: s,
  via: "link",
  healthy: true,
  resting: false,
  eligible: true,
  score_s: null,
  routing: null,
  load: null,
  pending: 0,
  speech: false,
  estimate: { unit_s: null, rate_mb_s: null, units: 0, transfers: 0 },
  ...over,
});

const ROUTING: ClusterRouting = {
  capabilities: [
    {
      capability: "sing",
      class: "job",
      latency: "batch",
      yields_to: ["tts", "asr"],
      variant: "9f3a1c2be0d4",
      speech_mode: "when_idle",
      conflict: null,
      class_conflict: null,
      endpoints: [
        ep("atlas", "sing", {
          score_s: 12.34,
          parts: { wait_ms: 2_000, run_ms: 9_000, transfer_ms: 1_340, penalty_ms: 0, penalties: [], weight: 1 },
          load: { running: 1, queued: 2, age_ms: 500 },
          pending: 1,
          routing: svcRouting({ variant: "9f3a1c2be0d4" }),
          estimate: { unit_s: 9, rate_mb_s: 4.2, units: 8, transfers: 3 },
        }),
        ep("laptop", "sing", { eligible: false, reason: "她的語音(tts)在這台,她在語音、直播或剛說過話", speech: true }),
        ep("old", "sing", {
          eligible: false,
          reason: "版本 77aa00ff11 和其他台的 9f3a1c2be0d4 不同,結果不能互換",
          routing: svcRouting({ variant: "77aa00ff11" }),
        }),
      ],
      decisions: [
        {
          at: iso(3 * 60_000),
          host: "atlas",
          service: "sing",
          what: "小星星",
          scores: [
            { host: "atlas", service: "sing", score_s: 12.3 },
            { host: "laptop", service: "sing", score_s: null, reason: "她的語音在這台" },
          ],
        },
      ],
      sessions: [],
      result_mb: 30,
    },
    {
      capability: "tts",
      class: "single",
      latency: "realtime",
      yields_to: [],
      variant: null,
      speech_mode: "never",
      conflict: { used: "atlas/tts", others: ["laptop/tts"] },
      class_conflict: null,
      endpoints: [ep("atlas", "tts"), ep("laptop", "tts", { eligible: false, reason: "同一個服務只能有一個,這是多出來的那個,不會被使用" })],
      decisions: [],
      sessions: [{ key: "room-1", host: "atlas", service: "tts", since: iso(60_000) }],
      result_mb: null,
    },
  ],
  hosts: [
    { host: "atlas", local: true, rtt_ms: 2.4, drained: null, weight: 1 },
    {
      host: "laptop",
      local: false,
      rtt_ms: 38,
      drained: "擁有者在面板設定清空",
      weight: 2,
      routes: [
        { name: "tailnet", kind: "tailnet", url: "laptop.ts.net", implicit: false, state: "resting", in_use: [], rtt_ms: null, mb_s: null, samples: 0, max_body_mb: null, probed_at: iso(60_000), ok_at: null, reason: "連不上:fetch failed" },
        { name: "direct", kind: "direct", url: "https://laptop.example.net:7890", implicit: false, state: "up", in_use: ["realtime", "interactive"], rtt_ms: 31.6, mb_s: 9.4, samples: 2, max_body_mb: null, probed_at: iso(60_000), ok_at: iso(60_000), reason: null },
        { name: "tunnel", kind: "tunnel", url: "https://laptop-tunnel.example.com", implicit: false, state: "up", in_use: ["bulk"], rtt_ms: 140, mb_s: 22.5, samples: 3, max_body_mb: 100, probed_at: iso(60_000), ok_at: iso(60_000), reason: null },
        { name: "plain", kind: "direct", url: "http://203.0.113.7:7890", implicit: false, state: "invalid", in_use: [], rtt_ms: null, mb_s: null, samples: 0, max_body_mb: null, probed_at: null, ok_at: null, reason: "direct 一定要用 https(TLS),不接受 http" },
        { name: "relay", kind: "relay", url: null, implicit: true, state: "unknown", in_use: [], rtt_ms: 38, mb_s: null, samples: 0, max_body_mb: null, probed_at: null, ok_at: null, reason: null },
      ],
    },
  ],
  activity: { in_voice: true, live: false, last_spoke_at: iso(30_000), idle: false },
  config: { allow_on_speech_host: "when_idle", idle_minutes: 10, weights: {}, drain: [], capabilities: { sing: { exclude: ["old"] } } },
  panel: [
    { kind: "drain", capability: "", host: "laptop", value: null, by: "discord:1", at: iso(120_000) },
    { kind: "weight", capability: "", host: "laptop", value: 2, by: "discord:1", at: iso(120_000) },
  ],
};

interface World {
  hosts: ClusterHostView[];
  infos: Record<string, ClusterHostInfo | { status: number; error: string }>;
  endpoints: ClusterEndpoints;
  /** Absent: the route answers 404, as an older Core does. */
  routing?: ClusterRouting;
}

const world = (over: Partial<World> = {}): World => ({ hosts: [PENDING, ATLAS, LAPTOP], infos: { atlas: ALL_STATES }, endpoints: ENDPOINTS, ...over });

function serve(w: World, extra?: Parameters<typeof mockFetch>[0]) {
  return mockFetch((method, url, body, headers) => {
    const extraRes = extra?.(method, url, body, headers);
    if (extraRes) return extraRes;
    if (method === "GET" && url.pathname === "/api/cluster/hosts") return { body: w.hosts };
    if (method === "GET" && url.pathname === "/api/cluster/endpoints") return { body: w.endpoints };
    if (method === "GET" && url.pathname === "/api/cluster/routing" && w.routing) return { body: w.routing };
    const m = /^\/api\/cluster\/hosts\/([^/]+)\/info$/.exec(url.pathname);
    if (method === "GET" && m) {
      const r = w.infos[m[1] ?? ""];
      if (!r) return { status: 409, body: { error: "host is not connected" } };
      return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
    }
    return undefined;
  });
}

const posts = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method && init.method !== "GET")
    .map(([u, init]) => ({ call: `${init?.method} ${String(u)}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }));

const rowOf = async (name: string) => (await screen.findByRole("heading", { name })).closest("li") as HTMLElement;

describe("helpers", () => {
  it("formats durations, countdowns and capability lists", () => {
    expect(fmtDuration(4_000)).toBe("剛剛");
    expect(fmtDuration(3 * 60_000)).toBe("3 分鐘");
    expect(fmtDuration(125 * 60_000)).toBe("2 小時 5 分");
    expect(fmtDuration(3 * 86_400_000)).toBe("3 天");
    expect(fmtCountdown(9 * 60_000 + 42_000)).toBe("9:42");
    expect(fmtCountdown(-5)).toBe("0:00");
    expect(parseCapabilities("asr, tts  asr\nsing")).toEqual(["asr", "tts", "sing"]);
  });
});

describe("Machines: hosts", () => {
  it("lists pending first and prominent, then approved and offline hosts", async () => {
    serve(world());
    renderRoute("/machines");

    const names = (await screen.findAllByRole("heading", { level: 3 })).map((h) => h.textContent);
    expect(names).toEqual(["studio-pc", "atlas", "laptop"]);

    const pending = await rowOf("studio-pc");
    expect(within(pending).getByText("待核可")).toBeInTheDocument();
    expect(within(pending).getByRole("button", { name: "核可" })).toBeInTheDocument();
    expect(within(pending).getByText("從未連線")).toBeInTheDocument();

    const atlas = await rowOf("atlas");
    expect(within(atlas).getByText("已核可")).toBeInTheDocument();
    expect(within(atlas).getByText("連線中")).toBeInTheDocument();
    expect(within(atlas).getByText(/自 2 小時前/)).toBeInTheDocument();
    expect(within(atlas).getByText("win32 · 5.0.0")).toBeInTheDocument();
    expect(within(atlas).getAllByText("tts").length).toBeGreaterThan(0);
    expect(within(atlas).queryByRole("button", { name: "核可" })).not.toBeInTheDocument();

    const laptop = await rowOf("laptop");
    expect(within(laptop).getByText("離線")).toBeInTheDocument();
    expect(within(laptop).getByText(/上次 5 分鐘前/)).toBeInTheDocument();
    // An offline host has nothing to expand.
    expect(within(laptop).queryByRole("button", { name: /展開|收起/ })).not.toBeInTheDocument();
  });

  it("shows every service state in words, with reasons in view and the right actions", async () => {
    serve(world());
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    const table = await within(atlas).findByRole("table", { name: "atlas 的服務" });
    const row = (n: string) => table.querySelector(`[data-service="${n}"]`) as HTMLElement;
    const actions = (n: string) => within(row(n)).queryAllByRole("button").map((b) => b.textContent);

    expect(within(row("asr")).getByText("執行中")).toBeInTheDocument();
    expect(actions("asr")).toEqual(["停止", "重啟"]);
    expect(within(row("tts")).getByText("啟動中")).toBeInTheDocument();
    expect(actions("tts")).toEqual(["停止"]);
    expect(within(row("sing")).getByText("失敗")).toBeInTheDocument();
    expect(within(row("sing")).getByText("CUDA out of memory")).toBeVisible();
    expect(actions("sing")).toEqual(["啟動"]);
    expect(within(row("turn")).getByText("等待重試")).toBeInTheDocument();
    expect(within(row("turn")).getByText("exited with code 1")).toBeVisible();
    expect(within(row("vad")).getByText("不健康")).toBeInTheDocument();
    expect(within(row("lyrics")).getByText("已停止")).toBeInTheDocument();
    expect(actions("lyrics")).toEqual(["啟動"]);
    expect(within(row("imagegen")).getByText("有人在外面啟動了它")).toBeVisible();
    expect(actions("imagegen")).toEqual([]);
    expect(within(row("voice")).getByText("no GPU on this machine")).toBeVisible();
    expect(actions("voice")).toEqual([]);
    expect(within(row("obs")).getByText("外部程式")).toBeInTheDocument();
    expect(actions("obs")).toEqual([]);
    expect(within(row("llm")).getByText("停止中")).toBeInTheDocument();
    expect(actions("llm")).toEqual([]);
    expect(within(row("asr")).getByText("3 分鐘")).toBeInTheDocument();

    // GPU: numbers in GB with one decimal, the reserved part drawn.
    expect(within(atlas).getByText("RTX 4070 SUPER")).toBeInTheDocument();
    expect(within(atlas).getByRole("meter", { name: /已用 6\.1 \/ 12\.0 GB,保留 2\.0 GB/ })).toBeInTheDocument();
    expect(within(atlas).getByTestId("gpu-reserve")).toHaveStyle({ width: "16.666666666666664%" });
  });

  it("collapses and expands a connected host", async () => {
    serve(world());
    const user = userEvent.setup();
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    await within(atlas).findByRole("table");
    await user.click(within(atlas).getByRole("button", { name: "收起 atlas" }));
    expect(within(atlas).queryByRole("table")).not.toBeInTheDocument();
    await user.click(within(atlas).getByRole("button", { name: "展開 atlas" }));
    expect(await within(atlas).findByRole("table")).toBeInTheDocument();
  });

  it("says so quietly when the host has no GPU, and shows a link that is not up", async () => {
    serve(world({ infos: { atlas: info({ gpu: null, link: "connecting", services: [service("asr")] }) } }));
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    expect(await within(atlas).findByText("沒有 GPU")).toBeInTheDocument();
    expect(within(atlas).getByText(/正在連線到 Core/)).toBeInTheDocument();
  });

  it("keeps the page when one host's info fails", async () => {
    serve(world({ infos: { atlas: { status: 500, error: "daemon timeout" } } }));
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    expect(await within(atlas).findByText(/daemon timeout/)).toBeInTheDocument();
    expect(within(atlas).getByRole("button", { name: "重試" })).toBeInTheDocument();
    // The other parts are still there.
    expect(await screen.findByText("誰負責什麼")).toBeInTheDocument();
    expect(await rowOf("laptop")).toBeInTheDocument();
  });
});

describe("Machines: approve and remove", () => {
  it("approves a connected pending host with everything it reports checked", async () => {
    const pending = host("studio-pc", { status: "pending", connected: true, connected_since: iso(60_000), last_seen_at: iso(1000) });
    const f = serve(
      world({
        hosts: [pending],
        infos: { "studio-pc": info({ name: "studio-pc", services: [service("asr", { provides: ["asr"] }), service("tts", { provides: ["tts", "turn"] })] }) },
      }),
      (method, url) => (method === "POST" && url.pathname === "/api/cluster/hosts/studio-pc/approve" ? { body: { ...pending, status: "approved" } } : undefined),
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    await user.click(await screen.findByRole("button", { name: "核可" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("核可「studio-pc」")).toBeInTheDocument();
    const boxes = await within(dialog).findAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);

    await user.click(within(dialog).getByRole("checkbox", { name: "turn" }));
    await user.click(within(dialog).getByRole("button", { name: "核可" }));
    await waitFor(() => expect(posts(f)).toEqual([{ call: "POST /api/cluster/hosts/studio-pc/approve", body: { capabilities: ["asr", "tts"] } }]));
    expect(await screen.findByText("已核可 studio-pc")).toBeInTheDocument();
  });

  it("takes typed capability names for an offline host that reports nothing", async () => {
    const f = serve(world({ hosts: [PENDING] }), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/hosts/studio-pc/approve" ? { body: { ...PENDING, status: "approved" } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    await user.click(await screen.findByRole("button", { name: "核可" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    await user.type(within(dialog).getByRole("textbox", { name: "能力名稱" }), "asr, sing");
    await user.click(within(dialog).getByRole("button", { name: "核可" }));
    await waitFor(() => expect(posts(f)[0]?.body).toEqual({ capabilities: ["asr", "sing"] }));
  });

  it("edits an approved host's list, keeping what it does not report right now", async () => {
    const f = serve(world(), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/hosts/atlas/approve" ? { body: ATLAS } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    await user.click(within(atlas).getByRole("button", { name: "atlas 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "編輯核可的能力" }));
    const dialog = await screen.findByRole("dialog");
    // Approved ones are checked, the others it reports are not.
    expect(await within(dialog).findByRole("checkbox", { name: "asr" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "tts" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "sing" })).not.toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: "sing" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "tts" }));
    await user.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(posts(f)[0]?.body).toEqual({ capabilities: ["asr", "sing"] }));
  });

  it("confirms before removing and says the key stops working", async () => {
    const f = serve(world(), (method, url) => (method === "DELETE" && url.pathname === "/api/cluster/hosts/laptop" ? { status: 204 } : undefined));
    const user = userEvent.setup();
    renderRoute("/machines");
    const laptop = await rowOf("laptop");
    await user.click(within(laptop).getByRole("button", { name: "laptop 的動作" }));
    await user.click(await screen.findByRole("menuitem", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("移除「laptop」?")).toBeInTheDocument();
    expect(within(dialog).getByText(/金鑰會立刻失效/)).toBeInTheDocument();
    expect(posts(f)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() => expect(posts(f).map((p) => p.call)).toEqual(["DELETE /api/cluster/hosts/laptop"]));
    expect(await screen.findByText("已移除 laptop")).toBeInTheDocument();
  });
});

describe("Machines: service actions", () => {
  it("asks again with the server's message on 409 and forces only after a second yes", async () => {
    let calls = 0;
    const f = serve(world(), (method, url, body) => {
      if (method === "POST" && url.pathname === "/api/cluster/hosts/atlas/services/asr/restart") {
        calls += 1;
        return (body as { force?: boolean }).force
          ? { body: { service: "asr", state: "starting" } }
          : { status: 409, body: { error: "she is singing right now" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    await user.click(await within(atlas).findByRole("button", { name: "重啟 asr" }));

    const first = await screen.findByRole("alertdialog");
    expect(within(first).getByText("重啟「asr」?")).toBeInTheDocument();
    await user.click(within(first).getByRole("button", { name: "重啟" }));

    const second = await screen.findByText("仍要重啟「asr」?");
    const dialog = second.closest('[role="alertdialog"]') as HTMLElement;
    expect(within(dialog).getByText("she is singing right now")).toBeInTheDocument();
    expect(calls).toBe(1);
    await user.click(within(dialog).getByRole("button", { name: "強制重啟" }));

    await waitFor(() => expect(calls).toBe(2));
    expect(posts(f).map((p) => p.body)).toEqual([{}, { force: true }]);
    expect(await screen.findByText("已重啟 asr")).toBeInTheDocument();
  });

  it("starts without a confirm, and a refused start offers force too", async () => {
    const f = serve(world(), (method, url, body) => {
      if (method === "POST" && url.pathname === "/api/cluster/hosts/atlas/services/lyrics/start")
        return (body as { force?: boolean }).force ? { body: { service: "lyrics", state: "starting" } } : { status: 409, body: { error: "GPU is busy" } };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    const row = (await within(atlas).findByRole("table")).querySelector('[data-service="lyrics"]') as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "啟動 lyrics" }));
    expect(await screen.findByText("GPU is busy")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "強制啟動" }));
    await waitFor(() => expect(posts(f)).toHaveLength(2));
  });

  it("toasts a failure that is not a refusal", async () => {
    serve(world(), (method, url) =>
      method === "POST" && url.pathname.endsWith("/services/asr/stop") ? { status: 500, body: { error: "daemon error" } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    await user.click(await within(atlas).findByRole("button", { name: "停止 asr" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "停止" }));
    expect(await screen.findByText("停止失敗:daemon error")).toBeInTheDocument();
    expect(screen.queryByText(/仍要停止/)).not.toBeInTheDocument();
  });
});

describe("Machines: invite", () => {
  it("creates a code with a name and shows it once with the command to run", async () => {
    const f = serve(world(), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/invites" ? { body: { code: "K7Q2-M9XD", expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    await user.click(await screen.findByRole("button", { name: "邀請電腦" }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByRole("textbox", { name: /名稱/ }), "studio pc");
    await user.click(within(dialog).getByRole("radio", { name: "1 小時" }));
    await user.click(within(dialog).getByRole("button", { name: "產生代碼" }));

    expect(await within(dialog).findByTestId("invite-code")).toHaveTextContent("K7Q2-M9XD");
    expect(posts(f)).toEqual([{ call: "POST /api/cluster/invites", body: { name: "studio pc", ttl_s: 3600 } }]);
    expect(within(dialog).getByTestId("invite-command")).toHaveTextContent(`miyoria host join ${window.location.origin} --code K7Q2-M9XD --name "studio pc"`);
    expect(within(dialog).getByText(/還有 \d+:\d\d 失效/)).toBeInTheDocument();
    expect(within(dialog).getByText(/只會顯示這一次/)).toBeInTheDocument();
    expect(within(dialog).getByText("miyoria host join --local")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "複製指令" }));
    expect(await navigator.clipboard.readText()).toBe(`miyoria host join ${window.location.origin} --code K7Q2-M9XD --name "studio pc"`);
  });

  it("defaults to ten minutes and leaves the name out when it is empty", async () => {
    const f = serve(world(), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/invites" ? { body: { code: "ABCD", expires_at: new Date(Date.now() + 600_000).toISOString() } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    await user.click(await screen.findByRole("button", { name: "邀請電腦" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "10 分鐘" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("button", { name: "產生代碼" }));
    expect(await within(dialog).findByTestId("invite-command")).toHaveTextContent(`miyoria host join ${window.location.origin} --code ABCD`);
    expect(within(dialog).getByTestId("invite-command").textContent).not.toContain("--name");
    expect(posts(f)[0]?.body).toEqual({ ttl_s: 600 });
  });
});

describe("Machines: who answers what", () => {
  it("lists candidates in order, marks the one in use and the capabilities nobody can serve", async () => {
    serve(world());
    renderRoute("/machines");
    const asr = (await screen.findByText("asr", { selector: '[data-capability] > span' })).closest("li") as HTMLElement;
    const candidates = within(asr).getAllByRole("listitem");
    expect(candidates).toHaveLength(2);
    expect(within(candidates[0] as HTMLElement).getByText("atlas / asr")).toBeInTheDocument();
    expect(within(candidates[0] as HTMLElement).getByText("直連")).toBeInTheDocument();
    expect(within(candidates[0] as HTMLElement).getByText("使用中")).toBeInTheDocument();
    expect(within(candidates[0] as HTMLElement).getByText("http://127.0.0.1:8003")).toBeInTheDocument();
    expect(within(candidates[1] as HTMLElement).getByText("經連線")).toBeInTheDocument();
    expect(within(candidates[1] as HTMLElement).queryByText("使用中")).not.toBeInTheDocument();

    const sing = document.querySelector('[data-capability="sing"]') as HTMLElement;
    expect(within(sing).getByText("沒有健康的服務")).toBeInTheDocument();
    expect(within(sing).queryByText("使用中")).not.toBeInTheDocument();
    const imagegen = document.querySelector('[data-capability="imagegen"]') as HTMLElement;
    expect(within(imagegen).getByText("沒有任何服務提供")).toBeInTheDocument();
  });

  it("fails on its own without blanking the hosts", async () => {
    mockFetch((_method, url) => {
      if (url.pathname === "/api/cluster/hosts") return { body: [LAPTOP] };
      if (url.pathname === "/api/cluster/endpoints") return { status: 500, body: { error: "registry unavailable" } };
      return undefined;
    });
    renderRoute("/machines");
    expect(await rowOf("laptop")).toBeInTheDocument();
    expect(await screen.findByText(/registry unavailable/)).toBeInTheDocument();
  });
});

describe("Machines: job dispatch", () => {
  const capRow = async (name: string) => {
    await screen.findByRole("heading", { name: "每個能力" });
    return document.querySelector(`[data-capability="${name}"]`) as HTMLElement;
  };
  const endpointOf = (cap: HTMLElement, key: string) => cap.querySelector(`[data-endpoint="${key}"]`) as HTMLElement;
  const REFUSAL = "調整分派需要 owner.cluster.route 權限(預設只有擁有者有)";

  it("shows each capability's class, scores, why an endpoint takes nothing new, and the decisions", async () => {
    serve(world({ routing: ROUTING }));
    renderRoute("/machines");
    const sing = await capRow("sing");
    expect(within(sing).getByText("工作 · 批次")).toBeInTheDocument();
    expect(sing).toHaveTextContent("版本 9f3a1c2b");
    expect(sing).toHaveTextContent("她語音所在的電腦 她閒置時才可以 · 她現在在語音");

    const atlas = endpointOf(sing, "atlas/sing");
    expect(atlas).toHaveTextContent("12.3 秒");
    expect(within(atlas).getByText("下一個")).toBeInTheDocument();
    expect(within(atlas).getByText("接新工作")).toBeInTheDocument();
    expect(within(atlas).getByTestId("score-parts")).toHaveTextContent("等待 2.0 秒 · 執行 9.0 秒 · 傳回 1.3 秒 · 加權 1");
    expect(within(atlas).getByText("執行 1 · 排隊 2 · 剛送出 1")).toBeInTheDocument();
    expect(within(atlas).getByText("每個工作約 9.0 秒(8 次) · 傳回 4.2 MB/s(3 次)")).toBeInTheDocument();

    const laptop = endpointOf(sing, "laptop/sing");
    expect(within(laptop).getByText("不接新工作")).toBeInTheDocument();
    expect(laptop).toHaveTextContent("她的語音(tts)在這台,她在語音、直播或剛說過話");
    expect(within(laptop).getByText("她的語音在這台")).toBeInTheDocument();
    expect(within(laptop).queryByText("下一個")).not.toBeInTheDocument();

    // Another variant: said on the capability, and its exclusion from the config is read only.
    expect(sing).toHaveTextContent("old / sing 的版本 77aa00ff 和其他台不同,不會用到");
    const old = endpointOf(sing, "old/sing");
    expect(within(old).getByText("設定檔")).toBeInTheDocument();
    expect(within(old).queryByRole("button", { name: /^排除/ })).not.toBeInTheDocument();

    const decisions = within(sing).getByRole("list", { name: "sing 最近的分派" });
    expect(within(decisions).getAllByRole("listitem")[0]).toHaveTextContent("3 分鐘前 · 小星星 → atlas · atlas 12.3 秒 / laptop 不接(她的語音在這台)");

    // Hosts: Core's own machine, the round trip, and a drain set from the panel.
    const hostAtlas = document.querySelector('[data-routing-host="atlas"]') as HTMLElement;
    expect(hostAtlas).toHaveTextContent("這台是 Core");
    expect(hostAtlas).toHaveTextContent("來回 2 ms");
    expect(within(hostAtlas).getByRole("spinbutton", { name: "atlas 的權重" })).toHaveValue(1);
    const hostLaptop = document.querySelector('[data-routing-host="laptop"]') as HTMLElement;
    expect(within(hostLaptop).getByText("擁有者在面板設定清空")).toBeInTheDocument();
    expect(within(hostLaptop).getByRole("button", { name: "恢復 laptop" })).toBeInTheDocument();
    expect(hostLaptop).toHaveTextContent("面板 · discord:1");
    expect(within(hostLaptop).getByRole("button", { name: "還原 laptop 的權重" })).toBeInTheDocument();
  });

  it("shows each host's routes, which one is in use for what, and what was measured", async () => {
    serve(world({ routing: ROUTING }));
    renderRoute("/machines");
    await capRow("sing");
    const routes = within(document.querySelector('[data-routing-host="laptop"]') as HTMLElement).getByRole("list", { name: "laptop 的連線路徑" });
    const route = (name: string) => routes.querySelector(`[data-route="${name}"]`) as HTMLElement;
    expect(route("direct")).toHaveTextContent("direct直連使用中 · 即時、一般32 ms · 9.4 MB/shttps://laptop.example.net:7890");
    expect(route("tunnel")).toHaveTextContent("使用中 · 大檔");
    expect(route("tunnel")).toHaveTextContent("140 ms · 22.5 MB/s · 每次最多 100 MB");
    expect(route("tailnet")).toHaveTextContent("剛剛失敗,先休息一下 · 連不上:fetch failed · 量於 1 分鐘前");
    expect(within(route("tailnet")).queryByText(/使用中/)).not.toBeInTheDocument();
    expect(route("relay")).toHaveTextContent("relay經控制連線38 ms還沒量過");
    expect(route("plain")).toHaveTextContent("不能用 · direct 一定要用 https");
    // An older Core sends no routes: nothing is shown for them.
    expect(document.querySelector('[data-routing-host="atlas"] [data-route]')).toBeNull();
  });

  it("says which single instance is used and which are not, and lists open sessions", async () => {
    serve(world({ routing: ROUTING }));
    renderRoute("/machines");
    const tts = await capRow("tts");
    expect(within(tts).getByText("唯一 · 即時")).toBeInTheDocument();
    expect(within(tts).getByRole("alert")).toHaveTextContent("只能有一個:用 atlas/tts,不用 laptop/tts");
    expect(within(endpointOf(tts, "atlas/tts")).getByText("使用中")).toBeInTheDocument();
    expect(within(tts).getByRole("list", { name: "tts 進行中的工作階段" })).toHaveTextContent("room-1 · atlas / tts");
  });

  it("shows a service's routing from the host, and nothing for an older hostd's", async () => {
    const withRouting = info({
      services: [
        service("sing", {
          provides: ["sing"],
          routing: svcRouting({ ready: false, reason: "少了 lead-split 模型", accept: false, owner_concurrency: 1 }),
          load: { running: 1, queued: 2, age_ms: 100, outside: "顯示卡借給 tts 了" },
        }),
        service("asr", { provides: ["asr"] }),
      ],
    });
    serve(world({ infos: { atlas: withRouting } }));
    renderRoute("/machines");
    const atlas = await rowOf("atlas");
    const table = await within(atlas).findByRole("table", { name: "atlas 的服務" });
    const sing = table.querySelector('[data-service="sing"]') as HTMLElement;
    // Once under the name for small screens, once in its own column.
    expect(within(sing).getAllByText("工作 · 沒準備好")).toHaveLength(2);
    expect(within(sing).getAllByText("少了 lead-split 模型")).toHaveLength(2);
    expect(within(sing).getAllByText("這台的主人不接受工作")).toHaveLength(2);
    expect(within(sing).getAllByText("主人限制同時 1 個")).toHaveLength(2);
    expect(within(sing).getAllByText("執行 1 · 排隊 2")).toHaveLength(2);
    expect(within(sing).getAllByText("顯示卡借給 tts 了")).toHaveLength(2);

    const asr = table.querySelector('[data-service="asr"]') as HTMLElement;
    expect(within(asr).queryByText(/就緒|沒準備好|排隊/)).not.toBeInTheDocument();
    expect(asr.querySelector('[data-cell="routing"]')).toHaveTextContent("—");
  });

  it("pins after a confirm and sends what the server needs", async () => {
    const f = serve(world({ routing: ROUTING }), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/routing/controls" ? { body: ROUTING } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const sing = await capRow("sing");
    await user.click(within(sing).getByRole("button", { name: "只用 laptop 做 sing" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("只用 laptop 做 sing?")).toBeInTheDocument();
    expect(within(dialog).getByText(/其他電腦不會再收到 sing 的新工作/)).toBeInTheDocument();
    expect(posts(f)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "只用這台" }));
    await waitFor(() =>
      expect(posts(f)).toEqual([{ call: "POST /api/cluster/routing/controls", body: { action: "set", kind: "pin", host: "laptop", capability: "sing" } }]),
    );
    expect(await screen.findByText("sing 只用 laptop")).toBeInTheDocument();
  });

  it("drains after a confirm and shows the server's refusal", async () => {
    const f = serve(world({ routing: ROUTING }), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/routing/controls" ? { status: 403, body: { error: REFUSAL } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    await capRow("sing");
    await user.click(screen.getByRole("button", { name: "清空 atlas" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("清空 atlas?")).toBeInTheDocument();
    expect(within(dialog).getByText("做完手上的工作,不再接新的,直到恢復。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "清空" }));
    await waitFor(() => expect(posts(f)).toEqual([{ call: "POST /api/cluster/routing/controls", body: { action: "set", kind: "drain", host: "atlas" } }]));
    expect(await screen.findByText(`調整分派失敗:${REFUSAL}`)).toBeInTheDocument();
    // The dialog stays for another try.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("excludes, resumes and weighs at once", async () => {
    const f = serve(world({ routing: ROUTING }), (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/routing/controls" ? { body: ROUTING } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const tts = await capRow("tts");
    await user.click(within(tts).getByRole("button", { name: "排除 laptop 的 tts" }));
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "恢復 laptop" }));
    await waitFor(() => expect(posts(f)).toHaveLength(2));
    const weight = screen.getByRole("spinbutton", { name: "atlas 的權重" });
    await user.clear(weight);
    await user.type(weight, "3");
    await user.click(within(document.querySelector('[data-routing-host="atlas"]') as HTMLElement).getByRole("button", { name: "套用" }));
    await waitFor(() =>
      expect(posts(f).map((p) => p.body)).toEqual([
        { action: "set", kind: "exclude", host: "laptop", capability: "tts" },
        { action: "clear", kind: "drain", host: "laptop" },
        { action: "set", kind: "weight", host: "atlas", value: 3 },
      ]),
    );
  });
});

describe("Machines: page states", () => {
  it("explains a stopped cluster module instead of toasting an error", async () => {
    mockFetch((_m, url) => (url.pathname.startsWith("/api/cluster/") ? { status: 503, body: { error: "the cluster module is not running" } } : undefined));
    renderRoute("/machines");
    expect(await screen.findByText("叢集模組沒有啟動")).toBeInTheDocument();
    expect(screen.getByText("[modules.cluster]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "邀請電腦" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains both ways to add a machine when there are none", async () => {
    serve(world({ hosts: [], endpoints: { capabilities: [] } }));
    const user = userEvent.setup();
    renderRoute("/machines");
    expect(await screen.findByText("還沒有電腦加入。")).toBeInTheDocument();
    expect(screen.getByText("miyoria host join --local")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "邀請電腦" })[0] as HTMLElement);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("is in the navigation as 電腦", async () => {
    serve(world());
    renderRoute("/machines");
    expect(await screen.findAllByRole("link", { name: "電腦" })).not.toHaveLength(0);
  });
});

describe("Machines: versions and updates", () => {
  const CORE = "c".repeat(40);
  const OLD = "a".repeat(40);
  const checkout = (commit: string, over: Partial<NonNullable<ClusterHostView["checkout"]>> = {}) => ({
    commit,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: false,
    fetched_at: null,
    read_at: Date.now(),
    ...over,
  });
  const live = { connected: true, connected_since: iso(60_000) };
  const FRIEND = host("friend", {
    ...live,
    checkout: checkout(OLD),
    relation: { relation: "behind", count: 3 },
    remote_update: { allowed: true },
    upgrade: null,
  });
  const CLOSED = host("closed", {
    ...live,
    checkout: checkout(OLD),
    relation: { relation: "behind", count: 3 },
    remote_update: { allowed: false, reason: "這台的主人關掉了遠端更新(host.toml 的 [update] allow_remote = false)" },
  });
  const MAIN = host("main-pc", {
    ...live,
    checkout: checkout(CORE),
    relation: { relation: "same" },
    remote_update: { allowed: false, reason: "這台跑著 Core,不能從面板更新;請在這台執行 miyoria update" },
  });
  const OLDHOST = host("old-pc", live);

  function serveUpdates(hosts: ClusterHostView[], extra?: Parameters<typeof mockFetch>[0]) {
    const infos = Object.fromEntries(hosts.map((h) => [h.name, info({ name: h.name })]));
    return serve(world({ hosts, infos }), (method, url, body, headers) => {
      if (method === "GET" && url.pathname === "/api/cluster/checkout") return { body: { checkout: checkout(CORE) } };
      return extra?.(method, url, body, headers);
    });
  }

  it("shows each version, how it stands to Core's, and plainly why a host cannot be updated", async () => {
    serveUpdates([FRIEND, CLOSED, MAIN, OLDHOST]);
    renderRoute("/machines");
    const friend = await rowOf("friend");
    expect(within(friend).getByText("main · aaaaaaaa")).toBeInTheDocument();
    expect(within(friend).getByText("落後 Core 3 個提交")).toBeInTheDocument();
    expect(within(friend).getByRole("checkbox", { name: "選取 friend" })).toBeEnabled();

    const closed = await rowOf("closed");
    expect(within(closed).getByText(/不能從面板更新:這台的主人關掉了遠端更新/)).toBeInTheDocument();
    expect(within(closed).getByRole("checkbox", { name: "選取 closed" })).toBeDisabled();

    const main = await rowOf("main-pc");
    expect(within(main).getByText("與 Core 相同")).toBeInTheDocument();
    expect(within(main).getByText(/這台跑著 Core/)).toBeInTheDocument();

    const old = await rowOf("old-pc");
    expect(within(old).getByText(/版本不明/)).toBeInTheDocument();
    expect(within(old).queryByRole("checkbox")).not.toBeInTheDocument();

    // Core's own version above the list, and main-pc's in its row.
    expect(await screen.findByText("Core 的版本")).toBeInTheDocument();
    expect(await screen.findAllByText("main · cccccccc")).toHaveLength(2);
  });

  it("updates the picked hosts after one confirmation, with only their names sent", async () => {
    const f = serveUpdates([FRIEND, CLOSED], (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/upgrade"
        ? { body: { commit: CORE, results: [{ host: "friend", ok: true }] } }
        : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const friend = await rowOf("friend");
    const update = await screen.findByRole("button", { name: "更新" });
    expect(update).toBeDisabled();
    await user.click(within(friend).getByRole("checkbox", { name: "選取 friend" }));
    expect(screen.getByText("已選 1 台")).toBeInTheDocument();
    await user.click(update);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("friend:aaaaaaaa → cccccccc")).toBeInTheDocument();
    expect(within(dialog).getByText(/模型不會下載/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "更新" }));
    await waitFor(() => expect(posts(f)).toEqual([{ call: "POST /api/cluster/upgrade", body: { hosts: ["friend"] } }]));
  });

  it("shows a waiting update with what it waits for, its steps, and a cancel", async () => {
    const waiting = host("friend", {
      ...live,
      checkout: checkout(OLD),
      relation: { relation: "behind", count: 3 },
      remote_update: { allowed: true },
      upgrade: {
        id: "j1",
        target: CORE,
        from: OLD,
        state: "waiting",
        step: "wait",
        waiting_for: "sing 正在處理工作",
        started_at: Date.now() - 60_000,
        steps: [
          { step: "check", state: "done", at: Date.now() - 60_000 },
          { step: "fetch", state: "done", detail: "aaaaaaaa → cccccccc 可以快轉", at: Date.now() - 50_000 },
          { step: "wait", state: "running", detail: "sing 正在處理工作", at: Date.now() - 40_000 },
        ],
      },
    });
    const f = serveUpdates([waiting], (method, url) =>
      method === "POST" && url.pathname === "/api/cluster/hosts/friend/upgrade/cancel" ? { body: { cancelled: true, job: null } } : undefined,
    );
    const user = userEvent.setup();
    renderRoute("/machines");
    const row = await rowOf("friend");
    expect(within(row).getAllByText("等她忙完").length).toBeGreaterThan(0);
    expect(within(row).getAllByText("sing 正在處理工作").length).toBeGreaterThan(0);
    const steps = within(row).getByRole("list", { name: "更新步驟" });
    expect(within(steps).getByText("取得新版")).toBeInTheDocument();
    // A host that is updating cannot be picked again.
    expect(within(row).getByRole("checkbox", { name: "選取 friend" })).toBeDisabled();
    await user.click(within(row).getByRole("button", { name: "取消更新" }));
    await waitFor(() => expect(posts(f)).toEqual([{ call: "POST /api/cluster/hosts/friend/upgrade/cancel", body: {} }]));
  });

  it("shows a failed update's reason, that it went back, and what is missing", async () => {
    const failed = host("friend", {
      ...live,
      checkout: checkout(OLD),
      relation: { relation: "behind", count: 3 },
      remote_update: { allowed: true },
      upgrade: {
        id: "j2",
        target: CORE,
        from: OLD,
        state: "failed",
        step: "rollback",
        started_at: Date.now() - 600_000,
        finished_at: Date.now() - 500_000,
        error: "pnpm install 失敗:ERR_PNPM_EPERM",
        rolled_back: true,
        commit: OLD,
        missing: [{ service: "sing", kind: "file", what: "lead-split/x.yaml" }],
        steps: [{ step: "rollback", state: "done", detail: "已回到 aaaaaaaa", at: Date.now() - 500_000 }],
      },
    });
    serveUpdates([failed]);
    renderRoute("/machines");
    const row = await rowOf("friend");
    expect(within(row).getByRole("alert")).toHaveTextContent("pnpm install 失敗");
    expect(within(row).getByText("已回到 aaaaaaaa", { selector: "dd" })).toBeInTheDocument();
    expect(within(row).getByText("sing:lead-split/x.yaml")).toBeInTheDocument();
    expect(within(row).getByText(/更新不會下載模型/)).toBeInTheDocument();
  });
});
