// Provider-agnostic structured output. Not every model has a JSON mode, and models that do may
// still wrap the object in prose or code fences, so a structured call always:
//
// 1. describes the JSON shape in the prompt (the caller's job) and sets `json_mode` only as a
//    hint; a provider that rejects the hint (HTTP 400 / 415 / 422) is asked again without it;
// 2. extracts the first JSON object from the reply (`extractJsonObject`: the whole text, fenced
//    blocks, then balanced `{ … }` spans in the surrounding prose);
// 3. validates it with a zod schema;
// 4. on failure asks once more, feeding back the concrete problems, then gives up
//    (`StructuredOutputError`) so the caller applies nothing. A reply cut off at `max_tokens`
//    (`finish_reason: "length"`) is not fed back (any `{ … }` found in it is a fragment); the
//    request is asked again with twice the token budget and a request to keep it short.

import type { z } from "zod";
import { withLlmTag } from "./trace.js";
import {
  assistantMessage,
  type ChatRequest,
  type ChatResponse,
  ProviderHttpError,
  userMessage,
} from "./types.js";

/** Statuses a provider answers with when it does not support `json_mode`. */
const JSON_MODE_REJECTED: ReadonlySet<number> = new Set([400, 415, 422]);
const MAX_ISSUES = 8;
const TRUNCATED = "回覆太長,還沒寫完就被截斷了;請寫得更精簡。";

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";

  constructor(
    message: string,
    /** What was wrong with the last reply. */
    readonly issues: string[],
    /** Calls made. */
    readonly attempts: number,
  ) {
    super(message);
  }
}

/** Anything that completes a request for a purpose (the `LlmRouter`). */
export interface Completer {
  complete(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Balanced `{ … }` spans of `text` (string literals respected), in order. */
function objectSpans(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * The first JSON object in a model's reply: the whole text, a fenced block (```json … ```), or
 * a balanced `{ … }` span in surrounding prose. `null` when there is none.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole.ok && isObject(whole.value)) return whole.value;
  for (const m of trimmed.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g)) {
    const inner = tryParse((m[1] ?? "").trim());
    if (inner.ok && isObject(inner.value)) return inner.value;
  }
  for (const span of objectSpans(trimmed)) {
    const parsed = tryParse(span);
    if (parsed.ok && isObject(parsed.value)) return parsed.value;
  }
  return null;
}

/** Zod issues as short lines (`agenda.0.text: expected string`). */
export function issueLines(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_ISSUES).map((i) => {
    const path = i.path.map(String).join(".");
    return path === "" ? i.message : `${path}: ${i.message}`;
  });
}

export interface StructuredOptions {
  /** Retries after an unusable reply (default 1). */
  repairs?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  /** The last response (usage of the final call). */
  response: ChatResponse;
  attempts: number;
  /** Prompt + completion tokens of every call. */
  tokens: number;
}

async function call(
  router: Completer,
  purpose: string,
  request: ChatRequest,
  signal: AbortSignal | undefined,
): Promise<ChatResponse> {
  try {
    return await router.complete(purpose, request, signal);
  } catch (error) {
    // The hint is optional: a provider without JSON mode gets the same request without it.
    if (request.json_mode && error instanceof ProviderHttpError) {
      if (JSON_MODE_REJECTED.has(error.status)) {
        return router.complete(purpose, { ...request, json_mode: false }, signal);
      }
    }
    throw error;
  }
}

/**
 * Completes `request` and returns its JSON object validated by `schema` (see the module
 * comment). Provider errors are thrown as they are; unusable replies after the repair retry
 * throw `StructuredOutputError`.
 */
export async function completeJson<S extends z.ZodType>(
  router: Completer,
  purpose: string,
  request: ChatRequest,
  schema: S,
  options: StructuredOptions = {},
): Promise<StructuredResult<z.output<S>>> {
  const repairs = Math.max(0, options.repairs ?? 1);
  let messages = request.messages;
  let maxTokens = request.max_tokens;
  let tokens = 0;
  let issues: string[] = [];
  for (let attempt = 1; attempt <= repairs + 1; attempt++) {
    const req = { ...request, messages, max_tokens: maxTokens };
    const response = await (attempt > 1
      ? withLlmTag({ repair: attempt - 1 }, () => call(router, purpose, req, options.signal))
      : call(router, purpose, req, options.signal));
    if (response.usage) tokens += response.usage.prompt_tokens + response.usage.completion_tokens;
    const cut = response.finish_reason === "length";
    const raw = extractJsonObject(response.text);
    if (raw === null) {
      issues = [cut ? TRUNCATED : "回覆裡沒有 JSON 物件(或 JSON 格式錯誤)"];
    } else {
      const parsed = schema.safeParse(raw);
      if (parsed.success) return { value: parsed.data, response, attempts: attempt, tokens };
      issues = cut ? [TRUNCATED] : issueLines(parsed.error);
    }
    if (attempt > repairs) {
      throw new StructuredOutputError(
        `unusable structured reply: ${issues.join("; ")}${cut ? ` (max_tokens=${maxTokens ?? "default"})` : ""}`,
        issues,
        attempt,
      );
    }
    if (cut) {
      if (typeof maxTokens === "number") maxTokens *= 2;
      messages = [...request.messages, userMessage(`${TRUNCATED}\n只回傳一個 JSON 物件。`)];
      continue;
    }
    messages = [
      ...messages,
      assistantMessage([...response.text].slice(0, 4000).join("")),
      userMessage(
        `上面的回覆不能用:\n${issues.map((i) => `- ${i}`).join("\n")}\n請修正後只回傳一個 JSON 物件,不要加其他文字。`,
      ),
    ];
  }
  throw new StructuredOutputError("unreachable", issues, repairs + 1);
}
