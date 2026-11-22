// Her notebook on the notes: the same paths, limits and refusals as the notebook pages.

import { MemorySettingsStore } from "@miyoria/store";
import type { NotebookWhere } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memoryConfig, type NotebookConfig } from "../../memory/src/config.js";
import { NotebookStore } from "../../memory/src/notebook.js";
import {
  NOTEBOOK_DELETE,
  NOTEBOOK_READ,
  NOTEBOOK_WRITE,
  NotebookDeleteTool,
  NotebookReadTool,
  NotebookWriteTool,
} from "../../memory/src/notebook-tools.js";
import { dm, FakeHandles, guild } from "../../memory/test/recent-helpers.js";
import { NotesNotebook } from "../src/notebook.js";
import { CHANNEL, DM_CHANNEL, fakeResolver, OWEN, OWEN_ACCOUNT, type Rig, rig } from "./helpers.js";

const inGuild: NotebookWhere = { context: CHANNEL, accounts: [OWEN_ACCOUNT] };
const inDm: NotebookWhere = { context: DM_CHANNEL, accounts: [OWEN_ACCOUNT] };

let open: Rig | null = null;
afterEach(() => {
  open?.store.close();
  open = null;
});

async function book(config: Partial<NotebookConfig> = {}) {
  open = await rig();
  const cfg = { ...memoryConfig().notebook, ...config };
  const handles = new FakeHandles().add("Owen", OWEN, OWEN_ACCOUNT);
  const notebook = new NotesNotebook({
    notes: open.notes,
    resolver: fakeResolver(),
    config: () => cfg,
    handles: () => handles,
    clock: open.clock,
  });
  return { notebook, notes: open.notes, clock: open.clock, cfg, handles };
}

