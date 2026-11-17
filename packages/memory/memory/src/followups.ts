// Whether two followups are about the same thing. The summarizer words the same question anew
// every time it sees it (2026-11-09 to 11-10: ten records of 「外掃區收得怎樣」 for one person,
// 「問他外掃區的那個問題」, 「追問外掃區後來收得怎樣」, 「外掃區把最懶兩人當副組長那招…」),
// so text similarity misses them and she asked it again and again. What they share is the matter
// itself: a run of words once the asking (「問他」「後來」「有沒有」) and the names are taken out.

import { simplify, tokenize } from "./tokenize.js";

/** Words of asking, in simplified characters, that say nothing about what is asked. */
const FILLER: readonly string[] = [
  "还没回答",
  "怎么回事",
  "没回答",
  "怎么样",
  "怎么了",
  "那件事",
  "问一下",
  "上线后",
  "时候",
  "后来",
  "后续",
  "以及",
  "还有",
  "顺便",
  "最后",
  "进度",
  "之后",
  "之前",
  "以后",
  "是否",
  "已经",
  "确认",
  "明天",
  "今天",
  "昨天",
  "昨晚",
  "今晚",
  "早上",
  "晚上",
  "下次",
  "上线",
  "到底",
  "结果",
  "问题",
  "问问",
  "追问",
  "问他",
  "问她",
  "那个",
  "这个",
  "那招",
  "这招",
  "事情",
  "一下",
  "看看",
  "还没",
  "回答",
  "情况",
  "现在",
  "最近",
  "一起",
  "有用",
  "有效",
  "怎样",
  "如何",
  "什么",
  "哪一",
  "哪个",
  "问",
  "哪",
  "谁",
  "是",
  "得",
  "要",
  "请",
  "让",
  "我",
  "你",
  "看",
  "等",
  "那",
  "否",
  "时",
  "他",
  "她",
  "的",
  "了",
  "吗",
  "呢",
  "吧",
  "事",
];

/** 「要不要」「有沒有」「管不管」: an A-not-A question, whatever it asks. */
const A_NOT_A = /(\p{Script=Han})[不没]\1/gu;
const HAN = /\p{Script=Han}/u;
/** Never part of a match: where something was taken out. */
const CUT = "|";

/** The matter of `text`: Han runs without names, asking words and A-not-A questions. */
function matter(text: string, names: readonly string[]): string {
  let s = simplify(text.toLowerCase());
  for (const name of names) {
    const n = simplify(name.trim().toLowerCase());
    if (n !== "") s = s.replaceAll(n, CUT);
  }
  s = s.replace(A_NOT_A, CUT);
  for (const word of FILLER) s = s.replaceAll(word, CUT);
  return [...s].map((c) => (HAN.test(c) ? c : CUT)).join("");
}

/** Longest run of characters both have (a cut never matches). */
function longestCommon(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      const c = x[i - 1];
      if (c !== CUT && c === y[j - 1]) {
        row[j] = (prev[j - 1] ?? 0) + 1;
        if ((row[j] ?? 0) > best) best = row[j] ?? 0;
      }
    }
    prev = row;
  }
  return best;
}

/** Runs of `n` characters of `s` that cross no cut. */
function grams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  const chars = [...s];
  for (let i = 0; i + n <= chars.length; i++) {
    const run = chars.slice(i, i + n);
    if (!run.includes(CUT)) out.add(run.join(""));
  }
  return out;
}

/** Words (not Han) of `text` that are not names. */
function words(text: string, names: readonly string[]): Set<string> {
  const skip = new Set(names.flatMap((n) => tokenize(n)));
  return new Set(tokenize(text).filter((t) => !HAN.test(t) && !skip.has(t)));
}

/**
 * Whether two followups ask about the same matter: a run of three characters of it in common that
 * is half of the shorter one, two such runs, or half of the shorter one's character pairs. Text
 * without Han characters compares its words instead. `names`: names of the people involved, which
 * say nothing about the matter.
 */
export function sameMatter(a: string, b: string, names: readonly string[] = []): boolean {
  const ma = matter(a, names);
  const mb = matter(b, names);
  const la = [...ma.replaceAll(CUT, "")].length;
  const lb = [...mb.replaceAll(CUT, "")].length;
  if (la > 0 && lb > 0) {
    // A run of three that is half of the shorter one (「問他外掃區的那個問題」 is 「外掃區」), or
    // more than one run of three (「外掃區」 and 「副組長」).
    const run = longestCommon(ma, mb);
    if (run >= 3 && run * 2 >= Math.min(la, lb)) return true;
    const ta = grams(ma, 3);
    let shared = 0;
    for (const g of grams(mb, 3)) if (ta.has(g)) shared += 1;
    if (shared >= 2) return true;
    const ga = grams(ma, 2);
    const gb = grams(mb, 2);
    let common = 0;
    for (const g of ga) if (gb.has(g)) common += 1;
    const smaller = Math.min(ga.size, gb.size);
    return common >= 2 && smaller > 0 && common / smaller >= 0.5;
  }
  const wa = words(a, names);
  const wb = words(b, names);
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  const smaller = Math.min(wa.size, wb.size);
  return common >= 2 && smaller > 0 && common / smaller >= 0.6;
}
