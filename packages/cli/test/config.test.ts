// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredModules } from "@miyoria/core/light";
import { SqliteStore } from "@miyoria/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig } from "../src/assets.js";
import * as config from "../src/commands/config.js";
import { parseKey } from "../src/toml-patch.js";
import { type Output, setOutput } from "../src/ui.js";
import { type Change, renderChange, Workspace } from "../src/workspace.js";
import { Picks, Scripted, Text, tempDir, Yes } from "./scripted.js";

let dir: string;
let path: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  dir = tempDir();
  path = join(dir, "miyoria.toml");
  writeFileSync(path, exampleConfig());
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});

afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

const text = () => out.join("");
const read = (p: string) => readFileSync(join(dir, p), "utf8");

describe("config", () => {
  it("env_names_for_new_secrets", () => {
    expect(config.envNameFor(parseKey('modules."platform.x".api_key'))).toBe("PLATFORM_X_API_KEY");
  });

  it("classifies_restarts", () => {
    const ws = Workspace.open(path);
    const change = (target: Change["target"], key: string, value: string | null): Change => ({
      target,
      key,
      old: null,
      new: value,
    });
    const [toggles, areas] = config.classify(ws, [
      change("toml", "modules.agent.enabled", "false"),
      change("toml", "modules.memory.enabled", null),
      change("toml", "speech.tts.local.voice", '"x"'),
      change("env", "MIYORIA_OWNER_ID", "1"),
      change("env", "STAGE_LINK_TOKEN", "1"),
    ]);
    expect(toggles).toEqual([
      ["agent", false],
      ["memory", true],
    ]);
    expect(areas).toEqual(["commands", "speech", "stage 節點", "stage.link"]);
  });

  it("menu_areas_edit_only_picked_fields", async () => {
    writeFileSync(join(dir, ".env"), "OBS_PASSWORD=old-password-123\n");
    const ws = Workspace.open(path, { processEnv: new Map() });
    // Stage: pick OBS port (5) and enable OBS (3).
    await config.runArea("stage", new Scripted([Picks(3, 5), Yes, Text("4456")]), ws);
    expect(ws.changes().map(renderChange)).toEqual([
      "~ stage.obs.enabled: false → true",
      "~ stage.obs.port: 4455 → 4456",
    ]);

    // Modules: turn off agent.
    const mods = configuredModules(config.workspaceConfig(ws));
    const keep = mods.flatMap(([id], i) => (id === "agent" ? [] : [i]));
    await config.runArea("modules", new Scripted([Picks(...keep)]), ws);
    expect(ws.doc.toString()).toContain("[modules.agent]\nenabled = false\n");
    ws.save();
    const saved = read("miyoria.toml");
    expect(saved).toContain('password = "${OBS_PASSWORD:-}"'); // secret reference untouched
    expect(saved).toContain("port = 4456\n");
  });

  it("set_writes_references_to_env_and_values_to_toml", async () => {
    writeFileSync(join(dir, ".env"), "LLM_API_KEY=old\n");
    await config.set(
      path,
      ["llm.providers.deepseek.api_key", "sk-new-1234567890"],
      undefined,
      false,
    );
    expect(read(".env")).toBe("LLM_API_KEY=sk-new-1234567890\n");
    expect(text()).toContain("引用 ${LLM_API_KEY},改寫 .env 的 LLM_API_KEY");
    expect(text()).not.toContain("sk-new-1234567890");

    await config.set(path, ["core.log", "debug"], undefined, false);
    expect(read("miyoria.toml")).toContain('log = "debug"\n');
    await config.set(path, ["stage.obs.port", "4460"], undefined, false);
    expect(read("miyoria.toml")).toContain("port = 4460\n");

    // A new plain secret goes to .env behind a reference.
    await config.set(path, ['modules."platform.x".api_key', "secret-value-123"], undefined, false);
    expect(read("miyoria.toml")).toContain(
      '[modules."platform.x"]\napi_key = "${PLATFORM_X_API_KEY:-}"\n',
    );
    expect(read(".env")).toContain("PLATFORM_X_API_KEY=secret-value-123\n");

    await expect(config.set(path, ["stage.obs.port", "abc"], undefined, false)).rejects.toThrow(
      /port/,
    );
    await expect(config.set(path, ["llm.providers", "x"], undefined, false)).rejects.toThrow(
      /是表格/,
    );
    await expect(config.set(path, ["x"], "1BAD", false)).rejects.toThrow(/不是合法的環境變數名稱/);
  });

  it("unset_get_and_list", async () => {
    writeFileSync(join(dir, ".env"), "LLM_API_KEY=sk-1234567890abcd\nUNUSED=1\n");
    await config.get(path, "llm.providers.deepseek.api_key", undefined, false);
    expect(text()).toContain("••••abcd");
    expect(text()).toContain("LLM_API_KEY: .env");
    out.length = 0;
    config.list(path, false);
    expect(text()).toContain('core.profile = "deepseek-chan"');
    expect(text()).toContain("UNUSED = 1  (miyoria.toml 沒有引用)");
    expect(text()).not.toContain("sk-1234567890abcd");
    await config.unset(path, "core.log", undefined, false);
    expect(read("miyoria.toml")).not.toContain("log = ");
    await config.unset(path, undefined, "UNUSED", false);
    expect(read(".env")).toBe("LLM_API_KEY=sk-1234567890abcd\n");
    await expect(config.unset(path, "core.nope", undefined, false)).rejects.toThrow(
      /沒有 `core.nope`/,
    );
    await expect(config.get(path, "nope", undefined, false)).rejects.toThrow(/miyoria config list/);
  });

  it("says_where_the_panel_covers_a_key_lists_the_layer_and_bakes_it_into_the_file", async () => {
    // The database the example config names, with a panel edit and a module switch in it.
    writeFileSync(
      path,
      `[core]\ndatabase_url = "sqlite:data/test.db"\n\n[modules.market]\nauction_hours = 12\n`,
    );
    const store = await SqliteStore.open(join(dir, "data", "test.db"));
    store.config.revisions.write(
      { modules: { market: { auction_hours: 48, auction_step: 7 }, cards: { enabled: false } } },
      "panel:discord:1",
    );
    await store.close();

    await config.get(path, "modules.market.auction_hours", undefined, false);
    expect(text()).toContain("48\n");
    expect(text()).toContain("面板改過:48(第 1 版,panel:discord:1");
    expect(text()).toContain("miyoria.toml:12");
    out.length = 0;

    await config.overrides(path);
    expect(text()).toContain("modules.market.auction_hours = 48");
    expect(text()).toContain("檔案:12");
    expect(text()).toContain("modules.market.auction_step = 7");
    expect(text()).not.toContain("enabled");
    out.length = 0;

    await config.set(path, ["modules.market.auction_hours", "24"], undefined, false);
    expect(text()).toContain("檔案的值不會生效");
    out.length = 0;

    await config.bake(path, true, null);
    expect(read("miyoria.toml")).toContain("auction_hours = 48\n");
    expect(read("miyoria.toml")).toContain("auction_step = 7\n");
    const after = await SqliteStore.open(join(dir, "data", "test.db"));
    expect(after.config.revisions.current()?.doc).toEqual({
      modules: { cards: { enabled: false } },
    });
    expect(after.config.revisions.current()?.created_by).toBe("cli");
    await after.close();
  });

  it("imports_the_file_into_the_database_by_hand_with_a_dry_run_first", async () => {
    writeFileSync(
      path,
      [
        "[core]",
        'database_url = "sqlite:data/test.db"',
        "",
        "[modules.market]",
        "auction_hours = 12",
        'auction_channel = "5001"',
        "",
        "[modules.api]",
        'token = "${MIYORIA_API_TOKEN:-}"',
        "",
      ].join("\n"),
    );
    const store = await SqliteStore.open(join(dir, "data", "test.db"));
    store.places.seen("discord", "111", "一號");
    store.persons.ensureRoom("discord", "111", "5001", "text");
    store.config.revisions.write({ modules: { market: { auction_step: 7 } } }, "panel:discord:1");
    await store.close();

    await config.importConfig(path, { replace: false, dryRun: true, yes: false }, null);
    expect(text()).toContain("試跑");
    expect(text()).toContain("寫成第 2 版");
    expect(text()).toContain("modules.market.auction_step");
    expect(text()).toContain('伺服器 discord:111  market.auction_channel = "5001"');
    const before = await SqliteStore.open(join(dir, "data", "test.db"));
    expect(before.config.revisions.current()?.version).toBe(1);
    await before.close();
    out.length = 0;

    // Not in a terminal and without --yes: nothing is written.
    await expect(
      config.importConfig(path, { replace: false, dryRun: false, yes: false }, null),
    ).rejects.toThrow(/--yes/);
    await config.importConfig(path, { replace: false, dryRun: false, yes: true }, null);
    expect(text()).toContain("已寫入第 2 版");
    const after = await SqliteStore.open(join(dir, "data", "test.db"));
    expect(after.config.revisions.current()).toMatchObject({ version: 2, created_by: "import" });
    expect(after.config.revisions.current()?.doc).toMatchObject({
      modules: {
        market: { auction_hours: 12, auction_step: 7, auction_channel: "5001" },
        api: { token: "${MIYORIA_API_TOKEN:-}" },
      },
    });
    await after.close();
    out.length = 0;

    // `get` says where a value comes from, and each server's own value.
    await config.get(path, "modules.market.auction_hours", undefined, false);
    expect(text()).toContain("12\n");
    expect(text()).toContain("來源:資料庫第 2 版(import");
    expect(text()).toContain("和 miyoria.toml 一樣");
    out.length = 0;
    await config.get(path, "modules.market.auction_channel", undefined, false);
    expect(text()).toContain('伺服器 一號:"5001"');
    out.length = 0;

    // Once imported, again only with --replace.
    await config.importConfig(path, { replace: false, dryRun: true, yes: false }, null);
    expect(text()).toContain("已經匯入過");
  });

  it("refuses_to_import_a_file_with_a_secret_as_text", async () => {
    writeFileSync(
      path,
      `[core]\ndatabase_url = "sqlite:data/test.db"\n\n[modules.api]\ntoken = "abc123"\n`,
    );
    const store = await SqliteStore.open(join(dir, "data", "test.db"));
    await store.close();
    await expect(
      config.importConfig(path, { replace: false, dryRun: true, yes: true }, null),
    ).rejects.toThrow(/modules\.api\.token.*\.env/);
  });

  it("editor_command_parses_arguments", () => {
    expect(config.editorCommand({ EDITOR: "code -w" })).toEqual(["code", ["-w"]]);
    expect(config.editorCommand({ VISUAL: "nvim", EDITOR: "code" })[0]).toBe("nvim");
    expect(config.editorCommand({})[0]).toBe(process.platform === "win32" ? "notepad" : "vi");
  });
});
