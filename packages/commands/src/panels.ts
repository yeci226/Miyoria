// The four panel commands: `/miyo`, `/song`, `/me i` and `/admin i` (`i` is the interactive
// subcommand a command with subcommands needs; `/miyo` and `/song` have none and stay bare).
// `/miyo` and `/song` are public, `/me i` and `/admin i` private (the registry's visibility
// table can change either).
//
// Each page lists controls that run the commands the feature modules registered (`voice join`,
// `queue song request`, `me privacy`, ...), so a feature keeps its own handlers, permission
// nodes and replies. The page tables below are the one place that says which control replaces
// which old command; a test checks that every command the repository registers has a control
// (or is a status line), and the `admin` panel lists any command that does not, so a command
// added later is reachable before someone adds a control for it.

import type { ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type Character,
  CharacterKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
} from "@miyoria/types";
import {
  type FieldAsk,
  mappedPaths,
  type PanelAction,
  type PanelDef,
  type PanelPage,
  registerPanelCommand,
} from "./panel.js";
import type { CommandRegistry } from "./registry.js";
import type { CardBlock } from "./reply.js";
import { ArgKind, argSpec } from "./spec.js";

/**
 * The three channel tiers (docs/design/v3-architecture.md §14.3). A tier is a shortcut for one
 * of the agent's channel levels; the finer levels (`quiet`, `lively`, `always`) stay in the
 * select below the buttons.
 */
export const CHANNEL_TIERS = [
  { id: "off", mode: "off", label: "關閉" },
  { id: "mention", mode: "mention-only", label: "只回提及" },
  { id: "chatty", mode: "normal", label: "可以聊天" },
] as const;

export type ChannelTier = (typeof CHANNEL_TIERS)[number]["id"];

/** The tier that a channel level belongs to (finer levels count as `chatty`). */
export function tierOf(mode: string): ChannelTier {
  if (mode === "off") return "off";
  if (mode === "mention-only") return "mention";
  return "chatty";
}

const MODE_LABELS = {
  off: "關閉",
  "mention-only": "只回提及",
  quiet: "安靜",
  normal: "一般",
  lively: "活躍",
  always: "每則都回",
  reset: "恢復預設",
} as const;

const ACTIVENESS_LABELS = { low: "低", medium: "普通", high: "高", reset: "恢復預設" } as const;

const field = (arg: string, label: string, extra: Partial<FieldAsk> = {}): FieldAsk => ({
  arg,
  label,
  ...extra,
});

const ID_FIELD = field("id", "項目編號", { placeholder: "例如 3" });
const USER_FIELD = field("user", "對象（使用者 ID 或 @提及）");
const ROLE_FIELD = field("role", "Miyoria 角色", { placeholder: "例如 moderator" });
const SCOPE_FIELD = field("scope", "範圍（可留空）", {
  placeholder: "global / guild / channel",
  required: false,
});
const MODULE_FIELD = field("id", "模組 id", { placeholder: "例如 llm" });

/**
 * The rules she keeps (docs/design/v3-architecture.md §9), on `/miyo` and `/admin` both. What a
 * person may do with a rule depends on their account, not on the page they use. The list is a
 * status line on the private `/admin` and a button on the public `/miyo` (the answer comes back
 * privately: a shared message never shows it).
 */
function rulesPage(listButton: boolean): PanelPage {
  return {
    id: "rules",
    label: "規則",
    description: "她一定要遵守的規則：查看、建立、解除",
    refresh: true,
    intro: [
      "規則不會隨時間淡掉。主人的規則直到解除；管理員的規則一定有時效；只有主人能解除別人定的規則。",
    ],
    status: [{ path: "admin directive list", label: "現在的規則" }],
    actions: [
      ...(listButton
        ? [
            {
              id: "rule-list",
              label: "查看規則",
              path: "admin directive list",
              style: "primary" as const,
            },
          ]
        : []),
      {
        id: "rule-add",
        label: "建立規則",
        path: "admin directive add",
        style: "primary",
        ask: {
          title: "建立規則",
          fields: [
            field("text", "規則內容", {
              placeholder: "例如：不要玩 Minecraft",
              style: "paragraph",
            }),
            field("effect", "效果", { placeholder: "deny / require_approval / avoid / prefer" }),
            field("capability", "動作（可留空）", {
              placeholder: "例如 game.start 或 game.*",
              required: false,
            }),
            field("activity", "事情（可留空）", { placeholder: "例如 minecraft", required: false }),
            field("minutes", "有效幾分鐘（主人可留空，就是直到解除）", { required: false }),
          ],
        },
      },
      {
        id: "rule-remove",
        label: "解除規則",
        path: "admin directive remove",
        style: "danger",
        ask: {
          title: "解除規則",
          fields: [field("rule", "規則編號或規則裡的字", { placeholder: "例如 minecraft" })],
        },
      },
    ],
  };
}

