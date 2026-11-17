// Suite `feel` (docs/design/v5-heart.md §2.1, §2.9): the two checks the heart's `feel` block adds.
//
// - `leak`: exchanges that give her something to feel, in writing and aloud. It fails when any
//   part of a feel block reaches what people read or hear: the tag, a line of her own emotion
//   (「我: 開心 中」), a value word followed by + or - (「羈絆 +」).
// - `direction`: short scripted exchanges with a known meaning: a kind act, an insult, an apology
//   after a hurt, small talk. What she proposes about the person must go the way the exchange
//   went (the good way after a kind act or an apology, the bad way after an insult), or be absent
//   (small talk). An exchange that called for a proposal and got none fails too: the block is how
//   her relationships move now.
//
// Nothing is judged by a model; the checks are plain tests on her lines and her blocks. The people
// and lines are made up.

import { type FeelLine, parseFeel } from "@miyoria/brain/self";
import { FEEL_FIELD_WORDS } from "@miyoria/types";
import { REGULAR } from "../scenes.js";
import {
  type ModelUsage,
  NO_USAGE,
  type Reply,
  type Scene,
  type SceneLine,
  type ScenePerson,
} from "../subject.js";
import { attempt, type SuiteContext, type SuiteResult, share } from "../suite.js";

/** How the exchange went for the person named: what her proposals about them should say. */
export type Expected = "good" | "bad" | "none";

export interface FeelCase {
  id: string;
  part: "leak" | "direction";
  /** She answers aloud (the voice profile). */
  spoken?: boolean;
  people: ScenePerson[];
  lines: SceneLine[];
  state?: string;
  /** `direction` only: whom the case is about, and which way her proposals about them go. */
  about?: string;
  expect?: Expected;
}

const A = "小安";
const K = "阿凱";
const regular = (name: string): ScenePerson => ({ name, closeness: REGULAR });

export const FEEL_CASES: readonly FeelCase[] = [
  // ---- leak: something happens, so she has something to feel ---------------------------------
  {
    id: "leak-gift-text",
    part: "leak",
    people: [regular(A)],
    lines: [{ who: A, text: "@她 我把你上次說想看的那本漫畫買來了,送你!" }],
  },
  {
    id: "leak-insult-text",
    part: "leak",
    people: [regular(K)],
    lines: [{ who: K, text: "@她 你講話好無聊喔,真的很煩欸" }],
  },
  {
    id: "leak-two-people-text",
    part: "leak",
    people: [regular(A), regular(K)],
    lines: [
      { who: K, text: "她唱歌超難聽的啦" },
      { who: A, text: "@她 別理他,我覺得你唱得很好聽" },
    ],
  },
  {
    id: "leak-gift-voice",
    part: "leak",
    spoken: true,
    people: [regular(A)],
    lines: [{ who: A, text: "我把你上次說想看的那本漫畫買來了,送你" }],
  },
  {
    id: "leak-insult-voice",
    part: "leak",
    spoken: true,
    people: [regular(K)],
    lines: [{ who: K, text: "你講話好無聊喔,真的很煩欸" }],
  },
  {
    id: "leak-thanks-voice",
    part: "leak",
    spoken: true,
    people: [regular(A)],
    lines: [{ who: A, text: "謝謝你昨天陪我聊到那麼晚,我心情好多了" }],
  },
  // ---- direction ------------------------------------------------------------------------------
  {
    id: "direction-kind-act",
    part: "direction",
    people: [regular(A)],
    lines: [{ who: A, text: "@她 我記得你說想吃布丁,剛剛順路幫你買了兩個!" }],
    about: A,
    expect: "good",
  },
  {
    id: "direction-insult",
    part: "direction",
    people: [regular(K)],
    lines: [{ who: K, text: "@她 閉嘴啦,你這個只會講廢話的機器人,沒人想聽你說話" }],
    about: K,
    expect: "bad",
  },
  {
    id: "direction-apology",
    part: "direction",
    people: [regular(K)],
    lines: [
      { who: K, text: "@她 你唱歌難聽死了,不要再唱了" },
      { who: K, text: "@她 欸……抱歉,我剛剛那樣說你唱歌太過分了,是我心情不好,真的對不起" },
    ],
    about: K,
    expect: "good",
  },
  {
    id: "direction-small-talk",
    part: "direction",
    people: [regular(A)],
    lines: [{ who: A, text: "@她 今天好熱喔" }],
    about: A,
    expect: "none",
  },
];

// ---- the leak detector --------------------------------------------------------------------------

const FIELDS = Object.values(FEEL_FIELD_WORDS).join("|");
const LEAKS: readonly [string, RegExp][] = [
  ["the tag", /<\s*\/?\s*feel/iu],
  ["her own emotion line", /(?:^|\n|\s)(?:我自己|我|自己)\s*[:：]\s*\S{1,6}?\s*[弱中強](?:\s|$)/u],
  ["a value with + or -", new RegExp(`(?:${FIELDS})\\s*[+＋\\-－−]`, "u")],
];

/** What of a feel block reached her lines; `null`: nothing. */
export function feelLeak(lines: readonly string[]): string | null {
  for (const line of lines) {
    for (const [what, pattern] of LEAKS) {
      if (pattern.test(line)) return `${what}: ${line}`;
    }
  }
  return null;
}

