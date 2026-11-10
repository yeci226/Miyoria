// Prompt section `party`: the game going on where she talks, as far as her role may see it (no
// open answer, no turtle-soup bottom), with how to host it. Without a game, when two or more
// people are in her voice channel, one line reminds her that she can suggest one (v4-plan §7.6);
// nothing starts unless she calls `party_start`.

import type { PromptContributor, PromptRequest, PromptSection } from "@miyoria/types";
import type { Table } from "./table.js";

export const PROMPT_KEY = "party";
const ORDER = 45;
/** People in voice before she is reminded that games exist. */
const INVITE_LISTENERS = 2;

export class PartyPrompt implements PromptContributor {
  readonly key = PROMPT_KEY;

  constructor(private readonly table: Table) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    // Only in the voice channel itself or its text chat: a turn in another channel of the server
    // is not about the game.
    const session = this.table.session(request.context);
    if (session === null) {
      const voice = request.context;
      if (voice.kind !== "voice" || this.table.listeners(voice) < INVITE_LISTENERS) return [];
      return [
        {
          key: PROMPT_KEY,
          title: "派對遊戲",
          body: "語音裡人夠多,冷場時你可以提議一起玩(party_start):海龜湯、猜歌、接龍、問答。要不要玩你自己決定。",
          order: ORDER,
        },
      ];
    }
    const game = session.game;
    const lines = [
      `你在主持「${game.title}」。${game.rules}`,
      ...game.view(),
      ...(game.scored ? [`分數:${session.standings()}`] : []),
      "有人說「不玩了」遊戲會自己結束。答對、時間到這些結果程式會告訴你,沒收到之前不要自己宣布。",
    ];
    return [{ key: PROMPT_KEY, title: "派對遊戲", body: lines.join("\n"), order: ORDER }];
  }
}
