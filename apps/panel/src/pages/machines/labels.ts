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

// --- job dispatch (v5-hostd §15) -------------------------------------------------------

export type ServiceRouting = NonNullable<ServiceStatus["routing"]>;
export type ServiceLoad = NonNullable<ServiceStatus["load"]>;

export const ROUTING_CLASS: Record<ServiceRouting["class"], string> = { single: "唯一", session: "工作階段", job: "工作" };

export const ROUTING_LATENCY: Record<ServiceRouting["latency"], string> = { realtime: "即時", interactive: "互動", batch: "批次" };

export const SPEECH_MODE: Record<"never" | "when_idle" | "always", string> = {
  never: "不送到她語音所在的電腦",
  when_idle: "她閒置時才可以",
  always: "都可以",
};

/** `12.3 秒` from seconds; whole seconds from 100 up. */
export const fmtSeconds = (s: number): string => `${s < 100 ? s.toFixed(1) : Math.round(s)} 秒`;

/** `2.0 秒` from ms, for the parts of a score. */
export const fmtMsAsSeconds = (ms: number): string => fmtSeconds(ms / 1000);

/** `執行 1 · 排隊 2`, with what Core sent that the host's report does not show yet. */
export function loadWords(load: Pick<ServiceLoad, "running" | "queued">, pending = 0): string {
  const parts = [`執行 ${load.running}`, `排隊 ${load.queued}`];
  if (pending > 0) parts.push(`剛送出 ${pending}`);
  return parts.join(" · ");
}

/** What a host reports of one service's routing, in short words; nothing from an older hostd. */
export function serviceRoutingLines(s: ServiceStatus): { text: string; alert?: boolean }[] {
  const r = s.routing;
  const lines: { text: string; alert?: boolean }[] = [];
  if (r) {
    lines.push({ text: `${ROUTING_CLASS[r.class]} · ${r.ready ? "就緒" : "沒準備好"}` });
    if (!r.ready && r.reason) lines.push({ text: r.reason, alert: true });
    if (!r.accept) lines.push({ text: "這台的主人不接受工作", alert: true });
    if (r.owner_concurrency !== undefined) lines.push({ text: `主人限制同時 ${r.owner_concurrency} 個` });
  }
  if (s.load) {
    lines.push({ text: loadWords(s.load) });
    if (s.load.outside) lines.push({ text: s.load.outside });
  }
  return lines;
}

// --- versions and remote updates (v5-hostd §14) ----------------------------------------

export type HostCheckout = NonNullable<ClusterHostView["checkout"]>;
export type UpgradeJob = NonNullable<ClusterHostView["upgrade"]>;
export type UpgradeStep = UpgradeJob["steps"][number];

/** The first 8 characters of a commit, as git people read it. */
export const shortSha = (sha: string): string => sha.slice(0, 8);

/** How a host's commit stands to Core's, in words. */
export function relationView(relation: ClusterHostView["relation"]): { label: string; tone: Tone } | null {
  if (relation === undefined) return null;
  switch (relation.relation) {
    case "same":
      return { label: "與 Core 相同", tone: "success" };
    case "behind":
      return { label: `落後 Core ${relation.count ?? "?"} 個提交`, tone: "warning" };
    case "ahead":
      return { label: `比 Core 新 ${relation.count ?? "?"} 個提交`, tone: "neutral" };
    case "diverged":
      return { label: "和 Core 分岔", tone: "danger" };
    default:
      return { label: "無法和 Core 比較", tone: "neutral" };
  }
}

export const UPGRADE_STATE: Record<UpgradeJob["state"], { label: string; tone: Tone; pulse: boolean }> = {
  waiting: { label: "等她忙完", tone: "warning", pulse: true },
  running: { label: "更新中", tone: "brand", pulse: true },
  done: { label: "已更新", tone: "success", pulse: false },
  failed: { label: "更新失敗", tone: "danger", pulse: false },
  refused: { label: "沒有更新", tone: "neutral", pulse: false },
  cancelled: { label: "已取消", tone: "neutral", pulse: false },
};

export const UPGRADE_STEP: Record<UpgradeStep["step"], string> = {
  check: "檢查",
  fetch: "取得新版",
  wait: "等她忙完",
  merge: "快轉",
  install: "安裝套件",
  sync: "同步 Python 環境",
  restart: "重啟服務",
  verify: "確認服務",
  rollback: "退回原本的版本",
};

export const STEP_STATE: Record<UpgradeStep["state"], string> = {
  running: "進行中",
  done: "完成",
  failed: "失敗",
  skipped: "略過",
};

export const MISSING_KIND: Record<NonNullable<UpgradeJob["missing"]>[number]["kind"], string> = {
  file: "模型檔",
  model: "模型",
  manual: "要自己放的",
};

export const upgradeActive = (job: ClusterHostView["upgrade"]): boolean =>
  job?.state === "running" || job?.state === "waiting";

/**
 * Whether the panel can ask this host to update to Core's commit, and why not. The host decides
 * again by its own rules; this only keeps the obvious no from being sent.
 */
export function updatable(host: ClusterHostView): { ok: boolean; reason?: string } {
  if (host.status !== "approved") return { ok: false, reason: "還沒核可" };
  if (!host.connected) return { ok: false, reason: "沒有連線" };
  if (host.remote_update === undefined) return { ok: false, reason: "這台的 hostd 比較舊,版本不明" };
  if (!host.remote_update.allowed) return { ok: false, reason: host.remote_update.reason ?? "這台不接受遠端更新" };
  if (upgradeActive(host.upgrade)) return { ok: false, reason: "正在更新" };
  if (host.checkout?.dirty) return { ok: false, reason: "這台有還沒提交的變更" };
  switch (host.relation?.relation) {
    case "same":
      return { ok: false, reason: "已經是 Core 的版本" };
    case "ahead":
      return { ok: false, reason: "比 Core 的版本新" };
    case "diverged":
      return { ok: false, reason: "和 Core 分岔了" };
    default:
      return { ok: true };
  }
}