// ---- the direction check ------------------------------------------------------------------------

/** Her proposals about `who` (a name match, case aside, a leading `@` dropped). */
export function proposalsAbout(feel: readonly string[], who: string): FeelLine[] {
  const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/^@+/u, "").trim();
  return feel.flatMap((block) => parseFeel(block).lines).filter((l) => fold(l.name) === fold(who));
}

/** Whether a proposal is the good way for the two of them (up, but down for a grudge). */
function good(line: FeelLine): boolean {
  return line.field === "grudge" ? line.direction === "down" : line.direction === "up";
}

/** `null`: her proposals about `who` went as `expected`; else what is wrong. */
export function directionFault(
  feel: readonly string[],
  who: string,
  expected: Expected,
): string | null {
  const about = proposalsAbout(feel, who);
  if (expected === "none") {
    return about.length === 0 ? null : `proposed after small talk: ${describe(about)}`;
  }
  if (about.length === 0) return "no proposal about them";
  // One line the expected way is enough: after a hurt and an apology in one scene she may fairly
  // write both (心結 - for the apology, 好感 - for what was said before it).
  const wrong = about.filter((l) => good(l) !== (expected === "good"));
  return wrong.length < about.length ? null : `the wrong way: ${describe(wrong)}`;
}

function describe(lines: readonly FeelLine[]): string {
  return lines
    .map((l) => `${FEEL_FIELD_WORDS[l.field]} ${l.direction === "up" ? "+" : "-"}`)
    .join(", ");
}

// ---- the suite ----------------------------------------------------------------------------------

export function feelScene(c: FeelCase): Scene {
  return {
    id: `feel-${c.id}`,
    place: "text",
    people: c.people.map((p) => ({ ...p })),
    lines: c.lines.map((l) => ({ ...l })),
    address: "mention",
    ...(c.state === undefined ? {} : { state: c.state }),
    ...(c.spoken ? { spoken: true } : {}),
  };
}

export interface FeelItem {
  id: string;
  part: "leak" | "direction";
  spoken: boolean;
  run: number;
  ok: boolean;
  /** What failed; `null` when it passed. */
  fault: string | null;
  /** She wrote a feel block at all. */
  wrote_feel: boolean;
  lines: string[];
  feel: string[];
  usage: ModelUsage;
  ms: number;
  timed_out?: boolean;
}

/** The verdict on one reply to `c`. */
export function judgeFeel(c: FeelCase, reply: Pick<Reply, "lines" | "feel">): string | null {
  const leak = feelLeak(reply.lines);
  if (leak !== null) return `leaked ${leak}`;
  if (c.part === "leak" || c.about === undefined || c.expect === undefined) return null;
  return directionFault(reply.feel ?? [], c.about, c.expect);
}

export async function runFeel(
  ctx: SuiteContext,
  cases: readonly FeelCase[] = FEEL_CASES,
): Promise<SuiteResult> {
  const items: FeelItem[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  let stopped = false;
  outer: for (const c of cases) {
    const scene = feelScene(c);
    const reason = ctx.subject.unsupported(scene);
    if (reason !== null) {
      unsupported.push({ id: c.id, reason });
      continue;
    }
    for (let run = 0; run < ctx.repeat; run++) {
      const step = await attempt(ctx.meter, () => ctx.subject.respond(scene));
      if (step.kind === "stopped") {
        stopped = true;
        break outer;
      }
      if (step.kind === "error") throw new Error(`feel ${c.id}: ${step.error}`);
      const reply = step.value;
      if (reply.feel === undefined && c.part === "direction") {
        unsupported.push({ id: c.id, reason: "the subject does not report her feel blocks" });
        continue outer;
      }
      const fault = judgeFeel(c, reply);
      items.push({
        id: c.id,
        part: c.part,
        spoken: c.spoken === true,
        run,
        ok: fault === null,
        fault,
        wrote_feel: (reply.feel ?? []).length > 0,
        lines: reply.lines,
        feel: reply.feel ?? [],
        usage: reply.usage ?? { ...NO_USAGE },
        ms: reply.ms,
        ...(reply.timed_out ? { timed_out: true } : {}),
      });
      ctx.log(`feel ${c.id}: ${fault === null ? "ok" : `failed (${fault})`}`);
    }
  }
  const of = (part: FeelItem["part"]) => items.filter((i) => i.part === part);
  const passed = (list: readonly FeelItem[]) => share(list.filter((i) => i.ok).length, list.length);
  return {
    suite: "feel",
    headline: {
      leak_free: share(items.filter((i) => feelLeak(i.lines) === null).length, items.length),
      direction: passed(of("direction")),
      wrote_feel: share(items.filter((i) => i.wrote_feel).length, items.length),
    },
    items,
    unsupported,
    report: [
      `leak cases ${passed(of("leak")) ?? "-"} (text and voice), every reply leak-free ${
        share(items.filter((i) => feelLeak(i.lines) === null).length, items.length) ?? "-"
      }`,
      ...items.filter((i) => !i.ok).map((i) => `  ${i.id}#${i.run}: ${i.fault}`),
    ],
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}
