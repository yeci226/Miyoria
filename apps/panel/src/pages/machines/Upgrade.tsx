import { ChevronRight, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import type { ClusterHostView } from "@miyoria/contracts/api";
import { useClusterCheckout, useClusterMutations } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { Dot, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  MISSING_KIND,
  relationView,
  STEP_STATE,
  shortSha,
  UPGRADE_STATE,
  UPGRADE_STEP,
  type UpgradeJob,
  upgradeActive,
  updatable,
} from "./labels";

const iso = (ms: number) => new Date(ms).toISOString();

// --- one host's version ------------------------------------------------------------

/** `main · 1a2b3c4d`, how it stands to Core's, and whether it takes updates from here. */
export function VersionLine({ host }: { host: ClusterHostView }) {
  if (!host.connected) return null;
  if (host.checkout === undefined) {
    return <p className="text-xs text-muted-foreground">版本不明(這台的 hostd 比較舊),不能從面板更新</p>;
  }
  const relation = relationView(host.relation);
  const blocked = host.remote_update && !host.remote_update.allowed ? host.remote_update.reason : undefined;
  return (
    <div className="grid gap-1 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {host.checkout === null ? (
          <span className="text-muted-foreground">不是 git checkout</span>
        ) : (
          <span className="font-mono text-xs" title={host.checkout.commit}>
            {host.checkout.branch ?? "detached"} · {shortSha(host.checkout.commit)}
          </span>
        )}
        {relation && (
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={relation.tone} />
            {relation.label}
          </span>
        )}
        {host.checkout?.dirty && <span className="text-primary">有還沒提交的變更</span>}
      </div>
      {blocked && <p className="text-xs text-muted-foreground">不能從面板更新:{blocked}</p>}
    </div>
  );
}

// --- one host's update -------------------------------------------------------------

