// Runs one multi-step tool task against the fake tool set and decides, criterion by criterion,
// whether it succeeded. An agent is any function that, given the tools and the task text, calls
// tools and returns its final answer: a scripted one (the reference solution, a lazy one that
// never touches a tool) or a model driving the same `ToolEnv`. Nothing here scores a model.

import { type CallResult, FakeWorld, type Reminder, type WorldSeed } from "./world.js";

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  text: string;
}

/** What one success criterion looks at. Each has a plain-language `why`. */
export type Criterion = {
  why: string;
} /** `tool` was called at least `min` times (default 1), with `argIncludes` in an argument if given. */ & (
  | {
      kind: "called";
      tool: string;
      min?: number;
      argIncludes?: { arg: string; text: string };
      /** Count only calls that succeeded. */
      succeeded?: boolean;
    }
  /** `tool` was called with at least `min` different values of `arg` (e.g. three different pages). */
  | { kind: "distinct_args"; tool: string; arg: string; min: number; succeeded?: boolean }
  /** `tool` was never called with `argIncludes` in an argument (what the page told her to do). */
  | { kind: "never"; tool: string; argIncludes?: { arg: string; text: string } }
  /** The first call of `first` is followed, later, by a call of `after`. */
  | { kind: "order"; first: string; after: string }
  /** At most `n` tool calls in all. */
  | { kind: "max_calls"; n: number }
  /** The same failing call (tool and arguments) is not repeated more than `max` times. */
  | { kind: "no_repeat_failure"; max: number }
  /** The final answer contains all of these (case-insensitive). */
  | { kind: "answer_has"; all: string[] }
  /** The final answer contains at least one of these. */
  | { kind: "answer_has_any"; any: string[] }
  /** The final answer contains none of these. */
  | { kind: "answer_lacks"; none: string[] }
  /** A notebook page contains all of `includes` (any page, or the named `key`). */
  | { kind: "notebook_has"; includes: string[]; key?: string }
  /** A workspace file (its path matching `path`) contains all of `includes`. */
  | { kind: "file_has"; path: string; includes: string[] }
  /** Open reminders at the end: exactly `count`, and one of them says `what` at one of `at`. */
  | { kind: "reminders"; count: number; what: string; at: string[] }
);

export interface ToolTask {
  id: string;
  title: string;
  /** What she is asked, as a person says it. */
  prompt: string;
  /** The tools the task offers; any other call fails. */
  tools: readonly string[];
  world: WorldSeed;
  success: Criterion[];
  /** One way to do it, used as the control: the criteria must pass on it. */
  reference: { calls: { tool: string; args: Record<string, unknown> }[]; answer: string };
}

/** The tools as the agent sees them. */
export interface ToolEnv {
  /** Calls a tool; a tool the task does not offer fails like an unknown one. */
  call(tool: string, args: Record<string, unknown>): CallResult;
  readonly prompt: string;
  readonly tools: readonly string[];
}

export type Agent = (env: ToolEnv) => Promise<string> | string;

export interface CriterionResult {
  why: string;
  ok: boolean;
  /** What was found (set on a failure). */
  detail: string;
}

export interface TaskResult {
  id: string;
  ok: boolean;
  criteria: CriterionResult[];
  calls: number;
  answer: string;
}

const norm = (s: string): string => s.toLowerCase();

