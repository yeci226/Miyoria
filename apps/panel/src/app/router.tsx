import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { AccessPage } from "@/pages/access/AccessPage";
import { ActivityPage } from "@/pages/activity/ActivityPage";
import { CharacterPage } from "@/pages/character/CharacterPage";
import { DataPage } from "@/pages/data/DataPage";
import { EconomyPage } from "@/pages/economy/EconomyPage";
import { EvalPage } from "@/pages/eval/EvalPage";
import { InnerPage } from "@/pages/inner/InnerPage";
import { LifePage } from "@/pages/life/LifePage";
import { LivePage } from "@/pages/live/LivePage";
import { LlmPage } from "@/pages/llm/LlmPage";
import { NotFoundPage } from "@/pages/NotFound";
import { OverviewPage } from "@/pages/overview/OverviewPage";
import { RulesPage } from "@/pages/rules/RulesPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { SystemPage } from "@/pages/system/SystemPage";
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
}

const STATUSES = ["ok", "error", "aborted", "streaming"] as const;

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