// ---- /miyo --------------------------------------------------------------------------------

function miyoPages(): PanelPage[] {
  return [
    {
      id: "home",
      label: "總覽",
      description: "她現在在做什麼",
      alwaysVisible: true,
      refresh: true,
      intro: ["用下方的選單切換分類。你看得到哪些分類，取決於你的權限。"],
      status: [
        { path: "game status", label: "遊戲" },
        { path: "stream status", label: "直播" },
        { path: "voice golive status", label: "Go Live" },
      ],
      actions: [],
    },
    {
      id: "voice",
      label: "語音",
      description: "進出語音頻道、聊天模式、Go Live",
      refresh: true,
      status: [
        { path: "voice mode", label: "語音聊天模式" },
        { path: "voice golive status", label: "Go Live" },
      ],
      actions: [
        { id: "join", label: "加入我的語音頻道", path: "voice join", style: "primary" },
        { id: "leave", label: "離開語音頻道", path: "voice leave" },
        {
          id: "golive-start",
          label: "開始 Go Live",
          path: "voice golive start",
          style: "success",
          ask: {
            title: "開始 Go Live",
            fields: [
              field("source", "推流來源（可留空）", {
                placeholder: "留空就用設定檔的 golive_source",
                required: false,
              }),
            ],
          },
        },
        { id: "golive-stop", label: "結束 Go Live", path: "voice golive stop", style: "danger" },
        {
          id: "mode",
          label: "語音聊天模式",
          path: "voice mode",
          choice: { arg: "mode", placeholder: "語音聊天模式…", labels: MODE_LABELS },
        },
      ],
    },
    {
      id: "party",
      label: "派對遊戲",
      description: "請她開一場猜歌或海龜湯",
      intro: [
        "猜歌要在語音頻道玩;海龜湯在語音頻道或這個文字頻道都可以,文字頻道裡問題和她的回答都是一般訊息。",
        "開了之後她主持。也可以直接跟她說「開海龜湯」。",
      ],
      actions: [
        {
          id: "party-soup",
          label: "海龜湯",
          path: "game party",
          args: { game: "soup" },
          style: "primary",
        },
        { id: "party-song", label: "猜歌", path: "game party", args: { game: "song" } },
      ],
    },
    {
      id: "stream",
      label: "直播",
      description: "OBS 開關台與場景",
      refresh: true,
      status: [{ path: "stream status", label: "直播機" }],
      actions: [
        { id: "start", label: "開始直播", path: "stream start", style: "success" },
        { id: "stop", label: "結束直播", path: "stream stop", style: "danger" },
        {
          id: "scene",
          label: "切換場景",
          path: "stream scene",
          ask: { title: "切換場景", fields: [field("name", "場景名稱")] },
        },
      ],
    },
    {
      id: "game",
      label: "遊戲",
      description: "開始、停止與指定目標",
      refresh: true,
      status: [{ path: "game status", label: "遊戲" }],
      actions: [
        {
          id: "start",
          label: "開始遊戲",
          path: "game start",
          style: "success",
          ask: {
            title: "開始遊戲",
            fields: [
              field("game", "遊戲 id（可留空）", { required: false }),
              field("where", "實況送到哪裡（可留空）", {
                placeholder: "auto / voice / here / stream",
                required: false,
              }),
            ],
          },
        },
        { id: "stop", label: "停止遊戲", path: "game stop", style: "danger" },
        {
          id: "goal",
          label: "指定目標",
          path: "game goal",
          ask: {
            title: "指定目標",
            fields: [field("text", "目標", { placeholder: "例如：去挖鐵礦", style: "paragraph" })],
          },
        },
      ],
    },
    {
      id: "chat",
      label: "聊天等級",
      description: "她在這個頻道多話到什麼程度",
      refresh: true,
      intro: [
        "關閉：不回話。只回提及：被叫到才回。可以聊天：被叫到會回，也會自己插話（等級是上限）。",
      ],
      status: [
        { path: "channel mode", label: "這個頻道的聊天等級" },
        { path: "channel activeness", label: "主動程度" },
      ],
      actions: [
        ...CHANNEL_TIERS.map(
          (tier): PanelAction => ({
            id: `tier-${tier.id}`,
            label: tier.label,
            path: "channel mode",
            args: { mode: tier.mode },
            style: tier.id === "off" ? "danger" : tier.id === "chatty" ? "success" : "secondary",
          }),
        ),
        {
          id: "mode",
          label: "更細的聊天等級",
          path: "channel mode",
          choice: { arg: "mode", placeholder: "更細的聊天等級…", labels: MODE_LABELS },
        },
        {
          id: "activeness",
          label: "主動程度",
          path: "channel activeness",
          choice: { arg: "level", placeholder: "主動程度…", labels: ACTIVENESS_LABELS },
        },
      ],
    },
    {
      id: "queue",
      label: "請求佇列",
      description: "排請求、投票、叫號",
      actions: [
        {
          id: "add",
          label: "排一個請求",
          path: "queue add",
          style: "primary",
          ask: {
            title: "排一個請求",
            fields: [
              field("text", "想請她做的事", { style: "paragraph" }),
              field("kind", "種類（可留空）", { placeholder: "例如 game_goal", required: false }),
            ],
          },
        },
        { id: "list", label: "查看佇列", path: "queue list" },
        {
          id: "upvote",
          label: "加一票",
          path: "queue upvote",
          ask: { title: "幫項目加一票", fields: [ID_FIELD] },
        },
        { id: "next", label: "叫下一個", path: "queue manage next", style: "primary" },
        { id: "done", label: "完成", path: "queue manage done", style: "success" },
        { id: "skip", label: "跳過", path: "queue manage skip" },
        { id: "pause", label: "暫停叫號", path: "queue manage pause" },
        { id: "resume", label: "恢復叫號", path: "queue manage resume" },
        {
          id: "remove",
          label: "移除項目",
          path: "queue manage remove",
          style: "danger",
          ask: { title: "移除項目", fields: [ID_FIELD] },
        },
        { id: "clear", label: "清空佇列", path: "queue manage clear", style: "danger" },
        {
          id: "priority",
          label: "調整優先度",
          path: "queue manage priority",
          ask: {
            title: "調整優先度",
            fields: [ID_FIELD, field("priority", "優先度（數字越大越前面）")],
          },
        },
        {
          id: "vote-start",
          label: "開始投票",
          path: "queue vote start",
          ask: {
            title: "開始投票",
            fields: [
              field("options", "選項（用逗號分隔）", { placeholder: "甲, 乙, 丙" }),
              field("seconds", "投票秒數", { placeholder: "60" }),
            ],
          },
        },
        { id: "vote-end", label: "結束投票", path: "queue vote end" },
      ],
    },
    {
      id: "songs",
      label: "歌單",
      description: "她的歌單（點歌請用 /song）",
      refresh: true,
      status: [{ path: "queue song list", label: "歌單" }],
      actions: [
        { id: "skip", label: "跳過這首", path: "queue song skip" },
        {
          id: "stop",
          label: "停止並清空",
          path: "queue song stop",
          style: "danger",
          confirm: "確定要停止唱歌並清空歌單嗎？",
        },
      ],
    },
    rulesPage(true),
    {
      id: "safety",
      label: "緊急停止",
      description: "讓她閉嘴、關台、停遊戲，或解除",
      refresh: true,
      intro: [
        "按下後她立刻閉嘴、不再回話，直播、語音和遊戲都會關掉；指令與面板照常可用。",
        "解除後她會再開口，但語音、直播和遊戲不會自動回來。",
      ],
      status: [{ path: "admin autonomy status", label: "自主行動" }],
      actions: [
        { id: "pause", label: "緊急停止", path: "admin autonomy pause", style: "danger" },
        { id: "resume", label: "解除", path: "admin autonomy resume", style: "success" },
      ],
    },
  ];
}

