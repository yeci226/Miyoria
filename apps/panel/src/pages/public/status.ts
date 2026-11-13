// Her public status and song list, and how they read: shared by the public site and the landing
// page. Kept apart from PublicSite so the landing does not pull in the member pages.

import { useQuery } from "@tanstack/react-query";
import type { PublicState, PublicStatus } from "@/api/types";
import { useApi } from "@/app/connection";
import type { Tone } from "@/components/status";

/** The Core rebuilds these every few seconds at most, so polling faster buys nothing. */
const POLL_MS = 15_000;

export const STATE: Record<PublicState, { label: string; tone: Tone; pulse?: boolean }> = {
  singing: { label: "她在唱歌", tone: "brand", pulse: true },
  playing: { label: "她在玩遊戲", tone: "success" },
  live: { label: "她在直播", tone: "brand", pulse: true },
  in_voice: { label: "她在語音頻道", tone: "success" },
  idle: { label: "她現在閒著", tone: "neutral" },
  offline: { label: "她現在不在", tone: "neutral" },
};

const GAMES: Record<string, string> = { minecraft: "Minecraft" };

export function stateLabel(status: PublicStatus): string {
  if (status.state === "playing" && status.game) {
    return `她在玩 ${GAMES[status.game] ?? status.game}`;
  }
  return STATE[status.state].label;
}

export function usePublicStatus() {
  const api = useApi();
  return useQuery({
    queryKey: ["public", "status"],
    queryFn: ({ signal }) => api.publicStatus({ signal }),
    refetchInterval: POLL_MS,
  });
}

export function usePublicSongs() {
  const api = useApi();
  return useQuery({
    queryKey: ["public", "songs"],
    queryFn: ({ signal }) => api.publicSongs({ signal }),
    refetchInterval: POLL_MS,
  });
}
