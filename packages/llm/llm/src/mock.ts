import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "./types.js";
import { LlmError } from "./types.js";

type Scripted = { kind: "reply"; events: StreamEvent[] } | { kind: "fail"; message: string };

async function* replay(events: readonly StreamEvent[]): ChatStream {
  for (const ev of events) yield structuredClone(ev);
}

/**
 * Scripted provider for tests. Each call pops the next scripted reply; the last one repeats.
 * Requests are recorded for assertions.
 *
 * ```ts
 * const p = new MockProvider("a").reply("你好。").fail("down");
 * ```
 */
export class MockProvider implements ChatProvider {
  readonly name: string;
  readonly #script: Scripted[] = [];
  readonly #requests: ChatRequest[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** Replies with `text`, streamed in sentence chunks, then `done` with a small usage. */
  reply(text: string): this {
    const parts = text.match(/[^。!?\n]*[。!?\n]|[^。!?\n]+$/gu) ?? [];
    const events: StreamEvent[] = parts.map((t) => ({ type: "text_delta", text: t }));
    events.push({
      type: "done",
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 5, cached_prompt_tokens: null },
    });
    return this.events(events);
  }

  events(events: StreamEvent[]): this {
    this.#script.push({ kind: "reply", events });
    return this;
  }

  /** The call rejects with `message` (before any event). */
  fail(message: string): this {
    this.#script.push({ kind: "fail", message });
    return this;
  }

  requests(): ChatRequest[] {
    return structuredClone(this.#requests);
  }

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.#requests.push(structuredClone(request));
    const next = this.#script.length > 1 ? this.#script.shift() : this.#script[0];
    if (!next) throw new LlmError(`mock provider \`${this.name}\` has no scripted reply`);
    if (next.kind === "fail") throw new LlmError(next.message);
    return replay(next.events);
  }
}
