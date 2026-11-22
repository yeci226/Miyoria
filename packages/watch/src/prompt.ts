import {
  type ContextKey,
  contextKeyString,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  safeName,
  sameAccount,
  type VoiceMember,
} from "@miyoria/types";
import type { WatchView } from "./watcher.js";

export const PROMPT_KEY = "watch";
const ORDER = 47;
const NOTES_SHOWN = 5;
const LINES_SHOWN = 6;
const LINE_CHARS = 120;
const BODY_CHARS = 2000;

const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

export interface WatchPromptDeps {
  view(): WatchView | null;
  /** Who streams in the voice channel `context`, as far as they let her watch. */
  streams(context: ContextKey): Promise<VoiceMember[]>;
  now(): number;
}

function watching(view: WatchView, now: number): string[] {
  const minutes = Math.max(0, Math.floor((now - view.startedAt) / 60_000));
  const lines = [`你正在看 ${safeName(view.target.name)} 的直播,看了 ${minutes} 分鐘。`];
  const age =
    view.lastLookAt === null
      ? "你還沒看過畫面。"
      : `最近一次看畫面是 ${Math.max(0, Math.round((now - view.lastLookAt) / 1000))} 秒前,下面的筆記可能已經過時。`;
  lines.push(`${age}有人問直播現在的畫面,先用 watch_look 看一眼再回答,不要只靠筆記。`);
  const notes = view.notes.slice(-NOTES_SHOWN);
  if (notes.length > 0) lines.push("最近看到:", ...notes.map((n) => `- ${n}`));
  const said = view.transcript.slice(-LINES_SHOWN);
  if (said.length > 0) lines.push("最近的台詞:", ...said.map((l) => `- ${cut(l, LINE_CHARS)}`));
  return lines;
}

/**
 * What she watches and who she could. Only in the voice context of the stream: notes and lines
 * stay out of every other chat. Like every section, its body is wrapped in a data block by
 * whoever renders it, with the delimiters escaped, so it is not wrapped here.
 */
export class WatchPrompt implements PromptContributor {
  readonly key = PROMPT_KEY;
  readonly #deps: WatchPromptDeps;

  constructor(deps: WatchPromptDeps) {
    this.#deps = deps;
  }

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const { context } = request;
    if (context.kind !== "voice") return [];
    const view = this.#deps.view();
    const here =
      view !== null && contextKeyString(view.target.context) === contextKeyString(context)
        ? view
        : null;
    const others = (await this.#deps.streams(context)).filter(
      (m) => here === null || !sameAccount(m.account, here.target.account),
    );
    const lines = here === null ? [] : watching(here, this.#deps.now());
    if (others.length > 0) {
      const names = others.map((m) => `${safeName(m.display_name)}(${m.account.id})`);
      lines.push(`這個頻道裡在開播、可以看的人:${names.join("、")}`);
      // Asked to watch, a model may answer "ok" and never call the tool (2026-11-22).
      if (here === null) {
        lines.push(
          "你現在沒有在看任何人的直播。要看就呼叫 watch_start;只回「好」不會開始看,畫面也不會送到你這裡。",
        );
      }
    }
    if (lines.length === 0) return [];
    return [
      {
        key: PROMPT_KEY,
        title: here === null ? "語音頻道裡的直播" : "你正在看的直播",
        body: cut(lines.join("\n"), BODY_CHARS),
        order: ORDER,
      },
    ];
  }
}
