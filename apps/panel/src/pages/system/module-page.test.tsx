import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AdminSpace, AdminSpaces, ModuleDetail, ModuleSettings, SettingField, SettingsHistory } from "@miyoria/contracts/api";
import { mockFetch, renderRoute } from "@/test/render";

const field = (over: Partial<SettingField> & Pick<SettingField, "path" | "kind" | "label">): SettingField => ({
  keys: over.path.split("."),
  help: null,
  group: "games",
  order: 10,
  apply: "module",
  danger: null,
  secret: false,
  scope: "cluster",
  merge: "replace",
  unit: null,
  labels: null,
  room: null,
  multiple: false,
  ref: "id",
  min: null,
  max: null,
  step: null,
  int: false,
  max_length: null,
  pattern: null,
  options: null,
  slider: false,
  long: false,
  default: null,
  ...over,
});

const DETAIL: ModuleDetail = {
  id: "party",
  name: "派對遊戲",
  description: "",
  enabled: true,
  state: "running",
  reason: null,
  recent_restarts: 0,
  icon: "party-popper",
  category: "play",
  settings: true,
  card: { facts: [{ label: "進行中", value: 1, unit: "場" }] },
  pending: null,
  required: false,
  requires: [],
  optional: [],
  dependents: [],
};

function settings(over: Partial<ModuleSettings> = {}): ModuleSettings {
  return {
    module: "party",
    name: "派對遊戲",
    revision: 4,
    groups: [{ id: "games", label: "遊戲" }],
    fields: [
      field({ path: "song_rounds", kind: "number", label: "猜歌幾首", min: 1, max: 30, int: true, step: 1, default: 8 }),
      field({ path: "rewards.enabled", kind: "switch", label: "玩完發魚幣", default: true }),
      field({ path: "drop_channels", kind: "channel", label: "掉落的頻道", multiple: true, default: [] }),
    ],
    values: {
      song_rounds: { value: 12, source: "panel", file: 8, file_set: true, set: true, env: null, invalid: null },
      "rewards.enabled": { value: true, source: "default", file: null, file_set: false, set: true, env: null, invalid: null },
      drop_channels: { value: ["111"], source: "file", file: ["111"], file_set: true, set: true, env: null, invalid: null },
    },
    updated: { version: 4, at: "2026-11-17T15:10:00.000Z", by: "panel:discord:1", by_label: "Owen" },
    guard: null,
    pending: null,
    can_edit: true,
    currency: "魚幣",
    ...over,
  };
}

const HISTORY: SettingsHistory = {
  items: [
    {
      version: 4,
      at: "2026-11-17T15:10:00.000Z",
      by: "panel:discord:1",
      by_label: "Owen",
      note: null,
      changes: [{ path: "song_rounds", label: "猜歌幾首", before: null, after: 12 }],
    },
  ],
  next_before: null,
};

const ROOMS = {
  ready: true,
  rooms: [
    { platform: "discord", id: "111", context: "discord:9:111", name: "閒聊", kind: "text", space: { id: "9", name: "魚缸" }, category: null, position: 0, usable: true, reason: null },
    { platform: "discord", id: "222", context: "discord:9:222", name: "公告", kind: "text", space: { id: "9", name: "魚缸" }, category: null, position: 1, usable: false, reason: "她不能在這裡發言" },
  ],
};

const SPACE_A: AdminSpace = { id: "a", platform: "discord", external_id: "9", name: "魚缸", primary: true, established: true, members: 3 };
const SPACE_B: AdminSpace = { id: "b", platform: "discord", external_id: "8", name: "第二", primary: false, established: false, members: 1 };

/** `fetch`'s handler with `GET /api/places/spaces` answered first. */
function spacesFirst(fetch: ReturnType<typeof mockFetch>, spaces: AdminSpaces) {
  const inner = fetch.getMockImplementation();
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input), "http://panel.test").pathname === "/api/places/spaces") {
      return new Response(JSON.stringify(spaces), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (inner === undefined) throw new Error("no fetch");
    return inner(input, init);
  };
}

