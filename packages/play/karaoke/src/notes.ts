// What she hears of a finished song (docs/design/karaoke.md §10): one note with the system's
// numbers, the way she hears of a card or a lot won, so she comments in her own words in one turn.
// The numbers are the program's and the note says so; she has no tool that changes a score. The
// title and the lyric lines come from YouTube and lrclib: untrusted, cut short, and the note's
// bucket is marked untrusted. A result flagged as not sung reads the same: she is never told
// someone cheated.

import { safeName } from "@miyoria/types";
import type { ScoreResult } from "./score/index.js";

export interface NoteInput {
  name: string;
  title: string;
  result: ScoreResult;
  /** The lyric line of each phrase, when the phrases are lines. */
  lines: readonly (string | null)[];
  /** Their best ranked total on this song before this one. */
  bestBefore: number | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function phrase(input: NoteInput, at: number | null): string | null {
  if (at === null) return null;
  const p = input.result.phrases[at];
  if (p === undefined) return null;
  const text = input.lines[p.index];
  const quoted = text ? `「${safeName(text, 16)}」` : "";
  return `第 ${p.index + 1} 句${quoted}(${p.score} 分)`;
}

// ---- rooms (step 4) ---------------------------------------------------------------------------

/** A room opened (no song yet: people queue songs inside): she is its host and may greet people. */
export function roomOpenedNote(opener: string, code: string): string {
  return `${safeName(opener)} 在會員頁開了一間唱 K 房間(房號 ${code}),還沒有點歌:大家進房間之後自己點。你是主持人:可以招呼大家用房號加入,一間最多八個人一起唱同一首。分數是系統算的。`;
}

/** A round starts in a few seconds. */
export function roundStartNote(
  code: string,
  round: number,
  title: string,
  names: string[],
): string {
  const who = names.map((n) => safeName(n)).join("、");
  return `唱 K 房間 ${code} 第 ${round} 首要開始了:「${safeName(title, 40)}」,${who} 一起唱。唱的時候不用說話,唱完系統會給分數,你再講評。`;
}

/** One singer's line of a round, for her. */
export interface RoundLine {
  name: string;
  rank: number | null;
  total: number | null;
  /** `voice`: the official score; `estimate`: the browser's (預估). */
  source: "voice" | "estimate" | null;
  finished: boolean;
  coins: number;
  winner: boolean;
  /** The best rank they reached during the song, and the worst. */
  bestRank: number | null;
  worstRank: number | null;
  vibrato_s: number | null;
  /** Their best phrase: `第 3 句「...」(95 分)`. */
  best: string | null;
}

/** A round's results: the official scores, the prizes, and a few moments worth a word. */
export function roundResultNote(
  code: string,
  round: number,
  title: string,
  lines: RoundLine[],
  note: string | null,
): string {
  const ranked = lines
    .filter((l) => l.total !== null)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map(
      (l) =>
        `${l.rank}. ${safeName(l.name)} ${l.total} 分${l.source === "estimate" ? "(預估)" : ""}${l.winner ? `(第一名,${l.coins} 魚幣)` : ""}`,
    );
  const missing = lines.filter((l) => l.total === null).map((l) => safeName(l.name));
  const moments: string[] = [];
  for (const l of lines) {
    if (l.rank !== null && l.worstRank !== null && l.worstRank - l.rank >= 2) {
      moments.push(`${safeName(l.name)} 從第 ${l.worstRank} 名追上來`);
    }
    if (l.vibrato_s !== null && l.vibrato_s >= 3) {
      moments.push(`${safeName(l.name)} 的顫音有 ${l.vibrato_s} 秒`);
    }
    if (l.best !== null && l.rank === 1) moments.push(`${safeName(l.name)} 唱得最好的是${l.best}`);
  }
  const parts = [
    `唱 K 房間 ${code} 第 ${round} 首「${safeName(title, 40) || "一首歌"}」唱完了,系統分數:${ranked.join(";") || "沒有人交出分數"}。`,
  ];
  if (missing.length > 0) parts.push(`${missing.join("、")} 沒有唱完。`);
  if (note !== null) parts.push(`${note}。`);
  if (moments.length > 0) parts.push(`${moments.slice(0, 4).join(";")}。`);
  parts.push("分數是系統算的,講評時照這些數字說;(預估)是瀏覽器算的,不算正式。");
  return parts.join("");
}

/** The note: who sang what, the total and the four parts, then what stood out. */
export function resultNote(input: NoteInput): string {
  const { result } = input;
  const who = safeName(input.name);
  const title = safeName(input.title, 40) || "一首歌";
  const parts = [
    `${who} 剛在會員頁一個人唱了「${title}」,系統分數 ${result.total} 分`,
    `(音程 ${result.pitch.score}/60、安定 ${result.stability.score}/15、節奏 ${result.rhythm.score}/15、表現 ${result.expression.score}/10)。`,
  ];
  const facts: string[] = [];
  const r = result.rhythm;
  if (!r.calibrated) facts.push("沒有校正延遲,節奏照音程給分");
  else if (r.feel === "late") facts.push(`節奏整體偏慢約 ${r.offset_ms} 毫秒`);
  else if (r.feel === "early") facts.push(`節奏整體偏快約 ${Math.abs(r.offset_ms ?? 0)} 毫秒`);
  else if (r.feel === "steady") facts.push("節奏跟得很準");
  if (result.facts.octave < 0) facts.push("用低八度唱");
  if (result.facts.octave > 0) facts.push("用高八度唱");
  if (result.facts.coverage < 0.7) facts.push(`有出聲的只有原唱的 ${pct(result.facts.coverage)}`);
  const offset = result.facts.offset_cents;
  if (offset !== null && Math.abs(offset) >= 25) {
    facts.push(`整體${offset < 0 ? "偏低" : "偏高"}約 ${Math.abs(offset)} cents`);
  }
  if (result.expression.vibrato_s >= 2) facts.push(`顫音 ${result.expression.vibrato_s} 秒`);
  if (result.expression.long_tones > 0) facts.push(`長音 ${result.expression.long_tones} 個`);
  const best = phrase(input, result.facts.best);
  const weakest = phrase(input, result.facts.weakest);
  if (best !== null) facts.push(`唱得最好的是${best}`);
  if (weakest !== null && weakest !== best) facts.push(`最弱的是${weakest}`);
  if (input.bestBefore === null) facts.push(`${who} 第一次唱這首`);
  else if (result.total > input.bestBefore) {
    facts.push(`比 ${who} 之前最好的 ${input.bestBefore} 分高`);
  } else facts.push(`${who} 之前最好是 ${input.bestBefore} 分`);
  return `${parts.join("")}${facts.join(";")}。分數是系統算的,講評時照這些數字說。`;
}
