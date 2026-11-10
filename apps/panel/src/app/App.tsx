import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { describeError, isApiError } from "@/api/http";
import type { Api } from "@/api/endpoints";
import type { AuthMethods, MemberSession, SessionInfo } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TokenGate } from "@/pages/login/TokenGate";
import { CardVerify, cardSerialIn } from "@/pages/public/CardVerify";
import { PublicSite } from "@/pages/public/PublicSite";
import { isLivePath, LivePage } from "@/pages/public/live/LivePage";
import { Backdrop } from "./Backdrop";
import { ConnectionProvider, useConnection } from "./connection";
import { EventStreamProvider } from "./events-store";
import { createQueryClient } from "./queries";
import { type AppRouter, createAppRouter } from "./router";
import {
  loginErrorMessage,
  SessionProvider,
  type SessionValue,
  TOKEN_SESSION,
  loginErrorIn,
  wantsTokenLogin,
} from "./session";

type AuthState =
  | { status: "checking" }
  /** `rejected`: the saved token stopped working; `expired`: the Discord session ended. */
  | { status: "signed_out"; reason?: "rejected" | "expired" }
  | { status: "signed_in"; session: SessionInfo }
  /**
   * Not an admin. Someone logged in (`member`) sees their page; anyone else, the login screen.
   */
  | { status: "public"; member: MemberSession | null };

/**
 * Who sees the public site, or `null` when this Core has none (older, or switched off): then the
 * login screen is all there is. Being unable to reach it says nothing about it, so that is `null`
 * too, and the login screen shows what is wrong.
 */
async function publicVisitor(api: Api, signal: AbortSignal): Promise<{ member: MemberSession | null } | null> {
  const [site, member] = await Promise.allSettled([api.publicStatus({ signal }), api.memberSession({ signal })]);
  const open = site.status === "fulfilled" || (isApiError(site.reason) && site.reason.status === 429);
  if (!open) return null;
  return { member: member.status === "fulfilled" ? member.value : null };
}

/** Where an admin signed in with Discord finds their own member page. */
export const OWN_PAGE = "/me";

/** The page's path and query from the router's history (`/card/MYR-…`, `/me`, `/login?error=…`). */
function pathOf(router: AppRouter): string {
  const { pathname, search } = router.history.location;
  return `${pathname || "/"}${search}`;
}

function OwnPage({ onLogout, onBack }: { onLogout: () => void; onBack: () => void }) {
  const { api } = useConnection();
  const member = useQuery({ queryKey: ["member", "session"], queryFn: ({ signal }) => api.memberSession({ signal }) });
  if (member.data) return <PublicSite member={member.data} onLogout={onLogout} onBack={onBack} />;
  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      {member.isError ? (
        <div className="glass-float grid max-w-sm gap-3 rounded-lg p-5 text-sm">
          <p>沒辦法讀到你的頁面:{describeError(member.error)}</p>
          <Button variant="outline" onClick={onBack}>
            回到管理面板
          </Button>
        </div>
      ) : (
        <div className="min-h-svh" aria-busy="true" aria-label="讀取你的頁面中" />
      )}
    </div>
  );
}

