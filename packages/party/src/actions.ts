// Capabilities of the `party` module, behind the gate like everything she does. She is the host:
// starting, running and ending a game are her decisions, made as tool calls of the main line.
//
// * `party.start` (tool `party_start`): a game in the voice channel she is in.
// * `party.host` (tool `party_host`): next round, a hint, her ruling on a near miss, the end.
// * `party.play` (tool `party_play`): her own move (a guess, a word, a line of the story).
// * `party.ask` (tool `party_ask`): turtle soup, a question for the referee.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import type { ContextKey, Principal } from "@miyoria/types";
import { z } from "zod";
import type { PartyPermissions } from "./config.js";
import { CHAIN_MODES, GAME_IDS, GAME_TITLES } from "./game.js";
import type { Session, Table } from "./table.js";

const StartArgs = z.object({
  game: z.enum(GAME_IDS),
  mode: z.enum(CHAIN_MODES).nullish(),
  rounds: z.number().int().min(1).max(30).nullish(),
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(200),
        answer: z.string().trim().min(1).max(60),
        also: z.array(z.string().trim().min(1).max(60)).max(5).nullish(),
      }),
    )
    .max(30)
    .nullish(),
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

/** The voice channel a call is about: where the turn is, else hers on that server. */
export function voiceOf(table: Table, p: Principal): ContextKey | null {
  const c = p.context;
  if (c === null) return null;
  if (c.kind === "voice") return c;
  return table.room(c.platform, c.scope);
}

function sessionOf(table: Table, p: Principal): Session {
  const voice = voiceOf(table, p);
  const session = voice === null ? null : table.session(voice);
  if (session === null) throw new CapabilityError("現在沒有在玩派對遊戲。");
  return session;
}

export function partyCapabilities(table: Table, perms: PartyPermissions): Capability[] {
  const start = defineCapability<StartArgs>({
    name: "party.start",
    summary: "在語音頻道開一場派對遊戲",
    risk: "low",
    args: StartArgs,
    permission: perms.start,
    tool: {
      name: "party_start",
      description:
        "在你所在的語音頻道開一場派對遊戲,你當主持人(有的也下場玩)。語音裡有人想玩、或大家冷場時你想帶動氣氛時用;一次只能玩一個。" +
        "game:soup 海龜湯(你念湯面,大家問是非題,裁判判定)、song 猜歌(放你唱過的歌的片段搶答)、" +
        "chain 接龍(mode:idiom 成語、word 詞語、story 故事,你也下場)、quiz 問答(搶答,題目可以自己出)。" +
        "開始後照回傳的說明開場。",
      properties: {
        game: { type: "string", enum: [...GAME_IDS], description: "哪個遊戲" },
        mode: {
          type: "string",
          enum: [...CHAIN_MODES],
          description: "接龍的種類(只有 chain 用,預設 idiom)",
        },
        rounds: { type: "integer", description: "幾題 / 幾首 / 幾串(可省略)" },
        questions: {
          type: "array",
          description: "問答用你自己出的題目(可省略,省略就用題庫;自己出的你知道答案,就不能搶答)",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
              also: { type: "array", items: { type: "string" }, description: "也算對的說法" },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["game"],
    },
    check(_args, p) {
      const voice = voiceOf(table, p);
      if (voice === null) return "she is not in a voice channel";
      const running = table.session(voice);
      return running ? `already playing ${running.game.id}` : null;
    },
    async execute(args, ctx) {
      const voice = voiceOf(table, ctx.principal);
      if (voice === null) throw new CapabilityError("你不在語音頻道,派對遊戲要在語音裡玩。");
      const session = table.start(voice, args.game, {
        mode: args.mode ?? null,
        rounds: args.rounds ?? null,
        questions:
          args.questions?.map((q) => ({
            question: q.question,
            answers: [q.answer, ...(q.also ?? [])],
          })) ?? null,
      });
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
      description:
        "主持正在玩的派對遊戲。action:next 下一題 / 下一首 / 新的一串(還沒人答對的會先公布答案)、hint 給一個提示、" +
        "accept 算「很接近」的那個答案對(多半是語音辨識錯字)、reject 不算(接龍會收回上一個詞)、end 結束遊戲。" +
        "回傳的就是結果,照著用自己的話講。",
      properties: {
        action: { type: "string", enum: [...HOST_ACTIONS], description: "要做什麼" },
        player: { type: "string", description: "accept / reject 針對誰(可省略 = 最近那個)" },
      },
      required: ["action"],
    },
    check(_args, p) {
      const voice = voiceOf(table, p);
      return voice !== null && table.session(voice) ? null : "no party game is running";
    },
    async execute(args, ctx) {
      const session = sessionOf(table, ctx.principal);
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
      description:
        "你自己在正在玩的派對遊戲裡出一手:猜歌、問答搶答、接龍接一個詞、故事接龍說你的那句。" +
        "text 是你要出的內容,程式會判定算不算,照結果講。",
      properties: { text: { type: "string", description: "你的答案、詞或那一句故事" } },
      required: ["text"],
    },
    check(_args, p) {
      const voice = voiceOf(table, p);
      return voice !== null && table.session(voice) ? null : "no party game is running";
    },
    async execute(args, ctx) {
      const session = sessionOf(table, ctx.principal);
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
      description:
        "海龜湯專用:有人問了是非題,或說出他猜的真相,就把那句話交給裁判(湯底只有裁判知道)。" +
        "回傳「是 / 不是 / 不重要 / 很接近了」或猜中了,照結果回答,不要自己加料。",
      properties: {
        question: { type: "string", description: "對方問的問題或猜的真相(照他的意思寫完整)" },
        player: { type: "string", description: "誰問的(猜中有分)" },
      },
      required: ["question"],
    },
    check(_args, p) {
      const voice = voiceOf(table, p);
      const session = voice === null ? null : table.session(voice);
      if (session === null) return "no party game is running";
      return session.game.id === "soup" ? null : `the game is ${GAME_TITLES[session.game.id]}`;
    },
    async execute(args, ctx) {
      const session = sessionOf(table, ctx.principal);
      session.touch();
      const who = args.player ? session.find(args.player) : null;
      const text = await session.game.ask(args.question, who);
      return { text, data: { game: session.game.id } };
    },
  });

  return [start, host, play, ask] as Capability[];
}