describe("the notebook on the notes", () => {
  it("writes, appends, reads, replaces and deletes a page about a known person", async () => {
    const b = await book();
    expect(await b.notebook.write("人/Owen", "喜歡拉麵", "append", inGuild)).toEqual({
      path: "人/Owen",
      chars: 4,
      created: true,
      elsewhere: 0,
    });
    const more = await b.notebook.write(" 人 / Owen ", "下週三考試", "append", inGuild);
    expect(more).toEqual({ path: "人/Owen", chars: 9, created: false, elsewhere: 0 });
    const page = b.notebook.read("人/Owen", inGuild);
    expect(page?.body).toContain("喜歡拉麵");
    expect(page?.body).toContain("下週三考試");
    expect(page?.about).toBe(OWEN);
    expect(b.notes.document(`person:${OWEN}`)).not.toBeNull();

    await b.notebook.write("人/Owen", "整理過的版本", "replace", inGuild);
    const rewritten = b.notebook.read("人/Owen", inGuild)?.body ?? "";
    expect(rewritten).toContain("整理過的版本");
    expect(rewritten).not.toContain("喜歡拉麵");
    // Nothing is deleted: the old lines are still there, marked outdated.
    expect(b.notes.lines(`person:${OWEN}`, "owner", { outdated: true }).length).toBeGreaterThan(
      b.notes.lines(`person:${OWEN}`, "owner").length,
    );

    expect(await b.notebook.remove("人/Owen", inGuild)).toBe(true);
    expect(b.notebook.read("人/Owen", inGuild)).toBeNull();
    expect(await b.notebook.remove("人/Owen", inGuild)).toBe(false);
  });

  it("keeps a page where it was written", async () => {
    const b = await book();
    await b.notebook.write("人/Owen", "私訊裡說的事", "append", inDm);
    await b.notebook.write("主題/伺服器活動", "週五有團", "append", inGuild);
    await b.notebook.write("自己/想做的事", "學畫畫", "append", { context: null });
    expect(
      b.notebook
        .index(inDm)
        .map((e) => e.path)
        .sort(),
    ).toEqual(["人/Owen", "自己/想做的事"]);
    expect(
      b.notebook
        .index(inGuild)
        .map((e) => e.path)
        .sort(),
    ).toEqual(["主題/伺服器活動", "自己/想做的事"]);
    expect(b.notebook.read("人/Owen", inGuild)).toBeNull();
    expect(b.notebook.read("主題/伺服器活動", inDm)).toBeNull();
  });

  it("puts her own pages in the self document, one section each", async () => {
    const b = await book();
    await b.notebook.write("自己/想做的事", "學畫畫", "append", { context: null });
    await b.notebook.write("自己/學到的", "別在深夜吵人", "append", { context: null });
    expect(
      b.notes
        .lines("self", "owner")
        .map((l) => [l.section, l.text])
        .sort(),
    ).toEqual([
      ["learned", "別在深夜吵人"],
      ["wants", "學畫畫"],
    ]);
    await b.notebook.write("自己/想做的事", "學做菜", "replace", { context: null });
    expect(b.notebook.read("自己/想做的事", { context: null })?.body).toContain("學做菜");
    expect(b.notebook.read("自己/想做的事", { context: null })?.body).not.toContain("學畫畫");
    expect(b.notebook.read("自己/學到的", { context: null })?.body).toContain("別在深夜吵人");
  });

  it("keeps a page about someone she cannot place as a topic of its own", async () => {
    const b = await book();
    await b.notebook.write("人/路人甲", "常在半夜出現", "append", inGuild);
    expect(b.notes.document("topic:人/路人甲")).not.toBeNull();
    expect(b.notebook.read("人/路人甲", inGuild)?.body).toContain("常在半夜出現");
    expect(b.notebook.index(inGuild).map((e) => e.path)).toContain("人/路人甲");
  });

  it("refuses with the old texts past the limits", async () => {
    const b = await book({ page_chars: 20, max_pages: 2 });
    await expect(b.notebook.write("主題/a", "   ", "append", inGuild)).rejects.toThrow(
      "內容是空的",
    );
    await b.notebook.write("主題/a", "一二三四五六七八九十", "append", inGuild);
    await expect(
      b.notebook.write("主題/a", "一二三四五六七八九十一", "append", inGuild),
    ).rejects.toThrow("這頁會超過 20 字(現在 10 字),先整理或改寫成精簡版");
    await b.notebook.write(
      "主題/a",
      "一二三四五六七八九十一二三四五六七八九十",
      "replace",
      inGuild,
    );
    await b.notebook.write("主題/b", "短", "append", inGuild);
    await expect(b.notebook.write("主題/c", "短", "append", inGuild)).rejects.toThrow(
      "筆記本滿了(2 頁),先刪掉或合併幾頁",
    );
  });

  it("counts only the pages she wrote, and only when a write starts a page", async () => {
    const b = await book({ max_pages: 2 });
    // What the segment pass and the import made does not fill her notebook.
    for (const name of ["x", "y", "z"]) {
      b.notes.apply(
        `topic:${name}`,
        [
          {
            op: "add",
            section: "misc",
            text: "聽來的",
            provenance: "observed",
            scope: { type: "self" },
            confidence: 0.5,
          },
        ],
        { author: "segment", reason: "pass", lenient: false },
        name,
      );
    }
    await b.notebook.write("主題/a", "一", "append", inGuild);
    await b.notebook.write("主題/b", "二", "append", inGuild);
    await expect(b.notebook.write("主題/c", "三", "append", inGuild)).rejects.toThrow(
      "筆記本滿了(2 頁),先刪掉或合併幾頁",
    );
    // A full notebook can still be tidied: a page that exists is rewritten from anywhere,
    // also one this place has no lines in.
    await b.notebook.write("主題/a", "整理過", "replace", inGuild);
    expect(await b.notebook.write("主題/a", "私訊補的", "append", inDm)).toMatchObject({
      created: true,
      elsewhere: 1,
    });
    // Deleting a page makes room for a new one.
    expect(await b.notebook.remove("主題/b", inGuild)).toBe(true);
    await b.notebook.write("主題/c", "三", "append", inGuild);
    // A page the segment pass made takes her lines too, and keeps its own.
    expect(await b.notebook.write("主題/x", "補一句", "replace", inGuild)).toMatchObject({
      elsewhere: 1,
    });
  });

  it("says what a rewrite or a delete from this place could not reach", async () => {
    const b = await book();
    const write = new NotebookWriteTool(b.notebook);
    const del = new NotebookDeleteTool(b.notebook);
    await b.notebook.write("主題/a", "伺服器寫的", "append", inGuild);
    const ctx = (where: NotebookWhere) =>
      ({ context: where.context, account: OWEN_ACCOUNT }) as never;
    expect(
      await write.call(ctx(inDm), { path: "主題/a", content: "私訊版", mode: "replace" }),
    ).toContain("另外還有 1 行是在別的地方寫的");
    expect(await del.call(ctx(inDm), { path: "主題/a" })).toBe(
      "刪掉了「主題/a」在這裡寫的部分;另外還有 1 行是在別的地方寫的,這裡刪不到。",
    );
    expect(await del.call(ctx(inDm), { path: "主題/a" })).toBe(
      "「主題/a」的 1 行都是在別的地方寫的,這裡刪不到。",
    );
    expect(await del.call(ctx(inGuild), { path: "主題/a" })).toBe("刪掉了「主題/a」。");
  });

  it("allows only so many writes an hour", async () => {
    const b = await book({ writes_per_hour: 3 });
    for (const name of ["a", "b", "c"])
      await b.notebook.write(`主題/${name}`, "好", "append", inGuild);
    await expect(b.notebook.write("主題/a", "好", "append", inGuild)).rejects.toThrow(
      "這一小時寫太多次了(上限 3 次),晚點再寫",
    );
    b.clock.tick(3_600_001);
    await b.notebook.write("主題/a", "好", "append", inGuild);
  });

  it("refuses a place identity does not know", async () => {
    const b = await book();
    await expect(
      b.notebook.write("主題/a", "好", "append", { context: guild("x", "g-unknown") }),
    ).rejects.toThrow("這裡的人或地方我還對不上,晚點再寫");
    await expect(
      b.notebook.write("主題/a", "好", "append", { context: dm("d9"), accounts: [] }),
    ).rejects.toThrow("這裡的人或地方我還對不上,晚點再寫");
  });

  it("is told when a page has too many lines", async () => {
    const b = await book({ page_chars: 100_000 });
    const rows = Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join("\n");
    await expect(b.notebook.write("主題/長", rows, "append", inGuild)).rejects.toThrow(
      "這頁的行數滿了,先用 mode=replace 整理成精簡版",
    );
    expect(b.notebook.read("主題/長", inGuild)).toBeNull();
  });

  it("forgets what the notes hold about a person", async () => {
    const b = await book();
    await b.notebook.write("人/Owen", "喜歡拉麵", "append", inGuild);
    expect(await b.notebook.forgetPerson(OWEN)).toBeGreaterThan(0);
    expect(b.notebook.read("人/Owen", inGuild)?.body ?? "").not.toContain("喜歡拉麵");
  });

  it("lists the same entries as the pages do", async () => {
    const b = await book();
    const pages = new NotebookStore({
      settings: new MemorySettingsStore(),
      profile: "p" as never,
      config: () => b.cfg,
      handles: () => b.handles,
      clock: b.clock,
    });
    for (const target of [b.notebook, pages]) {
      await target.write("人/Owen", "喜歡拉麵", "append", inGuild);
      await target.write("主題/活動", "週五有團", "append", inGuild);
    }
    const shape = (entries: ReturnType<typeof b.notebook.index>) =>
      entries
        .map((e) => ({ path: e.path, chars: e.chars, about: e.about, keys: Object.keys(e).sort() }))
        .sort((x, y) => x.path.localeCompare(y.path));
    expect(shape(b.notebook.index(inGuild))).toEqual(shape(pages.index(inGuild)));
  });

  it("runs under the three tools with the same specs", async () => {
    const b = await book();
    const pages = new NotebookStore({
      settings: new MemorySettingsStore(),
      profile: "p" as never,
      config: () => b.cfg,
      clock: b.clock,
    });
    const make = (s: typeof pages | NotesNotebook) =>
      [
        new NotebookReadTool(s, () => b.cfg),
        new NotebookWriteTool(s),
        new NotebookDeleteTool(s),
      ].map((t) => t.spec);
    expect(make(b.notebook)).toEqual(make(pages));
    expect(make(b.notebook).map((s) => s.name)).toEqual([
      NOTEBOOK_READ,
      NOTEBOOK_WRITE,
      NOTEBOOK_DELETE,
    ]);
  });
});
