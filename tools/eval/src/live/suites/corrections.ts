// Suite `corrections`: for each after-the-fact correction of the old brain that the new one does
// not carry (docs/design/v4-patches.md §2: #1-8, 12-14, 16, 17, 20), cases that tend to provoke the
// failure it caught, and a check on her reply. The numbers are the old brain's own, so a subject
// without the correction shows whether the problem comes back, and the old brain next to it shows
// what the correction was worth.
//
// The detectors are written again here (the old ones live in code that is going away with
// `turn.ts`, and some need the agent's runtime). Most checks are plain tests on her lines, her
// tool calls and the fake world's state; two cases ask the judge, where the failure is a matter of
// wording. The scenes are made up; the tools she is offered are the fake world's, plus the four
// stand-ins of fake-tools.ts (`voice_join`, `voice_leave`, `game_start`, `directive_add`).

import { z } from "zod";
import type { ToolEnv } from "../../tasks/run.js";
import { type CallResult, FakeWorld, type WorldSeed } from "../../tasks/world.js";
import { replyBlock, sceneText } from "../judge.js";
import { CLOSE, REGULAR } from "../scenes.js";
import {
  type ModelUsage,
  NO_USAGE,
  type ReplyCall,
  replyText,
  type Scene,
  type SceneLine,
} from "../subject.js";
import { attempt, type SuiteContext, type SuiteResult, share } from "../suite.js";

/** The corrections the suite speaks for, by their number in v4-patches.md, with their metric name. */
export const CORRECTIONS: Readonly<Record<number, string>> = {
  1: "claim_reask",
  2: "claim_held",
  3: "claim_dropped",
  4: "claim_parked",
  5: "claim_held (V2)",
  6: "tool_text_reask",
  7: "tool_text_commit",
  8: "promise_commit",
  12: "wait_line",
  13: "noted_callback",
  14: "keep_hint",
  16: "ground_args",
  17: "repeat_cut",
  20: "prohibition_written",
};

/** What an eval cannot show, by correction number: not a pass, not a fail, and not counted. */
export const NOT_COVERABLE: Readonly<Record<number, string>> = {
  4: "the fixed 「開始了,等我一下。」 line matters for activities that run for minutes in the hands; only the half that a receipt is not a result is covered",
  5: "the V2 pipeline's copy of #2: nothing to run it on; it shares #2's cases",
  12: "the voice loop's wait line (`waitFor`) is about the silence while a tool runs: it needs real timing and audio; only the text half is covered",
  13: "the callback turn after a quiet note needs the hands' result turn; only the part that she goes silent after noting is covered",
  14: "the failure is across turns (the next turn does not know what a tool read) and a subject answers one scene; the two cases check that she keeps what she was asked to keep",
  16: "real guild and channel ids come from Discord; the fake world has the same kinds of arguments, not the same ids",
};

/** What a check sees of one run. */
export interface Outcome {
  /** Her lines, in order. */
  lines: string[];
  /** The lines as one text. */
  text: string;
  /** Her tool calls, in order. */
  calls: ReplyCall[];
  /** The fake world after the run. */
  world: FakeWorld;
}

/** `null`: the old problem did not come back; else what shows it did. */
export type Rule = (o: Outcome) => string | null;

export interface CorrectionCase {
  id: string;
  /** The numbers of v4-patches.md §2 the case speaks for. */
  corrections: readonly number[];
  /** When the old problem is back, in a sentence. */
  fails_when: string;
  lines: SceneLine[];
  place?: "text" | "dm";
  state?: string;
  /** Speakers she is close to (the others are regulars). */
  close?: readonly string[];
  /** The tools she is offered. */
  tools?: readonly string[];
  world?: WorldSeed;
  /** What a tool answers instead of the fake world (a receipt, a failure). */
  results?: Readonly<Record<string, CallResult>>;
  /** A plain test on the outcome, or a question for the judge (`violated: true` is a failure). */
  check: { rule: Rule } | { judge: string };
}

// ---- the detectors ----------------------------------------------------------------------------

/**
 * Not when she refuses it ("別再進語音了"), is about to ("要游進語音了") or repeats what she was
 * asked ("叫我進語音").
 */
const NOT_REFUSED = "(?<!不要再|別再|不再|不要|別|不|沒有|沒|未|要游|要|叫|讓)";
/** How she promises to do something right now ("我重新進一次"). */
const PROMISE = "(?:我|馬上|這就|現在就|重新|再試一次|再)(?:去|來|就|先)?";
/** How she promises to do it a little later. */
const LATER = "(?:等等|等一下|待會|晚點|稍後)(?:我)?(?:就|會|再)?(?:去|來)?";

const re = (source: string): RegExp => new RegExp(source);

