// Prompt section `sing`: her set list, so she knows what is preparing, ready and playing. Song
// titles come from YouTube / the requester: `songLabel` makes them short inert lines, and the agent
// puts every section in a data block.

import type { PromptContributor, PromptSection } from "@miyoria/types";
import { safeName } from "@miyoria/types";
import { dedicationNote, type SongEntry, songLabel } from "./setlist.js";
import type { Singer } from "./singer.js";

export const PROMPT_KEY = "sing";
const MAX_LINES = 6;
/** Songs named in the queue line, at most. */
const MAX_QUEUE = 8;

/**
 * The requested songs in the order they were asked for, one line: who asked for which, the
 * place of each and whose turn is next. She asked for it (2026-11-11) so she would not have to
 * work the order out from the lists above. `null` when nobody is waiting.
 */
export function queueLine(open: readonly SongEntry[]): string | null {
  const asked = open.filter((e) => e.practice !== true);
  const playing = asked.find((e) => e.state === "playing") ?? null;
  const waiting = asked.filter((e) => e.state !== "playing");
  if (waiting.length === 0) return null;
  const who = (e: SongEntry) => safeName(e.requester_name, 24);
  const state = (e: SongEntry) =>
    e.state === "ready" ? "準備好了" : `準備中 ${Math.round(e.progress * 100)}%`;
  const parts = waiting
    .slice(0, MAX_QUEUE)
    .map((e, i) => `${i === 0 ? "下一首" : `第 ${i + 1} 首`} #${e.no}(${who(e)},${state(e)})`);
  if (waiting.length > MAX_QUEUE) parts.push(`還有 ${waiting.length - MAX_QUEUE} 首`);
  const head = playing === null ? "" : `正在唱 #${playing.no}(${who(playing)})→ `;
  return `點歌佇列(照點歌順序):${head}${parts.join(" → ")}`;
}

export class SingPrompt implements PromptContributor {
  readonly key = PROMPT_KEY;

  constructor(private readonly singer: Singer) {}

  async contribute(): Promise<PromptSection[]> {
    const list = this.singer.list;
    const playing = list.playing();
    const ready = list.ready();
    const preparing = list.preparing();
    if (!playing && ready.length === 0 && preparing.length === 0) return [];
    const who = (name: string) => safeName(name, 24);
    const lines: string[] = [];
    if (playing && this.singer.starting()) {
      lines.push(
        `要開始唱:#${playing.no} ${songLabel(playing)}(${who(playing.requester_name)} 點的${dedicationNote(playing)})。你說完這句就開始。`,
      );
    } else if (playing) {
      lines.push(
        `正在唱:#${playing.no} ${songLabel(playing)}(${who(playing.requester_name)} 點的${dedicationNote(playing)})。唱完之前你在語音說的話不會播出;要停用 sing_stop。`,
      );
      lines.push(
        "唱歌時有人再點歌也能用 sing_request 準備,新歌會排在這首後面;只有連結也可以,不需要歌名。文字頻道照常回,收食物、查魚幣、簽到這些工具照常用,不用等唱完。",
      );
    }
    for (const e of ready.slice(0, MAX_LINES)) {
      const when = e.forced ? "你有空就會自動開始" : "想唱就用 sing_start";
      lines.push(
        `準備好了:#${e.no} ${songLabel(e)}(${who(e.requester_name)} 點的${dedicationNote(e)};${when})`,
      );
    }
    for (const e of preparing.slice(0, MAX_LINES)) {
      lines.push(
        `準備中:#${e.no} ${songLabel(e)}(${who(e.requester_name)} 點的,${Math.round(e.progress * 100)}%)`,
      );
    }
    const order = queueLine(list.open());
    if (order !== null) lines.push(order);
    if (!this.singer.voiceContext()) lines.push("你現在不在語音頻道;要唱歌得先進語音。");
    return [{ key: PROMPT_KEY, title: "你的歌單", body: lines.join("\n"), order: 46 }];
  }
}
