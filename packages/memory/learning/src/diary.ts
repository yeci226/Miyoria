// Her diary: after the daily reflection she writes a short entry about her day in her own voice
// and posts it to `[modules.reflect.diary] channel` (off while it is empty).
//
// The entry is written from what the reflection already put in her words (its summary, what she
// felt, what she learned), never from raw chat. Those can come from DMs and private talk, so the
// rules forbid naming what was said in private and the post goes through the platform sink, which
// runs moderation like every other line of hers; the owner chooses the channel.
//
// One diary, in one channel the owner chose (phase 6, owner decision Q2). The reflection's summary
// is of every place she was in; once the day had talk in a server other than the diary channel's,
// the entry is not written from that summary but from the recaps of the diary server's own
// channels (`ConversationStates`), with her feelings, lessons and goals: nothing said in one
// server is posted in another.
//
// With a channel it is also something she does, not only something that follows the reflection:
// the capability `diary.write` (`diaryCapability`) is the "diary" row of her activity table
// (packages/heart/mind/src/life/activities.ts), so her mind can suggest it in the evening and her life
// log counts it. It writes from the newest daily reflection not written yet, and the write after
// the reflection goes through the same capability, so either way it is one entry per reflection
// and the owner's rules can stop it.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/gate/actions";
import { type LlmRouter, systemMessage, userMessage, withLlmTag } from "@miyoria/llm/llm";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type ContextKey,
  type ConversationState,
  characterCore,
  type PlatformSinks,
  type ProfileId,
  type ReflectionRun,
} from "@miyoria/types";
import { z } from "zod";
import type { DiaryConfig } from "./config.js";
import { parseContextString } from "./reflect.js";

const log = getLogger("learning.diary");

/** How long writing may take. */
const WRITE_TIMEOUT_MS = 60_000;

/** The rules of an entry. */
export function diaryRules(maxChars: number): string {
  return `你要寫今天的日記,會公開貼在大家看得到的頻道。
- 用第一人稱、你平常說話的口吻,像真的在寫日記,${maxChars} 字以內,可以分兩三段。
- 寫今天發生的事、你的心情、想記住的小事;可以提到大家知道的名字。
- 私訊裡說的事、別人的秘密或隱私、任何你不確定能公開的事都不要寫。
- 不寫數字分數,不提「反省」「系統」「模型」「提示詞」這類字眼,不要寫標題或日期。
- 只回日記本文。`;
}

/** How far back the day's talk goes (as the daily reflection gathers it). */
const DAY_TALK_MS = 1.5 * 24 * 3600 * 1000;
/** A recap is cut to this many characters in the material. */
const RECAP_CHARS = 300;

/**
 * What the reflection said, as the entry's material. With `here` (the recaps of the diary
 * server's channels, when the day had talk in other servers too) the summary of every place is
 * left out and those recaps stand in its place.
 */
export function diaryMaterial(run: ReflectionRun, here: readonly string[] | null = null): string {
  const lines =
    here === null
      ? [`今天的回顧:${run.summary.trim()}`]
      : here.length === 0
        ? []
        : [
            "今天在這裡聊的事:",
            ...here.map((r) => `- ${[...r.trim()].slice(0, RECAP_CHARS).join("")}`),
          ];
  if (run.feelings.length > 0) lines.push(`心情:${run.feelings.join("、")}`);
  if (run.lessons.length > 0) lines.push(`學到的事:${run.lessons.join("、")}`);
  if (run.goals.length > 0) lines.push(`接下來想做的:${run.goals.join("、")}`);
  return lines.join("\n");
}

/** The entry cut to `maxChars` (at a sentence end when there is one in the last third). */
export function fitEntry(text: string, maxChars: number): string {
  const clean = text.replace(/^["「『]+|["」』]+$/g, "").trim();
  const chars = [...clean];
  if (chars.length <= maxChars) return clean;
  const cut = chars.slice(0, maxChars).join("");
  const end = Math.max(...["。", "!", "?", "!", "?", "~", "…"].map((p) => cut.lastIndexOf(p)));
  return end >= Math.floor(cut.length * 0.66) ? cut.slice(0, end + 1) : `${cut}…`;
}

export interface DiaryDeps {
  router: () => LlmRouter | undefined;
  sinks: () => PlatformSinks | undefined;
  /** Her persona prompt (its character core is used). */
  persona: () => string;
  name: string;
  /** The settings store (the day of the last entry survives a restart); `null`: memory only. */
  store?: SettingsStore | null;
  profile?: ProfileId;
  /** The conversation states of every place (`ConversationStatesKey`); unset: none known. */
  conversations?: () => readonly ConversationState[];
}

/**
 * The recaps of the diary server's channels, when the day had talk in another server too;
 * `null` when it had not (the reflection's summary is then all about the diary's server, and DMs,
 * which the rules keep out).
 */
export function diaryRecaps(
  where: ContextKey,
  states: readonly ConversationState[],
  at: number,
): string[] | null {
  const day = states.filter(
    (c) =>
      c.context.kind !== "dm" &&
      c.context.scope !== null &&
      at - Date.parse(c.updated_at) < DAY_TALK_MS,
  );
  const here = (c: ConversationState) =>
    c.context.platform === where.platform && c.context.scope === where.scope;
  if (day.every(here)) return null;
  return day
    .filter(here)
    .map((c) => c.recap)
    .filter((r) => r.trim() !== "");
}

