// An edit made into the reference everyone sings against (docs/design/karaoke.md 「做了什麼第六
// 步」): the worker's reference with the edit's lyrics and notes and its pitch curve moved by the
// edit's shift. Every line that is not exactly one of the worker's is marked `edited` (and a line
// the editor marked checked stays marked).

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers";
import type { EditDoc } from "./ops.js";

const key = (line: WorkersKaraokeLineV2) => JSON.stringify({ ...line, edited: false });

/** The lines with `edited` set on every one the worker did not write as it is. */
export function markEdited(
  original: WorkersKaraokeLyricsV2 | null,
  lines: readonly WorkersKaraokeLineV2[],
): WorkersKaraokeLineV2[] {
  const known = new Set((original?.lines ?? []).map(key));
  return lines.map((l) => {
    const edited = l.edited || !known.has(key(l));
    return edited === l.edited ? l : { ...l, edited };
  });
}

/** How many lines of an edit are not the worker's. */
export function editedLines(lines: readonly WorkersKaraokeLineV2[]): number {
  return lines.filter((l) => l.edited).length;
}

/** The edit of the worker's `original`, as the reference everyone gets. */
export function composeReference(
  original: WorkersKaraokeReferenceV2,
  doc: EditDoc,
): WorkersKaraokeReferenceV2 {
  const shift = doc.pitch_shift;
  const lines = doc.lyrics === null ? null : markEdited(original.lyrics, doc.lyrics.lines);
  return {
    ...original,
    pitch:
      shift === 0
        ? original.pitch
        : {
            ...original.pitch,
            midi: original.pitch.midi.map((m) =>
              m === null ? null : Math.round((m + shift) * 100) / 100,
            ),
          },
    notes: [...doc.notes].sort((a, b) => a.start - b.start || a.end - b.end),
    lyrics:
      doc.lyrics === null || lines === null
        ? null
        : {
            ...doc.lyrics,
            timing: lines.some((l) => l.aligned) ? "char" : "line",
            lines,
          },
  };
}

/** The edit a reference is (its lyrics and notes), with the shift it was saved with. */
export function docOf(reference: WorkersKaraokeReferenceV2, pitchShift: number): EditDoc {
  return { lyrics: reference.lyrics, notes: [...reference.notes], pitch_shift: pitchShift };
}
