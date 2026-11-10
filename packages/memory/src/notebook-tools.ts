// Model tools of her notebook: `notebook_read` (a page, or the index), `notebook_write` and
// `notebook_delete`. Every answer is data: the page text is escaped, and a refused write says why.

import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import { isJsonObject, type JsonValue, type NotebookWhere } from "@miyoria/types";
import type { NotebookConfig } from "./config.js";
import { indexText, NotebookError, type NotebookStore, pageText } from "./notebook.js";

export const NOTEBOOK_READ = "notebook_read";
export const NOTEBOOK_WRITE = "notebook_write";
export const NOTEBOOK_DELETE = "notebook_delete";
export const NOTEBOOK_TOOLS = [NOTEBOOK_READ, NOTEBOOK_WRITE, NOTEBOOK_DELETE] as const;

function arg(args: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(args) ? args[key] : undefined;
}

function text(args: JsonValue, key: string): string {
  const v = arg(args, key);
  return typeof v === "string" ? v.trim() : "";
}

/** Where a tool call reads and writes: the place of the turn, with the DM partner. */
export function whereOf(ctx: ToolContext): NotebookWhere {
  return { context: ctx.context, accounts: [ctx.account] };
}

const PATH_HINT = "頁面路徑,例如「人/Owen」「主題/Minecraft 建築」「自己/想做的事」";

export class NotebookReadTool implements Tool {
  readonly spec: ToolSpec = {
    name: NOTEBOOK_READ,
    description:
      "讀你的筆記本。不給 path 就列出這裡看得到的所有頁面;給 path 就讀那一頁,太長的頁面用 from 分段讀。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_HINT },
        from: { type: "integer", minimum: 0, description: "從第幾個字開始讀(預設 0)" },
      },
    },
  };

  constructor(
    private readonly store: NotebookStore,
    private readonly config: () => NotebookConfig,
  ) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const cfg = this.config();
    const where = whereOf(ctx);
    const path = text(args, "path");
    if (path === "") {
      const entries = this.store.index(where);
      return entries.length === 0 ? "筆記本還是空的。" : indexText(entries, cfg.read_chars);
    }
    const page = this.store.read(path, where);
    if (page === null) return `沒有「${path}」這一頁(用 notebook_read 不給 path 可以看目錄)。`;
    const from = arg(args, "from");
    return pageText(
      page,
      typeof from === "number" && from > 0 ? Math.floor(from) : 0,
      cfg.read_chars,
    );
  }
}

export class NotebookWriteTool implements Tool {
  readonly spec: ToolSpec = {
    name: NOTEBOOK_WRITE,
    description:
      "寫進你的筆記本:每個人一頁(人/名字)、每個主題一頁(主題/名稱)、你自己的事(自己/…)。寫日後自己看得懂的重點,不要抄整段對話。mode=append 接在後面,mode=replace 整頁改寫(整理時用)。私訊裡寫的頁面只在那個私訊看得到。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_HINT },
        content: { type: "string", description: "要寫的內容" },
        mode: { type: "string", enum: ["append", "replace"], description: "預設 append" },
      },
      required: ["path", "content"],
    },
  };

  constructor(private readonly store: NotebookStore) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const path = text(args, "path");
    const content = text(args, "content");
    if (path === "" || content === "") return "path 和 content 都要給。";
    const mode = arg(args, "mode") === "replace" ? "replace" : "append";
    try {
      const r = await this.store.write(path, content, mode, whereOf(ctx));
      return `${r.created ? "新增" : "更新"}了「${r.path}」(現在 ${r.chars} 字)。`;
    } catch (error) {
      if (error instanceof NotebookError) return `沒有寫進去:${error.message}`;
      throw error;
    }
  }
}

export class NotebookDeleteTool implements Tool {
  readonly spec: ToolSpec = {
    name: NOTEBOOK_DELETE,
    description: "刪掉筆記本裡的一頁(只能刪在這個地方寫的頁面)。合併或整理之後用。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: PATH_HINT } },
      required: ["path"],
    },
  };

  constructor(private readonly store: NotebookStore) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const path = text(args, "path");
    if (path === "") return "要給 path。";
    try {
      return (await this.store.remove(path, whereOf(ctx)))
        ? `刪掉了「${path}」。`
        : `這裡沒有「${path}」這一頁。`;
    } catch (error) {
      if (error instanceof NotebookError) return `沒有刪:${error.message}`;
      throw error;
    }
  }
}
