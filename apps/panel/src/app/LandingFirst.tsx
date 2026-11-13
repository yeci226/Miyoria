import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { Backdrop } from "./Backdrop";
import { ConnectionProvider, useConnection } from "./connection";
import { createQueryClient } from "./query-client";
import { isSameOrigin } from "./session";
import { checkVisitor, type Visitor } from "./visitor";

/** Her tank: the landing for someone not logged in. Split out with its fonts and water. */
const Landing = lazy(() => import("@/pages/public/landing/Landing"));

/** While the landing loads. */
export function LandingFallback() {
  return <div className="min-h-svh" aria-busy="true" aria-label="讀取中" />;
}

/**
 * The front page for a first visit: the landing shows at once, without the panel's code and
 * without waiting for the login check, which runs beside it. If the check finds someone logged
 * in (or a Core without a public site), `onHandOff` gives the page to the panel.
 */
export function LandingFirst({ onHandOff }: { onHandOff: (visitor: Visitor) => void }) {
  return (
    <ConnectionProvider>
      <Backdrop />
      <Front onHandOff={onHandOff} />
    </ConnectionProvider>
  );
}

function Front({ onHandOff }: { onHandOff: (visitor: Visitor) => void }) {
  const { config, api } = useConnection();
  const [queryClient] = useState(() => createQueryClient());
  const [discord, setDiscord] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    void checkVisitor(api, config.token, ctl.signal).then((visitor) => {
      if (visitor === null) return;
      if (visitor.auth.status === "public" && visitor.auth.member === null) {
        setDiscord((visitor.methods?.discord ?? false) && isSameOrigin(config.baseUrl));
      } else {
        onHandOff(visitor);
      }
    });
    return () => ctl.abort();
  }, [api, config, onHandOff]);

  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<LandingFallback />}>
        <Landing discord={discord} notice={null} />
      </Suspense>
    </QueryClientProvider>
  );
}
