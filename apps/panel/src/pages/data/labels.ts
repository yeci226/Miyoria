import type { DataCategoryId, DataCategoryView, DataNote } from "@/api/types";
import type { NavPath } from "@/app/nav";

export const CATEGORY_LABEL: Record<DataCategoryId, string> = {
  memories: "記憶",
  relationships: "關係",
  call_names: "稱呼",
  inner: "內在狀態與感情",
  knowledge: "她整理的資料",
  learning: "反思與學到的事",
  conversation: "對話筆記",
  mood: "心情",
  messages: "聊天紀錄",
  decisions: "決策紀錄",
  initiative: "主動發話狀態",
  people: "人物與帳號連結",
  channels: "頻道設定",
  voice_consent: "語音同意",
  event_log: "事件日誌",
  directives: "主人規則",
  privacy: "隱私設定",
  queue: "點播佇列",
  roles: "角色與權限",
  persona: "Persona 修改",
  proposed_tools: "她提議的工具",
  extensions: "擴充套件資料",
  module_state: "模組開關",
  other_settings: "其他設定",
  tools_workspace: "工具工作區",
  audit: "稽核紀錄",
  llm_usage: "LLM 用量",
  panel_sessions: "面板登入",
};

export const MEMORY_KIND_LABEL: Record<string, string> = {
  fact: "事實",
  episode: "經歷",
  self_note: "她的筆記",
  followup: "之後要問",
};

export const NOTE_TEXT: Record<DataNote, string> = {
  restart_core: "Persona 與模組開關在 Core 重新啟動後才會回到設定值。",
  consent_cache: "語音同意最多一分鐘後生效。",
};

/** Where a category can be looked at in detail. */
export const VIEW_LINK: Partial<Record<DataCategoryId, { to: NavPath; search?: Record<string, string> }>> = {
  memories: { to: "/character", search: { tab: "memory" } },
  relationships: { to: "/character", search: { tab: "people" } },
  call_names: { to: "/character", search: { tab: "people" } },
  people: { to: "/character", search: { tab: "people" } },
  persona: { to: "/character", search: { tab: "persona" } },
  inner: { to: "/inner", search: { tab: "feelings" } },
  knowledge: { to: "/inner", search: { tab: "knowledge" } },
  learning: { to: "/inner", search: { tab: "reflection" } },
  conversation: { to: "/inner", search: { tab: "knowledge" } },
  mood: { to: "/inner", search: { tab: "state" } },
  decisions: { to: "/activity", search: { tab: "decisions" } },
  queue: { to: "/live" },
  roles: { to: "/access" },
  module_state: { to: "/system", search: { tab: "modules" } },
  extensions: { to: "/system", search: { tab: "extensions" } },
};

/** `id` plus everything deleting it takes along, in inventory order. */
export function withRequired(id: DataCategoryId, all: DataCategoryView[]): DataCategoryView[] {
  const want = new Set<DataCategoryId>();
  const add = (x: DataCategoryId) => {
    if (want.has(x)) return;
    want.add(x);
    for (const r of all.find((c) => c.id === x)?.requires ?? []) add(r);
  };
  add(id);
  return all.filter((c) => want.has(c.id));
}

/** Memories by kind, as one short line. */
export function breakdownText(breakdown: Record<string, number> | null): string | null {
  if (!breakdown) return null;
  const parts = Object.entries(breakdown)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${MEMORY_KIND_LABEL[kind] ?? kind} ${n}`);
  return parts.length > 0 ? parts.join("・") : null;
}
