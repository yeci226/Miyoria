// Document changes she proposes in a structured reply (folds, reflections): the zod schema of
// a draft, the prompt text describing them, and turning drafts (with the snapshot's short refs)
// into `KnowledgeChange`s applied one by one, each all or nothing.

import {
  type AccountRef,
  type ContextKey,
  hasEphemeralHandle,
  type JsonObject,
  type JsonValue,
  type KnowledgeBase,
  type KnowledgeChange,
  type KnowledgeSubject,
  type KnowledgeWriter,
  type PatchOp,
  type PersonId,
  type PlatformId,
} from "@miyoria/types";
import { z } from "zod";

const text = (max: number) => z.string().max(max);

export const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: z.json() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: z.json() }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("move"), from: z.string(), path: z.string() }),
]);

const said = z.string().max(40).nullable().default(null);
const why = text(300).default("");

export const DraftSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    subject: text(60),
    kind: text(40).min(1),
    title: text(80).min(1),
    content: z.record(z.string(), z.json()).default({}),
    why,
    said_by: said,
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("patch"),
    doc: text(40),
    ops: z.array(OpSchema).min(1).max(30),
    why,
    said_by: said,
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal("retitle"),
    doc: text(40),
    kind: text(40).nullable().default(null),
    title: text(80).nullable().default(null),
    why,
    said_by: said,
  }),
  z.object({ type: z.literal("delete"), doc: text(40), why, said_by: said }),
  z.object({
    type: z.literal("merge"),
    doc: text(40),
    into: text(40),
    path: z.string().default(""),
    why,
    said_by: said,
  }),
]);
export type Draft = z.output<typeof DraftSchema>;

/** The prompt's description of document changes (her choice of shape; examples are optional). */
export const DRAFT_FORMAT = `"documents" 是你自己整理的資料庫的修改(可省略或給空陣列)。資料怎麼分類、取什麼名字、用什麼結構都由你決定,也可以之後改名、合併或拆開:
- 新文件:{"type": "create", "subject": "人的名字(例如 Owen)/ server / self / topic:你取的主題名", "kind": "你定的種類", "title": "標題", "content": {任意 JSON}, "why": "理由", "said_by": "他的名字或 null"}
- 修改:{"type": "patch", "doc": "#文件代號", "ops": [{"op": "add / replace / remove / move", "path": "/欄位/子欄位", "value": 任意 JSON, "from": "/move 的來源"}], "why": "理由", "said_by": "他的名字或 null"}
- 改名 / 刪除 / 合併:{"type": "retitle", "doc": "#代號", "kind": "…", "title": "…"}、{"type": "delete", "doc": "#代號"}、{"type": "merge", "doc": "#代號", "into": "#代號", "path": "/放到哪個欄位"}
- path 用 JSON Pointer(/a/b,陣列用 /清單/0,加到最後用 /清單/-)。值可以是一段文字(可以用 Markdown)、數字、清單或物件。
- 提到人一律用名字(資料裡看到的名字,例如 Owen、Owen#2),不要用 u1、p1 這類代號;文件內容裡也一樣,代號每次都會變。
- said_by:這件事是誰說的就填他的名字;是你自己的判斷就填 null。別人說的關於別人的事,系統會標成「X 說」而且信心較低;別人寫的欄位只有他自己或你能改。
- 以下只是可能的樣子,不是規定:人物卡 {"喜歡": [...], "最近在忙": "…", "怎麼跟他相處": "…", "界線": [...]};伺服器 {"內梗": [...], "常聊的話題": [...], "規矩": [...]};主題 {"大家的生日": {"Owen": "3/14"}}。`;

/** Who the short refs in a prompt stand for. */
export interface RefTable {
  people: ReadonlyMap<string, { person: PersonId | null; account: AccountRef; name: string }>;
  guild: { platform: PlatformId; guild: string } | null;
}

/** A subject ref (a person's handle, `server`, `self`, `topic:名稱`) of the table. */
export function resolveSubject(ref: string, table: RefTable): KnowledgeSubject | null {
  const r = ref.trim();
  if (r === "self" || r === "我" || r === "自己") return { type: "self" };
  if (r === "server" || r === "伺服器") {
    return table.guild
      ? { type: "guild", platform: table.guild.platform, guild: table.guild.guild }
      : null;
  }
  if (r.startsWith("topic:")) {
    const name = r.slice("topic:".length).trim();
    return name === "" ? null : { type: "topic", name };
  }
  const who = table.people.get(r) ?? [...table.people.values()].find((p) => p.name === r);
  const person = who?.person ?? null;
  return person === null ? null : { type: "person", person };
}

function writerOf(
  draft: Draft,
  table: RefTable,
  fallback: KnowledgeWriter,
  context: ContextKey | null,
): KnowledgeWriter {
  const ref = draft.said_by?.trim() ?? "";
  if (ref === "" || ref === "null" || ref === "me" || ref === "self") return fallback;
  const who =
    table.people.get(ref) ?? [...table.people.values()].find((p) => p.name === ref) ?? null;
  // Attributed to someone not in the snapshot: hers, but as an inference (never privileged).
  if (!who) return { ...fallback, kind: fallback.kind === "panel" ? "panel" : "inferred" };
  return { kind: "said", account: who.account, person: who.person, name: who.name, context };
}

/** The change a draft stands for, or a reason it cannot be applied. */
export function draftChange(draft: Draft, table: RefTable): KnowledgeChange | string {
  switch (draft.type) {
    case "create": {
      const subject = resolveSubject(draft.subject, table);
      if (!subject) return `unknown subject \`${draft.subject}\``;
      return {
        type: "create",
        subject,
        kind: draft.kind,
        title: draft.title,
        content: draft.content as JsonObject,
        why: draft.why,
        ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
      };
    }
    case "patch":
      return {
        type: "patch",
        doc: draft.doc,
        ops: draft.ops as PatchOp[],
        why: draft.why,
        ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
      };
    case "retitle":
      return {
        type: "retitle",
        doc: draft.doc,
        kind: draft.kind,
        title: draft.title,
        why: draft.why,
      };
    case "delete":
      return { type: "delete", doc: draft.doc, why: draft.why };
    case "merge":
      return { type: "merge", doc: draft.doc, into: draft.into, path: draft.path, why: draft.why };
  }
}

/** Applies drafts one by one; returns what happened to each, in words. */
export async function applyDrafts(
  kb: KnowledgeBase,
  drafts: readonly Draft[],
  table: RefTable,
  fallback: KnowledgeWriter,
  context: ContextKey | null,
): Promise<{ applied: string[]; refused: string[] }> {
  const applied: string[] = [];
  const refused: string[] = [];
  for (const draft of drafts) {
    // Documents are kept for good: no per-call codes in them (and `u1` is no longer a ref).
    if (hasEphemeralHandle(draft as unknown as JsonValue)) {
      refused.push("contains a per-call code (u1, p1 ...); write the person's name instead");
      continue;
    }
    const change = draftChange(draft, table);
    if (typeof change === "string") {
      refused.push(change);
      continue;
    }
    const result = await kb.apply(change, writerOf(draft, table, fallback, context));
    if (result.ok) {
      const doc = result.doc;
      applied.push(
        doc
          ? `${doc.kind}「${doc.title}」`
          : `${draft.type} ${"doc" in draft ? draft.doc : ""}`.trim(),
      );
    } else refused.push(result.error);
  }
  return { applied, refused };
}
