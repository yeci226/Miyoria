// What the panel's prompt page shows of a run: the messages of its first model call as sent,
// squeezed, kept in the agent's archive (`SavedPromptsKey`, newest `[modules.agent.prompt] saved`
// of them, every `save_every`-th run) and published as `agent.prompt`, as the old turn did. Its
// token count is the provider's, from the answer to that call. The runner builds and sends its
// requests as before: only a copy of the messages is read here, from the host's model port.

import type { ChatRequest } from "@miyoria/llm/llm";
import { type ContextKey, Events, type SavedPrompt, toTimestamp } from "@miyoria/types";
import { type Agent, savedPrompt } from "../../agent/src/index.js";
import type { RunEvent } from "../../self/src/index.js";

interface Kept {
  context: ContextKey;
  /** The first call's prompt, until it is kept. */
  prompt: SavedPrompt | null;
  kept: boolean;
}

export class PromptKeeper {
  readonly #agent: Agent;
  readonly #runs = new Map<string, Kept>();
  /** Runs that reached the model, for `save_every`. */
  #count = 0;

  constructor(agent: Agent) {
    this.#agent = agent;
  }

  /** The run of `turn` in `context` starts. */
  begin(turn: string, context: ContextKey): void {
    this.#runs.set(turn, { context, prompt: null, kept: false });
  }

  /** A model call of the run of `turn` goes out: the first one is the run's prompt. */
  sent(turn: string | null | undefined, request: ChatRequest): void {
    const run = turn === null || turn === undefined ? undefined : this.#runs.get(turn);
    if (turn === null || turn === undefined || run === undefined) return;
    if (run.prompt !== null || run.kept) return;
    run.prompt = savedPrompt({
      turn,
      context: run.context,
      at: toTimestamp(this.#agent.ctx.clock.now()),
      reasoning: request.reasoning ?? "off",
      blocks: [],
      messages: request.messages,
      maxChars: this.#agent.config.prompt.saved_message_chars,
    });
  }

  /** What the runner reports: the first answer says how many tokens the prompt was. */
  event(event: RunEvent): void {
    if (event.type === "step") this.#keep(event.turn, event.usage?.prompt_tokens ?? null);
  }

  /** The run of `turn` is over; its prompt is kept if no answer came to keep it (`keep`). */
  end(turn: string, keep = true): void {
    if (keep) this.#keep(turn, null);
    this.#runs.delete(turn);
  }

  #keep(turn: string, tokens: number | null): void {
    const run = this.#runs.get(turn);
    const prompt = run?.prompt ?? null;
    if (run === undefined || prompt === null) return;
    run.prompt = null;
    run.kept = true;
    const agent = this.#agent;
    const every = agent.config.prompt.save_every;
    if (every <= 0) return;
    this.#count += 1;
    if ((this.#count - 1) % every !== 0) return;
    prompt.prompt_tokens = tokens;
    agent.prompts.push(prompt);
    agent.ctx.publish(Events.AgentPrompt, prompt, { turn });
  }
}
