// The consolidation prompt and lenient parsing of the summarizer's JSON.

import type { LogEntry } from "@miyoria/store";
import { isJsonObject, type JsonObject, type JsonValue, timestampMs } from "@miyoria/types";

/** Who a fact or followup is about: herself, a name from the transcript, or unknown. */
export type SubjectName =
  | { type: "myself" }
  | { type: "named"; name: string }
  | { type: "unknown" };

export interface ExEpisode {
  summary: string;
  importance: number;
  emotion: string | null;
}

export interface ExFact {
  subject: SubjectName;
  statement: string;
  importance: number;
  confidence: number;
  global: boolean;
  /** Hours the statement stays true (a state in progress); `null` = lasting. */
  valid_hours: number | null;
  /** Transcript lines (1-based) the summarizer says it comes from; empty when it named none. */
  lines: number[];
}

export interface ExNote {
  note: string;
  importance: number;
  /** Hours the note stays true (a state in progress); `null` = lasting. */
  valid_hours: number | null;
  /** Transcript lines (1-based) the summarizer says it comes from; empty when it named none. */
  lines: number[];
}

export interface ExFollowup {
  subject: SubjectName;
  about: string;
  due_in_hours: number;
}

/** What the summarizer extracted from one stretch of conversation. */
export interface Extraction {
  episode: ExEpisode | null;
  facts: ExFact[];
  self_notes: ExNote[];
  followups: ExFollowup[];
  /** Items that were present but malformed. */
  skipped: number;
}

export class ExtractionError extends Error {
  override readonly name = "ExtractionError";
}

