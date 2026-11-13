// Every routed LLM call, for the panel's call inspector: a bounded in-memory ring of call
// records (time, purpose, model, tokens, latency, cost and the price used, finish reason,
// fallbacks, retries, errors, who asked), and for the most recent calls the full request and
// response with secrets redacted. Records and details live in memory only (they start over
// when the process restarts); the cost tracker keeps the persisted totals. The reasoning and
// the answer of each call are also kept apart from the details, for many more calls, so the
// panel can read her chain of thought by kind of call.

import type { ReasoningLevel } from "@miyoria/types";
import type { Pricing } from "./cost.js";
import type { LlmCallTag } from "./trace.js";
import { type ChatMessage, contentText, type ToolCall, type Usage } from "./types.js";

/** Call records kept. */
export const MAX_CALLS = 5000;
/** Calls whose request and response are kept. */
export const MAX_DETAILS = 200;
/** Characters of all kept details together; the oldest go first past this. */
export const MAX_DETAIL_CHARS = 12_000_000;
/** Characters kept of one message, of the response text and of the reasoning. */
export const MAX_MESSAGE_CHARS = 40_000;
export const MAX_RESPONSE_CHARS = 40_000;
/** Calls whose reasoning and answer are kept for the chain-of-thought view. */
export const MAX_THINKING = 2000;
/** Characters of all kept reasoning and answers together. */
export const MAX_THINKING_CHARS = 10_000_000;
/** Characters kept of an answer in the chain-of-thought view. */
export const MAX_THINKING_ANSWER_CHARS = 4000;

export type LlmCallStatus = "streaming" | "ok" | "error" | "aborted";

/** What a call was for, broadly: her inner thoughts, a text or voice reply, and so on. */
export const CALL_KINDS = [
  "mind",
  "chat",
  "voice",
  "attention",
  "memory",
  "learning",
  "social",
  "other",
] as const;
export type LlmCallKind = (typeof CALL_KINDS)[number];

/** The kind of a call, from who asked (`module`) and for what (`label`, `purpose`). */
export function callKind(c: {
  module: string | null;
  label: string | null;
  purpose: string;
}): LlmCallKind {
  const m = c.module;
  if (m === "mind" || (m === null && c.purpose === "mind")) return "mind";
  if (m === "agent") {
    if (c.label === "voice") return "voice";
    if (c.label === "attention") return "attention";
    return "chat";
  }
  if (m === "voice") return "voice";
  if (m === "memory") return "memory";
  if (m === "learning") return "learning";
  if (m === "social") return "social";
  return "other";
}

/** A model of the chain that failed before this call's model answered. */
export interface LlmFallback {
  model: string;
  error: string;
  kind: string;
}

export interface LlmCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number | null;
}

/** One routed call. */
export interface LlmCallRecord {
  id: string;
  at: string;
  /** As requested (`chat`, `mind`, `fast`, ...). */
  purpose: string;
  /** The purpose whose chain answered (`chat` when `purpose` has none). */
  chain: string;
  /** What it was for, broadly (`callKind`). */
  kind: LlmCallKind;
  /** `provider:model` that answered (the last one tried when all failed). */
  model: string | null;
  provider: string | null;
  status: LlmCallStatus;
  /** Earlier models of the chain that failed first. */
  fallbacks: LlmFallback[];
  /** HTTP retries of the answering request (`429`, `503`, network). */
  retries: string[];
  thinking: boolean;
  /** Reasoning level the request was sent with (`off` when it did not think). */
  reasoning: ReasoningLevel;
  json_mode: boolean;
  tools: string[];
  max_tokens: number | null;
  temperature: number | null;
  messages: number;
  images: number;
  usage: LlmCallUsage | null;
  first_token_ms: number | null;
  total_ms: number | null;
  cost_usd: number | null;
  /** The price the cost was computed with; `null` when the model has no `[llm.pricing]`. */
  pricing: Pricing | null;
  finish_reason: string | null;
  error: string | null;
  error_kind: string | null;
  module: string | null;
  turn: string | null;
  thought: string | null;
  label: string | null;
  repair: number | null;
  /** Characters of the response text, reasoning and tool calls. */
  text_chars: number;
  reasoning_chars: number;
  tool_calls: number;
  /** The request and response are still kept. */
  has_detail: boolean;
}

