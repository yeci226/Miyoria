// End-to-end tests against an in-process HTTP server returning canned SSE.

import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { MetricsRegistry } from "@miyoria/runtime/kernel";
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
  LlmError,
  LlmRouter,
  llmMetrics,
  MIYORIA_VERSION,
  OpenAiConfig,
  OpenAiFactory,
  OpenAiProvider,
  type ProviderConfig,
  ProviderConfigSchema,
  ProviderHttpError,
  ProviderTimeoutError,
  parseModelRef,
  type StreamEvent,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "../src/index.js";
import { modelMessages } from "../src/openai/sdk.js";
import { sendRequest, wireBody } from "./support.js";

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

function deepseekConfig(): OpenAiConfig {
  return OpenAiConfig.fromProviderConfig(
    ProviderConfigSchema.parse({
      kind: "opencode",
      base_url: "http://provider.invalid/v1",
      api_key: "k",
    }),
  );
}

describe("stream parsing", () => {
  it("handles_arbitrary_splits", async () => {
    const input = Buffer.from(
      [
        ": keep-alive\r\n\r\n",
        `data: ${JSON.stringify(delta({ content: "你好" }))}\r\n\r\n`,
        `event: x\ndata: ${JSON.stringify(delta({ content: "🐟!" }))}\n\n`,
        `data: ${JSON.stringify(finish("stop"))}\n\n`,
        "data: [DONE]",
      ].join(""),
      "utf8",
    );
    // Bytes may be split anywhere, also inside a UTF-8 sequence.
    for (let step = 1; step <= input.length; step++) {
      const fake: typeof fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < input.length; i += step) {
                controller.enqueue(new Uint8Array(input.subarray(i, i + step)));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      const provider = new OpenAiProvider("test", new OpenAiConfig("http://provider.invalid/v1"), {
        fetch: fake,
      });
      const response = await completeChat(provider, request());
      expect(response.text, `step ${step}`).toBe("你好🐟!");
      expect(response.finish_reason, `step ${step}`).toBe("stop");
    }
  });
});

