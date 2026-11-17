// OpenAI-compatible Chat Completions provider (OpenAI, DeepSeek, OpenCode, OpenRouter, Ollama,
// vLLM, llama.cpp, LM Studio, ...), on the Vercel AI SDK's providers (`sdk.ts`).

import { randomBytes } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { inspect } from "node:util";
import { errorMessage, getLogger, isAbortError, sleep } from "@miyoria/runtime/kernel";
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
} from "../types.js";
import { MIYORIA_VERSION } from "../version.js";
import { prepareStep, StepError } from "./sdk.js";
import {
  type BodyPatch,
  DEFAULT_REASONING_MAX_TOKENS,
  finalBody,
  isDeepSeekKind,
  PROVIDER_KINDS,
  type ProviderKind,
  type ReasoningWire,
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
  /**
   * Which dialect is spoken: `deepseek` and `opencode` use the AI SDK's DeepSeek provider, the
   * others its OpenAI-compatible one.
   */
  kind: ProviderKind = "openai-compatible";
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
   * (default for `openai` and `opencode`, never capping `max_tokens`); otherwise levels only
   * switch thinking on and `maxTokens` caps the length per level, answer included
   * (`reasoning_effort` / `reasoning_max_tokens` in the provider settings).
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
  /**
   * Retries of a connect timeout (a dropped or stalled connection is often fine a moment later;
   * 11-11 night, 294 turns failed on one). Each waits another `connectTimeoutMs`.
   */
  connectRetries = 1;
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
    const kind = PROVIDER_KINDS.find((k) => k === config.kind);
    if (kind !== undefined) out.kind = kind;
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
    } else if (isDeepSeekKind(out.kind)) {
      out.thinkingOff = { thinking: { type: "disabled" } };
    }
    // OpenCode's DeepSeek models take `reasoning_effort` next to the `thinking` switch (its
    // model list: effort `low | high | max`; DeepSeek maps `medium` to `high`). Without it a
    // level could only cap `max_tokens`, which counts the reasoning too and cut answers.
    const effort =
      extra.reasoning_effort ?? (config.kind === "openai" || config.kind === "opencode");
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
      kind: this.kind,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey === null ? null : REDACTED,
      headers: Object.keys(this.headers),
      userAgent: this.userAgent,
      sessionHeader: this.sessionHeader,
      thinkingOff: this.thinkingOff,
      reasoning: this.reasoning,
      timeoutMs: this.timeoutMs,
      connectTimeoutMs: this.connectTimeoutMs,
      connectRetries: this.connectRetries,
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
  /** Send `reasoning_effort` for reasoning levels (default: `openai` and `opencode`). */
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

/** What one attempt's `fetch` saw, for the retry rules and the error messages. */
class Sent {
  /** Whether the request left (`false`: the SDK failed before sending it). */
  called = false;
  /** Whether no response came within the connect timeout. */
  connectTimedOut = false;
  /** What `fetch` threw. */
  fetchError: unknown;
  /** What reading the response body threw. */
  bodyError: unknown;
  /** Settles once a 2xx response arrived. */
  readonly responded: Promise<void>;
  #respond: () => void = () => undefined;
  #body: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #tail = "";

  constructor() {
    this.responded = new Promise((resolve) => {
      this.#respond = resolve;
    });
  }

  /** A 2xx response arrived; `body` is what reads it. */
  respond(body: ReadableStreamDefaultReader<Uint8Array>): void {
    this.#body = body;
    this.#respond();
  }

  /**
   * Stops reading the response, which closes the connection. The SDK keeps its stream open
   * when its consumer leaves, so the body is ended here.
   */
  close(): void {
    void this.#body?.cancel().catch(() => undefined);
  }

  /** Keeps the end of the body, where `[DONE]` is. */
  note(bytes: Uint8Array): void {
    const end = bytes.subarray(-64);
    const text = Buffer.from(end.buffer, end.byteOffset, end.byteLength).toString("latin1");
    this.#tail = (this.#tail + text).slice(-64);
  }

  sawDone(): boolean {
    return this.#tail.includes("[DONE]");
  }
}

const RESPONDED = Symbol("responded");

/**
 * Streaming Chat Completions client for OpenAI-compatible APIs. The AI SDK's providers write
 * the request and read the stream (`sdk.ts`); this class sends it: headers, timeouts, retries.
 */