export interface LlmMessageView {
  role: string;
  name: string | null;
  content: string;
  /** Characters cut from the middle. */
  cut: number;
  tool_calls: ToolCall[];
  tool_call_id: string | null;
}

export interface LlmCallDetail {
  messages: LlmMessageView[];
  tools: string[];
  response: { text: string; reasoning: string; tool_calls: ToolCall[]; cut: number };
}

/** A call with its chain of thought and answer, for the chain-of-thought view. */
export interface LlmThinking {
  call: LlmCallRecord;
  /** `null` once dropped from the ring (or before the call ends). */
  reasoning: string | null;
  answer: string | null;
  /** Names of the tools it called. */
  tool_calls: string[];
  /** Characters cut from the reasoning and the answer. */
  cut: number;
}

export interface LlmThinkingPage {
  items: LlmThinking[];
  next_cursor: string | null;
  matched: number;
  /** Calls per kind under the same filter (without the kind), and how many of them reasoned. */
  by_kind: { kind: LlmCallKind; calls: number; reasoned: number }[];
}

interface ThinkingEntry {
  reasoning: string;
  answer: string;
  tool_calls: string[];
  cut: number;
}

// ---- redaction ---------------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // Inline images: keep the type, drop the bytes.
  [
    /data:(image\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]{64,}/gi,
    (m, type) => `data:${type};base64,[圖片 ${Math.round((m.length * 3) / 4 / 1024)} KB 已省略]`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [已遮蔽]"],
  [/\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "sk-[已遮蔽]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "gh_[已遮蔽]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-[已遮蔽]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[已遮蔽]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza[已遮蔽]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[JWT 已遮蔽]"],
  // Discord bot tokens.
  [/\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g, "[Discord token 已遮蔽]"],
  // `api_key = ...`, `"token": "..."`, `password: ...`
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret|token)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    (_m, key) => `${key}[已遮蔽]`,
  ],
];

