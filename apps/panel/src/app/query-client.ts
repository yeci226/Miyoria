// The panel's query client, apart from the queries so the landing page can have one without them.

import { QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError } from "@/api/http";

/** Errors that retrying cannot fix. */
export const FINAL = new Set(["unauthorized", "not_provided", "not_found", "bad_response"]);

export function createQueryClient(onError?: (error: Error) => void): QueryClient {
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onError?.(error) }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(isApiError(error) && FINAL.has(error.kind)) && count < 2,
      },
      mutations: { retry: false },
    },
  });
  // Voice measurements written from the event stream have no fetcher to bring them back.
  client.setQueryDefaults(["e2e"], { gcTime: Number.POSITIVE_INFINITY, staleTime: Number.POSITIVE_INFINITY });
  return client;
}
