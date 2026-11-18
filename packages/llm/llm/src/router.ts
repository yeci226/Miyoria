import { errorMessage, getLogger, type MetricsRegistry } from "@miyoria/runtime/kernel";
import type { LlmCallStore } from "@miyoria/store";
import {
  type Clock,
  newId,
  type ReasoningLevel,
  reasoningEnabled,
  reasoningFor,
  systemClock,
} from "@miyoria/types";
import type { LlmCallSink, LlmLoggedResponse } from "./call-writer.js";
import { callUsage, LlmCallLog, type LlmCallRecord } from "./calls.js";
import {
  type BudgetConfig,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  type EventSink,
  type Pricing,
} from "./cost.js";
import { errorKind, type LlmMetrics, llmMetrics } from "./metrics.js";
import { collectRetries, currentLlmTag, type LlmCallTag } from "./trace.js";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  collectResponse,
  hasImages,
  LlmError,
  type ModelRef,
  modelRefString,
  NoImageModelError,
  ProviderHttpError,
  type StreamEvent,
  type ToolCall,
  textOnlyRequest,
  type Usage,
} from "./types.js";

const log = getLogger("llm.router");

/** Calls and tokens per `provider:model` since startup. */
export interface UsageRecord {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export interface LlmRouterOptions {
  /** Prices keyed by `provider:model`; unpriced models cost 0. */
  pricing?: ReadonlyMap<string, Pricing>;
  budget?: BudgetConfig;
  /** Replaces the cost tracker (tests with a fake clock). */
  tracker?: CostTracker;
  /** Where call, token, cost, latency and error metrics go. Default: the process-wide one. */
  metrics?: MetricsRegistry;
  /** Clock of the first-token latency. Default: the system clock. */
  clock?: Clock;
  /** `[llm.reasoning]`: the reasoning level per (reasoning) purpose. */
  reasoning?: ReadonlyMap<string, ReasoningLevel>;
  /**
   * `[llm.image_input]`: whether a model takes image parts, keyed by `provider:model` or by
   * `provider` (the model entry wins). Unlisted models do.
   */
  imageInput?: ReadonlyMap<string, boolean>;
  /** Where calls are recorded for the inspector (kept across module restarts by the module). */
  calls?: LlmCallLog;
  /** Where every finished call also goes (the on-disk call log). */
  sink?: LlmCallSink;
}

/** HTTP statuses with which a provider may refuse image parts it does not support. */
const IMAGE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

function rejectsImages(error: unknown): error is ProviderHttpError {
  return error instanceof ProviderHttpError && IMAGE_REJECTION_STATUSES.has(error.status);
}

/** One routed call while it streams. */
interface Call {
  key: string;
  purpose: string;
  /** When `LlmRouter.stream` was called (before any fallback). */
  requestedAt: number;
  /** When the request to the answering model was sent. */
  sentAt: number;
  firstTokenAt: number | null;
  /** Its entry in the call log. */
  record: LlmCallRecord;
  /** The request as sent to the answering model. */
  request: ChatRequest;
  tag: LlmCallTag | undefined;
  /** Not the model the purpose normally gets: see `RoutedStream.fallback`. */
  fallback: boolean;
}

/**
 * The stream `LlmRouter.stream` returns: a `ChatStream` that also tells which model answered
 * and how long the first token took.
 */
export class RoutedStream implements AsyncIterable<StreamEvent> {
  readonly #call: Call;
  readonly #events: AsyncGenerator<StreamEvent>;

  /** @internal Created by `LlmRouter.stream`. */
  constructor(call: Call, events: AsyncGenerator<StreamEvent>) {
    this.#call = call;
    this.#events = events;
  }

  /** `provider:model` that is answering. */
  get model(): string {
    return this.#call.key;
  }

  /**
   * A fallback model is answering: one earlier in the chain failed, or the budget replaced the
   * chain (`[llm.budget.fallback]`). What it writes passed none of the checks the first choice
   * was tried against, so the output review treats it as its own path.
   */
  get fallback(): boolean {
    return this.#call.fallback;
  }