/** `text` with API keys, tokens, passwords and inline image bytes replaced. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as never);
  }
  return out;
}

/** At most `max` characters: the head and the tail, with how many were cut. */
export function clip(text: string, max: number): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`,
    cut: text.length - max,
  };
}

function messageView(m: ChatMessage): LlmMessageView {
  const { text, cut } = clip(redactSecrets(contentText(m.content)), MAX_MESSAGE_CHARS);
  return {
    role: m.role,
    name: m.name,
    content: text,
    cut,
    tool_calls: m.tool_calls.map((c) => ({ ...c, arguments: redactSecrets(c.arguments) })),
    tool_call_id: m.tool_call_id,
  };
}

function detailChars(d: LlmCallDetail): number {
  return (
    d.messages.reduce((n, m) => n + m.content.length, 0) +
    d.response.text.length +
    d.response.reasoning.length
  );
}

// ---- stats ----------------------------------------------------------------------------------

export interface LlmGroupStats {
  key: string;
  calls: number;
  errors: number;
  prompt_tokens: number;
  cached_prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** First-token latency (ms) of the successful calls. */
  p50_ms: number | null;
  p95_ms: number | null;
  /** Total time (ms) of the successful calls. */
  total_p50_ms: number | null;
}

export interface LlmHourStats {
  /** Start of the hour (ISO). */
  hour: string;
  calls: number;
  errors: number;
  prompt_tokens: number;
  cached_prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  /** Cost per purpose. */
  by_purpose: Record<string, number>;
}

export interface LlmCallStats {
  since: string | null;
  /** All calls in the window. */
  total: LlmGroupStats;
  by_purpose: LlmGroupStats[];
  by_model: LlmGroupStats[];
  by_module: LlmGroupStats[];
  by_hour: LlmHourStats[];
  /** First-token latency (ms) of successful calls, by bucket upper bound. */
  latency: { le_ms: number; count: number }[];
  /** Error kinds by count. */
  errors: { kind: string; count: number }[];
  finish_reasons: { reason: string; count: number }[];
  expensive: LlmCallRecord[];
  slowest: LlmCallRecord[];
  /** The calls kept; older ones are gone from the ring. */
  kept: number;
  oldest: string | null;
}

/** Nearest-rank percentile of sorted values. */
function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

const LATENCY_BOUNDS = [250, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 13000, 20000, 30000];

function group(key: string, calls: readonly LlmCallRecord[]): LlmGroupStats {
  const ok = calls.filter((c) => c.status === "ok");
  const first = ok
    .map((c) => c.first_token_ms)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const total = ok
    .map((c) => c.total_ms)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const s: LlmGroupStats = {
    key,
    calls: calls.length,
    errors: calls.filter((c) => c.status === "error").length,
    prompt_tokens: 0,
    cached_prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    p50_ms: pct(first, 0.5),
    p95_ms: pct(first, 0.95),
    total_p50_ms: pct(total, 0.5),
  };
  for (const c of calls) {
    s.prompt_tokens += c.usage?.prompt_tokens ?? 0;
    s.cached_prompt_tokens += c.usage?.cached_prompt_tokens ?? 0;
    s.completion_tokens += c.usage?.completion_tokens ?? 0;
    s.reasoning_tokens += c.usage?.reasoning_tokens ?? 0;
    s.cost_usd += c.cost_usd ?? 0;
  }
  return s;
}

function groups(
  calls: readonly LlmCallRecord[],
  key: (c: LlmCallRecord) => string,
): LlmGroupStats[] {
  const by = new Map<string, LlmCallRecord[]>();
  for (const c of calls) {
    const k = key(c);
    const list = by.get(k);
    if (list) list.push(c);
    else by.set(k, [c]);
  }
  return [...by.entries()]
    .map(([k, list]) => group(k, list))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
}

function counts(values: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

// ---- the log --------------------------------------------------------------------------------

export interface LlmCallFilter {
  kind?: LlmCallKind;
  /** Only calls that answered with reasoning. */
  reasoned?: boolean;
  purpose?: string;
  model?: string;
  module?: string;
  status?: LlmCallStatus;
  /** Only calls with an error (status `error`) or a fallback / retry. */
  trouble?: boolean;
  thought?: string;
  turn?: string;
  /** ISO bounds of `at`. */
  since?: string;
  until?: string;
  /** Text in the purpose, model, label, error or (while kept) the request and response. */
  q?: string;
}

export class LlmCallLog {
  readonly #calls: LlmCallRecord[] = [];
  readonly #details = new Map<string, LlmCallDetail>();
  #detailChars = 0;
  readonly #thinking = new Map<string, ThinkingEntry>();
  #thinkingChars = 0;

  constructor(
    private readonly maxCalls = MAX_CALLS,
    private readonly maxDetails = MAX_DETAILS,
    private readonly maxDetailChars = MAX_DETAIL_CHARS,
    private readonly maxThinking = MAX_THINKING,
    private readonly maxThinkingChars = MAX_THINKING_CHARS,
  ) {}

  /** Starts a record of a call (returned for the router to fill in). */
  open(
    id: string,
    at: string,
    purpose: string,
    chain: string,
    request: {
      messages: ChatMessage[];
      tools?: { name: string }[];
      json_mode?: boolean;
      max_tokens?: number | null;
      temperature?: number | null;
    },
    thinking: boolean,
    tag: LlmCallTag | undefined,
    reasoning: ReasoningLevel = thinking ? "medium" : "off",
  ): LlmCallRecord {
    const images = request.messages.reduce(
      (n, m) =>
        n +
        (typeof m.content === "string"
          ? 0
          : m.content.filter((p) => p.type === "image_url").length),
      0,
    );
    const record: LlmCallRecord = {
      id,
      at,
      purpose,
      chain,
      kind: callKind({ module: tag?.module ?? null, label: tag?.label ?? null, purpose }),
      model: null,
      provider: null,
      status: "streaming",
      fallbacks: [],
      retries: [],
      thinking,
      reasoning,
      json_mode: request.json_mode ?? false,
      tools: (request.tools ?? []).map((t) => t.name),
      max_tokens: request.max_tokens ?? null,
      temperature: request.temperature ?? null,
      messages: request.messages.length,
      images,
      usage: null,
      first_token_ms: null,
      total_ms: null,
      cost_usd: null,
      pricing: null,
      finish_reason: null,
      error: null,
      error_kind: null,
      module: tag?.module ?? null,
      turn: tag?.turn ?? null,
      thought: tag?.thought ?? null,
      label: tag?.label ?? null,
      repair: tag?.repair ?? null,
      text_chars: 0,
      reasoning_chars: 0,
      tool_calls: 0,
      has_detail: true,
    };
    this.#calls.push(record);
    while (this.#calls.length > this.maxCalls) {
      const old = this.#calls.shift();
      if (old) {
        this.#dropDetail(old.id);
        this.#dropThinking(old.id);
      }
    }
    const detail: LlmCallDetail = {
      messages: request.messages.map(messageView),
      tools: record.tools,
      response: { text: "", reasoning: "", tool_calls: [], cut: 0 },
    };
    this.#details.set(id, detail);
    this.#detailChars += detailChars(detail);
    this.#trim();
    return record;
  }

  /** Sets the response of `id` (redacted, clipped). */
  respond(id: string, text: string, reasoning: string, toolCalls: ToolCall[]): void {
    const record = this.get(id);
    if (record) {
      record.text_chars = text.length;
      record.reasoning_chars = reasoning.length;
      record.tool_calls = toolCalls.length;
    }
    if (record) this.#keepThinking(id, text, reasoning, toolCalls);
    const d = this.#details.get(id);
    if (!d) return;
    this.#detailChars -= detailChars(d);
    const t = clip(redactSecrets(text), MAX_RESPONSE_CHARS);
    const r = clip(redactSecrets(reasoning), MAX_RESPONSE_CHARS);
    d.response = {
      text: t.text,
      reasoning: r.text,
      tool_calls: toolCalls.map((c) => ({ ...c, arguments: redactSecrets(c.arguments) })),
      cut: t.cut + r.cut,
    };
    this.#detailChars += detailChars(d);
    this.#trim();
  }

  #keepThinking(id: string, text: string, reasoning: string, toolCalls: ToolCall[]): void {
    this.#dropThinking(id);
    const r = clip(redactSecrets(reasoning), MAX_RESPONSE_CHARS);
    const a = clip(redactSecrets(text), MAX_THINKING_ANSWER_CHARS);
    const entry: ThinkingEntry = {
      reasoning: r.text,
      answer: a.text,
      tool_calls: toolCalls.map((c) => c.name),
      cut: r.cut + a.cut,
    };
    this.#thinking.set(id, entry);
    this.#thinkingChars += entry.reasoning.length + entry.answer.length;
    while (
      this.#thinking.size > this.maxThinking ||
      (this.#thinkingChars > this.maxThinkingChars && this.#thinking.size > 1)
    ) {
      const oldest = this.#thinking.keys().next().value;
      if (oldest === undefined) break;
      this.#dropThinking(oldest);
    }
  }

  #dropThinking(id: string): void {
    const t = this.#thinking.get(id);
    if (!t) return;
    this.#thinkingChars -= t.reasoning.length + t.answer.length;
    this.#thinking.delete(id);
  }

  #dropDetail(id: string): void {
    const d = this.#details.get(id);
    if (!d) return;
    this.#detailChars -= detailChars(d);
    this.#details.delete(id);
    const record = this.get(id);
    if (record) record.has_detail = false;
  }

  #trim(): void {
    while (
      this.#details.size > this.maxDetails ||
      (this.#detailChars > this.maxDetailChars && this.#details.size > 1)
    ) {
      const oldest = this.#details.keys().next().value;
      if (oldest === undefined) break;
      this.#dropDetail(oldest);
    }
  }

  get(id: string): LlmCallRecord | undefined {
    for (let i = this.#calls.length - 1; i >= 0; i--) {
      const c = this.#calls[i] as LlmCallRecord;
      if (c.id === id) return c;
    }
    return undefined;
  }

  detail(id: string): LlmCallDetail | null {
    const d = this.#details.get(id);
    return d ? structuredClone(d) : null;
  }

  #matches(c: LlmCallRecord, f: LlmCallFilter): boolean {
    if (f.kind && c.kind !== f.kind) return false;
    if (f.reasoned && c.reasoning_chars === 0) return false;
    if (f.purpose && c.purpose !== f.purpose) return false;
    if (f.model && c.model !== f.model) return false;
    if (f.module && (c.module ?? "") !== f.module) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.trouble && c.status !== "error" && c.fallbacks.length === 0 && c.retries.length === 0)
      return false;
    if (f.thought && c.thought !== f.thought) return false;
    if (f.turn && c.turn !== f.turn) return false;
    if (f.since && c.at < f.since) return false;
    if (f.until && c.at > f.until) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const hay = [c.purpose, c.model, c.label, c.module, c.error, c.finish_reason, c.id]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) {
        const t = this.#thinking.get(c.id);
        const d = this.#details.get(c.id);
        if (!d && !t) return false;
        const text = [
          d?.response.text ?? "",
          ...(d?.messages.map((m) => m.content) ?? []),
          t?.reasoning ?? "",
          t?.answer ?? "",
        ]
          .join("\n")
          .toLowerCase();
        if (!text.includes(q)) return false;
      }
    }
    return true;
  }

  /** Matching calls, newest first; `before` is the id of the last one already shown. */
  list(
    filter: LlmCallFilter = {},
    limit = 100,
    before?: string,
  ): { items: LlmCallRecord[]; next_cursor: string | null; matched: number } {
    const all: LlmCallRecord[] = [];
    for (let i = this.#calls.length - 1; i >= 0; i--) {
      const c = this.#calls[i] as LlmCallRecord;
      if (this.#matches(c, filter)) all.push(c);
    }
    let start = 0;
    if (before) {
      const at = all.findIndex((c) => c.id === before);
      start = at < 0 ? all.length : at + 1;
    }
    const items = all.slice(start, start + limit).map((c) => structuredClone(c));
    const last = items[items.length - 1];
    return {
      items,
      next_cursor: start + limit < all.length && last ? last.id : null,
      matched: all.length,
    };
  }

  /**
   * Matching calls with their reasoning and answer, newest first (`before` as in `list`), and
   * how many calls of each kind match the rest of the filter.
   */
  thinking(filter: LlmCallFilter = {}, limit = 50, before?: string): LlmThinkingPage {
    const page = this.list(filter, limit, before);
    const rest: LlmCallFilter = { ...filter, kind: undefined, reasoned: undefined };
    const kinds = new Map<LlmCallKind, { calls: number; reasoned: number }>();
    for (const c of this.#calls) {
      if (!this.#matches(c, rest)) continue;
      const k = kinds.get(c.kind) ?? { calls: 0, reasoned: 0 };
      k.calls += 1;
      if (c.reasoning_chars > 0) k.reasoned += 1;
      kinds.set(c.kind, k);
    }
    return {
      items: page.items.map((call) => {
        const t = this.#thinking.get(call.id);
        return {
          call,
          reasoning: t?.reasoning ?? null,
          answer: t?.answer ?? null,
          tool_calls: t ? [...t.tool_calls] : [],
          cut: t?.cut ?? 0,
        };
      }),
      next_cursor: page.next_cursor,
      matched: page.matched,
      by_kind: CALL_KINDS.filter((k) => kinds.has(k)).map((kind) => ({
        kind,
        ...(kinds.get(kind) as { calls: number; reasoned: number }),
      })),
    };
  }

  /** Every recorded call of thought `id` or turn `turn`, oldest first. */
  forThought(id: string): LlmCallRecord[] {
    return this.#calls.filter((c) => c.thought === id).map((c) => structuredClone(c));
  }

  /** Breakdowns of the calls since `since` (ISO), or of every kept call. */
  stats(since: string | null = null, filter: LlmCallFilter = {}): LlmCallStats {
    const calls = this.#calls.filter(
      (c) =>
        (since === null || c.at >= since) && c.status !== "streaming" && this.#matches(c, filter),
    );
    const hours = new Map<string, LlmCallRecord[]>();
    for (const c of calls) {
      const d = new Date(c.at);
      d.setUTCMinutes(0, 0, 0);
      const k = d.toISOString();
      const list = hours.get(k);
      if (list) list.push(c);
      else hours.set(k, [c]);
    }
    const byHour: LlmHourStats[] = [...hours.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([hour, list]) => {
        const g = group(hour, list);
        const byPurpose: Record<string, number> = {};
        for (const c of list)
          byPurpose[c.purpose] = (byPurpose[c.purpose] ?? 0) + (c.cost_usd ?? 0);
        return {
          hour,
          calls: g.calls,
          errors: g.errors,
          prompt_tokens: g.prompt_tokens,
          cached_prompt_tokens: g.cached_prompt_tokens,
          completion_tokens: g.completion_tokens,
          cost_usd: g.cost_usd,
          by_purpose: byPurpose,
        };
      });
    const firsts = calls
      .filter((c) => c.status === "ok" && c.first_token_ms !== null)
      .map((c) => c.first_token_ms as number);
    const latency = LATENCY_BOUNDS.map((le) => ({ le_ms: le, count: 0 }));
    latency.push({ le_ms: Number.MAX_SAFE_INTEGER, count: 0 });
    for (const ms of firsts) {
      const b = latency.find((x) => ms <= x.le_ms);
      if (b) b.count += 1;
    }
    const errorKinds = counts(
      calls.filter((c) => c.status === "error").map((c) => c.error_kind ?? "error"),
    );
    const reasons = counts(
      calls.filter((c) => c.status === "ok").map((c) => c.finish_reason ?? "unknown"),
    );
    const top = (f: (c: LlmCallRecord) => number) =>
      [...calls]
        .sort((a, b) => f(b) - f(a))
        .slice(0, 10)
        .filter((c) => f(c) > 0)
        .map((c) => structuredClone(c));
    return {
      since,
      total: group("all", calls),
      by_purpose: groups(calls, (c) => c.purpose),
      by_model: groups(calls, (c) => c.model ?? "—"),
      by_module: groups(calls, (c) => c.module ?? "—"),
      by_hour: byHour,
      latency,
      errors: [...errorKinds.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count),
      finish_reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      expensive: top((c) => c.cost_usd ?? 0),
      slowest: top((c) => (c.status === "ok" ? (c.total_ms ?? 0) : 0)),
      kept: this.#calls.length,
      oldest: this.#calls[0]?.at ?? null,
    };
  }

  get size(): number {
    return this.#calls.length;
  }
}

/** `Usage` as a call record keeps it. */
export function callUsage(u: Usage): LlmCallUsage {
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    cached_prompt_tokens: Math.min(u.cached_prompt_tokens ?? 0, u.prompt_tokens),
    reasoning_tokens: u.reasoning_tokens ?? null,
  };
}
