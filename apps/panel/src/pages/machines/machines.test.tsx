import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ClusterEndpoints, ClusterHostInfo, ClusterHostView } from "@miyoria/contracts/api";
import { mockFetch, renderRoute } from "@/test/render";
import { fmtCountdown, fmtDuration, parseCapabilities } from "./labels";

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

interface World {
  hosts: ClusterHostView[];
  infos: Record<string, ClusterHostInfo | { status: number; error: string }>;
  endpoints: ClusterEndpoints;
}

const world = (over: Partial<World> = {}): World => ({ hosts: [PENDING, ATLAS, LAPTOP], infos: { atlas: ALL_STATES }, endpoints: ENDPOINTS, ...over });

function serve(w: World, extra?: Parameters<typeof mockFetch>[0]) {
  return mockFetch((method, url, body, headers) => {
    const extraRes = extra?.(method, url, body, headers);
    if (extraRes) return extraRes;
    if (method === "GET" && url.pathname === "/api/cluster/hosts") return { body: w.hosts };
    if (method === "GET" && url.pathname === "/api/cluster/endpoints") return { body: w.endpoints };
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
