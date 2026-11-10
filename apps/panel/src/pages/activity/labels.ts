import type {
  ActivityPhase,
  ActivityRequest,
  ActivityResource,
  ActivityTask,
  ActivityType,
  ArbiterReason,
  ArbiterVerdict,
  LedgerKind,
  LedgerOutcome,
  TurnCancelCause,
  TurnOutcome,
  TurnReason,
} from "@/api/types";
import type { Tone } from "@/components/status";

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  idle: "閒著",
  chatting: "聊天",
  singing: "唱歌",
  game: "玩遊戲",
  browse: "逛網站",
};

export const PHASE_LABEL: Record<ActivityPhase, string> = {
  starting: "開始中",
  running: "進行中",
  stopping: "結束中",
  failed: "失敗",
};

export const PHASE_TONE: Record<ActivityPhase, Tone> = {
  starting: "warning",
  running: "success",
  stopping: "warning",
  failed: "danger",
};

export const PRESENCE_STATE_LABEL = {
  none: "不在語音",
  joining: "正在加入語音",
  in: "在語音",
  leaving: "正在離開語音",
} as const;

export const BROADCAST_STATE_LABEL = {
  off: "沒有開台",
  starting: "開台中",
  live: "直播中",
  stopping: "收台中",
} as const;

export const RESOURCE_LABEL: Record<ActivityResource, string> = {
  presence: "語音",
  broadcast: "直播",
  activity: "活動",
};

export const TASK_STATUS_LABEL: Record<ActivityTask["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  done: "完成",
  failed: "失敗",
};

export const TASK_STATUS_TONE: Record<ActivityTask["status"], Tone> = {
  queued: "neutral",
  running: "brand",
  done: "success",
  failed: "danger",
};

/** Why a task or activity failed (`TaskFailureCode`). */
export const FAILURE_LABEL: Record<string, string> = {
  timeout: "逾時",
  cancelled: "被取消",
  superseded: "被新的取代",
  busy: "正忙著",
  invalid: "指令看不懂",
  not_found: "找不到目標",
  unreachable: "到不了",
  precondition: "條件不足",
  disconnected: "連線中斷",
  crashed: "程式當掉",
  died: "死掉了",
  denied: "被拒絕",
  internal: "內部錯誤",
};

/** A transition request in words. */
export function requestLabel(r: ActivityRequest): string {
  switch (r.type) {
    case "ensure_voice":
      return "加入語音";
    case "leave_voice":
      return "離開語音";
    case "ensure_live":
      return "開台";
    case "stop_live":
      return "收台";
    case "start":
      return `開始${ACTIVITY_TYPE_LABEL[r.activity]}${r.target ? `(${r.target})` : ""}`;
    case "stop":
      return r.activity ? `停止${ACTIVITY_TYPE_LABEL[r.activity]}` : "停止目前的活動";
    case "scene_override":
      return `切到場景「${r.scene}」`;
    case "clear_override":
      return "取消場景覆蓋";
  }
}

export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  impulse: "念頭",
  turn: "回合",
  task: "任務",
  notice: "通知",
};

export const LEDGER_OUTCOME_LABEL: Record<LedgerOutcome, string> = {
  pending: "等待中",
  ok: "成功",
  ignored: "沒人理",
  failed: "失敗",
  denied: "被擋下",
};

export const LEDGER_OUTCOME_TONE: Record<LedgerOutcome, Tone> = {
  pending: "brand",
  ok: "success",
  ignored: "warning",
  failed: "danger",
  denied: "danger",
};

export const SOURCE_LABEL: Record<string, string> = {
  message: "訊息",
  plan: "她的計畫",
  agenda: "目標",
  followup: "跟進",
  notice: "通知",
  game: "遊戲旁白",
  song: "歌",
  world: "周遭變化",
  command: "指令",
  panel: "面板",
};

export const VERDICT_LABEL: Record<ArbiterVerdict, string> = {
  accepted: "通過",
  merged: "合併",
  deferred: "延後",
  rejected: "擋下",
  preempted: "被插隊",
  expired: "過期",
};

export const VERDICT_TONE: Record<ArbiterVerdict, Tone> = {
  accepted: "success",
  merged: "neutral",
  deferred: "warning",
  rejected: "danger",
  preempted: "warning",
  expired: "neutral",
};

export const REASON_LABEL: Record<ArbiterReason, string> = {
  budget: "預算用完",
  rate: "次數上限",
  cooldown: "冷卻中",
  quiet_hours: "安靜時段",
  consent: "對方沒同意",
  paused: "自主已暫停",
  ceiling: "頻道等級限制",
  busy: "正忙著",
  unanswered: "上次沒人回",
  superseded: "被更急的取代",
  expired: "過期",
  denied: "閘門拒絕",
};

export const TURN_REASON_LABEL: Record<TurnReason, string> = {
  addressed: "被叫到",
  reply_to_her: "回她的話",
  ambient: "自己插話",
  initiative: "主動開話題",
  notice: "收到通知",
};

export const CANCEL_LABEL: Record<TurnCancelCause, string> = {
  input: "有新訊息",
  barge_in: "被打斷",
  superseded: "被更急的取代",
  expired: "來不及",
  floor: "場地被佔用",
  shutdown: "模組停止",
};

export const OUTCOME_KINDS = ["sent", "silence", "cancelled", "error"] as const;

export const OUTCOME_KIND_LABEL: Record<(typeof OUTCOME_KINDS)[number], string> = {
  sent: "說了",
  silence: "沒說話",
  cancelled: "取消",
  error: "出錯",
};

export const OUTCOME_TONE: Record<(typeof OUTCOME_KINDS)[number], Tone> = {
  sent: "success",
  silence: "neutral",
  cancelled: "warning",
  error: "danger",
};

/** One line for a turn outcome (`說了 2 則`, `被打斷(Owen)`). */
export function outcomeText(o: TurnOutcome): string {
  switch (o.type) {
    case "sent":
      return `說了 ${o.parts} 則`;
    case "silence":
      return "選擇沉默";
    case "cancelled":
      return `${CANCEL_LABEL[o.cause] ?? o.cause}${o.by ? `(${o.by})` : ""}`;
    case "error":
      return `出錯:${o.error}`;
  }
}