function StepRows({ job, now }: { job: UpgradeJob; now: number }) {
  return (
    <ol aria-label="更新步驟" className="grid">
      {job.steps.map((s, i) => (
        <li
          // A step can repeat (waiting twice): its place in the list, which only grows, is its identity.
          key={i}
          className="grid grid-cols-[8rem_4rem_1fr] gap-x-3 border-b border-line-soft py-1.5 text-xs last:border-0 max-sm:grid-cols-[7rem_1fr]"
        >
          <span>{UPGRADE_STEP[s.step]}</span>
          <span className={cn(s.state === "failed" ? "text-primary" : "text-muted-foreground")}>{STEP_STATE[s.state]}</span>
          <span className="min-w-0 break-words text-muted-foreground max-sm:col-span-2" title={fmtDateTime(iso(s.at))}>
            {s.detail ?? ""}
            {s.state === "running" && <span className="ml-2 tabular-nums">{fmtRelative(iso(s.at), now)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Outcome({ job }: { job: UpgradeJob }) {
  const lines: Array<{ label: string; value: string; alert?: boolean }> = [];
  if (job.commit) lines.push({ label: "現在的版本", value: shortSha(job.commit) });
  if (job.rolled_back) lines.push({ label: "退回", value: `已回到 ${job.from ? shortSha(job.from) : "原本的版本"}` });
  if (job.restarted?.length) lines.push({ label: "重啟了", value: job.restarted.join("、") });
  for (const s of job.not_restarted ?? []) lines.push({ label: "還沒重啟", value: `${s.service}:${s.reason}` });
  for (const s of job.failed ?? []) lines.push({ label: "沒有起來", value: `${s.service}:${s.reason}`, alert: true });
  for (const m of job.missing ?? []) {
    lines.push({ label: `缺${MISSING_KIND[m.kind]}`, value: `${m.service}:${m.what}`, alert: true });
  }
  if (lines.length === 0 && !job.notes?.length) return null;
  return (
    <div className="grid gap-2">
      {lines.length > 0 && (
        <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
          {lines.map((l) => (
            <div key={`${l.label}${l.value}`} className="contents">
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd className={cn("min-w-0 break-words font-mono", l.alert && "text-primary")}>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(job.missing?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          更新不會下載模型;要那台的主人在那台執行 <code className="font-mono">miyoria doctor --fix</code> 或{" "}
          <code className="font-mono">miyoria models pull</code>。
        </p>
      )}
      {job.notes?.map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

/** The running update, or the last one: its state, what it waits for, its steps and result. */
export function UpgradeStatus({ host, now }: { host: ClusterHostView; now: number }) {
  const job = host.upgrade;
  const { upgradeCancel } = useClusterMutations();
  const active = upgradeActive(job);
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (!job) return null;
  const view = UPGRADE_STATE[job.state];
  const shown = open || active || job.state === "failed";
  const when = job.finished_at ?? job.started_at;
  return (
    <section aria-label={`${host.name} 的更新`} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
        <StatusBadge tone={view.tone} pulse={view.pulse}>
          {view.label}
        </StatusBadge>
        <span className="font-mono text-xs text-muted-foreground">
          {job.from ? shortSha(job.from) : "?"} → {shortSha(job.target)}
        </span>
        {active && job.state === "running" && <span>{UPGRADE_STEP[job.step]}</span>}
        {job.state === "waiting" && job.waiting_for && <span>{job.waiting_for}</span>}
        <span className="text-xs text-muted-foreground" title={fmtDateTime(iso(when))}>
          {fmtRelative(iso(when), now)}
        </span>
        {!active && job.state !== "failed" && (
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
            步驟
          </Button>
        )}
        {job.state === "waiting" && (
          <Button
            writes
            size="sm"
            variant="outline"
            busy={upgradeCancel.isPending}
            onClick={() =>
              upgradeCancel.mutate(host.name, {
                onSuccess: (r) => (r.cancelled ? notify.ok(`已取消 ${host.name} 的更新`) : notify.info("它已經開始改東西,不能取消了")),
                onError: (e) => notify.error(e, "取消失敗"),
              })
            }
          >
            取消更新
          </Button>
        )}
      </div>
      {job.error && (
        <p role={job.state === "failed" ? "alert" : undefined} className={cn("text-xs", job.state === "failed" ? "text-primary" : "text-muted-foreground")}>
          {job.error}
        </p>
      )}
      {shown && (
        <div id={panel} className="grid max-w-3xl gap-3">
          <StepRows job={job} now={now} />
          <Outcome job={job} />
        </div>
      )}
    </section>
  );
}

// --- the selection -----------------------------------------------------------------

/** Above the list: Core's version, how many are picked, and the one action. */
export function UpgradeBar({
  hosts,
  selected,
  onSelectAll,
  onDone,
}: {
  hosts: ClusterHostView[];
  selected: ReadonlySet<string>;
  onSelectAll: (names: string[]) => void;
  onDone: () => void;
}) {
  const core = useClusterCheckout();
  const { upgrade } = useClusterMutations();
  const [confirming, setConfirming] = useState(false);
  const checkout = core.data?.checkout ?? null;
  const picked = hosts.filter((h) => selected.has(h.name));
  const candidates = hosts.filter((h) => updatable(h).ok).map((h) => h.name);
  const noCore = core.isSuccess && checkout === null;

  const run = () =>
    upgrade.mutate(
      picked.map((h) => h.name),
      {
        onSuccess: (answer) => {
          setConfirming(false);
          onDone();
          const started = answer.results.filter((r) => r.ok).map((r) => r.host);
          if (started.length > 0) notify.ok(`已開始更新:${started.join("、")}`);
          for (const r of answer.results.filter((x) => !x.ok)) notify.warn(`${r.host} 沒有更新:${r.error ?? ""}`);
        },
        onError: (e) => notify.error(e, "更新失敗"),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft pb-3 text-[13px]">
      <span className="text-muted-foreground">Core 的版本</span>
      {checkout ? (
        <span className="font-mono text-xs" title={checkout.commit}>
          {checkout.branch ?? "detached"} · {shortSha(checkout.commit)}
        </span>
      ) : (
        <span className="text-muted-foreground">{noCore ? "Core 不是從 git checkout 執行的,不能從這裡更新電腦" : "—"}</span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {candidates.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onSelectAll(selected.size === candidates.length ? [] : candidates)}>
            {selected.size === candidates.length ? "全部取消" : "選取可以更新的"}
          </Button>
        )}
        {picked.length > 0 && <span className="tabular-nums text-muted-foreground">已選 {picked.length} 台</span>}
        <Button writes size="sm" disabled={picked.length === 0 || checkout === null} onClick={() => setConfirming(true)}>
          <RefreshCw />
          更新
        </Button>
      </span>

      <ConfirmDialog
        open={confirming}
        title={`更新 ${picked.length} 台電腦到 Core 的版本?`}
        confirmLabel="更新"
        busy={upgrade.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={run}
      >
        <ul className="grid gap-1 font-mono text-xs text-foreground">
          {picked.map((h) => (
            <li key={h.name}>
              {h.name}:{h.checkout ? shortSha(h.checkout.commit) : "?"} → {checkout ? shortSha(checkout.commit) : "?"}
            </li>
          ))}
        </ul>
        <p className="mt-3">
          每台會快轉到這個提交、裝需要的套件、重啟有變動的服務。她在做歌、唱歌或直播時,那台會先等(最多 30 分鐘)。有未提交變更或分岔的電腦會拒絕。模型不會下載。
        </p>
      </ConfirmDialog>
    </div>
  );
}
