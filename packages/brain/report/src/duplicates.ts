// Likely duplicates: the words of a report's title to search the repository's open issues with,
// and how alike two titles are. The search is GitHub's (title keywords, open issues only); which
// of its answers counts as a likely duplicate is decided here, so a loose search match is not one.

import { REMOVED } from "./sanitize.js";

const HAN = /\p{Script=Han}/u;
const RUNS = /\p{Script=Han}+|[\p{L}\p{N}]+/gu;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "it",
  "to",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "not",
  "no",
  "with",
  "for",
  "when",
  "can",
  "cant",
  "does",
  "doesnt",
  "dont",
  "after",
  "her",
  "she",
]);

/** Single characters a Chinese title is full of that say nothing about the problem. */
const HAN_FILLER = /[的了是不會在我你妳她他有沒都很嗎啦喔耶就也又還被把跟和]/gu;

/** The words of `title` worth searching with: at most `limit`, longest first. */
export function searchTerms(title: string, limit = 3): string[] {
  let text = title.normalize("NFKC").toLowerCase();
  for (const removed of Object.values(REMOVED)) text = text.split(removed).join(" ");
  const found = new Set<string>();
  for (const run of text.match(RUNS) ?? []) {
    if (HAN.test(run)) {
      for (const part of run.replace(HAN_FILLER, " ").split(" ")) {
        if ([...part].length >= 2) found.add(part);
      }
    } else if (run.length >= 2 && !STOP_WORDS.has(run)) {
      found.add(run);
    }
  }
  return [...found]
    .sort((a, b) => [...b].length - [...a].length || (a < b ? -1 : 1))
    .slice(0, limit);
}

/** The pieces two titles are compared by: words, and each pair of neighbouring Han characters. */
function pieces(title: string): Set<string> {
  const out = new Set<string>();
  // An area prefix (`[voice] ...`) says where, not what.
  const text = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\s*\[[^\]]{0,40}\]\s*/, "");
  for (const run of text.match(RUNS) ?? []) {
    if (!HAN.test(run)) {
      if (run.length >= 2 && !STOP_WORDS.has(run)) out.add(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) out.add(run);
    for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

/** How alike two titles are, from 0 to 1 (the Dice coefficient of their pieces). */
export function titleSimilarity(a: string, b: string): number {
  const x = pieces(a);
  const y = pieces(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const p of x) if (y.has(p)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** A search answer this alike is a likely duplicate. */
export const LIKELY_DUPLICATE = 0.4;

export interface IssueMatch {
  number: number;
  title: string;
  url: string;
}

/** The open issue most like `title`, when one is alike enough. */
export function likelyDuplicate(
  title: string,
  candidates: readonly IssueMatch[],
): (IssueMatch & { score: number }) | null {
  let best: (IssueMatch & { score: number }) | null = null;
  for (const c of candidates) {
    const score = titleSimilarity(title, c.title);
    if (score >= LIKELY_DUPLICATE && (best === null || score > best.score)) best = { ...c, score };
  }
  return best;
}
