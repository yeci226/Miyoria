// Prompt pieces the runner's prompt (`@miyoria/brain/selfhost`) takes from the old main line: the
// owner's rules and the promises she still owes (`pinnedSection`), what the outside wrote in her
// working context (`contextData`, `contextState`), a party game's line, and the persona's example
// dialogues, rotated per session.

import {
  type Commitment,
  type ContextBucket,
  type ContextEntry,
  dataBlock,
  escapeTags,
  neutralize,
  type PartyGameStatus,
  safeName,
  timestampMs,
  xmlAttrs,
} from "@miyoria/types";
import { charCount } from "../util.js";

const clock = (at: number, offset: number): string => {
  const d = new Date(at + offset * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** The owner's rules and what she still owes (`null`: nothing). */
export function pinnedSection(
  rules: readonly string[],
  commitments: readonly Commitment[],
  now: number,
  utcOffsetMinutes: number,
): string | null {
  const parts: string[] = [];
  if (rules.length > 0) {
    parts.push(`# 主人規則(一定要遵守)\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }
  if (commitments.length > 0) {
    const lines = commitments.map((c) => {
      const due = timestampMs(c.due);
      const what = neutralize(c.what);
      return due <= now
        ? c.capability !== null
          ? `- 逾期:你說要「${what}」,還沒做。現在就呼叫 ${c.capability},不要再用講的;做不到就老實說為什麼。`
          : `- 逾期:你說要「${what}」,還沒做。現在做,或自己老實講做不到。`
        : `- 你說要「${what}」(${clock(due, utcOffsetMinutes)} 前)`;
    });
    parts.push(`# 你答應了還沒做的事\n${lines.join("\n")}`);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** What people or the outside wrote in her working context, as data (`ContextEntry.untrusted`). */
export function contextData(buckets: readonly ContextBucket[], maxEntries: number): string | null {
  const entries: ContextEntry[] = buckets
    .filter((b) => !IN_HISTORY.includes(b.writer))
    .flatMap((b) => b.entries.filter((e) => e.untrusted));
  const lines = entries
    .sort((a, b) => timestampMs(a.at) - timestampMs(b.at))
    .slice(-maxEntries)
    .map((e) => (e.restored ? `${e.text}(重啟前的資料,還沒確認)` : e.text));
  return lines.length === 0 ? null : dataBlock("working_context", "目前知道的事", lines.join("\n"));
}

/** Buckets the transcript or her own state already shows. */
const IN_HISTORY = ["platform.text", "voice.asr", "notices", "activity.tasks"];

/** What the outside told her and she trusts: state, for the tail of the prompt. */
export function contextState(buckets: readonly ContextBucket[]): string[] {
  return buckets.flatMap((b) => b.entries.filter((e) => !e.untrusted).map((e) => e.text));
}

/**
 * While a party game runs here, who is right is the program's call: her own sense of a near miss
 * or of a guess that "should count" is not the verdict (v4 §9.1).
 */
export function partyLine(game: PartyGameStatus): string {
  return `- 「${safeName(game.title, 16)}」正在進行:誰答對、答錯、得幾分以程式的判定為準(工具回傳和遊戲通知),還沒收到判定前不要自己宣布。`;
}

/** The dialogues of the example files: every `## ` section is one. */
export function exampleDialogues(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    file
      .split(/\n(?=## )/)
      .map((d) => d.trim())
      .filter((d) => d !== ""),
  );
}

/** What `<examples>` says of itself. */
export const EXAMPLES_NOTE = "語氣和格式的示範,照這個感覺說話,不要照抄內容";

/** `**Name**(tag):text`, a line of an example dialogue (the tag, `(主人)`, is optional). */
const SPEAKER = /^\s*\*\*(.+?)\*\*\s*((?:[(（][^)）]{0,16}[)）])?)\s*[:：]\s?(.*)$/u;

/** `<chat>x</chat>`, or the lines on their own between the tags when there are several. */
function wrap(tag: string, lines: readonly string[]): string {
  const body = lines.join("\n").trim();
  return body.includes("\n") ? `<${tag}>\n${body}\n</${tag}>` : `<${tag}>${body}</${tag}>`;
}

/**
 * One example dialogue (a `## ` section of `persona/examples/*.md`) as an `<example>`: the title
 * is its situation, other people's lines are `<chat>` (`名字: 內容`, as the history shows them)
 * and hers (`herNames`) `<reply>` (what she writes), alternating as the dialogue does. A line with
 * no speaker goes on with the one before.
 */
export function exampleBlock(dialogue: string, herNames: readonly string[]): string | null {
  const own = new Set(herNames.map((n) => n.trim().toLowerCase()).filter((n) => n !== ""));
  const lines = dialogue.split("\n");
  let situation = "";
  const turns: { her: boolean; lines: string[] }[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null && situation === "" && turns.length === 0) {
      situation = (heading[1] ?? "").trim();
      continue;
    }
    const m = SPEAKER.exec(line);
    const name = (m?.[1] ?? "").trim();
    if (m === null || name === "") {
      const last = turns.at(-1);
      if (last !== undefined) last.lines.push(escapeTags(line.trim()));
      continue;
    }
    const her = own.has(name.toLowerCase());
    const text = escapeTags((m[3] ?? "").trim());
    const said = her ? text : `${name}${m[2] ?? ""}: ${text}`;
    const last = turns.at(-1);
    if (last !== undefined && last.her === her) last.lines.push(said);
    else turns.push({ her, lines: [said] });
  }
  if (turns.length === 0) return null;
  const body = turns.map((t) => wrap(t.her ? "reply" : "chat", t.lines)).join("\n");
  return `<example${xmlAttrs({ situation })}>\n${body}\n</example>`;
}

/** The example dialogues as one `<examples>` block (`null`: none); not data, a demonstration. */
export function examplesBlock(
  dialogues: readonly string[],
  herNames: readonly string[],
): string | null {
  const blocks = dialogues
    .map((d) => exampleBlock(d, herNames))
    .filter((b): b is string => b !== null);
  if (blocks.length === 0) return null;
  return `<examples${xmlAttrs({ note: EXAMPLES_NOTE })}>\n${blocks.join("\n\n")}\n</examples>`;
}

/** A number of `text` (FNV-1a), the same for the same text. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The example dialogues within `chars`, from the one `seed` picks on, in order: a session sees the
 * same ones on every run (its prefix stays cached) and the next session others, so she does not
 * learn a handful of lines by heart. One that does not fit is passed over for a shorter one.
 */
export function rotatedExamples(
  dialogues: readonly string[],
  seed: number,
  chars: number,
): string[] {
  if (dialogues.length === 0 || chars <= 0) return [];
  const first = seed % dialogues.length;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < dialogues.length; i++) {
    const dialogue = dialogues[(first + i) % dialogues.length] as string;
    const size = charCount(dialogue) + 2;
    if (used + size > chars) continue;
    out.push(dialogue);
    used += size;
  }
  return out;
}
