// The lyrics under the lane, reference.json version 2 (docs/design/karaoke.md 「做了什麼第二步」):
// how far each piece of an aligned line is sung and which readings a song has come from the module
// shared with the stream's karaoke scene (`@miyoria/play/karaoke/lyrics`); the viewer's own choices
// kept in this browser (the reading shown, the key of each song) are here. No DOM here.

import type { ReadingMode } from "@miyoria/play/karaoke/lyrics";

export {
  COUNTDOWN_DOTS,
  countdown,
  isDoubtful,
  keyLabel,
  lineProgress,
  pieceProgress,
  type ReadingMode,
  readingLabel,
  readingModes,
  rubyOf,
  stageLines,
  stepped,
  sungEnd,
} from "@miyoria/play/karaoke/lyrics";

// ---- kept in this browser --------------------------------------------------------------------

type StorageGetter = () => Pick<Storage, "getItem" | "setItem">;
const local: StorageGetter = () => window.localStorage;

const READING_KEY = "miyoria.karaoke.reading";
const KEY_PREFIX = "miyoria.karaoke.key:";

export function loadReading(storage: StorageGetter = local): ReadingMode {
  try {
    const v = storage().getItem(READING_KEY);
    return v === "reading" || v === "roman" ? v : "off";
  } catch {
    return "off";
  }
}

export function saveReading(mode: ReadingMode, storage: StorageGetter = local): void {
  try {
    storage().setItem(READING_KEY, mode);
  } catch {
    // Not kept: this visit still shows it.
  }
}

/** The key last sung for `song`, `0` when none (-6..6). */
export function loadKey(song: string, max: number, storage: StorageGetter = local): number {
  try {
    const v = Number(storage().getItem(`${KEY_PREFIX}${song}`));
    return Number.isInteger(v) && Math.abs(v) <= max ? v : 0;
  } catch {
    return 0;
  }
}

export function saveKey(song: string, shift: number, storage: StorageGetter = local): void {
  try {
    storage().setItem(`${KEY_PREFIX}${song}`, String(shift));
  } catch {
    // Not kept.
  }
}
