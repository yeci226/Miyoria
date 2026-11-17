// `/api/notes/*`, and the old knowledge and notebook routes over the same documents.

import type {
  DataInventoryView,
  KnowledgeView,
  NotebookIndex,
  NoteDocumentView,
  NoteHistory,
  NoteRevertResult,
  NotesList,
} from "@miyoria/contracts/api";
import { NotebookConfigSchema } from "@miyoria/memory/memory";
import {
  NotesKnowledge,
  NotesNotebook,
  type NotesStore,
  notesTables,
  topicSubject,
} from "@miyoria/memory/notes";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { AuditLogKey, ProfileDataStoreKey, SqliteStore, StoreKey } from "@miyoria/store";
import { KnowledgeKey, NotebookKey, type PersonId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const sups: Supervisor[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function harness() {
  const store = await SqliteStore.open(":memory:", { plugins: [notesTables] });
  stores.push(store);
  const notes: NotesStore = store.plugin(notesTables);
  const sup = new Supervisor();
  sups.push(sup);
  const s = sup.services;
  s.provide("kernel", SupervisorKey, sup);
  s.provide("kernel", ActiveProfileKey, "p");
  s.provide("kernel", StoreKey, store);
  s.provide("kernel", ProfileDataStoreKey, store.profileData);
  s.provide("kernel", AuditLogKey, store.audit);
  const knowledge = new NotesKnowledge({ notes, resolver: notes.resolver() });
  s.provide("kernel", KnowledgeKey, knowledge.base());
  s.provide(
    "kernel",
    NotebookKey,
    new NotesNotebook({
      notes,
      resolver: notes.resolver(),
      config: () => NotebookConfigSchema.parse({}),
    }),
  );
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const call = (method: string, path: string, json?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(json !== undefined && { json }) });
  return { store, notes, base, call, knowledge };
}

const SELF = { type: "self" } as const;

/** A topic document with two lines, one of them outdated, and her self document rewritten once. */
async function filled(h: Awaited<ReturnType<typeof harness>>) {
  const subject = topicSubject("拉麵");
  const first = h.notes.add(
    subject,
    {
      section: "summary",
      text: "週五吃",
      provenance: "told_by_other",
      scope: SELF,
      told_by: "01HOWEN0000000000000000000" as PersonId,
      evidence: [
        { quote: "我們週五去吃拉麵", person_id: "01HOWEN0000000000000000000" as PersonId },
      ],
    },
    { author: "tool" },
    "拉麵",
  );
  h.notes.outdate(subject, first.id, "改了", { author: "tool" });
  h.notes.add(
    subject,
    { section: "summary", text: "週六吃", provenance: "observed", scope: SELF },
    { author: "tool" },
  );
  h.notes.add(
    "self",
    { section: "thoughts", text: "我想少插話", provenance: "concluded", scope: SELF },
    { author: "reflect" },
  );
  return { subject, first };
}

describe("notes routes", () => {
  it("need the token", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/notes/documents")).status).toBe(401);
    expect(
      (await raw(h.base, "POST", "/api/notes/documents/x/revert", { json: { version: 0 } })).status,
    ).toBe(401);
  });

  it("list documents with counts by kind, and by one kind", async () => {
    const h = await harness();
    const empty = (await h.call("GET", "/api/notes/documents")).body as NotesList;
    expect(empty.documents.every((d) => d.kind === "self")).toBe(true);
    await filled(h);
    const all = (await h.call("GET", "/api/notes/documents")).body as NotesList;
    expect(all.counts.find((c) => c.kind === "topic")).toEqual({
      kind: "topic",
      documents: 1,
      lines: 1,
    });
    expect(all.counts.find((c) => c.kind === "self")?.documents).toBe(1);
    const topics = (await h.call("GET", "/api/notes/documents?kind=topic")).body as NotesList;
    expect(topics.documents).toHaveLength(1);
    expect(topics.documents[0]).toMatchObject({
      kind: "topic",
      label: "拉麵",
      lines: 1,
      version: 3,
    });
    expect(topics.counts).toEqual(all.counts);
    expect((await h.call("GET", "/api/notes/documents?kind=dog")).status).toBe(400);
  });

  it("show one document by section, with the outdated lines behind a flag", async () => {
    const h = await harness();
    await filled(h);
    const id = ((await h.call("GET", "/api/notes/documents?kind=topic")).body as NotesList)
      .documents[0]?.id;
    const shown = (await h.call("GET", `/api/notes/documents/${id}`)).body as NoteDocumentView;
    expect(shown.outdated).toBe(1);
    expect(shown.sections.map((s) => [s.key, s.label, s.lines.map((l) => l.text)])).toEqual([
      ["summary", "重點", ["週六吃"]],
    ]);
    const line = shown.sections[0]?.lines[0];
    expect(line).toMatchObject({
      provenance: "observed",
      author: "tool",
      scope: { type: "self", label: "她自己" },
      outdated_at: null,
      evidence: [],
    });
    const withOld = (await h.call("GET", `/api/notes/documents/${id}?outdated=true`))
      .body as NoteDocumentView;
    const old = withOld.sections[0]?.lines.find((l) => l.outdated_at !== null);
    expect(old).toMatchObject({
      text: "週五吃",
      provenance: "told_by_other",
      outdated_reason: "改了",
      evidence: [{ quote: "我們週五去吃拉麵", redacted: false }],
    });
    expect((await h.call("GET", "/api/notes/documents/nothing")).status).toBe(404);
    expect((await h.call("GET", `/api/notes/documents/${id}?outdated=maybe`)).status).toBe(400);
  });

  it("give a document's history by version", async () => {
    const h = await harness();
    await filled(h);
    const id = ((await h.call("GET", "/api/notes/documents?kind=topic")).body as NotesList)
      .documents[0]?.id;
    const history = (await h.call("GET", `/api/notes/documents/${id}/history`)).body as NoteHistory;
    expect(history.versions.map((v) => [v.version, v.author, v.changes.map((c) => c.op)])).toEqual([
      [1, "tool", ["add"]],
      [2, "tool", ["outdate"]],
      [3, "tool", ["add"]],
    ]);
    expect(history.versions[0]?.changes[0]).toMatchObject({
      section_label: "重點",
      text: "週五吃",
    });
    expect((await h.call("GET", "/api/notes/documents/nothing/history")).status).toBe(404);
  });

  it("revert a document to a version: a new version and an audit record", async () => {
    const h = await harness();
    const { subject } = await filled(h);
    const doc = h.notes.document(subject);
    const id = doc?.id ?? "";
    const done = await h.call("POST", `/api/notes/documents/${id}/revert`, { version: 1 });
    expect(done.status).toBe(200);
    const result = done.body as NoteRevertResult;
    expect(result).toMatchObject({ version: 4, restored: 1, outdated: 1, gone: 0 });
    expect(result.document).toMatchObject({ version: 4, lines: 1 });
    expect(h.notes.lines(subject, "owner").map((l) => l.text)).toEqual(["週五吃"]);
    const history = (await h.call("GET", `/api/notes/documents/${id}/history`)).body as NoteHistory;
    expect(history.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(history.versions[3]).toMatchObject({ author: "panel" });
    const audit = await h.store.audit.recent(10, "api");
    expect(audit.find((e) => e.action === "notes.revert")).toMatchObject({
      target: subject,
      ok: true,
      detail: { version: 1, made: 4, restored: 1, outdated: 1 },
    });
  });

  it("revert herself too, and refuse what is not there", async () => {
    const h = await harness();
    await filled(h);
    const self = h.notes.document("self");
    const reverted = await h.call("POST", `/api/notes/documents/${self?.id}/revert`, {
      version: 0,
    });
    expect((reverted.body as NoteRevertResult).outdated).toBeGreaterThan(0);
    expect(
      (await h.call("POST", `/api/notes/documents/${self?.id}/revert`, { version: 99 })).status,
    ).toBe(400);
    expect(
      (await h.call("POST", "/api/notes/documents/nothing/revert", { version: 0 })).status,
    ).toBe(404);
    expect(
      (await h.call("POST", `/api/notes/documents/${self?.id}/revert`, { version: -1 })).status,
    ).toBe(422);
    const audit = await h.store.audit.recent(10, "api");
    expect(audit.some((e) => e.action === "notes.revert" && !e.ok)).toBe(true);
  });
});

describe("the old routes over the notes", () => {
  it("serve what her knowledge tool wrote, in the shape they had", async () => {
    const h = await harness();
    await h.knowledge.base().apply(
      {
        type: "create",
        subject: { type: "topic", name: "大家的生日" },
        kind: "清單",
        title: "生日",
        content: { 重點: "三月有兩個" },
        why: "",
      },
      { kind: "self", account: null, person: null, name: null, context: null },
    );
    const view = (await h.call("GET", "/api/knowledge")).body as KnowledgeView;
    const doc = view.documents.find((d) => d.subject.type === "topic");
    expect(doc).toMatchObject({
      kind: "主題",
      content: { 重點: ["三月有兩個"] },
      subject_label: "大家的生日",
      version: 1,
    });
    expect(doc?.short_id).toMatch(/^#[0-9a-z]{6}$/);
    expect(doc?.history).toHaveLength(1);
  });

  it("serve her notebook pages from the notes", async () => {
    const h = await harness();
    await h.notes.add(
      topicSubject("拉麵"),
      { section: "summary", text: "週五吃", provenance: "observed", scope: SELF },
      { author: "tool" },
      "拉麵",
    );
    const index = (await h.call("GET", "/api/notebook")).body as NotebookIndex;
    expect(index.pages.map((p) => p.path)).toContain("主題/拉麵");
    const page = await h.call("GET", `/api/notebook/page?path=${encodeURIComponent("主題/拉麵")}`);
    expect(page.status).toBe(200);
    expect((page.body as { body: string }).body).toContain("週五吃");
    expect(
      (await h.call("GET", `/api/notebook/page?path=${encodeURIComponent("主題/沒有")}`)).status,
    ).toBe(404);
  });
});

describe("her documents among the data", () => {
  it("are counted in her knowledge, and a forgotten person takes theirs along", async () => {
    const h = await harness();
    const owen = await h.store.people.upsertAccount({ platform: "discord", id: "2" }, "Owen");
    await filled(h);
    h.notes.add(
      `person:${owen}`,
      {
        section: "likes",
        text: "喜歡拉麵",
        provenance: "told_by_subject",
        scope: SELF,
        told_by: owen,
      },
      { author: "tool" },
    );
    const count = async () =>
      ((await h.call("GET", "/api/data")).body as DataInventoryView).categories.find(
        (c) => c.id === "knowledge",
      )?.count ?? 0;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(4);
    h.store.personData.forget(owen, { reason: "forget me", source: "test" });
    expect(h.notes.document(`person:${owen}`)).toBeNull();
    expect(await count()).toBeLessThan(before);
  });
});