function core(view: ModuleSettings, save: (body: unknown) => { status?: number; body: unknown }) {
  const puts: unknown[] = [];
  const fetch = mockFetch((method, url, body) => {
    if (url.pathname === "/api/modules/party") return { body: DETAIL };
    if (url.pathname === "/api/modules/party/settings" && method === "GET") return { body: view };
    if (url.pathname === "/api/modules/party/settings" && method === "PUT") {
      puts.push(body);
      return save(body);
    }
    if (url.pathname === "/api/modules/party/settings/history") return { body: HISTORY };
    if (url.pathname === "/api/places/rooms") return { body: ROOMS };
    if (url.pathname === "/api/modules") return { body: [] };
    return undefined;
  });
  return { fetch, puts };
}

describe("a module's page", () => {
  it("shows the card, the fields with where they come from, and the change log", async () => {
    core(settings(), () => ({ body: {} }));
    renderRoute("/system/party");
    expect(await screen.findByRole("heading", { level: 2, name: "派對遊戲" })).toBeInTheDocument();
    expect(screen.getByText("進行中")).toBeInTheDocument();
    const rounds = await screen.findByLabelText("猜歌幾首");
    expect(rounds).toHaveValue(12);
    expect(screen.getByText(/面板改過 · 檔案:8/)).toBeInTheDocument();
    expect(await screen.findByText("閒聊")).toBeInTheDocument();
    const log = screen.getByRole("region", { name: "變更紀錄" });
    expect(within(log).getByText("Owen · 第 4 版")).toBeInTheDocument();
    expect(within(log).getByText("12")).toBeInTheDocument();
  });

  it("saves the changed fields with one button and shows Core's problems under the field", async () => {
    const { puts } = core(settings(), () => ({ status: 400, body: { error: "bad", problems: [{ path: "song_rounds", message: "猜歌幾首:數值過大" }] } }));
    const user = userEvent.setup();
    renderRoute("/system/party");
    const rounds = await screen.findByLabelText("猜歌幾首");
    await user.clear(rounds);
    // Within the field's HTML limits (1..30); Core refuses it anyway, and says why.
    await user.type(rounds, "25");
    await user.click(screen.getByRole("switch"));
    expect(screen.getByText(/項沒存/)).toHaveTextContent("有 2 項沒存");
    await user.click(screen.getByRole("button", { name: "儲存並重新啟動派對遊戲" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ expected: 4, set: { song_rounds: 25, "rewards.enabled": false }, reset: [] });
    expect(await screen.findByText("猜歌幾首:數值過大")).toBeInTheDocument();
    expect(rounds).toHaveAttribute("aria-invalid", "true");
  });

  it("puts a field back to the file's value", async () => {
    const { puts } = core(settings(), () => ({ body: { revision: 5, applied: "restarted", state: "running", reason: null } }));
    const user = userEvent.setup();
    renderRoute("/system/party");
    await user.click(await screen.findByRole("button", { name: "還原成檔案的值" }));
    expect(await screen.findByLabelText("猜歌幾首")).toHaveValue(8);
    await user.click(screen.getByRole("button", { name: "儲存並重新啟動派對遊戲" }));
    await waitFor(() => expect(puts).toEqual([{ expected: 4, set: {}, reset: ["song_rounds"] }]));
  });

  it("asks first when the restart has to wait for her to finish singing", async () => {
    const { puts } = core(settings({ guard: "singing" }), () => ({ body: { revision: 5, applied: "deferred", state: "running", reason: null } }));
    const user = userEvent.setup();
    renderRoute("/system/party");
    await user.click(await screen.findByRole("switch"));
    await user.click(screen.getByRole("button", { name: "儲存並重新啟動派對遊戲" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getAllByText(/她唱完/).length).toBeGreaterThan(0);
    expect(puts).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "儲存,之後套用" }));
    await waitFor(() => expect(puts).toHaveLength(1));
  });

  it("with one server shows no server switch and no scope, as before", async () => {
    const { fetch } = core(settings({ fields: [field({ path: "song_rounds", kind: "number", label: "猜歌幾首", scope: "space", default: 8 })] }), () => ({ body: {} }));
    const one: AdminSpaces = { spaces: [SPACE_A], default: "a" };
    fetch.mockImplementation(spacesFirst(fetch, one));
    renderRoute("/system/party");
    expect(await screen.findByLabelText("猜歌幾首")).toHaveValue(12);
    expect(screen.queryByRole("combobox", { name: "伺服器" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "範圍" })).not.toBeInTheDocument();
  });

  it("with two servers sets a server's own value at once, and says what it inherits", async () => {
    const view = settings({
      fields: [
        field({ path: "song_rounds", kind: "number", label: "猜歌幾首", scope: "space", default: 8 }),
        field({ path: "rewards.enabled", kind: "switch", label: "玩完發魚幣", default: true }),
      ],
    });
    const atA = settings({
      ...view,
      place: { space: { id: "a", name: "魚缸" }, room: null },
      values: {
        ...view.values,
        song_rounds: { value: 5, source: "space", file: 8, file_set: true, set: true, env: null, invalid: null, place: { own: 5, own_set: true, inherited: 12, inherited_from: "panel" } },
      },
    });
    const puts: { url: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      if (url.pathname === "/api/places/spaces") return { body: { spaces: [SPACE_A, SPACE_B], default: "a" } };
      if (url.pathname === "/api/modules/party") return { body: DETAIL };
      if (url.pathname === "/api/modules/party/settings" && method === "GET") return { body: url.searchParams.get("space") === "a" ? atA : view };
      if (url.pathname === "/api/modules/party/settings" && method === "PUT") {
        puts.push({ url: url.search, body });
        return { body: { revision: 4, applied: "immediate", state: "running", reason: null } };
      }
      if (url.pathname === "/api/modules/party/settings/history") return { body: { items: [], next_before: null } };
      if (url.pathname === "/api/places/rooms") return { body: ROOMS };
      if (url.pathname === "/api/modules") return { body: [] };
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute("/system/party");
    expect(await screen.findByRole("combobox", { name: "伺服器" })).toBeInTheDocument();
    const scope = await screen.findByRole("radiogroup", { name: "範圍" });
    expect(within(scope).getByRole("radio", { name: "魚缸" })).toBeChecked();
    const rounds = await screen.findByLabelText("猜歌幾首");
    await waitFor(() => expect(rounds).toHaveValue(5));
    expect(screen.getByText(/這個伺服器設的 · 拿掉後是 12/)).toBeInTheDocument();
    // A field that is the same everywhere is not on a server's form.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/其他 1 項設定所有地方都一樣/)).toBeInTheDocument();
    await user.clear(rounds);
    await user.type(rounds, "7");
    await user.click(screen.getByRole("button", { name: "儲存到魚缸" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: "?space=a", body: { expected: 4, set: { song_rounds: 7 }, reset: [] } });

    // The whole install's values are one click away.
    await user.click(within(scope).getByRole("radio", { name: "全部伺服器" }));
    expect(await screen.findByRole("switch")).toBeInTheDocument();
    expect(screen.getByLabelText("猜歌幾首")).toHaveValue(12);
  });

  it("is read only for someone without the module's settings node", async () => {
    core(settings({ can_edit: false }), () => ({ body: {} }));
    renderRoute("/system/party");
    expect(await screen.findByLabelText("猜歌幾首")).toBeDisabled();
    expect(screen.getByText(/admin\.settings\.party/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "還原成檔案的值" })).not.toBeInTheDocument();
  });
});
