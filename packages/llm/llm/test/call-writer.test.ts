import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@miyoria/runtime/kernel";
import type { Clock, JsonValue } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatProvider,
  type ChatRequest,
  type FinishedLlmCall,
  type LlmCallLine,
  LlmCallLog,
  LlmCallWriter,
  LlmConfigSchema,
  LlmModule,
  LlmRouter,
  LlmRouterKey,
  MockProvider,
  type ProviderFactory,
  parseModelRef,
  userMessage,
  withLlmTag,
} from "../src/index.js";

const DAY = "2026-11-14";
const NOON = Date.parse(`${DAY}T12:00:00.000Z`);

let dir: string;
let now: number;
const clock: Clock = { now: () => now };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-llm-calls-"));
  now = NOON;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): LlmCallLine[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as LlmCallLine);
}

function router(writer: LlmCallWriter, ...providers: MockProvider[]): LlmRouter {
  return new LlmRouter(
    new Map<string, ChatProvider>(providers.map((p) => [p.name, p])),
    new Map([["chat", providers.map((p) => parseModelRef(`${p.name}:model-${p.name}`))]]),
    { sink: writer },
  );
}

/** A finished call without going through a router. */
function finished(id: string, text = "x".repeat(200)): FinishedLlmCall {
  const log = new LlmCallLog();
  const record = log.open(
    id,
    new Date(now).toISOString(),
    "chat",
    "chat",
    {
      messages: [userMessage(text)],
    },
    false,
    undefined,
  );
  record.status = "ok";
  return {
    record,
    request: { messages: [userMessage(text)] },
    response: { text, reasoning: "", tool_calls: [] },
  };
}

