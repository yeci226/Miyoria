import type { SettingsStore } from "@miyoria/store";
import type { FieldSource, JsonValue, KnowledgeDoc, ProfileId, Timestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  importLegacy,
  type NotebookPageRecord,
  notebookPages,
  personSubject,
  placeSubject,
  SELF_SUBJECT,
  topicSubject,
} from "../src/index.js";
import { DM_ROOM, fakeResolver, OWEN, rig, SPACE } from "./helpers.js";

const AT = "2026-11-01T12:00:00.000Z" as Timestamp;

function page(
  fields: Partial<NotebookPageRecord> & Pick<NotebookPageRecord, "id" | "path" | "body">,
): NotebookPageRecord {
  return { origin: null, about: null, created_at: AT, updated_at: AT, ...fields };
}

const source = (fields: Partial<FieldSource>): FieldSource => ({
  kind: "inferred",
  account: null,
  name: null,
  origin: null,
  confidence: 0.7,
  at: AT,
  ...fields,
});

function knowledge(
  fields: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "id" | "subject" | "content">,
): KnowledgeDoc {
  return {
    kind: "檔案",
    title: "文件",
    sources: { "": source({}) },
    created_at: AT,
    updated_at: AT,
    version: 1,
    history: [],
    ...fields,
  } as KnowledgeDoc;
}

const pages: NotebookPageRecord[] = [
  page({
    id: "p-owen",
    path: "人/Owen",
    about: OWEN,
    origin: { type: "guild", platform: "discord", guild: "g1" },
    body: "## 喜好\n- 喜歡吃拉麵\n- 喜歡打 osu\n近況:在準備期末考\n他人很好",
  }),
  page({ id: "p-ghost", path: "人/路人", body: "不知道是誰" }),
  page({ id: "p-self", path: "自己/想做的事", body: "學會畫畫\n存錢買耳機" }),
  page({
    id: "p-topic",
    path: "主題/Minecraft/建築",
    origin: { type: "dm", platform: "discord", account: "u-owen" },
    body: "城堡用石磚",
  }),
  page({
    id: "p-far",
    path: "主題/別的伺服器",
    origin: { type: "guild", platform: "discord", guild: "g9" },
    body: "x",
  }),
];

const docs: KnowledgeDoc[] = [
  knowledge({
    id: "k-owen",
    subject: { type: "person", person: OWEN },
    title: "Owen 的檔案",
    content: { 稱呼: "阿文", 喜好: ["拉麵", "osu"], 生日: { 月: 3, 日: 14 } },
    sources: {
      "": source({
        kind: "said",
        account: { platform: "discord", id: "u-owen" },
        origin: "discord:g1",
        confidence: 0.8,
      }),
      "/生日": source({ kind: "inferred", origin: "dm:discord:dm:d1", confidence: 0.6 }),
    },
  }),
  knowledge({
    id: "k-guild",
    subject: { type: "guild", platform: "discord", guild: "g1" },
    title: "系上伺服器",
    content: { 規矩: "不能貼色圖" },
    sources: { "": source({ kind: "panel", origin: "discord:g1", confidence: 1 }) },
  }),
  knowledge({
    id: "k-far",
    subject: { type: "guild", platform: "discord", guild: "g9" },
    content: { 規矩: "x" },
  }),
  knowledge({
    id: "k-topic",
    subject: { type: "topic", name: "期末考" },
    content: { 日期: "一月第二週" },
  }),
];

