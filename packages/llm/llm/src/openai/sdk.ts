// The one file that touches the Vercel AI SDK: a `ChatRequest` becomes one `streamText` step
// (no retries, no tool execution, no second step), and the step's parts become `StreamEvent`s.
// Retries, timeouts and the request headers stay in `provider.ts`, behind the `fetch` it passes.

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { errorMessage } from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  TypeValidationError,
  tool,
} from "ai";
import {
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  contentText,
  type StreamEvent,
  type Usage,
} from "../types.js";
import { type BodyPatch, isDeepSeekKind, type ProviderKind, type ReasoningWire } from "./wire.js";

// The SDK prints its call warnings (an option a model ignores, ...) to the console by default.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

/** The name `createOpenAICompatible` is given, which is also its `providerOptions` key. */
const COMPATIBLE = "openaiCompatible";
const DEEPSEEK = "deepseek";

/** Image URLs go to the API as they are; the SDK must never download one. */
const IMAGE_URLS = { "image/*": [/^https?:\/\/.*$/i] };

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/** Where and how a step is sent: the provider's settings and this request's headers. */
export interface StepTarget {
  kind: ProviderKind;
  /** API root without a trailing slash. */
  baseUrl: string;
  apiKey: string | null;
  /** Headers of every request of the provider. */
  headers: Readonly<Record<string, string>>;
  /** Headers of this request (the session header). */
  requestHeaders: Readonly<Record<string, string>>;
  thinkingOff: Readonly<Record<string, JsonValue>> | null;
  reasoning: ReasoningWire;
}

/** One attempt at sending a prepared step. */
export interface StepAttempt {
  /** Sends the HTTP request the SDK built. */
  fetch: typeof fetch;
  /** Whether the response body ended with `[DONE]` (the SDK does not say). */
  sawDone: () => boolean;
}

export interface PreparedStep {
  /** What the attempt's `fetch` has to write into the body. */
  patch: BodyPatch;
  /**
   * Sends the step. The stream ends with exactly one `done` or throws a `StepError`; nothing is
   * sent before the first `next()`.
   */
  open(attempt: StepAttempt): AsyncGenerator<StreamEvent, void, undefined>;
}

/** Why a step failed, in terms `provider.ts` maps to `LlmError`s. */
export type StepFailure =
  /** A non-2xx response. */
  | { kind: "http"; status: number; headers: Record<string, string>; body: string }
  /** The abort signal fired. */
  | { kind: "aborted" }
  /** A stream chunk that is not valid JSON or not a completion chunk. */
  | { kind: "chunk"; reason: string; payload: string }
  /** An error object sent in the stream. */
  | { kind: "provider"; detail: string }
  /** The stream ended without saying how it finished. */
  | { kind: "ended" }
  /** Anything else (`cause`): the request could not be built or sent, the body broke off. */
  | { kind: "other" };

export class StepError extends Error {
  override name = "StepError";

  constructor(
    readonly failure: StepFailure,
    options?: ErrorOptions,
  ) {
    super(`step failed: ${failure.kind}`, options);
  }
}

