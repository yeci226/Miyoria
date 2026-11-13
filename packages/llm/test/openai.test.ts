// End-to-end tests against an in-process HTTP server returning canned SSE.

import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { MetricsRegistry } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantMessage,
  type ChatProvider,
  type ChatRequest,
  collectResponse,
  completeChat,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  LlmRouter,
  llmMetrics,
  MIYORIA_VERSION,
  OpenAiConfig,
  OpenAiFactory,
  OpenAiProvider,
  type ProviderConfig,
  ProviderConfigSchema,
  ProviderTimeoutError,
  parseModelRef,
  SseParser,
  type StreamEvent,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "../src/index.js";
import { bodyJson, requestBody } from "../src/openai/wire.js";

type Canned =
  /** SSE body, sent in pieces of `split` bytes. */
  | { kind: "sse"; body: string; split: number }
  | { kind: "status"; status: number; body: string; retryAfter?: string };

interface Recorded {
  headers: IncomingHttpHeaders;
  body: Record<string, JsonValue>;
}

class Server {
  hits = 0;
  readonly requests: Recorded[] = [];
  readonly #http: HttpServer;
  baseUrl = "";

  private constructor(readonly script: Canned[]) {
    this.#http = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        raw += c;
      });
      req.on("end", () => {
        void this.#respond(req.url ?? "", req.headers, raw, res);
      });
    });
  }

  async #respond(
    url: string,
    headers: IncomingHttpHeaders,
    raw: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const hit = this.hits++;
    this.requests.push({ headers, body: JSON.parse(raw) });
    const canned = this.script[Math.min(hit, this.script.length - 1)] as Canned;
    if (canned.kind === "status") {
      const h: Record<string, string> = { "content-type": "text/plain" };
      if (canned.retryAfter !== undefined) h["retry-after"] = canned.retryAfter;
      res.writeHead(canned.status, h).end(canned.body);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(canned.body, "utf8");
    for (let i = 0; i < bytes.length; i += canned.split) {
      await new Promise((r) => setTimeout(r, 2));
      res.write(bytes.subarray(i, i + canned.split));
    }
    res.end();
  }

  static async start(script: Canned[]): Promise<Server> {
    const server = new Server(script);
    await new Promise<void>((resolve) => server.#http.listen(0, "127.0.0.1", resolve));
    const { port } = server.#http.address() as AddressInfo;
    server.baseUrl = `http://127.0.0.1:${port}/v1/`;
    servers.push(server);
    return server;
  }

  provider(): OpenAiProvider {
    const config = new OpenAiConfig(this.baseUrl);
    config.apiKey = "sk-test-secret";
    config.retryBackoffMs = 10;
    config.headers["X-Title"] = "miyoria-tests";
    return new OpenAiProvider("test", config);
  }

  lastRequest(): Recorded {
    return this.requests.at(-1) as Recorded;
  }

  close(): Promise<void> {
    this.#http.closeAllConnections();
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function sse(chunks: JsonValue[], done: boolean, split: number): Canned {
  let body = ": keep-alive\n\n";
  for (const c of chunks) body += `data: ${JSON.stringify(c)}\r\n\r\n`;
  if (done) body += "data: [DONE]\n\n";
  return { kind: "sse", body, split };
}

const delta = (d: JsonValue): JsonValue => ({
  choices: [{ index: 0, delta: d, finish_reason: null }],
});

const finish = (reason: string, usage: JsonValue = null): JsonValue => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  usage,
});

const request = (): ChatRequest => ({
  model: "deepseek-chat",
  messages: [systemMessage("be cute"), userMessage("hi")],
});

async function events(provider: OpenAiProvider, req: ChatRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of await provider.stream(req)) out.push(ev);
  return out;
}

const okScript = (): Canned[] => [sse([delta({ content: "ok" }), finish("stop")], true, 64)];

function kindConfig(
  server: Server,
  kind: string,
  extra: Record<string, JsonValue> = {},
): ProviderConfig {
  return ProviderConfigSchema.parse({ kind, base_url: server.baseUrl, api_key: "k", ...extra });
}

