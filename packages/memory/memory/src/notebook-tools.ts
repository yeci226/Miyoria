// Model tools of her notebook: `notebook_read` (a page, or the index), `notebook_write` and
// `notebook_delete`. Every answer is data: the page text is escaped, and a refused write says why.

import {
  type Tool,
  type ToolContext,
  type ToolMeta,
  type ToolSpec,
  toolParameters,
} from "@miyoria/llm/tools";
import {
  isJsonObject,
  type JsonValue,
  type NotebookEntry,
  type NotebookPage,
  type NotebookWhere,
} from "@miyoria/types";
import { z } from "zod";
import type { NotebookConfig } from "./config.js";
import {
  indexText,
  NotebookError,
  pageText,
  type WriteMode,
  type WriteResult,
} from "./notebook.js";

export const NOTEBOOK_READ = "notebook_read";
export const NOTEBOOK_WRITE = "notebook_write";
export const NOTEBOOK_DELETE = "notebook_delete";
export const NOTEBOOK_TOOLS = [NOTEBOOK_READ, NOTEBOOK_WRITE, NOTEBOOK_DELETE] as const;

/** What the three tools need of a notebook: the page store, or her documents (`NotesNotebook`). */
export interface NotebookBackend {
  index(where: NotebookWhere): NotebookEntry[];
  read(path: string, where: NotebookWhere): NotebookPage | null;
  write(path: string, text: string, mode: WriteMode, where: NotebookWhere): Promise<WriteResult>;
  remove(path: string, where: NotebookWhere): Promise<boolean>;
  /** Lines in use of the page that were written somewhere else than `where` (her documents). */
  elsewhere?(path: string, where: NotebookWhere): number;
}

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

const ReadParams = z.object({
  path: z.string().describe(PATH_HINT).optional(),
  from: z.int().min(0).describe("從第幾個字開始讀(預設 0)").optional(),
});

export class NotebookReadTool implements Tool {
  /** Reading a page writes nothing. */
  readonly readOnly = true;
  readonly spec: ToolSpec = {
    name: NOTEBOOK_READ,
    description:
      "讀你的筆記本。不給 path 就列出這裡看得到的所有頁面;給 path 就讀那一頁,太長的頁面用 from 分段讀。",
    parameters: toolParameters(ReadParams),
  };
  readonly parameters = ReadParams;
  readonly meta: ToolMeta = {
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "notebook",
    core: true,
  };

  constructor(
    private readonly store: NotebookBackend,
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

const WriteParams = z.object({
  path: z.string().describe(PATH_HINT),
  content: z.string().describe("要寫的內容"),
  mode: z.enum(["append", "replace"]).describe("預設 append").optional(),
});

export class NotebookWriteTool implements Tool {
  readonly spec: ToolSpec = {
    name: NOTEBOOK_WRITE,
    description:
      "寫進你的筆記本:每個人一頁(人/名字)、每個主題一頁(主題/名稱)、你自己的事(自己/…)。寫日後自己看得懂的重點,不要抄整段對話。mode=append 接在後面,mode=replace 整頁改寫(整理時用)。私訊裡寫的頁面只在那個私訊看得到。",
    parameters: toolParameters(WriteParams),
  };
  readonly parameters = WriteParams;
  readonly meta: ToolMeta = {
    effect: "act",
    speed: "instant",
    risk: "low",
    group: "notebook",
    core: true,
  };

  constructor(private readonly store: NotebookBackend) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const path = text(args, "path");
    const content = text(args, "content");
    if (path === "" || content === "") return "path 和 content 都要給。";
    const mode = arg(args, "mode") === "replace" ? "replace" : "append";
    try {
      const r = await this.store.write(path, content, mode, whereOf(ctx));
      const done = `${r.created ? "新增" : "更新"}了「${r.path}」(現在 ${r.chars} 字)。`;
      const rest = r.elsewhere ?? 0;
      return mode === "replace" && rest > 0
        ? `${done}這頁另外還有 ${rest} 行是在別的地方寫的,這裡改不到,所以還留著。`
        : done;
    } catch (error) {
      if (error instanceof NotebookError) return `沒有寫進去:${error.message}`;
      throw error;
    }
  }
}

const DeleteParams = z.object({ path: z.string().describe(PATH_HINT) });

export class NotebookDeleteTool implements Tool {
  readonly spec: ToolSpec = {
    name: NOTEBOOK_DELETE,
    description: "刪掉筆記本裡的一頁(只能刪在這個地方寫的頁面)。合併或整理之後用。",
    parameters: toolParameters(DeleteParams),
  };
  readonly parameters = DeleteParams;
  readonly meta: ToolMeta = { effect: "act", speed: "instant", risk: "medium", group: "notebook" };

  constructor(private readonly store: NotebookBackend) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const path = text(args, "path");
    if (path === "") return "要給 path。";
    try {
      const where = whereOf(ctx);
      const removed = await this.store.remove(path, where);
      const rest = this.store.elsewhere?.(path, where) ?? 0;
      if (rest > 0) {
        return removed
          ? `刪掉了「${path}」在這裡寫的部分;另外還有 ${rest} 行是在別的地方寫的,這裡刪不到。`
          : `「${path}」的 ${rest} 行都是在別的地方寫的,這裡刪不到。`;
      }
      return removed ? `刪掉了「${path}」。` : `這裡沒有「${path}」這一頁。`;
    } catch (error) {
      if (error instanceof NotebookError) return `沒有刪:${error.message}`;
      throw error;
    }
  }
}
