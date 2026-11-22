// The channel levels of the admin Space (docs/design/v5-places.md): the channels of the server the
// page is about (`useAdminSpace`), and that server's own level. Without a `?space=` the Core lists
// the primary's, as a single-server install always had.

import { type Query, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelLevelsView } from "@miyoria/contracts/api";
import type { ContextKey } from "@miyoria/contracts/wire";
import { isApiError } from "@/api/http";
import { useApi } from "./connection";
import { FINAL } from "./query-client";
import { useAdminSpace } from "./space";

/** Polls every `ms`, but stops once the route turned out not to exist or the token is bad. */
const poll =
  (ms: number) =>
  (query: Query<ChannelLevelsView, Error, ChannelLevelsView, readonly unknown[]>): number | false => {
    const e = query.state.error;
    return isApiError(e) && FINAL.has(e.kind) ? false : ms;
  };

export const channelLevelKeys = {
  all: ["channels", "levels"] as const,
  of: (space: string | null) => ["channels", "levels", space] as const,
};

/** The levels and the text channels of the admin Space. */
export function useSpaceChannelLevels() {
  const api = useApi();
  const { space } = useAdminSpace();
  return useQuery({
    queryKey: channelLevelKeys.of(space),
    queryFn: ({ signal }) => api.rpc.channels.levels({ query: { space: space ?? undefined } }, { signal }),
    refetchInterval: poll(15_000),
  });
}

/** Sets or resets one channel's level; the list of its Space is updated in place. */
export function useSetSpaceChannelLevel() {
  const api = useApi();
  const qc = useQueryClient();
  const { space } = useAdminSpace();
  return useMutation({
    mutationFn: ({ context, mode }: { context: ContextKey; mode: string | null }) => api.rpc.channels.setLevel({ body: { context, mode } }),
    onSuccess: (row) => {
      qc.setQueryData<ChannelLevelsView>(channelLevelKeys.of(space), (old) =>
        old
          ? {
              ...old,
              channels: old.channels.map((c) =>
                c.context.platform === row.context.platform && c.context.scope === row.context.scope && c.context.channel === row.context.channel ? row : c,
              ),
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: channelLevelKeys.all });
    },
  });
}

/** Sets or resets the level of the whole admin Space (its channels without one of their own). */
export function useSetSpaceLevel() {
  const api = useApi();
  const qc = useQueryClient();
  const { space } = useAdminSpace();
  return useMutation({
    mutationFn: ({ mode }: { mode: string | null }) => api.rpc.channels.setSpaceLevel({ query: { space: space ?? undefined }, body: { mode } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: channelLevelKeys.all }),
  });
}