describe("importLegacy", () => {
  it("writes the pages and documents as notes, and reports what it cannot map", async () => {
    const { notes } = await rig();
    const report = importLegacy(notes, { pages, knowledge: docs }, fakeResolver());
    const owen = notes.lines(personSubject(OWEN), "owner");
    expect(owen.map((l) => [l.section, l.text]).sort()).toEqual(
      [
        ["likes", "喜歡吃拉麵"],
        ["likes", "喜歡打 osu"],
        ["recent", "在準備期末考"],
        ["likes", "他人很好"],
        ["address", "阿文"],
        ["likes", "拉麵"],
        ["likes", "osu"],
        ["misc", "生日 / 月: 3"],
        ["misc", "生日 / 日: 14"],
      ].sort(),
    );
    const page = owen.find((l) => l.text === "喜歡吃拉麵");
    expect(page).toMatchObject({
      provenance: "observed",
      confidence: 0.6,
      author: "import",
      scope: { type: "space", space: SPACE },
    });
    expect(owen.find((l) => l.text === "阿文")).toMatchObject({
      provenance: "told_by_subject",
      told_by: OWEN,
      confidence: 0.8,
      scope: { type: "space", space: SPACE },
    });
    expect(owen.find((l) => l.text === "生日 / 月: 3")).toMatchObject({
      provenance: "concluded",
      scope: { type: "room", room: DM_ROOM },
    });
    expect(
      notes
        .lines(SELF_SUBJECT, "owner")
        .map((l) => [l.section, l.text])
        .sort(),
    ).toEqual(
      [
        ["wants", "學會畫畫"],
        ["wants", "存錢買耳機"],
      ].sort(),
    );
    expect(notes.lines(topicSubject("Minecraft/建築"), "owner")[0]).toMatchObject({
      text: "城堡用石磚",
      scope: { type: "dm", person: OWEN },
    });
    expect(notes.document(topicSubject("Minecraft/建築"))?.title).toBe("Minecraft/建築");
    expect(notes.lines(placeSubject(SPACE), "owner")[0]).toMatchObject({
      section: "rules",
      provenance: "observed",
    });
    expect(notes.lines(topicSubject("期末考"), "owner")[0]).toMatchObject({
      text: "日期: 一月第二週",
      scope: { type: "self" },
    });
    expect(report.unmapped.map((u) => u.source)).toEqual([
      "notebook:人/路人",
      "notebook:主題/別的伺服器",
      "knowledge:文件",
    ]);
    expect(report.added).toBe(14);
    expect(report.documents).toBe(5);
    expect(report.already).toBe(0);
  });

  it("adds nothing the second time", async () => {
    const { notes } = await rig();
    const first = importLegacy(notes, { pages, knowledge: docs }, fakeResolver());
    const counts = notes.counts();
    const second = importLegacy(notes, { pages, knowledge: docs }, fakeResolver());
    expect(second.added).toBe(0);
    expect(second.already).toBe(first.added);
    expect(notes.counts()).toEqual(counts);
    // A page that grew adds only its new line.
    const grown = pages.map((p) => (p.id === "p-self" ? { ...p, body: `${p.body}\n去海邊` } : p));
    expect(importLegacy(notes, { pages: grown, knowledge: docs }, fakeResolver()).added).toBe(1);
  });

  it("reports what the limits refuse instead of cutting it", async () => {
    const { notes } = await rig(undefined, { selfLines: 1 });
    const report = importLegacy(
      notes,
      { pages: [pages[2] as NotebookPageRecord], knowledge: [] },
      fakeResolver(),
    );
    expect(report.added).toBe(1);
    expect(report.unmapped).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("holds 1 lines") }),
    ]);
  });

  it("splits a line longer than a note line", async () => {
    const { notes } = await rig();
    const long = "很長的句子。".repeat(50);
    importLegacy(
      notes,
      { pages: [page({ id: "p-long", path: "主題/長", body: long })], knowledge: [] },
      fakeResolver(),
    );
    const lines = notes.lines(topicSubject("長"), "owner");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => [...l.text].length <= 200)).toBe(true);
  });
});

describe("notebookPages", () => {
  it("reads every stored page with where it was written", async () => {
    const rows = new Map<string, JsonValue>([
      ["notebook:page:a", JSON.parse(JSON.stringify(pages[0])) as JsonValue],
      ["notebook:page:b", { broken: true }],
    ]);
    const settings = {
      async list(_profile: ProfileId, prefix: string) {
        return new Map([...rows].filter(([k]) => k.startsWith(prefix)));
      },
    } as unknown as SettingsStore;
    const read = await notebookPages(settings, "deepseek-chan" as ProfileId);
    expect(read).toEqual([pages[0]]);
  });
});