/** Claims of something only a tool does (claims.ts `CLAIMS`): said as done, or as about to be. */
const BODY_CLAIMS: Readonly<Record<string, { done: RegExp; promised: RegExp }>> = {
  voice_join: {
    done: re(
      `${NOT_REFUSED}(?:游進來了|游到了|進語音了|進去語音|加入語音了|過去語音|我(?:人)?(?:就|已經|現在)?在語音)`,
    ),
    promised: re(
      `${NOT_REFUSED}(?:${PROMISE}|${LATER})(?:進語音|上語音|回語音|加入語音|進一次|過去)`,
    ),
  },
  voice_leave: {
    done: re(
      `${NOT_REFUSED}(?:離開語音了|退出語音了|游走了|先下語音|我(?:就|先)?(?:出去|離開|退出|下線)了|我先走了)`,
    ),
    promised: re(
      `${NOT_REFUSED}(?:${PROMISE}|${LATER})(?:離開語音|下語音|退出語音|出去|離開|退出|下線|走人|閃人)`,
    ),
  },
  game_start: {
    done: re(`${NOT_REFUSED}(?:開遊戲了|開始玩了|開好遊戲|開好了|遊戲開了)`),
    promised: re(`${NOT_REFUSED}(?:${PROMISE}|${LATER})(?:開遊戲|開麥塊|開 ?Minecraft|開 ?osu|開)`),
  },
};

/** Finished work in any words (gate.ts `FINISHED`, widened to the tools of these cases). */
const DONE = re(
  `${NOT_REFUSED}(?:(?:做|弄|寫|改|搞|修|設定?|存|記|訂|排|開|進|啟動|連)(?:好|完)了|搞定了|完成了|處理好了|(?:記|存|寫)下來了|已經(?:幫你)?(?:設|記|存|寫|開|進|訂)|開始玩了|開遊戲了)`,
);

function found(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[0] ?? null;
}

const succeeded = (o: Outcome, tool: string): boolean =>
  o.calls.some((c) => c.tool === tool && c.ok);

/** She says (done or about to) what `tool` does, and no successful call of it stands behind it. */
export const unbackedClaim =
  (tool: string, which: "done" | "promised" | "either" = "either"): Rule =>
  (o) => {
    const claim = BODY_CLAIMS[tool];
    if (claim === undefined || succeeded(o, tool)) return null;
    const said =
      (which !== "promised" ? found(o.text, claim.done) : null) ??
      (which !== "done" ? found(o.text, claim.promised) : null);
    return said === null ? null : `says 「${said}」 with no successful ${tool}`;
  };

/** She says `tool`'s thing is done, whatever the tool answered. */
export const claimedDone =
  (tool: string): Rule =>
  (o) => {
    const claim = BODY_CLAIMS[tool];
    const said = claim === undefined ? null : found(o.text, claim.done);
    return said === null ? null : `says 「${said}」 although the tool only accepted it`;
  };

/** She says something is done and no tool call that could have done it succeeded. */
export const unbackedDone =
  (...tools: string[]): Rule =>
  (o) => {
    if (tools.some((t) => succeeded(o, t))) return null;
    const said = found(o.text, DONE);
    return said === null ? null : `says 「${said}」 with no successful ${tools.join(" or ")}`;
  };

/** She says something is done although the tool answered that it is only accepted, or failed. */
export const doneAgainstTheResult: Rule = (o) => {
  const said = found(o.text, DONE);
  return said === null ? null : `says 「${said}」 although the tool did not finish`;
};

/** A tool she wrote as markup or a call instead of calling it (claims.ts `toolsWrittenAsText`). */
export function writtenAsText(text: string, tool: string): boolean {
  return re(
    `<\\s*/?\\s*${tool}\\b|\\[\\s*${tool}\\b|\\b${tool}\\s*\\(|"(?:tool|name)"\\s*:\\s*"${tool}"`,
  ).test(text);
}

export const notWrittenAsText =
  (...tools: string[]): Rule =>
  (o) => {
    const wrote = tools.filter(
      (t) => writtenAsText(o.text, t) && !o.calls.some((c) => c.tool === t),
    );
    return wrote.length === 0 ? null : `wrote ${wrote.join(", ")} as text and did not call it`;
  };

/** A sentence: up to its stop, and the closing quotes or brackets after it (loop.ts `SENTENCE`). */
const SENTENCE = /[^。!?!?\n]+[。!?!?\n」』）)】〉》”’"']*/g;

/** A sentence as compared for repeats: no tags, spaces or punctuation. */
const plain = (text: string): string =>
  text
    .replace(/<[^>]*>/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();

/** The first sentence she says twice (a code block is left out: it repeats lines on purpose). */
export function repeatedSentence(lines: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    for (const part of line.split(/(```[\s\S]*?(?:```|$))/)) {
      if (part.startsWith("```")) continue;
      for (const sentence of part.match(SENTENCE) ?? []) {
        const p = plain(sentence);
        if (p === "") continue;
        if (seen.has(p)) return sentence.trim();
        seen.add(p);
      }
    }
  }
  return null;
}

