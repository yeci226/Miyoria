// @miyoria/play/karaoke/lyrics: the karaoke lyrics as a page shows them, shared by the member
// page's singing scene (apps/panel) and the stream's karaoke scene (apps/overlay). Plain TypeScript
// with no DOM and no Node, and no imports outside this folder except the reference format's types
// (`import type`, so no schema library reaches a page's bundle).
//
// - `lines.ts`: which two lines show, the counting-in dots, how far each piece is sung, the wipe.
// - `readings.ts`: furigana / pinyin / romaji above the words, and how a key is written.
// - `video-sync.ts`: the background video following the song's clock.

export {
  COUNTDOWN_DOTS,
  countdown,
  fillClip,
  isDoubtful,
  lineProgress,
  lyricAt,
  pieceProgress,
  stageLines,
  stepped,
  sungEnd,
} from "./lines.js";
export { keyLabel, type ReadingMode, readingLabel, readingModes, rubyOf } from "./readings.js";
export {
  catchUpRate,
  type SongNow,
  StallWatch,
  VIDEO_CHECK_MS,
  VIDEO_NEAR_S,
  VIDEO_RATE_SPAN,
  VIDEO_SEEK_S,
  VIDEO_STALL_S,
  type VideoNow,
  type VideoStep,
  videoStep,
  videoTarget,
} from "./video-sync.js";
