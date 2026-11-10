// The work lane as the main line reaches it (v4 §4.3 "誰能開"): three capabilities, each also a
// tool of hers.
//
// * `work.start` (`work_start`): a task, in her words, with why and for whom. It answers at once
//   with the task's id (`{task}` in its data), so the hands follow it like any task and tell her
//   what came of it when it ends: a result turn where someone waits, her next prompt otherwise.
// * `work.list` (`work_list`): what runs, what waits, what ended lately.
// * `work.steer` (`work_steer`): a hint or a new goal (the task keeps what it did and its budget),
//   or stop.
//
// The allowance of a task is decided here, by code, from where it was started (`allow.ts`).

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import type { ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  DirectivesKey,
  type Principal,
  WORK_LIST,
  WORK_START,
  WORK_STEER,
} from "@miyoria/types";
import { z } from "zod";
import { allowance } from "./allow.js";
import { shortId, type WorkLaneService } from "./lane.js";

export const WORK_START_TOOL = "work_start";
export const WORK_LIST_TOOL = "work_list";
export const WORK_STEER_TOOL = "work_steer";

const StartArgs = z.object({
  goal: z.string().min(1).max(600),
  for: z.string().max(80).nullish(),
  tools: z.array(z.string()).max(20).nullish(),
  steps: z.number().int().min(1).max(50).nullish(),
  /** The row of her activity table, when it is one (set by her own proposals). */
  activity: z.string().max(20).nullish(),
});
type StartArgs = z.output<typeof StartArgs>;

const ListArgs = z.object({});

const SteerArgs = z.object({
  task: z.string().min(1).max(40),
  hint: z.string().max(600).nullish(),
  goal: z.string().max(600).nullish(),
  stop: z.boolean().nullish(),
});
type SteerArgs = z.output<typeof SteerArgs>;

/** Who waits for a task: the person who asked, or whoever suggested it to her. */
function requesterOf(principal: Principal): AccountRef | null {
  return principal.requester;
}

export interface WorkCapabilityDeps {
  lane: WorkLaneService;
  tools(): ToolRegistry;
}

export function workCapabilities(deps: WorkCapabilityDeps): Capability[] {
  const { lane } = deps;
  const start = defineCapability<StartArgs>({
    name: WORK_START,
    summary: "把要花很多步的事交給工作車道在背景做",
    risk: "low",
    args: StartArgs,
    permission: null,
    tool: {
      name: WORK_START_TOOL,
      description:
        "把要花很多步的事交給背景的工作車道去做:查好幾個來源再整理、在工作區寫一個小程式、整理筆記、改進一個技能。" +
        "它在背景一步一步做(可以上網、跑程式、讀寫你的工作區和筆記),不會講話也不會發訊息;" +
        "做完會把結論告訴你,由你決定怎麼跟大家說。一兩步就能查到的,直接用查詢工具就好,不用開任務。" +
        "goal 用你自己的話寫清楚要做出什麼;for 是幫誰做的(名字),你自己想做的就省略。",
      properties: {
        goal: { type: "string", description: "要做出什麼(一兩句,寫成做完時要有的東西)" },
        for: { type: "string", description: "幫誰做的(名字);你自己想做的就省略" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "只想讓它用哪些工具(省略:能用的都給)",
        },
        steps: { type: "integer", minimum: 1, maximum: 50, description: "最多幾步(通常省略)" },
      },
      required: ["goal"],
    },
    async execute(args, ctx) {
      const principal = ctx.principal;
      const context: ContextKey | null = principal.context;
      const cfg = lane.config;
      const tools = allowance({
        configured: cfg.tools,
        tool: (name) => deps.tools().get(name),
        directives: ctx.services.get(DirectivesKey) ?? null,
        context,
        wanted: args.tools ?? null,
      });
      const own = principal.kind === "self" && principal.requester === null;
      const outcome = lane.start({
        goal: args.goal,
        why: ctx.request.why ?? "",
        for: args.for?.trim() || null,
        principal,
        context,
        tools,
        maxSteps: args.steps ?? (own ? cfg.initiative_steps : cfg.max_steps),
        turn: ctx.request.turn,
        activity: args.activity ?? null,
      });
      if (!outcome.ok) throw new CapabilityError(outcome.why);
      const id = shortId(outcome.id);
      const where =
        outcome.state === "running" ? "開始做了" : `前面還有 ${outcome.ahead + 1} 件,輪到就開始`;
      const who = requesterOf(principal) === null ? "" : ",做完會回來告訴你";
      return {
        text: `交給工作車道了(任務 ${id}),${where}${who};還沒做完,不要說做好了。能用:${tools.join("、") || "沒有工具"}`,
        data: { task: outcome.id, work: true, short: id },
      };
    },
  });
  const list = defineCapability<z.output<typeof ListArgs>>({
    name: WORK_LIST,
    summary: "看工作車道上的任務",
    risk: "low",
    args: ListArgs,
    permission: null,
    tool: {
      name: WORK_LIST_TOOL,
      description:
        "看你交給工作車道的任務:哪些在做、哪些在排隊、最近做完了什麼。要改方向或停掉時先看代號。",
      properties: {},
    },
    async execute() {
      const lines = lane.lines();
      return lines.length === 0 ? "工作車道上沒有任務。" : lines.join("\n");
    },
  });
  const steer = defineCapability<SteerArgs>({
    name: WORK_STEER,
    summary: "改工作車道上任務的方向,或停掉它",
    risk: "low",
    args: SteerArgs,
    permission: null,
    tool: {
      name: WORK_STEER_TOOL,
      description:
        "改一個工作車道上的任務(task 填 work_list 看到的代號):hint 補一句話讓它照著調整,goal 換目標(做到現在的會留著)," +
        "stop: true 停掉。改目標或補充不會多給它步數或時間。",
      properties: {
        task: { type: "string", description: "任務代號" },
        hint: { type: "string", description: "補充一句話" },
        goal: { type: "string", description: "新的目標" },
        stop: { type: "boolean", description: "停掉它" },
      },
      required: ["task"],
    },
    async execute(args, ctx) {
      const out = lane.steer(args.task, {
        hint: args.hint ?? null,
        goal: args.goal ?? null,
        stop: args.stop === true,
        why: ctx.request.why,
      });
      if (!out.ok) throw new CapabilityError(out.text);
      return out.text;
    },
  });
  return [start, list, steer] as Capability[];
}