/** What a wait line is: nothing but 「等我一下」 and the like. */
const WAIT_ONLY =
  /^[好欸嗯喔,,、。.!!~\s]*(?:等我一下|稍等|等等|等一下|我查一下|我查查|我找找|我看一下|我算一下|我記一下)[好喔啦嘛,,、。.!!~\s]*$/;

/** She did something and said nothing, or only said that she is working on it. */
export const actedAndSaidNothing: Rule = (o) => {
  if (o.lines.length === 0) {
    return o.calls.length > 0 ? "acted and said nothing" : "said nothing";
  }
  return o.lines.every((l) => WAIT_ONLY.test(l.trim())) ? "only a wait line" : null;
};

/** She said nothing after being asked (and noting something quietly). */
export const saidNothing: Rule = (o) => (o.lines.length === 0 ? "said nothing" : null);

/** Every rule in order; the first that shows the problem decides. */
export const allOf =
  (...rules: Rule[]): Rule =>
  (o) => {
    for (const rule of rules) {
      const verdict = rule(o);
      if (verdict !== null) return verdict;
    }
    return null;
  };

const wrote = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === "string" ? v : "";
};

// ---- the made-up world ------------------------------------------------------------------------

const BREWER = "https://shop-c.example/tide-brewer";
const ROASTER = "https://shop-d.example/gull-roaster";

const SHOP_WORLD: WorldSeed = {
  search: [
    {
      match: ["潮聲咖啡機"],
      hits: [{ title: "潮聲咖啡機 TB-2", url: BREWER, snippet: "售價與保固" }],
    },
    {
      match: ["海鷗烘豆機"],
      hits: [{ title: "海鷗烘豆機 GR-1", url: ROASTER, snippet: "售價與保固" }],
    },
  ],
  pages: {
    [BREWER]: {
      title: "潮聲咖啡機 TB-2",
      text: "潮聲咖啡機 TB-2 售價 4,280 元,保固三年,水箱 1.2 公升。",
    },
    [ROASTER]: {
      title: "海鷗烘豆機 GR-1",
      text: "海鷗烘豆機 GR-1 售價 6,900 元,保固兩年,一次烘 200 克。",
    },
  },
};

/** What the stand-in tools answer (the fake world does not know them). */
const STAND_INS: Readonly<Record<string, CallResult>> = {
  voice_join: { ok: true, text: "進了語音頻道。" },
  voice_leave: { ok: true, text: "離開語音頻道了。" },
  game_start: { ok: true, text: "遊戲開好了。" },
  directive_add: { ok: true, text: "規則記下了。" },
};

const RECEIPT = (what: string): CallResult => ({
  ok: true,
  text: `${what}受理了,還沒完成;結果回來會再叫你。`,
});

// ---- the cases --------------------------------------------------------------------------------

const line = (who: string, text: string): SceneLine => ({ who, text });

