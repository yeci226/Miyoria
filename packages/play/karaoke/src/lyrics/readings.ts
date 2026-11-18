// What sits above the words (furigana, pinyin or romaji) and how a key is written. The viewer's own
// choice of reading is kept by each page (the member page in its browser, the stream in its query
// string); this file only says what a song has and what each piece shows.

import type { WorkersKaraokeLyricsV2, WorkersKaraokePiece } from "@miyoria/contracts/workers";

/** What is shown above the words: nothing, the reading (furigana / pinyin), or romaji. */
export type ReadingMode = "off" | "reading" | "roman";

/** The reading modes a song's lyrics have (besides `off`): what its pieces carry. */
export function readingModes(lyrics: WorkersKaraokeLyricsV2 | null): ReadingMode[] {
  const pieces = (lyrics?.lines ?? []).flatMap((l) => l.pieces ?? []);
  const out: ReadingMode[] = [];
  if (pieces.some((p) => p.reading !== null)) out.push("reading");
  if (pieces.some((p) => p.roman !== null)) out.push("roman");
  return out;
}

/** The words of a mode for this song's language: 假名 for Japanese, 拼音 for Chinese. */
export function readingLabel(mode: ReadingMode, language: string | null): string {
  if (mode === "off") return "不顯示";
  if (mode === "roman") return "羅馬字";
  return language === "zh" ? "拼音" : "假名";
}

/** What a piece shows above it in `mode`, or `null`. */
export function rubyOf(piece: WorkersKaraokePiece, mode: ReadingMode): string | null {
  if (mode === "reading") return piece.reading;
  if (mode === "roman") return piece.roman;
  return null;
}

/** `原調`, `+2`, `−3`. */
export function keyLabel(shift: number): string {
  if (shift === 0) return "原調";
  return shift > 0 ? `+${shift}` : `−${Math.abs(shift)}`;
}
