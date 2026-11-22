// What she writes on a card as it is issued: a line for them, which picture of her goes on it, a
// stamp and a few fields she names herself. The card's numbers and bands stay the system's; these
// are only words, and every one of them passes what the member page passes (nobody else named,
// moderation) or is left off.
//
// She is given what the member page already shows them (bands, her line for them, memories they
// may read) and her mood, never her private feeling: it names other people and may hold a secret,
// and a card's code lets anyone read it. A milestone card (docs/design/v5-play.md §6.1) adds the
// tier and the shared memory she anchored it with, which the design puts on the card; what she
// writes of it passes the same checks. A keepsake card (P5) is told what it already prints (since
// when, what they were, their old cards); only her line of it is kept.
//
// She writes as she talks: her whole persona and example dialogues (`herVoice`), then what a card
// asks (`CARD_VOICE`): short spoken lines of hers, no tier's name, nothing made up, nobody but the
// two of them. A text that still names a tier is left off. A text that names anyone else, by the
// names she knows people by or by a name in what she was given (`other-names.ts`), has her write
// the card once more without that memory, and is left off if it still does: every path a card's
// words take (daily, drop, milestone, the keepsake's later line) comes through `writeCard`.

import type { CardField, MemberCard } from "@miyoria/contracts/api";
import {
  completeJson,
  LlmRouterKey,
  systemMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm/llm";
import type { CardOccasion } from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  AffectStateKey,
  type Character,
  CharacterKey,
  DEFAULT_CHARACTER,
  type NameSplit,
  RELATIONSHIP_LABELS,
} from "@miyoria/types";
import { z } from "zod";
import { herVoice, WRITTEN_NOT_CHAT, withoutMarkup } from "./her-voice.js";
import { type NameHit, type NameScreen, nameScreen, otherNameIn } from "./other-names.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.card");

/** Her line, a stamp, a field's name and its text, at most (characters). */
export const MAX_LINE = 40;
export const MAX_STAMP = 6;
export const MAX_LABEL = 6;
export const MAX_FIELD = 24;
/** Fields she may add. */
export const MAX_FIELDS = 3;
/** How long she may take before the card goes out without her words. */
const WRITE_TIMEOUT_MS = 15_000;

/** What she chose for one card. */
export interface CardWords {
  line: string | null;
  pose: string | null;
  stamp: string | null;
  fields: CardField[];
}

const loose = z.string().nullable().catch(null).default(null);

const WordsSchema = z.object({
  line: loose,
  pose: loose,
  stamp: loose,
  fields: z
    .array(z.object({ label: z.string(), text: z.string() }).catch({ label: "", text: "" }))
    .catch([])
    .default([]),
});

/** What she knows of them for the card: only what the member page shows them. */
export interface CardContext {
  /** Their display name. */
  name: string;
  view: MemberCard;
  /** Memories they may read, newest first. */
  memories: readonly string[];
  /** Pictures of her the card may use (their affinity band's). */
  poses: readonly string[];
  /** What the card is for when it is not a daily one (told as `occasionLine`); default daily. */
  occasion?: CardOccasion | null;
  /**
   * Whose names are whose (`namesFor`): every text she writes is checked against everyone else's
   * names and the names in what she is given (`other-names.ts`). `null` when the names cannot be
   * read: then nothing she wrote could be shown, and she is not asked.
   */
  names: NameSplit | null;
}

