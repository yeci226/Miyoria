// @miyoria/llm: the LLM layer.
//
// * `ChatProvider` is implemented per API family; `OpenAiProvider` (kinds `openai-compatible`,
//   `openai`, `deepseek`, `opencode`) ships here.
// * `LlmRouter` maps a purpose (`chat`, `fast`, `summarizer`, `game`, `vision`, ...) to a
//   fallback chain of `provider:model` references, tracks usage, cost and the budget.
// * `LlmModule` (id `llm`) builds providers from `[llm]` through `ProviderFactory`s and
//   provides the router as `LlmRouterKey`.

export {
  CALL_KINDS,
  callKind,
  callUsage,
  clip,
  type LlmCallDetail,
  type LlmCallFilter,
  type LlmCallKind,
  LlmCallLog,
  type LlmCallRecord,
  type LlmCallStats,
  type LlmCallStatus,
  type LlmCallUsage,
  type LlmFallback,
  type LlmGroupStats,
  type LlmHourStats,
  type LlmMessageView,
  type LlmThinking,
  type LlmThinkingPage,
  MAX_CALLS,
  MAX_DETAILS,
  redactSecrets,
} from "./calls.js";
export {
  BUDGET_TOPIC,
  type BudgetConfig,
  BudgetConfigSchema,
  type BudgetEventPayload,
  type BudgetState,
  budgetConfig,
  type CostReport,
  CostTracker,
  callCost,
  type EventSink,
  type ModelUsage,
  type OnExhausted,
  type PeriodReport,
  type Pricing,
  PricingSchema,
  periodKeys,
  pricing,
  USAGE_KEY_PREFIX,
  USAGE_PROFILE,
} from "./cost.js";
export {
  type ErrorStage,
  errorKind,
  FIRST_TOKEN_BUCKETS,
  type LlmMetrics,
  llmMetrics,
} from "./metrics.js";
export { MockProvider } from "./mock.js";
export {
  type LlmConfig,
  LlmConfigSchema,
  LlmModule,
  type LlmModuleOptions,
  LlmRouterKey,
  type ProviderConfig,
  ProviderConfigSchema,
  type ProviderFactory,
  USAGE_FLUSH_INTERVAL_MS,
} from "./module.js";
export * from "./openai/index.js";
export { LlmRouter, type LlmRouterOptions, RoutedStream, type UsageRecord } from "./router.js";
export { contextHash, contextSession, sessionId } from "./session.js";
export {
  type Completer,
  completeJson,
  extractJsonObject,
  issueLines,
  type StructuredOptions,
  StructuredOutputError,
  type StructuredResult,
} from "./structured.js";
export {
  collectRetries,
  currentLlmTag,
  type LlmCallTag,
  noteProviderRetry,
  withLlmTag,
} from "./trace.js";
export {
  assistantMessage,
  BudgetExhaustedError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatRole,
  type ChatStream,
  type ContentPart,
  collectResponse,
  completeChat,
  contentText,
  hasImages,
  IMAGE_PLACEHOLDER,
  type ImageDetail,
  type ImagePart,
  LlmError,
  type MessageContent,
  type ModelRef,
  ModelRefSchema,
  modelRefString,
  NoImageModelError,
  ProviderHttpError,
  ProviderTimeoutError,
  parseModelRef,
  type StreamEvent,
  systemMessage,
  type TextPart,
  type ToolCall,
  type ToolSpec,
  textOnlyRequest,
  toolResultMessage,
  tryParseModelRef,
  type Usage,
  userMessage,
} from "./types.js";
export { MIYORIA_VERSION } from "./version.js";
