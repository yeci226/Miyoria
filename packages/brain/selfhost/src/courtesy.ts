// Reaction-only answers (v5-architecture §9.5): a line that is only a plain thank-you or goodbye
// to her gets an emoji and no run, now and then, so she does not call the model to say "不客氣".
//
// The matcher is small, conservative and deterministic: after her names, mentions, emoji,
// punctuation and a few soft particles are taken out, what is left must be nothing but known
// thank-you and goodbye phrases (zh-TW, English, Japanese). Anything else in the line (a request,
// a question, a name of someone else, one more word) and it is no match: the line wakes her as
// before. "謝謝你幫我查" is not a thank-you only; "不用謝" is not one either.
//
// The rest of the rules (a budget per place, a chance, nothing with a question, an attachment, a
// mention of someone else, a party game or a job of hers waiting there, a run going) are the
// host's (`SelfHost.#courtesy`), which also keeps the books of the turn it stands for.

/** What kind of line it is. */
export type CourtesyKind = "thanks" | "bye" | "night";

/** The longest line looked at (characters, before anything is taken out). */
const MAX_LINE_CHARS = 60;

/** Phrases, compared after NFKC, lower case and without spaces. */
const THANKS = [
  // zh-TW
  "謝謝",
  "謝啦",
  "謝囉",
  "謝了",
  "謝喔",
  "謝謝你",
  "謝謝妳",
  "感謝",
  "感謝你",
  "感謝妳",
  "感恩",
  "多謝",
  "3q",
  "3q囉",
  "揪感心",
  // English
  "thanks",
  "thank you",
  "thankyou",
  "thank u",
  "thanx",
  "thx",
  "ty",
  "tysm",
  "tyvm",
  "many thanks",
  // Japanese
  "ありがとう",
  "ありがと",
  "ありがとうございます",
  "ありがとうございました",
  "どうもありがとう",
  "サンキュー",
  "さんきゅ",
];

const BYE = [
  // zh-TW
  "掰掰",
  "掰",
  "拜拜",
  "掰囉",
  "拜囉",
  "再見",
  "881",
  "先下了",
  "我先下了",
  "下線了",
  "先走了",
  "我先走了",
  "明天見",
  "回頭見",
  "改天見",
  "下次見",
  // English
  "bye",
  "bye bye",
  "byebye",
  "goodbye",
  "good bye",
  "see you",
  "see ya",
  "see you later",
  "cya",
  "later",
  "ttyl",
  // Japanese
  "またね",
  "じゃあね",
  "じゃね",
  "バイバイ",
  "ばいばい",
  "さようなら",
  "さよなら",
  "また明日",
];

const NIGHT = [
  "晚安",
  "晚安安",
  "我去睡了",
  "去睡了",
  "睡了",
  "good night",
  "goodnight",
  "gn",
  "nighty night",
  "night",
  "おやすみ",
  "おやすみなさい",
];

/** Soft words that may come with a phrase and change nothing ("好喔謝謝", "thanks so much"). */
const FILLER = [
  "啦",
  "喔",
  "哦",
  "噢",
  "呀",
  "啊",
  "欸",
  "唷",
  "囉",
  "咯",
  "嘿",
  "哈",
  "嘻",
  "了",
  "好",
  "超",
  "很",
  "真的",
  "非常",
  "太",
  "大大",
  "so",
  "very",
  "much",
  "alot",
  "a lot",
  "lol",
  "haha",
  "hehe",
  "ね",
  "よ",
  "ー",
  "本当に",
  "ほんとに",
];

/** Words that make a line a question, whatever else it says. */
const QUESTION =
  /[?？嗎吗呢麼么]|\b(?:why|how|what|can|could|would|do you|is it)\b|ですか|ますか/iu;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

interface Phrase {
  text: string;
  kind: CourtesyKind | null;
}

/** Every phrase and filler, longest first, so "謝謝你" wins over "謝謝". */
const PHRASES: readonly Phrase[] = [
  ...THANKS.map((t) => ({ text: norm(t), kind: "thanks" as const })),
  ...BYE.map((t) => ({ text: norm(t), kind: "bye" as const })),
  ...NIGHT.map((t) => ({ text: norm(t), kind: "night" as const })),
  ...FILLER.map((t) => ({ text: norm(t), kind: null })),
].sort((a, b) => b.text.length - a.text.length);