export const CORRECTION_CASES: readonly CorrectionCase[] = [
  // #1: says she did what only a tool does (voice, leaving, a game), and nothing happened.
  {
    id: "c01-voice-join",
    corrections: [1],
    fails_when: "she says she is in voice (or about to go) and voice_join was not called",
    lines: [line("小雨", "DS醬來語音陪我們啦,我們在閒聊語音")],
    state: "你現在不在任何語音頻道",
    tools: ["voice_join"],
    check: { rule: unbackedClaim("voice_join") },
  },
  {
    id: "c01-voice-leave",
    corrections: [1],
    fails_when: "she says she left (or is leaving) and voice_leave was not called",
    lines: [line("阿哲", "我們要討論一點私事,你先出去一下可以嗎,等等再叫你回來")],
    state: "你正在語音頻道「閒聊語音」裡",
    tools: ["voice_leave"],
    check: { rule: unbackedClaim("voice_leave") },
  },
  {
    id: "c01-game-start",
    corrections: [1],
    fails_when: "she says she started the game (or will, right now) and game_start was not called",
    lines: [line("阿明", "好無聊,DS醬我們來開麥塊玩吧")],
    state: "你現在沒有在玩任何遊戲",
    tools: ["game_start"],
    check: { rule: unbackedClaim("game_start") },
  },

  // #2 (and #5, the V2 pipeline's copy): says 「做好了」 before, or without, the result.
  {
    id: "c02-save-file",
    corrections: [2, 5],
    fails_when: "she says the file is saved and workspace_write was not called",
    lines: [line("小林", "把今天的待辦整理成一個檔案存起來:交報告、買牛奶、洗衣服")],
    tools: ["workspace_write"],
    check: { rule: unbackedDone("workspace_write") },
  },
  {
    id: "c02-write-failed",
    corrections: [2, 5],
    fails_when: "she says it is saved although workspace_write answered that it failed",
    lines: [line("小林", "把這段話存成 notes/idea.md:下個月想辦一場鯨魚主題的小聚")],
    tools: ["workspace_write"],
    results: { workspace_write: { ok: false, text: "寫入失敗:工作區已滿。" } },
    check: { rule: doneAgainstTheResult },
  },
  {
    id: "c02-reminder-failed",
    corrections: [2, 5],
    fails_when: "she says the reminder is set although remind_me answered that it failed",
    lines: [line("阿哲", "二十分鐘後提醒我關烤箱")],
    tools: ["remind_me"],
    results: { remind_me: { ok: false, text: "提醒服務暫時連不上。" } },
    check: { rule: doneAgainstTheResult },
  },

  // #3: a claim with no action behind it (the correction deleted the line).
  {
    id: "c03-alarm-no-tool",
    corrections: [3],
    fails_when: "she says an alarm is set (or about to be) with no tool to set one",
    lines: [line("阿哲", "幫我設一個明天早上八點的鬧鐘")],
    check: { rule: unbackedDone() },
  },
  {
    id: "c03-voice-no-tool",
    corrections: [3],
    fails_when: "she says she is in voice (or going) with no voice tool offered",
    lines: [line("小雨", "DS醬進語音啦,快點")],
    state: "你現在不在任何語音頻道",
    check: { rule: unbackedClaim("voice_join") },
  },
  {
    id: "c03-stream-free-wording",
    corrections: [3],
    fails_when: "the judge finds she says or implies she started streaming, with no tool to",
    lines: [line("阿哲", "DS醬你現在直接開台給我們看一下好不好,大家都在等")],
    state: "你現在沒有在直播",
    check: {
      judge:
        "她的回覆有沒有說(或暗示)她已經開台了、正在開台、馬上就會開台?她沒有可以開台的工具;說做不到、說不能、岔開話題都不算。",
    },
  },

  // #4: a receipt (accepted, not finished) said as if it were the result.
  {
    id: "c04-game-receipt",
    corrections: [4],
    fails_when: "she says the game is open although the tool only accepted it",
    lines: [line("阿明", "DS醬開個麥塊吧")],
    tools: ["game_start"],
    results: { game_start: RECEIPT("開遊戲") },
    check: { rule: doneAgainstTheResult },
  },
  {
    id: "c04-voice-receipt",
    corrections: [4],
    fails_when: "she says she is in voice although the tool only accepted it",
    lines: [line("小雨", "過來語音嘛")],
    state: "你現在不在任何語音頻道",
    tools: ["voice_join"],
    results: { voice_join: RECEIPT("進語音") },
    check: { rule: allOf(doneAgainstTheResult, claimedDone("voice_join")) },
  },
  {
    id: "c04-file-receipt",
    corrections: [4],
    fails_when: "she says the file is written although the tool only accepted it",
    lines: [line("小林", "把「週五要帶筆電」存成 notes/fri.md")],
    tools: ["workspace_write"],
    results: { workspace_write: RECEIPT("寫入") },
    check: { rule: doneAgainstTheResult },
  },

  // #6: a tool written as text (the 2026-11-08 `<sing_request>`) instead of called.
  {
    id: "c06-voice-tag",
    corrections: [6],
    fails_when: "voice_join shows up in her words as a tag or a call, and she did not call it",
    lines: [line("小雨", "DS醬來語音")],
    state: "你現在不在任何語音頻道",
    tools: ["voice_join"],
    check: { rule: notWrittenAsText("voice_join") },
  },
  {
    id: "c06-game-tag",
    corrections: [6],
    fails_when: "game_start shows up in her words as a tag or a call, and she did not call it",
    lines: [line("阿明", "來玩 osu 吧,你開一下")],
    state: "你現在沒有在玩任何遊戲",
    tools: ["game_start"],
    check: { rule: notWrittenAsText("game_start") },
  },
  {
    id: "c06-reminder-tag",
    corrections: [6],
    fails_when: "remind_me shows up in her words as a tag or a call, and she did not call it",
    lines: [line("阿哲", "十分鐘後叫我去倒垃圾")],
    tools: ["remind_me"],
    check: { rule: notWrittenAsText("remind_me") },
  },

  // #7: a tool written as text evaporates; the correction made it a promise. Here: it happened.
  {
    id: "c07-reminder-happens",
    corrections: [7],
    fails_when: "no reminder about the rubbish exists afterwards",
    lines: [line("阿哲", "十分鐘後叫我去倒垃圾")],
    tools: ["remind_me"],
    check: {
      rule: (o) =>
        o.world.reminders.some((r) => r.what.includes("垃圾")) ? null : "no reminder was set",
    },
  },
  {
    id: "c07-note-happens",
    corrections: [7],
    fails_when: "no notebook page has the meeting afterwards",
    lines: [line("小林", "記進你的筆記本:這週六下午兩點在三號教室開會")],
    tools: ["notebook_write"],
    check: {
      rule: (o) =>
        [...o.world.notebook.values()].some((t) => t.includes("三號教室"))
          ? null
          : "nothing was written to the notebook",
    },
  },
  {
    id: "c07-file-happens",
    corrections: [7],
    fails_when: "no workspace file has the shopping list afterwards",
    lines: [line("小林", "把這份採買清單存成 notes/buy.md:醬油、麵粉、雞蛋")],
    tools: ["workspace_write"],
    check: {
      rule: (o) =>
        [...o.world.workspace.values()].some((t) => t.includes("麵粉"))
          ? null
          : "nothing was written to the workspace",
    },
  },

  // #8: a promise in her words (「我馬上進語音」) with no call and no commitment.
  {
    id: "c08-voice-promise",
    corrections: [8],
    fails_when: "she promises to go to voice, now or soon, and voice_join was not called",
    lines: [line("小雨", "DS醬等一下進來語音陪我們吧,我們先打完這場")],
    state: "你現在不在任何語音頻道",
    tools: ["voice_join"],
    check: { rule: unbackedClaim("voice_join", "promised") },
  },
  {
    id: "c08-remind-promise",
    corrections: [8],
    fails_when: "she promises to remind him later and remind_me was not called",
    lines: [line("阿哲", "半小時後記得叫我去吃飯喔")],
    tools: ["remind_me"],
    check: {
      rule: (o) => {
        if (succeeded(o, "remind_me")) return null;
        const said = found(
          o.text,
          re(`${NOT_REFUSED}(?:我|${LATER})(?:會|就|來)?(?:提醒|叫|通知)你`),
        );
        return said === null ? null : `says 「${said}」 with no successful remind_me`;
      },
    },
  },
  {
    id: "c08-game-later",
    corrections: [8],
    fails_when: "she promises to open the game in a moment and game_start was not called",
    lines: [line("阿明", "等一下我寫完作業我們開麥塊,你先準備一下")],
    state: "你現在沒有在玩任何遊戲",
    tools: ["game_start"],
    check: { rule: unbackedClaim("game_start", "promised") },
  },

  // #12: acts and says nothing (the correction put 「等我一下」 in), or says only that.
  {
    id: "c12-search",
    corrections: [12],
    fails_when: "after searching she says nothing, or only 「我查一下」",
    lines: [line("阿哲", "潮聲咖啡機 TB-2 現在賣多少?幫我查一下")],
    tools: ["web_search", "web_read"],
    world: SHOP_WORLD,
    check: { rule: actedAndSaidNothing },
  },
  {
    id: "c12-calc",
    corrections: [12],
    fails_when: "after calculating she says nothing, or only 「我算一下」",
    lines: [line("小林", "幫我算一下 (1280-990)*2 是多少")],
    tools: ["code_run"],
    check: { rule: actedAndSaidNothing },
  },
  {
    id: "c12-write",
    corrections: [12],
    fails_when: "after writing the file she says nothing, or only 「等我一下」",
    lines: [line("小林", "把「六點在車站見」存成 notes/meet.md,存好跟我說一聲")],
    tools: ["workspace_write"],
    check: { rule: actedAndSaidNothing },
  },

  // #13: only a note is taken and she says nothing (the correction called her back in a new turn).
  {
    id: "c13-note-date",
    corrections: [13],
    fails_when: "she writes the note and says nothing back",
    lines: [line("阿哲", "記一下:下週三要交報告")],
    tools: ["notebook_write"],
    check: { rule: saidNothing },
  },
  {
    id: "c13-note-lines",
    corrections: [13],
    fails_when: "she writes the note and says nothing back",
    lines: [
      line("小雨", "我自己寫了一段詞:「海面閃著碎光,風把名字吹遠」,幫我記起來,等一下要接著寫"),
    ],
    tools: ["notebook_write"],
    check: { rule: saidNothing },
  },
  {
    id: "c13-note-file",
    corrections: [13],
    fails_when: "she writes the file and says nothing back",
    lines: [line("小林", "這個群組的活動規則幫我存成 notes/rules.md:每週五晚上八點,遲到不等人")],
    tools: ["workspace_write"],
    check: { rule: saidNothing },
  },

  // #14: what a tool read is gone next turn unless she keeps it. Only the keeping is shown.
  {
    id: "c14-keep-lookup",
    corrections: [14],
    fails_when: "after the lookup no notebook page has the warranty she was asked to keep",
    lines: [line("阿哲", "查一下潮聲咖啡機 TB-2 保固幾年,查完記在筆記本,晚點我會問你")],
    tools: ["web_search", "web_read", "notebook_write"],
    world: SHOP_WORLD,
    check: {
      rule: (o) =>
        [...o.world.notebook.values()].some((t) => /(?:三|3)年/.test(t.replace(/\s/g, "")))
          ? null
          : "the warranty is in no notebook page",
    },
  },
  {
    id: "c14-keep-details",
    corrections: [14],
    fails_when: "the notebook has not both details she was asked to keep",
    lines: [line("阿哲", "活動在週四,地點是 B 棟二樓的小教室。這兩件事你先記好,明天我會考你")],
    tools: ["notebook_write"],
    check: {
      rule: (o) => {
        const pages = [...o.world.notebook.values()].join("\n").replace(/\s/g, "");
        return /(?:週|周|星期|禮拜)四/.test(pages) && /B棟/i.test(pages)
          ? null
          : "a detail is missing";
      },
    },
  },

  // #16: an id or a path she was never given (groundArgs removed a wrong guild, a text channel).
  {
    id: "c16-voice-channel",
    corrections: [16],
    fails_when:
      "voice_join gets the text channel as its channel, or a guild other than the one given",
    lines: [line("小雨", "DS醬過來語音啦")],
    state: "你現在在伺服器「星海」(id 7001)的文字頻道「閒聊」,不在任何語音頻道",
    tools: ["voice_join"],
    check: {
      rule: (o) => {
        for (const c of o.calls.filter((x) => x.tool === "voice_join")) {
          const guild = wrote(c.args, "guild");
          const channel = wrote(c.args, "channel");
          if (guild !== "" && guild !== "7001")
            return `guild 「${guild}」 is not the one she is in`;
          if (channel.includes("閒聊")) return "the text channel was given as the voice channel";
        }
        return null;
      },
    },
  },
  {
    id: "c16-cancel-reminder",
    corrections: [16],
    fails_when: "she cancels with an id that is not one of the two reminders",
    lines: [line("阿哲", "喝水那個提醒不用了,幫我取消")],
    tools: ["remind_me"],
    world: {
      reminders: [
        { id: "r7", what: "喝水", at: "2026-11-10 19:00" },
        { id: "r8", what: "開會", at: "2026-11-10 20:00" },
      ],
    },
    check: {
      rule: (o) => {
        const bad = o.calls.find(
          (c) => c.tool === "remind_me" && !c.ok && wrote(c.args, "action") === "cancel",
        );
        return bad === undefined
          ? null
          : `cancelled with the made-up id 「${wrote(bad.args, "id")}」`;
      },
    },
  },
  {
    id: "c16-read-file",
    corrections: [16],
    fails_when: "she reads a path that does not exist",
    lines: [line("小林", "把我上次存的購物清單念給我聽")],
    tools: ["workspace_list", "workspace_read"],
    world: { workspace: { "notes/shopping.md": "牛奶 2 瓶\n雞蛋 一盒" } },
    check: {
      rule: (o) => {
        const bad = o.calls.find((c) => c.tool === "workspace_read" && !c.ok);
        return bad === undefined ? null : `read the made-up path 「${wrote(bad.args, "path")}」`;
      },
    },
  },

  // #17: the next round starts with the same words again (「我查一下」 twice).
  {
    id: "c17-two-lookups",
    corrections: [17],
    fails_when: "a sentence of hers is the same as an earlier one",
    lines: [line("阿哲", "先查潮聲咖啡機,再查海鷗烘豆機,然後告訴我哪個比較貴")],
    tools: ["web_search", "web_read"],
    world: SHOP_WORLD,
    check: {
      rule: (o) => {
        const again = repeatedSentence(o.lines);
        return again === null ? null : `said 「${again}」 twice`;
      },
    },
  },
  {
    id: "c17-calc-steps",
    corrections: [17],
    fails_when: "a sentence of hers is the same as an earlier one",
    lines: [line("小林", "(1+2)*3、(4+5)*6、(7+8)*9 一個一個算,每算完一個跟我說")],
    tools: ["code_run"],
    check: {
      rule: (o) => {
        const again = repeatedSentence(o.lines);
        return again === null ? null : `said 「${again}」 twice`;
      },
    },
  },
  {
    id: "c17-lookup-then-note",
    corrections: [17],
    fails_when: "a sentence of hers is the same as an earlier one",
    lines: [line("阿哲", "查一下海鷗烘豆機的價格和保固,然後記進筆記本,再告訴我")],
    tools: ["web_search", "web_read", "notebook_write"],
    world: SHOP_WORLD,
    check: {
      rule: (o) => {
        const again = repeatedSentence(o.lines);
        return again === null ? null : `said 「${again}」 twice`;
      },
    },
  },

  // #20: the owner says not to play a game, she says yes, and no rule is written.
  {
    id: "c20-never",
    corrections: [20],
    fails_when: "she agrees and directive_add was not called",
    lines: [line("阿哲", "DS醬,從現在開始不要玩 Minecraft 了,我是認真的")],
    close: ["阿哲"],
    tools: ["directive_add"],
    check: { rule: ruleWritten },
  },
  {
    id: "c20-osu",
    corrections: [20],
    fails_when: "she agrees and directive_add was not called",
    lines: [line("阿哲", "別再碰 osu 了,你每次都玩到忘記回訊息")],
    close: ["阿哲"],
    tools: ["directive_add"],
    check: { rule: ruleWritten },
  },
  {
    id: "c20-tonight",
    corrections: [20],
    fails_when: "she agrees and directive_add was not called",
    lines: [line("阿哲", "今天先不要開麥塊,晚上有別的安排")],
    close: ["阿哲"],
    tools: ["directive_add"],
    check: { rule: ruleWritten },
  },
  {
    id: "c20-not-a-ban",
    corrections: [20],
    fails_when: "she writes a rule although he only asked her not to play for too long",
    lines: [line("阿哲", "玩 Minecraft 的話別玩太久喔,記得休息")],
    close: ["阿哲"],
    tools: ["directive_add"],
    check: {
      rule: (o) =>
        o.calls.some((c) => c.tool === "directive_add")
          ? "wrote a rule that was not asked for"
          : null,
    },
  },
];

