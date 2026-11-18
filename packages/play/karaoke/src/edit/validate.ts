// What an edited reference must hold before Core stores it (docs/design/karaoke.md 「做了什麼第六
// 步」): Core runs this on every save and refuses one with any problem, never mending it; the editor
// runs the same to list the problems before it sends. Each problem is a sentence for the editor's
// person, with the line or note it is about.

import type { WorkersKaraokeNote } from "@miyoria/contracts/workers";
import type { EditDoc } from "./ops.js";

/** Bounds of an edit. */
export const EDIT_LIMITS = {
  lines: 600,
  /** Characters of one line's text. */
  text: 200,
  /** Pieces of one line. */
  pieces: 200,
  /** Characters of one reading or romaji. */
  reading: 40,
  /** Characters of what was heard (kept from the worker). */
  heard: 600,
  notes: 6000,
  /** The lowest and highest note (C1 to C7): a voice is well inside. */
  midiLow: 24,
  midiHigh: 96,
  /** Semitones the whole curve may move. */
  shift: 24,
  /** The edit as JSON, in characters. */
  bytes: 1_500_000,
} as const;

/** A problem with an edit: its sentence, and the line or note it is about (`null`: the whole). */
export interface EditProblem {
  line: number | null;
  note: number | null;
  message: string;
}

/** What the edit is checked against: the song's length and the worker's pitch curve. */
export interface EditContext {
  duration_s: number;
  /** The worker's curve, before `pitch_shift`. */
  curve: readonly (number | null)[];
}

const EPS = 0.001;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const secs = (t: number) => `${Math.round(t * 100) / 100} 秒`;

