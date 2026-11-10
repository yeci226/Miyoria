// Party games (`@miyoria/party`) as `GET /api/party` serves them: the games running now with their
// players and scores, and how the last ones ended. A 503 is the party module being off; an empty
// snapshot is no game right now.

import type { PartyPlayerView } from "@/api/v4-types";

/** Why a game ended, in words. */
export const END_REASONS: Record<string, string> = {
  done: "玩完了",
  host: "被關掉了",
  stop: "有人說不玩了",
  idle: "太久沒人動",
  empty: "人都走了",
  left: "她離開了頻道",
  away: "她被叫走了",
};

export const endReason = (reason: string): string => END_REASONS[reason] ?? reason;

/** `Owen 30、你 10`: the players who have a score, best first. */
export function scoreLine(players: PartyPlayerView[]): string {
  return [...players]
    .sort((a, b) => b.score - a.score)
    .filter((p) => p.score > 0)
    .map((p) => `${p.name} ${p.score}`)
    .join("、");
}
