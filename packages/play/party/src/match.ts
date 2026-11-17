// Forgiving comparison of what people say with an answer. Most answers arrive through speech
// recognition, so the text is never exact: it carries filler around the answer ("是晴天吧"), the
// recognizer writes simplified or variant characters, drops or swaps one character, or spells a
// Latin title without spaces. The rules here are deterministic: the same words always get the
// same verdict, and a near miss is reported as `close` for her to rule on, never silently passed.

import { Converter } from "opencc-js/t2cn";

let toSimplified: ((text: string) => string) | undefined;

/**
 * The form two texts are compared in: NFKC, lower case, simplified characters (so 臺/台 and the
 * recognizer's simplified output meet), letters and digits only.
 */
export function fold(text: string): string {
  const convert = toSimplified ?? Converter({ from: "tw", to: "cn" });
  toSimplified = convert;
  const simple = convert(text.normalize("NFKC").toLowerCase());
  return [...simple].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

/** Edit distance over code points. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[y.length] ?? 0;
}

/**
 * How much of `answer` (folded) the best stretch of `heard` (folded) gets right, 0..1: windows
 * of `heard` one shorter to one longer than the answer, so filler around it does not count.
 */
export function similarity(heard: string, answer: string): number {
  const h = [...heard];
  const n = [...answer].length;
  if (n === 0 || h.length === 0) return 0;
  let best = 0;
  for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
    if (len > h.length) {
      best = Math.max(best, 1 - editDistance(h.join(""), answer) / n);
      break;
    }
    for (let start = 0; start + len <= h.length; start++) {
      const window = h.slice(start, start + len).join("");
      best = Math.max(best, 1 - editDistance(window, answer) / n);
    }
  }
  return Math.max(0, best);
}

export type Verdict = "hit" | "close" | "miss";

/** Characters an answer may be wrong by and still count: none for one or two, one per four. */
function allowed(length: number): number {
  return length <= 2 ? 0 : Math.floor(length / 4) || 1;
}

/** Longest heard text compared (a long utterance is not an answer, and costs time). */
const MAX_HEARD = 60;

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** One run of Chinese numerals as digits: 十二 → 12, 一百八十 → 180, 八八六 → 886. */
function cnNumber(run: string): string {
  const chars = [...run];
  if (!chars.some((c) => c in CN_UNITS)) return chars.map((c) => CN_DIGITS[c] ?? "").join("");
  let total = 0;
  let digit = 0;
  for (const c of chars) {
    const unit = CN_UNITS[c];
    if (unit === undefined) digit = CN_DIGITS[c] ?? 0;
    else {
      total += (digit || 1) * unit;
      digit = 0;
    }
  }
  return String(total + digit);
}

/** The numbers said in folded text, Chinese numerals included ("十七天" → ["17"]). */
export function numbersIn(folded: string): string[] {
  const digits = folded.replace(/[零〇一二两三四五六七八九十百千]+/gu, (run) => cnNumber(run));
  return digits.match(/\d+/g) ?? [];
}

/**
 * Whether `heard` gives one of `answers`: `hit` when it contains one, or comes within the allowed
 * errors of one; `close` when it gets at least half of one right (or names more than half of a
 * long one); `miss` otherwise. A number has to be said exactly ("十七" is not "7").
 */
export function judgeAnswer(heard: string, answers: readonly string[]): Verdict {
  const h = [...fold(heard)].slice(0, MAX_HEARD).join("");
  if (h === "") return "miss";
  let close = false;
  for (const raw of answers) {
    const a = fold(raw);
    const n = [...a].length;
    if (n === 0) continue;
    if (/^\d+$/.test(a)) {
      if (numbersIn(h).includes(a)) return "hit";
      continue;
    }
    if (h.includes(a)) return "hit";
    // Three quarters of a long title is enough: people drop its tail ("說好不哭" for "說好不哭
    // with 五月天"). A short one has to be said whole.
    if (n >= 6 && a.includes(h) && [...h].length * 4 >= n * 3) return "hit";
    const sim = similarity(h, a);
    if (sim >= 1 - allowed(n) / n) return "hit";
    if (sim >= 0.5 || (n >= 4 && a.includes(h) && [...h].length * 2 > n)) close = true;
  }
  return close ? "close" : "miss";
}

/** How far a near miss is, for her (never the answer itself): "差 1 個字(答案 2 個字)". */
export function closeness(heard: string, answers: readonly string[]): string {
  const h = fold(heard);
  let best = Number.POSITIVE_INFINITY;
  let length = 0;
  for (const raw of answers) {
    const a = fold(raw);
    const n = [...a].length;
    if (n === 0) continue;
    const off = Math.round((1 - similarity(h, a)) * n);
    if (off < best) {
      best = off;
      length = n;
    }
  }
  if (!Number.isFinite(best)) return "有點接近";
  return best <= 0 ? "幾乎一樣" : `差 ${best} 個字(答案 ${length} 個字)`;
}

const STOP_PHRASES = [
  "结束游戏",
  "游戏结束",
  "停止游戏",
  "不玩了",
  "不要玩了",
  "别玩了",
  "先不玩了",
];

/**
 * Someone asks for the game to end. Only an utterance that is mostly the phrase counts ("好啦不玩
 * 了"), so a story line that mentions a game ending does not stop one.
 */
export function asksToStop(text: string): boolean {
  const f = fold(text);
  return STOP_PHRASES.some((p) => f.includes(p) && [...f].length <= [...p].length + 4);
}

/** Han characters (one code point each in the sense the chains need). */
export function isHan(c: string): boolean {
  return /\p{Script=Han}/u.test(c);
}

/** Particles a spoken word may trail ("天空啊"), not part of it. */
const TRAILING = new Set([..."了啊吧呢嗎吗喔哦耶呀啦唷欸诶嘛"]);

/** The Han runs of `text`, in order, each with its folded form beside the original. */
export function hanRuns(text: string): string[] {
  const out: string[] = [];
  let run = "";
  for (const c of text.normalize("NFKC")) {
    if (isHan(c)) run += c;
    else {
      if (run !== "") out.push(run);
      run = "";
    }
  }
  if (run !== "") out.push(run);
  return out;
}

/** Drops the particles a run ends with. */
export function trimParticles(word: string): string {
  const chars = [...word];
  while (chars.length > 0 && TRAILING.has(chars.at(-1) ?? "")) chars.pop();
  return chars.join("");
}

/** Whether two single characters are the same once folded (台 / 臺, 吗 / 嗎). */
export function sameChar(a: string, b: string): boolean {
  return a === b || (a !== "" && fold(a) === fold(b));
}