/** What she is told a card nobody bought is for, as a line of `about`. */
export function occasionLine(occasion: CardOccasion): string {
  if (occasion.kind === "keepsake") {
    const facts = occasion.facts.map((f) => `${f.label}:${f.text}`).join("、");
    return `這不是平常的每日卡,是紀念卡:他在你開始發卡之前就認識你了,這張是給老朋友的${
      facts === "" ? "" : `(卡上已經印著:${facts})`
    }。line 寫一句你當面會跟這個老朋友說的話;卡上印著的事不用再寫一次。`;
  }
  const scene =
    occasion.scene === null
      ? "line 從上面你記得的事裡挑一件,照記得的樣子用你的口氣說;想不到要挑哪件,就寫現在這一刻。"
      : `line 說你們之間的這個場面:「${occasion.scene}」,用你平常說話的口氣,像當面跟他提起那件事。`;
  return `這不是平常的每日卡,是里程碑卡:你們的關係剛往前走了一步,這張是你送他的。卡上已經印著關係的名稱「${occasion.tier}」,你的字裡不要再寫它。${scene}
- 只說寫到的事:不加任何沒寫到的話、動作、反應、時間或後來的事(像「笑到你問我是不是壞掉了」這種補出來的一句也不行);寧可短一點。
- 誰做了什麼照原樣:記得的事和場面裡的「我」是你,「他」「她」是他;寫成對他說的話時,「我」還是你,他變成「你」。是他問你的,就不要寫成你問他;是你做的,就不要寫成他做的。卡上的欄位也一樣。`;
}

export const POSE_WORDS: Readonly<Record<string, string>> = {
  calm: "平靜",
  smile: "微笑",
  blush: "害羞臉紅",
  heart: "比愛心",
  squint: "瞇眼笑",
  finger: "豎手指",
  hand: "揮手",
  smug: "屑屑眼得意",
  sweat: "冒冷汗",
  cold: "冷淡",
};

/**
 * The words of the relationship scale that read as its name on a card (「摯友認證」): every tier
 * name but the everyday words 認識, 朋友 and 討厭, which a line may use as plain words.
 */
export const TIER_WORDS: readonly string[] = RELATIONSHIP_LABELS.filter(
  (l) => l !== "認識" && l !== "朋友" && l !== "討厭" && l !== "很討厭",
);

/**
 * How her words on a card sound (after her persona): hers, spoken, and nothing made up. Her nature
 * is `[character] creature` (the first character's 鯨魚, which gives exactly the words she always
 * had); a profile without one has only her tails and quips.
 */
export function cardVoice(her: Character = DEFAULT_CHARACTER): string {
  const quirks = her.creature === "" ? "尾音和吐槽" : `尾音、吐槽和${her.creature}的小毛病`;
  return `## 卡上的字怎麼寫
- 卡上的字就是你在聊天裡會說的話:短、口語,有你的${quirks},像隨手寫在卡背的一兩句。不是賀卡文案:不寫工整的完整長句、文藝的比喻,也不寫「祝你…」「願你…」「謝謝你的陪伴」這種誰都能寫的話。
- 換一個名字還能照用的句子就不要寫;寫只有你會對他說的。
- 陌生人的卡也是你寫的:有點距離、有點好奇或小小吐槽,不是「初次見面請多指教」的制式問候,也不是填空的表格。討厭的人的卡冷淡敷衍,但還是你的口氣。
- 卡上任何地方(line、stamp、fields)都不寫關係分級的名稱:${RELATIONSHIP_LABELS.filter((l) => l !== "認識").join("、")}這些詞都不寫,也不寫「XX認證」「升級成XX」「正式成為XX」。你們多熟,讓口氣自己說出來。
- 只寫下面給你的事。沒有共同的回憶或場面可寫時,就寫現在這一刻(你現在的心情、他今天來了、這張卡本身),不要編一件你們以前做過的事,也不要替記得的事補上沒寫到的細節。
- 卡是你們兩個人之間的東西,只寫你和他。記得的事裡有別人(朋友、家人、推薦他東西的人,任何名字或綽號)時,那個人整個不寫:不寫名字、不寫綽號,也不改寫成「朋友」「有人」「某人」「另一個人」;只寫那件事裡你和他的部分,或者換一件事寫。
- 不寫數字、分數、價錢,不寫你心裡的盤算或秘密。`;
}