  /**
   * Milliseconds from the `stream` call to the first text or reasoning delta, including time
   * spent on models that failed before it; `null` until one arrives.
   */
  get firstTokenMs(): number | null {
    const at = this.#call.firstTokenAt;
    return at === null ? null : Math.max(0, at - this.#call.requestedAt);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.#events;
  }
}

/**
 * Routes requests by purpose (`chat`, `fast`, `summarizer`, `game`, `vision`, ...) to a chain
 * of models, falling back to the next model if one fails before producing any output.
 * Provided as the `LlmRouterKey` service by the `llm` module.
 */
export class LlmRouter {
  readonly #providers: ReadonlyMap<string, ChatProvider>;
  readonly #purposes: Map<string, ModelRef[]>;
  readonly #usage = new Map<string, UsageRecord>();
  readonly #cost: CostTracker;
  readonly #metrics: LlmMetrics;
  readonly #clock: Clock;
  readonly #reasoning: ReadonlyMap<string, ReasoningLevel>;
  readonly #imageInput: ReadonlyMap<string, boolean>;
  /** Models that refused image parts in this run (`provider:model`); they get text from now on. */
  readonly #refusedImages = new Set<string>();
  readonly #calls: LlmCallLog;
  readonly #sink: LlmCallSink | undefined;

  constructor(
    providers: ReadonlyMap<string, ChatProvider>,
    purposes: ReadonlyMap<string, ModelRef[]>,
    options: LlmRouterOptions = {},
  ) {
    this.#providers = providers;
    this.#purposes = new Map(purposes);
    this.#cost =
      options.tracker ?? new CostTracker(options.pricing, options.budget ?? budgetConfig());
    this.#metrics = llmMetrics(options.metrics);
    this.#clock = options.clock ?? systemClock;
    this.#reasoning = options.reasoning ?? new Map();
    this.#imageInput = options.imageInput ?? new Map();
    this.#calls = options.calls ?? new LlmCallLog();
    this.#sink = options.sink;
  }

  /**
   * Whether `model` takes image parts: not after it refused them in this run, else
   * `[llm.image_input]` for the model, then for its provider; unlisted models do.
   */
  modelTakesImages(model: ModelRef): boolean {
    const key = modelRefString(model);
    if (this.#refusedImages.has(key)) return false;
    return this.#imageInput.get(key) ?? this.#imageInput.get(model.provider) ?? true;
  }

  /**
   * Whether a request for `purpose` would reach a model that looks at images (the first model
   * of the chain in use), so callers can skip preparing images nobody sees.
   */
  takesImages(purpose: string): boolean {
    const first = this.#chainForState(purpose, this.#cost.state())[0];
    return first !== undefined && this.modelTakesImages(first);
  }

  /**
   * The reasoning level of a request for `purpose`: `request.reasoning` when set; an explicit
   * `request.thinking` (older callers: `false` = `off`, `true` = the configured level, at least
   * `medium`); else for its reasoning purpose (`request.reasoning_purpose`, default `purpose`)
   * `[llm.reasoning]`, then the §3.10 defaults; purposes nobody lists do not reason.
   */
  reasoningFor(purpose: string, request: ChatRequest): ReasoningLevel {
    if (request.reasoning != null) return request.reasoning;
    const key = request.reasoning_purpose ?? purpose;
    const configured = this.#configuredLevel(key);
    if (request.thinking === false) return "off";
    if (request.thinking === true) return configured === "off" ? "medium" : configured;
    return configured;
  }

  #configuredLevel(key: string): ReasoningLevel {
    const set = this.#reasoning.get(key);
    if (set !== undefined) return set;
    return reasoningFor(key);
  }

  /** Overrides purposes, e.g. with the active profile's `[llm.purposes]`. */
  setPurposes(overrides: ReadonlyMap<string, ModelRef[]>): void {
    for (const [purpose, chain] of overrides) this.#purposes.set(purpose, chain);
  }

