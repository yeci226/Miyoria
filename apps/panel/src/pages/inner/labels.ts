import type {
  AgendaStatus,
  DriveName,
  IntentStatus,
  PresenceActivity,
  PresenceStatus,
  ThoughtTriggerKind,
} from "@/api/types";
import type { Tone } from "@/components/status";

export const DRIVE_LABEL: Record<DriveName, string> = {
  social: "想聊天",
  play: "想玩",
  attention: "想被注意",
  rest: "想休息",
  curiosity: "好奇",
};

export const DRIVE_ORDER: DriveName[] = ["social", "play", "attention", "rest", "curiosity"];

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: "在線",
  idle: "閒置",
  dnd: "請勿打擾",
  offline: "離線",
};

export const PRESENCE_TONE: Record<PresenceStatus, Tone> = {
  online: "success",
  idle: "warning",
  dnd: "danger",
  offline: "neutral",
};

export const AGENDA_LABEL: Record<AgendaStatus, string> = {
  open: "進行中",
  done: "完成",
  expired: "過期",
  dropped: "放棄",
};

export const AGENDA_TONE: Record<AgendaStatus, Tone> = {
  open: "brand",
  done: "success",
  expired: "neutral",
  dropped: "neutral",
};

export const TRIGGER_LABEL: Record<ThoughtTriggerKind, string> = {
  heartbeat: "心跳",
  salient: "周遭變化",
  suggestion: "契機",
  turn: "講完話",
  voice_quiet: "語音冷場",
  manual: "手動",
};

export const INTENT_LABEL: Record<IntentStatus, string> = {
  pending: "等待",
  started: "進行中",
  done: "完成",
  denied: "擋下",
  dropped: "放棄",
  failed: "失敗",
};

export const INTENT_TONE: Record<IntentStatus, Tone> = {
  pending: "neutral",
  started: "brand",
  done: "success",
  denied: "danger",
  dropped: "neutral",
  failed: "warning",
};

/** Where the gate decided. */
export const STAGE_LABEL: Record<string, string> = {
  unknown: "未知能力",
  args: "參數",
  pause: "暫停",
  prohibition: "禁止",
  consent: "對方意願",
  permission: "權限",
  budget: "額度",
  risk: "風險",
  rate: "次數",
  review: "審核",
  escalation: "擁有者",
};

/** `*` / `voice` / `text` / `discord:<guild>` / a context string, in words. */
export function scopeLabel(scope: string): string {
  if (scope === "*") return "所有地方";
  if (scope === "voice") return "所有語音頻道";
  if (scope === "text") return "所有文字頻道";
  const parts = scope.split(":");
  if (parts.length === 2) return `伺服器 ${parts[1]}`;
  if (parts.length === 4 && parts[2] === "voice") return `語音 ${parts[3]}`;
  if (parts.length === 3) return parts[1] === "dm" ? `私訊 ${parts[2]}` : `#${parts[2]}`;
  return scope;
}

/** What someone is doing, in one short phrase. */
export function activityText(a: PresenceActivity): string | null {
  switch (a.type) {
    case "playing":
      return a.name ? `玩 ${a.name}` : null;
    case "listening":
      if (a.details) return `聽 ${a.details}${a.state ? ` — ${a.state}` : ""}`;
      return a.name ? `聽 ${a.name}` : null;
    case "streaming":
      return a.details ? `直播 ${a.details}` : "直播中";
    case "watching":
      return a.name ? `看 ${a.name}` : null;
    case "competing":
      return a.name ? `比賽 ${a.name}` : null;
    case "custom": {
      const text = [a.details, a.name].filter(Boolean).join(" ");
      return text ? `「${text}」` : null;
    }
  }
}

/** Her emotions (`EMOTION_LABELS` of `packages/types/src/self.ts`). */
export const EMOTION_LABEL: Record<string, string> = {
  joy: "喜",
  anger: "怒",
  sorrow: "哀",
  fear: "懼",
  surprise: "驚",
  disgust: "厭",
  shy: "害羞",
  pride: "得意",
  jealousy: "嫉妒",
  lonely: "寂寞",
  missing: "想念",
  gratitude: "感激",
  guilt: "愧疚",
  frustration: "不甘心",
  resentment: "不爽",
};

/** All drives, including the newer ones the `self` card does not show. */
export const AFFECT_DRIVE_LABEL: Record<string, string> = {
  ...DRIVE_LABEL,
  esteem: "想被肯定",
  hunger: "想吃白飯",
  longing: "想靠近在意的人",
};

export const AFFECT_DRIVE_ORDER: string[] = [...DRIVE_ORDER, "esteem", "hunger", "longing"];

/** What the bias table calls the things she may want to do (`AffectBiases.wants`). */
export const WANT_LABEL: Record<string, string> = {
  chat_with: "找人聊天",
  find_person: "去找某個人",
  play: "玩遊戲",
  stream: "開台",
  rest: "休息",
  sing: "唱歌",
  explore: "找點新鮮事",
  goal: "做目標裡的事",
};

export const GOAL_STATUS_LABEL: Record<string, string> = {
  pending: "等待",
  active: "進行中",
  done: "完成",
  dropped: "放棄",
};

export const GOAL_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  active: "brand",
  done: "success",
  dropped: "neutral",
};

export const GOAL_SOURCE_LABEL: Record<string, string> = {
  plan: "她的計畫",
  plan_daily: "今日計畫",
  reflect: "反思",
  panel: "面板",
};
