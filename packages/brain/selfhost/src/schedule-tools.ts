// `schedule(when, note, where?)` and its two helpers, `schedule_list` and `schedule_cancel`: she
// sets her own later wake-up (docs/design/v5-architecture.md §7.3). Only the new runner offers
// them (`next`); `schedule` is always offered (core), the other two are found with `find_tools`.

import { defineTool, type Tool, type ToolContext, type ToolResult } from "@miyoria/llm/tools";
import { type ContextKey, contextKeyString, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import { SCHEDULE_CANCEL_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_TOOL } from "./initiative-texts.js";
import { type ScheduleBook, ScheduleError, scheduleKey, scheduleLine } from "./schedule.js";

export const SCHEDULE = "schedule";
export const SCHEDULE_LIST = "schedule_list";
export const SCHEDULE_CANCEL = "schedule_cancel";

export interface ScheduleToolDeps {
  book: ScheduleBook;
  /** The place she named, from where she is; `null`: she knows no such place. */
  resolve(place: string, from: ContextKey): Promise<ContextKey | null>;
  /** A place's name as she would know it, when the platform has one. */
  describe(place: ContextKey): Promise<string | null>;
  /**
   * The Space of a place (identity's id; `null`: none). `schedule_list` in one server shows only
   * that server's schedules and those of no server (docs/design/v5-places.md). Unset: all.
   */
  spaceOf?(place: ContextKey | null): string | null;
}

const SetParams = z.object({
  when: z.string().describe(SCHEDULE_TOOL.when),
  note: z.string().describe(SCHEDULE_TOOL.note),
  where: z.string().optional().describe(SCHEDULE_TOOL.where),
});

const CancelParams = z.object({
  id: z.string().describe(SCHEDULE_CANCEL_TOOL.id),
});

const failed = (text: string): ToolResult => ({ ok: false, code: "failed", stage: null, text });

/** A tool whose `result` is the call; `call` throws its refusal, as `ToolRegistry` expects. */
function withResult(
  tool: Tool,
  run: (ctx: ToolContext, raw: JsonValue) => Promise<ToolResult>,
): Tool {
  return { ...tool, result: run };
}

export function scheduleTools(deps: ScheduleToolDeps): Tool[] {
  const { book } = deps;

  const set = async (ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = SetParams.safeParse(raw);
    if (!args.success || args.data.when.trim() === "" || args.data.note.trim() === "") {
      return failed(SCHEDULE_TOOL.empty);
    }
    const when = book.when(args.data.when);
    if (when === null) return failed(SCHEDULE_TOOL.unreadable(args.data.when));
    let place: ContextKey | null = ctx.context;
    const where = args.data.where?.trim() ?? "";
    if (where !== "") {
      place = await deps.resolve(where, ctx.context);
      if (place === null) return failed(SCHEDULE_TOOL.unknownPlace(where));
      if (place.kind === "dm" && contextKeyString(place) !== contextKeyString(ctx.context)) {
        return failed(SCHEDULE_TOOL.dmPlace);
      }
    }
    try {
      const row = book.set({ when, note: args.data.note, context: place });
      const at = when.daily ?? args.data.when.trim();
      return { ok: true, text: SCHEDULE_TOOL.set(scheduleKey(row), at, when.daily !== null) };
    } catch (error) {
      if (error instanceof ScheduleError) return failed(error.message);
      throw error;
    }
  };

  const list = async (ctx: ToolContext): Promise<ToolResult> => {
    const space = deps.spaceOf?.(ctx.context) ?? null;
    const rows = book
      .open()
      .filter((r) => deps.spaceOf === undefined || r.space_id === null || r.space_id === space);
    if (rows.length === 0) return { ok: true, text: SCHEDULE_LIST_TOOL.none };
    const here = contextKeyString(ctx.context);
    const lines: string[] = [];
    for (const row of rows) {
      const where =
        row.context === null
          ? SCHEDULE_LIST_TOOL.home
          : contextKeyString(row.context) === here
            ? SCHEDULE_LIST_TOOL.here
            : ((await deps.describe(row.context)) ?? row.context.channel);
      lines.push(scheduleLine(row, book.offsetMinutes, where));
    }
    return { ok: true, text: lines.join("\n") };
  };

  const cancel = async (_ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = CancelParams.safeParse(raw);
    if (!args.success) return failed(SCHEDULE_CANCEL_TOOL.notFound);
    const row = book.cancel(args.data.id);
    if (row === null) return failed(SCHEDULE_CANCEL_TOOL.notFound);
    return { ok: true, text: SCHEDULE_CANCEL_TOOL.cancelled(scheduleKey(row), row.note) };
  };

  const call =
    (run: (ctx: ToolContext, raw: JsonValue) => Promise<ToolResult>) =>
    async (ctx: ToolContext, raw: JsonValue): Promise<string> => {
      const result = await run(ctx, raw);
      if (!result.ok) throw new Error(result.text);
      return result.text;
    };

  return [
    withResult(
      defineTool({
        name: SCHEDULE,
        description: SCHEDULE_TOOL.description,
        parameters: SetParams,
        effect: "act",
        speed: "instant",
        risk: "low",
        group: "schedule",
        core: true,
        next: true,
        call: call(set),
      }),
      set,
    ),
    withResult(
      defineTool({
        name: SCHEDULE_LIST,
        description: SCHEDULE_LIST_TOOL.description,
        parameters: z.object({}),
        effect: "read",
        speed: "instant",
        risk: "low",
        group: "schedule",
        next: true,
        readOnly: true,
        call: call(list),
      }),
      list,
    ),
    withResult(
      defineTool({
        name: SCHEDULE_CANCEL,
        description: SCHEDULE_CANCEL_TOOL.description,
        parameters: CancelParams,
        effect: "act",
        speed: "instant",
        risk: "low",
        group: "schedule",
        next: true,
        call: call(cancel),
      }),
      cancel,
    ),
  ];
}
