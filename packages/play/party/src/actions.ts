// Capabilities of the `party` module, behind the gate like everything she does. She is the host:
// starting, running and ending a game are her decisions, made as tool calls of the main line. Anyone
// may ask her to start one (the tool call then carries that person as the requester, and the node
// `permissions.start` gates it); she may also propose one herself.
//
// * `party.start` (tool `party_start`): a game in the voice channel she is in, or turtle soup in
//   the text channel the request came from.
// * `party.host` (tool `party_host`): next round, a hint, her ruling on a near miss, the end.
// * `party.play` (tool `party_play`): her own move (a guess).
// * `party.ask` (tool `party_ask`): turtle soup, a question for the referee.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/gate/actions";
import type { ContextKey, Principal } from "@miyoria/types";
import { z } from "zod";
import type { PartyPermissions } from "./config.js";
import { GAME_IDS, GAME_TITLES, GAMES_AVAILABLE, type GameId, isGameId } from "./game.js";
import type { Session, Table } from "./table.js";

// `game` is a plain string so a game that is gone (quiz, chains) is refused with a sentence
// instead of a schema error.
const StartArgs = z.object({
  game: z.string().trim().min(1).max(32),
  rounds: z.number().int().min(1).max(30).nullish(),
  where: z.enum(["voice", "here"]).nullish(),
});
const HOST_ACTIONS = ["next", "hint", "accept", "reject", "end"] as const;
const HostArgs = z.object({
  action: z.enum(HOST_ACTIONS),
  player: z.string().trim().max(64).nullish(),
});
const PlayArgs = z.object({ text: z.string().trim().min(1).max(200) });
const AskArgs = z.object({
  question: z.string().trim().min(1).max(300),
  player: z.string().trim().max(64).nullish(),
});
type StartArgs = z.output<typeof StartArgs>;
type HostArgs = z.output<typeof HostArgs>;
type PlayArgs = z.output<typeof PlayArgs>;
type AskArgs = z.output<typeof AskArgs>;

/**
 * The game a call is about: the one in the channel it came from (a voice channel, a text channel
 * playing turtle soup, or the text chat of a voice channel), else the one in the voice channel she
 * is in on that server.
 */
export function sessionOf(table: Table, p: Principal): Session | null {
  const c = p.context;
  if (c === null) return null;
  const here = table.session(c);
  if (here !== null || c.kind === "voice") return here;
  const room = table.room(c.platform, c.scope);
  return room === null ? null : table.session(room);
}

/**
 * Where a start goes. Song guessing is voice only (the voice channel she is in on that server).
 * Turtle soup goes where the request came from: a text channel plays it as messages, the voice
 * channel (or its own text chat) as speech; `where: "voice"` from another text channel sends it
 * to the voice channel she is in. A string is the reason there is no place (said to whoever asked).
 */
export function startPlace(
  table: Table,
  p: Principal,
  game: GameId,
  where: "voice" | "here" | null,
): ContextKey | string {
  const c = p.context;
  if (c === null) return "這裡開不了派對遊戲。";
  if (c.kind === "voice") return c;
  const room = table.room(c.platform, c.scope);
  if (game === "song" || where === "voice") {
    return room ?? `你不在語音頻道,${game === "song" ? "猜歌" : "語音裡的海龜湯"}要在語音頻道玩。`;
  }
  if (c.scope === null) return "私訊裡不能開派對遊戲,要在伺服器的頻道或語音裡。";
  // The text chat of the voice channel she is in is part of that game, not a second one.
  if (room !== null && room.channel === c.channel && where === null) return room;
  return c;
}

function running(table: Table, p: Principal): Session {
  const session = sessionOf(table, p);
  if (session === null) throw new CapabilityError("現在沒有在玩派對遊戲。");
  return session;
}

