// One wish of hers, wherever it is kept (docs/design/v4-plan.md §2.4, §7.6, §8.2).
//
// 2026-11-10: she asked one person the same thing ten times in 100 minutes. One wish ("ask S how
// X went") lived in three stores at once: a proposal on the board, a commitment of the main line
// and a goal of her Plan, and later a timer could have been a fourth. None of them knew of the
// others, none was closed when she had asked or when S had answered, and each could raise it
// again. Here a wish is one thing with one key, person plus topic:
//
// * every store that holds it registers itself as a holder (`commitment:<id>`, `proposal:<id>`,
//   `goal:<id>`, `reminder:<id>`), and a holder about the same person and topic joins the wish
//   that is there instead of starting another;
// * once she asked (a line or a message reached the person), or the person answered, or told her
//   they were asked already, the wish changes state in the EventLog (`decision`, source `wish`)
//   and every store closes its holder from there;
// * before anything raises a wish again (a due commitment, a proposal, a goal, a timer) it asks
//   `screen`: answered or told to stop means never; asked and not answered means one polite
//   follow-up at most, after a long configured gap.
//
// Topics are matched by cheap code, never by a model: the words of a wish without the person, the
// times and the words every request has ("問", "之後", "上線時"), as character pairs, and two
// texts are about the same thing when most pairs of the shorter one are in the other.

import type { Handle } from "./handle.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Source of the `decision` events that carry a wish. */
export const WISH_SOURCE = "wish";

/** Why a wish stopped being open: she asked, they answered, they said stop, or it went stale. */
export type WishEnd = "asked" | "answered" | "stop" | "expired";

/**
 * `open`: not raised yet. `asked`: she raised it and waits for an answer (one follow-up may come,
 * much later). `closed`: answered, refused or stale; nothing raises it again.
 */
export type WishState = "open" | "asked" | "closed";

export interface Wish {
  /** `wish:<handle>:<id>`: the person and the first holder that raised the topic. */
  key: string;
  person: Handle;
  /** What it is about, in the words of its first holder (cut). */
  topic: string;
  /** The stores holding it: `commitment:<id>`, `proposal:<id>`, `goal:<id>`, `reminder:<id>`. */
  holders: string[];
  state: WishState;
  made_at: Timestamp;
  /** The last time she raised it with them. */
  asked_at: Timestamp | null;
  /** How often she raised it. */
  asked: number;
  closed_at: Timestamp | null;
  /** Why it is no longer open. */
  end: WishEnd | null;
}

/** The `body` of a `decision` event of source `wish`. */
export interface WishBody {
  wish: Wish;
}

/** Whether something may raise a wish now. */
export type WishVerdict =
  | { raise: true; wish: Wish | null }
  | {
      raise: false;
      wish: Wish;
      /** Why not, in her words (for the log and her ledger). */
      why: string;
      /** It may be raised again from then on (a follow-up); `null`: never. */
      until: Timestamp | null;
    };

/** Provided by the `arbiter` module. Answers from memory, writes to the EventLog. */
export interface Wishes {
  /**
   * `holder` holds the wish about `person` and `text`: the one already there with the same topic,
   * or a new one. `null` without a person: a wish about nobody in particular is not tracked.
   */
  hold(person: Handle | null, text: string, holder: string): Wish | null;
  /** The wish `holder` holds. */
  of(holder: string): Wish | null;
  /** The wish about `person` and `text`, if there is one. */
  find(person: Handle | null, text: string): Wish | null;
  /**
   * Whether the wish may be raised with the person now (`holder`'s, or the one about `person`
   * and `text`). Reads `PersonThreadsKey` when it is there: what she asked anywhere counts.
   */
  screen(
    input: { person: Handle | null; text: string; holder?: string | null },
    signal?: AbortSignal,
  ): Promise<WishVerdict>;
  /** She raised `key` with the person (a line or a message reached them). */
  asked(key: string): void;
  /** `key` is closed for good. */
  close(key: string, end: WishEnd): void;
}

export const WishesKey = serviceKey<Wishes>("Wishes");