describe("wire", () => {
  it("serializes_request", async () => {
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
    expect(await wireBody(req)).toEqual({
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

  it("drops half emoji left by a cut, keeping whole ones", async () => {
    const cut = "好喔🐟".slice(0, 3); // "好喔" + the first half of the fish
    const { json } = await sendRequest({ messages: [userMessage(`${cut}|\uDC1F|🐟`)] });
    // No lone surrogate escape left for a strict parser to refuse.
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(JSON.parse(json).messages[0].content).toBe("好喔||🐟");
  });

  it("deepseek_kinds_serialize_the_same_request", async () => {
    const req: ChatRequest = {
      model: "deepseek-v4.1-flash",
      messages: [
        systemMessage("sys"),
        userMessage("hi", "owen"),
        assistantMessage("", [{ id: "call_1", name: "roll", arguments: '{"sides":6}' }]),
        toolResultMessage("call_1", "4"),
      ],
      tools: [
        { name: "roll", description: "Roll a die", parameters: { type: "object" } },
        { name: "ask", description: "Ask", parameters: { type: "object" } },
      ],
      temperature: 0.5,
      max_tokens: 64,
      stop: ["\n\n"],
      json_mode: true,
    };
    const body = await wireBody(req, deepseekConfig());
    // JSON mode is the body field alone: no message is added to the prompt.
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi", name: "owen" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "roll", arguments: '{"sides":6}' } },
        ],
      },
      { role: "tool", content: "4", tool_call_id: "call_1" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
    // Tools keep the order they were given in.
    expect((body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([
      "roll",
      "ask",
    ]);
    // Sent although the model may think: the SDK's DeepSeek provider would leave it out.
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(64);
    expect(body.stop).toEqual(["\n\n"]);
    expect(body.tool_choice).toBeUndefined();
  });
});

describe("conversation history", () => {
  const call = { id: "call_1", name: "roll", arguments: '{"sides":6}' };
  const history = (reasoning: string | null): ChatRequest => ({
    model: "deepseek-v4.1-flash",
    messages: [
      userMessage("roll"),
      { ...assistantMessage("", [call]), reasoning },
      toolResultMessage("call_1", "4"),
    ],
  });
  const assistant = (body: Record<string, JsonValue>) =>
    (body.messages as Record<string, JsonValue>[])[1] as Record<string, JsonValue>;

  it("sends_the_reasoning_of_an_assistant_message_back", async () => {
    for (const config of [deepseekConfig(), new OpenAiConfig("http://provider.invalid/v1")]) {
      const sent = assistant(await wireBody(history("She asked for a d6."), config));
      expect(sent.reasoning_content, config.kind).toBe("She asked for a d6.");
      expect(sent.tool_calls, config.kind).toHaveLength(1);
    }
    // Without reasoning: DeepSeek's thinking models want the field all the same, empty.
    expect(assistant(await wireBody(history(null), deepseekConfig())).reasoning_content).toBe("");
    expect(assistant(await wireBody(history(""), deepseekConfig())).reasoning_content).toBe("");
    expect("reasoning_content" in assistant(await wireBody(history(null)))).toBe(false);
  });

  it("tool_arguments_that_are_not_json_go_back_as_an_empty_object", async () => {
    for (const config of [deepseekConfig(), new OpenAiConfig("http://provider.invalid/v1")]) {
      for (const bad of ['{"sides":', "", "{sides: 6}", "six"]) {
        const req = history(null);
        (req.messages[1] as { tool_calls: { arguments: string }[] }).tool_calls = [
          { ...call, arguments: bad },
        ];
        const sent = assistant(await wireBody(req, config));
        expect(sent.tool_calls, `${config.kind} ${bad}`).toEqual([
          { id: "call_1", type: "function", function: { name: "roll", arguments: "{}" } },
        ]);
      }
    }
  });

  it("a_tool_result_is_named_after_the_call_it_answers", async () => {
    const messages = [
      userMessage("roll"),
      assistantMessage("", [call, { id: "call_2", name: "weather", arguments: "{}" }]),
      toolResultMessage("call_2", "sunny"),
      toolResultMessage("call_1", "4"),
      // No call with this id came before it.
      toolResultMessage("call_9", "?"),
    ];
    const results = modelMessages(messages, "deepseek").flatMap((m) =>
      m.role === "tool" ? m.content : [],
    );
    expect(results).toMatchObject([
      { toolCallId: "call_2", toolName: "weather", output: { type: "text", value: "sunny" } },
      { toolCallId: "call_1", toolName: "roll", output: { type: "text", value: "4" } },
      { toolCallId: "call_9", toolName: "unknown", output: { type: "text", value: "?" } },
    ]);
    // Each result is still its own message on the wire.
    for (const config of [deepseekConfig(), new OpenAiConfig("http://provider.invalid/v1")]) {
      const body = await wireBody({ model: "m", messages }, config);
      expect((body.messages as JsonValue[]).slice(2), config.kind).toEqual([
        { role: "tool", tool_call_id: "call_2", content: "sunny" },
        { role: "tool", tool_call_id: "call_1", content: "4" },
        { role: "tool", tool_call_id: "call_9", content: "?" },
      ]);
    }
  });

  it("keeps_empty_and_repeated_messages_one_to_one", async () => {
    const messages = [
      systemMessage("a"),
      userMessage("u1"),
      userMessage(""),
      assistantMessage(""),
      systemMessage("b"),
      assistantMessage("x"),
      assistantMessage("y"),
    ];
    for (const config of [deepseekConfig(), new OpenAiConfig("http://provider.invalid/v1")]) {
      const body = await wireBody({ model: "deepseek-chat", messages }, config);
      expect(
        (body.messages as { role: string; content: string }[]).map((m) => [m.role, m.content]),
        config.kind,
      ).toEqual([
        ["system", "a"],
        ["user", "u1"],
        ["user", ""],
        ["assistant", ""],
        ["system", "b"],
        ["assistant", "x"],
        ["assistant", "y"],
      ]);
    }
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

describe("AI SDK transport", () => {
  const deepseek = (server: Server, extra: Record<string, JsonValue> = {}) =>
    new OpenAiFactory().build("ds", kindConfig(server, "deepseek", extra)) as OpenAiProvider;

  it("tool_call_fragments_carry_the_index_and_only_the_first_the_id_and_name", async () => {
    const call = (index: number, id: string | null, name: string | null, args: string) =>
      delta({
        tool_calls: [
          {
            index,
            ...(id !== null ? { id, type: "function" } : {}),
            function: { ...(name !== null ? { name } : {}), arguments: args },
          },
        ],
      });
    const script = () =>
      sse(
        [
          delta({ reasoning_content: "hm" }),
          delta({ content: "好" }),
          call(0, "call_a", "roll", ""),
          call(0, null, null, '{"sides"'),
          call(1, "call_b", "weather", '{"city":'),
          call(0, null, null, ":20}"),
          call(1, null, null, '"Taipei"}'),
          finish("tool_calls"),
        ],
        true,
        11,
      );
    const tools = [{ name: "roll", description: "Roll a die", parameters: { type: "object" } }];
    for (const kind of ["deepseek", "openai-compatible"]) {
      const server = await Server.start([script()]);
      const provider = new OpenAiFactory().build(kind, kindConfig(server, kind)) as OpenAiProvider;
      const evs = await events(provider, { ...request(), tools });
      expect(evs, kind).toEqual([
        { type: "reasoning_delta", text: "hm" },
        { type: "text_delta", text: "好" },
        { type: "tool_call_delta", index: 0, id: "call_a", name: "roll", arguments: "" },
        { type: "tool_call_delta", index: 0, id: null, name: null, arguments: '{"sides"' },
        { type: "tool_call_delta", index: 1, id: "call_b", name: "weather", arguments: "" },
        { type: "tool_call_delta", index: 1, id: null, name: null, arguments: '{"city":' },
        { type: "tool_call_delta", index: 0, id: null, name: null, arguments: ":20}" },
        { type: "tool_call_delta", index: 1, id: null, name: null, arguments: '"Taipei"}' },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ]);
    }
  });

  it("arguments_cut_off_by_the_length_limit_still_arrive", async () => {
    const server = await Server.start([
      sse(
        [
          delta({
            tool_calls: [{ index: 0, id: "c1", function: { name: "roll", arguments: '{"si' } }],
          }),
          finish("length"),
        ],
        true,
        64,
      ),
    ]);
    const resp = await completeChat(deepseek(server), request());
    expect(resp.finish_reason).toBe("length");
    expect(resp.tool_calls).toEqual([{ id: "c1", name: "roll", arguments: '{"si' }]);
  });

  it("maps_usage_with_cached_and_reasoning_tokens", async () => {
    const deepseekUsage = {
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 25 },
    };
    const openaiUsage = {
      prompt_tokens: 50,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 32 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    const plain = { prompt_tokens: 7, completion_tokens: 2 };
    for (const kind of ["deepseek", "openai-compatible"]) {
      const server = await Server.start(
        [deepseekUsage, openaiUsage, plain].map((usage) =>
          sse([delta({ content: "hi" }), finish("stop", usage)], true, 64),
        ),
      );
      const provider = new OpenAiFactory().build(kind, kindConfig(server, kind));
      expect((await completeChat(provider, request())).usage, kind).toStrictEqual({
        prompt_tokens: 120,
        completion_tokens: 40,
        cached_prompt_tokens: 100,
        reasoning_tokens: 25,
      });
      expect((await completeChat(provider, request())).usage, kind).toStrictEqual({
        prompt_tokens: 50,
        completion_tokens: 8,
        cached_prompt_tokens: 32,
        reasoning_tokens: 0,
      });
      // What the server did not report stays unknown instead of becoming 0.
      expect((await completeChat(provider, request())).usage, kind).toStrictEqual({
        prompt_tokens: 7,
        completion_tokens: 2,
        cached_prompt_tokens: null,
      });
    }
  });

  it("waits_as_long_as_retry_after_says_before_retrying_a_429", async () => {
    const server = await Server.start([
      { kind: "status", status: 429, body: "slow down", retryAfter: "1" },
      ...okScript(),
    ]);
    const started = Date.now();
    const resp = await completeChat(deepseek(server), request());
    expect(resp.text).toBe("ok");
    expect(server.hits).toBe(2);
    // Far above the backoff (500 ms, the first retry's).
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("a_500_after_the_retries_is_a_provider_http_error", async () => {
    for (const kind of ["deepseek", "openai-compatible"]) {
      const server = await Server.start([{ kind: "status", status: 500, body: "boom" }]);
      const config = OpenAiConfig.fromProviderConfig(kindConfig(server, kind, { max_retries: 1 }));
      config.retryBackoffMs = 5;
      const error = await new OpenAiProvider("p", config)
        .stream(request())
        .catch((e: unknown) => e);
      expect(error, kind).toBeInstanceOf(ProviderHttpError);
      expect(error, kind).toMatchObject({
        status: 500,
        message: "p: HTTP 500 Internal Server Error: boom",
      });
      expect(server.hits, kind).toBe(2);
    }
  });

  it("an_unreachable_server_is_retried_then_a_plain_llm_error", async () => {
    let calls = 0;
    const refused: typeof fetch = async () => {
      calls++;
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };
    const config = new OpenAiConfig("http://provider.invalid/v1");
    config.maxRetries = 2;
    config.retryBackoffMs = 5;
    const error = await new OpenAiProvider("p", config, { fetch: refused })
      .stream(request())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).not.toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).toBe("p: request failed: fetch failed (connect ECONNREFUSED)");
    expect(calls).toBe(3);
  });

  it("a_stream_that_stalls_fails_after_the_idle_timeout", async () => {
    const http = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(delta({ content: "a" }))}\n\n`);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as AddressInfo;
      for (const kind of ["deepseek", "openai-compatible"] as const) {
        const config = new OpenAiConfig(`http://127.0.0.1:${port}/v1`);
        config.kind = kind;
        config.timeoutMs = 100;
        const stream = await new OpenAiProvider("stall", config).stream(request());
        const it = stream[Symbol.asyncIterator]();
        expect(await it.next()).toEqual({ value: { type: "text_delta", text: "a" }, done: false });
        const error = await it.next().catch((e: unknown) => e);
        expect(error, kind).toBeInstanceOf(LlmError);
        expect((error as Error).message, kind).toBe(
          "stall: stream interrupted: no data for 100 ms",
        );
      }
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("a_consumer_that_stops_early_closes_the_connection", async () => {
    let closed = 0;
    const http = createServer((req, res) => {
      req.resume();
      req.socket.on("close", () => {
        closed++;
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(delta({ content: "a" }))}\n\n`);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const config = new OpenAiConfig(`http://127.0.0.1:${port}/v1`);
      for await (const ev of await new OpenAiProvider("early", config).stream(request())) {
        expect(ev).toEqual({ type: "text_delta", text: "a" });
        break;
      }
      await expect.poll(() => closed).toBe(1);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("a_caller_abort_in_the_middle_of_the_stream_ends_it_with_the_abort", async () => {
    const http = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(delta({ content: "a" }))}\n\n`);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const config = new OpenAiConfig(`http://127.0.0.1:${port}/v1`);
      const controller = new AbortController();
      const stream = await new OpenAiProvider("mid", config).stream(request(), controller.signal);
      const it = stream[Symbol.asyncIterator]();
      expect((await it.next()).value).toEqual({ type: "text_delta", text: "a" });
      setTimeout(() => controller.abort(), 20);
      await expect(it.next()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("deepseek_kinds_do_not_take_a_key_from_the_environment", async () => {
    const before = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-from-env";
    try {
      const config = OpenAiConfig.fromProviderConfig(
        ProviderConfigSchema.parse({ kind: "deepseek", base_url: "http://provider.invalid/v1" }),
      );
      const { headers } = await sendRequest(request(), config);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
      expect(headers.get("accept")).toBe("text/event-stream");
    } finally {
      if (before === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = before;
    }
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
