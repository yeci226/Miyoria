// A cheap rolling "what are they talking about" note: frequent words of recent messages,
// without an LLM call per message. Latin words count whole; CJK text counts in character
// bigrams (no segmenter needed). A term must appear in at least two messages.

const LATIN_STOP = new Set([
  "the",
  "and",
  "you",
  "for",
  "that",
  "this",
  "with",
  "are",
  "was",
  "but",
  "not",
  "have",
  "just",
  "lol",
  "lmao",
  "yes",
  "yeah",
  "what",
  "how",
  "can",
  "its",
  "it's",
  "i'm",
  "don't",
  "http",
  "https",
]);

const CJK_STOP = new Set([
  "我們",
  "你們",
  "他們",
  "什麼",
  "這個",
  "那個",
  "一個",
  "沒有",
  "就是",
  "可以",
  "不是",
  "真的",
  "覺得",
  "知道",
  "現在",
  "今天",
  "然後",
  "因為",
  "所以",
  "怎麼",
  "還是",
  "已經",
  "自己",
  "一下",
  "這樣",
  "那樣",
  "時候",
  "東西",
  "的話",
  "好像",
  "應該",
  "不要",
  "我要",
  "我的",
  "你的",
  "他的",
  "是不",
  "不會",
  "有點",
  "一起",
  "哈哈",
  "呵呵",
  "我也",
  "你也",
  "這是",
  "那是",
  "是我",
  "是你",
  "了吧",
  "的人",
]);

const NOISE = /https?:\/\/\S+|<a?:\w+:\d+>|<[@#][!&]?\d+>/g;
const LATIN = /[a-z][a-z0-9'+#-]{2,}/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

/** Terms of one message, each once. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  const clean = text.toLowerCase().replace(NOISE, " ");
  for (const word of clean.match(LATIN) ?? []) {
    if (!LATIN_STOP.has(word)) out.add(word);
  }
  for (const run of clean.match(CJK) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      const pair = `${chars[i]}${chars[i + 1]}`;
      // Repeated characters ("哈哈", "www") are laughter, not topics.
      if (chars[i] === chars[i + 1] || CJK_STOP.has(pair)) continue;
      out.add(pair);
    }
  }
  return out;
}

function isCjk(term: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(term);
}

/** Up to `max` frequent terms of `texts` (each counted once per message). */
export function topicWords(texts: readonly string[], max = 5): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  const chosen: string[] = [];
  const used = new Set<string>();
  for (const [term] of ranked) {
    if (chosen.length >= max) break;
    // Overlapping bigrams of one word ("鯨魚", "魚娘") would repeat the same topic.
    if (isCjk(term) && [...term].some((c) => used.has(c))) continue;
    chosen.push(term);
    if (isCjk(term)) for (const c of term) used.add(c);
  }
  return chosen;
}
