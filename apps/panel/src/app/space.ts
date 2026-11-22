// Which server an admin page is about (docs/design/v5-places.md §6): the address's `?space=` (so a
// page can be shared and reloaded), else the Core's default (the primary). Pages pass `space` to
// their per-server routes and leave it out when it is `null`; the Core then uses its own default,
// which is what a single-server install always did.
//
//     const { space } = useAdminSpace();
//     useQuery({ queryKey: ["market", "plan", space], queryFn: () => api.rpc.marketAdmin.plan({ query: { space: space ?? undefined } }) });
//
// The switcher that sets it lives in the shell's header (`Shell.tsx`, drawn only with more than one
// server); `setSpace` is what it calls.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { AdminSpace } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "./connection";

export const spaceKeys = {
  admin: ["places", "spaces"] as const,
};

/** Every server she is in. An older Core without the route answers as a single-server one. */
export function useAdminSpaces() {
  const api = useApi();
  return useQuery({
    queryKey: spaceKeys.admin,
    queryFn: async ({ signal }) => {
      try {
        return await api.rpc.places.spaces(undefined, { signal });
      } catch (e) {
        if (isNotProvided(e)) return { spaces: [], default: null };
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export interface AdminSpaceState {
  /** The server the page is about; `null` while unknown or when the Core has none (leave `space` out). */
  space: string | null;
  spaces: AdminSpace[];
  /** More than one server: the only time a switcher is worth showing. */
  multiple: boolean;
  /** Puts `id` in the address (`null`, or the default: takes it out). */
  setSpace: (id: string | null) => void;
  loading: boolean;
}

/** The `?space=` of the current address, whichever route it is on. */
function useSearchSpace(): string | null {
  return useRouterState({
    select: (s) => {
      const value = (s.location.search as Record<string, unknown>).space;
      return typeof value === "string" && value !== "" ? value : null;
    },
  });
}

export function useAdminSpace(): AdminSpaceState {
  const query = useAdminSpaces();
  const navigate = useNavigate();
  const requested = useSearchSpace();
  const spaces = query.data?.spaces ?? [];
  const fallback = query.data?.default ?? null;
  // A server she left (an old link) falls back to the default, once the list says so.
  const space = query.data === undefined ? requested : spaces.some((s) => s.id === requested) ? requested : fallback;
  const setSpace = (id: string | null) => {
    const next = id === null || id === fallback ? undefined : id;
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({ ...prev, space: next })) as never,
      replace: true,
    });
  };
  return { space, spaces, multiple: spaces.length > 1, setSpace, loading: query.isPending };
}
