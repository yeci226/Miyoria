// Capabilities of the `sing` module, behind the gate like everything she does:
//
// * `sing.request` (tool `sing_request`): prepare a song (search, link or library file). People
//   asking her is a request she may turn down; commands and the panel force it (sung as soon as
//   it is ready and she is free).
// * `sing.play` (tool `sing_start`): sing a ready song now, after what she is saying.
// * `sing.stop` (tool `sing_stop`): stop the song (skip), or with `all` also drop the rest.
// * `sing.steer` (no tool): change a song that has not started (its place in the list, its key).
//   Only the ActivityManager's steer calls it, for the main line (docs/design/v3-architecture.md
//   §10.6); it answers with the outcome as its data.

import { type Capability, defineCapability } from "@miyoria/gate/actions";
import { type JsonObject, type Principal, safeName } from "@miyoria/types";
import { z } from "zod";
import type { SingPermissions } from "./config.js";
import { BACKING_MODES, songLabel } from "./setlist.js";
import type { Singer } from "./singer.js";

const RequestArgs = z.object({
  /** Song name (with the artist helps), a YouTube link, or `library:<file>`. */
  query: z.string().trim().min(1).max(300),
  /** Whole-song transposition in semitones. */
  key: z.number().int().min(-6).max(6).nullish(),
  /** What becomes of the song's own backing voices (kept as recorded by default). */
  backing: z.enum(BACKING_MODES).nullish(),
  /** How to call the person who asked (shown in the list and to her later). */
  by: z.string().trim().min(1).max(64).nullish(),
  /** She prepares it for herself (練歌): no one is waiting, so it is not sung on its own. */
  practice: z.boolean().nullish(),
  /** Commands only: use a ticket when the person is at the limit. */
  ticket: z.boolean().nullish(),
  /** Commands only: a paid dedication (up to 40 characters). */
  dedication: z.string().trim().max(200).nullish(),
});
// Song numbers start at 1; a model that fills the optional field with 0 means "the first ready".
const PlayArgs = z.object({
  song: z.preprocess((v) => (v === 0 ? null : v), z.number().int().positive().nullish()),
});
const StopArgs = z.object({ all: z.boolean().nullish(), current: z.boolean().nullish() });
const SteerArgs = z.object({
  steer: z.object({
    id: z.string().min(1).max(64),
    task: z.string().min(1).max(64),
    patch: z.record(z.string(), z.unknown()),
    why: z.string().max(400),
    cause: z.string().max(64),
  }),
});
type RequestArgs = z.output<typeof RequestArgs>;
type PlayArgs = z.output<typeof PlayArgs>;
type StopArgs = z.output<typeof StopArgs>;
type SteerArgs = z.output<typeof SteerArgs>;

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
      meta: { effect: "act", speed: "long", group: "sing" },
      description:
        "準備一首歌給你唱(在背景下載、分離人聲、轉成你的聲音,通常要一到兩分鐘;已經唱過的歌馬上好)。" +
        "有人點歌、你想唱的時候用;準備的時候照常聊天,好了會告訴你,再用 sing_start 開唱。" +
        "query 寫歌名(加上歌手更準),也可以是 YouTube 或 bilibili 連結。不想唱、歌不適合可以拒絕。",
      properties: {
        query: { type: "string", description: "歌名 + 歌手,或 YouTube / bilibili 連結" },
        key: { type: "integer", description: "整首升降幾個半音(-6 到 6,通常省略)" },
        backing: {
          type: "string",
          enum: [...BACKING_MODES],
          description:
            "原曲的伴唱(和聲、合唱)怎麼處理,沒人提就省略:keep 保留原本的(預設)、drop 不要伴唱、" +
            "convert 伴唱也用你的聲音唱、acapella 清唱(只有你的主唱,沒有伴奏)",
        },
        by: { type: "string", description: "點歌的人怎麼稱呼(可省略)" },
        practice: {
          type: "boolean",
          description:
            "沒人點、是你自己想練的歌就填 true:先準備好放進歌單,不會自己開唱,等有人在語音、你想唱再用 sing_start",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const p = ctx.principal;
      // Only she practises: a person's request or a command is always for someone.
      const practice = p.kind === "self" && (args.practice === true || p.requester === null);
      const entry = await singer.request(
        {
          query: args.query,
          key: args.key ?? 0,
          backing: args.backing ?? "keep",
          requester: p.requester,
          requester_name: byOf(p, args.by),
          context: p.context,
          forced: !practice && forced(p),
          practice,
          // Money moves only on the person's own command, never on her tool call.
          ...(p.kind === "command"
            ? { ticket: args.ticket === true, dedication: args.dedication ?? null }
            : {}),
        },
        ctx.signal,
      );
      const label = songLabel(entry);
      const text =
        entry.state === "ready"
          ? `${label} 已經準備好了(#${entry.no}),${entry.forced ? "她有空就會唱" : "可以用 sing_start 開唱"}。`
          : entry.state === "playing"
            ? `${label} 已經準備好了(#${entry.no}),她馬上就唱。`
            : `開始準備 ${label}(#${entry.no},大約一到兩分鐘)。${entry.forced ? "好了她就會唱。" : practice ? "好了會告訴你,不會自己開唱。" : "好了會告訴你。"}`;
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
      meta: { effect: "act", speed: "long", group: "sing" },
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
      meta: { effect: "act", speed: "instant", group: "sing" },
      description:
        "停止唱歌。預設停掉正在唱的這首;all = true 時歌單上還沒唱的也一起取消。" +
        "想讓這首唱完、只把後面的清掉(例如要收尾),用 all = true 加 current = false。",
      properties: {
        all: { type: "boolean", description: "也取消歌單上其他還沒唱的歌" },
        current: {
          type: "boolean",
          description: "要不要停掉正在唱的這首(預設 true;false = 讓它唱完)",
        },
      },
    },
    async execute(args) {
      const keep = args.current === false;
      const { stopped, dropped } = await singer.stop(args.all === true, !keep);
      const parts: string[] = [];
      if (keep) parts.push(singer.playing() ? "這首會唱完。" : "現在沒有在唱歌。");
      else parts.push(stopped ? `已停止 ${songLabel(stopped)}。` : "現在沒有在唱歌。");
      if (dropped > 0) parts.push(`取消了歌單上的 ${dropped} 首。`);
      return { text: parts.join(""), data: { stopped: stopped?.no ?? null, dropped } };
    },
  });

  const steer = defineCapability<SteerArgs>({
    name: "sing.steer",
    summary: "改一首還沒開唱的歌(順序、key)",
    risk: "low",
    args: SteerArgs,
    permission: null,
    async execute(args) {
      const s = args.steer;
      const answer = await singer.steer({
        id: s.id,
        task: s.task,
        patch: s.patch as JsonObject,
        why: s.why,
        cause: s.cause,
      });
      return { text: answer.detail, data: { outcome: answer.outcome, detail: answer.detail } };
    },
  });

  return [request, play, stop, steer] as Capability[];
}
