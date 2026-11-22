// The karaoke routes as the page reads them (`/api/member/karaoke/*`, the route table's
// `karaoke` group). A refusal is the Core's own sentence (`describeError`).

import { useQuery } from "@tanstack/react-query";
import type { KaraokeSongView } from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { usePushed } from "@/app/push";

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

/**
 * How often whether a room can be opened is asked again: often while it cannot (she joining a
 * voice channel must enable 開一間房 within a second or two, not on the next reload), seldom
 * while it can (she leaving is said by Core when someone tries). Only while the page is in view.
 */
export const ROOMS_WAIT_POLL_MS = 1_500;
export const ROOMS_POLL_MS = 15_000;

/**
 * Whether a room can be opened now, its price, the balance and the room they are in. `space`: the
 * server it is about (phase 6, `useMemberSpace`); `null`: the Core's default (their own). Under a
 * `PushProvider` it comes by push (her joining a voice channel shows at once) and is polled only
 * while the stream is not there.
 */
export function useRooms(enabled = true, space: string | null = null) {
  const api = useApi();
  const key = [...ROOMS, space] as const;
  const pushed = usePushed("rooms", space, key, enabled);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.rpc.karaokeRooms.overview(space ? { query: { space } } : undefined, { signal }),
    retry: retryUnlessOff,
    enabled,
    staleTime: 0,
    refetchInterval: (q) =>
      pushed || q.state.error ? false : q.state.data && !q.state.data.available ? ROOMS_WAIT_POLL_MS : ROOMS_POLL_MS,
  });
}
