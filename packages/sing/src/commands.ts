// `/queue song request | list | skip | voteskip | stop`. Request, skip and stop go through the actuator
// registry's gate (principal `command`, override: a commanded song is sung once it is ready).

import { type ActuatorRegistry, deniedText } from "@miyoria/actions";
import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CardButton,
  type CommandHandler,
  type CommandRegistry,
  type CommandReply,
  type CommandSpec,
  ComponentResult,
  cardReply,
  commandName,
  commandSpec,
  componentId,
  type Invocation,
  notice,
  type RegisterOptions,
} from "@miyoria/commands";
import { type JsonObject, Principals } from "@miyoria/types";
import type { SingPermissions } from "./config.js";
import {
  BACKING_LABELS,
  BACKING_MODES,
  type BackingMode,
  type SongEntry,
  songLabel,
} from "./setlist.js";
import type { Singer } from "./singer.js";

const R = {
  skip: "sing:list:skip",
  voteskip: "sing:list:voteskip",
  refresh: "sing:list:refresh",
} as const;

/** Song titles come from YouTube: no Markdown in them. */
function md(text: string): string {
  return text.replace(/[\\*_`~|>#[\]()]/g, (c) => `\\${c}`);
}

const STATE: Record<SongEntry["state"], string> = {
  preparing: "準備中",
  ready: "已準備好",
  playing: "正在唱",
  done: "唱完了",
  failed: "失敗",
  cancelled: "已取消",
};

function line(e: SongEntry, waiting = false): string {
  let s = `#${e.no} ${md(songLabel(e))}：${STATE[e.state]}`;
  if (e.state === "preparing") s += `（${Math.round(e.progress * 100)}%）`;
  s += ` · ${md(e.requester_name)}`;
  if (waiting) s += "（不在語音裡，回來再唱）";
  if (e.state === "failed" && e.error) s += `（${md(e.error.slice(0, 80))}）`;
  return s;
}

/** The set list card (public, with skip / refresh buttons). */
export function listCard(singer: Singer, note: string | null = null): CommandReply {
  const all = singer.list.all();
  const open = all.filter((e) => ["preparing", "ready", "playing"].includes(e.state));
  const recent = all.filter((e) => !open.includes(e)).slice(-3);
  const blocks: CardBlock[] = [];
  blocks.push({
    type: "text",
    text:
      open.length > 0
        ? open.map((e) => line(e, e.state === "ready" && singer.waitsForRequester(e))).join("\n")
        : "歌單是空的。用 /queue song request 點歌。",
  });
  if (recent.length > 0) {
    blocks.push({ type: "muted", text: recent.map((e) => line(e)).join("\n") });
  }
  if (note) blocks.push({ type: "muted", text: note });
  const buttons: CardButton[] = [
    { id: componentId(R.refresh), label: "重新整理", style: "secondary" },
  ];
  if (singer.playing()) {
    buttons.unshift(
      { id: componentId(R.voteskip), label: "投票跳過", style: "primary" },
      { id: componentId(R.skip), label: "跳過", style: "danger" },
    );
  }
  blocks.push({ type: "buttons", buttons });
  return cardReply(blocks, {
    title: "歌單",
    accent: singer.playing() ? "success" : "neutral",
    session: {},
  });
}

/** One person's vote to skip the song she is singing, as a public notice. */
async function voteSkip(singer: Singer, inv: Invocation): Promise<CommandReply> {
  const vote = await singer.voteSkip(inv.invoker);
  if (vote === null) return { ...notice("info", "她現在沒有在唱歌。"), ephemeral: true };
  const song = md(songLabel(vote.entry));
  if (vote.skipped) return notice("success", `已跳過 ${song}。`);
  const tally = `${vote.votes}/${vote.needed}`;
  return vote.counted
    ? notice("info", `${md(inv.invoker_display_name)} 投票跳過 ${song}（${tally}）。`)
    : { ...notice("info", `你已經投過了（${tally}）。`), ephemeral: true };
}

/** Runs a capability for the invoker through the gate (principal `command`, override). */
async function ask(
  actuators: ActuatorRegistry,
  inv: Invocation,
  capability: string,
  args: JsonObject,
): Promise<CommandReply> {
  const outcome = await actuators.invoke({
    principal: Principals.command(inv.invoker, inv.context),
    capability,
    args,
    why: `/${inv.path.join(" ")}`,
    turn: null,
  });
  switch (outcome.status) {
    case "done":
      return notice("success", md(outcome.result.text));
    case "denied":
      return notice("warn", deniedText(outcome.decision.stage), outcome.decision.reason);
    case "failed":
      return notice("warn", "沒辦法照做。", outcome.error);
  }
}

/** Registers `queue song request | list | skip | stop`; returns the paths. */
export function registerCommands(
  registry: CommandRegistry,
  perms: SingPermissions,
  actuators: ActuatorRegistry,
  singer: Singer,
): string[] {
  const paths: string[] = [];
  const add = (spec: CommandSpec, handler: CommandHandler, options: RegisterOptions = {}) => {
    paths.push(commandName(spec));
    registry.register(spec, handler, options);
  };

  add(
    commandSpec("queue song request", "點一首歌給她唱（用她的聲音翻唱，準備好她就唱）", {
      args: [
        argSpec("song", "歌名（加上歌手更準）或 YouTube / bilibili 連結", ArgKind.string),
        argSpec("key", "整首升降幾個半音（-6 到 6）", ArgKind.integer, { required: false }),
        argSpec(
          "backing",
          "伴唱怎麼處理（預設保留原曲伴唱）",
          ArgKind.choice(BACKING_MODES.map((m) => BACKING_LABELS[m])),
          { required: false },
        ),
        argSpec(
          "ticket",
          "同時點歌數到上限時，用點歌加點券多點一首（沒到上限不收費）",
          ArgKind.boolean,
          {
            required: false,
          },
        ),
        argSpec("dedication", "獻詞（40 字內，要付費；過審查、不能點名別人）", ArgKind.string, {
          required: false,
        }),
      ],
      permission: perms.request,
    }),
    (inv) => {
      const query = (inv.str("song") ?? "").trim();
      if (query === "") return notice("warn", "請輸入歌名。");
      const key = inv.int("key");
      const args: JsonObject = { query, by: inv.invoker_display_name };
      if (key !== null && key !== undefined) args.key = key;
      const backing = backingOf(inv.str("backing"));
      if (backing !== "keep") args.backing = backing;
      if (inv.bool("ticket") === true) args.ticket = true;
      const dedication = (inv.str("dedication") ?? "").trim();
      if (dedication !== "") args.dedication = dedication;
      return ask(actuators, inv, "sing.request", args);
    },
  );

  add(
    commandSpec("queue song list", "查看她的歌單：準備中、準備好的和正在唱的歌", {
      permission: perms.list,
    }),
    () => listCard(singer),
    {
      components: [
        { route: R.refresh, handle: () => ComponentResult.update(listCard(singer)) },
        {
          route: R.voteskip,
          permission: perms.list,
          handle: async (inv) => {
            const result = await voteSkip(singer, inv);
            return result.tone === "success"
              ? ComponentResult.update(listCard(singer, result.text))
              : ComponentResult.reply(result);
          },
        },
        {
          route: R.skip,
          permission: perms.skip,
          handle: async (inv) => {
            const result = await ask(actuators, inv, "sing.stop", {});
            if (result.tone === "warn") return ComponentResult.reply(result);
            return ComponentResult.update(listCard(singer, result.text));
          },
        },
      ],
    },
  );

  add(commandSpec("queue song skip", "跳過她正在唱的歌", { permission: perms.skip }), (inv) =>
    ask(actuators, inv, "sing.stop", {}),
  );

  add(
    commandSpec("queue song voteskip", "投票跳過她正在唱的歌（語音裡四分之一的人投了就跳過）", {
      permission: perms.list,
    }),
    (inv) => voteSkip(singer, inv),
  );

  add(commandSpec("queue song stop", "停止唱歌並清空歌單", { permission: perms.stop }), (inv) =>
    ask(actuators, inv, "sing.stop", { all: true }),
  );

  return paths;
}

/** The backing mode a command picked (by its label or its own name); `keep` when none. */
export function backingOf(choice: string | null | undefined): BackingMode {
  const c = (choice ?? "").trim();
  return BACKING_MODES.find((m) => m === c || BACKING_LABELS[m] === c) ?? "keep";
}