const sessionRequest = (session: string | null): ChatRequest => ({ ...request(), session });

describe("SseParser", () => {
  it("handles_arbitrary_splits", () => {
    const input = Buffer.from(
      ': keep-alive\r\n\r\ndata: {"a":"你好"}\r\n\r\nevent: x\ndata: l1\ndata: l2\n\ndata: [DONE]',
      "utf8",
    );
    for (let step = 1; step <= input.length; step++) {
      const p = new SseParser();
      const got: string[] = [];
      for (let i = 0; i < input.length; i += step) got.push(...p.push(input.subarray(i, i + step)));
      got.push(...p.finish());
      expect(got, `step ${step}`).toEqual(['{"a":"你好"}', "l1\nl2", "[DONE]"]);
    }
  });
});

describe("wire", () => {
  it("serializes_request", () => {
    const req: ChatRequest = {
      model: "deepseek-chat",
      messages: [
        systemMessage("sys"),
        userMessage("hi", "owen"),
        assistantMessage("", [{ id: "call_1", name: "roll", arguments: '{"sides":6}' }]),
        toolResultMessage("call_1", "4"),
      ],
      tools: [{ name: "roll", description: "Roll a die", parameters: { type: "object" } }],
      temperature: 0.5,
      json_mode: true,
    };
    expect(requestBody(req)).toEqual({
      model: "deepseek-chat",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi", name: "owen" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "roll", arguments: '{"sides":6}' },
            },
          ],
        },
        { role: "tool", content: "4", tool_call_id: "call_1" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "roll", description: "Roll a die", parameters: { type: "object" } },
        },
      ],
      temperature: 0.5,
      response_format: { type: "json_object" },
    });
  });

  it("drops half emoji left by a cut, keeping whole ones", () => {
    const cut = "好喔🐟".slice(0, 3); // "好喔" + the first half of the fish
    const json = bodyJson(requestBody({ messages: [userMessage(`${cut}|\uDC1F|🐟`)] }));
    // No lone surrogate escape left for a strict parser to refuse.
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(JSON.parse(json).messages[0].content).toBe("好喔||🐟");
  });
});