  /** The chain of `purpose`, or of `chat` when the purpose is not configured. */
  chain(purpose: string): ModelRef[] {
    return [...(this.#purposes.get(purpose) ?? this.#purposes.get("chat") ?? [])];
  }

  hasPurpose(purpose: string): boolean {
    return this.chain(purpose).length > 0;
  }

  /** Whether `purpose` has a chain of its own (not just the `chat` fallback). */
  configures(purpose: string): boolean {
    return (this.#purposes.get(purpose)?.length ?? 0) > 0;
  }

  /** The purpose whose chain a request for `purpose` uses (`chat` if unconfigured). */
  #effectivePurpose(purpose: string): string {
    return this.#purposes.has(purpose) ? purpose : "chat";
  }

  /** The configured fallback while degraded or exhausted, else the normal chain. */
  #chainForState(purpose: string, state: BudgetState): ModelRef[] {
    if (state !== "ok") {
      const fallback = this.#cost.fallbackChain(this.#effectivePurpose(purpose));
      if (fallback && fallback.length > 0) return [...fallback];
    }
    return this.chain(purpose);
  }

  /** Usage per `provider:model` since startup. */
  usage(): Map<string, UsageRecord> {
    return new Map([...this.#usage].map(([k, v]) => [k, { ...v }]));
  }

  /** Spend so far today and this month, per model, plus the budget state. */
  costReport(): CostReport {
    return this.#cost.report();
  }

  /** Current budget state (re-evaluated, so day rollovers are applied). */
  budgetState(): BudgetState {
    return this.#cost.state();
  }

  /** Publishes the current budget state as an `llm.budget` event. */
  announceBudget(): void {
    this.#cost.announce();
  }

  /** Where budget events (`llm.budget`) are published. */
  setEventSink(sink: EventSink): void {
    this.#cost.setSink(sink);
  }

  /**
   * Adds the spending of the current day and month that the event log holds (`llm.call` events
   * of earlier runs). Call once, after `setEventSink` and before the first call.
   */
  restoreUsage(calls: LlmCallStore): Promise<void> {
    return this.#cost.restore(calls);
  }

  /**
   * Streams a response for `purpose` (falls back to `chat` if the purpose is not configured).
   * `request.model` is overwritten.
   *
   * Rejects with `BudgetExhaustedError` when the budget is used up and `on_exhausted = "stop"`
   * (unless the purpose is exempt). While degraded or exhausted the `[llm.budget.fallback]`
   * chain replaces the normal one.
   *
   * With `request.requires_images` images are never stripped: models known not to take them are
   * skipped, and `NoImageModelError` is thrown when none of the chain does.
   */
  async stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<RoutedStream> {
    const requestedAt = this.#clock.now();
    const tag = currentLlmTag();
    const level = this.reasoningFor(purpose, request);
    const record = this.#calls.open(
      newId(),
      new Date(requestedAt).toISOString(),
      purpose,
      this.#effectivePurpose(purpose),
      request,
      reasoningEnabled(level),
      tag,
      level,
    );
    tag?.onCall?.({ id: record.id, cost_usd: null, status: record.status });
    /** The request last sent (or about to be). */
    let sent = request;
    const fail = (error: unknown): never => {
      record.status = signal?.aborted ? "aborted" : "error";
      record.error = errorMessage(error);
      record.error_kind = errorKind(error);
      record.total_ms = Math.max(0, this.#clock.now() - requestedAt);
      this.#finish(record, sent, null);
      tag?.onCall?.({ id: record.id, cost_usd: null, status: record.status });
      throw error;
    };
    let state: BudgetState;
    try {
      state = this.#cost.gate(purpose);
    } catch (error) {
      return fail(error);
    }
    const chain = this.#chainForState(purpose, state);
    const budgetChain =
      state !== "ok" &&
      (this.#cost.fallbackChain(this.#effectivePurpose(purpose))?.length ?? 0) > 0;
    if (chain.length === 0) {
      return fail(
        new LlmError(`no model configured for purpose \`${purpose}\` (and no \`chat\` fallback)`),
      );
    }
    const required = request.requires_images === true;
    /** Models of the chain that cannot take this request's images. */
    let blind = 0;
    let refusedWith: number | null = null;
    let lastError: unknown;
    for (const model of chain) {
      const key = modelRefString(model);
      record.model = key;
      record.provider = model.provider;
      const provider = this.#providers.get(model.provider);
      if (!provider) {
        log.warn({ model: key }, "unknown provider in model chain");
        lastError = new LlmError(`unknown provider \`${model.provider}\``);
        record.fallbacks.push({ model: key, error: errorMessage(lastError), kind: "error" });
        continue;
      }
      if (required && !this.modelTakesImages(model)) {
        blind++;
        record.fallbacks.push({ model: key, error: "does not take images", kind: "error" });
        continue;
      }
      let iterator: AsyncIterator<StreamEvent>;
      let first: IteratorResult<StreamEvent>;
      const sentAt = this.#clock.now();
      let routed: ChatRequest = {
        ...request,
        model: model.model,
        thinking: reasoningEnabled(level),
        reasoning: level,
      };
      const images = hasImages(routed.messages);
      if (images && !this.modelTakesImages(model)) routed = textOnlyRequest(routed);
      sent = routed;
      try {
        try {
          [iterator, first] = await collectRetries(record.retries, () =>
            this.#open(provider, routed, signal),
          );
        } catch (error) {
          // A provider that cannot take image parts: once more as text, and remember it.
          const downgrade =
            !required && images && hasImages(routed.messages) && rejectsImages(error);
          if (signal?.aborted || !downgrade) throw error;
          log.warn(
            { model: key, err: errorMessage(error) },
            "model refused image input, retrying as text",
          );
          record.retries.push("圖片被拒,改用文字");
          const textOnly = textOnlyRequest(routed);
          sent = textOnly;
          [iterator, first] = await collectRetries(record.retries, () =>
            this.#open(provider, textOnly, signal),
          );
          this.#refusedImages.add(key);
          log.warn({ model: key }, "sending this model text only from now on");
        }
      } catch (error) {
        if (signal?.aborted) return fail(error);
        log.warn({ model: key, err: errorMessage(error) }, "model failed, trying next in chain");
        this.#metrics.errors.inc({
          model: key,
          purpose,
          stage: "request",
          kind: errorKind(error),
        });
        record.fallbacks.push({ model: key, error: errorMessage(error), kind: errorKind(error) });
        lastError = error;
        if (required && rejectsImages(error)) {
          blind++;
          refusedWith = error.status;
        }
        continue;
      }
      // The answering model is not a fallback.
      record.pricing = this.#cost.priceFor(key);
      const call: Call = {
        key,
        purpose,
        requestedAt,
        sentAt,
        firstTokenAt: null,
        record,
        request: sent,
        tag,
        fallback: budgetChain || record.fallbacks.length > 0,
      };
      this.#metrics.calls.inc({ model: key, purpose });
      if (!first.done) this.#observe(call, first.value);
      return new RoutedStream(call, this.#track(call, first, iterator, signal));
    }
    const failed = record.fallbacks.pop();
    if (failed) record.model = failed.model;
    if (required && blind === chain.length) {
      return fail(new NoImageModelError(purpose, refusedWith));
    }
    return fail(lastError ?? new LlmError("all models failed"));
  }

  /** Hands a finished call to the sink; a failing sink never fails the call. */
  #finish(record: LlmCallRecord, request: ChatRequest, response: LlmLoggedResponse | null): void {
    if (!this.#sink) return;
    try {
      this.#sink.write({ record, request, response });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "LLM call sink failed");
    }
  }

  /** The call inspector's log (the most recent calls, bounded). */
  get calls(): LlmCallLog {
    return this.#calls;
  }

  /** Every `[llm.pricing]` entry, by `provider:model`. */
  prices(): Record<string, Pricing> {
    return this.#cost.prices();
  }

  /** Starts a response; only failures before the first event count as the model failing. */
  async #open(
    provider: ChatProvider,
    request: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<[AsyncIterator<StreamEvent>, IteratorResult<StreamEvent>]> {
    const stream = await provider.stream(request, signal);
    const iterator = stream[Symbol.asyncIterator]();
    return [iterator, await iterator.next()];
  }

  async complete(
    purpose: string,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return collectResponse(await this.stream(purpose, request, signal));
  }

  /** Notes the first text or reasoning delta of `call`. */
  #observe(call: Call, ev: StreamEvent): void {
    if (call.firstTokenAt !== null) return;
    if (ev.type !== "text_delta" && ev.type !== "reasoning_delta") return;
    const now = this.#clock.now();
    call.firstTokenAt = now;
    this.#metrics.firstToken.observe(
      { model: call.key, purpose: call.purpose },
      Math.max(0, now - call.sentAt) / 1000,
    );
  }

  #record(call: Call, usage: Usage): number {
    const key = call.key;
    let record = this.#usage.get(key);
    if (!record) {
      record = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
      this.#usage.set(key, record);
    }
    record.calls += 1;
    record.prompt_tokens += usage.prompt_tokens;
    record.completion_tokens += usage.completion_tokens;
    record.cached_prompt_tokens += usage.cached_prompt_tokens ?? 0;
    const cost = this.#cost.record(key, usage);
    const labels = { model: key, purpose: call.purpose };
    const tokens = this.#metrics.tokens;
    tokens.inc({ ...labels, type: "prompt" }, usage.prompt_tokens);
    tokens.inc({ ...labels, type: "completion" }, usage.completion_tokens);
    tokens.inc({ ...labels, type: "cached_prompt" }, usage.cached_prompt_tokens ?? 0);
    this.#metrics.cost.inc(labels, cost);
    return cost;
  }