describe("LlmCallWriter", () => {
  it("writes one line per finished call with the record, request and response", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    const r = router(writer, new MockProvider("a").reply("你好。"));
    await withLlmTag({ module: "agent", turn: "turn-1", label: "reply" }, () =>
      r.complete("chat", {
        messages: [userMessage("嗨")],
        tools: [{ name: "web_search", description: "Search", parameters: { type: "object" } }],
        temperature: 0.7,
        max_tokens: 256,
        reasoning: "low",
      }),
    );
    await writer.flush();

    const [line, ...rest] = lines(join(dir, `${DAY}.jsonl`));
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      v: 1,
      logged_at: new Date(NOON).toISOString(),
      metadata_only: null,
      call: {
        purpose: "chat",
        provider: "a",
        model: "a:model-a",
        status: "ok",
        module: "agent",
        turn: "turn-1",
        label: "reply",
        reasoning: "low",
        thinking: true,
        tools: ["web_search"],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        finish_reason: "stop",
        error: null,
      },
      request: {
        messages: [{ role: "user", content: "嗨", name: null, tool_calls: [], tool_call_id: null }],
        tools: [{ name: "web_search", description: "Search", parameters: { type: "object" } }],
        temperature: 0.7,
        max_tokens: 256,
        reasoning: "low",
        thinking: true,
      },
      response: { text: "你好。", reasoning: "", tool_calls: [] },
    });
    expect(line?.call).not.toHaveProperty("has_detail");
    expect(typeof line?.call.total_ms).toBe("number");
    expect(writer.written).toBe(1);
    expect(writer.dropped).toBe(0);
  });

  it("writes failed calls too, with the error and no response", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    const r = router(writer, new MockProvider("a").fail("down"));
    await expect(r.complete("chat", { messages: [userMessage("hi")] })).rejects.toThrow("down");
    await writer.flush();
    const [line] = lines(join(dir, `${DAY}.jsonl`));
    expect(line?.call).toMatchObject({ status: "error", error: "down", model: "a:model-a" });
    expect(line?.response).toBeNull();
    expect(line?.request?.messages[0]?.content).toBe("hi");
  });

  it("writes nothing secret: keys, auth headers and provider config stay out", async () => {
    const key = "sk-proj-SECRETSECRETSECRET1234";
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";
    const writer = new LlmCallWriter({ dir, clock });
    const r = router(writer, new MockProvider("a").reply(`echo ${key}`));
    const request = {
      messages: [userMessage(`my key is ${key}, header Authorization: ${bearer}`)],
      // Fields a caller might put on the object; only the known ones are written.
      api_key: key,
      headers: { Authorization: bearer },
      provider: { api_key: key, base_url: "https://example.invalid" },
    } as unknown as ChatRequest;
    await r.complete("chat", request);
    const failing = router(writer, new MockProvider("a").fail(`401 invalid key ${key}`));
    await expect(failing.complete("chat", { messages: [userMessage("hi")] })).rejects.toThrow();
    await writer.flush();

    const text = readFileSync(join(dir, `${DAY}.jsonl`), "utf8");
    expect(text).not.toContain("SECRETSECRET");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("example.invalid");
    expect(text).not.toMatch(/"api_key"|"headers"|"base_url"|"authorization"/i);
    expect(lines(join(dir, `${DAY}.jsonl`))).toHaveLength(2);
  });

  it("drops inline image bytes", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    const r = router(writer, new MockProvider("a").reply("ok"));
    const url = `data:image/png;base64,${"A".repeat(4000)}`;
    await r.complete("chat", {
      messages: [
        userMessage([
          { type: "text", text: "看" },
          { type: "image_url", image_url: { url, detail: "low" } },
        ]),
      ],
    });
    await writer.flush();
    const text = readFileSync(join(dir, `${DAY}.jsonl`), "utf8");
    expect(text).not.toContain("A".repeat(100));
    expect(text).toContain("data:image/png;base64,[圖片");
  });

  it("starts a new file when the UTC day changes", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    now = Date.parse(`${DAY}T23:59:59.000Z`);
    writer.write(finished("a"));
    await writer.flush();
    now = Date.parse("2026-11-15T00:00:01.000Z");
    writer.write(finished("b"));
    await writer.flush();
    expect(readdirSync(dir).sort()).toEqual([`${DAY}.jsonl`, "2026-11-15.jsonl"]);
    expect(lines(join(dir, `${DAY}.jsonl`)).map((l) => l.call.id)).toEqual(["a"]);
    expect(lines(join(dir, "2026-11-15.jsonl")).map((l) => l.call.id)).toEqual(["b"]);
  });

  it("deletes files older than keep_days, at prune and when the day changes", async () => {
    for (const day of ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", DAY]) {
      writeFileSync(join(dir, `${day}.jsonl`), "{}\n");
    }
    writeFileSync(join(dir, "notes.txt"), "not ours");
    const writer = new LlmCallWriter({ dir, clock, keepDays: 3 });
    expect(await writer.prune()).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([
      "2026-11-12.jsonl",
      "2026-11-13.jsonl",
      `${DAY}.jsonl`,
      "notes.txt",
    ]);

    writer.write(finished("a"));
    await writer.flush();
    now = Date.parse("2026-11-15T00:00:01.000Z");
    writer.write(finished("b"));
    await writer.flush();
    expect(readdirSync(dir).sort()).toEqual([
      "2026-11-13.jsonl",
      `${DAY}.jsonl`,
      "2026-11-15.jsonl",
      "notes.txt",
    ]);
  });

  it("writes metadata only once the day's file passes max_mb_per_day", async () => {
    const writer = new LlmCallWriter({ dir, clock, maxBytesPerDay: 1500 });
    for (const id of ["a", "b", "c"]) writer.write(finished(id, "y".repeat(600)));
    await writer.flush();
    const [a, b, c] = lines(join(dir, `${DAY}.jsonl`));
    expect(a?.metadata_only).toBeNull();
    expect(a?.request?.messages[0]?.content).toBe("y".repeat(600));
    expect(a?.response?.text).toBe("y".repeat(600));
    for (const l of [b, c]) {
      expect(l?.metadata_only).toBe("size_cap");
      expect(l?.request).toBeNull();
      expect(l?.response).toBeNull();
      expect(l?.call.text_chars).toBe(0);
      expect(l?.call.messages).toBe(1);
    }

    // A restarted writer picks up the file's size.
    const again = new LlmCallWriter({ dir, clock, maxBytesPerDay: 1500 });
    again.write(finished("d", "z".repeat(10)));
    await again.flush();
    expect(lines(join(dir, `${DAY}.jsonl`))[3]?.metadata_only).toBe("size_cap");
  });

  it("writes metadata only when bodies are off", async () => {
    const writer = new LlmCallWriter({ dir, clock, bodies: false });
    writer.write(finished("a", "secret-ish chat"));
    await writer.flush();
    const [line] = lines(join(dir, `${DAY}.jsonl`));
    expect(line).toMatchObject({ metadata_only: "config", request: null, response: null });
    expect(readFileSync(join(dir, `${DAY}.jsonl`), "utf8")).not.toContain("secret-ish chat");
  });

  it("never throws into the caller when the directory cannot be written, and counts drops", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "a file where the directory should be");
    const writer = new LlmCallWriter({ dir: blocked, clock });
    const r = router(writer, new MockProvider("a").reply("still answers"));
    expect((await r.complete("chat", { messages: [userMessage("hi")] })).text).toBe(
      "still answers",
    );
    writer.write(finished("b"));
    await writer.flush();
    expect(writer.written).toBe(0);
    expect(writer.dropped).toBe(2);
    expect(await writer.prune()).toBe(0);
    expect(await writer.recent(10)).toEqual([]);
    await writer.close();
  });

  it("drops and counts lines past the queue bound", async () => {
    const writer = new LlmCallWriter({ dir, clock, maxQueue: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) writer.write(finished(id));
    expect(writer.dropped).toBe(3);
    await writer.flush();
    expect(lines(join(dir, `${DAY}.jsonl`)).map((l) => l.call.id)).toEqual(["a", "b"]);
  });

  it("writes what is queued on close, and drops what comes after", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    for (let i = 0; i < 600; i++) writer.write(finished(`c${i}`, "hi"));
    await writer.close();
    expect(lines(join(dir, `${DAY}.jsonl`))).toHaveLength(600);
    writer.write(finished("late"));
    await writer.flush();
    expect(lines(join(dir, `${DAY}.jsonl`))).toHaveLength(600);
    expect(writer.dropped).toBe(1);
  });

  it("reads back today's newest records for the inspector", async () => {
    const writer = new LlmCallWriter({ dir, clock });
    for (const id of ["a", "b", "c", "d"]) writer.write(finished(id));
    await writer.flush();
    const recent = await writer.recent(3);
    expect(recent.map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(recent.every((r) => !r.has_detail)).toBe(true);
    // Reading only the tail skips the cut first line.
    const size = readFileSync(join(dir, `${DAY}.jsonl`)).length;
    expect((await writer.recent(10, Math.floor(size * 0.6))).map((r) => r.id)).toEqual(["c", "d"]);

    const ring = new LlmCallLog(3);
    ring.open(
      "new",
      new Date(now).toISOString(),
      "chat",
      "chat",
      { messages: [] },
      false,
      undefined,
    );
    expect(ring.restore([...recent, ...recent])).toBe(2);
    expect(ring.list().items.map((c) => c.id)).toEqual(["new", "d", "c"]);
    expect(ring.detail("d")).toBeNull();
  });
});

