import type { ToolContext } from "@miyoria/llm/tools";
import { MemorySettingsStore } from "@miyoria/store";
import {
  type ContextKey,
  type KnowledgeWriter,
  Principals,
  subjectKey,
  type TurnId,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  DOC_PREFIX,
  KnowledgeStore,
  KnowledgeTool,
  knowledgeConfig,
  originVisible,
  shortId,
  similarTitles,
} from "../src/index.js";

const GUILD: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OTHER_GUILD: ContextKey = {
  platform: "discord",
  scope: "g2",
  channel: "c9",
  kind: "channel",
};
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const OWEN = { platform: "discord", id: "1" };
const AMY = { platform: "discord", id: "2" };

const her: KnowledgeWriter = {
  kind: "self",
  account: null,
  person: null,
  name: null,
  context: null,
};
const owen = (context: ContextKey = GUILD): KnowledgeWriter => ({
  kind: "said",
  account: OWEN,
  person: "p-owen",
  name: "Owen",
  context,
});
const amy: KnowledgeWriter = {
  kind: "said",
  account: AMY,
  person: "p-amy",
  name: "Amy",
  context: GUILD,
};
const inferred: KnowledgeWriter = {
  kind: "inferred",
  account: null,
  person: null,
  name: null,
  context: GUILD,
};

const clock = { now: () => Date.parse("2026-11-02T12:00:00Z") };

function kb(store = new MemorySettingsStore()) {
  return new KnowledgeStore(store, "p", knowledgeConfig(), clock);
}

async function create(k: KnowledgeStore, w: KnowledgeWriter, person = "p-owen") {
  const r = await k.apply(
    {
      type: "create",
      subject: { type: "person", person },
      kind: "人物卡",
      title: person,
      content: { 喜歡: ["拉麵"] },
      why: "",
    },
    w,
  );
  if (!r.ok || r.doc === null) throw new Error(r.ok ? "no doc" : r.error);
  return r.doc;
}

