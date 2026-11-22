// Her public status and song list, and how they read: shared by the public site and the landing
// page. Kept apart from PublicSite so the landing does not pull in the member pages.

import { useQuery } from "@tanstack/react-query";
import type { PublicState, PublicStatus } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { usePushed } from "@/app/push";
import type { Tone } from "@/components/status";
import { WORLD } from "@/lib/world";

/** Her pronoun in this profile (`lib/world.ts`). */
const HER = WORLD.pronoun;

/**
 * The Core rebuilds these every few seconds at most, so polling faster buys nothing. Under a
 * `PushProvider` both come by push instead, and are polled only while the stream is not there.
 */
const POLL_MS = 15_000;
export const PUBLIC_SONGS = ["public", "songs"] as const;

export const STATE: Record<PublicState, { label: string; tone: Tone; pulse?: boolean }> = {
  singing: { label: `${HER}在唱歌`, tone: "brand", pulse: true },
  playing: { label: `${HER}在玩遊戲`, tone: "success" },
  live: { label: `${HER}在直播`, tone: "brand", pulse: true },
  in_voice: { label: `${HER}在語音頻道`, tone: "success" },
  idle: { label: `${HER}現在閒著`, tone: "neutral" },
  offline: { label: `${HER}現在不在`, tone: "neutral" },
};

const GAMES: Record<string, string> = { minecraft: "Minecraft" };

export function stateLabel(status: PublicStatus): string {
  if (status.state === "playing" && status.game) {
    return `${HER}在玩 ${GAMES[status.game] ?? status.game}`;
  }
  return STATE[status.state].label;
}

export function usePublicStatus() {
  const api = useApi();
  const options = api.q.public.status.queryOptions();
  const pushed = usePushed("status", null, options.queryKey);
  return useQuery({ ...options, refetchInterval: pushed ? false : POLL_MS });
}

export function usePublicSongs() {
  const api = useApi();
  const pushed = usePushed("songs", null, PUBLIC_SONGS);
  return useQuery({
    queryKey: PUBLIC_SONGS,
    queryFn: ({ signal }) => api.rpc.public.songs(undefined, { signal }),
    refetchInterval: pushed ? false : POLL_MS,
  });
}
