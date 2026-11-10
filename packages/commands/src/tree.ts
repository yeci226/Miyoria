// The command tree's groups (command → group → subcommand), declared in one place so every
// module that adds a subcommand shares the same descriptions and platform gates.
//
// Discord shows the whole tree. The four panels (`/miyo`, `/song`, `/me i`, `/admin i`, see
// `panels.ts`) sit beside it: a command with subcommands opens its panel with the subcommand
// `i`, listed first; `/miyo` and `/song` have none and stay bare. Gates of the panels are the
// entries named like them.
//
//   /miyo     (panel)
//   /song     (panel)
//   /voice    join · leave · mode · consent · golive start|stop|status
//   /stream   start · stop · status · scene
//   /me       i · profile · call · link · privacy · wallet · checkin · feed · give · board ·
//             screen · letter · card · fortune · goals · pledge · bounties · memory show|export|forget ·
//             play quests|draw|album|giveitem|predictions|bet|titles|commission|commissions|
//             room|shop (regrouped for Discord, see `SLASH_REGROUP`)
//   /queue    add · list · upvote · manage ... · vote start|end · song request|list|skip|stop
//   /game     start · stop · goal · status
//   /channel  mode · activeness
//   /admin    i · module ... · role ... · perm ... · person ... · persona show · memory wipe ·
//             autonomy pause|resume|status · directive list|add|remove
//   /help

import type { GroupInfo } from "./spec.js";

type GroupInit = Partial<Omit<GroupInfo, "description">> & { description: string };

export const COMMAND_GROUPS: Readonly<Record<string, GroupInit>> = {
  miyo: { description: "她的控制面板：語音、直播、遊戲、聊天等級與緊急停止", guild_only: true },
  song: { description: "點歌與歌單", guild_only: true },
  voice: { description: "語音：讓她加入或離開語音頻道、設定語音模式與 Go Live", guild_only: true },
  "voice golive": { description: "Discord Go Live 推流" },
  stream: { description: "直播：透過直播機控制 OBS", guild_only: true },
  me: { description: "你的資料：她怎麼稱呼你、帳號連結與她記得的事" },
  "me memory": { description: "她記得的關於你的事" },
  "me play": { description: "玩與收藏：每日任務、抽收藏、預測、委託、小店與她的房間" },
  queue: { description: "請求佇列與投票", guild_only: true },
  "queue manage": { description: "管理佇列（叫號、跳過、清空等）" },
  "queue vote": { description: "投票" },
  "queue song": { description: "點歌：她用自己的聲音唱" },
  game: { description: "遊戲：讓她開始或停止玩遊戲", guild_only: true },
  channel: { description: "頻道設定：她在這個頻道的聊天模式與主動程度", guild_only: true },
  // No Manage Server gate: what a member may do is decided by permission nodes, so a
  // moderator with `admin.person.*` still finds `/admin`.
  admin: { description: "管理：模組、角色權限、她認識的人與資料", guild_only: true },
  "admin module": { description: "管理模組" },
  "admin role": { description: "管理角色與身分組對應" },
  "admin perm": { description: "覆寫角色的權限節點" },
  "admin person": { description: "管理她認識的人" },
  "admin persona": { description: "她的人格設定" },
  "admin memory": { description: "她的記憶資料" },
  "admin autonomy": { description: "她的自主行動：暫停、恢復與狀態" },
};

/**
 * Commands that Discord shows under another path. Discord allows 25 subcommands per command,
 * and `/me` has more than that (the economy's second generation alone added eleven), so the
 * surplus goes into the `me play` group instead of being cut off at the end of the list.
 *
 * Only the presentation changes: the registry still knows (and audits, and applies
 * `[modules.commands.visibility]` to) the real path, and accepts the presented one as an alias.
 * Panels, chat commands and permission nodes keep using the real path.
 */
export const SLASH_REGROUP: Readonly<Record<string, string>> = {
  "me quests": "me play quests",
  "me draw": "me play draw",
  "me album": "me play album",
  "me giveitem": "me play giveitem",
  "me predictions": "me play predictions",
  "me bet": "me play bet",
  "me titles": "me play titles",
  "me commission": "me play commission",
  "me commissions": "me play commissions",
  "me room": "me play room",
  "me shop": "me play shop",
};

/**
 * The command line a person on `platform` types for `path` (`me album` is `/me play album` on
 * Discord). Texts that tell people what to type use this, so they never name a path that the
 * platform does not have.
 */
export function typedCommand(path: string, platform: string): string {
  return `/${platform === "discord" ? (SLASH_REGROUP[path] ?? path) : path}`;
}

/** Display order of the top-level commands (e.g. in `/help`). */
export const CATEGORY_ORDER: readonly string[] = [
  "miyo",
  "song",
  "voice",
  "stream",
  "me",
  "queue",
  "game",
  "channel",
  "admin",
  "help",
];

export function groupInfo(init: GroupInit): GroupInfo {
  return {
    description: init.description,
    guild_only: init.guild_only ?? false,
    member_permission: init.member_permission ?? null,
  };
}
