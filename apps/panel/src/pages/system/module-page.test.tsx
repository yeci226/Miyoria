import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ModuleDetail, ModuleSettings, SettingField, SettingsHistory } from "@miyoria/contracts/api";
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

  it("is read only for someone without the module's settings node", async () => {
    core(settings({ can_edit: false }), () => ({ body: {} }));
    renderRoute("/system/party");
    expect(await screen.findByLabelText("猜歌幾首")).toBeDisabled();
    expect(screen.getByText(/admin\.settings\.party/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "還原成檔案的值" })).not.toBeInTheDocument();
  });
});
