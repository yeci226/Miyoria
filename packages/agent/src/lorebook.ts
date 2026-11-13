// The profile's lorebook (`lorebook.toml`, SillyTavern's World Info) and the style note of a turn
// (its Author's Note). Nothing of it sits in the fixed front of the prompt: what a turn brings up
// goes into `<style_note>` in the per-turn tail, so the cached prefix stays the same.
//
// * Entries come up when one of their keys is in the last few lines other people wrote or in the
//   message she answers (any case), or when her mood is one of theirs; at most `MAX_ENTRIES`, by
//   priority. Her own lines do not count: a reminder about rice brought up by her own talk of rice
//   would keep her on it.
// * Kaomoji (text only): `KAOMOJI_PICKS` faces, mostly of the group(s) of her mood and one or two of
//   the others, none she used in her last lines, in an order seeded by the turn.

import type { Lorebook, LoreEntry } from "@miyoria/profile";

/** Entries shown in one turn at most. */
export const MAX_ENTRIES = 3;
/** Kaomoji offered in one text turn. */
export const KAOMOJI_PICKS = 4;
/** Lines of other people's (before the ones she answers) where keys are looked for. */
export const SCAN_LINES = 4;
/** Her own lines whose kaomoji are not offered again. */
export const RECENT_OWN_LINES = 10;

/** The entries `text` (lower-cased already or not) or `moods` bring up, highest priority first. */
export function triggeredEntries(
  book: Lorebook | null,
  scan: string,
  moods: ReadonlySet<string>,
  voice: boolean,
  max = MAX_ENTRIES,
): LoreEntry[] {
  if (book === null || max <= 0) return [];
  const text = scan.toLowerCase();
  const hit = (e: LoreEntry) =>
    e.keys.some((k) => k.trim() !== "" && text.includes(k.trim().toLowerCase())) ||
    e.moods.some((m) => moods.has(m));
  return book.entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.channel === "both" || (e.channel === "voice") === voice) && hit(e))
    .sort((a, b) => b.e.priority - a.e.priority || a.i - b.i)
    .slice(0, max)
    .map(({ e }) => e);
}

/** A number generator for `seed` (mulberry32): the same picks for the same turn. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * `count` kaomoji for a text turn: mostly from the groups of `moods`, one or two from the others
 * (all from every group when no group is hers), none that is in `recent` (her last lines).
 */
export function pickKaomoji(
  book: Lorebook | null,
  moods: ReadonlySet<string>,
  recent: readonly string[],
  seed: number,
  count = KAOMOJI_PICKS,
): string[] {
  if (book === null || count <= 0) return [];
  const said = recent.join("\n");
  const fresh = (faces: readonly string[]) =>
    [...new Set(faces.map((f) => f.trim()))].filter((f) => f !== "" && !said.includes(f));
  const random = seeded(seed);
  const mine = book.kaomoji.filter((g) => g.moods.some((m) => moods.has(m)));
  const others = book.kaomoji.filter((g) => !mine.includes(g));
  const main = shuffled(fresh(mine.flatMap((g) => g.faces)), random);
  const rest = shuffled(
    fresh(others.flatMap((g) => g.faces)).filter((f) => !main.includes(f)),
    random,
  );
  if (main.length === 0) return rest.slice(0, count);
  // Mostly hers: of 4, one from the other groups; two from 6 on.
  const wantOthers = count < 2 ? 0 : count < 6 ? 1 : 2;
  const fromMain = Math.max(count - Math.min(wantOthers, rest.length), 0);
  const picked = main.slice(0, fromMain);
  return [...picked, ...rest.slice(0, count - picked.length)];
}

/** The style note's fixed lines. */
export const STYLE_LINES = {
  text: [
    "- 回覆開頭先放這一刻的 <emo:名稱>(不想開口就只輸出 <silence/>)。",
    "- 短短的、口語,想到什麼說什麼;一句吐槽或一聲驚呼就可以是整個回覆。",
    "- 顏文字只在情緒特別滿的時候用(大約四則一個,一則最多一個),一般回話不用;伺服器表情(:名字:)不算顏文字。",
  ],
  voice: [
    "- 回覆開頭先放這一刻的 <emo:名稱>(不想開口就只輸出 <silence/>)。",
    "- 講短一點、口語、念得出來,不用顏文字和 emoji。",
  ],
} as const;

/** The line that offers this turn's kaomoji. */
export const KAOMOJI_LINE = "- 這回合想用顏文字的話從這幾個挑:";

/** The body of `<style_note>`: the fixed lines, the kaomoji picks (text), the entries. */
export function styleNote(
  voice: boolean,
  kaomoji: readonly string[],
  entries: readonly LoreEntry[],
): string {
  const lines: string[] = [...(voice ? STYLE_LINES.voice : STYLE_LINES.text)];
  if (!voice && kaomoji.length > 0) lines.push(`${KAOMOJI_LINE}${kaomoji.join(" ")}`);
  for (const e of entries) {
    const text = e.text.replace(/\s+/g, " ").trim();
    if (text !== "") lines.push(`- ${text}`);
  }
  return lines.join("\n");
}