  async *#track(
    call: Call,
    first: IteratorResult<StreamEvent>,
    rest: AsyncIterator<StreamEvent>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent> {
    let finished = false;
    const record = call.record;
    let text = "";
    let reasoning = "";
    const tools: ToolCall[] = [];
    const end = (status: LlmCallRecord["status"], error: unknown = null) => {
      if (record.status !== "streaming") return;
      record.status = status;
      record.total_ms = Math.max(0, this.#clock.now() - call.requestedAt);
      record.first_token_ms =
        call.firstTokenAt === null ? null : Math.max(0, call.firstTokenAt - call.requestedAt);
      if (error !== null) {
        record.error = errorMessage(error);
        record.error_kind = errorKind(error);
      }
      this.#calls.respond(record.id, text, reasoning, tools);
      this.#finish(record, call.request, { text, reasoning, tool_calls: tools });
      call.tag?.onCall?.({ id: record.id, cost_usd: record.cost_usd, status });
    };
    try {
      for (let next = first; !next.done; ) {
        const ev = next.value;
        this.#observe(call, ev);
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "reasoning_delta") reasoning += ev.text;
        else if (ev.type === "tool_call_delta") {
          while (tools.length <= ev.index) tools.push({ id: "", name: "", arguments: "" });
          const t = tools[ev.index] as ToolCall;
          if (ev.id !== null) t.id = ev.id;
          if (ev.name !== null) t.name += ev.name;
          t.arguments += ev.arguments;
        } else if (ev.type === "done") {
          record.finish_reason = ev.finish_reason;
          if (ev.usage) {
            record.usage = callUsage(ev.usage);
            record.cost_usd = this.#record(call, ev.usage);
          }
        }
        yield ev;
        try {
          next = await rest.next();
        } catch (error) {
          if (!signal?.aborted) {
            this.#metrics.errors.inc({
              model: call.key,
              purpose: call.purpose,
              stage: "stream",
              kind: errorKind(error),
            });
          }
          end(signal?.aborted ? "aborted" : "error", error);
          throw error;
        }
      }
      finished = true;
      end("ok");
    } finally {
      if (!finished) {
        // The caller stopped reading (or the stream failed, recorded above).
        end(
          record.finish_reason !== null ? "ok" : "aborted",
          record.finish_reason !== null ? null : new LlmError("stopped before the end"),
        );
        await rest.return?.();
      }
    }
  }
}
