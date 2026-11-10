// The work lane (docs/design/v4-plan.md §4.3): the second of the two lanes. The main line must stay
// short and answer people; anything that takes many steps (a question across three sources, a
// small program in her workspace, a game session) runs here instead, as a task with its own
// transcript, its own tools and its own budget, off the Floor.
//
// A task never speaks (§3 item 7, §15): it has no mouth and no tool that says something to
// someone. What it found goes back to the main line as a result, the way the hands' results do,
// and only the main line decides whether and how to tell anyone.
//
// Two kinds of task:
//
// * Tasks the main line starts (`work.start`): a goal in her words, a tool allowance (never more
//   than the Directives' filter offers where it was started), steps, time and tokens. The lane runs
//   the model with tools in a loop until it answers without calling one, gives up, is stopped or
//   runs out of budget. Its events are `worklane.task.*` (`taskTopic(WORK_OWNER, …)`), so it is in
//   her "what I am doing" state like any other task.
// * Tasks an owner drives step by step (`WorkLane.open`): the game director. The owner decides
//   when to think and what each step does; the lane keeps the transcript (what it saw, what it
//   tried, what came of it), counts the tokens and shows the task.

import type { JsonValue } from "./json.js";
import type { ContextKey } from "./platform.js";
import type { ReasoningLevel } from "./reasoning.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Task owner of the lane's own tasks (`worklane.task.started`, ...). */
export const WORK_OWNER = "worklane";

/** Capability that starts a task. */
export const WORK_START = "work.start";
/** Capability that lists the tasks. */
export const WORK_LIST = "work.list";
/** Capability that steers or stops a task. */
export const WORK_STEER = "work.steer";

/** Model purpose and `[llm.reasoning]` purpose of a task's calls. */
export const WORK_PURPOSE = "work";

/** How a task ended. */
export const WORK_ENDS = ["done", "gave_up", "stopped", "out_of_budget"] as const;

export type WorkEnd = (typeof WORK_ENDS)[number];

export type WorkState = "queued" | "running" | WorkEnd;

export function isWorkEnd(value: unknown): value is WorkEnd {
  return typeof value === "string" && (WORK_ENDS as readonly string[]).includes(value);
}

/** One task as the main line, the panel and her state see it. */
export interface WorkTaskView {
  id: string;
  /** `worklane` for the main line's tasks, the owner of a driven task (`game.minecraft`). */
  owner: string;
  /** What it is for, in her words. */
  goal: string;
  why: string;
  /** Whom it is for (a name), `null`: herself. */
  for: string | null;
  /** Where it was started (results are told there). */
  context: ContextKey | null;
  state: WorkState;
  /** Model calls made. */
  steps: number;
  /** Tool calls made. */
  calls: number;
  tokens: number;
  /** Tools it may call. */
  tools: string[];
  created_at: Timestamp;
  ended_at: Timestamp | null;
  /** Her conclusion (`done`), or why it ended otherwise. */
  result: string | null;
  /** What it did, a line per step (`查了「X」`, `讀了 example.org 的網頁`). */
  did: string[];
}

/** A task its owner drives one step at a time. */
export interface DrivenWorkSpec {
  owner: string;
  goal: string;
  /** Steps its transcript keeps (older ones fall out). */
  keep_steps: number;
}

/** One step of a driven task: one model call. */
export interface DrivenStep {
  /** The instructions (stable: the cached prefix). */
  system: string;
  /** What it sees now, in full, for this call. */
  user: string;
  /** What of `user` the transcript keeps for later steps (default: all of it). */
  kept?: string;
  /** Model purpose (`[llm.purposes]`). */
  purpose: string;
  json?: boolean;
  reasoning?: ReasoningLevel | null;
  temperature?: number | null;
  max_tokens?: number | null;
  session?: string | null;
  timeout_ms: number;
}

/** A message of a driven task's transcript. */
export interface WorkMessage {
  role: "user" | "assistant";
  content: string;
}

/** Thrown by `DrivenWork.step` when the task is over (ended, or out of budget). */
export class WorkEndedError extends Error {
  override readonly name = "WorkEndedError";

  constructor(
    readonly state: WorkEnd,
    message: string,
  ) {
    super(message);
  }
}

export interface DrivenWork {
  readonly id: string;
  /**
   * One step: what came of the last one (`result`) and `user` join the transcript, the model
   * answers, the answer is kept. Throws `WorkEndedError` once the task is over.
   */
  step(input: DrivenStep, signal?: AbortSignal): Promise<string>;
  /** What came of what it tried (the next step sees it first). */
  result(text: string): void;
  /** The transcript the next step builds on, oldest first. */
  transcript(): WorkMessage[];
  /** Ends it (the owner stopped, or reached its goal). Idempotent. */
  end(state: Exclude<WorkEnd, "out_of_budget">, detail: string): void;
  readonly ended: boolean;
}

/** Provided by the `agent` module. */
export interface WorkLane {
  /** Every task kept: running and queued first, then the newest ended. */
  tasks(): WorkTaskView[];
  /** Opens a task its owner drives (it never queues: the owner already decided to work). */
  open(spec: DrivenWorkSpec): DrivenWork;
  /**
   * What an owner learned and keeps across restarts (the director's skills when her skill store
   * is not running), in the settings store; `null` removes it. Resolves once it is written.
   */
  keep(owner: string, key: string, value: JsonValue | null): Promise<void>;
  /** What `keep` kept, or `null`. */
  kept(owner: string, key: string): Promise<JsonValue | null>;
}

export const WorkLaneKey = serviceKey<WorkLane>("WorkLane");
