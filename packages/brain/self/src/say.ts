// `say(place, text)`: how she speaks somewhere other than the place of the run. In the place of
// the run she just writes. The line goes the way her written lines go: the guard's line check,
// then the outlet; a refusal is the tool's answer.

import { defineTool, type Tool, type ToolContext, type ToolResult } from "@miyoria/llm/tools";
import { type ContextKey, contextKeyString, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import { SAY_TOOL } from "./rules.js";

export const SAY = "say";

/** How a line of the tool ended: sent, or why not. */
export type Spoken = { ok: true } | { ok: false; code: string; reason: string };

export interface SayDeps {
  /** The place she named, from where she is; `null`: she knows no such place. */
  resolve(place: string, from: ContextKey): ContextKey | null | Promise<ContextKey | null>;
  /**
   * Why `say` may not go to `place` at all (a DM, which has a tool of its own with its own
   * checks); `null`: it may. Unset: every place may.
   */
  refuses?(place: ContextKey): string | null;
  /** Checks and delivers the line for the run of `turn`; `null`: no such run is going on. */
  sayIn(turn: string, place: ContextKey, text: string): Promise<Spoken | null>;
}

const Params = z.object({
  place: z.string().describe(SAY_TOOL.place),
  text: z.string().describe(SAY_TOOL.text),
});

function refused(stage: string, text: string): ToolResult {
  return { ok: false, code: "denied", stage, text };
}

export function sayTool(deps: SayDeps): Tool {
  const run = async (ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = Params.safeParse(raw);
    if (!args.success || args.data.text.trim() === "" || args.data.place.trim() === "") {
      return { ok: false, code: "failed", stage: null, text: SAY_TOOL.empty };
    }
    const name = args.data.place.trim();
    const place = await deps.resolve(name, ctx.context);
    if (place === null) return refused("place", SAY_TOOL.unknownPlace(name));
    if (contextKeyString(place) === contextKeyString(ctx.context)) {
      return refused("place", SAY_TOOL.here);
    }
    const refusal = deps.refuses?.(place) ?? null;
    if (refusal !== null) return refused("place", SAY_TOOL.blocked(refusal));
    const spoken = await deps.sayIn(ctx.turn, place, args.data.text.trim());
    if (spoken === null) return refused("run", SAY_TOOL.noRun);
    return spoken.ok
      ? { ok: true, text: SAY_TOOL.sent(name) }
      : refused(spoken.code, SAY_TOOL.blocked(spoken.reason));
  };
  const tool = defineTool({
    name: SAY,
    description: SAY_TOOL.description,
    parameters: Params,
    effect: "say",
    speed: "instant",
    risk: "medium",
    group: "chat",
    core: true,
    next: true,
    async call(ctx, raw) {
      const result = await run(ctx, raw);
      if (!result.ok) throw new Error(result.text);
      return result.text;
    },
  });
  return { ...tool, result: run };
}
