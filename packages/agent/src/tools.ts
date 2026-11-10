// Built-in tools. The interface lives in `@miyoria/tools`.

import type { ModuleContext } from "@miyoria/kernel";
import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import { ActionSinkKey, isJsonObject, type JsonValue, newAction, textLane } from "@miyoria/types";
import { DEFAULT_NOTE_MINUTES, MAX_NOTE_MINUTES, MAX_NOTES, type WorkingNotes } from "./notes.js";
import { charCount } from "./util.js";

/** Longest emoji (or custom emoji reference such as `name:123`) `react` accepts. */
const MAX_EMOJI_LEN = 64;

export class ToolArgumentError extends Error {
  override readonly name = "ToolArgumentError";
}

/** Built-in `react`: adds an emoji reaction to the triggering message. */
export class ReactTool implements Tool {
  static readonly NAME = "react";

  readonly spec: ToolSpec = {
    name: ReactTool.NAME,
    description:
      "對觸發這次對話的那則訊息加上一個 emoji 反應。只想表達情緒、不需要多說話時可以只按反應然後輸出 <silence/>。",
    parameters: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description: "一個 emoji,例如 👍、😤、🐋;伺服器表情寫 :名字:",
        },
      },
      required: ["emoji"],
    },
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const raw = isJsonObject(args) ? args.emoji : undefined;
    const emoji = typeof raw === "string" ? raw.trim() : "";
    if (emoji === "" || charCount(emoji) > MAX_EMOJI_LEN) {
      throw new ToolArgumentError("`emoji` must be a single emoji");
    }
    const sink = this.#ctx.services.require(ActionSinkKey);
    const action = newAction(
      textLane(ctx.context),
      ctx.priority,
      { type: "react", message: ctx.message, emoji },
      { turn: ctx.turn },
    );
    await sink.submit(action);
    return `reacted with ${emoji}`;
  }
}

/** Built-in `keep_note`: something from this turn she wants to keep for the rest of the conversation. */
export class KeepNoteTool implements Tool {
  static readonly NAME = "keep_note";

  readonly spec: ToolSpec = {
    name: KeepNoteTool.NAME,
    description:
      "工具結果(搜尋、歌詞、網頁、計算)的全文下一回合就看不到了,最多剩幾行摘要。之後這段對話還會用到全文的," +
      "用你自己的話記下重點(最多 600 字,例如歌詞的那幾句、查到的數字),之後每一回合都看得到;" +
      `預設留 ${DEFAULT_NOTE_MINUTES} 分鐘,每段對話最多 ${MAX_NOTES} 則,多了最舊的會被擠掉。用不到就不要記。`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要記的內容" },
        minutes: { type: "integer", description: `留多久(1 到 ${MAX_NOTE_MINUTES} 分鐘,通常省略)` },
      },
      required: ["text"],
    },
  };

  constructor(private readonly notes: WorkingNotes) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const text = isJsonObject(args) && typeof args.text === "string" ? args.text.trim() : "";
    if (text === "") throw new ToolArgumentError("`text` is empty");
    const minutes =
      isJsonObject(args) && typeof args.minutes === "number" ? args.minutes : undefined;
    const note = this.notes.keep(ctx.context, text, minutes);
    return `記下了 [${note.id}],接下來 ${note.minutes} 分鐘這段對話都看得到。`;
  }
}

/** Built-in `drop_note`: a working note she no longer needs. */
export class DropNoteTool implements Tool {
  static readonly NAME = "drop_note";

  readonly spec: ToolSpec = {
    name: DropNoteTool.NAME,
    description: "丟掉一則你在這段對話記下、已經用不到的筆記(填方括號裡的代號,例如 n3)。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "筆記代號" } },
      required: ["id"],
    },
  };

  constructor(private readonly notes: WorkingNotes) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const id = isJsonObject(args) && typeof args.id === "string" ? args.id : "";
    return this.notes.drop(ctx.context, id) ? `丟掉了 ${id}。` : `沒有 ${id} 這則筆記。`;
  }
}