/** Settings key of the day of her last entry. */
export const DIARY_STATE_KEY = "reflect:diary:last_day";

/** Whether `run` is a daily reflection an entry can be written from. */
function writable(run: ReflectionRun): boolean {
  return run.kind === "daily" && run.error === null && run.summary.trim() !== "";
}

/** Writes and posts the entry of a daily reflection. */
export class Diary {
  #lastDay: string | null = null;

  constructor(
    private readonly config: DiaryConfig,
    private readonly d: DiaryDeps,
  ) {}

  /** Reads the day of the last entry back (a restart must not post the same day twice). */
  async load(): Promise<void> {
    const store = this.d.store;
    if (!store || this.d.profile === undefined) return;
    const day = await store.get(this.d.profile, DIARY_STATE_KEY);
    if (typeof day === "string") this.#lastDay = day;
  }

  /** The diary server's recaps when the day had talk elsewhere too (`diaryRecaps`). */
  #recaps(where: ContextKey, run: ReflectionRun): string[] | null {
    try {
      return diaryRecaps(where, this.d.conversations?.() ?? [], Date.parse(run.at));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot read the day's talk for her diary");
      // Unknown: only what is not about any place.
      return [];
    }
  }

  /** The channel entries go to, or `null` when the diary is off. */
  where(): ContextKey | null {
    const raw = this.config.channel.trim();
    return raw === "" ? null : parseContextString(raw);
  }

  /**
   * The newest daily reflection she has not written about yet (`runs` newest first, as
   * `Reflector.runs` gives them), or `null`. Only the newest counts: an older day she skipped
   * stays skipped.
   */
  pending(runs: readonly ReflectionRun[]): ReflectionRun | null {
    const run = runs.find(writable);
    if (run === undefined || run.at.slice(0, 10) === this.#lastDay) return null;
    return run;
  }

  /** Writes and posts the entry for `run`; returns the text posted, or `null`. */
  async write(run: ReflectionRun, signal?: AbortSignal): Promise<string | null> {
    const where = this.where();
    if (where === null || !writable(run)) return null;
    const day = run.at.slice(0, 10);
    if (this.#lastDay === day) return null;
    const router = this.d.router();
    const sink = this.d.sinks()?.get(where.platform);
    if (!router || !sink) return null;
    const who = characterCore(this.d.persona()) || `你是${this.d.name}。`;
    try {
      const timeout = AbortSignal.timeout(WRITE_TIMEOUT_MS);
      const response = await withLlmTag({ module: "learning", label: "diary" }, () =>
        router.complete(
          "chat",
          {
            messages: [
              systemMessage(`${who}\n\n${diaryRules(this.config.max_chars)}`),
              userMessage(diaryMaterial(run, this.#recaps(where, run))),
            ],
            reasoning_purpose: "diary",
            max_tokens: 800,
          },
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        ),
      );
      const entry = fitEntry(response.text, this.config.max_chars);
      if (entry === "") return null;
      const text = this.config.heading ? `${this.config.heading}\n${entry}` : entry;
      // Unprompted: posted without a notification (`proactive`, see the Discord sink).
      const message = { text, reply_to: null, proactive: true };
      const sent = await sink.send(where, message, signal);
      if (sent.blocked) log.info({ blocked: sent.blocked }, "moderation changed her diary entry");
      this.#lastDay = day;
      const store = this.d.store;
      if (store && this.d.profile !== undefined) {
        await store.set(this.d.profile, DIARY_STATE_KEY, day).catch((error: unknown) => {
          log.warn({ error: errorMessage(error) }, "cannot keep the day of her diary entry");
        });
      }
      return text;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "she could not write her diary");
      return null;
    }
  }
}

/** The capability id the "diary" row of her activity table waits for. */
export const DIARY_CAPABILITY = "diary.write";
export const DIARY_TOOL = "diary_write";

const DiaryArgs = z.object({}).loose();
type DiaryArgs = z.output<typeof DiaryArgs>;

/**
 * `diary.write`: writes and posts the entry of the newest daily reflection not written yet.
 * Refused before the gate allows it (`check`) when there is none, so a refused try is not counted
 * as written in her day.
 */
export function diaryCapability(
  diary: Diary,
  runs: () => readonly ReflectionRun[],
): Capability<DiaryArgs> {
  return defineCapability<DiaryArgs>({
    name: DIARY_CAPABILITY,
    summary: "寫今天的日記,貼到日記頻道",
    risk: "low",
    args: DiaryArgs,
    permission: null,
    tool: {
      name: DIARY_TOOL,
      meta: { effect: "say", speed: "instant", group: "diary" },
      description:
        "寫一篇日記貼到日記頻道,用你每天回顧時想過的事寫(一次回顧一篇;還沒回顧過的就不能寫)。" +
        "會公開給大家看,私訊裡的事不會寫進去。",
      properties: {},
    },
    check: () =>
      diary.where() === null
        ? "日記頻道沒有設定"
        : diary.pending(runs()) === null
          ? "最近一次回顧的日記已經寫過了,或還沒有回顧可以寫"
          : null,
    async execute(_args, ctx) {
      const run = diary.pending(runs());
      if (run === null) throw new CapabilityError("nothing to write: the last reflection has one");
      const text = await diary.write(run, ctx.signal);
      if (text === null) throw new CapabilityError("the diary entry could not be written");
      return { text: "日記寫好貼出去了", data: { day: run.at.slice(0, 10) } };
    },
  });
}