/** Converts `request` once; every attempt then sends the same step. */
export function prepareStep(
  target: StepTarget,
  request: ChatRequest,
  signal?: AbortSignal,
): PreparedStep {
  const deepseek = isDeepSeekKind(target.kind);
  const key = deepseek ? DEEPSEEK : COMPATIBLE;
  const thinkingOff = request.thinking === false ? target.thinkingOff : null;
  const options: Record<string, JsonValue> = {};
  // DeepSeek's provider has to know thinking is off, or it leaves `temperature` out.
  if (deepseek && thinkingOff && isDisabled(thinkingOff.thinking)) {
    options.thinking = { type: "disabled" };
  }
  let maxTokens = request.max_tokens ?? null;
  const level = request.reasoning ?? null;
  if (level !== null && level !== "off" && request.thinking !== false) {
    if (target.reasoning.effort) {
      // DeepSeek has `low | high | max` and takes `medium` as `high`.
      options.reasoningEffort = deepseek && level === "medium" ? "high" : level;
    } else {
      const cap = target.reasoning.maxTokens[level] ?? null;
      if (cap !== null) maxTokens = Math.min(maxTokens ?? cap, cap);
    }
  }
  const fields: Record<string, JsonValue> = { ...thinkingOff };
  // Written by us, not through the SDK's options: DeepSeek's provider drops `temperature`
  // whenever it takes thinking to be on, and answers JSON mode by adding a system message.
  if (request.temperature != null) fields.temperature = request.temperature;
  if (request.json_mode) fields.response_format = { type: "json_object" };
  const patch: BodyPatch = { fields, imageDetails: imageDetails(request.messages) };

  const specs = request.tools ?? [];
  const tools: ToolSet = Object.fromEntries(
    specs.map((t) => [
      t.name,
      // No `execute`: the SDK reports the call and stops.
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
  const messages = modelMessages(request.messages, key);
  const stop = request.stop ?? [];

  return {
    patch,
    open: (attempt) =>
      events(
        streamText({
          model: model(target, request.model ?? "", attempt.fetch),
          messages,
          allowSystemInMessages: true,
          ...(specs.length > 0 ? { tools, toolOrder: specs.map((t) => t.name) } : {}),
          ...(maxTokens !== null ? { maxOutputTokens: maxTokens } : {}),
          ...(stop.length > 0 ? { stopSequences: stop } : {}),
          ...(Object.keys(options).length > 0 ? { providerOptions: { [key]: options } } : {}),
          headers: { ...target.requestHeaders },
          ...(signal ? { abortSignal: signal } : {}),
          maxRetries: 0,
          // Errors reach us as `error` parts; the default handler prints them.
          onError: () => undefined,
        }).fullStream,
        attempt.sawDone,
      ),
  };
}

function model(target: StepTarget, id: string, fetch: typeof globalThis.fetch): LanguageModel {
  const headers = { ...target.headers };
  if (isDeepSeekKind(target.kind)) {
    // An empty key keeps the SDK from reading `DEEPSEEK_API_KEY` out of the environment.
    return createDeepSeek({ baseURL: target.baseUrl, apiKey: target.apiKey ?? "", headers, fetch })(
      id,
    );
  }
  return createOpenAICompatible({
    name: COMPATIBLE,
    baseURL: target.baseUrl,
    ...(target.apiKey !== null ? { apiKey: target.apiKey } : {}),
    headers,
    fetch,
    includeUsage: true,
    supportedUrls: () => IMAGE_URLS,
  })(id);
}

function isDisabled(thinking: JsonValue | undefined): boolean {
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    !Array.isArray(thinking) &&
    thinking.type === "disabled"
  );
}

function imageDetails(messages: readonly ChatMessage[]): BodyPatch["imageDetails"] {
  return messages.flatMap((m) =>
    m.role !== "user" || typeof m.content === "string"
      ? []
      : m.content.flatMap((p) => (p.type === "image_url" ? [p.image_url.detail] : [])),
  );
}

/**
 * Our messages as the SDK's. A tool result takes its tool's name from the assistant call it
 * answers; reasoning goes back as a reasoning part (`reasoning_content` on the wire).
 */
export function modelMessages(messages: readonly ChatMessage[], key: string): ModelMessage[] {
  /** Tool name by call id, from the assistant messages so far. */
  const toolNames = new Map<string, string>();
  return messages.map((m) => modelMessage(m, key, toolNames));
}

function modelMessage(m: ChatMessage, key: string, toolNames: Map<string, string>): ModelMessage {
  const named = m.name !== null ? { providerOptions: { [key]: { name: m.name } } } : {};
  switch (m.role) {
    case "system":
      return { role: "system", content: contentText(m.content), ...named };
    case "user": {
      // The compatible provider reads the name of a one-part message from the part.
      if (typeof m.content === "string") {
        const content =
          m.name !== null ? [{ type: "text" as const, text: m.content, ...named }] : m.content;
        return { role: "user", content, ...named };
      }
      return { role: "user", content: m.content.map(userPart), ...named };
    }
    case "assistant": {
      for (const call of m.tool_calls) toolNames.set(call.id, call.name);
      const text = contentText(m.content);
      const reasoning = m.reasoning ?? "";
      if (reasoning === "" && m.tool_calls.length === 0) {
        return { role: "assistant", content: text, ...named };
      }
      return {
        role: "assistant",
        content: [
          ...(reasoning !== "" ? [{ type: "reasoning" as const, text: reasoning }] : []),
          ...(text !== "" ? [{ type: "text" as const, text }] : []),
          ...m.tool_calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: toolInput(call.arguments),
          })),
        ],
        ...named,
      };
    }
    case "tool": {
      const id = m.tool_call_id ?? "";
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: toolNames.get(id) ?? "unknown",
            output: { type: "text", value: contentText(m.content) },
          },
        ],
      };
    }
  }
}

/**
 * The arguments the model wrote, parsed. Arguments that are not JSON go back as `{}`: the model
 * was already told about them in the call's result.
 */
function toolInput(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return {};
  }
}