/** System prompt: she reviews the conversation and writes her own memories. */
export function systemPrompt(selfLabel: string): string {
  return `你正在回想自己剛剛參與的一段對話,把值得記住的事整理成「你自己的記憶」。
逐字稿裡標成「${selfLabel}」的是你自己說的話,其他人用他們的名字標示。

用你自己的角度寫(第一人稱「我」),提到別人時一定寫出他們的名字,讓每一條日後單獨看也看得懂。
只記對話裡真的出現的資訊,不要猜測或補充;寒暄、玩笑、沒內容的閒聊不用記。
逐字稿每一行前面有編號 [n]。每條事實和筆記都要寫出它根據哪幾行(lines);找不到根據的就不要寫。

只輸出一個 JSON 物件,格式如下:
{
  "episode": {"summary": "一兩句話描述這段對話發生了什麼(我的角度)", "importance": 0.0到1.0, "emotion": "我當時的心情,一個詞"} 或 null,
  "facts": [{"subject_name": "這件事是關於誰(用逐字稿裡的名字),關於我自己就寫 \\"self\\"", "statement": "例如:Owen 喜歡吃拉麵", "importance": 0.0到1.0, "confidence": 0.0到1.0, "global": true 或 false, "valid_hours": null 或 幾小時內仍然成立, "lines": [它根據的行號]}],
  "self_notes": [{"note": "我說過的承諾、表達過的意見、我自己的經歷,例如:我答應 Owen 下次陪他打 Minecraft", "importance": 0.0到1.0, "valid_hours": null 或 幾小時內仍然成立, "lines": [它根據的行號]}],
  "followups": [{"subject_name": "要追問誰", "about": "之後想問或提起的事,例如:問 Owen 明天的考試考得怎樣", "due_in_hours": 幾小時後適合提起}]
}

規則:
- importance:1 是非常重要(重大消息、強烈喜好、承諾),0.1 是幾乎不重要。
- confidence:對方明確說的接近 1,只是暗示或玩笑話就低一點。
- valid_hours:只有「現在正在發生的狀態」才填(例如「正在下載歌」「已經開台」「Owen 在打 osu」),填它大概還會成立幾小時;長久成立的事(喜好、關係、承諾、經歷)填 null。
- 提到人一律寫名字,不要寫 u1、p2 這類代號。
- global 只在「名字、希望我怎麼稱呼他、代名詞」這類到哪裡都適用、而且一點都不私密的事實才設 true,其他一律 false。
- 沒有值得記的就給空陣列或 null,不要硬湊。`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `%Y-%m-%d %H:%M` in a fixed UTC offset. */
function local(ts: string, offsetMinutes: number): string {
  const d = new Date(timestampMs(ts) + offsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}`;
}

/** Transcript given to the summarizer, one line per log entry. */
export function transcript(
  lines: readonly LogEntry[],
  selfLabel: string,
  isPrivate: boolean,
  utcOffsetMinutes: number,
): string {
  const offset = Math.min(18 * 60, Math.max(-18 * 60, utcOffsetMinutes));
  let out = isPrivate ? "地點:私訊(一對一)\n" : "地點:伺服器頻道\n";
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first && last) out += `時間:${local(first.ts, offset)} 到 ${local(last.ts, offset)}\n`;
  out += "\n逐字稿:\n";
  lines.forEach((entry, i) => {
    const name = entry.is_self ? selfLabel : entry.author_name;
    out += `[${i + 1}] ${name}: ${entry.text.replaceAll("\n", " ")}\n`;
  });
  return out;
}

/**
 * Parses the summarizer's answer. Tolerates code fences, prose around the object, trailing
 * commas, a bare array of facts, string numbers and 0..10 / 0..100 scales; malformed items are skipped (counted in `skipped`). Fails
 * only when there is no JSON object.
 */
export function parseExtraction(text: string): Extraction {
  const value = findObject(text);
  const out: Extraction = { episode: null, facts: [], self_notes: [], followups: [], skipped: 0 };

  const episode = value.episode;
  if (episode === undefined || episode === null) {
    // nothing
  } else if (typeof episode === "string" && episode.trim() !== "") {
    out.episode = { summary: episode.trim(), importance: 0.3, emotion: null };
  } else if (isJsonObject(episode)) {
    const summary = strField(episode, ["summary", "content", "text"]);
    if (summary !== null) {
      out.episode = {
        summary,
        importance: unit(episode.importance) ?? 0.3,
        emotion: strField(episode, ["emotion", "mood"]),
      };
    } else {
      out.skipped += 1;
    }
  } else {
    out.skipped += 1;
  }

  for (const item of array(value, "facts")) {
    if (!isJsonObject(item)) {
      out.skipped += 1;
      continue;
    }
    const statement = strField(item, ["statement", "fact", "content"]);
    if (statement === null) {
      out.skipped += 1;
      continue;
    }
    out.facts.push({
      subject: subject(item),
      statement,
      importance: unit(item.importance) ?? 0.5,
      confidence: unit(item.confidence) ?? 0.7,
      global: boolean(item.global),
      valid_hours: hours(item.valid_hours),
      lines: lineNumbers(item.lines),
    });
  }

  for (const item of array(value, "self_notes")) {
    let note: ExNote | null = null;
    if (typeof item === "string") {
      if (item.trim() !== "") {
        note = { note: item.trim(), importance: 0.4, valid_hours: null, lines: [] };
      }
    } else if (isJsonObject(item)) {
      const n = strField(item, ["note", "content", "statement"]);
      if (n !== null) {
        note = {
          note: n,
          importance: unit(item.importance) ?? 0.4,
          valid_hours: hours(item.valid_hours),
          lines: lineNumbers(item.lines),
        };
      }
    }
    if (note) out.self_notes.push(note);
    else out.skipped += 1;
  }

  for (const item of array(value, "followups")) {
    if (!isJsonObject(item)) {
      out.skipped += 1;
      continue;
    }
    const about = strField(item, ["about", "content", "topic"]);
    if (about === null) {
      out.skipped += 1;
      continue;
    }
    const hours = number(item.due_in_hours) ?? 24;
    out.followups.push({
      subject: subject(item),
      about,
      due_in_hours: Math.min(24 * 90, Math.max(0, hours)),
    });
  }
  return out;
}

/** Keys that mark an object (or an array's items) as an extraction rather than stray JSON. */
const OBJECT_KEYS = ["episode", "facts", "self_notes", "followups"];
const ITEM_KEYS = ["statement", "fact", "note", "about", "summary"];

/** Removes trailing commas before `}` / `]` (outside strings); nothing else is repaired. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") {
        i += 1;
        out += text[i] ?? "";
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ",") {
      const rest = text.slice(i + 1).trimStart();
      if (rest.startsWith("}") || rest.startsWith("]")) continue;
    }
    out += c;
  }
  return out;
}

function tryParse(text: string): JsonValue | undefined {
  for (const t of [text, dropTrailingCommas(text)]) {
    try {
      return JSON.parse(t) as JsonValue;
    } catch {
      // try the repaired form, then give up on this candidate
    }
  }
  return undefined;
}

/** Balanced `{ … }` / `[ … ]` spans of `text` (string literals respected), in order, capped. */
function spans(text: string, open: "{" | "["): string[] {
  const close = open === "{" ? "}" : "]";
  const out: string[] = [];
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
    if (out.length >= 8) break;
  }
  return out;
}

const hasKey = (o: JsonObject, keys: readonly string[]) => keys.some((k) => k in o);

/** An extraction object, or a bare array of fact-like items read as `facts`; else `null`. */
function asExtraction(v: JsonValue | undefined, strict: boolean): JsonObject | null {
  if (v === undefined) return null;
  if (isJsonObject(v)) return !strict || hasKey(v, OBJECT_KEYS) ? v : null;
  if (Array.isArray(v) && v.some((x) => isJsonObject(x) && hasKey(x, ITEM_KEYS))) {
    return { facts: v };
  }
  return null;
}

function findObject(text: string): JsonObject {
  const trimmed = text.trim();
  // The whole text may be any object (an empty one means "nothing to remember").
  const whole = tryParse(trimmed);
  const direct = asExtraction(whole, false);
  if (direct) return direct;
  const candidates: string[] = [];
  for (const m of trimmed.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
    candidates.push((m[1] ?? "").trim());
  }
  candidates.push(...spans(trimmed, "{"), ...spans(trimmed, "["));
  for (const c of candidates) {
    const found = asExtraction(tryParse(c), true);
    if (found) return found;
  }
  if (!trimmed.includes("{") && !trimmed.includes("[")) {
    throw new ExtractionError("no JSON object in summarizer output");
  }
  throw new ExtractionError("no usable JSON object in summarizer output");
}

function array(value: JsonObject, key: string): readonly JsonValue[] {
  const v = value[key];
  return Array.isArray(v) ? v : [];
}

/** The first of `keys` holding a string, trimmed, if not empty. */
function strField(map: JsonObject, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = map[k];
    if (typeof v === "string") {
      const s = v.trim();
      return s === "" ? null : s;
    }
  }
  return null;
}

const SELF_NAMES: ReadonlySet<string> = new Set(["self", "me", "myself", "我", "我自己"]);

function subject(map: JsonObject): SubjectName {
  const name = strField(map, ["subject_name", "subject", "name"]);
  if (name === null) return { type: "unknown" };
  return SELF_NAMES.has(name.toLowerCase()) ? { type: "myself" } : { type: "named", name };
}

/** Rust `str::parse::<f64>` syntax (decimal, optional exponent, `inf` / `nan`). */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function number(value: JsonValue | undefined): number | null {
  let n: number | null = null;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim().replace(/%+$/, "");
    if (FLOAT.test(s)) n = Number(s);
  }
  return n !== null && Number.isFinite(n) ? n : null;
}

/** Line numbers (positive integers, once each) the summarizer cited; anything else is dropped. */
function lineNumbers(value: JsonValue | undefined): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const v of value) {
    const n = number(v);
    if (n !== null && Number.isInteger(n) && n >= 1) out.add(n);
  }
  return [...out];
}

/** A lifetime in hours (positive), else `null`. */
function hours(value: JsonValue | undefined): number | null {
  const n = number(value);
  return n !== null && n > 0 ? n : null;
}

/** A 0..1 score; 0..10 and 0..100 scales are rescaled. */
function unit(value: JsonValue | undefined): number | null {
  let n = number(value);
  if (n === null) return null;
  if (n > 10) n /= 100;
  else if (n > 1) n /= 10;
  return Math.min(1, Math.max(0, n));
}

function boolean(value: JsonValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  if (typeof value === "number") return value !== 0;
  return false;
}