export class OpenAiProvider implements ChatProvider {
  readonly name: string;
  /** Full request URL (`{base_url}/chat/completions`). */
  readonly url: string;
  readonly #kind: ProviderKind;
  readonly #baseUrl: string;
  readonly #apiKey: string | null;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #sessionHeader: string | null;
  readonly #thinkingOff: Record<string, JsonValue> | null;
  readonly #reasoning: ReasoningWire;
  /** Stable for the provider's lifetime, so background requests share one cache route. */
  readonly #fallbackSession = `miyoria-${randomBytes(8).toString("hex")}`;
  readonly #timeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #connectRetries: number;
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
    this.#kind = config.kind;
    this.#apiKey = config.apiKey;
    this.#headers = headers;
    this.#sessionHeader = config.sessionHeader?.toLowerCase() ?? null;
    this.#thinkingOff = config.thinkingOff;
    this.#reasoning = config.reasoning;
    this.#timeoutMs = config.timeoutMs;
    this.#connectTimeoutMs = config.connectTimeoutMs;
    this.#connectRetries = config.connectRetries;
    this.#maxRetries = config.maxRetries;
    this.#retryBackoffMs = config.retryBackoffMs;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.url = `${this.#baseUrl}/chat/completions`;
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

  /**
   * Sends the request, retrying transient failures. Resolves once a 2xx response arrives,
   * i.e. before any of the stream is consumed. A connect timeout is retried `connectRetries`
   * times, then rejects with `ProviderTimeoutError` so the router can try the next model.
   */
  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    log.debug(
      { provider: this.name, model: request.model, url: this.url },
      "chat completion request",
    );
    const session = this.#sessionValue(request);
    const step = prepareStep(
      {
        kind: this.#kind,
        baseUrl: this.#baseUrl,
        apiKey: this.#apiKey,
        headers: this.#headers,
        requestHeaders:
          this.#sessionHeader !== null && session !== null
            ? { [this.#sessionHeader]: session }
            : {},
        thinkingOff: this.#thinkingOff,
        reasoning: this.#reasoning,
      },
      request,
      signal,
    );
    let connectAttempt = 0;
    for (let attempt = 0; ; attempt++) {
      const sent = new Sent();
      const events = step.open({
        fetch: (_input, init) => this.#send(sent, step.patch, init),
        sawDone: () => sent.sawDone(),
      });
      const first = events.next();
      // Read again by `#events`; a rejection in between must not count as unhandled.
      first.catch(() => undefined);
      let error: unknown;
      try {
        // Nothing is streamed before the response arrives: `first` only wins by failing.
        await Promise.race([sent.responded.then(() => RESPONDED), first]);
        return this.#events(events, first, sent, signal);
      } catch (caught) {
        error = caught;
      }
      await events.return(undefined).catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      const failure = error instanceof StepError ? error.failure : null;
      if (failure?.kind === "aborted") throw abortError();
      if (sent.connectTimedOut) {
        if (connectAttempt < this.#connectRetries) {
          connectAttempt++;
          const delay = this.#backoff(attempt);
          log.warn({ provider: this.name, delay_ms: delay }, "LLM connect timed out, retrying");
          noteProviderRetry("connect timeout");
          await sleep(delay, signal);
          continue;
        }
        throw new ProviderTimeoutError(
          `${this.name}: request failed: no response within ${this.#connectTimeoutMs} ms (connect timeout)`,
          "connect",
          { cause: sent.fetchError },
        );
      }
      if (failure?.kind === "http") {
        if (attempt < this.#maxRetries && isRetryable(failure.status)) {
          const delay = retryAfterMs(failure.headers) ?? this.#backoff(attempt);
          log.warn(
            { provider: this.name, status: failure.status, delay_ms: delay },
            "LLM request failed, retrying",
          );
          noteProviderRetry(`HTTP ${failure.status}`);
          await sleep(delay, signal);
          continue;
        }
        throw new ProviderHttpError(
          `${this.name}: HTTP ${statusText(failure.status)}: ${snippet(failure.body)}`,
          failure.status,
        );
      }
      const cause = sent.fetchError ?? (error instanceof StepError ? error.cause : error);
      // A request the SDK could not build fails the same way every time.
      if (!sent.called || attempt >= this.#maxRetries) {
        throw new LlmError(`${this.name}: request failed: ${describeFetchError(cause)}`, { cause });
      }
      const delay = this.#backoff(attempt);
      log.warn(
        { provider: this.name, err: describeFetchError(cause), delay_ms: delay },
        "LLM request failed, retrying",
      );
      noteProviderRetry(describeFetchError(cause));
      await sleep(delay, signal);
    }
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
   * The `fetch` of one attempt: sends what the SDK built, with the body patched and the
   * headers set to ours (the SDK appends its own name to `User-Agent` and sends an empty
   * `Authorization` for a provider without a key). The connect timeout runs until the response
   * headers arrive, the idle timeout whenever bytes are awaited.
   */
  async #send(sent: Sent, patch: BodyPatch, init: RequestInit | undefined): Promise<Response> {
    sent.called = true;
    const headers = Object.fromEntries(new Headers(init?.headers));
    delete headers.authorization;
    Object.assign(headers, this.#headers, { accept: "text/event-stream" });
    const body = finalBody(String(init?.body ?? "{}"), patch);
    const idle = new IdleTimer(this.#timeoutMs);
    const connectMs = this.#connectTimeoutMs;
    const connect =
      connectMs > 0 ? new IdleTimer(connectMs, `no response within ${connectMs} ms`) : null;
    const signals = [idle.signal];
    if (connect) signals.push(connect.signal);
    if (init?.signal) signals.push(init.signal);
    let response: Response;
    try {
      response = await this.#fetch(this.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      sent.connectTimedOut = connect?.signal.aborted ?? false;
      sent.fetchError = error;
      throw error;
    } finally {
      idle.clear();
      connect?.clear();
    }
    if (!response.ok || response.body === null) return response;
    const reader = response.body.getReader();
    sent.respond(reader);
    return new Response(guarded(reader, idle, sent), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** The stream of an attempt whose response arrived, with its failures as `LlmError`s. */
  async *#events(
    events: AsyncGenerator<StreamEvent, void, undefined>,
    first: Promise<IteratorResult<StreamEvent, void>>,
    sent: Sent,
    signal: AbortSignal | undefined,
  ): ChatStream {
    try {
      for (let next = first; ; next = events.next()) {
        let result: IteratorResult<StreamEvent, void>;
        try {
          result = await next;
        } catch (error) {
          throw this.#streamError(error, sent, signal);
        }
        if (result.done) return;
        yield result.value;
      }
    } finally {
      sent.close();
      await events.return(undefined).catch(() => undefined);
    }
  }

  #streamError(error: unknown, sent: Sent, signal: AbortSignal | undefined): unknown {
    if (signal?.aborted) return signal.reason;
    const failure = error instanceof StepError ? error.failure : null;
    switch (failure?.kind) {
      case "aborted":
        return abortError();
      case "ended":
        return new LlmError(`${this.name}: stream ended unexpectedly`);
      case "chunk":
        return new LlmError(
          `${this.name}: invalid stream chunk (${failure.reason}): ${snippet(failure.payload)}`,
        );
      case "provider":
        return new LlmError(`${this.name}: error in stream: ${failure.detail}`);
      default: {
        const cause = sent.bodyError ?? (error instanceof StepError ? error.cause : error);
        return new LlmError(`${this.name}: stream interrupted: ${errorMessage(cause)}`, { cause });
      }
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

/**
 * The response body, read one chunk per read of the consumer: the idle timeout only runs while
 * waiting for bytes, not while the consumer is busy.
 */
function guarded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idle: IdleTimer,
  sent: Sent,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        idle.reset();
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          sent.note(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          sent.bodyError = error;
          controller.error(error);
        } finally {
          idle.clear();
        }
      },
      async cancel(reason) {
        idle.clear();
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers["retry-after"]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
}

/** Status code and reason phrase: `"401 Unauthorized"`. */
function statusText(status: number): string {
  return `${status} ${STATUS_CODES[status] ?? "<unknown status code>"}`;
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

/** Handles the provider kinds `openai-compatible`, `openai`, `deepseek` and `opencode`. */
export class OpenAiFactory implements ProviderFactory {
  static readonly KINDS = PROVIDER_KINDS;
  readonly kinds: readonly string[] = OpenAiFactory.KINDS;

  build(name: string, config: ProviderConfig): ChatProvider {
    try {
      return new OpenAiProvider(name, OpenAiConfig.fromProviderConfig(config));
    } catch (error) {
      throw new LlmError(`provider \`${name}\`: ${errorMessage(error)}`, { cause: error });
    }
  }
}
