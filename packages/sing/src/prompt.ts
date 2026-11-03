// Prompt section `sing`: her set list, so she knows what is preparing, ready and playing. Song
// titles come from YouTube / the requester: `songLabel` makes them short inert lines, and the agent
// puts every section in a data block.

import type { PromptContributor, PromptSection } from "@miyoria/types";
import { safeName } from "@miyoria/types";
import { songLabel } from "./setlist.js";
import type { Singer } from "./singer.js";

export const PROMPT_KEY = "sing";
const MAX_LINES = 6;

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
        `要開始唱:#${playing.no} ${songLabel(playing)}(${who(playing.requester_name)} 點的)。你說完這句就開始。`,
      );
    } else if (playing) {
      lines.push(
        `正在唱:#${playing.no} ${songLabel(playing)}(${who(playing.requester_name)} 點的)。唱完之前你在語音說的話不會播出;要停用 sing_stop。`,
      );
      lines.push(
        "唱歌時有人再點歌,照樣用 sing_request 先準備,會排在這首後面;只給連結也可以,不用問歌名。",
      );
    }
    for (const e of ready.slice(0, MAX_LINES)) {
      const when = e.forced ? "你有空就會自動開始" : "想唱就用 sing_start";
      lines.push(`準備好了:#${e.no} ${songLabel(e)}(${who(e.requester_name)} 點的;${when})`);
    }
    for (const e of preparing.slice(0, MAX_LINES)) {
      lines.push(
        `準備中:#${e.no} ${songLabel(e)}(${who(e.requester_name)} 點的,${Math.round(e.progress * 100)}%)`,
      );
    }
    if (!this.singer.voiceContext()) lines.push("你現在不在語音頻道;要唱歌得先進語音。");
    return [{ key: PROMPT_KEY, title: "你的歌單", body: lines.join("\n"), order: 46 }];
  }
}
