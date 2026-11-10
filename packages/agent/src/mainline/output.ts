// `TurnOutput` from one streaming response (docs/design/v3-architecture.md §10, §21).
//
// The model writes what she says as plain tagged text, which arrives first and is spoken while the
// rest is generated, and asks for actions with native tool calls in the same response. A commitment
// is a call of the `commit` pseudo tool and a steer one of `steer_task`: neither reaches the tool
// registry. A provider that only returns text still gives a valid output, so there is no JSON that
// can fail to parse on the hot path.

import { REQUEST_RULE } from "@miyoria/actions";
import type { ToolCall, ToolSpec } from "@miyoria/llm";
import {
  type ActionCall,
  type CommitmentDraft,
  type ContextKey,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type SaySegment,
  type TurnOutput,
} from "@miyoria/types";
import type { Expression } from "../expression.js";

export const COMMIT_TOOL = "commit";
export const STEER_TOOL = "steer_task";

export const COMMIT_SPEC: ToolSpec = {
  name: COMMIT_TOOL,
  description: "說了要做、但現在做不到的事,記下來。到期沒做,系統會提醒你。",
  parameters: {
    type: "object",
    properties: {
      what: { type: "string", description: "要做什麼,一句話" },
      tool: { type: "string", description: "之後要用的工具名稱(有的話)" },
      due_secs: { type: "integer", description: "幾秒內要做到" },
    },
    required: ["what"],
  },
};

export const STEER_SPEC: ToolSpec = {
  name: STEER_TOOL,
  description:
    "改變手上進行中任務的目標,保留進度。只在同一件事換目標或參數時用;不做了用停止工具,換別的事直接開新的。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "任務 id(「手上的任務」裡的)" },
      patch: { type: "object", description: "要改的目標參數" },
      why: { type: "string", description: "為什麼改,一句話" },
    },
    required: ["task", "patch", "why"],
  },
};

/** A tool's description is what she needs to pick it; details come back in its errors. */
function firstSentence(text: string): string {
  const end = text.search(/[。!?]/u);
  return end < 0 ? text : text.slice(0, end + 1);
}

/** An argument with the first clause of its description. */
function slimProperty(value: JsonValue): JsonValue {
  if (!isJsonObject(value) || typeof value.description !== "string") return value;
  // "(省略 = ...)" is what tells her to leave it out: without it she fills in any id she knows.
  if (value.description.includes("省略")) return value;
  return { ...value, description: value.description.split(/[,。;(]/u)[0] ?? "" };
}

/**
 * Ids a tool call must not take from the model. Inside a server the server is known, so a `guild`
 * that differs is a mistaken id, and the text channel she is talking in is never a voice channel.
 * Leaving them out means "here", which is what she meant.
 */
export function groundArgs(tool: string, args: JsonValue, key: ContextKey): JsonValue {
  if (!isJsonObject(args)) return args;
  const out: JsonObject = { ...args };
  if (key.scope !== null && typeof out.guild === "string" && out.guild !== key.scope) {
    delete out.guild;
  }
  if (tool === "voice_join" && out.channel === key.channel) delete out.channel;
  return out;
}

/**
 * A tool as the main line offers it. Every capability tool repeats that a request is only a request
 * and what `why` and `on_own` mean, about 150 characters each, 2000 over the tools of a normal
 * turn. The fixed rules say it once (`OUTPUT_RULES`), and the first sentence of what a tool does is
 * what she needs to pick it.
 */
export function slimTool(spec: ToolSpec): ToolSpec {
  const description = firstSentence(spec.description.replace(REQUEST_RULE, "").trim());
  const parameters = spec.parameters;
  if (!isJsonObject(parameters) || !isJsonObject(parameters.properties)) {
    return { ...spec, description };
  }
  const properties: JsonObject = {};
  for (const [name, value] of Object.entries(parameters.properties)) {
    properties[name] = slimProperty(value);
  }
  // Her reasons are in the decision she logs; `why` would only say them twice.
  delete properties.why;
  if (properties.on_own !== undefined) properties.on_own = { type: "boolean" };
  return { ...spec, description, parameters: { ...parameters, properties } };
}

/** Pseudo tools: part of the output, not something the tool registry runs. */
export function isPseudoTool(name: string): boolean {
  return name === COMMIT_TOOL || name === STEER_TOOL;
}

function commitment(call: ToolCall): CommitmentDraft | null {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
  } catch {
    return null;
  }
  if (typeof args !== "object" || args === null) return null;
  const { what, tool, due_secs: due } = args as Record<string, unknown>;
  if (typeof what !== "string" || what.trim() === "") return null;
  return {
    what: what.trim(),
    capability: typeof tool === "string" && tool.trim() !== "" ? tool.trim() : null,
    due_secs: typeof due === "number" && due > 0 ? due : null,
  };
}

/** The output of one response, `said` being what she said in it. */
export function turnOutput(
  expression: Expression,
  calls: readonly ToolCall[],
  said: readonly SaySegment[],
): TurnOutput {
  const actions: ActionCall[] = [];
  const commitments: CommitmentDraft[] = [];
  for (const call of calls) {
    if (call.name === COMMIT_TOOL) {
      const draft = commitment(call);
      if (draft !== null) commitments.push(draft);
    } else {
      actions.push({ id: call.id, tool: call.name, args: call.arguments });
    }
  }
  return {
    say: [...said],
    actions,
    commitments,
    // Only `<silence/>` is a decision. An empty response is a model that gave nothing.
    silence: expression.silence && said.length === 0,
  };
}