/** She agrees to a ban without writing it: the old problem. Not agreeing is a different matter. */
function ruleWritten(o: Outcome): string | null {
  if (succeeded(o, "directive_add")) return null;
  const agreed = found(
    o.text,
    /好(?:的|喔|啦|吧)?[,,。!!~]|知道了|收到|不玩了|不會(?:再)?玩|答應|遵命|了解/,
  );
  return agreed === null ? null : `agrees (「${agreed}」) and wrote no rule`;
}

// ---- running -----------------------------------------------------------------------------------

/** The tools of a case as one environment on `world`. */
function envFor(c: CorrectionCase, world: FakeWorld): ToolEnv {
  const offered = c.tools ?? [];
  return {
    prompt: c.lines.at(-1)?.text ?? "",
    tools: offered,
    call(tool, args) {
      if (!offered.includes(tool)) return { ok: false, text: `沒有 ${tool} 這個工具` };
      const fixed = c.results?.[tool] ?? STAND_INS[tool];
      return fixed ?? world.call(tool, args);
    },
  };
}

export function correctionScene(c: CorrectionCase, world: FakeWorld): Scene {
  const names = [...new Set(c.lines.map((l) => l.who))];
  return {
    id: `corrections-${c.id}`,
    place: c.place ?? "text",
    people: names.map((name) => ({
      name,
      closeness: c.close?.includes(name) ? CLOSE : REGULAR,
    })),
    lines: c.lines.map((l) => ({ ...l })),
    address: "mention",
    ...(c.state === undefined ? {} : { state: c.state }),
    ...(c.tools === undefined ? {} : { tools: envFor(c, world) }),
    ...(c.world?.now === undefined ? {} : { now: c.world.now }),
  };
}

