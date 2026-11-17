// Her tools for the sub-agents: `delegate` (core: it starts a job and answers at once with its id)
// and `delegate_list`, `delegate_cancel`, `delegate_read` (found with `find_tools`). All are for
// the new runner only (`next`), so the current turn's tool list does not change.

import {
  defineTool,
  type Tool,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@miyoria/llm/tools";
import type { AccountRef, JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { Delegator } from "./delegate.js";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_LIST_TOOL,
  DELEGATE_READ_TOOL,
  DELEGATE_REFUSALS,
  DELEGATE_TOOL,
} from "./delegate-texts.js";
import { CALLABLE_KINDS } from "./subagents.js";
import type { WakeAuthor } from "./types.js";

export const DELEGATE = "delegate";
export const DELEGATE_LIST = "delegate_list";
export const DELEGATE_CANCEL = "delegate_cancel";
export const DELEGATE_READ = "delegate_read";

export const DELEGATE_TOOLS: readonly string[] = [
  DELEGATE,
  DELEGATE_LIST,
  DELEGATE_CANCEL,
  DELEGATE_READ,
];

export interface DelegateToolDeps {
  delegator: Delegator;
  /** The name shown for an account in a job's wake (`WakeAuthor.name`). Default: its id. */
  nameOf?: (account: AccountRef) => string;
}

/** Who a tool call acts for: the person who asked, when someone did. */
export function askerOf(
  ctx: ToolContext,
  nameOf?: (account: AccountRef) => string,
): WakeAuthor | null {
  const account = ctx.principal.requester;
  if (account === null) return null;
  return { account, name: nameOf?.(account) ?? account.id };
}

const denied = (stage: string, text: string): ToolResult => ({
  ok: false,
  code: "denied",
  stage,
  text,
});

/** A tool whose refusals are values (`result`) and, for the current turn's reading, errors (`call`). */
function tool(
  definition: Omit<ToolDefinition, "call">,
  run: (ctx: ToolContext, raw: JsonValue) => Promise<ToolResult>,
): Tool {
  const base = defineTool({
    ...definition,
    async call(ctx, raw) {
      const out = await run(ctx, raw);
      if (!out.ok) throw new Error(out.text);
      return out.text;
    },
  });
  return { ...base, result: run };
}

const StartArgs = z.object({
  kind: z.enum(CALLABLE_KINDS as [string, ...string[]]).describe(DELEGATE_TOOL.kind),
  goal: z.string().describe(DELEGATE_TOOL.goal),
  budget: z.number().positive().describe(DELEGATE_TOOL.budget).optional(),
});

/** What a call may say: looser than the spec, so a kind she should not use gets a clear refusal. */
const LooseStart = z.object({ kind: z.string(), goal: z.string(), budget: z.number().optional() });

const CancelArgs = z.object({ job: z.string().describe(DELEGATE_CANCEL_TOOL.job) });

const ReadArgs = z.object({
  job: z.string().describe(DELEGATE_READ_TOOL.job),
  what: z.enum(["result", "transcript"]).describe(DELEGATE_READ_TOOL.what).optional(),
  from: z.int().min(0).describe(DELEGATE_READ_TOOL.from).optional(),
});

export function delegateTools(deps: DelegateToolDeps): Tool[] {
  const { delegator } = deps;
  const common = { risk: "low", group: "work", next: true } as const;
  return [
    tool(
      {
        name: DELEGATE,
        description: DELEGATE_TOOL.description,
        parameters: StartArgs,
        ...common,
        effect: "act",
        speed: "long",
        core: true,
        actsFor: true,
      },
      async (ctx, raw) => {
        const args = LooseStart.safeParse(raw);
        if (!args.success) return denied("args", DELEGATE_REFUSALS.emptyGoal);
        const out = delegator.start({
          kind: args.data.kind,
          goal: args.data.goal,
          budget: args.data.budget ?? null,
          context: ctx.context,
          from: askerOf(ctx, deps.nameOf),
        });
        return out.ok ? { ok: true, text: out.text } : denied(out.code, out.text);
      },
    ),
    tool(
      {
        name: DELEGATE_LIST,
        description: DELEGATE_LIST_TOOL.description,
        parameters: z.object({}),
        ...common,
        effect: "read",
        speed: "instant",
        readOnly: true,
      },
      async () => {
        const lines = delegator.lines();
        return { ok: true, text: lines.length === 0 ? "沒有交給小幫手的工作。" : lines.join("\n") };
      },
    ),
    tool(
      {
        name: DELEGATE_CANCEL,
        description: DELEGATE_CANCEL_TOOL.description,
        parameters: CancelArgs,
        ...common,
        effect: "act",
        speed: "instant",
      },
      async (_ctx, raw) => {
        const args = CancelArgs.safeParse(raw);
        if (!args.success || args.data.job.trim() === "") {
          return denied("args", DELEGATE_REFUSALS.empty);
        }
        const out = delegator.cancel(args.data.job);
        return out.ok ? { ok: true, text: out.text } : denied("job", out.text);
      },
    ),
    tool(
      {
        name: DELEGATE_READ,
        description: DELEGATE_READ_TOOL.description,
        parameters: ReadArgs,
        ...common,
        effect: "read",
        speed: "instant",
        readOnly: true,
        framed: true,
      },
      async (_ctx, raw) => {
        const args = ReadArgs.safeParse(raw);
        if (!args.success || args.data.job.trim() === "") {
          return denied("args", DELEGATE_REFUSALS.empty);
        }
        const out = delegator.read(args.data.job, args.data.what ?? "result", args.data.from ?? 0);
        return out.ok ? { ok: true, text: out.text } : denied("job", out.text);
      },
    ),
  ];
}
