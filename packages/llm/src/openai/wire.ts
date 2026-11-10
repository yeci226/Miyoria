// Chat Completions wire format.

import type { JsonValue, ReasoningLevel } from "@miyoria/types";
import { z } from "zod";
import type { ChatMessage, ChatRequest, ContentPart, Usage } from "../types.js";

/** How a provider expresses reasoning levels (`OpenAiConfig.reasoningEffort` and caps). */
export interface ReasoningWire {
  /** Send `reasoning_effort: "low" | "medium" | "high"` (APIs that have it). */
  effort: boolean;
  /**
   * Without `effort`: `max_tokens` cap per level, the stand-in for "think less" on APIs that
   * only have an on / off switch (`null`: no cap). Never raises a smaller `max_tokens`.
   */
  maxTokens: Readonly<Partial<Record<ReasoningLevel, number | null>>>;
}

/** Default caps of reasoning levels on on / off providers (`low` and `medium` think briefly). */
export const DEFAULT_REASONING_MAX_TOKENS: Readonly<Record<ReasoningLevel, number | null>> = {
  off: null,
  low: 2048,
  medium: 8192,
  high: null,
};

/** Half of a surrogate pair: what cutting text by UTF-16 units leaves of an emoji. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The body as JSON, with half emoji (a lone surrogate, left where some text was cut) dropped:
 * `JSON.stringify` writes one as an escape strict parsers (DeepSeek's) refuse with 400
 * "unexpected end of hex escape", failing the whole call.
 */
export function bodyJson(body: Record<string, JsonValue>): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    typeof value === "string" ? value.replace(LONE_SURROGATE, "") : value,
  );
}

/**
 * Request body. Only `content` / `tool_calls` are ever sent for assistant messages, so
 * reasoning output (e.g. DeepSeek `reasoning_content`) never goes back. The session id is
 * never part of the body.
 */
export function requestBody(
  req: ChatRequest,
  /** Merged into the body when `req.thinking === false` (the provider's switch). */
  thinkingOff: Readonly<Record<string, JsonValue>> | null = null,
  /** How `req.reasoning` is sent (`null`: not at all, only the on / off switch). */
  reasoning: ReasoningWire | null = null,
): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    model: req.model ?? "",
    messages: req.messages.map(wireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.max_tokens != null) body.max_tokens = req.max_tokens;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  if (req.json_mode) body.response_format = { type: "json_object" };
  if (req.thinking === false && thinkingOff) Object.assign(body, thinkingOff);
  const level = req.reasoning ?? null;
  if (reasoning !== null && level !== null && level !== "off" && req.thinking !== false) {
    if (reasoning.effort) {
      body.reasoning_effort = level;
    } else {
      const cap = reasoning.maxTokens[level] ?? null;
      if (cap !== null) {
        const asked = typeof body.max_tokens === "number" ? body.max_tokens : cap;
        body.max_tokens = Math.min(asked, cap);
      }
    }
  }
  return body;
}

function wireMessage(m: ChatMessage): Record<string, JsonValue> {
  const toolCalls =
    m.role === "assistant"
      ? m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }))
      : [];
  // `null` for assistant messages that only carry tool calls.
  const content: JsonValue =
    typeof m.content !== "string"
      ? m.content.map(wirePart)
      : m.content !== "" || toolCalls.length === 0
        ? m.content
        : null;
  const out: Record<string, JsonValue> = { role: m.role, content };
  if (m.name !== null) out.name = m.name;
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  if (m.role === "tool" && m.tool_call_id !== null) out.tool_call_id = m.tool_call_id;
  return out;
}

/** A content part as the API takes it (`alt` is ours and stays out). */
function wirePart(p: ContentPart): JsonValue {
  return p.type === "text"
    ? { type: "text", text: p.text }
    : { type: "image_url", image_url: { url: p.image_url.url, detail: p.image_url.detail } };
}

const opt = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const WireUsageSchema = z.object({
  prompt_tokens: opt(z.number()),
  completion_tokens: opt(z.number()),
  /** DeepSeek. */
  prompt_cache_hit_tokens: opt(z.number()),
  /** OpenAI. */
  prompt_tokens_details: opt(z.object({ cached_tokens: opt(z.number()) })),
  /** OpenAI, OpenRouter, DeepSeek reasoners. */
  completion_tokens_details: opt(z.object({ reasoning_tokens: opt(z.number()) })),
});

/** One streamed chunk; unknown fields are ignored. */
export const ChunkSchema = z.object({
  choices: opt(
    z.array(
      z.object({
        delta: opt(
          z.object({
            content: opt(z.string()),
            /** DeepSeek. */
            reasoning_content: opt(z.string()),
            /** OpenRouter and some local servers. */
            reasoning: opt(z.string()),
            tool_calls: opt(
              z.array(
                z.object({
                  index: opt(z.number()),
                  id: opt(z.string()),
                  function: opt(z.object({ name: opt(z.string()), arguments: opt(z.string()) })),
                }),
              ),
            ),
          }),
        ),
        finish_reason: opt(z.string()),
      }),
    ),
  ),
  usage: opt(WireUsageSchema),
  error: z.unknown().optional(),
});
export type Chunk = z.output<typeof ChunkSchema>;

export function wireUsage(u: z.output<typeof WireUsageSchema>): Usage {
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_prompt_tokens:
      u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
    ...(u.completion_tokens_details?.reasoning_tokens != null
      ? { reasoning_tokens: u.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}