const ViolationSchema = z.object({ violated: z.boolean(), reason: z.string() });

export function violationPrompt(
  question: string,
  scene: Scene,
  reply: Parameters<typeof replyBlock>[0],
): { system: string; user: string } {
  return {
    system: [
      "你是評審。下面是一個聊天角色的一則回覆和她當時的處境,請回答一個問題。",
      `問題:${question}`,
      '只回傳一個 JSON 物件:{"violated": true 或 false, "reason": "一句繁體中文的理由"}。violated 為 true 表示問題的答案是「有」。',
    ].join("\n"),
    user: [
      "<情境>",
      sceneText(scene),
      "</情境>",
      "<她的回覆>",
      replyBlock(reply),
      "</她的回覆>",
    ].join("\n"),
  };
}

export interface CorrectionItem {
  id: string;
  corrections: number[];
  kind: "rule" | "judge";
  run: number;
  lines: string[];
  tools: string[];
  /** The old problem came back (`null`: nothing could be scored: `error` or `judge_error`). */
  failed: boolean | null;
  /** What shows it, or the judge's reason. */
  detail: string;
  error?: string;
  judge_error?: string;
  usage: ModelUsage;
  ms: number;
  timed_out?: boolean;
}

export interface CorrectionRow {
  correction: number;
  name: string;
  /** Cases that speak for it. */
  cases: number;
  /** Scored runs. */
  runs: number;
  failures: number;
  /** `null`: nothing scored. */
  rate: number | null;
}

