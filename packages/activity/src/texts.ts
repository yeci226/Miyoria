// What she reads about transitions: the tool answers and the notices (zh-TW; she says it in her
// own words). Specifics (`detail`) may contain untrusted names (games, channels).

import type { ActivityRequest, TaskFailureCode, TransitionResult } from "@miyoria/types";

/** Short form of a task id for her ("task 4F2K9Q"). */
export function shortTask(id: string): string {
  return id.slice(-6);
}

const ACTIVITY_NAMES: Readonly<Record<string, string>> = {
  chatting: "聊天",
  singing: "唱歌",
  game: "遊戲",
  browse: "瀏覽",
};

function gameName(target: string | null): string {
  if (target === null || target === "") return "遊戲";
  return target.length <= 1 ? target.toUpperCase() : target[0]?.toUpperCase() + target.slice(1);
}

/** What the request is about, as a noun phrase ("開台", "Minecraft"). */
export function what(request: ActivityRequest): string {
  switch (request.type) {
    case "ensure_voice":
      return "進語音頻道";
    case "leave_voice":
      return "離開語音頻道";
    case "ensure_live":
      return "開台";
    case "stop_live":
      return "關台";
    case "start":
      return request.activity === "game"
        ? `開始玩 ${gameName(request.target)}`
        : `開始${ACTIVITY_NAMES[request.activity] ?? request.activity}`;
    case "stop":
      return request.activity === null
        ? "停止目前的活動"
        : `停止${ACTIVITY_NAMES[request.activity] ?? request.activity}`;
    case "scene_override":
      return `切到場景 ${request.scene}`;
    case "clear_override":
      return "回到自動場景";
  }
}

/** Notice text when the task is done. */
export function doneText(request: ActivityRequest, detail: string, name: string | null): string {
  switch (request.type) {
    case "ensure_voice":
      return "進語音頻道了。";
    case "leave_voice":
      return "離開語音頻道了。";
    case "ensure_live":
      return detail === "" ? "開台了。" : `開台了(${detail})。`;
    case "stop_live":
      return "關台了。";
    case "start":
      return request.activity === "game"
        ? `${name ?? gameName(request.target)} 開好了,已經開始玩。`
        : `${what(request)}了。`;
    case "stop":
      return name !== null ? `停止玩 ${name} 了。` : "停下來了。";
    case "scene_override":
    case "clear_override":
      return `${what(request)}了。`;
  }
}

/** Notice text when the task failed. */
export function failedText(
  request: ActivityRequest,
  code: TaskFailureCode,
  detail: string,
  name: string | null,
): string {
  const why = detail === "" ? CODE_TEXT[code] : detail;
  switch (request.type) {
    case "ensure_live":
      return `開台失敗:${why}`;
    case "stop_live":
      return `關台失敗:${why}`;
    case "start":
      return request.activity === "game"
        ? `${name ?? gameName(request.target)} 沒有開成:${why}`
        : `${what(request)}失敗:${why}`;
    default:
      return `${what(request)}失敗:${why}`;
  }
}

/** A game that ended by itself (`disconnected`, `crashed`). */
export function endedText(
  name: string,
  code: TaskFailureCode | null,
  reason: string | null,
): string {
  const why =
    code === "disconnected"
      ? "遊戲被關掉或斷線了(可能是有人關的,不是要你重開)"
      : code === "crashed"
        ? "遊戲的擴充套件當掉了"
        : (reason ?? "遊戲停止了");
  return `${name} 結束了:${why}。場景已經切回來。`;
}

export const CODE_TEXT: Readonly<Record<TaskFailureCode, string>> = {
  timeout: "等太久了",
  cancelled: "取消了",
  superseded: "被新的要求取代了",
  busy: "正在忙別的事",
  invalid: "要求看不懂",
  not_found: "找不到",
  unreachable: "到不了",
  precondition: "條件不足",
  disconnected: "連線斷了",
  crashed: "程式當掉了",
  died: "死掉了",
  denied: "不被允許",
  internal: "出了點問題",
};

/** The tool answer for an accepted / refused request (`detach`). */
export function answerText(request: ActivityRequest, result: TransitionResult): string {
  switch (result.status) {
    case "started":
      return `${what(request)}:開始了(task ${shortTask(result.task)})。好了或失敗都會再通知你,不用重複呼叫,先用自己的話回應。`;
    case "queued":
      return `${what(request)}:排在前一件事後面(task ${shortTask(result.task)})。好了會再通知你,不用重複呼叫。`;
    case "already":
      return result.task === null
        ? `${what(request)}:現在已經是這樣了,不用再做。`
        : `${what(request)}:已經在進行中(task ${shortTask(result.task)}),不用重複呼叫。`;
    case "refused":
      return `${what(request)}:沒辦法(${result.detail})。`;
  }
}
