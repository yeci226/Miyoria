// What a program can count over a batch of replies (docs/design/persona-v4.md §6.4): catchphrase
// frequency, how many end in a question, the length spread and how the replies open. The two
// things the document leaves to a person or a judge (how many jab first, whether the grumbling
// is followed by help) are not counted here.

/** The catchphrases of §6.4. */
export const CATCHPHRASES: readonly string[] = [
  "好啦",
  "哼",
  "真是的",
  "可別",
  "才、才不是",
  "baka",
  "伺服器繁忙",
  "大肥魚",
];

/** Of those, the ones that are stock openers; a reply that starts with one is counted apart. */
export const STOCK_OPENERS: readonly string[] = ["好啦", "哼", "真是的", "可別", "才、才不是"];

const SILENCE = /^<silence\s*\/>$/i;
const TAGS = /<emo:[^>]*>|<\/?[a-z][a-z0-9_-]*\s*\/?>/gi;

/** The reply as people read it: no emotion tags, trimmed. `<silence/>` alone is "". */
export function visibleText(reply: string): string {
  return reply.replace(TAGS, "").trim();
}

export function isSilence(reply: string): boolean {
  return SILENCE.test(reply.trim());
}

/** Characters (code points), not UTF-16 units. */
export function lengthOf(text: string): number {
  return [...text].length;
}

/** Nearest-rank percentile of `values` (`p` in 0..100); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

/** The first two characters of the reply, past punctuation and spaces. */
export function openingOf(text: string): string {
  const letters = text.replace(/^[\s\p{P}\p{S}]+/u, "");
  return [...letters].slice(0, 2).join("");
}

export interface Counters {
  /** Replies counted. */
  replies: number;
  /** Replies that are only `<silence/>` (left out of every number below). */
  silent: number;
  /** Share of replies that contain at least one catchphrase, 0..1. */
  catchphrase_rate: number;
  /** Replies containing each catchphrase. */
  catchphrases: Record<string, number>;
  /** Share of replies that end in a question mark, 0..1. */
  question_rate: number;
  length: { p10: number; p50: number; p90: number; p90_over_p50: number; p90_over_p10: number };
  openings: {
    /** Distinct openings over replies: 1 is every reply opening differently. */
    distinct_share: number;
    /** Share of replies that start with a stock opener (`STOCK_OPENERS`). */
    stock_opener_rate: number;
    /** The most common openings. */
    top: { opening: string; count: number }[];
  };
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 100) / 100);
const share = (n: number, of: number): number =>
  of === 0 ? 0 : Math.round((n / of) * 1000) / 1000;

export function countReplies(replies: readonly string[]): Counters {
  const spoken = replies.filter((r) => !isSilence(r)).map(visibleText);
  const texts = spoken.filter((t) => t !== "");
  const lengths = texts.map(lengthOf);

  const catchphrases: Record<string, number> = {};
  for (const phrase of CATCHPHRASES) {
    catchphrases[phrase] = texts.filter((t) => t.includes(phrase)).length;
  }
  const withAny = texts.filter((t) => CATCHPHRASES.some((p) => t.includes(p))).length;
  const questions = texts.filter((t) => /[?？]$/.test(t)).length;

  const opened = new Map<string, number>();
  for (const t of texts) {
    const o = openingOf(t);
    if (o !== "") opened.set(o, (opened.get(o) ?? 0) + 1);
  }
  const stock = texts.filter((t) => {
    const letters = t.replace(/^[\s\p{P}\p{S}]+/u, "");
    return STOCK_OPENERS.some((p) => letters.startsWith(p));
  }).length;

  const p10 = percentile(lengths, 10);
  const p50 = percentile(lengths, 50);
  const p90 = percentile(lengths, 90);
  return {
    replies: replies.length,
    silent: replies.length - texts.length,
    catchphrase_rate: share(withAny, texts.length),
    catchphrases,
    question_rate: share(questions, texts.length),
    length: {
      p10,
      p50,
      p90,
      p90_over_p50: ratio(p90, p50),
      p90_over_p10: ratio(p90, p10),
    },
    openings: {
      distinct_share: share(opened.size, texts.length),
      stock_opener_rate: share(stock, texts.length),
      top: [...opened.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([opening, count]) => ({ opening, count })),
    },
  };
}
