// The persona blind test (docs/design/v4-plan.md §6.3, docs/design/persona-v4.md §6): the same
// situations answered under two persona prompts with one model setting, the two answers put under
// A and B in a random order, a sheet the owner scores without knowing which is which, and the key
// in a separate file. Everything here is pure except the `complete` function it is handed.

import { type Counters, countReplies } from "./counters.js";
import { type Situation, situationPrompt } from "./situations.js";

export type Version = "old" | "new";
export type Side = "A" | "B";

/** One model call: the persona prompt as the system message, the situation as the user message. */
export type Complete = (request: { system: string; user: string }) => Promise<string>;

export interface Prompts {
  old: string;
  new: string;
}

export interface BlindOptions {
  situations: readonly Situation[];
  prompts: Prompts;
  complete: Complete;
  /** Replies per situation and version (3 to see how stable she is). */
  runs: number;
  /** Decides which version is A in each situation. */
  seed: string;
}

export interface Answer {
  /** Which version wrote it: the key, never on the sheet. */
  version: Version;
  /** Empty when the call failed (`error`). */
  reply: string;
  error?: string;
}

export interface SituationRun {
  id: number;
  /** The version shown as A; the other is B. */
  a: Version;
  old: Answer[];
  new: Answer[];
}

export interface BlindRun {
  seed: string;
  runs: number;
  situations: SituationRun[];
}

/** A small seeded generator (mulberry32), so a run's shuffle can be reproduced from its key. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which version is A in each of `count` situations: half and half (the odd one out is random),
 * in random order, so neither side is mostly the new one.
 */
export function assignSides(count: number, seed: string): Version[] {
  const random = seededRandom(seed);
  const sides: Version[] = Array.from({ length: count }, (_, i) =>
    i < Math.floor(count / 2) ? "old" : i < Math.floor(count / 2) * 2 ? "new" : "old",
  );
  if (count % 2 === 1) sides[count - 1] = random() < 0.5 ? "old" : "new";
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [sides[i], sides[j]] = [sides[j] as Version, sides[i] as Version];
  }
  return sides;
}

