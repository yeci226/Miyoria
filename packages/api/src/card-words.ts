// What she writes on a card as it is issued: a line for them, which picture of her goes on it, a
// stamp and a few fields she names herself. The card's numbers and bands stay the system's; these
// are only words, and every one of them passes what the member page passes (nobody else named,
// moderation) or is left off.
//
// She is given what the member page already shows them (bands, her line for them, memories they
// may read) and her mood, never her private feeling: it names other people and may hold a secret,
// and a card's code lets anyone read it.

import { PersonaHandleKey } from "@miyoria/agent";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { completeJson, LlmRouterKey, systemMessage, userMessage, withLlmTag } from "@miyoria/llm";
import { AffectStateKey, characterCore } from "@miyoria/types";
import { z } from "zod";
import type { ApiState } from "./state.js";
import type { CardField, MemberCard } from "./types.js";

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

function rules(poses: readonly string[]): string {
  const choices = poses.map((p) => `${p}(${POSE_WORDS[p] ?? p})`).join("、");
  return `你要發一張卡給下面這個人,卡上的字你自己寫,他本人會看到,拿到卡的人掃碼也看得到。
只回傳 JSON:{"line": 字串, "pose": 字串, "stamp": 字串或 null, "fields": [{"label": 字串, "text": 字串}]}
- line:這一刻想對他說的一句話,${MAX_LINE} 字內,用你平常說話的語氣,每次發卡都可以不一樣。
- pose:卡上放你哪張圖,從這幾個挑:${choices}。
- stamp:蓋在卡上的章,${MAX_STAMP} 字內(例如「認證損友」),不想蓋就 null。
- fields:你想在卡上多寫的東西,0 到 ${MAX_FIELDS} 個,欄位名稱(${MAX_LABEL} 字內)和內容(${MAX_FIELD} 字內)都你決定,例如給他的稱號、你們的回憶、對他的期待;沒什麼想寫就空陣列。
- 只寫你和他,不提任何其他人(不寫別人的名字,也不寫「另一個人」「某人」);不寫數字分數、不寫你心裡的盤算或秘密。`;
}

function about(c: CardContext, mood: string | null): string {
  const v = c.view;
  const lines = [
    `他:${c.name}${v.call_name ? `(你叫他 ${v.call_name})` : ""}`,
    `你們的關係:${v.relationship ?? "還不認識"}`,
    `好感 ${v.affinity ?? "—"}、信任 ${v.trust ?? "—"}、熟悉 ${v.familiarity ?? "—"}`,
  ];
  if (v.public_feeling) lines.push(`你之前寫給他的話:${v.public_feeling}`);
  if (c.memories.length > 0) {
    lines.push(`你記得和他有關的事:\n${c.memories.map((m) => `- ${m}`).join("\n")}`);
  }
  if (mood) lines.push(`你現在的心情:${mood}`);
  return lines.join("\n");
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/**
 * Her words for a card, each passed by `pass` (nobody else named, moderation) or dropped; `null`
 * when she cannot write now (no model, a failure, too slow): the card goes out without them.
 */
export async function writeCard(
  state: ApiState,
  c: CardContext,
  pass: (text: string) => string | null,
): Promise<CardWords | null> {
  const router = state.optional(LlmRouterKey);
  if (!router) return null;
  const persona = state.optional(PersonaHandleKey);
  const who = persona ? characterCore(persona.corePrompt()) : "";
  let mood: string | null = null;
  try {
    mood = state.optional(AffectStateKey)?.snapshot().mood_line ?? null;
  } catch {
    mood = null;
  }
  try {
    const result = await withLlmTag({ module: "api", label: "card" }, () =>
      completeJson(
        router,
        "chat",
        {
          messages: [
            systemMessage(
              `${who || `你是${persona?.displayName() ?? "她"}。`}\n\n${rules(c.poses)}`,
            ),
            userMessage(about(c, mood)),
          ],
          json_mode: true,
          reasoning_purpose: "card",
          max_tokens: 400,
        },
        WordsSchema,
        { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) },
      ),
    );
    return checked(result.value, c.poses, pass);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "she could not write on a card");
    return null;
  }
}

/** Her raw choice, cut to size and passed field by field. */
export function checked(
  raw: z.output<typeof WordsSchema>,
  poses: readonly string[],
  pass: (text: string) => string | null,
): CardWords {
  const say = (v: string | null, max: number) => {
    if (v === null) return null;
    const text = cut(v, max);
    return text === "" ? null : pass(text);
  };
  const fields: CardField[] = [];
  for (const f of raw.fields) {
    if (fields.length >= MAX_FIELDS) break;
    const label = say(f.label, MAX_LABEL);
    const text = say(f.text, MAX_FIELD);
    if (label !== null && text !== null) fields.push({ label, text });
  }
  return {
    line: say(raw.line, MAX_LINE),
    pose: raw.pose !== null && poses.includes(raw.pose) ? raw.pose : null,
    stamp: say(raw.stamp, MAX_STAMP),
    fields,
  };
}
