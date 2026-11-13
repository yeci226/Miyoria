import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import type { LlmCallKind } from "@/api/types";
import { NotFoundPage } from "@/pages/NotFound";
import {
  ACTIVITY_TABS,
  type ActivityTab,
  CHARACTER_TABS,
  ECONOMY_TABS,
  type EconomyTab,
  type CharacterTab,
  INNER_TABS,
  type InnerTab,
  LIFE_TABS,
  type LifeTab,
  LLM_TABS,
  type LlmTab,
  oneOf,
  SYSTEM_TABS,
  type SystemTab,
} from "./nav";
import { Shell } from "./Shell";

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFoundPage });

// Each page is its own chunk, fetched when it is first opened: the public site and the sign-in
// screen load without the panel's pages, and the panel loads only the page it opens on.
const OverviewPage = lazyRouteComponent(() => import("@/pages/overview/OverviewPage"), "OverviewPage");
const ActivityPage = lazyRouteComponent(() => import("@/pages/activity/ActivityPage"), "ActivityPage");
const LivePage = lazyRouteComponent(() => import("@/pages/live/LivePage"), "LivePage");
const CharacterPage = lazyRouteComponent(() => import("@/pages/character/CharacterPage"), "CharacterPage");
const InnerPage = lazyRouteComponent(() => import("@/pages/inner/InnerPage"), "InnerPage");
const LifePage = lazyRouteComponent(() => import("@/pages/life/LifePage"), "LifePage");
const EconomyPage = lazyRouteComponent(() => import("@/pages/economy/EconomyPage"), "EconomyPage");
const LlmPage = lazyRouteComponent(() => import("@/pages/llm/LlmPage"), "LlmPage");
const SystemPage = lazyRouteComponent(() => import("@/pages/system/SystemPage"), "SystemPage");
const RulesPage = lazyRouteComponent(() => import("@/pages/rules/RulesPage"), "RulesPage");
const EvalPage = lazyRouteComponent(() => import("@/pages/eval/EvalPage"), "EvalPage");
const AccessPage = lazyRouteComponent(() => import("@/pages/access/AccessPage"), "AccessPage");
const DataPage = lazyRouteComponent(() => import("@/pages/data/DataPage"), "DataPage");
const SettingsPage = lazyRouteComponent(() => import("@/pages/settings/SettingsPage"), "SettingsPage");

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  validateSearch: (s: Record<string, unknown>): { tab?: ActivityTab; turn?: string } => ({
    tab: oneOf(ACTIVITY_TABS, s.tab),
    turn: str(s.turn),
  }),
  component: ActivityPage,
});

export const characterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/character",
  validateSearch: (s: Record<string, unknown>): { tab?: CharacterTab; person?: string } => ({
    tab: oneOf(CHARACTER_TABS, s.tab),
    person: str(s.person),
  }),
  component: CharacterPage,
});

export const innerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inner",
  validateSearch: (s: Record<string, unknown>): { tab?: InnerTab; thought?: string } => ({
    tab: oneOf(INNER_TABS, s.tab),
    thought: str(s.thought),
  }),
  component: InnerPage,
});

export const lifeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/life",
  validateSearch: (s: Record<string, unknown>): { tab?: LifeTab } => ({ tab: oneOf(LIFE_TABS, s.tab) }),
  component: LifePage,
});

export const economyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/economy",
  validateSearch: (s: Record<string, unknown>): { tab?: EconomyTab } => ({ tab: oneOf(ECONOMY_TABS, s.tab) }),
  component: EconomyPage,
});

export interface LlmSearch {
  tab?: LlmTab;
  /** The call open in the sheet. */
  call?: string;
  thought?: string;
  turn?: string;
  purpose?: string;
  model?: string;
  module?: string;
  status?: "ok" | "error" | "aborted" | "streaming";
  trouble?: boolean;
  q?: string;
  /** The kind of call the chain-of-thought tab shows. */
  kind?: LlmCallKind;
}

const STATUSES = ["ok", "error", "aborted", "streaming"] as const;
const LLM_KINDS: readonly LlmCallKind[] = ["mind", "chat", "voice", "attention", "memory", "learning", "social", "other"];

export const llmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/llm",
  validateSearch: (s: Record<string, unknown>): LlmSearch => ({
    tab: oneOf(LLM_TABS, s.tab),
    call: str(s.call),
    thought: str(s.thought),
    turn: str(s.turn),
    purpose: str(s.purpose),
    model: str(s.model),
    module: str(s.module),
    status: STATUSES.find((x) => x === s.status),
    trouble: s.trouble === true || s.trouble === "true" ? true : undefined,
    q: str(s.q),
    kind: LLM_KINDS.find((x) => x === s.kind),
  }),
  component: LlmPage,
});

export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  validateSearch: (s: Record<string, unknown>): { tab?: SystemTab; q?: string } => ({
    tab: oneOf(SYSTEM_TABS, s.tab),
    q: str(s.q),
  }),
  component: SystemPage,
});

/** Old bookmarks (one page per feature) land on the merged pages. */
const moved = (path: string, to: string, search: Record<string, string> = {}) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, search } as never);
    },
  });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  activityRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/live", component: LivePage }),
  characterRoute,
  innerRoute,
  lifeRoute,
  economyRoute,
  llmRoute,
  systemRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/rules", component: RulesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/eval", component: EvalPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/access", component: AccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/data", component: DataPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  moved("/events", "/activity", { tab: "events" }),
  moved("/decisions", "/activity", { tab: "decisions" }),
  moved("/voice", "/activity", { tab: "transcript" }),
  moved("/persona", "/character", { tab: "persona" }),
  moved("/memory", "/character", { tab: "memory" }),
  moved("/people", "/character", { tab: "people" }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/people/$personId",
    beforeLoad: ({ params }) => {
      throw redirect({ to: "/character", search: { tab: "people", person: params.personId } });
    },
  }),
  moved("/queue", "/live"),
  moved("/stage", "/live"),
  moved("/modules", "/system", { tab: "modules" }),
  moved("/extensions", "/system", { tab: "extensions" }),
  moved("/mcp", "/system", { tab: "mcp" }),
  moved("/calls", "/llm", { tab: "calls" }),
  moved("/roles", "/access"),
]);

/**
 * Clean addresses (`/activity`, `/card/MYR-…`): the Core answers any page path without a file
 * extension with `index.html` (`packages/api/src/panel.ts`).
 */
export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false, scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