// ---- /song --------------------------------------------------------------------------------

function songPages(): PanelPage[] {
  return [
    {
      id: "main",
      label: "歌單",
      description: "點歌、投票跳過",
      alwaysVisible: true,
      refresh: true,
      intro: ["她會用自己的聲音翻唱。歌名加上歌手比較準，也可以貼 YouTube 或 bilibili 連結。"],
      status: [{ path: "queue song list", label: "歌單" }],
      actions: [
        {
          id: "request",
          label: "點歌",
          path: "queue song request",
          style: "primary",
          ask: {
            title: "點歌",
            fields: [
              field("song", "歌名或 YouTube / bilibili 連結", {
                placeholder: "例如：櫻ノ詩 / 歌手",
              }),
              field("key", "升降幾個半音（-6 到 6，可留空）", {
                placeholder: "0",
                required: false,
              }),
            ],
          },
        },
        { id: "voteskip", label: "投票跳過", path: "queue song voteskip" },
        { id: "list", label: "貼到頻道", path: "queue song list" },
        { id: "skip", label: "跳過這首", path: "queue song skip" },
        {
          id: "stop",
          label: "停止並清空",
          path: "queue song stop",
          style: "danger",
          confirm: "確定要停止唱歌並清空歌單嗎？",
        },
      ],
    },
  ];
}