function Authenticated({ router }: { router: AppRouter }) {
  const { config, api, signOut } = useConnection();
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const path = useSyncExternalStore(router.history.subscribe, () => pathOf(router));
  const [tokenLogin, setTokenLogin] = useState(() => wantsTokenLogin(pathOf(router)));
  const [loginError, setLoginError] = useState<string | null>(() => loginErrorIn(pathOf(router)));
  const [recheck, setRecheck] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;

  // Any 401 means the token changed or the session ended: back to the login screen.
  const [queryClient] = useState(() =>
    createQueryClient((error) => {
      if (!isApiError(error) || error.kind !== "unauthorized") return;
      const current = authRef.current;
      if (current.status === "public" && current.member !== null) {
        setAuth({ status: "public", member: null });
        return;
      }
      if (current.status !== "signed_in") return;
      setAuth({ status: "signed_out", reason: current.session.method === "discord" ? "expired" : "rejected" });
    }),
  );

  // Who are we? Asked on load and whenever the URL or token changes.
  useEffect(() => {
    const ctl = new AbortController();
    const { signal } = ctl;
    setAuth({ status: "checking" });
    void (async () => {
      const [m, s] = await Promise.allSettled([api.authMethods({ signal }), api.session({ signal })]);
      if (signal.aborted) return;
      setMethods(m.status === "fulfilled" ? m.value : null);
      if (s.status === "fulfilled") {
        setAuth({ status: "signed_in", session: s.value });
        return;
      }
      const e: unknown = s.reason;
      const unauthorized = isApiError(e) && e.kind === "unauthorized";
      // A saved token on an older or unreachable Core: carry on as before
      // (the shell shows the Core as unreachable).
      if (config.token && !unauthorized) {
        setAuth({ status: "signed_in", session: TOKEN_SESSION });
        return;
      }
      if (config.token) {
        setAuth({ status: "signed_out", reason: "rejected" });
        return;
      }
      const visitor = await publicVisitor(api, signal);
      if (signal.aborted) return;
      setAuth(visitor ? { status: "public", member: visitor.member } : { status: "signed_out" });
    })();
    return () => ctl.abort();
  }, [api, config.token, recheck]);

  // A new URL or token invalidates everything cached for the old one.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    queryClient.clear();
  }, [config.baseUrl, config.token, queryClient]);

  // A failed Discord login's `/login?error=…` is read once, then the address goes back to `/`, so
  // the router never sees the login path and a reload does not show the error again.
  useEffect(() => {
    if (loginErrorIn(path) !== null) router.history.replace("/");
  }, [path, router]);

  // `/login` is how the owner reaches the token form from a member's page.
  useEffect(() => {
    if (wantsTokenLogin(path)) setTokenLogin(true);
  }, [path]);

  const logout = useCallback(() => {
    const current = authRef.current;
    const method = current.status === "signed_in" ? current.session.method : current.status === "public" ? "discord" : "token";
    queryClient.clear();
    if (method === "discord") {
      void api
        .logout()
        .catch(() => undefined)
        .finally(() => setRecheck((n) => n + 1));
    } else {
      signOut();
    }
  }, [api, queryClient, signOut]);

  const sessionValue = useMemo<SessionValue | null>(
    () => (auth.status === "signed_in" ? { session: auth.session, logout } : null),
    [auth, logout],
  );

  // A card's code leads here; anyone may check one, logged in or not.
  const serial = cardSerialIn(path);
  if (serial !== null) {
    return (
      <QueryClientProvider client={queryClient}>
        <CardVerify serial={serial} />
      </QueryClientProvider>
    );
  }

  // Her live page; anyone may watch, logged in or not.
  if (isLivePath(path)) {
    return (
      <QueryClientProvider client={queryClient}>
        <LivePage />
      </QueryClientProvider>
    );
  }

  if (auth.status === "checking") {
    return <div className="min-h-svh" aria-busy="true" aria-label="確認登入狀態中" />;
  }

  // An admin who logged in with Discord is a member too, with a page of their own.
  if (auth.status === "signed_in" && auth.session.method === "discord" && (path === OWN_PAGE || path.startsWith(`${OWN_PAGE}?`))) {
    return (
      <QueryClientProvider client={queryClient}>
        <OwnPage
          onLogout={logout}
          onBack={() => router.history.push("/")}
        />
      </QueryClientProvider>
    );
  }

  if (auth.status === "public" && auth.member !== null && !tokenLogin) {
    return (
      <QueryClientProvider client={queryClient}>
        <PublicSite
          member={auth.member}
          notice={loginError === null ? null : loginErrorMessage(loginError)}
          onLogout={logout}
        />
      </QueryClientProvider>
    );
  }

  if (auth.status === "signed_out" || auth.status === "public" || !sessionValue) {
    return (
      <TokenGate
        rejected={auth.status === "signed_out" && auth.reason === "rejected"}
        expired={auth.status === "signed_out" && auth.reason === "expired"}
        discord={methods?.discord ?? false}
        error={loginError}
        // Someone at the door is most likely a member: the token form is for the owner.
        tokenOpen={tokenLogin || auth.status !== "public"}
        onSaved={() => {
          setLoginError(null);
          setTokenLogin(false);
          setRecheck((n) => n + 1);
        }}
      />
    );
  }

  return (
    <SessionProvider value={sessionValue}>
      <QueryClientProvider client={queryClient}>
        <EventStreamProvider>
          <RouterProvider router={router} />
        </EventStreamProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}

export function App({ router }: { router?: AppRouter }) {
  const [r] = useState(() => router ?? createAppRouter());
  return (
    <ConnectionProvider>
      <TooltipProvider>
        <Backdrop />
        <Authenticated router={r} />
        <Toaster />
      </TooltipProvider>
    </ConnectionProvider>
  );
}
