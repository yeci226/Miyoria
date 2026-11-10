import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { ConnectionProvider } from "@/app/connection";
import { EventStore, EventStoreContext } from "@/app/events-store";
import { createQueryClient } from "@/app/queries";
import { createAppRouter } from "@/app/router";
import { SessionProvider, type SessionValue } from "@/app/session";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export type Handler = (
  method: string,
  url: URL,
  body: unknown,
  headers: Headers,
) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | undefined;

/** Stubs `fetch` with a router-like handler; unknown routes answer like the Core's fallback. */
export function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://panel.test");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const res = handler(init?.method ?? "GET", url, body, new Headers(init?.headers)) ?? { status: 404, body: { error: "no such endpoint" } };
    const text = res.text ?? (res.body === undefined ? "" : JSON.stringify(res.body));
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : text, {
      status,
      headers: { "content-type": "application/json", ...res.headers },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const writer: SessionValue = {
  session: { method: "token", user: null, permissions: { write: true } },
  logout: () => {},
};

export function testQueryClient(): QueryClient {
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false, refetchInterval: false, staleTime: Infinity } });
  return qc;
}

function Providers({
  store,
  session,
  queryClient,
  children,
}: {
  store: EventStore;
  session?: SessionValue;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  const inner = (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <EventStoreContext.Provider value={store}>{children}</EventStoreContext.Provider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
  return (
    <ConnectionProvider initial={{ baseUrl: "", token: "t0ken" }}>
      {session ? <SessionProvider value={session}>{inner}</SessionProvider> : inner}
    </ConnectionProvider>
  );
}

/** Renders `ui` inside every provider a page needs, at a memory route. */
export function renderPage(ui: ReactNode, opts: { store?: EventStore; session?: SessionValue } = {}) {
  const store = opts.store ?? new EventStore(0);
  const root = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{ui}</> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = testQueryClient();
  const utils = render(
    <Providers store={store} session={opts.session} queryClient={queryClient}>
      <RouterProvider router={router as never} />
    </Providers>,
  );
  return { ...utils, store, queryClient };
}

/** Renders the whole app (shell + routes) at `path`, signed in, without the login round trip. */
export function renderRoute(path: string, opts: { store?: EventStore; session?: SessionValue } = {}) {
  const store = opts.store ?? new EventStore(0);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = testQueryClient();
  const utils = render(
    <Providers store={store} session={opts.session ?? writer} queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...utils, store, router, queryClient };
}