describe("LlmModule call log", () => {
  const mockFactory = (provider: ChatProvider): ProviderFactory => ({
    kinds: ["mock"],
    build: () => provider,
  });

  it("writes calls under baseDir, flushes on stop and loads today's calls at start", async () => {
    const key = "sk-live-PROVIDERKEY0123456789";
    const config = LlmConfigSchema.parse({
      providers: { m: { kind: "mock", api_key: key, headers: { Authorization: `Bearer ${key}` } } },
      purposes: { chat: ["m:model-a"] },
      call_log: { dir: "logs/llm" },
    });
    expect(config.call_log).toEqual({
      enabled: true,
      dir: "logs/llm",
      keep_days: 14,
      max_mb_per_day: 512,
      bodies: true,
    });
    const published: JsonValue[] = [];
    const run = async (): Promise<void> => {
      const sup = new Supervisor({ clock });
      const events = sup.bus.subscribe("llm.call");
      await sup.register(
        new LlmModule(config, [mockFactory(new MockProvider("m").reply("嗨"))], { baseDir: dir }),
        null,
        true,
      );
      await sup.startAll();
      const r = sup.services.require(LlmRouterKey);
      await r.complete("chat", { messages: [userMessage("hi")] });
      for (let env = events.tryRecv(); env !== null; env = events.tryRecv()) {
        published.push(env.data as never);
      }
      await sup.stopAll();
    };
    await run();
    const file = join(dir, "logs", "llm", `${DAY}.jsonl`);
    expect(lines(file)).toHaveLength(1);
    expect(readFileSync(file, "utf8")).not.toContain("PROVIDERKEY");
    // The call's event points at its line: the file's day and the call's id.
    const line = JSON.parse(readFileSync(file, "utf8")) as { call: { id: string } };
    expect(published).toEqual([
      expect.objectContaining({ call_id: line.call.id, log_day: DAY, status: "ok" }),
    ]);

    // A new process: the inspector shows the call from before.
    const second = new LlmModule(config, [mockFactory(new MockProvider("m").reply("嗨"))], {
      baseDir: dir,
    });
    const sup2 = new Supervisor({ clock });
    await sup2.register(second, null, true);
    await sup2.startAll();
    const r = sup2.services.require(LlmRouterKey);
    for (let i = 0; i < 50 && r.calls.size === 0; i++)
      await new Promise((res) => setTimeout(res, 5));
    expect(r.calls.list().items.map((c) => c.status)).toEqual(["ok"]);
    await sup2.stopAll();
  });

  it("writes nothing when disabled", async () => {
    const config = LlmConfigSchema.parse({
      purposes: { chat: ["m:model-a"] },
      providers: { m: { kind: "mock" } },
      call_log: { enabled: false },
    });
    const sup = new Supervisor({ clock });
    await sup.register(
      new LlmModule(config, [mockFactory(new MockProvider("m").reply("嗨"))], { baseDir: dir }),
      null,
      true,
    );
    await sup.startAll();
    await sup.services.require(LlmRouterKey).complete("chat", { messages: [userMessage("hi")] });
    await sup.stopAll();
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});
