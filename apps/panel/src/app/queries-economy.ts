// The economy's admin queries that are per server (phase 6): beside `queries.ts`, whose keys they
// extend so that what invalidates the plain key (a settled prediction) invalidates these too.

import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/http";
import { useApi } from "./connection";
import { queryKeys } from "./queries";
import { FINAL } from "./query-client";
import { useAdminSpace } from "./space";

/** A module that is off or missing stays so: polling it again will not change that. */
const OFF = new Set<string>([...FINAL, "unavailable"]);
const poll = (ms: number) => (q: { state: { error: Error | null } }) => {
  const e = q.state.error;
  return isApiError(e) && OFF.has(e.kind) ? false : ms;
};

/**
 * The predictions of the server the page is about, with two or more servers; every server's with
 * one (as before there were several). Each names its server.
 */
export function useAdminPredictions() {
  const api = useApi();
  const { space, multiple, spaces } = useAdminSpace();
  const asked = multiple && space !== null ? space : undefined;
  const query = useQuery({
    queryKey: [...queryKeys.predictions, asked ?? null],
    queryFn: ({ signal }) => api.rpc.economy.predictions({ query: { space: asked } }, { signal }),
    refetchInterval: poll(30_000),
    retry: false,
  });
  return { query, multiple, space: spaces.find((s) => s.id === asked) ?? null };
}