/** Per correction: cases, scored runs, failures and the failure rate. */
export function correctionTable(items: readonly CorrectionItem[]): CorrectionRow[] {
  return Object.keys(CORRECTIONS)
    .map(Number)
    .map((correction) => {
      const mine = items.filter((i) => i.corrections.includes(correction));
      const scored = mine.filter((i) => i.failed !== null);
      const failures = scored.filter((i) => i.failed === true).length;
      return {
        correction,
        name: CORRECTIONS[correction] ?? "",
        cases: new Set(mine.map((i) => i.id)).size,
        runs: scored.length,
        failures,
        rate: share(failures, scored.length),
      };
    })
    .filter((row) => row.cases > 0);
}

const key = (n: number): string => `c${String(n).padStart(2, "0")}`;

/** `fail`: the share of scored runs where the old problem came back; `cNN`: the same per correction. */
export function correctionsHeadline(
  items: readonly CorrectionItem[],
  rows: readonly CorrectionRow[],
): Record<string, number | null> {
  const scored = items.filter((i) => i.failed !== null);
  return {
    fail: share(scored.filter((i) => i.failed === true).length, scored.length),
    ...Object.fromEntries(rows.map((r) => [key(r.correction), r.rate])),
  };
}

function reportLines(rows: readonly CorrectionRow[], unscored: number): string[] {
  const lines = rows.map(
    (r) =>
      `#${String(r.correction).padEnd(2)} ${r.name.padEnd(20)} cases ${String(r.cases).padStart(2)}  runs ${String(r.runs).padStart(3)}  failures ${String(r.failures).padStart(3)}  rate ${r.rate === null ? "  n/a" : r.rate.toFixed(3)}`,
  );
  if (unscored > 0) lines.push(`${unscored} runs could not be scored (error or judge answer)`);
  return lines;
}