export function partyCapabilities(table: Table, perms: PartyPermissions): Capability[] {
  const start = defineCapability<StartArgs>({
    name: "party.start",
    summary: "開一場派對遊戲(語音裡的猜歌或海龜湯,或文字頻道裡的海龜湯)",
    risk: "low",
    args: StartArgs,
    permission: perms.start,
    tool: {
      name: "party_start",
      meta: { effect: "act", speed: "long", group: "party" },
      description:
        "開一場派對遊戲,你當主持人。有人請你開(誰都可以請),或大家冷場時你自己想帶動氣氛時用;一次只能玩一個。" +
        "game:soup 海龜湯(你念湯面,大家問是非題,裁判判定;語音或文字頻道都能玩,在哪個頻道被請就開在哪個頻道)、" +
        "song 猜歌(放你唱過的歌的片段搶答,只有語音頻道)。" +
        "where:你在文字頻道被請、而你正在語音頻道時,要玩在語音就填 voice,玩在這個文字頻道就填 here(省略 = 這個頻道)。" +
        "開始後照回傳的說明開場。",
      properties: {
        game: { type: "string", enum: [...GAME_IDS], description: "哪個遊戲" },
        rounds: { type: "integer", description: "猜歌幾首(可省略)" },
        where: {
          type: "string",
          enum: ["voice", "here"],
          description: "海龜湯玩在哪裡(可省略)",
        },
      },
      required: ["game"],
    },
    check(args, p) {
      // A game that is gone passes: `execute` tells her which games there are.
      if (!isGameId(args.game)) return null;
      const place = startPlace(table, p, args.game, args.where ?? null);
      if (typeof place === "string") return place;
      const running = table.session(place);
      return running ? `這裡已經在玩「${running.game.title}」了,要換遊戲先結束它。` : null;
    },
    async execute(args, ctx) {
      if (!isGameId(args.game)) {
        throw new CapabilityError(`沒有「${args.game}」這個遊戲。${GAMES_AVAILABLE}`);
      }
      const place = startPlace(table, ctx.principal, args.game, args.where ?? null);
      if (typeof place === "string") throw new CapabilityError(place);
      const session = table.start(place, args.game, { rounds: args.rounds ?? null });
      // A command or the panel asked: nobody is mid-turn with her, so the opening reaches her as a
      // note she may react to (a person's request in chat comes back to her turn as the answer).
      const p = ctx.principal;
      if (p.kind === "command" || p.kind === "panel") {
        session.note("open", `有人請你開了「${session.game.title}」。${session.opening}`);
      }
      return {
        text: `「${session.game.title}」開始了。${session.opening}`,
        data: { game: args.game, session: session.id },
      };
    },
  });

  const host = defineCapability<HostArgs>({
    name: "party.host",
    summary: "主持派對遊戲(下一題、提示、判定、結束)",
    risk: "low",
    args: HostArgs,
    permission: perms.host,
    tool: {
      name: "party_host",
      meta: { effect: "act", speed: "instant", group: "party" },
      description:
        "主持正在玩的派對遊戲。action:next 下一首(還沒人猜到的會先公布答案;海龜湯是放棄並公布湯底)、hint 給一個提示、" +
        "accept 算「很接近」的那個答案對(多半是語音辨識錯字)、reject 不算、end 結束遊戲。" +
        "回傳的就是結果,照著用自己的話講。",
      properties: {
        action: { type: "string", enum: [...HOST_ACTIONS], description: "要做什麼" },
        player: { type: "string", description: "accept / reject 針對誰(可省略 = 最近那個)" },
      },
      required: ["action"],
    },
    check(_args, p) {
      return sessionOf(table, p) !== null ? null : "no party game is running";
    },
    async execute(args, ctx) {
      const session = running(table, ctx.principal);
      const who = args.player ? session.find(args.player) : null;
      if (args.player && who === null && (args.action === "accept" || args.action === "reject")) {
        throw new CapabilityError(`遊戲裡找不到「${args.player}」。`);
      }
      session.touch();
      const game = session.game;
      let text: string;
      switch (args.action) {
        case "next":
          text = game.next();
          break;
        case "hint":
          text = game.hint();
          break;
        case "accept":
        case "reject":
          text = game.judge(args.action === "accept", who);
          break;
        case "end":
          session.end("host");
          text = `「${game.title}」結束了。最後分數:${session.standings()}`;
          break;
      }
      return { text, data: { game: game.id, action: args.action } };
    },
  });

  const play = defineCapability<PlayArgs>({
    name: "party.play",
    summary: "在派對遊戲裡出一手(猜、接詞、接故事)",
    risk: "low",
    args: PlayArgs,
    permission: perms.play,
    tool: {
      name: "party_play",
      meta: { effect: "act", speed: "instant", group: "party" },
      description:
        "你自己在正在玩的派對遊戲裡出一手:猜歌的搶答。" +
        "text 是你要出的內容,程式會判定對不對,照結果講。",
      properties: { text: { type: "string", description: "你的答案" } },
      required: ["text"],
    },
    check(_args, p) {
      return sessionOf(table, p) !== null ? null : "no party game is running";
    },
    async execute(args, ctx) {
      const session = running(table, ctx.principal);
      session.touch();
      const text = session.game.play(args.text);
      return { text, data: { game: session.game.id } };
    },
  });

  const ask = defineCapability<AskArgs>({
    name: "party.ask",
    summary: "把海龜湯的問題交給裁判",
    risk: "low",
    args: AskArgs,
    permission: perms.play,
    tool: {
      name: "party_ask",
      meta: { effect: "act", speed: "instant", group: "party" },
      description:
        "海龜湯專用:有人問了是非題,或說出他猜的真相,就把那句話交給裁判(湯底只有裁判知道)。" +
        "回傳「是 / 不是 / 不重要 / 很接近了」或猜中了,照結果回答,不要自己加料。",
      properties: {
        question: { type: "string", description: "對方問的問題或猜的真相(照他的意思寫完整)" },
        player: { type: "string", description: "誰問的(猜中有分;省略 = 你正在回的那個人)" },
      },
      required: ["question"],
    },
    check(_args, p) {
      const session = sessionOf(table, p);
      if (session === null) return "no party game is running";
      return session.game.id === "soup" ? null : `the game is ${GAME_TITLES[session.game.id]}`;
    },
    async execute(args, ctx) {
      const session = running(table, ctx.principal);
      session.touch();
      // Whoever she names; else the person whose message her turn answers (they asked).
      const who =
        (args.player ? session.find(args.player) : null) ??
        session.byAccount(ctx.principal.requester);
      const text = await session.game.ask(args.question, who);
      return { text, data: { game: session.game.id } };
    },
  });

  return [start, host, play, ask] as Capability[];
}