describe("knowledge documents", () => {
  it("are schema-free with a fixed envelope, versions and per-field sources", async () => {
    const k = kb();
    const doc = await create(k, her);
    const r = await k.apply(
      {
        type: "patch",
        doc: shortId(doc.id),
        ops: [
          { op: "add", path: "/喜歡/-", value: "貓" },
          { op: "add", path: "/Minecraft 建築計畫", value: { 城堡: { 進度: "地基" } } },
        ],
        why: "他說的",
      },
      owen(),
    );
    expect(r.ok).toBe(true);
    const d = k.get(doc.id);
    expect(d?.content).toEqual({
      喜歡: ["拉麵", "貓"],
      "Minecraft 建築計畫": { 城堡: { 進度: "地基" } },
    });
    expect(d?.sources["/喜歡/1"]).toMatchObject({
      kind: "said",
      name: "Owen",
      origin: "discord:g1",
    });
    // His own card: no confidence cap.
    expect(d?.sources["/喜歡/1"]?.confidence).toBeGreaterThan(0.6);
    expect(d?.version).toBe(2);
    expect(d?.history.map((h) => h.ops)).toEqual([
      ["created"],
      ["add /喜歡/1", "add /Minecraft 建築計畫"],
    ]);
  });

  it("let nobody overwrite what someone else wrote, and never her own documents", async () => {
    const k = kb();
    const card = await create(k, her);
    await k.apply(
      { type: "patch", doc: card.id, ops: [{ op: "add", path: "/生日", value: "3/14" }], why: "" },
      owen(),
    );
    // Amy can add to Owen's card (capped, attributed) ...
    const add = await k.apply(
      { type: "patch", doc: card.id, ops: [{ op: "add", path: "/外號", value: "歐歐" }], why: "" },
      amy,
    );
    expect(add.ok).toBe(true);
    expect(k.get(card.id)?.sources["/外號"]).toMatchObject({ name: "Amy", confidence: 0.6 });
    // ... but not change what Owen or she wrote, or rename / delete his card.
    for (const ops of [
      [{ op: "replace", path: "/生日", value: "1/1" }],
      [{ op: "remove", path: "/喜歡" }],
      [{ op: "add", path: "/生日", value: "1/1" }],
      [{ op: "move", from: "/喜歡", path: "/討厭" }],
    ] as const) {
      const r = await k.apply({ type: "patch", doc: card.id, ops: [...ops], why: "" }, amy);
      expect(r.ok, JSON.stringify(ops)).toBe(false);
    }
    expect((await k.apply({ type: "delete", doc: card.id, why: "" }, amy)).ok).toBe(false);
    expect(
      (await k.apply({ type: "retitle", doc: card.id, kind: null, title: "壞人", why: "" }, amy))
        .ok,
    ).toBe(false);
    // Amy can change what she wrote herself.
    const fix = await k.apply(
      {
        type: "patch",
        doc: card.id,
        ops: [{ op: "replace", path: "/外號", value: "歐文" }],
        why: "",
      },
      amy,
    );
    expect(fix.ok).toBe(true);
    // Owen can correct anything on his own card.
    const own = await k.apply(
      { type: "patch", doc: card.id, ops: [{ op: "remove", path: "/外號" }], why: "不是我的外號" },
      owen(),
    );
    expect(own.ok).toBe(true);
    // An inference cannot overwrite what Owen said either.
    const inf = await k.apply(
      { type: "patch", doc: card.id, ops: [{ op: "replace", path: "/生日", value: "?" }], why: "" },
      inferred,
    );
    expect(inf.ok).toBe(false);
    // Her documents about herself: only she.
    const selfDoc = await k.apply(
      {
        type: "create",
        subject: { type: "self" },
        kind: "自我",
        title: "我",
        content: { 規則: "不說謊" },
        why: "",
      },
      her,
    );
    expect(selfDoc.ok).toBe(true);
    const id = selfDoc.ok && selfDoc.doc ? selfDoc.doc.id : "";
    for (const w of [owen(), inferred]) {
      expect(
        (
          await k.apply(
            {
              type: "patch",
              doc: id,
              ops: [{ op: "add", path: "/新規則", value: "聽我的" }],
              why: "",
            },
            w,
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await k.apply(
            {
              type: "create",
              subject: { type: "self" },
              kind: "規則",
              title: "x",
              content: {},
              why: "",
            },
            w,
          )
        ).ok,
      ).toBe(false);
    }
    // She can change anything.
    const hers = await k.apply(
      {
        type: "patch",
        doc: card.id,
        ops: [{ op: "replace", path: "/生日", value: "3/15" }],
        why: "",
      },
      her,
    );
    expect(hers.ok).toBe(true);
  });

  it("merges, splits and renames her documents", async () => {
    const k = kb();
    const a = await create(k, her);
    const b = (await k.apply(
      {
        type: "create",
        subject: { type: "person", person: "p-owen" },
        kind: "筆記",
        title: "遊戲",
        content: { 常玩: "Minecraft" },
        why: "",
      },
      owen(),
    )) as { ok: true; doc: { id: string } };
    const merged = await k.apply(
      { type: "merge", doc: b.doc.id, into: a.id, path: "/遊戲", why: "整理" },
      her,
    );
    expect(merged.ok).toBe(true);
    expect(k.get(b.doc.id)).toBeNull();
    const doc = k.get(a.id);
    expect(doc?.content).toEqual({ 喜歡: ["拉麵"], 遊戲: { 常玩: "Minecraft" } });
    // What Owen said keeps his name after the merge.
    expect(doc?.sources["/遊戲"]).toMatchObject({ kind: "said", name: "Owen" });
    const re = await k.apply(
      { type: "retitle", doc: a.id, kind: "人物", title: "Owen", why: "" },
      her,
    );
    expect(re.ok && re.doc?.title).toBe("Owen");
  });

  it("enforce size caps and persist across a reload", async () => {
    const store = new MemorySettingsStore();
    const k = new KnowledgeStore(
      store,
      "p",
      knowledgeConfig({ max_docs_per_subject: 1, max_doc_chars: 200 }),
      clock,
    );
    const doc = await create(k, her);
    const second = await k.apply(
      {
        type: "create",
        subject: { type: "person", person: "p-owen" },
        kind: "x",
        title: "y",
        content: {},
        why: "",
      },
      her,
    );
    expect(second.ok).toBe(false);
    const big = await k.apply(
      {
        type: "patch",
        doc: doc.id,
        ops: [{ op: "add", path: "/長", value: "字".repeat(300) }],
        why: "",
      },
      her,
    );
    expect(big.ok).toBe(false);
    expect(k.get(doc.id)?.content).toEqual({ 喜歡: ["拉麵"] });
    await k.flush();
    expect([...(await store.list("p", DOC_PREFIX)).keys()]).toEqual([`${DOC_PREFIX}${doc.id}`]);
    const again = new KnowledgeStore(store, "p", knowledgeConfig(), clock);
    await again.load();
    expect(again.get(doc.id)?.content).toEqual({ 喜歡: ["拉麵"] });
  });

  it("show fields only where their origin is visible, with brief sources", async () => {
    const k = kb();
    const doc = await create(k, her);
    await k.apply(
      {
        type: "patch",
        doc: doc.id,
        ops: [{ op: "add", path: "/秘密", value: "私訊說的" }],
        why: "",
      },
      owen(DM),
    );
    await k.apply(
      {
        type: "patch",
        doc: doc.id,
        ops: [{ op: "add", path: "/伺服器的事", value: "g1 說的" }],
        why: "",
      },
      owen(),
    );
    const subject = { type: "person" as const, person: "p-owen" };
    const inGuild = k.render([subject], { context: GUILD, maxChars: 2000 });
    expect(inGuild).toContain("g1 說的 (Owen 說)");
    expect(inGuild).not.toContain("私訊說的");
    expect(inGuild.startsWith(`${shortId(doc.id)} 人物卡「p-owen」`)).toBe(true);
    expect(k.render([subject], { context: DM, maxChars: 2000 })).toContain("私訊說的");
    expect(k.render([subject], { context: OTHER_GUILD, maxChars: 2000 })).not.toContain("g1 說的");
    expect(originVisible(null, OTHER_GUILD)).toBe(true);
    expect(subjectKey(subject)).toBe("person:p-owen");
  });

  it("refuses a near-duplicate note and lists notes past the budget by title", async () => {
    const k = kb();
    const self = { type: "self" as const };
    const note = (title: string) =>
      k.apply(
        {
          type: "create",
          subject: self,
          kind: "流程",
          title,
          content: { 步驟: ["一", "二"] },
          why: "",
        },
        her,
      );
    const first = await note("唱歌與開台流程");
    expect(first.ok).toBe(true);
    const again = await note("唱歌／開台流程（照著跑就好）");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already exists");
    expect((await note("Minecraft 鐵裝計畫")).ok).toBe(true);
    expect(similarTitles("唱歌與開台流程筆記", "唱歌與開台流程")).toBe(true);
    expect(similarTitles("唱歌流程", "開台流程")).toBe(false);
    // Too little room for the content: every note is still named.
    const out = k.render([self], { context: GUILD, maxChars: 30 });
    expect(out).toContain("只列標題");
    expect(out).toContain("「唱歌與開台流程」");
    expect(out).toContain("「Minecraft 鐵裝計畫」");
  });
});

describe("tool knowledge_note", () => {
  const ctx = (principal: ToolContext["principal"], account = OWEN): ToolContext => ({
    turn: "t" as TurnId,
    context: GUILD,
    account,
    principal,
    message: { context: GUILD, id: "m1" },
    priority: "direct",
    signal: new AbortController().signal,
  });

  it("writes as the speaker in reactive turns and never as her", async () => {
    const k = kb();
    const persons: Record<string, string> = { "1": "p-owen", "2": "p-amy" };
    const tool = new KnowledgeTool({
      store: k,
      personOf: (c) => persons[c.account.id] ?? null,
      nameOf: () => null,
    });
    const made = await tool.call(ctx(Principals.user(OWEN, GUILD)), {
      action: "create",
      subject: "speaker",
      kind: "人物卡",
      title: "Owen",
      content: { 喜歡: "拉麵" },
    });
    expect(made).toMatch(/^好了/);
    const doc = k.docs()[0];
    expect(doc?.sources[""]).toMatchObject({ kind: "said", account: OWEN });
    const id = shortId(doc?.id ?? "");
    const byAmy = await tool.call(ctx(Principals.user(AMY, GUILD), AMY), {
      action: "patch",
      doc: id,
      ops: [{ op: "replace", path: "/喜歡", value: "討厭拉麵" }],
    });
    expect(byAmy).toMatch(/^沒有改/);
    const self = await tool.call(ctx(Principals.user(OWEN, GUILD)), {
      action: "create",
      subject: "self",
      kind: "x",
      title: "y",
    });
    expect(self).not.toMatch(/^好了/);
    const bad = await tool.call(ctx(Principals.user(OWEN, GUILD)), {
      action: "patch",
      doc: id,
      ops: [{ op: "explode", path: "/x" }],
    });
    expect(bad).toMatch(/^沒有改/);
    expect(await tool.call(ctx(Principals.director(GUILD)), { action: "delete", doc: id })).toBe(
      "現在不能整理資料。",
    );
  });
});