/** `cardVoice` of the first character, word for word what the card prompt always said. */
export const CARD_VOICE = cardVoice();

function rules(poses: readonly string[], her: Character): string {
  const choices = poses.map((p) => `${p}(${POSE_WORDS[p] ?? p})`).join("、");
  // On a daily card the relationship picks her expression: she does not choose a picture.
  const pose = poses.length > 0 ? `\n- pose:卡上放你哪張圖,從這幾個挑:${choices}。` : "";
  const shape = poses.length > 0 ? `"pose": 字串, ` : "";
  return `${WRITTEN_NOT_CHAT}

你要發一張卡給下面這個人,卡上的字你自己寫,他本人會看到,拿到卡的人掃碼也看得到。
只回傳 JSON:{"line": 字串, ${shape}"stamp": 字串或 null, "fields": [{"label": 字串, "text": 字串}]}
- line:這一刻你想對他說的話,${MAX_LINE} 字內,每次發卡都可以不一樣。${pose}
- stamp:蓋在卡上的章,${MAX_STAMP} 字內,像你隨口給他的綽號或一句吐槽;不想蓋就 null。
- fields:你想在卡上多寫的東西,0 到 ${MAX_FIELDS} 個,欄位名稱(${MAX_LABEL} 字內)和內容(${MAX_FIELD} 字內)都你決定;沒什麼想寫就空陣列,寧可少寫也不要湊滿。

${cardVoice(her)}`;
}

function about(c: CardContext, mood: string | null): string {
  const v = c.view;
  const lines = [
    `他:${c.name}${v.call_name ? `(你叫他 ${v.call_name})` : ""}`,
    `你們的關係:${v.relationship ?? "還不認識"}`,
    `羈絆 ${v.affinity ?? "—"}、信任 ${v.trust ?? "—"}、熟悉 ${v.familiarity ?? "—"}`,
  ];
  if (v.public_feeling) lines.push(`你之前寫給他的話:${v.public_feeling}`);
  if (c.memories.length > 0) {
    lines.push(`你記得和他有關的事:\n${c.memories.map((m) => `- ${m}`).join("\n")}`);
  }
  if (mood) lines.push(`你現在的心情:${mood}`);
  if (c.occasion) lines.push(occasionLine(c.occasion));
  return lines.join("\n");
}

/** What she is given of them that may hold someone else's name: memories, a scene, a card's facts. */
function givenTexts(c: CardContext): string[] {
  const o = c.occasion;
  const occasion =
    o?.kind === "milestone"
      ? o.scene === null
        ? []
        : [o.scene]
      : o?.kind === "keepsake"
        ? o.facts.map((f) => `${f.label} ${f.text}`)
        : [];
  return [...c.memories, ...occasion, ...(c.view.public_feeling ? [c.view.public_feeling] : [])];
}

/** `c` without the given texts at `drop` (indices of `givenTexts`). */
function without(c: CardContext, drop: readonly number[]): CardContext {
  const memories = c.memories.filter((_, i) => !drop.includes(i));
  const o = c.occasion;
  let occasion = o;
  let at = c.memories.length;
  if (o?.kind === "milestone" && o.scene !== null) {
    if (drop.includes(at)) occasion = { ...o, scene: null };
    at += 1;
  } else if (o?.kind === "keepsake") {
    occasion = { ...o, facts: o.facts.filter((_, i) => !drop.includes(at + i)) };
    at += o.facts.length;
  }
  const view = drop.includes(at) ? { ...c.view, public_feeling: null } : c.view;
  return { ...c, memories, occasion: occasion ?? null, view };
}

/** Said when she is asked again because her first words named someone else. */
const AGAIN =
  "你剛才寫的字裡出現了別人。重寫一次:卡上只有你和他,不寫別人的名字或綽號,也不用「朋友」「某人」代替。";

