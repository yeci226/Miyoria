// Search tokens for Chinese, Japanese and Latin text.
//
// Han runs are converted to simplified characters (OpenCC, Taiwan variants to mainland) and
// segmented with jieba (search mode, HMM on); kana and Latin runs are split at script boundaries
// and non-word characters. Everything is lowercased, full-width ASCII is folded and stop words
// are dropped. The same function is used for stored `tokens` and for queries.

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";
import * as OpenCC from "opencc-js";

let jieba: Jieba | undefined;
let toSimplified: ((text: string) => string) | undefined;

function segmenter(): Jieba {
  jieba ??= Jieba.withDict(dict);
  return jieba;
}

/** `text` with traditional Han characters converted to simplified (OpenCC, Taiwan to mainland). */
export function simplify(text: string): string {
  const convert: (text: string) => string =
    toSimplified ?? OpenCC.Converter({ from: "tw", to: "cn" });
  toSimplified = convert;
  return convert(text);
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  // Chinese (traditional and simplified)
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "妳",
  "他",
  "她",
  "它",
  "牠",
  "我們",
  "你們",
  "他們",
  "她們",
  "我们",
  "你们",
  "他们",
  "和",
  "與",
  "与",
  "也",
  "就",
  "都",
  "而",
  "及",
  "著",
  "着",
  "啊",
  "吧",
  "呢",
  "嗎",
  "吗",
  "喔",
  "哦",
  "呀",
  "啦",
  "欸",
  "耶",
  "嘛",
  "哈",
  "哈哈",
  "嗯",
  "這",
  "那",
  "这",
  "這個",
  "那個",
  "这个",
  "那个",
  "一個",
  "一个",
  "有",
  "沒",
  "没",
  "沒有",
  "没有",
  "不",
  "很",
  "會",
  "会",
  "要",
  "說",
  "说",
  "跟",
  "把",
  "被",
  "讓",
  "让",
  "給",
  "给",
  "對",
  "对",
  "什麼",
  "什么",
  "怎麼",
  "怎么",
  "為",
  "为",
  "還",
  "还",
  "又",
  "再",
  "之",
  "其",
  "或",
  "但",
  "所以",
  "因為",
  "因为",
  "如果",
  "然後",
  "然后",
  "就是",
  "可以",
  "自己",
  "一下",
  "一些",
  "一樣",
  "一样",
  "這樣",
  "这样",
  "那樣",
  "那样",
  "上",
  "下",
  "中",
  "裡",
  "里",
  "得",
  "地",
  "個",
  "个",
  "些",
  "記得",
  "记得",
  // Japanese
  "が",
  "は",
  "を",
  "の",
  "に",
  "で",
  "と",
  "も",
  "へ",
  "や",
  "か",
  "ね",
  "よ",
  "な",
  "わ",
  "て",
  "た",
  "だ",
  "です",
  "ます",
  "でした",
  "ました",
  "から",
  "まで",
  "より",
  "けど",
  "って",
  "これ",
  "それ",
  "あれ",
  "この",
  "その",
  "あの",
  "ここ",
  "そこ",
  "する",
  "した",
  "して",
  "いる",
  "ある",
  "ない",
  "なる",
  "こと",
  "もの",
  "よね",
  "かな",
  "でも",
  "私",
  "僕",
  "俺",
  "あなた",
  "さん",
  "ちゃん",
  // English
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "am",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "as",
  "what",
  "who",
  "how",
  "why",
  "when",
  "where",
  "which",
  "can",
  "will",
  "would",
  "should",
  "could",
  "just",
  "about",
  "im",
  "dont",
  "lol",
  "ok",
  "okay",
  "yes",
  "yeah",
]);

type Script = "han" | "hiragana" | "katakana" | "word" | "other";

/** Rust `char::is_alphanumeric`: Alphabetic or Numeric. */
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;

function script(c: string): Script {
  const cp = c.codePointAt(0) ?? 0;
  if (
    cp === 0x3005 ||
    cp === 0x3007 ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  ) {
    return "han";
  }
  if (cp >= 0x3041 && cp <= 0x309f) return "hiragana";
  if (
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff66 && cp <= 0xff9f)
  ) {
    return "katakana";
  }
  return ALPHANUMERIC.test(c) ? "word" : "other";
}

/** Lowercases and folds full-width ASCII (`Ｏｗｅｎ` → `owen`). */
function normalize(text: string): string {
  let out = "";
  for (const c of text) {
    const cp = c.codePointAt(0) ?? 0;
    let mapped = c;
    if (cp >= 0xff01 && cp <= 0xff5e) mapped = String.fromCodePoint(cp - 0xfee0);
    else if (cp === 0x3000) mapped = " ";
    out += mapped.toLowerCase();
  }
  return out;
}

class Collector {
  readonly out: string[] = [];
  readonly #seen = new Set<string>();

  flush(run: string, s: Script): void {
    if (run === "") return;
    switch (s) {
      case "han":
        // jieba's dictionary is simplified Chinese; traditional text is converted first so
        // both scripts segment (and match) alike.
        for (const word of segmenter().cutForSearch(simplify(run), true)) this.push(word);
        break;
      case "hiragana":
      case "katakana":
      case "word":
        this.push(run);
        break;
      case "other":
        break;
    }
  }

  push(raw: string): void {
    const token = raw.trim();
    if (token === "" || STOP_WORDS.has(token)) return;
    const chars = [...token];
    const first = chars[0] === undefined ? undefined : script(chars[0]);
    const single = chars.length === 1;
    // Single Latin letters and lone kana carry no meaning on their own.
    const meaningless =
      single && (first === "hiragana" || first === "katakana" || /^[A-Za-z]+$/.test(token));
    if (!meaningless && !this.#seen.has(token)) {
      this.#seen.add(token);
      this.out.push(token);
    }
  }
}

/** Search tokens of `text`, in order of first appearance, without duplicates. */
export function tokenize(text: string): string[] {
  const collector = new Collector();
  let run = "";
  let runScript: Script = "other";
  for (const c of normalize(text)) {
    const s = script(c);
    if (s !== runScript) {
      collector.flush(run, runScript);
      run = "";
      runScript = s;
    }
    if (s !== "other") run += c;
  }
  collector.flush(run, runScript);
  return collector.out;
}

/** Tokens joined with spaces, as stored in `MemoryRecord.tokens`. */
export function tokenString(text: string): string {
  return tokenize(text).join(" ");
}

/** Text with case, width, whitespace and punctuation removed, for near-duplicate detection. */
export function normalizeForCompare(text: string): string {
  let out = "";
  for (const c of normalize(text)) if (script(c) !== "other") out += c;
  return out;
}

/** Dice coefficient of character bigrams of two normalized strings (0..1). */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return na === "" ? 0 : 1;
  const grams = (s: string): string[] => {
    const chars = [...s];
    if (chars.length === 1) return [`${chars[0]}\0`];
    const out: string[] = [];
    for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}\u0001${chars[i + 1]}`);
    return out;
  };
  const ga = grams(na);
  const gb = grams(nb);
  if (ga.length === 0 || gb.length === 0) return 0;
  const total = ga.length + gb.length;
  const remaining = new Map<string, number>();
  for (const g of gb) remaining.set(g, (remaining.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of ga) {
    const n = remaining.get(g) ?? 0;
    if (n > 0) {
      remaining.set(g, n - 1);
      common += 1;
    }
  }
  return (2 * common) / total;
}
