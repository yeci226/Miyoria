// What step B6 writes for her to read (her inbox, why she was woken, the `schedule` tools), beside
// the runner's own texts (`self/src/rules.ts`). The owner has not read these yet; each is a
// candidate for rules.ts, where they move once reviewed.

import { neutralize, safeName } from "@miyoria/types";
import type { InboxKind } from "./initiative-schema.js";

const flat = (text: string, max = 160): string => {
  const chars = [...neutralize(text).replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

// ---- block 6: her inbox -------------------------------------------------------------------------

/** Title of her inbox (block 6). */
export const INBOX_TITLE = "你的收件匣(不是對話,是給你的事)";

/** What each kind of item is, as the line's head. */
export const INBOX_LABELS: Readonly<Record<InboxKind, string>> = {
  timer: "你設的時間到了",
  world: "外面發生的事",
  followup: "之前想追問的事",
  commitment: "答應過、已經過了時間的事",
  result: "回來的結果",
};

/** The mark of an item that belongs to no place (her home). */
export const INBOX_HOME = "(不屬於哪個地方)";

// ---- block 7: why she was woken (the note of a `self` wake) -------------------------------------

export const WAKE_NOTES = {
  followup: (text: string) => `之前想追問的事到時間了:「${flat(text)}」`,
  commitment: (text: string) => `你答應過的事已經過了時間:「${flat(text)}」`,
  quiet: (items: number, promises: number) =>
    `這裡安靜一陣子了;${items > 0 ? `你的收件匣有 ${items} 件事` : ""}${
      items > 0 && promises > 0 ? "," : ""
    }${promises > 0 ? `你有 ${promises} 件答應過的事還沒做` : ""}`,
  longing: (name: string) =>
    `你有點想念 ${safeName(name)};這裡是你和他的私訊,要不要找他說話由你決定`,
  morning: "早上了,這是你今天第一次醒來",
} as const;

// ---- the `schedule` tools -----------------------------------------------------------------------

export const SCHEDULE_TOOL = {
  description:
    "設一個你自己之後醒來的時間:時間到了你會在那個地方醒來,看到你寫的 note,要不要說話、做什麼由你決定。" +
    "when 可以是相對的(「30m」「2h」「in 45m」「30分鐘後」「2小時後」)、" +
    "「20:00」(下一次到這個時間)、「2026-11-17 20:00」(都是你的當地時間)," +
    "或每天(「daily 08:00」「每天 08:00」)。where 省略就是你現在這個地方。數量和最遠天數有上限。",
  when: "什麼時候:「30m」「2h」「20:00」「2026-11-17 20:00」「daily 08:00」",
  note: "到時候要想起的事(用你自己的話,一句)",
  where: "在哪裡叫醒你:頻道的名字或代號(可省略,省略就是這裡)",
  set: (key: string, when: string, daily: boolean) =>
    `設好了(${key}),還沒到時間:${daily ? `每天 ${when}` : when}會叫你。`,
  unreadable: (when: string) =>
    `看不懂「${flat(when, 40)}」這個時間。用「30m」「2h」「20:00」「2026-11-17 20:00」或「daily 08:00」。`,
  past: "這個時間已經過了。",
  tooFar: (days: number) => `最多只能設 ${days} 天內的時間。`,
  tooMany: (n: number, max: number) => `已經設了 ${n} 個(上限 ${max}),先取消一些。`,
  perPerson: (max: number) => `這個人已經有 ${max} 個提醒在等了,先取消一個。`,
  empty: "要給 when(什麼時候)和 note(要想起什麼)。",
  unknownPlace: (place: string) => `找不到「${flat(place, 64)}」這個地方,沒有設。`,
  dmPlace: "私訊的地方不能用名字指定:在那個私訊裡設,或省略 where。",
} as const;

export const SCHEDULE_LIST_TOOL = {
  description: "列出你設的、還在等的時間(也包括 remind_me 的提醒),每個有代號。",
  none: "沒有在等的時間。",
  daily: "(每天)",
  here: "這裡",
  home: "你家(不在哪個地方)",
} as const;

export const SCHEDULE_CANCEL_TOOL = {
  description: "用代號(例如 S7XK2P)取消一個你設的時間。",
  id: "要取消的代號",
  cancelled: (key: string, note: string) => `取消了 ${key}:${flat(note)}`,
  notFound: "找不到這個代號,沒有取消。",
} as const;