// ---- /me ----------------------------------------------------------------------------------

function mePages(policyUrl: string | null, her: Character, coin: string): PanelPage[] {
  const policy = (): CardBlock[] =>
    policyUrl
      ? [
          {
            type: "buttons",
            buttons: [{ id: "policy", label: "隱私政策", style: "secondary", url: policyUrl }],
          },
        ]
      : [{ type: "muted", text: "管理者還沒有提供隱私政策的連結。" }];
  return [
    {
      id: "home",
      label: "開始",
      description: "第一次來？從這裡開始",
      alwaysVisible: true,
      intro: [
        `我是 ${her.name}，一個 AI。這是你自己的面板，其他人看不到，也不用背指令。`,
        "想聽她唱歌：按「點歌」。想管她能不能聽你、私訊你、看你的狀態：切到「隱私」。",
        "她記得的關於你的事可以查看、匯出和刪除：切到「記憶與刪除」。",
      ],
      actions: [
        {
          id: "song",
          label: "點歌",
          path: "queue song request",
          style: "primary",
          ask: {
            title: "點歌",
            fields: [
              field("song", "歌名或 YouTube / bilibili 連結", {
                placeholder: "例如：櫻ノ詩 / 歌手",
              }),
              field("key", "升降幾個半音（-6 到 6，可留空）", {
                placeholder: "0",
                required: false,
              }),
            ],
          },
        },
        { id: "consent-on", label: "允許語音收音", path: "voice consent", args: { state: "on" } },
        { id: "consent-off", label: "停止語音收音", path: "voice consent", args: { state: "off" } },
      ],
      extra: policy,
    },
    {
      id: "privacy",
      label: "隱私",
      description: "私訊、主動找你、看你的狀態、語音收音",
      refresh: true,
      intro: ["每一項都可以隨時改回來。沒有按過的項目維持預設。"],
      status: [
        { path: "me privacy", label: "目前的設定" },
        { path: "voice consent", label: "語音收音" },
      ],
      actions: [
        { id: "dm-on", label: "允許私訊", path: "me privacy", args: { dm: "on" } },
        { id: "dm-off", label: "禁止私訊", path: "me privacy", args: { dm: "off" } },
        { id: "approach-on", label: "允許主動找我", path: "me privacy", args: { approach: "on" } },
        {
          id: "approach-off",
          label: "禁止主動找我",
          path: "me privacy",
          args: { approach: "off" },
        },
        {
          id: "presence-on",
          label: "允許看我的狀態",
          path: "me privacy",
          args: { presence: "on" },
        },
        {
          id: "presence-off",
          label: "禁止看我的狀態",
          path: "me privacy",
          args: { presence: "off" },
        },
        { id: "consent-on", label: "允許語音收音", path: "voice consent", args: { state: "on" } },
        { id: "consent-off", label: "停止語音收音", path: "voice consent", args: { state: "off" } },
      ],
      extra: policy,
    },
    {
      id: "profile",
      label: "我的資料",
      description: "她怎麼稱呼你、帳號連結",
      // A status line shows the words only: no picture is drawn for it.
      status: [{ path: "me profile", label: "她對你的印象", args: { picture: false } }],
      actions: [
        {
          id: "call",
          label: "改稱呼",
          path: "me call",
          ask: {
            title: "她怎麼稱呼你",
            fields: [field("name", "稱呼", { placeholder: "輸入「清除」取消", maxLength: 20 })],
          },
        },
        {
          id: "link",
          label: "連結其他帳號",
          path: "me link",
          ask: {
            title: "連結其他帳號",
            fields: [
              field("code", "連結代碼（可留空）", {
                placeholder: "留空 = 取得代碼，到另一個帳號輸入",
                required: false,
              }),
            ],
          },
        },
      ],
    },
    {
      // Commands come from the economy module; without it the page is hidden.
      id: "wallet",
      label: "錢包",
      description: `${coin}、簽到、餵${her.pronoun}`,
      refresh: true,
      status: [{ path: "me wallet", label: "我的錢包", args: { picture: false } }],
      actions: [
        { id: "checkin", label: "簽到", path: "me checkin", style: "primary" },
        { id: "rice", label: "餵一碗", path: "me feed", args: { item: "rice" } },
        { id: "big-bowl", label: "餵鋼盆", path: "me feed", args: { item: "big_bowl" } },
        {
          // Anything they name (`/me feed thing:`): a quote first, charged only on 確認.
          id: "gift",
          label: `送${her.pronoun}別的`,
          path: "me feed",
          ask: {
            title: `自己取名送${her.pronoun}一樣東西（先報價，確認才扣）`,
            fields: [field("thing", "想送什麼，例如「一杯珍奶」", { maxLength: 24 })],
          },
        },
        {
          id: "screen",
          label: "留言上大螢幕",
          path: "me screen",
          ask: {
            title: "留言上大螢幕",
            fields: [field("text", "留言（60 字內）", { maxLength: 60 })],
          },
        },
        {
          id: "danmaku",
          label: "發彈幕",
          path: "me danmaku",
          ask: {
            title: "發一則彈幕（她直播時，從畫面右邊飄過）",
            fields: [field("text", "彈幕（沒顯示出來的會自動退回）", { maxLength: 100 })],
          },
        },
        {
          id: "give",
          label: "轉給別人",
          path: "me give",
          ask: {
            title: `轉${coin}給別人（另收手續費，會燒掉）`,
            fields: [
              USER_FIELD,
              field("amount", `對方收到多少${coin}`, { placeholder: "1 到 50" }),
            ],
          },
        },
        { id: "board", label: "排行榜", path: "me board" },
      ],
    },
    {
      // The economy's second generation (quests, titles, predictions, her room). Commands come from the economy module; without it the page is hidden. 唱 K is the karaoke module's.
      id: "play",
      label: "一起玩",
      description: "每日任務、稱號、預測、她的房間、唱 K",
      refresh: true,
      status: [{ path: "me quests", label: "今天的任務" }],
      actions: [
        { id: "titles", label: "稱號", path: "me titles" },
        { id: "predictions", label: "看預測", path: "me predictions" },
        {
          id: "bet",
          label: "押預測",
          path: "me bet",
          ask: {
            title: `押${coin}猜結果`,
            fields: [
              field("prediction", "預測的代號", { placeholder: "「看預測」裡的代號" }),
              field("option", "選項的號碼或名字"),
              field("amount", `押多少${coin}`),
            ],
          },
        },
        { id: "room", label: "她的房間", path: "me room" },
        {
          id: "room-fund",
          label: "出錢佈置房間",
          path: "me room",
          ask: {
            title: `出${coin}佈置${her.pronoun}的房間`,
            fields: [field("item", "要出錢的東西（名字或代號）"), field("amount", `出多少${coin}`)],
          },
        },
        { id: "karaoke", label: "唱 K", path: "me karaoke" },
      ],
    },
    {
      // The card comes from the commands module itself (the api module gives it). The fortune slip
      // is the paid add-on of the check-in (`me checkin fortune:true`).
      id: "keepsakes",
      label: "卡片",
      description: "她給你的卡片",
      actions: [{ id: "card", label: "我的卡片", path: "me card", style: "primary" }],
    },
    {
      id: "wishes",
      label: "她的願望",
      description: "她的懸賞",
      refresh: true,
      status: [{ path: "me bounties", label: "她的懸賞" }],
      actions: [{ id: "bounties", label: "看懸賞", path: "me bounties", style: "primary" }],
    },
    {
      id: "memory",
      label: "記憶與刪除",
      description: "查看、匯出、忘記她記得的事",
      intro: ["你可以隨時查看、匯出或刪除她記得的關於你的事。刪除前會再確認一次。"],
      actions: [
        { id: "show", label: "查看", path: "me memory show", style: "primary" },
        { id: "export", label: "匯出", path: "me memory export" },
        {
          id: "forget",
          label: "忘記某件事",
          path: "me memory forget",
          ask: {
            title: "忘記某件事",
            fields: [field("target", "關鍵字", { placeholder: "她記得的內容裡的字" })],
          },
        },
        {
          id: "forget-all",
          label: "忘記全部",
          path: "me memory forget",
          args: { target: "all" },
          style: "danger",
        },
      ],
      extra: policy,
    },
  ];
}

