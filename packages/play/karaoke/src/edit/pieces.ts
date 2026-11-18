// How a line's text is cut into pieces when the editor changes it (reference.json version 2's
// `pieces`, docs/design/karaoke.md 「做了什麼第二步」): a Chinese character, a kana (a mora, small
// kana kept with the one before), or a word of letters is one sung piece; spaces and punctuation
// between them are pieces that are not sung. The worker cuts Japanese kanji words as one piece with
// their reading; an edit keeps every piece outside the changed span as it was (its time, reading
// and romaji), and only the changed span is cut again here, one kanji a piece.

import type { WorkersKaraokePiece } from "@miyoria/contracts/workers";

const HAN = /[㐀-䶿一-鿿豈-﫿々〇〻]/u;
const KANA = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/u;
/** Small kana: sung with the kana before them (きゃ is one mora). */
const SMALL = /[ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ]/u;
const LETTER = /[\p{L}\p{N}'’]/u;

const piece = (text: string, sung: boolean): WorkersKaraokePiece => ({
  text,
  sung,
  start: null,
  end: null,
  reading: null,
  roman: null,
});

/** `text` cut into pieces, none timed, no readings. */
export function piecesFromText(text: string): WorkersKaraokePiece[] {
  const out: WorkersKaraokePiece[] = [];
  let word = "";
  let gap = "";
  const flushWord = () => {
    if (word !== "") out.push(piece(word, true));
    word = "";
  };
  const flushGap = () => {
    if (gap !== "") out.push(piece(gap, false));
    gap = "";
  };
  for (const ch of text) {
    if (HAN.test(ch) || KANA.test(ch)) {
      flushWord();
      flushGap();
      const last = out.at(-1);
      if (SMALL.test(ch) && last?.sung && KANA.test(last.text)) {
        out[out.length - 1] = { ...last, text: last.text + ch };
      } else {
        out.push(piece(ch, true));
      }
    } else if (LETTER.test(ch)) {
      flushGap();
      word += ch;
    } else {
      flushWord();
      gap += ch;
    }
  }
  flushWord();
  flushGap();
  return out;
}

/** What a text edit did to a line's pieces: the new pieces, and where each old piece went. */
export interface Repieced {
  pieces: WorkersKaraokePiece[];
  /** For each old piece, its index among the new pieces, or `null` when it was cut again. */
  moved: (number | null)[];
}

/**
 * The pieces of a line whose text changed from `before` to `text`: the pieces wholly inside the
 * unchanged start and end of the text are kept as they were; what lies between is cut again
 * (`piecesFromText`), untimed. Without old pieces (or ones that do not spell the old text), all of
 * it is cut again.
 */
export function repiece(old: readonly WorkersKaraokePiece[] | null, text: string): Repieced {
  const before = old?.map((p) => p.text).join("") ?? null;
  if (old === null || before === null) {
    return { pieces: piecesFromText(text), moved: [] };
  }
  if (before === text) return { pieces: [...old], moved: old.map((_, i) => i) };
  let prefix = 0;
  const most = Math.min(before.length, text.length);
  while (prefix < most && before[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < most - prefix &&
    before[before.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    suffix++;
  }
  // The old pieces that lie wholly in the unchanged head, and wholly in the unchanged tail.
  const bounds: [number, number][] = [];
  let at = 0;
  for (const p of old) {
    bounds.push([at, at + p.text.length]);
    at += p.text.length;
  }
  let head = 0;
  while (head < old.length && (bounds[head] as [number, number])[1] <= prefix) head++;
  let tail = old.length;
  while (tail > head && (bounds[tail - 1] as [number, number])[0] >= before.length - suffix) tail--;
  const headEnd = head === 0 ? 0 : (bounds[head - 1] as [number, number])[1];
  const tailStart = tail === old.length ? before.length : (bounds[tail] as [number, number])[0];
  const middle = text.slice(headEnd, text.length - (before.length - tailStart));
  const cut = piecesFromText(middle);
  const pieces = [...old.slice(0, head), ...cut, ...old.slice(tail)];
  const moved: (number | null)[] = old.map((_, i) =>
    i < head ? i : i >= tail ? i - tail + head + cut.length : null,
  );
  return { pieces: joinGaps(pieces, moved), moved };
}

/**
 * Two unsung pieces side by side become one (a cut beside a kept gap); `moved` is updated in place.
 */
function joinGaps(pieces: WorkersKaraokePiece[], moved: (number | null)[]): WorkersKaraokePiece[] {
  const out: WorkersKaraokePiece[] = [];
  const where: number[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last !== undefined && !last.sung && !p.sung) {
      out[out.length - 1] = { ...last, text: last.text + p.text };
    } else {
      out.push(p);
    }
    where.push(out.length - 1);
  }
  for (let i = 0; i < moved.length; i++) {
    const m = moved[i];
    if (m !== null && m !== undefined) moved[i] = where[m] ?? null;
  }
  return out;
}

/** Every sung piece has a time: the line can be lit piece by piece. */
export function piecesTimed(pieces: readonly WorkersKaraokePiece[] | null): boolean {
  if (pieces === null) return false;
  const sung = pieces.filter((p) => p.sung);
  return sung.length > 0 && sung.every((p) => p.start !== null && p.end !== null);
}
