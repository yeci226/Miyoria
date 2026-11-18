// What she reads when something the Arbiter admitted wakes her (`impulses.ts`). Block 7 frames it
// (`WAKE_LINES` of `@miyoria/brain/self`, which also neutralizes it): a `world` wake says
// 「剛發生一件事:「…」」 and that she may stay quiet.

/** What happened, as the `world` wake carries it, by the impulse's source. */
export const ADMITTED_NOTES = {
  /** A game she plays: the narration of the log or the director's line. */
  game: (hint: string) => `你正在玩的遊戲:${hint.trim()}`,
  /** A friend's stream she is watching in voice: what a look at it showed. */
  watch: (hint: string) => `你正在看的直播:${hint.trim()}`,
  /** A song of hers: about to start, ready, done or failed (the singer says what is wanted). */
  song: (hint: string) => `唱歌的事:${hint.trim()}`,
  /** Anything else a module asked her to react to. */
  other: (hint: string) => hint.trim(),
} as const;

/** The tool name a notice wake shows (`result` wake: 「你之前開始的事有結果了(通知,…)」). */
export const NOTICE_TOOL = "通知";

/** A notice as a line of the result's data. */
export function noticeLine(ok: boolean, text: string): string {
  return `- ${ok ? "成功" : "失敗"}:${text.replace(/\s+/g, " ").trim()}`;
}
