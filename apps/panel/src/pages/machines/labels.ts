import type { ClusterHostInfo, ClusterHostView } from "@miyoria/contracts/api";
import type { Tone } from "@/components/status";

export type ServiceStatus = ClusterHostInfo["services"][number];
export type ServiceState = ServiceStatus["state"];
export type HostStatus = ClusterHostView["status"];

export const HOST_STATUS: Record<HostStatus, { label: string; tone: Tone }> = {
  pending: { label: "待核可", tone: "warning" },
  approved: { label: "已核可", tone: "success" },
  revoked: { label: "已撤銷", tone: "neutral" },
};

export const LINK_STATE: Record<string, string> = {
  none: "沒有設定連線",
  connecting: "正在連線到 Core",
  unauthorized: "金鑰被 Core 拒絕",
  stopped: "連線已停止",
};

export const GPU_POLICY: Record<NonNullable<ServiceStatus["gpu"]>["policy"], string> = {
  pinned: "常駐",
  evictable: "可讓出",
  on_demand: "用時才載入",
  reserve: "保留",
};

export const SERVICE_KIND: Record<ServiceStatus["kind"], string> = {
  worker: "工作程序",
  node: "節點",
  external: "外部程式",
};

export interface ServiceView {
  label: string;
  tone: Tone;
  pulse: boolean;
  /** Said in words under the badge, never in a tooltip. */
  note?: string;
}

/** How one service reads at a glance: running and healthy is calm, the rest says what is wrong. */
export function serviceView(s: ServiceStatus): ServiceView {
  switch (s.state) {
    case "running":
      return s.healthy
        ? { label: "執行中", tone: "success", pulse: false }
        : { label: "不健康", tone: "danger", pulse: false, note: s.reason ?? "執行中,但健康檢查沒有通過" };
    case "starting":
      return { label: "啟動中", tone: "warning", pulse: true };
    case "stopping":
      return { label: "停止中", tone: "warning", pulse: true };
    case "backoff":
      return { label: "等待重試", tone: "warning", pulse: true, note: s.reason };
    case "failed":
      return { label: "失敗", tone: "danger", pulse: false, note: s.reason ?? "沒有說明原因" };
    case "stopped":
      return { label: "已停止", tone: "neutral", pulse: false };
    case "external":
      return { label: "外部程式", tone: s.healthy ? "success" : "neutral", pulse: false, note: s.healthy ? undefined : "沒有回應" };
    case "foreign":
      return { label: "外部啟動", tone: "warning", pulse: false, note: "有人在外面啟動了它" };
    case "disabled":
      return { label: "已停用", tone: "neutral", pulse: false, note: s.reason };
    default:
      return { label: s.state, tone: "neutral", pulse: false };
  }
}

export type ServiceAction = "start" | "stop" | "restart";

/** What the panel offers: services the host did not start, or has switched off, have no actions. */
export function serviceActions(s: ServiceStatus): ServiceAction[] {
  switch (s.state) {
    case "stopped":
    case "failed":
      return ["start"];
    case "starting":
      return ["stop"];
    case "running":
    case "backoff":
      return ["stop", "restart"];
    default:
      return [];
  }
}

export const ACTION_LABEL: Record<ServiceAction, string> = { start: "啟動", stop: "停止", restart: "重啟" };

/** `3 分鐘`, `2 小時 5 分`, `4 天`: how long something has been the way it is. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "剛剛";
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} 小時` : `${h} 小時 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

/** MB as GB with one decimal. */
export const fmtGb = (mb: number): string => (mb / 1024).toFixed(1);

/** `m:ss` for a countdown. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Capability names typed in a field: split on commas, spaces and newlines. */
export const parseCapabilities = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,,、]+/)
      .map((c) => c.trim())
      .filter(Boolean),
  ),
];

/** What the host's services provide, in first-seen order. */
export const reportedCapabilities = (services: ServiceStatus[]): string[] => [...new Set(services.flatMap((s) => s.provides))];