/** Every problem of `doc`, at most `max` of them (in order: the whole, the lines, the notes). */
export function validateEdit(doc: EditDoc, ctx: EditContext, max = 50): EditProblem[] {
  const out: EditProblem[] = [];
  const add = (line: number | null, note: number | null, message: string) => {
    if (out.length < max) out.push({ line, note, message });
  };
  const L = EDIT_LIMITS;
  const song = ctx.duration_s;

  if (!Number.isInteger(doc.pitch_shift) || Math.abs(doc.pitch_shift) > L.shift) {
    add(null, null, `整首最多移 ${L.shift} 個半音`);
  } else if (doc.pitch_shift !== 0) {
    let low = Infinity;
    let high = -Infinity;
    for (const m of ctx.curve) {
      if (m === null) continue;
      low = Math.min(low, m + doc.pitch_shift);
      high = Math.max(high, m + doc.pitch_shift);
    }
    if (low < L.midiLow || high > L.midiHigh) {
      add(null, null, "整首移了之後,參考的音高超出範圍(C1 到 C7)");
    }
  }

  const lines = doc.lyrics?.lines ?? [];
  if (lines.length > L.lines) add(null, null, `歌詞最多 ${L.lines} 行`);
  let prevStart = -Infinity;
  lines.forEach((line, i) => {
    const at = `第 ${i + 1} 行:`;
    if (line.text.trim() === "") add(i, null, `${at}沒有字`);
    if (line.text.length > L.text) add(i, null, `${at}字太多了(最多 ${L.text} 個)`);
    if ((line.heard?.length ?? 0) > L.heard) add(i, null, `${at}聽到的字太長了`);
    if (!finite(line.start) || (line.end !== null && !finite(line.end))) {
      add(i, null, `${at}時間不是數字`);
      return;
    }
    if (line.start < 0) add(i, null, `${at}開始的時間不能早於 0 秒`);
    if (line.start > song) add(i, null, `${at}開始的時間(${secs(line.start)})在歌結束之後`);
    if (line.end !== null && line.end <= line.start) add(i, null, `${at}結束的時間要在開始之後`);
    if (line.end !== null && line.end > song + EPS) {
      add(i, null, `${at}結束的時間(${secs(line.end)})在歌結束之後`);
    }
    if (line.start <= prevStart + EPS && i > 0) {
      add(i, null, `${at}開始的時間要比上一行晚`);
    }
    prevStart = line.start;
    const pieces = line.pieces;
    if (pieces === null) {
      if (line.aligned) add(i, null, `${at}標成逐字對好了,卻沒有逐字的時間`);
      return;
    }
    if (pieces.length > L.pieces) add(i, null, `${at}片段太多了(最多 ${L.pieces} 個)`);
    if (pieces.map((p) => p.text).join("") !== line.text) {
      add(i, null, `${at}片段合起來要等於這一行的字`);
    }
    const lineEnd = line.end ?? song;
    let prevEnd = -Infinity;
    let untimed = false;
    for (const p of pieces) {
      const where = `${at}「${p.text}」`;
      if (p.text === "") add(i, null, `${at}有空的片段`);
      if ((p.reading?.length ?? 0) > L.reading || (p.roman?.length ?? 0) > L.reading) {
        add(i, null, `${where}的讀音太長了`);
      }
      if ((p.start === null) !== (p.end === null)) {
        add(i, null, `${where}只有開始或只有結束的時間`);
        continue;
      }
      if (p.start === null || p.end === null) {
        if (p.sung) untimed = true;
        continue;
      }
      if (!p.sung) {
        add(i, null, `${where}不用唱,不能有時間`);
        continue;
      }
      if (!finite(p.start) || !finite(p.end)) {
        add(i, null, `${where}的時間不是數字`);
        continue;
      }
      if (p.end <= p.start) add(i, null, `${where}結束的時間要在開始之後`);
      if (p.start < line.start - EPS || p.end > lineEnd + EPS) {
        add(i, null, `${where}在這一行的時間外面(${secs(p.start)}–${secs(p.end)})`);
      }
      if (p.start < prevEnd - EPS) add(i, null, `${where}和前一個字重疊了`);
      prevEnd = Math.max(prevEnd, p.end);
    }
    if (line.aligned && untimed) add(i, null, `${at}標成逐字對好了,還有字沒有時間`);
  });

  if (doc.notes.length > L.notes) add(null, null, `音符最多 ${L.notes} 個`);
  const byLine = new Map<number | null, { n: WorkersKaraokeNote; i: number }[]>();
  doc.notes.forEach((n, i) => {
    const at = `第 ${i + 1} 個音符:`;
    if (!finite(n.start) || !finite(n.end) || !finite(n.midi)) {
      add(null, i, `${at}不是數字`);
      return;
    }
    if (n.start < 0) add(null, i, `${at}開始的時間不能早於 0 秒`);
    if (n.end <= n.start) add(null, i, `${at}結束的時間要在開始之後`);
    if (n.end > song + EPS) add(null, i, `${at}在歌結束之後(${secs(n.end)})`);
    if (n.midi < L.midiLow || n.midi > L.midiHigh) {
      add(null, i, `${at}音高超出範圍(C1 到 C7)`);
    }
    if (n.line !== null) {
      const line = lines[n.line];
      if (!Number.isInteger(n.line) || line === undefined) {
        add(null, i, `${at}指到不存在的第 ${n.line + 1} 行`);
      } else if (n.char !== null) {
        const count = line.pieces?.length ?? 0;
        if (!Number.isInteger(n.char) || n.char < 0 || n.char >= count) {
          add(null, i, `${at}指到第 ${n.line + 1} 行不存在的字`);
        }
      }
    } else if (n.char !== null) {
      add(null, i, `${at}沒有行卻指到一個字`);
    }
    const group = byLine.get(n.line) ?? [];
    group.push({ n, i });
    byLine.set(n.line, group);
  });
  for (const [line, group] of byLine) {
    group.sort((a, b) => a.n.start - b.n.start);
    for (let j = 1; j < group.length; j++) {
      const a = group[j - 1] as { n: WorkersKaraokeNote; i: number };
      const b = group[j] as { n: WorkersKaraokeNote; i: number };
      if (b.n.start < a.n.end - EPS) {
        add(
          line,
          b.i,
          line === null
            ? `第 ${b.i + 1} 個音符和第 ${a.i + 1} 個重疊了`
            : `第 ${line + 1} 行:第 ${b.i + 1} 個音符和第 ${a.i + 1} 個重疊了`,
        );
      }
    }
  }
  return out;
}
