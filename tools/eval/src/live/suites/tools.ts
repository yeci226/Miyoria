// Suite `tools`: the ten multi-step tool tasks (tasks/set.ts) with the subject as the agent, on the
// fake world, decided by the tasks' own criteria (`runTask`). Nothing is judged by a model.

import { runTask, type TaskResult, type ToolEnv, type ToolTask } from "../../tasks/run.js";
import { TOOL_TASKS } from "../../tasks/set.js";
import { REGULAR } from "../scenes.js";
import { type ModelUsage, NO_USAGE, type Reply, replyText, type Scene } from "../subject.js";
import { attempt, type SuiteContext, type SuiteResult, share } from "../suite.js";

/** Who asks her in a tool task. */
const ASKER = "阿哲";

/** The task as a scene: one regular asks her in a text channel, with the task's tools on offer. */
export function taskScene(task: ToolTask, env: ToolEnv): Scene {
  return {
    id: `tools-${task.id}`,
    place: "text",
    people: [{ name: ASKER, closeness: REGULAR }],
    lines: [{ who: ASKER, text: task.prompt }],
    address: "mention",
    tools: env,
    // Only a task that sets its clock depends on it (the reminder tasks).
    ...(task.world.now === undefined ? {} : { now: task.world.now }),
  };
}

export interface ToolItem extends TaskResult {
  run: number;
  lines: string[];
  usage: ModelUsage;
  ms: number;
  timed_out?: boolean;
}

export async function runTools(
  ctx: SuiteContext,
  tasks: readonly ToolTask[] = TOOL_TASKS,
): Promise<SuiteResult> {
  const items: ToolItem[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  let stopped = false;
  outer: for (const task of tasks) {
    const probe: ToolEnv = {
      prompt: task.prompt,
      tools: task.tools,
      call: () => ({ ok: false, text: "" }),
    };
    const reason = ctx.subject.unsupported(taskScene(task, probe));
    if (reason !== null) {
      unsupported.push({ id: task.id, reason });
      continue;
    }
    for (let run = 0; run < ctx.repeat; run++) {
      let reply: Reply | null = null;
      const step = await attempt(ctx.meter, () =>
        runTask(task, async (env) => {
          reply = await ctx.subject.respond(taskScene(task, env));
          return replyText(reply);
        }),
      );
      if (step.kind === "stopped") {
        stopped = true;
        break outer;
      }
      if (step.kind === "error") throw new Error(`tools ${task.id}: ${step.error}`);
      const done = reply as Reply | null;
      items.push({
        ...step.value,
        run,
        lines: done?.lines ?? [],
        usage: done?.usage ?? { ...NO_USAGE },
        ms: done?.ms ?? 0,
        ...(done?.timed_out ? { timed_out: true } : {}),
      });
      ctx.log(`tools ${task.id}: ${step.value.ok ? "ok" : "failed"} (${step.value.calls} calls)`);
    }
  }
  return {
    suite: "tools",
    headline: { success: share(items.filter((i) => i.ok).length, items.length) },
    items,
    unsupported,
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}