describe("OpenAiProvider", () => {
  it("streams_text_split_across_chunk_boundaries", async () => {
    const server = await Server.start([
      sse(
        [
          delta({ role: "assistant", content: "" }),
          delta({ content: "你好," }),
          delta({ content: " world" }),
          delta({ content: "!" }),
          finish("stop"),
        ],
        true,
        7,
      ),
    ]);
    const evs = await events(server.provider(), request());
    const text = evs.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
    expect(text).toBe("你好, world!");
    expect(evs.at(-1)).toEqual({ type: "done", finish_reason: "stop", usage: null });

    const { headers, body } = server.lastRequest();
    expect(headers.authorization).toBe("Bearer sk-test-secret");
    expect(headers["x-title"]).toBe("miyoria-tests");
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect((body.messages as JsonValue[])[1]).toEqual({ role: "user", content: "hi" });
    for (const absent of ["temperature", "max_tokens", "stop", "tools", "response_format"]) {
      expect(body[absent], `${absent} should not be sent`).toBeUndefined();
    }
  });

  it("separates_deepseek_reasoning_content", async () => {
    const server = await Server.start([
      sse(
        [
          delta({ content: null, reasoning_content: "Let me " }),
          delta({ content: null, reasoning_content: "think." }),
          delta({ content: "Hello!", reasoning_content: null }),
          finish("stop"),
        ],
        true,
        16,
      ),
    ]);
    const resp = await completeChat(server.provider(), request());
    expect(resp.reasoning).toBe("Let me think.");
    expect(resp.text).toBe("Hello!");
  });

  it("assembles_tool_call_deltas", async () => {
    const call = (index: number, id: string | null, name: string | null, args: string) => {
      const fn: Record<string, JsonValue> = { arguments: args };
      if (name !== null) fn.name = name;
      const c: Record<string, JsonValue> = { index, function: fn };
      if (id !== null) {
        c.id = id;
        c.type = "function";
      }
      return delta({ tool_calls: [c] });
    };
    const server = await Server.start([
      sse(
        [
          call(0, "call_a", "roll", ""),
          call(0, null, null, '{"sides"'),
          call(1, "call_b", "weather", '{"city":'),
          call(0, null, null, ":20}"),
          call(1, null, null, '"Taipei"}'),
          finish("tool_calls"),
        ],
        true,
        11,
      ),
    ]);
    const req: ChatRequest = {
      ...request(),
      tools: [
        {
          name: "roll",
          description: "Roll a die",
          parameters: { type: "object", properties: { sides: { type: "integer" } } },
        },
      ],
      temperature: 0.25,
      max_tokens: 64,
      stop: ["\n\n"],
      json_mode: true,
    };
    const resp = await completeChat(server.provider(), req);
    expect(resp.finish_reason).toBe("tool_calls");
    expect(resp.tool_calls).toEqual([
      { id: "call_a", name: "roll", arguments: '{"sides":20}' },
      { id: "call_b", name: "weather", arguments: '{"city":"Taipei"}' },
    ]);
    const { body } = server.lastRequest();
    const tools = body.tools as { type: string; function: { name: string } }[];
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("roll");
    expect(body.temperature).toBe(0.25);
    expect(body.max_tokens).toBe(64);
    expect(body.stop).toEqual(["\n\n"]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("reports_usage_with_cached_tokens", async () => {
    // DeepSeek: usage on the finishing chunk.
    const deepseek = sse(
      [
        delta({ content: "hi" }),
        finish("stop", {
          prompt_tokens: 120,
          completion_tokens: 3,
          total_tokens: 123,
          prompt_cache_hit_tokens: 100,
          prompt_cache_miss_tokens: 20,
        }),
      ],
      true,
      9,
    );
    // OpenAI: usage in a separate trailing chunk with no choices.
    const openai = sse(
      [
        delta({ content: "hi" }),
        finish("length"),
        {
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 32 },
          },
        },
      ],
      true,
      13,
    );
    const server = await Server.start([deepseek, openai]);
    const provider = server.provider();

    const dones = (await events(provider, request())).filter((e) => e.type === "done");
    expect(dones).toEqual([
      {
        type: "done",
        finish_reason: "stop",
        usage: { prompt_tokens: 120, completion_tokens: 3, cached_prompt_tokens: 100 },
      },
    ]);

    const resp = await completeChat(provider, request());
    expect(resp.finish_reason).toBe("length");
    expect(resp.usage).toEqual({
      prompt_tokens: 50,
      completion_tokens: 8,
      cached_prompt_tokens: 32,
    });
  });

  it("retries_server_errors_before_streaming", async () => {
    const server = await Server.start([
      { kind: "status", status: 500, body: "boom" },
      { kind: "status", status: 429, body: "slow down", retryAfter: "0" },
      sse([delta({ content: "ok" }), finish("stop")], true, 64),
    ]);
    const resp = await completeChat(server.provider(), request());
    expect(resp.text).toBe("ok");
    expect(server.hits).toBe(3);
  });

  it("gives_up_after_max_retries", async () => {
    const server = await Server.start([{ kind: "status", status: 503, body: "overloaded" }]);
    await expect(server.provider().stream(request())).rejects.toThrow(/503/);
    expect(server.hits).toBe(3);
  });

  it("unauthorized_error_includes_status_and_body", async () => {
    const server = await Server.start([
      {
        kind: "status",
        status: 401,
        body: '{"error":{"message":"Authentication Fails (no such user)","type":"authentication_error"}}',
      },
    ]);
    const err = await server
      .provider()
      .stream(request())
      .catch((e: unknown) => e as Error);
    const msg = `${(err as Error).message} ${inspect(err)}`;
    expect(msg).toContain("401 Unauthorized");
    expect(msg).toContain("Authentication Fails");
    expect(msg).not.toContain("sk-test-secret");
    expect(server.hits, "4xx must not be retried").toBe(1);
  });

  it("truncated_stream_errors_without_retry", async () => {
    const server = await Server.start([sse([delta({ content: "hal" })], false, 64)]);
    const stream = await server.provider().stream(request());
    const it = stream[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: { type: "text_delta", text: "hal" }, done: false });
    await expect(it.next()).rejects.toThrow(/stream ended unexpectedly/);
    expect((await it.next()).done).toBe(true);
    expect(server.hits).toBe(1);
  });

  it("an error chunk or invalid JSON fails the stream", async () => {
    const server = await Server.start([
      sse([delta({ content: "a" }), { error: { message: "overloaded" } }], true, 64),
      { kind: "sse", body: "data: {not json}\n\n", split: 64 },
    ]);
    const provider = server.provider();
    await expect(collectResponse(await provider.stream(request()))).rejects.toThrow(
      /error in stream: .*overloaded/,
    );
    await expect(collectResponse(await provider.stream(request()))).rejects.toThrow(
      /invalid stream chunk/,
    );
  });

  it("can be cancelled with a signal", async () => {
    const server = await Server.start(okScript());
    const controller = new AbortController();
    controller.abort();
    await expect(server.provider().stream(request(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("factory_builds_from_provider_config", async () => {
    const server = await Server.start([sse([delta({ content: "hey" }), finish("stop")], true, 64)]);
    const config = ProviderConfigSchema.parse({
      kind: "deepseek",
      base_url: server.baseUrl,
      api_key: "sk-factory-secret",
      timeout_secs: 30,
      max_retries: 0,
      headers: { "X-Custom": "1" },
    });
    const factory = new OpenAiFactory();
    expect(factory.kinds).toContain("openai-compatible");
    const provider = factory.build("deepseek", config);
    expect(provider.name).toBe("deepseek");
    expect((await completeChat(provider, request())).text).toBe("hey");
    const { headers } = server.lastRequest();
    expect(headers.authorization).toBe("Bearer sk-factory-secret");
    expect(headers["x-custom"]).toBe("1");

    const parsed = OpenAiConfig.fromProviderConfig(config);
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.maxRetries).toBe(0);
    const shown = `${inspect(parsed)} ${JSON.stringify(parsed)} ${inspect(new OpenAiProvider("x", parsed))} ${String(provider)}`;
    expect(shown).not.toContain("sk-factory-secret");

    // Default endpoints and URL joining.
    const bare = (kind: string) => ProviderConfigSchema.parse({ kind, api_key: "k" });
    const url = (cfg: OpenAiConfig) => new OpenAiProvider("x", cfg).url;
    expect(url(OpenAiConfig.fromProviderConfig(bare("deepseek")))).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(url(OpenAiConfig.fromProviderConfig(bare("openai")))).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(url(new OpenAiConfig("http://localhost:11434/v1"))).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(() => factory.build("local", bare("openai-compatible"))).toThrow(/base_url/);
    expect(() =>
      factory.build(
        "bad",
        ProviderConfigSchema.parse({ kind: "openai", headers: { "bad name": "x" } }),
      ),
    ).toThrow("invalid header name `bad name`");
  });

  it("every_kind_sends_the_miyoria_user_agent", async () => {
    const expected = `miyoria/${MIYORIA_VERSION}`;
    expect(DEFAULT_USER_AGENT).toBe(expected);
    for (const kind of ["openai-compatible", "openai", "deepseek", "opencode"]) {
      const server = await Server.start(okScript());
      const provider = new OpenAiFactory().build(kind, kindConfig(server, kind));
      await completeChat(provider, request());
      expect(server.lastRequest().headers["user-agent"], kind).toBe(expected);
    }

    // Configurable; an explicit header wins over both.
    const server = await Server.start(okScript());
    let provider = new OpenAiFactory().build(
      "x",
      kindConfig(server, "openai-compatible", { user_agent: "my-bot/2.0" }),
    );
    await completeChat(provider, request());
    expect(server.lastRequest().headers["user-agent"]).toBe("my-bot/2.0");

    provider = new OpenAiFactory().build(
      "x",
      kindConfig(server, "openai-compatible", {
        user_agent: "my-bot/2.0",
        headers: { "User-Agent": "custom/3" },
      }),
    );
    await completeChat(provider, request());
    expect(server.lastRequest().headers["user-agent"]).toBe("custom/3");
  });

  it("session_header_only_when_configured_with_a_stable_fallback", async () => {
    // Not configured: never sent, even with a session.
    let server = await Server.start(okScript());
    let provider = new OpenAiFactory().build("a", kindConfig(server, "deepseek"));
    await completeChat(provider, sessionRequest("miyoria-x-1"));
    expect(server.lastRequest().headers["x-opencode-session"]).toBeUndefined();

    // Configured, custom name.
    server = await Server.start(okScript());
    provider = new OpenAiFactory().build(
      "b",
      kindConfig(server, "openai-compatible", { session_header: "X-Session" }),
    );
    await completeChat(provider, sessionRequest("miyoria-x-1"));
    expect(server.lastRequest().headers["x-session"]).toBe("miyoria-x-1");
    // Configured but the request has no session (doctor, background jobs): a fallback id that
    // stays the same for the provider's lifetime.
    await completeChat(provider, sessionRequest(null));
    const fallback = server.lastRequest().headers["x-session"];
    expect(fallback).toMatch(/^miyoria-[0-9a-f]{16}$/);
    await completeChat(provider, sessionRequest(null));
    expect(server.lastRequest().headers["x-session"]).toBe(fallback);
    // The session never ends up in the body.
    expect(server.lastRequest().body.session).toBeUndefined();
  });

  it("opencode_defaults", async () => {
    const cfg = OpenAiConfig.fromProviderConfig(
      ProviderConfigSchema.parse({ kind: "opencode", api_key: "k" }),
    );
    expect(cfg.baseUrl).toBe("https://opencode.ai/inference/go/v1");
    expect(cfg.sessionHeader).toBe("x-opencode-session");
    expect(new OpenAiProvider("oc", cfg).url).toBe(
      "https://opencode.ai/inference/go/v1/chat/completions",
    );

    // Missing or blank key is a clear error.
    for (const raw of [{ kind: "opencode" }, { kind: "opencode", api_key: "  " }]) {
      expect(() => new OpenAiFactory().build("opencode", ProviderConfigSchema.parse(raw))).toThrow(
        /api_key.*opencode/,
      );
    }

    // The session header can be switched off.
    const off = ProviderConfigSchema.parse({ kind: "opencode", api_key: "k", session_header: "" });
    expect(OpenAiConfig.fromProviderConfig(off).sessionHeader).toBeNull();

    // End to end against the mock (base_url override).
    const server = await Server.start(okScript());
    const provider = new OpenAiFactory().build("opencode", kindConfig(server, "opencode"));
    await completeChat(provider, sessionRequest("miyoria-deepseek-chan-0123456789abcdef"));
    const { headers } = server.lastRequest();
    expect(headers["x-opencode-session"]).toBe("miyoria-deepseek-chan-0123456789abcdef");
    expect(headers.authorization).toBe("Bearer k");

    // Other kinds still need no key.
    const local = ProviderConfigSchema.parse({
      kind: "openai-compatible",
      base_url: "http://x/v1",
    });
    expect(() => new OpenAiFactory().build("local", local)).not.toThrow();
  });
});

/** Accepts connections and reads requests but never answers. */
class HangingServer {
  hits = 0;
  /** Requests whose connection the client closed. */
  closed = 0;
  readonly #http: HttpServer;
  baseUrl = "";

  private constructor() {
    this.#http = createServer((req) => {
      this.hits++;
      req.resume();
      req.socket.on("close", () => {
        this.closed++;
      });
    });
  }

  static async start(): Promise<HangingServer> {
    const server = new HangingServer();
    await new Promise<void>((resolve) => server.#http.listen(0, "127.0.0.1", resolve));
    const { port } = server.#http.address() as AddressInfo;
    server.baseUrl = `http://127.0.0.1:${port}/v1/`;
    hanging.push(server);
    return server;
  }

  config(connectTimeoutMs: number, connectRetries = 0): OpenAiConfig {
    const config = new OpenAiConfig(this.baseUrl);
    config.connectTimeoutMs = connectTimeoutMs;
    config.timeoutMs = 10_000;
    config.maxRetries = 2;
    config.connectRetries = connectRetries;
    config.retryBackoffMs = 10;
    return config;
  }

  close(): Promise<void> {
    this.#http.closeAllConnections();
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }
}

const hanging: HangingServer[] = [];
afterEach(async () => {
  await Promise.all(hanging.splice(0).map((s) => s.close()));
});

describe("connect timeout", () => {
  it("aborts a server that never responds, without retrying", async () => {
    const server = await HangingServer.start();
    const provider = new OpenAiProvider("hang", server.config(150));
    const started = Date.now();
    const error = await provider.stream(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(error).toMatchObject({ phase: "connect" });
    expect(String((error as Error).message)).toMatch(
      /^hang: request failed: no response within 150 ms \(connect timeout\)$/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.hits).toBe(1);
    // The connection is closed, not left hanging.
    await expect.poll(() => server.closed).toBe(1);
  });

  it("retries a connect timeout the configured number of times, then gives up", async () => {
    const server = await HangingServer.start();
    const provider = new OpenAiProvider("hang", server.config(100, 1));
    const error = await provider.stream(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(server.hits).toBe(2);
  });

  it("a caller abort while waiting wins over the connect timeout", async () => {
    const server = await HangingServer.start();
    const provider = new OpenAiProvider("hang", server.config(5_000));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(provider.stream(request(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect.poll(() => server.closed).toBe(1);
  });

  it("does not limit a slow stream once the headers arrived", async () => {
    // Headers right away, the first token after 300 ms: longer than the connect timeout.
    const http = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => {
        res.end(`data: ${JSON.stringify(delta({ content: "slow" }))}\n\ndata: [DONE]\n\n`);
      }, 300);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const config = new OpenAiConfig(`http://127.0.0.1:${port}/v1`);
      config.connectTimeoutMs = 100;
      const response = await completeChat(new OpenAiProvider("slow", config), request());
      expect(response.text).toBe("slow");
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("is read from connect_timeout_secs and can be turned off", () => {
    const parse = (extra: Record<string, JsonValue>) =>
      OpenAiConfig.fromProviderConfig(
        ProviderConfigSchema.parse({ kind: "openai", api_key: "k", ...extra }),
      );
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(parse({}).connectTimeoutMs).toBe(15_000);
    expect(parse({ connect_timeout_secs: 3 }).connectTimeoutMs).toBe(3_000);
    expect(parse({ connect_timeout_secs: 0.5 }).connectTimeoutMs).toBe(500);
    expect(parse({ connect_timeout_secs: 0 }).connectTimeoutMs).toBe(0);
    expect(() => parse({ connect_timeout_secs: -1 })).toThrow(/invalid provider settings/);
    expect(JSON.parse(JSON.stringify(parse({})))).toMatchObject({ connectTimeoutMs: 15_000 });
  });

  it("triggers the purpose fallback and is counted", async () => {
    const hang = await HangingServer.start();
    const ok = await Server.start(okScript());
    const registry = new MetricsRegistry();
    const providers = new Map<string, ChatProvider>([
      ["hang", new OpenAiProvider("hang", hang.config(150))],
      ["ok", ok.provider()],
    ]);
    const router = new LlmRouter(
      providers,
      new Map([["chat", [parseModelRef("hang:m"), parseModelRef("ok:m")]]]),
      { metrics: registry },
    );
    const stream = await router.stream("chat", request());
    expect(stream.model).toBe("ok:m");
    expect((await collectResponse(stream)).text).toBe("ok");
    expect(stream.firstTokenMs).toBeGreaterThanOrEqual(150);
    const m = llmMetrics(registry);
    expect(
      m.errors.get({ model: "hang:m", purpose: "chat", stage: "request", kind: "connect_timeout" }),
    ).toBe(1);
    expect(m.calls.get({ model: "ok:m", purpose: "chat" })).toBe(1);
    expect(m.firstToken.count({ model: "ok:m", purpose: "chat" })).toBe(1);
    expect(hang.hits).toBe(1);
  });
});