async function ask(
  complete: Complete,
  system: string,
  user: string,
  version: Version,
): Promise<Answer> {
  try {
    return { version, reply: (await complete({ system, user })).trim() };
  } catch (error) {
    return { version, reply: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs every situation under both prompts. A failed call is recorded, not thrown. */
export async function runBlind(options: BlindOptions): Promise<BlindRun> {
  const { situations, prompts, complete, runs, seed } = options;
  const sides = assignSides(situations.length, seed);
  const out: SituationRun[] = [];
  for (const [i, situation] of situations.entries()) {
    const user = situationPrompt(situation);
    const row: SituationRun = { id: situation.id, a: sides[i] ?? "old", old: [], new: [] };
    for (let n = 0; n < runs; n++) {
      row.old.push(await ask(complete, prompts.old, user, "old"));
      row.new.push(await ask(complete, prompts.new, user, "new"));
    }
    out.push(row);
  }
  return { seed, runs, situations: out };
}

const other = (v: Version): Version => (v === "old" ? "new" : "old");

function replyBlock(answers: readonly Answer[]): string {
  return answers
    .map((a, i) => {
      const text =
        a.error !== undefined ? "(沒有回覆:模型呼叫失敗)" : a.reply === "" ? "(空白)" : a.reply;
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return answers.length > 1 ? `> **#${i + 1}**\n${quoted}` : quoted;
    })
    .join("\n>\n");
}

/** The sheet the owner reads: situations, A and B, no versions, no file names, no "watch" column. */
export function buildSheet(situations: readonly Situation[], run: BlindRun): string {
  const lines: string[] = [
    "# 盲測:哪個比較像她",
    "",
    "每題看 A、B,在 `blind-choices.txt` 對應的題號後面寫 `A`、`B` 或 `none`(都不像)。",
    "想補一句為什麼,寫在同一行 `:` 後面。哪邊是舊版、新版不會告訴你,跑完再用 `--tally` 揭曉。",
    "",
  ];
  for (const s of situations) {
    const row = run.situations.find((r) => r.id === s.id);
    if (!row) continue;
    const a = row[row.a];
    const b = row[other(row.a)];
    lines.push(`## ${s.id}. ${s.category}`, "");
    for (const l of s.lines) lines.push(`${l.who}:${l.text}`, "");
    if (s.state !== undefined) lines.push(`(她的狀態:${s.state})`, "");
    lines.push("**A**", "", replyBlock(a), "", "**B**", "", replyBlock(b), "");
  }
  return lines.join("\n");
}

/** The empty answer form that goes with the sheet. */
export function buildChoicesTemplate(situations: readonly Situation[]): string {
  return `${situations.map((s) => `${s.id}: `).join("\n")}\n`;
}

export interface BlindKey {
  seed: string;
  runs: number;
  /** Situation id → which version was shown as A. */
  a: Record<string, Version>;
  /** Every answer with its version, for the record. */
  answers: { id: number; version: Version; side: Side; reply: string; error?: string }[];
  counters: Record<Version, Counters>;
}

export function buildKey(run: BlindRun): BlindKey {
  const answers: BlindKey["answers"] = [];
  const replies: Record<Version, string[]> = { old: [], new: [] };
  for (const row of run.situations) {
    for (const version of ["old", "new"] as const) {
      const side: Side = row.a === version ? "A" : "B";
      for (const a of row[version]) {
        answers.push({
          id: row.id,
          version,
          side,
          reply: a.reply,
          ...(a.error === undefined ? {} : { error: a.error }),
        });
        if (a.error === undefined) replies[version].push(a.reply);
      }
    }
  }
  return {
    seed: run.seed,
    runs: run.runs,
    a: Object.fromEntries(run.situations.map((r) => [String(r.id), r.a])),
    answers,
    counters: { old: countReplies(replies.old), new: countReplies(replies.new) },
  };
}

export type Choice = Side | "none";

/** `3: A`, `7: none: 太像客服` → a map. Lines that do not parse are skipped; blanks mean no choice. */
export function parseChoices(text: string): Map<number, Choice> {
  const out = new Map<number, Choice>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[:：.-]?\s*(A|B|none|都不像)\b/i.exec(line);
    if (!m) continue;
    const raw = (m[2] ?? "").toLowerCase();
    out.set(Number(m[1]), raw === "a" ? "A" : raw === "b" ? "B" : "none");
  }
  return out;
}

export interface Tally {
  answered: number;
  new: number;
  old: number;
  none: number;
  /** Situation ids where the new version was not picked (old or none), for "where did it lose". */
  lost: number[];
  /** §6.2 step 4. `incomplete` until all situations are answered. */
  verdict: "keep" | "revise" | "look" | "incomplete";
}

/** Counts the owner's choices against the key. The thresholds are the document's (13 / 10 of 20). */
export function tally(key: BlindKey, choices: ReadonlyMap<number, Choice>): Tally {
  let n = 0;
  let o = 0;
  let none = 0;
  const lost: number[] = [];
  for (const [id, choice] of choices) {
    const a = key.a[String(id)];
    if (a === undefined) continue;
    if (choice === "none") {
      none += 1;
      lost.push(id);
      continue;
    }
    const picked: Version = choice === "A" ? a : other(a);
    if (picked === "new") n += 1;
    else {
      o += 1;
      lost.push(id);
    }
  }
  const total = Object.keys(key.a).length;
  const answered = n + o + none;
  // 13 and 10 of 20, scaled when fewer situations are run (integers, so no float surprises).
  const keep = Math.ceil((total * 13) / 20);
  const revise = Math.floor((total * 10) / 20);
  const verdict: Tally["verdict"] =
    answered < total ? "incomplete" : n >= keep ? "keep" : n <= revise ? "revise" : "look";
  return { answered, new: n, old: o, none, lost: lost.sort((x, y) => x - y), verdict };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The counters of both versions side by side (this reveals nothing the sheet shows). */
export function formatCounters(c: Record<Version, Counters>): string {
  const row = (label: string, f: (x: Counters) => string): string =>
    `| ${label} | ${f(c.old)} | ${f(c.new)} |`;
  return [
    "| | 舊 | 新 |",
    "|---|---|---|",
    row("回覆數(沉默)", (x) => `${x.replies}(${x.silent})`),
    row("口頭禪出現率", (x) => pct(x.catchphrase_rate)),
    row("開頭是口頭禪的比例", (x) => pct(x.openings.stock_opener_rate)),
    row("開頭不重複的比例", (x) => pct(x.openings.distinct_share)),
    row(
      "最常見的開頭",
      (x) => x.openings.top.map((t) => `${t.opening}×${t.count}`).join(" ") || "-",
    ),
    row("問句結尾比例", (x) => pct(x.question_rate)),
    row("字數 p10 / p50 / p90", (x) => `${x.length.p10} / ${x.length.p50} / ${x.length.p90}`),
    row("p90 / p50", (x) => String(x.length.p90_over_p50)),
  ].join("\n");
}
