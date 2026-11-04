// Capabilities of the `sing` module, behind the gate like everything she does:
//
// * `sing.request` (tool `sing_request`): prepare a song (search, link or library file). People
//   asking her is a request she may turn down; commands and the panel force it (sung as soon as
//   it is ready and she is free).
// * `sing.play` (tool `sing_start`): sing a ready song now, after what she is saying.
// * `sing.stop` (tool `sing_stop`): stop the song (skip), or with `all` also drop the rest.

import { type Capability, defineCapability } from "@miyoria/actions";
import { type Principal, safeName } from "@miyoria/types";
import { z } from "zod";
import type { SingPermissions } from "./config.js";
import { songLabel } from "./setlist.js";
import type { Singer } from "./singer.js";

const RequestArgs = z.object({
  /** Song name (with the artist helps), a YouTube link, or `library:<file>`. */
  query: z.string().trim().min(1).max(300),
  /** Whole-song transposition in semitones. */
  key: z.number().int().min(-6).max(6).nullish(),
  /** How to call the person who asked (shown in the list and to her later). */
  by: z.string().trim().min(1).max(64).nullish(),
});
const PlayArgs = z.object({ song: z.number().int().positive().nullish() });
const StopArgs = z.object({ all: z.boolean().nullish() });
type RequestArgs = z.output<typeof RequestArgs>;
type PlayArgs = z.output<typeof PlayArgs>;
type StopArgs = z.output<typeof StopArgs>;

/** Commands and the panel force a song: it is sung as soon as it is ready. */
function forced(p: Principal): boolean {
  return (p.kind === "command" && p.override) || p.kind === "panel";
}

function byOf(p: Principal, by: string | null | undefined): string {
  if (by) return safeName(by, 32);
  if (p.kind === "self") return "她自己";
  if (p.kind === "panel") return "面板";
  return p.kind === "command" ? "指令" : "聊天室的人";
}

export function singCapabilities(singer: Singer, perms: SingPermissions): Capability[] {
  const request = defineCapability<RequestArgs>({
    name: "sing.request",
    summary: "準備一首歌(用她的聲音翻唱)",
    risk: "medium",
    args: RequestArgs,
    permission: perms.request,
    // Downloading and converting take a minute of GPU time each.
    limits: { per_day: 40, per_person_per_day: 8, cooldown_ms: 0 },
    tool: {
      name: "sing_request",
      description:
        "準備一首歌給你唱(在背景下載、分離人聲、轉成你的聲音,通常要一到兩分鐘;已經唱過的歌馬上好)。" +
        "有人點歌、你想唱的時候用;準備的時候照常聊天,好了會告訴你,再用 sing_start 開唱。" +
        "一次點好幾首就每首各用一次 sing_request。" +
        "query 寫歌名(加上歌手更準),也可以是 YouTube 連結。" +
        "歌不適合可以拒絕,但已經唱過不是拒絕的理由:唱過的歌有人點就再唱一次。",
      properties: {
        query: { type: "string", description: "歌名 + 歌手,或 YouTube 連結" },
        key: { type: "integer", description: "整首升降幾個半音(-6 到 6,通常省略)" },
        by: { type: "string", description: "點歌的人怎麼稱呼(可省略)" },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const p = ctx.principal;
      const entry = await singer.request(
        {
          query: args.query,
          key: args.key ?? 0,
          requester: p.requester,
          requester_name: byOf(p, args.by),
          context: p.context,
          forced: forced(p),
        },
        ctx.signal,
      );
      const label = songLabel(entry);
      const text =
        entry.state === "ready"
          ? `${label} 已經準備好了(#${entry.no}),${entry.forced ? "她有空就會唱" : "可以用 sing_start 開唱"}。`
          : entry.state === "playing"
            ? `${label} 已經準備好了(#${entry.no}),她馬上就唱。`
            : `開始準備 ${label}(#${entry.no},大約一到兩分鐘)。${entry.forced ? "好了她就會唱。" : "好了會告訴你。"}`;
      return { text, data: { song: entry.no, state: entry.state } };
    },
  });

  const play = defineCapability<PlayArgs>({
    name: "sing.play",
    summary: "在語音頻道唱一首準備好的歌",
    risk: "low",
    args: PlayArgs,
    permission: perms.play,
    tool: {
      name: "sing_start",
      description:
        "唱一首已經準備好的歌(在你所在的語音頻道;你這句話說完才開始,唱的時候你不能說話)。" +
        "song 是歌單上的編號,省略 = 最早準備好的那首。開唱前用一句話開場。",
      properties: { song: { type: "integer", description: "歌單編號(可省略)" } },
    },
    check(args) {
      const now = singer.playing();
      if (now) return `already singing ${songLabel(now)}`;
      if (args.song == null && singer.list.ready().length === 0) return "no song is ready";
      return null;
    },
    async execute(args, ctx) {
      const entry = singer.play(args.song ?? null, ctx.principal.context, ctx.request.turn);
      return {
        text: `準備開始唱 ${songLabel(entry)}(#${entry.no}),說完這句就開始。`,
        data: { song: entry.no },
      };
    },
  });

  const stop = defineCapability<StopArgs>({
    name: "sing.stop",
    summary: "停止唱歌",
    risk: "low",
    args: StopArgs,
    permission: perms.skip,
    tool: {
      name: "sing_stop",
      description: "停止正在唱的歌;all = true 時歌單上其他還沒唱的也一起取消。",
      properties: { all: { type: "boolean", description: "也取消歌單上其他的歌" } },
    },
    async execute(args) {
      const { stopped, dropped } = await singer.stop(args.all === true);
      const parts: string[] = [];
      parts.push(stopped ? `已停止 ${songLabel(stopped)}。` : "現在沒有在唱歌。");
      if (dropped > 0) parts.push(`取消了歌單上的 ${dropped} 首。`);
      return { text: parts.join(""), data: { stopped: stopped?.no ?? null, dropped } };
    },
  });

  return [request, play, stop] as Capability[];
}
