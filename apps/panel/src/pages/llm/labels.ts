import type { LlmCallKind, LlmCallRecord, LlmCallStatus, LlmPricing } from "@/api/types";
import type { Tone } from "@/components/status";

/** Purposes in words; unknown ones show their key. */
export const PURPOSE_LABEL: Record<string, string> = {
  chat: "聊天回覆",
  mind: "內心想法",
  fast: "快速判斷",
  summarizer: "摘要",
  review: "自我審查",
  game: "遊戲",
  vision: "看圖",
  translate: "翻譯",
  reflection: "反思",
  learning: "學習",
  memory: "記憶",
  appraisal: "關係評估",
};

export const MODULE_LABEL: Record<string, string> = {
  agent: "回話",
  mind: "內心",
  memory: "記憶",
  social: "關係",
  learning: "學習",
  actions: "動作審核",
  stage: "舞台",
  voice: "語音",
  game: "遊戲",
};

/** Kinds of call in words, in the order the chain-of-thought tab lists them. */
export const KIND_LABEL: Record<LlmCallKind, string> = {
  mind: "內心想法",
  chat: "文字聊天",
  voice: "語音",
  attention: "要不要回",
  memory: "記憶",
  learning: "學習",
  social: "關係",
  other: "其他",
};

export const STATUS_LABEL: Record<LlmCallStatus, string> = {
  ok: "成功",
  error: "錯誤",
  aborted: "中斷",
  streaming: "進行中",
};

export const STATUS_TONE: Record<LlmCallStatus, Tone> = {
  ok: "success",
  error: "danger",
  aborted: "warning",
  streaming: "brand",
};

export const FINISH_LABEL: Record<string, string> = {
  stop: "正常結束",
  length: "被長度截斷",
  tool_calls: "呼叫工具",
  content_filter: "內容過濾",
  unknown: "沒有回報",
};

export const ERROR_LABEL: Record<string, string> = {
  connect_timeout: "連線逾時",
  timeout: "逾時",
  http_4xx: "HTTP 4xx",
  http_5xx: "HTTP 5xx",
  aborted: "取消",
  error: "其他錯誤",
};

export const purposeLabel = (p: string) => PURPOSE_LABEL[p] ?? p;
export const moduleLabel = (m: string | null) => (m === null || m === "—" ? "未標記" : (MODULE_LABEL[m] ?? m));

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** USD with enough digits for fractions of a cent. */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export const fmtPerMtok = (v: number | null) => (v === null ? "—" : `$${v.toFixed(v < 1 ? 3 : 2)}`);

/** The cost of a call, line by line, from the price it was charged at. */
export function costLines(call: LlmCallRecord): { label: string; tokens: number; price: number; usd: number }[] | null {
  const u = call.usage;
  const p: LlmPricing | null = call.pricing;
  if (!u || !p) return null;
  const cached = Math.min(u.cached_prompt_tokens, u.prompt_tokens);
  const cachedPrice = p.cached_input_per_mtok ?? p.input_per_mtok;
  return [
    { label: "輸入(未快取)", tokens: u.prompt_tokens - cached, price: p.input_per_mtok, usd: ((u.prompt_tokens - cached) * p.input_per_mtok) / 1e6 },
    { label: "輸入(快取命中)", tokens: cached, price: cachedPrice, usd: (cached * cachedPrice) / 1e6 },
    { label: "輸出", tokens: u.completion_tokens, price: p.output_per_mtok, usd: (u.completion_tokens * p.output_per_mtok) / 1e6 },
  ];
}

/** Cache hit rate of prompt tokens, 0..1. */
export const hitRate = (prompt: number, cached: number) => (prompt > 0 ? Math.min(cached, prompt) / prompt : 0);