function cut(text: string, max: number): string {
  const chars = [...withoutMarkup(text).replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** One answer of hers for `c`; `null` when she gives none (a failure, too slow). */
async function ask(
  state: ApiState,
  c: CardContext,
  mood: string | null,
  again: boolean,
): Promise<z.output<typeof WordsSchema> | null> {
  const router = state.optional(LlmRouterKey);
  if (!router) return null;
  const told = again ? `${about(c, mood)}\n\n${AGAIN}` : about(c, mood);
  try {
    const result = await withLlmTag({ module: "api", label: "card" }, () =>
      completeJson(
        router,
        "chat",
        {
          messages: [
            systemMessage(
              `${herVoice(state)}\n\n${rules(c.poses, state.optional(CharacterKey) ?? DEFAULT_CHARACTER)}`,
            ),
            userMessage(told),
          ],
          json_mode: true,
          reasoning_purpose: "card",
          max_tokens: 400,
        },
        WordsSchema,
        { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) },
      ),
    );
    return result.value;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "she could not write on a card");
    return null;
  }
}

/**
 * Her words for a card, each passed by `pass` (nobody else named, moderation) or dropped; `null`
 * when she cannot write now (no model, a failure, too slow, the names cannot be read): the card
 * goes out without them.
 *
 * A text of hers that names anyone but them (`otherNameIn`: the directory's names, or one found in
 * what she was given) has her write the card once more, without the memory that name came from;
 * whatever still names someone then is left off, and the rest stands.
 */
export async function writeCard(
  state: ApiState,
  c: CardContext,
  pass: (text: string) => string | null,
): Promise<CardWords | null> {
  if (!state.optional(LlmRouterKey) || c.names === null) return null;
  let mood: string | null = null;
  try {
    mood = state.optional(AffectStateKey)?.snapshot().mood_line ?? null;
  } catch {
    mood = null;
  }
  const screen = nameScreen(c.names, givenTexts(c));
  const first = await ask(state, c, mood, false);
  if (first === null) return null;
  const once = checked(first, c.poses, pass, screen);
  if (once.named.length === 0) return once.words;
  const from = [...new Set(once.named.flatMap((hit) => hit.from))];
  log.info(
    { texts: once.named.length, memories: from.length },
    "her words on a card named someone else; she writes them again",
  );
  const second = await ask(state, without(c, from), mood, true);
  if (second === null) return once.words;
  const twice = checked(second, c.poses, pass, screen);
  if (twice.named.length > 0) {
    log.info({ texts: twice.named.length }, "her words on a card still named someone: left off");
  }
  return twice.words;
}

/**
 * Her raw choice, cut to size and passed field by field; a text that names a tier of the scale
 * (`TIER_WORDS`) is left off like one `pass` refuses, and so is one that names someone else by
 * `screen` (`named` says where each came from).
 */
export function checked(
  raw: z.output<typeof WordsSchema>,
  poses: readonly string[],
  pass: (text: string) => string | null,
  screen?: NameScreen,
): { words: CardWords; named: NameHit[] } {
  const named: NameHit[] = [];
  const say = (v: string | null, max: number) => {
    if (v === null) return null;
    const text = cut(v, max);
    if (text === "" || TIER_WORDS.some((t) => text.includes(t))) return null;
    const hit = screen === undefined ? null : otherNameIn(screen, text);
    if (hit !== null) {
      named.push(hit);
      return null;
    }
    return pass(text);
  };
  const fields: CardField[] = [];
  for (const f of raw.fields) {
    if (fields.length >= MAX_FIELDS) break;
    const label = say(f.label, MAX_LABEL);
    const text = say(f.text, MAX_FIELD);
    if (label !== null && text !== null) fields.push({ label, text });
  }
  const words: CardWords = {
    line: say(raw.line, MAX_LINE),
    pose: raw.pose !== null && poses.includes(raw.pose) ? raw.pose : null,
    stamp: say(raw.stamp, MAX_STAMP),
    fields,
  };
  return { words, named };
}
