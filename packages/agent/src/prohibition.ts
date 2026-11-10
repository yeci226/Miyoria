// The safety net under `directive_add` (docs/design/backlog.md, fixture
// `mc-owner-rule-never-written`): the owner told her four times not to play Minecraft, she said
// yes every time, and no rule was ever written, so the next `game.start` went through.
//
// Writing a rule stays the main line's choice. Only what cannot be misread is caught here: a plain
// "don't play <a game she has>" in a message of this turn. When she did not write a rule in that
// turn herself, the turn writes it for her, as the person who said it: the directive service
// decides, as for her own call, whether that person may make the rule (a viewer's becomes a wish
// or is refused). "For now" / "today" makes it last `TEMPORARY_MINUTES`.

/** A prohibition read off a message. */
export interface Prohibition {
  /** The game, as its rule scope names it (`minecraft`). */
  activity: string;
  /** The rule in the person's words (the sentence that said it). */
  text: string;
  /** `null`: until revoked (for the owner). */
  minutes: number | null;
}

/** Games she can start, and what people call them. */
export const GAME_NAMES: Readonly<Record<string, readonly string[]>> = {
  minecraft: ["minecraft", "麥塊", "當個創世神", "mc"],
  osu: ["osu!", "osu"],
};

/** How long a "for now" rule lasts. */
export const TEMPORARY_MINUTES = 6 * 60;

const NEGATION =
  /(?:不要|別|不准|不可以|不能|禁止|不許|不用)(?:再|先|繼續|一直)?(?:去)?(?:玩|開|打|碰)/g;
const TEMPORARY = /先|今天|今晚|等一下|暫時|這陣子|這幾天/;
/** "Don't play it for so long", "can't play" (ability): not a ban. */
const NOT_A_BAN = /太久|那麼久|一直玩|玩太|玩不了|不能玩了嗎|可以玩|不玩了|要不要/;

function sentenceAround(text: string, at: number): string {
  const ends = /[。.!！?？\n]/;
  let start = at;
  while (start > 0 && !ends.test(text[start - 1] ?? "")) start--;
  let end = at;
  while (end < text.length && !ends.test(text[end] ?? "")) end++;
  return text.slice(start, Math.min(end + 1, text.length)).trim();
}

/**
 * The prohibition `text` states, or `null`: a negated "play / open" followed (within a few
 * characters) by the name of a game in `games`, in a sentence that is not about playing too long.
 */
export function prohibitionOf(
  text: string,
  games: Readonly<Record<string, readonly string[]>> = GAME_NAMES,
): Prohibition | null {
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(NEGATION)) {
    // "I don't (want to) play": about the speaker, not a rule for her ("we" still counts).
    const before = lower.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0);
    if (
      /我(?:先|也|就|才|還|今天)?$/.test(before) &&
      !/我們(?:先|也|就|才|還|今天)?$/.test(before)
    ) {
      continue;
    }
    const at = (m.index ?? 0) + m[0].length;
    const after = lower.slice(at, at + 16);
    const sentence = sentenceAround(text, m.index ?? 0);
    if (NOT_A_BAN.test(sentence)) continue;
    for (const [activity, names] of Object.entries(games)) {
      const named = names.some((n) => {
        const i = after.indexOf(n);
        if (i < 0) return false;
        // `mc` and `osu` must stand alone, not inside a longer word.
        const next = after[i + n.length] ?? "";
        return !/[a-z0-9]/.test(next);
      });
      if (!named) continue;
      return {
        activity,
        text: sentence === "" ? text.trim() : sentence,
        minutes: TEMPORARY.test(sentence) ? TEMPORARY_MINUTES : null,
      };
    }
  }
  return null;
}