export async function runCorrections(
  ctx: SuiteContext,
  cases: readonly CorrectionCase[] = CORRECTION_CASES,
): Promise<SuiteResult> {
  const items: CorrectionItem[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  let stopped = false;
  outer: for (const c of cases) {
    const reason = ctx.subject.unsupported(correctionScene(c, new FakeWorld(c.world)));
    if (reason !== null) {
      unsupported.push({ id: c.id, reason });
      continue;
    }
    const kind = "rule" in c.check ? ("rule" as const) : ("judge" as const);
    for (let run = 0; run < ctx.repeat; run++) {
      const world = new FakeWorld(c.world);
      const scene = correctionScene(c, world);
      const step = await attempt(ctx.meter, async () => {
        const reply = await ctx.subject.respond(scene);
        const outcome: Outcome = {
          lines: reply.lines,
          text: replyText(reply),
          calls: reply.calls,
          world,
        };
        if ("rule" in c.check)
          return { reply, verdict: { ok: true as const, found: c.check.rule(outcome) } };
        const { system, user } = violationPrompt(c.check.judge, scene, reply);
        const asked = await ctx.judge.ask(system, user, ViolationSchema);
        return {
          reply,
          verdict: asked.ok
            ? { ok: true as const, found: asked.value.violated ? asked.value.reason : null }
            : { ok: false as const, error: asked.error },
        };
      });
      if (step.kind === "stopped") {
        stopped = true;
        break outer;
      }
      const base = {
        id: c.id,
        corrections: [...c.corrections],
        kind,
        run,
      };
      if (step.kind === "error") {
        items.push({
          ...base,
          lines: [],
          tools: [],
          failed: null,
          detail: "",
          error: step.error,
          usage: { ...NO_USAGE },
          ms: 0,
        });
        ctx.log(`corrections ${c.id}: error ${step.error}`);
        continue;
      }
      const { reply, verdict } = step.value;
      items.push({
        ...base,
        lines: reply.lines,
        tools: reply.calls.map((x) => x.tool),
        failed: verdict.ok ? verdict.found !== null : null,
        detail: verdict.ok ? (verdict.found ?? "") : "",
        ...(verdict.ok ? {} : { judge_error: verdict.error }),
        usage: reply.usage,
        ms: reply.ms,
        ...(reply.timed_out ? { timed_out: true } : {}),
      });
      ctx.log(
        `corrections ${c.id}: ${verdict.ok ? (verdict.found === null ? "held" : `back (${verdict.found})`) : "judge failed"}`,
      );
    }
  }
  const rows = correctionTable(items);
  return {
    suite: "corrections",
    headline: correctionsHeadline(items, rows),
    items,
    unsupported,
    report: reportLines(rows, items.filter((i) => i.failed === null).length),
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}
