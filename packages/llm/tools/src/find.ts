// `find_tools`: how she reaches the tools a turn does not always offer. A search over name,
// group and description by plain substring, which works for Chinese and English alike; what it
// finds joins the session's loaded tools.

import { type ContextKey, contextKeyString, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { LoadedTools } from "./loaded.js";
import { defineTool, type Tool, type ToolEffect, type ToolRisk } from "./tool.js";

export const FIND_TOOLS = "find_tools";
/** Matches one search returns (and loads). */
export const FIND_TOOLS_LIMIT = 8;

/** What a search reads of a tool. */
export interface ToolListing {
  name: string;
  description: string;
  group: string;
  effect: ToolEffect;
  risk: ToolRisk;
  core: boolean;
}

/** One match as she is shown it. */
export interface FoundTool {
  name: string;
  /** The first sentence of the description. */
  description: string;
  effect: ToolEffect;
  risk: ToolRisk;
  group: string;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const RUNS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

export interface SearchTerm {
  text: string;
  /** What a hit in a description counts: 2 for a whole word or run, 1 for a part of a run. */
  weight: 2 | 1;
  /** A two-character word taken apart: it hits when the description has both characters. */
  both?: [string, string];
}

/**
 * The query as lower-case terms: words (a tool name stays whole), and a run of Chinese or
 * Japanese characters both whole and in parts, since nothing marks where its words end: every
 * pair of neighbours of a longer run, and the two characters of a two-character one (「唱歌」
 * finds 「唱一首歌」).
 */
export function searchTerms(query: string): SearchTerm[] {
  const terms = new Map<string, SearchTerm>();
  const add = (text: string, weight: 2 | 1, both?: [string, string]) => {
    if (text === "" || terms.has(text)) return;
    terms.set(text, both ? { text, weight, both } : { text, weight });
  };
  for (const piece of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    for (const run of piece.match(RUNS) ?? []) {
      add(run, 2);
      if (!CJK.test(run)) continue;
      const chars = [...run];
      for (let i = 0; chars.length > 2 && i + 1 < chars.length; i++) {
        add(`${chars[i]}${chars[i + 1]}`, 1);
      }
      const [a, b] = chars;
      if (chars.length === 2 && a !== undefined && b !== undefined) add(`${a}+${b}`, 1, [a, b]);
    }
  }
  return [...terms.values()];
}

/**
 * Words she may use for a group, whose key is English. A description mentions other topics too
 * (「唱歌」 is in several coin tools), so the group has to count for more than a mention.
 */
const GROUP_WORDS: Readonly<Record<string, readonly string[]>> = {
  economy: ["金幣", "魚幣", "錢", "錢包", "商店", "經濟"],
  party: ["派對", "派對遊戲"],
  sing: ["唱歌", "歌", "點歌"],
  game: ["遊戲"],
  stream: ["直播", "開台"],
  voice: ["語音"],
  memory: ["記憶", "回憶"],
  notebook: ["筆記本"],
  notes: ["筆記"],
  web: ["網路", "網頁", "搜尋"],
  code: ["程式"],
  workspace: ["工作區", "檔案"],
  skills: ["技能"],
  work: ["任務"],
  rules: ["規則"],
  schedule: ["提醒"],
  chat: ["私訊", "聊天"],
  diary: ["日記"],
};

/** A match scoring under this share of the best one is left out (and not loaded). */
const KEEP_SHARE = 0.5;

function score(tool: ToolListing, terms: readonly SearchTerm[]): number {
  const name = tool.name.toLowerCase();
  const words = name.split(/[_-]+/);
  const group = tool.group.toLowerCase();
  const groupWords = GROUP_WORDS[group] ?? [];
  const description = tool.description.toLowerCase();
  // What the tool is for comes first; later sentences are when to use it and what else exists.
  const head = firstSentence(description, Number.POSITIVE_INFINITY);
  const said = (has: (text: string) => boolean) => (has(head) ? 1 : has(description) ? 0.5 : 0);
  let total = 0;
  for (const { text, weight, both } of terms) {
    if (both) {
      total += weight * said((where) => both.every((char) => where.includes(char)));
      continue;
    }
    total += weight * said((where) => where.includes(text));
    if (group === text || groupWords.includes(text)) total += 4;
    if (weight < 2) continue;
    if (name === text) total += 8;
    else if (words.includes(text)) total += 5;
    else if (name.includes(text)) total += 3;
  }
  return total;
}

/** The description's first sentence, on one line. */
export function firstSentence(description: string, maxChars = 80): string {
  const line = description.replace(/\s+/g, " ").trim();
  const end = line.search(/[。!?！？]|\.(\s|$)/u);
  const sentence = [...(end === -1 ? line : line.slice(0, end + 1))];
  return sentence.length > maxChars
    ? `${sentence.slice(0, maxChars).join("")}…`
    : sentence.join("");
}

/**
 * The tools that are not always offered and match `query` (within `group` when given), best
 * first, ties by name; a match far weaker than the best one is left out. An empty query with a
 * group lists the group.
 */
export function searchTools(
  tools: readonly ToolListing[],
  query: string,
  group: string | null = null,
  limit: number = FIND_TOOLS_LIMIT,
): FoundTool[] {
  const terms = searchTerms(query);
  const wanted = group?.trim().toLowerCase() ?? "";
  const ranked = tools
    .filter((t) => !t.core && (wanted === "" || t.group.toLowerCase() === wanted))
    .map((tool) => ({
      tool,
      score: terms.length === 0 ? (wanted === "" ? 0 : 1) : score(tool, terms),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1));
  const least = (ranked[0]?.score ?? 0) * KEEP_SHARE;
  const kept = ranked.filter((r) => r.score >= least);
  return kept.slice(0, Math.max(0, limit)).map(({ tool }) => ({
    name: tool.name,
    description: firstSentence(tool.description),
    effect: tool.effect,
    risk: tool.risk,
    group: tool.group,
  }));
}

/** The session a tool call belongs to, until the turn runner has session ids of its own. */
export function toolSession(context: ContextKey): string {
  return contextKeyString(context);
}

const Params = z.object({
  query: z
    .string()
    .describe("想做的事或工具的關鍵字,中文或英文都可以,例如「金幣」「唱歌」「game」"),
  group: z.string().describe("只找某一類,例如 economy、party、sing、game、stream").optional(),
});

/** Where `find_tools` looks and what it adds to. */
export interface ToolCatalog {
  listings(): ToolListing[];
  readonly loaded: LoadedTools;
}

/** `find_tools` over `catalog`. */
export function findTools(catalog: ToolCatalog): Tool {
  return defineTool({
    name: FIND_TOOLS,
    description:
      "找出平常不在你工具清單裡的工具(金幣、派對遊戲、唱歌、遊戲、直播這些)。" +
      "用關鍵字說你想做的事;找到的工具會加進這次對話可以用的工具,之後直接呼叫就好。" +
      "不確定有沒有這種工具時先找,不要猜工具的名字。",
    parameters: Params,
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "core",
    core: true,
    next: true,
    readOnly: true,
    async call(ctx, raw: JsonValue): Promise<string> {
      const args = Params.safeParse(raw);
      if (!args.success) return "要給 query(想找什麼)。";
      const all = catalog.listings();
      const found = searchTools(all, args.data.query, args.data.group ?? null);
      if (found.length === 0) {
        const groups = [...new Set(all.filter((t) => !t.core).map((t) => t.group))].sort();
        return `沒有找到符合的工具。可以找的類別:${groups.join("、")}`;
      }
      catalog.loaded.load(
        toolSession(ctx.context),
        found.map((f) => f.name),
      );
      const lines = found.map((f) => `- ${f.name}(${f.effect},風險 ${f.risk}):${f.description}`);
      return `找到 ${found.length} 個工具,已經加進你可以用的工具:\n${lines.join("\n")}`;
    },
  });
}
