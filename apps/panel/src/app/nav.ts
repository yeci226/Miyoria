import {
  Activity,
  Clapperboard,
  Cpu,
  Database,
  Gauge,
  HeartPulse,
  type LucideIcon,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Target,
  UserRound,
} from "lucide-react";

export type NavPath =
  | "/"
  | "/activity"
  | "/live"
  | "/character"
  | "/inner"
  | "/rules"
  | "/llm"
  | "/eval"
  | "/system"
  | "/access"
  | "/data"
  | "/settings";

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
  /** Tabs of the page, for the command palette. */
  tabs?: { tab: string; label: string }[];
}

export const ACTIVITY_TABS = [
  { tab: "turns", label: "回合" },
  { tab: "events", label: "事件" },
  { tab: "decisions", label: "決策" },
  { tab: "transcript", label: "轉錄" },
  { tab: "body", label: "活動" },
  { tab: "ledger", label: "帳本" },
  { tab: "prompts", label: "提示詞" },
] as const;

export const CHARACTER_TABS = [
  { tab: "persona", label: "Persona" },
  { tab: "memory", label: "記憶" },
  { tab: "people", label: "人" },
] as const;

export const INNER_TABS = [
  { tab: "state", label: "狀態" },
  { tab: "affect", label: "情緒" },
  { tab: "feelings", label: "感情" },
  { tab: "goals", label: "目標" },
  { tab: "world", label: "世界" },
  { tab: "thoughts", label: "想法" },
  { tab: "knowledge", label: "知識" },
  { tab: "reflection", label: "反思" },
] as const;

export const LLM_TABS = [
  { tab: "overview", label: "概況" },
  { tab: "calls", label: "呼叫" },
  { tab: "prices", label: "價格與用量" },
] as const;

export const SYSTEM_TABS = [
  { tab: "modules", label: "子系統" },
  { tab: "extensions", label: "擴充套件" },
  { tab: "mcp", label: "MCP" },
] as const;

export type ActivityTab = (typeof ACTIVITY_TABS)[number]["tab"];
export type CharacterTab = (typeof CHARACTER_TABS)[number]["tab"];
export type SystemTab = (typeof SYSTEM_TABS)[number]["tab"];
export type InnerTab = (typeof INNER_TABS)[number]["tab"];
export type LlmTab = (typeof LLM_TABS)[number]["tab"];

/** The sidebar: pages in the groups the header names as `分類 / 頁面`. */
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "現場",
    items: [
      { to: "/", label: "總覽", icon: Gauge },
      { to: "/live", label: "直播", icon: Clapperboard },
      { to: "/activity", label: "動態", icon: Activity, tabs: [...ACTIVITY_TABS] },
    ],
  },
  {
    label: "她",
    items: [
      { to: "/inner", label: "內心", icon: HeartPulse, tabs: [...INNER_TABS] },
      { to: "/character", label: "角色", icon: UserRound, tabs: [...CHARACTER_TABS] },
      { to: "/rules", label: "規則", icon: Shield },
    ],
  },
  {
    label: "運作",
    items: [
      { to: "/llm", label: "LLM", icon: Cpu, tabs: [...LLM_TABS] },
      { to: "/system", label: "系統", icon: Server, tabs: [...SYSTEM_TABS] },
      { to: "/eval", label: "評測", icon: Target },
    ],
  },
  {
    label: "管理",
    items: [
      { to: "/access", label: "權限", icon: ShieldCheck },
      { to: "/data", label: "資料", icon: Database },
      { to: "/settings", label: "設定", icon: Settings },
    ],
  },
];

export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export const isActive = (to: NavPath, path: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));

export function titleFor(path: string): string {
  return NAV.find((i) => isActive(i.to, path))?.label ?? "Miyoria";
}

export function groupFor(path: string): string | null {
  return NAV_GROUPS.find((g) => g.items.some((i) => isActive(i.to, path)))?.label ?? null;
}

/** Narrows a search param to one of `values`, else `undefined`. */
export function oneOf<T extends string>(values: readonly { tab: T }[], v: unknown): T | undefined {
  return values.some((x) => x.tab === v) ? (v as T) : undefined;
}
