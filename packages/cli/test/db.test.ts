// `miyoria db import-links / archive / doctor`: the printers over the store's cut-over functions,
// on a small V4 database from `@miyoria/store/testing`.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@miyoria/store";
import { v4File } from "@miyoria/store/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, helpText, parseArgs } from "../src/cli.js";
import { archiveCommand, doctorCommand, importLinksCommand } from "../src/commands/db.js";
import { setOutput } from "../src/ui.js";
import { Scripted, Text } from "./scripted.js";

let root = "";
let out: string[] = [];
let restore: () => void = () => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-cli-db-"));
  mkdirSync(join(root, "data"));
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) });
});
afterEach(() => {
  restore();
  rmSync(root, { recursive: true, force: true });
});

const text = () => out.join("");
/** Paths as the commands print them: with forward slashes, which every shell takes. */
const slashed = (path: string) => path.replaceAll("\\", "/");
const lastLines = (n: number) => text().trimEnd().split("\n").slice(-n);

function config(databaseUrl: string): string {
  const path = join(root, "miyoria.toml");
  writeFileSync(path, `[core]\nprofile = "deepseek-chan"\ndatabase_url = "${databaseUrl}"\n`);
  return path;
}

function oldDatabase(name = "miyoria.db"): string {
  const path = join(root, "data", name);
  v4File(path).close();
  return path;
}

describe("miyoria db import-links", () => {
  it("lists what it would bring in a dry run, then imports, ending with the counts", async () => {
    const old = oldDatabase();
    const cfg = config("sqlite:data/core.db");
    await importLinksCommand(cfg, { from: old, dryRun: true });
    expect(text()).toContain("試跑完成,沒有寫入任何東西");
    expect(text()).toContain("owen → owen#2");
    expect(existsSync(join(root, "data", "core.db"))).toBe(false);

    out = [];
    await importLinksCommand(cfg, { from: old, dryRun: false });
    expect(lastLines(7)).toEqual([
      "數量",
      "  人 4(另有 1 人只為了保存選擇而建立)、帳號 6",
      "  handle:沿用 4、改名 1、新取 0",
      "  選擇:隱私 1、語音同意 3",
      "  紀念卡資料:有舊羈絆的 2 人、舊卡 3 張",
      "  略過:已經匯入 0、沒有帳號 1、找不到人的帳號 1、沒人用的 handle 1",
      `✓ 匯入完成:5 人、6 個帳號,5 筆 identity.imported 事件,建立了 ${slashed(join(root, "data", "core.db"))}`,
    ]);
  });

  it("needs --from, and refuses a new database still named miyoria.db", async () => {
    const old = oldDatabase("old.db");
    await expect(
      importLinksCommand(config("sqlite:data/core.db"), { from: undefined, dryRun: true }),
    ).rejects.toThrow("--from");
    await expect(
      importLinksCommand(config("sqlite:data/miyoria.db"), { from: old, dryRun: true }),
    ).rejects.toThrow("core.database_url sqlite:data/core.db");
  });
});

describe("miyoria db archive", () => {
  it("asks for the word, then archives and prints the next commands", async () => {
    oldDatabase();
    const cfg = config("sqlite:data/miyoria.db");
    const options = { file: undefined, dryRun: false, yes: false };
    await expect(archiveCommand(cfg, options, null)).rejects.toThrow("--yes");
    await archiveCommand(cfg, options, new Scripted([Text("yes")]));
    expect(text()).toContain("已取消,沒有搬動任何檔案。");
    expect(readdirSync(join(root, "data")).sort()).toEqual(["miyoria.db"]);

    out = [];
    await archiveCommand(cfg, options, new Scripted([Text("archive")]));
    expect(readdirSync(join(root, "data")).sort()).toEqual(["archive"]);
    expect(text()).toContain("沒有刪除任何檔案");
    const next = lastLines(7);
    expect(next[0]).toBe("接下來");
    expect(next[1]).toBe(
      `  miyoria config set core.database_url sqlite:data/core.db -c ${slashed(cfg)}`,
    );
    expect(next[2]).toMatch(/^ {2}miyoria db import-links --from .*\.single\.db --dry-run -c /);
  });
});

describe("miyoria db doctor", () => {
  it("describes a V4 file with what the guard says and what an import would bring", async () => {
    const old = oldDatabase();
    await doctorCommand(join(root, "none.toml"), old);
    expect(text()).toContain("V4 的資料庫(schema_version 18)");
    expect(text()).toContain("Core 會拒絕開啟這個檔案");
    expect(text()).toContain("import-links 會帶過來的");
    expect(text()).toContain("人 5、帳號 6、事件(log_events) 1");
  });

  it("lists a V5 file's servers, their members and the primary", async () => {
    const path = join(root, "core.db");
    const store = await SqliteStore.open(path);
    store.places.seen("discord", "111", "魚缸");
    store.places.seen("discord", "222", "第二");
    await store.close();
    await doctorCommand(join(root, "none.toml"), path);
    expect(text()).toContain("伺服器");
    expect(text()).toMatch(/魚缸 {2}.*discord:111.* {2}成員 0 {2}主要的/);
    expect(text()).toMatch(/第二 {2}.*discord:222.* {2}成員 0\n/);
  });

  it("fails on a file that is not a database", async () => {
    const path = join(root, "notes.db");
    writeFileSync(path, "x".repeat(200));
    await expect(doctorCommand(join(root, "none.toml"), path)).rejects.toThrow("1 項檢查沒通過");
  });
});

describe("the db commands", () => {
  it("are under `miyoria db` with their options", () => {
    const parsed = parseArgs(["db", "import-links", "--from", "x.db", "--dry-run"]);
    expect(parsed.path.map((c) => c.name)).toEqual(["miyoria", "db", "import-links"]);
    expect(parsed.ctx.options).toMatchObject({ from: "x.db", "dry-run": true });
    const db = COMMANDS.subcommands?.find((c) => c.name === "db");
    expect(db?.subcommands?.map((c) => c.name)).toEqual(["import-links", "archive", "doctor"]);
    expect(helpText([COMMANDS, db as NonNullable<typeof db>])).toContain("import-links");
  });
});
