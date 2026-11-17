// Tool `knowledge_note`: her documents from inside a turn. The provider's function calling
// keeps the arguments JSON; the writer is whoever the turn runs for, so the overwrite
// protection holds no matter what the model was talked into: in a reactive turn it is the
// speaker (`said`: they may add things and change what is theirs or about them), in a turn she
// started herself it is `inferred` (she concluded it from a conversation), never privileged.

import type { Tool, ToolContext, ToolMeta, ToolSpec } from "@miyoria/llm/tools";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type KnowledgeBase,
  type KnowledgeChange,
  type KnowledgeSubject,
  type KnowledgeWriter,
  type PersonId,
} from "@miyoria/types";
import { PatchError, parseOps } from "./json-doc.js";
import { shortId } from "./knowledge.js";

export const KNOWLEDGE_TOOL = "knowledge_note";

export interface ToolDeps {
  store: Pick<KnowledgeBase, "apply">;
  personOf: (ctx: ToolContext) => PersonId | null;
  nameOf: (ctx: ToolContext) => string | null;
}

function str(args: JsonObject, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export class KnowledgeTool implements Tool {
  readonly meta: ToolMeta = { effect: "act", speed: "instant", risk: "low", group: "memory" };
  readonly spec: ToolSpec = {
    name: KNOWLEDGE_TOOL,
    description:
      "整理你自己的資料庫(關於人、這個伺服器、你取名的主題)。結構由你決定:新增文件、用 JSON Patch 修改欄位、改名、刪除或合併。參考資料「你整理的資料」裡有文件代號(#xxxxxx)。別人告訴你的事會記成「他說的」;別人寫的欄位只有他自己能改,關於你自己的文件只能在你自己反思時改。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "retitle", "delete", "merge"] },
        subject: {
          type: "string",
          description: "create 用:speaker(正在跟你說話的人)、server(這個伺服器)或 topic:主題名",
        },
        kind: { type: "string", description: "文件種類,你自己取(例如 人物卡、內梗、建築計畫)" },
        title: { type: "string" },
        content: {
          type: "object",
          description: "create 用:文件內容(任意 JSON,文字可以用 Markdown)",
        },
        doc: { type: "string", description: "要改的文件代號,例如 #a1b2c3" },
        into: { type: "string", description: "merge:合併到哪份文件" },
        path: { type: "string", description: "merge:放在哪個欄位(JSON Pointer)" },
        ops: {
          type: "array",
          description: "patch 用:JSON Patch 操作",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove", "move"] },
              path: { type: "string", description: "JSON Pointer,例如 /喜歡/- 或 /最近在忙" },
              from: { type: "string" },
              value: {},
            },
            required: ["op", "path"],
          },
        },
        why: { type: "string" },
      },
      required: ["action"],
    },
  };

  constructor(private readonly deps: ToolDeps) {}

  #writer(ctx: ToolContext): KnowledgeWriter | null {
    const p = ctx.principal;
    if (p.kind === "user") {
      return {
        kind: "said",
        account: { ...ctx.account },
        person: this.deps.personOf(ctx),
        name: this.deps.nameOf(ctx),
        context: ctx.context,
      };
    }
    if (p.kind === "self") {
      return { kind: "inferred", account: null, person: null, name: null, context: ctx.context };
    }
    return null;
  }

  #subject(raw: string | null, ctx: ToolContext): KnowledgeSubject | string {
    const r = raw ?? "speaker";
    if (r === "speaker") {
      const person = this.deps.personOf(ctx);
      return person === null ? "不知道對方是誰" : { type: "person", person };
    }
    if (r === "server") {
      return ctx.context.scope !== null && ctx.context.kind !== "dm"
        ? { type: "guild", platform: ctx.context.platform, guild: ctx.context.scope }
        : "這裡不是伺服器";
    }
    if (r.startsWith("topic:") && r.length > 6) return { type: "topic", name: r.slice(6) };
    return "subject 只能是 speaker、server 或 topic:主題名";
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    if (!isJsonObject(args)) return "參數要是一個物件。";
    const writer = this.#writer(ctx);
    if (!writer) return "現在不能整理資料。";
    const why = str(args, "why") ?? "";
    let change: KnowledgeChange;
    try {
      switch (str(args, "action")) {
        case "create": {
          const subject = this.#subject(str(args, "subject"), ctx);
          if (typeof subject === "string") return subject;
          const content = isJsonObject(args.content) ? args.content : {};
          change = {
            type: "create",
            subject,
            kind: str(args, "kind") ?? "筆記",
            title: str(args, "title") ?? "未命名",
            content,
            why,
          };
          break;
        }
        case "patch":
          change = { type: "patch", doc: str(args, "doc") ?? "", ops: parseOps(args.ops), why };
          break;
        case "retitle":
          change = {
            type: "retitle",
            doc: str(args, "doc") ?? "",
            kind: str(args, "kind"),
            title: str(args, "title"),
            why,
          };
          break;
        case "delete":
          change = { type: "delete", doc: str(args, "doc") ?? "", why };
          break;
        case "merge":
          change = {
            type: "merge",
            doc: str(args, "doc") ?? "",
            into: str(args, "into") ?? "",
            path: str(args, "path") ?? "",
            why,
          };
          break;
        default:
          return "action 要是 create、patch、retitle、delete 或 merge。";
      }
    } catch (error) {
      return error instanceof PatchError ? `沒有改:${error.message}` : "參數不正確。";
    }
    const result = await this.deps.store.apply(change, writer);
    if (!result.ok) return `沒有改:${result.error}`;
    if (result.doc === null) return "好了。";
    return `好了:${shortId(result.doc.id)} ${result.doc.kind}「${result.doc.title}」`;
  }
}
