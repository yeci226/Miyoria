// The karaoke routes as the page reads them (`/api/member/karaoke/*`, the route table's
// `karaoke` group). A refusal is the Core's own sentence (`describeError`).

import { useQuery } from "@tanstack/react-query";
import type { KaraokeSongView } from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";

export const KARAOKE = ["member", "karaoke"] as const;
export const OVERVIEW = [...KARAOKE, "overview"] as const;
export const songKey = (id: string) => [...KARAOKE, "song", id] as const;
export const resultKey = (id: string) => [...KARAOKE, "result", id] as const;

/** A preparing song is asked about this often. */
export const SONG_POLL_MS = 2_000;
/** Her comment is looked for this often, and for this long. */
export const COMMENT_POLL_MS = 5_000;
export const COMMENT_WAIT_MS = 4 * 60_000;
/** The official score (from the recording) is looked for this often, and for this long. */
export const VOICE_POLL_MS = 3_000;
export const VOICE_WAIT_MS = 3 * 60_000;

/** An older Core has no such route, a stopped module stays stopped: asking again will not help. */
export const retryUnlessOff = (n: number, e: Error) =>
  !isNotProvided(e) && !(isApiError(e) && e.kind === "unavailable") && n < 2;

/** Whether the error means karaoke is not on this Core (or is switched off). */
export const isOff = (e: unknown) => isNotProvided(e) || (isApiError(e) && e.kind === "unavailable");

export function useOverview(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: OVERVIEW,
    queryFn: ({ signal }) => api.rpc.karaoke.overview(undefined, { signal }),
    retry: retryUnlessOff,
    enabled,
  });
}

/** A song while it is being prepared: asked again every two seconds until it is not. */
export function usePreparing(song: KaraokeSongView) {
  const api = useApi();
  return useQuery({
    queryKey: songKey(song.id),
    queryFn: ({ signal }) => api.rpc.karaoke.song({ params: { id: song.id } }, { signal }),
    initialData: song,
    refetchInterval: (q) => (q.state.data?.state === "preparing" && !q.state.error ? SONG_POLL_MS : false),
    retry: retryUnlessOff,
  });
}

// ---- rooms (`/api/member/karaoke/rooms/*`, the route table's `karaokeRooms` group) -------------

export const ROOMS = [...KARAOKE, "rooms"] as const;

/** Whether a room can be opened now, its price, the balance and the room they are in. */
export function useRooms(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ROOMS,
    queryFn: ({ signal }) => api.rpc.karaokeRooms.overview(undefined, { signal }),
    retry: retryUnlessOff,
    enabled,
  });
}