/** The holder name of a store's entry. */
export function wishHolder(
  store: "commitment" | "proposal" | "goal" | "reminder",
  id: string,
): string {
  return `${store}:${id}`;
}

// ---- topics ----------------------------------------------------------------------------------

/**
 * Words every wish to ask someone has, longest first: what is left is the topic. Single
 * characters split runs too, so "的結果" and "結果" are the same pairs.
 */
const FILLER = [
  "答應過的",
  "答應過",
  "有沒有",
  "怎麼樣",
  "的時候",
  "問一下",
  "關心一下",
  "上線",
  "說話",
  "接話",
  "出現",
  "順便",
  "記得",
  "答應",
  "承諾",
  "問問",
  "追問",
  "關心",
  "怎樣",
  "如何",
  "之後",
  "以後",
  "時候",
  "一下",
  "還有",
  "聊聊",
  "看看",
  "提醒",
  "私訊",
  "那個",
  "這個",
  "事情",
  "的事",
  "問",
  "聊",
  "跟",
  "和",
  "時",
  "後",
  "也",
  "再",
  "的",
  "了",
  "嗎",
  "呢",
  "吧",
  "啊",
  "他",
  "她",
  "你",
  "我",
  "當",
  "等",
  "要",
  "會",
  "去",
];
const LATIN_FILLER = new Set([
  "ask",
  "asked",
  "about",
  "how",
  "went",
  "when",
  "online",
  "after",
  "the",
  "and",
  "also",
  "what",
  "tell",
  "remind",
  "her",
  "him",
  "them",
  "promise",
  "promised",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pairs of characters (and longer Latin words) a wish's topic is made of. */
export function wishGrams(text: string, person: Handle | null = null): Set<string> {
  let s = text.normalize("NFKC").toLowerCase();
  if (person !== null && person.trim() !== "") {
    const name = person.trim().toLowerCase();
    s = /^[\w.\- ]+$/.test(name)
      ? s.replace(new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`, "g"), " ")
      : s.replaceAll(name, " ");
  }
  s = s.replace(/<[^>]*>/g, " ").replace(/[0-9]+/g, " ");
  for (const f of FILLER) s = s.replaceAll(f, " ");
  const grams = new Set<string>();
  for (const run of s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) grams.add(run);
    for (let i = 0; i + 1 < chars.length; i++) grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  for (const word of s.match(/[a-z]{3,}/g) ?? []) if (!LATIN_FILLER.has(word)) grams.add(word);
  return grams;
}

/**
 * `a` and `b` are about the same thing (for the same person): at least `min` of the smaller
 * one's grams are shared. A DM to the person is held to `DM_SAME_WISH` (2026-11-11: her DM
 * paraphrased a wish whose topic also carried its plan's steps, shared 0.30, and the wish
 * fired again 13 minutes later; an unrelated DM shared 0.00).
 */
export function sameWish(a: string, b: string, person: Handle | null = null, min = 0.5): boolean {
  const x = wishGrams(a, person);
  const y = wishGrams(b, person);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / Math.min(x.size, y.size) >= min;
}

/** `sameWish`'s share for a DM sent to the wish's person: the message is for them alone. */
export const DM_SAME_WISH = 0.25;

/**
 * The person says she asked already, or asks her to stop asking ("你已經在私訊問過我了",
 * "你問我好幾次了", "不要再問了"). Whatever she wanted to ask them is closed for good.
 */
const STOP_ASKING = [
  /問過(我|了)/u,
  /(已經|剛剛?|剛才|早就|不是|都)\s*問過/u,
  /問(了)?(我)?(了)?(好幾|好多|很多|那麼多|這麼多|幾|兩|三|N)\s*(次|遍)/iu,
  /(一直|一再|重複|又|還)(在)?問/u,
  /(別|不要|不用|甭|別再|不要再)(再)?(一直)?問/u,
  /問夠了|問煩了/u,
  /\balready asked\b|\bstop asking\b|\basked (me )?(that |this |it )?(already|before|twice|several times)\b/i,
];

export function stopsAsking(text: string): boolean {
  const s = text.normalize("NFKC");
  return STOP_ASKING.some((r) => r.test(s));
}
