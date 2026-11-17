// `knowledge_note` and the knowledge section of the prompt, on the notes.

import type { ToolContext } from "@miyoria/llm/tools";
import type { ContextKey, KnowledgeBase } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeTool } from "../../learning/src/tool.js";
import { NotesKnowledge } from "../src/knowledge.js";
import {
  CHANNEL,
  DM_CHANNEL,
  fakeResolver,
  OWEN,
  OWEN_ACCOUNT,
  type Rig,
  rig,
  SPACE,
} from "./helpers.js";

let open: Rig | null = null;
afterEach(() => {
  open?.store.close();
  open = null;
});

async function setup() {
  open = await rig();
  const knowledge = new NotesKnowledge({ notes: open.notes, resolver: fakeResolver() });
  const base: KnowledgeBase = knowledge.base();
  const tool = new KnowledgeTool({
    store: base,
    personOf: () => OWEN,
    nameOf: () => "Owen",
  });
  const ctx = (context: ContextKey, kind: "user" | "self" = "user") =>
    ({
      turn: "t1",
      context,
      account: OWEN_ACCOUNT,
      principal: { kind, account: OWEN_ACCOUNT },
      message: { context, id: "m1" },
      priority: "normal",
      signal: new AbortController().signal,
    }) as unknown as ToolContext;
  return { knowledge, base, tool, ctx, notes: open.notes };
}

describe("knowledge_note on the notes", () => {
  it("creates a document about the speaker and says its short id", async () => {
    const k = await setup();
    const out = await k.tool.call(k.ctx(DM_CHANNEL), {
      action: "create",
      subject: "speaker",
      kind: "人物卡",
      title: "Owen",
      content: { 喜歡: "拉麵", 最近在忙: "考試" },
    });
    expect(out).toMatch(/^好了:#\S+ 人物卡「Owen」$/);
    const lines = k.notes.lines(`person:${OWEN}`, "owner");
    expect(lines.map((l) => l.text).sort()).toEqual(["最近在忙: 考試", "喜歡: 拉麵"].sort());
    expect(lines.every((l) => l.author === "tool" && l.provenance === "told_by_subject")).toBe(
      true,
    );
  });

  it("patches by label, outdating the old line, and refuses what is someone else's", async () => {
    const k = await setup();
    await k.tool.call(k.ctx(DM_CHANNEL), {
      action: "create",
      subject: "topic:拉麵",
      kind: "主題",
      title: "拉麵",
      content: { 店: "一蘭" },
    });
    const id = k.notes.document("topic:拉麵")?.id ?? "";
    const done = await k.tool.call(k.ctx(DM_CHANNEL), {
      action: "patch",
      doc: `#${id.slice(-6)}`,
      ops: [{ op: "replace", path: "/店", value: "一風堂" }],
    });
    expect(done).toContain("好了");
    expect(k.notes.lines("topic:拉麵", "owner").map((l) => l.text)).toEqual(["店: 一風堂"]);
    expect(k.notes.lines("topic:拉麵", "owner", { outdated: true })).toHaveLength(2);
  });

  it("keeps her self document for her own reflection", async () => {
    const k = await setup();
    const out = await k.tool.call(k.ctx(CHANNEL), {
      action: "create",
      subject: "topic:x",
      kind: "k",
      title: "x",
      content: { a: "b" },
    });
    expect(out).toContain("好了");
    const refused = await k.base.apply(
      {
        type: "create",
        subject: { type: "self" },
        kind: "自我",
        title: "我",
        content: { a: "b" },
        why: "",
      },
      { kind: "said", account: OWEN_ACCOUNT, person: OWEN, name: "Owen", context: CHANNEL },
    );
    expect(refused.ok).toBe(false);
  });

  it("shows a document only where its lines may be seen", async () => {
    const k = await setup();
    await k.tool.call(k.ctx(DM_CHANNEL), {
      action: "create",
      subject: "speaker",
      kind: "人物卡",
      title: "Owen",
      content: { 祕密: "私訊裡說的" },
    });
    const subjects = [{ type: "person" as const, person: OWEN }];
    const here = k.base.render(subjects, { context: DM_CHANNEL, maxChars: 800 });
    expect(here).toContain("私訊裡說的");
    expect(k.base.render(subjects, { context: CHANNEL, maxChars: 800 })).toBe("");
    expect(k.base.render(subjects, { context: null, maxChars: 800 })).toContain("私訊裡說的");
    expect(k.knowledge.viewerFor(CHANNEL).space).toBe(SPACE);
  });

  it("lists and reads what her tool wrote, from the notes only", async () => {
    const k = await setup();
    expect(k.base.docs()).toEqual([]);
    await k.tool.call(k.ctx(DM_CHANNEL), {
      action: "create",
      subject: "speaker",
      kind: "人物卡",
      title: "Owen",
      content: { 喜好: "拉麵", 最近在忙: "考試" },
    });
    await k.tool.call(k.ctx(CHANNEL), {
      action: "create",
      subject: "topic:拉麵",
      kind: "主題",
      title: "拉麵",
      content: { 重點: "週五吃" },
    });
    const all = k.base.docs();
    expect(all.map((d) => d.subject.type).sort()).toEqual(["person", "topic"]);
    const owen = k.base.docs({ type: "person", person: OWEN });
    expect(owen).toHaveLength(1);
    const doc = owen[0];
    expect(doc?.subject).toEqual({ type: "person", person: OWEN });
    expect(doc?.kind).toBe("人物");
    expect(doc?.content).toEqual({ 喜好: ["拉麵"], 其他: ["最近在忙: 考試"] });
    expect(doc?.sources["/喜好/0"]).toMatchObject({ kind: "said", confidence: expect.any(Number) });
    expect(doc?.history.map((h) => h.version)).toEqual([1]);
    expect(k.base.get(doc?.id ?? "")?.content).toEqual(doc?.content);
    expect(k.base.get("#nothing")).toBeNull();
    expect(k.base.docs({ type: "topic", name: "拉麵" })[0]?.content).toEqual({ 重點: ["週五吃"] });
  });

  it("stops listing a document once all its lines are outdated", async () => {
    const k = await setup();
    await k.tool.call(k.ctx(CHANNEL), {
      action: "create",
      subject: "topic:拉麵",
      kind: "主題",
      title: "拉麵",
      content: { 重點: "週五吃" },
    });
    const id = k.base.docs()[0]?.id ?? "";
    await k.base.apply(
      { type: "delete", doc: id, why: "" },
      { kind: "panel", account: null, person: null, name: null, context: null },
    );
    expect(k.base.docs()).toEqual([]);
    expect(k.base.get(id)).toBeNull();
  });
});