// ---- /admin -------------------------------------------------------------------------------

function adminPages(): PanelPage[] {
  const person = (arg = "user") => ({ target: arg });
  return [
    {
      id: "modules",
      label: "模組",
      description: "查看、啟用、停用、重啟",
      actions: [
        { id: "list", label: "列出模組", path: "admin module list", style: "primary" },
        {
          id: "enable",
          label: "啟用",
          path: "admin module enable",
          style: "success",
          ask: { title: "啟用模組", fields: [MODULE_FIELD] },
        },
        {
          id: "disable",
          label: "停用",
          path: "admin module disable",
          style: "danger",
          ask: { title: "停用模組", fields: [MODULE_FIELD] },
        },
        {
          id: "restart",
          label: "重新啟動",
          path: "admin module restart",
          ask: { title: "重新啟動模組", fields: [MODULE_FIELD] },
        },
      ],
    },
    {
      id: "roles",
      label: "角色與權限",
      description: "角色、身分組對應、權限覆寫",
      focusable: true,
      actions: [
        { id: "list", label: "列出角色", path: "admin role list", style: "primary" },
        {
          id: "whois",
          label: "查詢某人的角色",
          path: "admin role whois",
          ask: { title: "查詢角色", fields: [{ ...USER_FIELD, required: false }] },
          ...person(),
        },
        {
          id: "assign",
          label: "指派角色",
          path: "admin role assign",
          ask: { title: "指派角色", fields: [USER_FIELD, ROLE_FIELD, SCOPE_FIELD] },
          ...person(),
        },
        {
          id: "revoke",
          label: "收回角色",
          path: "admin role revoke",
          ask: { title: "收回角色", fields: [USER_FIELD, ROLE_FIELD, SCOPE_FIELD] },
          ...person(),
        },
        {
          id: "map",
          label: "對應身分組",
          path: "admin role map",
          ask: {
            title: "把身分組對應到角色",
            fields: [field("discord_role", "Discord 身分組 ID 或 @提及"), ROLE_FIELD],
          },
        },
        {
          id: "unmap",
          label: "取消對應",
          path: "admin role unmap",
          ask: {
            title: "取消身分組對應",
            fields: [field("discord_role", "Discord 身分組 ID 或 @提及")],
          },
        },
        ...(["allow", "deny", "clear"] as const).map(
          (op): PanelAction => ({
            id: `perm-${op}`,
            label: { allow: "允許權限", deny: "禁止權限", clear: "清除覆寫" }[op],
            path: `admin perm ${op}`,
            ask: {
              title: { allow: "允許權限節點", deny: "禁止權限節點", clear: "清除權限覆寫" }[op],
              fields: [
                ROLE_FIELD,
                field("node", "權限節點", { placeholder: "例如 queue.skip 或 queue.*" }),
                SCOPE_FIELD,
              ],
            },
          }),
        ),
      ],
    },
    {
      id: "people",
      label: "她認識的人",
      description: "羈絆、標籤、封鎖",
      focusable: true,
      intro: ["也可以直接用 `/admin i user:@某人` 開啟並指定對象。"],
      actions: [
        { id: "show", label: "查看", path: "admin person show", style: "primary", ...person() },
        {
          id: "tag",
          label: "加標籤",
          path: "admin person tag",
          ask: {
            title: "加標籤",
            fields: [USER_FIELD, field("tag", "標籤", { placeholder: "friend" })],
          },
          ...person(),
        },
        {
          id: "untag",
          label: "移除標籤",
          path: "admin person untag",
          ask: { title: "移除標籤", fields: [USER_FIELD, field("tag", "標籤")] },
          ...person(),
        },
        { id: "block", label: "封鎖", path: "admin person block", style: "danger", ...person() },
        { id: "unblock", label: "解除封鎖", path: "admin person unblock", ...person() },
        {
          id: "reset",
          label: "重置印象",
          path: "admin person reset",
          style: "danger",
          ...person(),
        },
        {
          id: "adjust",
          label: "調整羈絆",
          path: "admin person adjust",
          ask: {
            title: "調整羈絆",
            fields: [USER_FIELD, field("affinity", "羈絆變化", { placeholder: "-1000 到 1000" })],
          },
          ...person(),
        },
      ],
    },
    rulesPage(false),
    {
      id: "data",
      label: "資料",
      description: "人格設定與記憶",
      actions: [
        { id: "persona", label: "人格設定", path: "admin persona show" },
        { id: "wipe", label: "清除記憶資料", path: "admin memory wipe", style: "danger" },
      ],
    },
  ];
}