function userPart(
  p: ContentPart,
): Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number] {
  if (p.type === "text") return { type: "text", text: p.text };
  const url = p.image_url.url;
  const data = DATA_URL.exec(url);
  if (data) {
    return {
      type: "file",
      mediaType: data[1] as string,
      data: { type: "data", data: data[2] as string },
    };
  }
  // Only the provider's own check reads the subtype of a URL; the URL is sent as it is.
  const extension = IMAGE_EXTENSION.exec(url.split(/[?#]/, 1)[0] ?? "")?.[1]?.toLowerCase();
  const subtype = extension === undefined ? "png" : extension === "jpg" ? "jpeg" : extension;
  return { type: "file", mediaType: `image/${subtype}`, data: { type: "url", url: new URL(url) } };
}

/**
 * The step's parts as `StreamEvent`s. A tool call's fragments carry the index of the call (in
 * the order the calls started); the first has its id and name, the rest only arguments.
 */
async function* events(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  sawDone: () => boolean,
): AsyncGenerator<StreamEvent, void, undefined> {
  const calls = new Map<string, number>();
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  try {
    for await (const part of parts) {
      switch (part.type) {
        case "text-delta":
          if (part.text !== "") yield { type: "text_delta", text: part.text };
          break;
        case "reasoning-delta":
          if (part.text !== "") yield { type: "reasoning_delta", text: part.text };
          break;
        case "tool-input-start": {
          const index = calls.size;
          calls.set(part.id, index);
          yield {
            type: "tool_call_delta",
            index,
            id: part.id,
            name: part.toolName,
            arguments: "",
          };
          break;
        }
        case "tool-input-delta": {
          const index = calls.get(part.id);
          if (index !== undefined && part.delta !== "") {
            yield { type: "tool_call_delta", index, id: null, name: null, arguments: part.delta };
          }
          break;
        }
        case "error":
          // The compatible provider's word for a stream without a finish reason; whether that
          // is a failure is decided at the end, as for DeepSeek's.
          if (!isMissingFinishReason(part.error)) throw stepError(part.error);
          break;
        case "abort":
          throw new StepError({ kind: "aborted" });
        case "finish-step":
          usage = usageOf(part.usage);
          finishReason = part.rawFinishReason ?? null;
          break;
        case "finish":
          // Some servers omit the finish reason; a stream that reported its usage or ended
          // with `[DONE]` is complete all the same.
          if (finishReason === null && usage === null && !sawDone()) {
            throw new StepError({ kind: "ended" });
          }
          yield { type: "done", finish_reason: finishReason, usage };
          return;
        default:
          break;
      }
    }
  } catch (error) {
    throw error instanceof StepError ? error : stepError(error);
  }
  throw new StepError({ kind: "ended" });
}

function isMissingFinishReason(error: unknown): boolean {
  return InvalidResponseDataError.isInstance(error) && /finish reason/i.test(error.message);
}

function stepError(error: unknown): StepError {
  if (APICallError.isInstance(error) && error.statusCode != null) {
    return new StepError(
      {
        kind: "http",
        status: error.statusCode,
        headers: error.responseHeaders ?? {},
        body: error.responseBody ?? "",
      },
      { cause: error },
    );
  }
  if (JSONParseError.isInstance(error)) {
    return new StepError(
      { kind: "chunk", reason: errorMessage(error.cause), payload: error.text },
      { cause: error },
    );
  }
  if (TypeValidationError.isInstance(error)) {
    return new StepError(
      { kind: "chunk", reason: errorMessage(error.cause), payload: JSON.stringify(error.value) },
      { cause: error },
    );
  }
  // An error chunk: DeepSeek's provider wraps it (`data` is the chunk), the compatible one
  // wraps it too or passes the object on.
  if (error instanceof Error && error.name === "AI_StreamProviderError") {
    const data = (error as { data?: unknown }).data;
    return new StepError(
      { kind: "provider", detail: JSON.stringify(data ?? error.message) },
      { cause: error },
    );
  }
  if (typeof error === "object" && error !== null && !(error instanceof Error)) {
    return new StepError({ kind: "provider", detail: JSON.stringify(error) }, { cause: error });
  }
  return new StepError({ kind: "other" }, { cause: error });
}

/**
 * Usage as the server reported it (`null`: not at all). Cached and reasoning tokens are read
 * from the server's own numbers where the SDK kept them: it reports `0` for a count the server
 * left out, and the compatible provider does not know DeepSeek's `prompt_cache_hit_tokens`.
 */
function usageOf(usage: LanguageModelUsage): Usage | null {
  const raw = usage.raw;
  if (raw === undefined) {
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
    const reasoning = usage.outputTokenDetails.reasoningTokens;
    return {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      cached_prompt_tokens: usage.inputTokenDetails.cacheReadTokens ?? null,
      ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
    };
  }
  const cached =
    count(raw.prompt_cache_hit_tokens) ?? count(field(raw.prompt_tokens_details, "cached_tokens"));
  const reasoning = count(field(raw.completion_tokens_details, "reasoning_tokens"));
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    cached_prompt_tokens: cached,
    ...(reasoning !== null ? { reasoning_tokens: reasoning } : {}),
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
