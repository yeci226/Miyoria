// OpenAI-compatible Chat Completions provider (OpenAI, DeepSeek, OpenCode, OpenRouter, Ollama,
// vLLM, llama.cpp, LM Studio, ...).

import { randomBytes } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { inspect } from "node:util";
import { errorMessage, getLogger, isAbortError, sleep } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { ProviderConfig, ProviderFactory } from "../module.js";
import { noteProviderRetry } from "../trace.js";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmError,
  ProviderHttpError,
  ProviderTimeoutError,
  type StreamEvent,
  type Usage,
} from "../types.js";
import { MIYORIA_VERSION } from "../version.js";
import { SseParser } from "./sse.js";
import {
  bodyJson,
  ChunkSchema,
  DEFAULT_REASONING_MAX_TOKENS,
  type ReasoningWire,
  requestBody,
  wireUsage,
} from "./wire.js";

const log = getLogger("llm.openai");

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const OPENCODE_BASE_URL = "https://opencode.ai/inference/go/v1";
/** Header OpenCode reads the conversation id from. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
/** Identifies Miyoria (not the HTTP library) to every provider. */
export const DEFAULT_USER_AGENT = `miyoria/${MIYORIA_VERSION}`;
/** Default of `connect_timeout_secs`. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

const REDACTED = "<redacted>";

/** Settings for `OpenAiProvider`. Inspecting or JSON-serializing it redacts secrets. */
export class OpenAiConfig {
  /** API root; `/chat/completions` is appended as-is (no `/v1` is added). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer ...` when set. */
  apiKey: string | null = null;
  /** Extra request headers. */
  headers: Record<string, string> = {};
  /** `User-Agent` of every request. A `User-Agent` entry in `headers` takes precedence. */
  userAgent: string = DEFAULT_USER_AGENT;
  /**
   * Name of the header that carries `ChatRequest.session` (e.g. `x-opencode-session`). Nothing
   * is sent when `null` or when the request has no session.
   */
  sessionHeader: string | null = null;
  /**
   * Body fields that turn thinking off for requests with `thinking: false` (`null`: none).
   * `deepseek` and `opencode` default to `{"thinking": {"type": "disabled"}}`.
   */
  thinkingOff: Record<string, JsonValue> | null = null;
  /**
   * How reasoning levels (`[llm.reasoning]`) are sent: `effort` sends `reasoning_effort`
   * (default for `openai`); otherwise levels only switch thinking on and `maxTokens` caps the
   * length per level (`reasoning_effort` / `reasoning_max_tokens` in the provider settings).
   */
  reasoning: ReasoningWire = { effort: false, maxTokens: { ...DEFAULT_REASONING_MAX_TOKENS } };
  /** Max idle time while waiting for response bytes (headers or stream), in ms. */
  timeoutMs = 120_000;
  /**
   * Max time from sending a request to its response headers, in ms; `0` turns it off. Unlike
   * the idle timeout it is not retried, so a provider that hangs falls back to the next model
   * of the purpose quickly. Raise it for servers that only answer once the first token is
   * ready (e.g. Ollama loading a model).
   */
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  /** Retries for 429 / 5xx / network errors before the stream starts. */
  maxRetries = 2;
  /** First retry delay; doubles on every attempt unless `Retry-After` is sent. */
  retryBackoffMs = 500;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Reads `base_url`, `api_key` and the extras `timeout_secs`, `connect_timeout_secs`,
   * `max_retries`, `headers`, `user_agent` and `session_header`.
   *
   * `openai`, `deepseek` and `opencode` default `base_url` to the official endpoints.
   * `opencode` also requires an API key and defaults `session_header` to
   * `x-opencode-session` (set it to `""` to turn the header off).
   */
  static fromProviderConfig(config: ProviderConfig): OpenAiConfig {
    const parsed = ExtraSchema.safeParse(config.extra);
    if (!parsed.success) {
      throw new LlmError(`invalid provider settings: ${z.prettifyError(parsed.error)}`);
    }
    const extra = parsed.data;
    const url = config.base_url?.trim();
    let baseUrl: string;
    if (url) baseUrl = url;
    else if (config.kind === "openai") baseUrl = OPENAI_BASE_URL;
    else if (config.kind === "deepseek") baseUrl = DEEPSEEK_BASE_URL;
    else if (config.kind === "opencode") baseUrl = OPENCODE_BASE_URL;
    else throw new LlmError(`\`base_url\` is required for kind \`${config.kind}\``);

    const out = new OpenAiConfig(baseUrl);
    out.apiKey = config.api_key?.trim() ? config.api_key : null;
    out.headers = { ...(extra.headers ?? {}) };
    if (config.kind === "opencode" && out.apiKey === null) {
      throw new LlmError("`api_key` is required for kind `opencode`");
    }
    const ua = extra.user_agent?.trim();
    if (ua) out.userAgent = ua;
    if (extra.session_header != null) {
      out.sessionHeader = extra.session_header.trim() || null;
    } else if (config.kind === "opencode") {
      out.sessionHeader = OPENCODE_SESSION_HEADER;
    }
    if (extra.thinking_off !== undefined) {
      const off = extra.thinking_off;
      out.thinkingOff =
        off && Object.keys(off).length > 0 ? (off as Record<string, JsonValue>) : null;
    } else if (config.kind === "deepseek" || config.kind === "opencode") {
      out.thinkingOff = { thinking: { type: "disabled" } };
    }
    const effort = extra.reasoning_effort ?? config.kind === "openai";
    out.reasoning = {
      effort,
      maxTokens: { ...DEFAULT_REASONING_MAX_TOKENS, ...(extra.reasoning_max_tokens ?? {}) },
    };
    if (extra.timeout_secs != null) out.timeoutMs = extra.timeout_secs * 1000;
    if (extra.connect_timeout_secs != null) {
      out.connectTimeoutMs = extra.connect_timeout_secs * 1000;
    }
    if (extra.max_retries != null) out.maxRetries = extra.max_retries;
    return out;
  }

