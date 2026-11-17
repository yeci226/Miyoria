// What of the Chat Completions request body is ours: the provider kinds, how reasoning levels
// are sent, and the last pass over the body the AI SDK wrote.

import type { JsonValue, ReasoningLevel } from "@miyoria/types";
import type { ImageDetail } from "../types.js";

/** The provider kinds `OpenAiFactory` builds. */
export const PROVIDER_KINDS = ["openai-compatible", "openai", "deepseek", "opencode"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Whether the kind speaks DeepSeek's dialect (`thinking`, `reasoning_content`). */
export function isDeepSeekKind(kind: ProviderKind): boolean {
  return kind === "deepseek" || kind === "opencode";
}

/** How a provider expresses reasoning levels (`OpenAiConfig.reasoning`). */
export interface ReasoningWire {
  /** Send `reasoning_effort` (APIs that have it). */
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

/** What the request needs in its body that the AI SDK has no option for. */
export interface BodyPatch {
  /** Top-level fields, written over the SDK's (`response_format`, the `thinking_off` fields). */
  fields: Record<string, JsonValue>;
  /** `detail` of every image part, in the order the images appear in the messages. */
  imageDetails: ImageDetail[];
}

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
 * The body that is sent: the SDK's (`raw`, JSON) with the patch applied. `tool_choice` is
 * dropped: a request never sets one, and the SDK's explicit `"auto"` is the API's default.
 */
export function finalBody(raw: string, patch: BodyPatch): string {
  const body = JSON.parse(raw) as Record<string, JsonValue>;
  delete body.tool_choice;
  Object.assign(body, patch.fields);
  if (patch.imageDetails.length > 0 && Array.isArray(body.messages)) {
    let image = 0;
    for (const part of body.messages.flatMap(contentParts)) {
      const url = part.type === "image_url" ? part.image_url : null;
      const detail = patch.imageDetails[image];
      if (!isRecord(url)) continue;
      if (detail !== undefined) url.detail = detail;
      image++;
    }
  }
  return bodyJson(body);
}

function contentParts(message: JsonValue): Record<string, JsonValue>[] {
  const content = isRecord(message) ? message.content : null;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