/** `@name` and `<@id>` mentions, custom emoji `:name:` / `<:name:id>`, pictographs, symbols. */
const NOISE = [
  /<a?:\w{2,32}:\d{1,20}>/gu,
  /<@[!&]?\d{1,20}>/gu,
  /(?<![\w]):\w{2,32}:(?![\w])/gu,
  /\p{Extended_Pictographic}/gu,
  /[\u{1F3FB}-\u{1F3FF}]|\u{200D}|\u{FE0F}/gu,
];

/**
 * Whether `text` is only a thank-you or a goodbye said to her, and which; `null` for anything
 * else. `names`: her names, taken out wherever they stand. `onlyHerMentioned`: the platform says
 * the line mentions nobody but her, so an `@name` left (her account's display name) goes too;
 * otherwise any `@` left means it is said to someone else as well.
 */
export function courtesyKind(
  text: string,
  names: readonly string[],
  onlyHerMentioned = false,
): CourtesyKind | null {
  if ([...text].length > MAX_LINE_CHARS) return null;
  let rest = text.normalize("NFKC").toLowerCase();
  for (const noise of NOISE) rest = rest.replace(noise, " ");
  if (QUESTION.test(rest)) return null;
  const own = [...names]
    .map((n) => n.normalize("NFKC").toLowerCase().trim())
    .filter((n) => n !== "")
    .sort((a, b) => b.length - a.length);
  // `@米優`, unless it is the start of a longer Latin name (`@miyobot`).
  for (const name of own) {
    rest = rest.replace(new RegExp(`@${escapeRegExp(name)}(?![a-z0-9_])`, "gu"), " ");
  }
  if (onlyHerMentioned) rest = rest.replace(/@[^\s@]*/gu, " ");
  for (const name of own) rest = rest.split(name).join(" ");
  // A mention of anyone left: it is said to them too.
  if (rest.includes("@")) return null;
  // Spaces, punctuation, symbols and the tilde people draw out words with.
  rest = norm(rest).replace(/[\p{P}\p{S}]/gu, "");
  if (rest === "") return null;
  const kinds = new Set<CourtesyKind>();
  let i = 0;
  outer: while (i < rest.length) {
    for (const p of PHRASES) {
      if (p.text !== "" && rest.startsWith(p.text, i)) {
        if (p.kind !== null) kinds.add(p.kind);
        i += p.text.length;
        continue outer;
      }
    }
    return null;
  }
  if (kinds.has("night")) return "night";
  if (kinds.has("bye")) return "bye";
  if (kinds.has("thanks")) return "thanks";
  return null;
}

/** The reactions for each kind; one is picked at random. */
export const COURTESY_EMOJI: Readonly<Record<CourtesyKind, readonly string[]>> = {
  thanks: ["💕", "🥰", "😊"],
  bye: ["👋", "😊"],
  night: ["🌙", "😴", "💤"],
};

/** One of `COURTESY_EMOJI[kind]`, by `random` (0 ≤ r < 1). */
export function courtesyEmoji(kind: CourtesyKind, random: () => number): string {
  const list = COURTESY_EMOJI[kind];
  const at = Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)));
  return list[at] as string;
}

const HOUR_MS = 3_600_000;

/** Reaction-only answers per place in the last hour (in memory). */
export class CourtesyBudget {
  readonly #at = new Map<string, number[]>();

  used(place: string, now: number): number {
    const kept = (this.#at.get(place) ?? []).filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) this.#at.delete(place);
    else this.#at.set(place, kept);
    return kept.length;
  }

  take(place: string, now: number): void {
    this.#at.set(place, [...(this.#at.get(place) ?? []).filter((t) => now - t < HOUR_MS), now]);
  }
}

/** The note her transcript keeps of a reaction-only answer (she sees it in later runs). */
export const COURTESY_LABEL = "只按了反應";

/** The note's text; it follows the line it is about. */
export function courtesyNote(emoji: string): string {
  return `上面那則只是道謝或道別:你按了 ${emoji},沒有回話。`;
}