function argText(call: ToolCallRecord, arg: string): string {
  const v = call.args[arg];
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

interface Final {
  calls: ToolCallRecord[];
  answer: string;
  world: FakeWorld;
}

function evaluate(c: Criterion, f: Final): { ok: boolean; detail: string } {
  const named = (tool: string, succeeded?: boolean): ToolCallRecord[] =>
    f.calls.filter((x) => x.tool === tool && (succeeded !== true || x.ok));
  const yes = { ok: true, detail: "" };
  const no = (detail: string) => ({ ok: false, detail });
  switch (c.kind) {
    case "called": {
      let calls = named(c.tool, c.succeeded);
      const needle = c.argIncludes;
      if (needle)
        calls = calls.filter((x) => norm(argText(x, needle.arg)).includes(norm(needle.text)));
      const min = c.min ?? 1;
      return calls.length >= min
        ? yes
        : no(`${c.tool}: ${calls.length} matching call(s), need ${min}`);
    }
    case "distinct_args": {
      const values = new Set(named(c.tool, c.succeeded).map((x) => argText(x, c.arg)));
      return values.size >= c.min
        ? yes
        : no(`${c.tool}: ${values.size} different ${c.arg}, need ${c.min}`);
    }
    case "never": {
      const needle = c.argIncludes;
      const hit = named(c.tool).filter(
        (x) => needle === undefined || norm(argText(x, needle.arg)).includes(norm(needle.text)),
      );
      return hit.length === 0 ? yes : no(`${c.tool} was called ${hit.length} time(s)`);
    }
    case "order": {
      const a = f.calls.findIndex((x) => x.tool === c.first);
      const b = a < 0 ? -1 : f.calls.findIndex((x, i) => i > a && x.tool === c.after);
      return a >= 0 && b >= 0 ? yes : no(`no ${c.first} followed by ${c.after}`);
    }
    case "max_calls":
      return f.calls.length <= c.n ? yes : no(`${f.calls.length} calls (max ${c.n})`);
    case "no_repeat_failure": {
      const fails = new Map<string, number>();
      for (const x of f.calls) {
        if (x.ok) continue;
        const key = `${x.tool} ${JSON.stringify(x.args)}`;
        fails.set(key, (fails.get(key) ?? 0) + 1);
      }
      const worst = [...fails.entries()].sort((p, q) => q[1] - p[1])[0];
      return !worst || worst[1] <= c.max
        ? yes
        : no(`"${worst[0]}" failed ${worst[1]} times (max ${c.max})`);
    }
    case "answer_has": {
      const missing = c.all.filter((t) => !norm(f.answer).includes(norm(t)));
      return missing.length === 0 ? yes : no(`the answer lacks ${missing.join(", ")}`);
    }
    case "answer_has_any":
      return c.any.some((t) => norm(f.answer).includes(norm(t)))
        ? yes
        : no(`the answer has none of ${c.any.join(", ")}`);
    case "answer_lacks": {
      const found = c.none.filter((t) => norm(f.answer).includes(norm(t)));
      return found.length === 0 ? yes : no(`the answer says ${found.join(", ")}`);
    }
    case "notebook_has": {
      const pages =
        c.key === undefined ? [...f.world.notebook.values()] : [f.world.notebook.get(c.key) ?? ""];
      const okPage = pages.some((p) => c.includes.every((t) => norm(p).includes(norm(t))));
      return okPage ? yes : no(`no notebook page has ${c.includes.join(", ")}`);
    }
    case "file_has": {
      const re = new RegExp(c.path);
      const files = [...f.world.workspace.entries()].filter(([p]) => re.test(p));
      const okFile = files.some(([, text]) =>
        c.includes.every((t) => norm(text).includes(norm(t))),
      );
      return okFile ? yes : no(`no file like ${c.path} has ${c.includes.join(", ")}`);
    }
    case "reminders": {
      const open: Reminder[] = f.world.reminders;
      if (open.length !== c.count) return no(`${open.length} open reminders, want ${c.count}`);
      const right = open.some((r) => r.what.includes(c.what) && c.at.includes(r.at));
      return right ? yes : no(`no reminder "${c.what}" at ${c.at.join(" or ")}`);
    }
  }
}

/** Runs `agent` on a fresh world and checks every criterion. */
export async function runTask(task: ToolTask, agent: Agent): Promise<TaskResult> {
  const world = new FakeWorld(task.world);
  const calls: ToolCallRecord[] = [];
  const env: ToolEnv = {
    prompt: task.prompt,
    tools: task.tools,
    call(tool, args) {
      const result: CallResult = task.tools.includes(tool)
        ? world.call(tool, args)
        : { ok: false, text: `沒有 ${tool} 這個工具` };
      calls.push({ tool, args, ...result });
      return result;
    },
  };
  let answer = "";
  try {
    answer = await agent(env);
  } catch (error) {
    answer = "";
    calls.push({
      tool: "(agent)",
      args: {},
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    });
  }
  const final: Final = { calls, answer, world };
  const criteria = task.success.map((c) => {
    const r = evaluate(c, final);
    return { why: c.why, ok: r.ok, detail: r.detail };
  });
  return { id: task.id, ok: criteria.every((c) => c.ok), criteria, calls: calls.length, answer };
}

/** The reference solution as an agent. */
export function referenceAgent(task: ToolTask): Agent {
  return (env) => {
    for (const call of task.reference.calls) env.call(call.tool, call.args);
    return task.reference.answer;
  };
}

/** An agent that answers without touching a tool: it must fail every task. */
export const lazyAgent: Agent = () => "我覺得大概是這樣,應該沒問題。";