  /** Same fields with the API key and header values redacted. */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey === null ? null : REDACTED,
      headers: Object.keys(this.headers),
      userAgent: this.userAgent,
      sessionHeader: this.sessionHeader,
      thinkingOff: this.thinkingOff,
      reasoning: this.reasoning,
      timeoutMs: this.timeoutMs,
      connectTimeoutMs: this.connectTimeoutMs,
      maxRetries: this.maxRetries,
      retryBackoffMs: this.retryBackoffMs,
    };
  }

  [inspect.custom](): string {
    return `OpenAiConfig ${inspect(this.toJSON())}`;
  }
}

const ExtraSchema = z.object({
  timeout_secs: z.number().int().nonnegative().nullable().optional(),
  connect_timeout_secs: z.number().nonnegative().nullable().optional(),
  max_retries: z.number().int().nonnegative().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  user_agent: z.string().nullable().optional(),
  session_header: z.string().nullable().optional(),
  /** Body fields that turn thinking off; `{}` or null sends nothing. */
  thinking_off: z.record(z.string(), z.json()).nullable().optional(),
  /** Send `reasoning_effort` for reasoning levels (default: only for `openai`). */
  reasoning_effort: z.boolean().nullable().optional(),
  /** `max_tokens` cap per reasoning level when there is no `reasoning_effort`. */
  reasoning_max_tokens: z
    .object({
      low: z.number().int().positive().nullable().optional(),
      medium: z.number().int().positive().nullable().optional(),
      high: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

export interface OpenAiProviderOptions {
  /** `fetch` implementation (tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Streaming Chat Completions client for OpenAI-compatible APIs. */
export class OpenAiProvider implements ChatProvider {
  readonly name: string;
  /** Full request URL (`{base_url}/chat/completions`). */
  readonly url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #sessionHeader: string | null;
  readonly #thinkingOff: Record<string, JsonValue> | null;
  readonly #reasoning: ReasoningWire;
  /** Stable for the provider's lifetime, so background requests share one cache route. */
  readonly #fallbackSession = `miyoria-${randomBytes(8).toString("hex")}`;
  readonly #timeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  readonly #fetch: typeof fetch;

  /** Throws `LlmError` for invalid header names / values, user agent or API key. */
  constructor(name: string, config: OpenAiConfig, options: OpenAiProviderOptions = {}) {
    this.name = name;
    const headers: Record<string, string> = {};
    if (!HEADER_VALUE.test(config.userAgent)) throw new LlmError("invalid `user_agent`");
    headers["user-agent"] = config.userAgent;
    if (config.sessionHeader !== null && !TOKEN.test(config.sessionHeader)) {
      throw new LlmError(`invalid \`session_header\` name \`${config.sessionHeader}\``);
    }
    if (config.apiKey !== null) {
      const value = `Bearer ${config.apiKey}`;
      if (!HEADER_VALUE.test(value)) throw new LlmError("API key contains invalid characters");
      headers.authorization = value;
    }
    for (const [k, v] of Object.entries(config.headers)) {
      if (!TOKEN.test(k)) throw new LlmError(`invalid header name \`${k}\``);
      if (!HEADER_VALUE.test(v)) throw new LlmError(`invalid value for header \`${k}\``);
      headers[k.toLowerCase()] = v;
    }
    this.#headers = headers;
    this.#sessionHeader = config.sessionHeader?.toLowerCase() ?? null;
    this.#thinkingOff = config.thinkingOff;
    this.#reasoning = config.reasoning;
    this.#timeoutMs = config.timeoutMs;
    this.#connectTimeoutMs = config.connectTimeoutMs;
    this.#maxRetries = config.maxRetries;
    this.#retryBackoffMs = config.retryBackoffMs;
    this.#fetch = options.fetch ?? fetch;
    this.url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  toString(): string {
    return `OpenAiProvider(${this.name}, ${this.url})`;
  }

  [inspect.custom](): string {
    return `OpenAiProvider ${inspect({
      name: this.name,
      url: this.url,
      sessionHeader: this.#sessionHeader,
      maxRetries: this.#maxRetries,
    })}`;
  }

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    const body = bodyJson(requestBody(request, this.#thinkingOff, this.#reasoning));
    log.debug(
      { provider: this.name, model: request.model, url: this.url },
      "chat completion request",
    );
    const headers: Record<string, string> = {
      ...this.#headers,
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    const session = this.#sessionValue(request);
    if (this.#sessionHeader !== null && session !== null) headers[this.#sessionHeader] = session;
    const { response, idle } = await this.#send(body, headers, signal);
    return events(this.name, response, idle, signal);
  }

  /**
   * The session header value when one is configured: the request's id, or this provider's
   * fallback id for requests outside a conversation (doctor, memory consolidation, appraisal…)
   * since some providers (OpenCode) reject requests without one.
   */
  #sessionValue(request: ChatRequest): string | null {
    if (this.#sessionHeader === null) return null;
    if (request.session == null) return this.#fallbackSession;
    if (!HEADER_VALUE.test(request.session)) {
      log.warn({ provider: this.name }, "session id is not a valid header value, using fallback");
      return this.#fallbackSession;
    }
    return request.session;
  }

  #backoff(attempt: number): number {
    return Math.min(this.#retryBackoffMs * 2 ** attempt, MAX_BACKOFF_MS);
  }

  /**
   * Sends the request, retrying transient failures. Resolves once a 2xx response arrives,
   * i.e. before any of the stream is consumed. A connect timeout is not retried: it rejects
   * with `ProviderTimeoutError` so the router can try the next model.
   */
  async #send(
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; idle: IdleTimer }> {
    for (let attempt = 0; ; attempt++) {
      const idle = new IdleTimer(this.#timeoutMs);
      // Only runs until the headers arrive; the idle timer then guards the body alone.
      const connectMs = this.#connectTimeoutMs;
      const connect =
        connectMs > 0 ? new IdleTimer(connectMs, `no response within ${connectMs} ms`) : null;
      const signals = [idle.signal];
      if (connect) signals.push(connect.signal);
      if (signal) signals.push(signal);
      const fetchSignal = AbortSignal.any(signals);
      let response: Response;
      try {
        response = await this.#fetch(this.url, {
          method: "POST",
          headers,
          body,
          signal: fetchSignal,
        });
      } catch (error) {
        idle.clear();
        connect?.clear();
        if (signal?.aborted) throw signal.reason;
        if (connect?.signal.aborted) {
          throw new ProviderTimeoutError(
            `${this.name}: request failed: no response within ${connectMs} ms (connect timeout)`,
            "connect",
            { cause: error },
          );
        }
        if (attempt >= this.#maxRetries) {
          throw new LlmError(`${this.name}: request failed: ${describeFetchError(error)}`, {
            cause: error,
          });
        }
        const delay = this.#backoff(attempt);
        log.warn(
          { provider: this.name, err: describeFetchError(error), delay_ms: delay },
          "LLM request failed, retrying",
        );
        noteProviderRetry(describeFetchError(error));
        await sleep(delay, signal);
        continue;
      }
      idle.clear();
      connect?.clear();
      if (response.ok) return { response, idle };
      if (attempt < this.#maxRetries && isRetryable(response.status)) {
        const delay = retryAfterMs(response) ?? this.#backoff(attempt);
        await response.body?.cancel().catch(() => undefined);
        log.warn(
          { provider: this.name, status: response.status, delay_ms: delay },
          "LLM request failed, retrying",
        );
        noteProviderRetry(`HTTP ${response.status}`);
        await sleep(delay, signal);
        continue;
      }
      throw await httpError(this.name, response);
    }
  }
}

/** Aborts its signal (a `TimeoutError`) after `ms` without `reset()`. */
class IdleTimer {
  readonly #controller = new AbortController();
  readonly #ms: number;
  readonly #message: string;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number, message = `no data for ${ms} ms`) {
    this.#ms = ms;
    this.#message = message;
    this.reset();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  reset(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#controller.abort(new DOMException(this.#message, "TimeoutError"));
    }, this.#ms);
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
}

/** Like Rust's `StatusCode` display: `"401 Unauthorized"`. */
function statusText(status: number): string {
  return `${status} ${STATUS_CODES[status] ?? "<unknown status code>"}`;
}

async function httpError(provider: string, response: Response): Promise<ProviderHttpError> {
  const body = await response.text().catch(() => "");
  return new ProviderHttpError(
    `${provider}: HTTP ${statusText(response.status)}: ${snippet(body)}`,
    response.status,
  );
}

function describeFetchError(error: unknown): string {
  if (isAbortError(error)) return errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? `${errorMessage(error)} (${cause.message})` : errorMessage(error);
}

/** At most 500 characters, trimmed. */
function snippet(s: string): string {
  const chars = [...s.trim()];
  return chars.length > 500 ? `${chars.slice(0, 500).join("")}...` : chars.join("");
}

/** Turns the SSE byte stream into `StreamEvent`s, ending with exactly one `done` (or an error). */
async function* events(
  provider: string,
  response: Response,
  idle: IdleTimer,
  signal: AbortSignal | undefined,
): ChatStream {
  const state = { finishReason: null as string | null, usage: null as Usage | null };
  const parser = new SseParser();
  const body = response.body;
  if (!body) throw new LlmError(`${provider}: response has no body`);
  const reader = body.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      // The idle timeout only runs while waiting for bytes, not while the consumer is busy.
      idle.reset();
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new LlmError(`${provider}: stream interrupted: ${errorMessage(error)}`, {
          cause: error,
        });
      } finally {
        idle.clear();
      }
      const payloads = chunk.done ? parser.finish() : parser.push(chunk.value);
      for (const payload of payloads) {
        const result = handle(provider, payload, state);
        if (result === "done") {
          yield done(state);
          return;
        }
        yield* result;
      }
      if (chunk.done) {
        // Some servers omit `[DONE]`; accept a stream that reported how it finished.
        if (state.finishReason !== null || state.usage !== null) {
          yield done(state);
          return;
        }
        throw new LlmError(`${provider}: stream ended unexpectedly`);
      }
    }
  } finally {
    idle.clear();
    // Also after `[DONE]`: nothing after it matters.
    await reader.cancel().catch(() => undefined);
  }
}

function done(state: { finishReason: string | null; usage: Usage | null }): StreamEvent {
  return { type: "done", finish_reason: state.finishReason, usage: state.usage };
}

/** Events of one SSE payload, `"done"` for `[DONE]`; throws for invalid or error chunks. */
function handle(
  provider: string,
  raw: string,
  state: { finishReason: string | null; usage: Usage | null },
): StreamEvent[] | "done" {
  const payload = raw.trim();
  if (payload === "") return [];
  if (payload === "[DONE]") return "done";
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    throw new LlmError(
      `${provider}: invalid stream chunk (${errorMessage(error)}): ${snippet(payload)}`,
    );
  }
  const parsed = ChunkSchema.safeParse(json);
  if (!parsed.success) {
    throw new LlmError(
      `${provider}: invalid stream chunk (${z.prettifyError(parsed.error)}): ${snippet(payload)}`,
    );
  }
  const chunk = parsed.data;
  if (chunk.error != null) {
    throw new LlmError(`${provider}: error in stream: ${JSON.stringify(chunk.error)}`);
  }
  if (chunk.usage) state.usage = wireUsage(chunk.usage);
  const out: StreamEvent[] = [];
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) out.push({ type: "reasoning_delta", text: reasoning });
      if (delta.content) out.push({ type: "text_delta", text: delta.content });
      for (const call of delta.tool_calls ?? []) {
        out.push({
          type: "tool_call_delta",
          index: call.index ?? 0,
          id: call.id ?? null,
          name: call.function?.name ?? null,
          arguments: call.function?.arguments ?? "",
        });
      }
    }
    if (choice.finish_reason != null) state.finishReason = choice.finish_reason;
  }
  return out;
}

/** Handles the provider kinds `openai-compatible`, `openai`, `deepseek` and `opencode`. */
export class OpenAiFactory implements ProviderFactory {
  static readonly KINDS = ["openai-compatible", "openai", "deepseek", "opencode"] as const;
  readonly kinds: readonly string[] = OpenAiFactory.KINDS;

  build(name: string, config: ProviderConfig): ChatProvider {
    try {
      return new OpenAiProvider(name, OpenAiConfig.fromProviderConfig(config));
    } catch (error) {
      throw new LlmError(`provider \`${name}\`: ${errorMessage(error)}`, { cause: error });
    }
  }
}