// ---- registration -------------------------------------------------------------------------

export interface PanelsOptions {
  services?: ServiceLookup | null;
  /** The privacy policy link shown on `/me`. */
  policyUrl?: string | null;
}

/** The four panels (see the page tables above). */
export function panelDefs(options: PanelsOptions = {}): PanelDef[] {
  const policyUrl = options.policyUrl?.trim() || null;
  // Who she is in this profile (docs/design/v5-profiles.md); Miyoria without a running Core.
  const her = options.services?.get(CharacterKey) ?? DEFAULT_CHARACTER;
  return [
    {
      command: "miyo",
      title: `${her.name} 控制面板`,
      description: "她的控制面板：語音、直播、遊戲、聊天等級與緊急停止",
      pages: miyoPages(),
    },
    {
      command: "song",
      title: "點歌",
      description: "點歌與歌單",
      pages: songPages(),
    },
    {
      command: "me",
      title: "我的面板",
      description: "你的資料、隱私、語音同意與她記得的事",
      ephemeral: true,
      pages: mePages(policyUrl, her, options.services?.get(CurrencyKey) ?? DEFAULT_CURRENCY),
    },
    {
      command: "admin",
      title: "管理",
      description: "模組、角色權限、她認識的人與資料",
      ephemeral: true,
      args: [argSpec("user", "要處理的人（選填）", ArgKind.user, { required: false })],
      pages: adminPages(),
      open: (inv) => {
        const user = inv.str("user");
        return user === null ? {} : { page: "people", target: user };
      },
      rest: {
        id: "more",
        label: "其他指令",
        description: "沒有專屬按鈕的指令（例如擴充提供的）",
      },
    },
  ];
}

/** Registers the four panels. */
export function registerPanels(registry: CommandRegistry, options: PanelsOptions = {}): void {
  const defs = panelDefs(options);
  const mapped = mappedPaths(defs);
  // `help` stays a command of its own.
  mapped.add("help");
  for (const def of defs) {
    registerPanelCommand(registry, def, { services: options.services ?? null, mapped });
  }
}

/** The commands the panels run (their paths), for tests and docs. */
export function panelCommandPaths(options: PanelsOptions = {}): string[] {
  return [...mappedPaths(panelDefs(options))].sort();
}
