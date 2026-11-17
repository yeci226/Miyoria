// Counts what a live run spends and stops it at a limit. Every provider the run's router uses is
// wrapped here, so each model call is checked before it is sent (`--max-usd` is a hard stop) and
// its usage is added when it ends, whoever made the call: her brain, a module beside it, the judge.

import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  callCost,
  LlmError,
  type Pricing,
  type Usage,
} from "@miyoria/llm/llm";
import { type ModelUsage, NO_USAGE } from "./subject.js";

/** The run's limit is spent: thrown instead of sending a model call. */
export class BudgetStopError extends LlmError {
  override name = "BudgetStopError";

  constructor(spent: number, limit: number) {
    super(`eval budget spent: $${spent.toFixed(4)} of $${limit.toFixed(4)}`);
  }
}

export interface MeterOptions {
  /** `[llm.pricing]`, by `provider:model`. A model without an entry has no known cost. */
  pricing?: ReadonlyMap<string, Pricing>;
  /** Estimated USD after which no further call is sent (`null`: no limit). */
  maxUsd?: number | null;
}

export class Meter {
  readonly #pricing: ReadonlyMap<string, Pricing>;
  readonly #maxUsd: number | null;
  #usage: ModelUsage = { ...NO_USAGE };
  #usd = 0;
  #refused = 0;
  readonly #unpriced = new Set<string>();
  readonly #models = new Map<string, ModelUsage>();

  constructor(options: MeterOptions = {}) {
    this.#pricing = options.pricing ?? new Map();
    this.#maxUsd = options.maxUsd ?? null;
  }

  /** Tokens and calls so far (a copy). */
  usage(): ModelUsage {
    return { ...this.#usage };
  }

  /** Estimated cost so far of the calls whose model has a price. */
  usd(): number {
    return this.#usd;
  }

  /** Models that answered and have no `[llm.pricing]` entry: their cost is not in `usd()`. */
  unpriced(): string[] {
    return [...this.#unpriced].sort();
  }

  /** Usage per `provider:model`. */
  models(): Record<string, ModelUsage> {
    return Object.fromEntries([...this.#models].map(([k, v]) => [k, { ...v }]));
  }

  /** The limit is reached: the next call would be refused. */
  spent(): boolean {
    return this.#maxUsd !== null && this.#usd >= this.#maxUsd;
  }

  /** Calls refused so far: each is something in the run that went without its model. */
  refusals(): number {
    return this.#refused;
  }

  /** Throws `BudgetStopError` when the limit is reached. */
  check(): void {
    if (this.#maxUsd !== null && this.#usd >= this.#maxUsd) {
      this.#refused += 1;
      throw new BudgetStopError(this.#usd, this.#maxUsd);
    }
  }

  record(model: string, usage: Usage): void {
    const add: ModelUsage = {
      calls: 1,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_prompt_tokens: usage.cached_prompt_tokens ?? 0,
      reasoning_tokens: usage.reasoning_tokens ?? 0,
    };
    const sum = (a: ModelUsage): ModelUsage => ({
      calls: a.calls + add.calls,
      prompt_tokens: a.prompt_tokens + add.prompt_tokens,
      completion_tokens: a.completion_tokens + add.completion_tokens,
      cached_prompt_tokens: a.cached_prompt_tokens + add.cached_prompt_tokens,
      reasoning_tokens: a.reasoning_tokens + add.reasoning_tokens,
    });
    this.#usage = sum(this.#usage);
    this.#models.set(model, sum(this.#models.get(model) ?? { ...NO_USAGE }));
    const price = this.#pricing.get(model);
    if (price) this.#usd += callCost(price, usage);
    else this.#unpriced.add(model);
  }

  /**
   * `provider` with every call checked against the limit first and counted when it ends. A call
   * that ends without usage (the provider reported none, or the reader stopped early) counts as a
   * call with no tokens.
   */
  wrap(provider: ChatProvider): ChatProvider {
    const meter = this;
    return {
      name: provider.name,
      async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
        meter.check();
        const model = `${provider.name}:${request.model ?? ""}`;
        const inner = await provider.stream(request, signal);
        return (async function* (): ChatStream {
          let counted = false;
          try {
            for await (const ev of inner) {
              if (ev.type === "done" && ev.usage && !counted) {
                counted = true;
                meter.record(model, ev.usage);
              }
              yield ev;
            }
          } finally {
            if (!counted) {
              meter.record(model, {
                prompt_tokens: 0,
                completion_tokens: 0,
                cached_prompt_tokens: null,
              });
            }
          }
        })();
      },
    };
  }
}
