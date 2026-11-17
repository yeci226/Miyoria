// A tool's spec as she is offered it: the text every capability repeats left out, the rest within
// the limits of `ToolLimits`.

import { REQUEST_RULE } from "@miyoria/gate/actions";
import type { ToolSpec } from "@miyoria/llm/llm";
import { isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";

/** How much of a tool's text is offered. */
export interface ToolLimits {
  /** Characters of the description (0: no limit). */
  description: number;
  /** Characters of one argument's description (0: no limit). */
  argument: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = { description: 600, argument: 200 };

/** Where a sentence or a clause of a tool's text may end. */
const SENTENCE_ENDS = ["。", "!", "?", "!", "?", ";", ";"];

/**
 * `text` within `max` characters: whole sentences while they fit, else cut short with `…`. A tool
 * is offered whole (v4 §4.2): the first sentence alone left out what an argument means, when to
 * use it and what comes back, and she guessed (V3 cut it for an old 4,000-token target).
 */
export function upToSentence(text: string, max: number): string {
  const chars = [...text];
  if (max <= 0 || chars.length <= max) return text;
  const head = chars.slice(0, max).join("");
  const end = Math.max(...SENTENCE_ENDS.map((p) => head.lastIndexOf(p)));
  return end > 0 ? head.slice(0, end + 1) : `${chars.slice(0, Math.max(max - 1, 1)).join("")}…`;
}

/** An argument with its description within `max`. */
function slimProperty(value: JsonValue, max: number): JsonValue {
  if (!isJsonObject(value) || typeof value.description !== "string") return value;
  // "(省略 = ...)" is what tells her to leave it out: without it she fills in any id she knows.
  if (value.description.includes("省略")) return value;
  return { ...value, description: upToSentence(value.description, max) };
}

/**
 * A tool as she is offered it. Every capability tool repeats that a request is only a request and
 * what `why` and `on_own` mean, about 150 characters each, 2000 over the tools of a run: the fixed
 * rules say it once. The rest of what a tool says is offered whole, each part within `limits`.
 *
 * A registered spec does not change (a tool that changes registers a new one), so the slim one is
 * kept per spec and limits instead of being rebuilt for every tool on every run. Treat the result
 * as read-only: it is shared.
 */
export function slimTool(spec: ToolSpec, limits: ToolLimits = DEFAULT_TOOL_LIMITS): ToolSpec {
  const key = `${limits.description}:${limits.argument}`;
  const kept = SLIM.get(spec);
  if (kept?.key === key) return kept.slim;
  const slim = slimNow(spec, limits);
  SLIM.set(spec, { key, slim });
  return slim;
}

const SLIM = new WeakMap<ToolSpec, { key: string; slim: ToolSpec }>();

function slimNow(spec: ToolSpec, limits: ToolLimits): ToolSpec {
  const description = upToSentence(
    spec.description.replace(REQUEST_RULE, "").trim(),
    limits.description,
  );
  const parameters = spec.parameters;
  if (!isJsonObject(parameters) || !isJsonObject(parameters.properties)) {
    return { ...spec, description };
  }
  const properties: JsonObject = {};
  for (const [name, value] of Object.entries(parameters.properties)) {
    properties[name] = slimProperty(value, limits.argument);
  }
  // Her reasons are in the decision she logs; `why` would only say them twice.
  delete properties.why;
  if (properties.on_own !== undefined) properties.on_own = { type: "boolean" };
  return { ...spec, description, parameters: { ...parameters, properties } };
}
