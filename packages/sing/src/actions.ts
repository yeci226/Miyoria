// Capabilities of the `sing` module, behind the gate like everything she does:
//
// * `sing.request` (tool `sing_request`): prepare a song (search, link or library file). People
//   asking her is a request she may turn down; commands and the panel force it (sung as soon as
//   it is ready and she is free).
// * `sing.play` (tool `sing_start`): sing a ready song now, after what she is saying. She can name
//   it, and a song she already sang goes back on the list (the worker has it cached); a song not
//   on the list has to go through `sing.request`, with its permission and limits.
// * `sing.stop` (tool `sing_stop`): stop the song (skip), or with `all` also drop the rest.

import { type Capability, defineCapability } from "@miyoria/actions";
import { type Principal, safeName } from "@miyoria/types";
import { z } from "zod";
import type { SingPermissions } from "./config.js";
import { type SongNo, songLabel } from "./setlist.js";
import { SingError, type Singer } from "./singer.js";

const RequestArgs = z.object({
  /** Song name (with the artist helps), a YouTube link, or `library:<file>`. */
  query: z.string().trim().min(1).max(300),
  /** Whole-song transposition in semitones. */
  key: z.number().int().min(-6).max(6).nullish(),
  /** How to call the person who asked (shown in the list and to her later). */
  by: z.string().trim().min(1).max(64).nullish(),
});
const PlayArgs = z.object({
  /** A number on the set list (also written as text, `#3`) or a song's name. */
  song: z.union([z.number().int().positive(), z.string().trim().min(1).max(300)]).nullish(),
});
const StopArgs = z.object({ all: z.boolean().nullish() });
type RequestArgs = z.output<typeof RequestArgs>;
type PlayArgs = z.output<typeof PlayArgs>;
type StopArgs = z.output<typeof StopArgs>;

/** The song she means: a set list number, a name, or `null` for the first ready one. */
function songRef(song: PlayArgs["song"]): SongNo | string | null {
  if (typeof song !== "string") return song ?? null;
  return /^#?\d+$/.test(song) ? Number(song.replace("#", "")) : song;
}

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

const NOBODY_ASKED = "she only sings what someone asks for";

/** `onlyOnRequest` (`[modules.sing] only_on_request`): nothing here is hers to start alone. */
export function singCapabilities(
  singer: Singer,
  perms: SingPermissions,
  onlyOnRequest = false,
): Capability[] {
  const nobodyAsked = (p: Principal) => (onlyOnRequest && p.kind === "self" ? NOBODY_ASKED : null);

  const request = defineCapability<RequestArgs>({
    name: "sing.request",
    summary: "準備一首歌(用她的聲音翻唱)",
    risk: "medium",
    args: RequestArgs,
    permission: perms.request,
    // Downloading and converting take a minute of GPU time each.
    limits: { per_day: 40, per_person_per_day: 8, cooldown_ms: 0 },
    available: () => !onlyOnRequest,
    check: (_args, principal) => nobodyAsked(principal),
    tool: {
      name: "sing_request",
      description:
        "準備一首歌給你唱(在背景下載、分離人聲、轉成你的聲音,通常要一到兩分鐘;已經唱過的歌馬上好)。" +
        (onlyOnRequest
          ? "有人點歌的時候用;準備的時候照常聊天,好了就會開始唱,不用再做別的。"
          : "有人點歌、你想唱的時候用;準備的時候照常聊天,好了會告訴你,再用 sing_start 開唱。") +
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
          forced: forced(p) || onlyOnRequest,
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
    available: () => !onlyOnRequest,
    ...(onlyOnRequest
      ? {}
      : {
          tool: {
            name: "sing_start",
            description:
              "唱一首已經準備好的歌(在你所在的語音頻道;你這句話說完才開始,唱的時候你不能說話)。" +
              "song 是歌單上的編號或歌名,省略 = 最早準備好的那首;剛唱過的歌也可以再唱一次。" +
              "不在歌單上的歌要先用 sing_request 準備。開唱前用一句話開場。",
            properties: { song: { type: "string", description: "歌單編號或歌名(可省略)" } },
          },
        }),
    check(args, principal) {
      const notAsked = nobodyAsked(principal);
      if (notAsked) return notAsked;
      const now = singer.playing();
      if (now) return `already singing ${songLabel(now)}`;
      if (args.song == null && singer.list.ready().length === 0) return "no song is ready";
      return null;
    },
    async execute(args, ctx) {
      const ref = songRef(args.song);
      const p = ctx.principal;
      const listed =
        typeof ref === "string"
          ? singer.list.named(ref)
          : ref === null
            ? null
            : singer.list.get(ref);
      if (typeof ref === "string" && listed === null) {
        throw new SingError(`「${safeName(ref, 60)}」不在歌單上,要先用 sing_request 準備`);
      }
      if (listed?.state === "done") {
        // Sung before, so the worker has it: back on the list for who asked for it.
        const again = await singer.request(
          {
            query: listed.query,
            key: listed.key,
            requester: listed.requester,
            requester_name: listed.requester_name,
            context: p.context ?? listed.context,
            forced: true,
          },
          ctx.signal,
        );
        return {
          text: `${songLabel(again)} 再唱一次(#${again.no}),她有空就會開始。`,
          data: { song: again.no },
        };
      }
      const no = listed?.no ?? (typeof ref === "number" ? ref : null);
      const entry = singer.play(no, p.context, ctx.request.turn);
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
