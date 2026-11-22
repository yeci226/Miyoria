import type { ReportDraftView, ReportStatus } from "@miyoria/contracts/api";
import type { Tone } from "@/components/status";

/** The areas she files a report under (the tool's list), in the panel's words. */
export const AREA_LABEL: Record<string, string> = {
  voice: "語音",
  sing: "唱歌",
  karaoke: "卡拉 OK",
  chat: "聊天",
  memory: "記憶",
  economy: "金幣",
  cards: "卡片",
  market: "市集",
  game: "遊戲",
  stream: "直播",
  panel: "管理面板",
  member_page: "成員頁面",
  other: "其他",
};

export const areaLabel = (area: string) => AREA_LABEL[area] ?? area;

export const STATUS: Record<ReportStatus, { label: string; tone: Tone }> = {
  draft: { label: "待審核", tone: "warning" },
  opening: { label: "正在開 issue", tone: "warning" },
  commenting: { label: "正在留言", tone: "warning" },
  opened: { label: "已開 issue", tone: "success" },
  commented: { label: "已加到 issue", tone: "success" },
  duplicate: { label: "重複", tone: "neutral" },
  rejected: { label: "已拒絕", tone: "neutral" },
};

/** Still waiting on the owner (or on GitHub). */
export const isPending = (d: ReportDraftView) => d.status === "draft" || d.status === "opening" || d.status === "commenting";

export const PLACE: Record<NonNullable<ReportDraftView["place"]>, string> = {
  channel: "頻道",
  dm: "私訊",
  other: "其他地方",
};

/** How GitHub says an issue was closed. */
export function closeLabel(reason: string | null): string {
  switch (reason) {
    case "completed":
    case null:
      return "做完關掉了";
    case "not_planned":
      return "不打算處理";
    case "duplicate":
      return "以重複關掉";
    default:
      return `關掉了(${reason})`;
  }
}

/** An issue number typed in a field: `12` or `#12`; `null` for anything else. */
export function parseIssue(raw: string): number | null {
  const m = /^\s*[#＃]?(\d{1,9})\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}
