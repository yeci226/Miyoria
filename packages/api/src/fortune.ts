// A fortune slip (今日籤詩) she writes for someone who paid for one (docs/design/economy.md §13):
// a rank, a short title, a four line poem, a few fields (戀愛, 學業, ...) and a personal line. The
// words are hers, the shape is the system's: every text is cut to size and passed by what the member
// page passes (nobody else named, moderation), and a rank that is not one of the six is replaced
// by a weighted draw.
//
// She is given what the member page already shows them (bands, her line for them, memories they
// may read) and her mood, never her private feeling. One slip per person per local day, kept so
// they can look at it again, export it and have it forgotten with their cards.

import { PersonaHandleKey } from "@miyoria/agent";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { completeJson, LlmRouterKey, systemMessage, userMessage, withLlmTag } from "@miyoria/llm";
import { type FortuneRecord, FortuneStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  characterCore,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  newId,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { dateOf } from "./public.js";
import type { ApiState } from "./state.js";
import type { FortuneField, IssuedFortune, MemberCard } from "./types.js";

const log = getLogger("api.fortune");

/** The six ranks, best first. */
export type FortuneRank = IssuedFortune["rank"];
export const FORTUNE_RANKS: readonly FortuneRank[] = ["大吉", "吉", "中吉", "小吉", "末吉", "凶"];

/** How often a draw lands on each when she names none that fits: mostly good, rarely 凶. */
export const RANK_WEIGHTS: Readonly<Record<FortuneRank, number>> = {
  大吉: 10,
  吉: 30,
  中吉: 25,
  小吉: 20,
  末吉: 10,
  凶: 5,
};

/** Characters at most: title, a poem line, a field's name, a field's text, her line. */
export const MAX_TITLE = 8;
export const MAX_POEM_LINE = 7;
export const POEM_LINES = 4;
export const MAX_FIELD_LABEL = 4;
export const MAX_FIELD_TEXT = 20;
export const MAX_FIELDS = 3;
export const MAX_LINE = 30;
/** How long she may take before the payment is given back. */
const WRITE_TIMEOUT_MS = 20_000;
/** Slips an export lists at most. */
const MAX_EXPORTED = 400;

/** What she wrote, already cut and passed. */
export interface FortuneSlip {
  rank: FortuneRank;
  title: string;
  poem: string[];
  fields: FortuneField[];
  line: string | null;
}

const loose = z.string().nullable().catch(null).default(null);

const SlipSchema = z.object({
  rank: loose,
  title: loose,
  poem: z
    .union([z.array(z.string().catch("")), z.string()])
    .catch([])
    .default([]),
  fields: z
    .array(z.object({ label: z.string(), text: z.string() }).catch({ label: "", text: "" }))
    .catch([])
    .default([]),
  line: loose,
});
export type RawSlip = z.output<typeof SlipSchema>;

/** What she knows of them for the slip: only what the member page shows them. */
export interface FortuneContext {
  /** Their display name. */
  name: string;
  view: MemberCard;
  /** Memories they may read, newest first. */
  memories: readonly string[];
  /** Today, `YYYY-MM-DD`. */
  date: string;
}

const RULES = `你要為下面這個人抽一支今日籤,籤上的字你自己寫,他本人會看到,可以下載分享。
只回傳 JSON:{"rank": 字串, "title": 字串, "poem": [四句], "fields": [{"label": 字串, "text": 字串}], "line": 字串}
- rank:只能是 ${FORTUNE_RANKS.join("、")} 其中一個。多數時候是吉(大吉、吉、中吉、小吉、末吉都算),凶很少見,看你今天對他的感覺和他最近的樣子決定,不要每次都一樣。
- title:籤題,${MAX_TITLE} 字內(例如「春風得意」)。
- poem:剛好 4 句,每句 ${MAX_POEM_LINE} 字內,不加標點,像籤詩的口吻,可以俏皮,要和他有關。
- fields:0 到 ${MAX_FIELDS} 個,欄位名稱(${MAX_FIELD_LABEL} 字內,例如 戀愛、學業、健康、願望、財運)和內容(${MAX_FIELD_TEXT} 字內)。
- line:對他說的一句私人的話,${MAX_LINE} 字內,用你平常說話的語氣。
- 只寫你和他,不提任何其他人(不寫別人的名字,也不寫「另一個人」「某人」);不寫數字分數、不寫你心裡的盤算或秘密;不要真的預言重大的事(病、錢、死亡),輕鬆就好。`;

function about(c: FortuneContext, mood: string | null): string {
  const v = c.view;
  const lines = [
    `今天:${c.date}`,
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

/** `text` flattened to one line and cut to `max` characters (`…` after a cut when `dots`). */
function cut(text: string, max: number, dots: boolean): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max).join("")}${dots ? "…" : ""}`;
}

/** The trailing punctuation of a poem line: the slip sets its own. */
const TAIL = /[，。,.;；、!！?？\s]+$/u;

/** A rank by weight; `random` in [0, 1). */
export function drawRank(random: () => number = Math.random): FortuneRank {
  const total = FORTUNE_RANKS.reduce((n, r) => n + RANK_WEIGHTS[r], 0);
  let at = Math.min(Math.max(random(), 0), 0.999_999) * total;
  for (const rank of FORTUNE_RANKS) {
    at -= RANK_WEIGHTS[rank];
    if (at < 0) return rank;
  }
  return "吉";
}

/**
 * Her raw choice, validated: the rank is hers when it is one of the six (else drawn), the title
 * and all four poem lines must survive `pass` (else `null`: there is no slip), and the rest is
 * dropped field by field.
 */
export function checked(
  raw: RawSlip,
  pass: (text: string) => string | null,
  random: () => number = Math.random,
): FortuneSlip | null {
  const say = (v: string | null, max: number, dots: boolean) => {
    if (v === null) return null;
    const text = cut(v, max, dots);
    return text === "" ? null : pass(text);
  };
  const title = say(raw.title, MAX_TITLE, false);
  const lines = (Array.isArray(raw.poem) ? raw.poem : raw.poem.split(/\n+/))
    .map((l) => l.replace(TAIL, "").trim())
    .filter((l) => l !== "")
    .slice(0, POEM_LINES)
    .map((l) => say(l, MAX_POEM_LINE, false));
  if (title === null || lines.length !== POEM_LINES) return null;
  const poem: string[] = [];
  for (const l of lines) {
    if (l === null) return null;
    poem.push(l);
  }
  const named = raw.rank?.trim() ?? "";
  const rank = (FORTUNE_RANKS as readonly string[]).includes(named)
    ? (named as FortuneRank)
    : drawRank(random);
  const fields: FortuneField[] = [];
  for (const f of raw.fields) {
    if (fields.length >= MAX_FIELDS) break;
    const label = say(f.label, MAX_FIELD_LABEL, false);
    const text = say(f.text, MAX_FIELD_TEXT, true);
    if (label !== null && text !== null) fields.push({ label, text });
  }
  return { rank, title, poem, fields, line: say(raw.line, MAX_LINE, true) };
}

/**
 * Her slip for `c`, each text passed by `pass`; `null` when she cannot write now (no model, a
 * failure, too slow, nothing usable): the caller gives the payment back.
 */
export async function writeFortune(
  state: ApiState,
  c: FortuneContext,
  pass: (text: string) => string | null,
): Promise<FortuneSlip | null> {
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
    const result = await withLlmTag({ module: "api", label: "fortune" }, () =>
      completeJson(
        router,
        "chat",
        {
          messages: [
            systemMessage(`${who || `你是${persona?.displayName() ?? "她"}。`}\n\n${RULES}`),
            userMessage(about(c, mood)),
          ],
          json_mode: true,
          reasoning_purpose: "fortune",
          max_tokens: 500,
        },
        SlipSchema,
        { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) },
      ),
    );
    return checked(result.value, pass);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "she could not write a fortune");
    return null;
  }
}

// ---- keeping them ---------------------------------------------------------------------------

const text = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

function slipJson(slip: FortuneSlip): JsonObject {
  return {
    rank: slip.rank,
    title: slip.title,
    poem: slip.poem,
    fields: slip.fields.map((f) => ({ label: f.label, text: f.text })),
    line: slip.line,
  };
}

/** A stored slip as it may leave, built field by field; `null` when it is not one. */
export function issuedFortune(r: FortuneRecord): IssuedFortune | null {
  const s = r.slip;
  const rank = text(s.rank);
  const title = text(s.title);
  if (rank === null || !(FORTUNE_RANKS as readonly string[]).includes(rank) || title === null) {
    return null;
  }
  const poem = Array.isArray(s.poem)
    ? s.poem.flatMap((l) => (typeof l === "string" ? [l] : []))
    : [];
  if (poem.length !== POEM_LINES) return null;
  const fields: FortuneField[] = [];
  if (Array.isArray(s.fields)) {
    for (const f of s.fields) {
      if (!isJsonObject(f)) continue;
      const label = text(f.label);
      const body = text(f.text);
      if (label !== null && body !== null) fields.push({ label, text: body });
    }
  }
  return {
    id: r.id,
    date: dateOf(r.day),
    issued_at: r.issued_at,
    rank: rank as FortuneRank,
    title,
    poem,
    fields,
    line: text(s.line),
  };
}

/** Who a slip is for: the session account, every account of the person, the person. */
export interface FortuneHolder {
  account: AccountRef;
  accounts: readonly AccountRef[];
  person: PersonId | null;
}

/** The slip of local day `day`, or `null` (also when there is no store). */
export async function fortuneOfDay(
  state: ApiState,
  holder: FortuneHolder,
  day: number,
): Promise<IssuedFortune | null> {
  const store = state.optional(FortuneStoreKey);
  if (!store) return null;
  const found = await store.forDay(state.profile(), holder.accounts, day);
  return found ? issuedFortune(found) : null;
}

/**
 * Keeps `slip` as the slip of `day`, written for the session account. `false` when the person
 * already has one for that day (a second request raced the first).
 */
export async function keepFortune(
  state: ApiState,
  holder: FortuneHolder,
  day: number,
  entryId: string,
  slip: FortuneSlip,
): Promise<IssuedFortune | null> {
  const store = state.optional(FortuneStoreKey);
  if (!store) return null;
  const record: FortuneRecord = {
    id: newId(),
    profile: state.profile(),
    account: holder.account,
    person: holder.person,
    day,
    issued_at: toTimestamp(state.now()),
    entry: entryId,
    slip: slipJson(slip),
  };
  if (!(await store.put(record, holder.accounts))) return null;
  return issuedFortune(record);
}

/** Their slips for the export, newest first. */
export async function fortunesOf(
  state: ApiState,
  accounts: readonly AccountRef[],
): Promise<IssuedFortune[]> {
  const store = state.optional(FortuneStoreKey);
  if (!store) return [];
  try {
    const rows = await store.listFor(state.profile(), accounts, MAX_EXPORTED);
    return rows.flatMap((r) => {
      const view = issuedFortune(r);
      return view === null ? [] : [view];
    });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot list fortunes");
    return [];
  }
}

/** Deletes their slips (a forget), whatever else is in the way. */
export async function deleteFortunes(
  state: ApiState,
  accounts: readonly AccountRef[],
): Promise<number> {
  const store = state.optional(FortuneStoreKey);
  if (!store) return 0;
  try {
    return await store.deleteFor(state.profile(), accounts);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot delete fortunes");
    return 0;
  }
}
