import { useState } from "react";
import { isApiError } from "@/api/http";
import type { ClusterHostInfo, ClusterHostView } from "@miyoria/contracts/api";
import { useClusterHostInfo, useClusterMutations } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  fmtDuration,
  fmtGb,
  GPU_POLICY,
  LINK_STATE,
  SERVICE_KIND,
  type ServiceAction,
  type ServiceStatus,
  serviceActions,
  serviceRoutingLines,
  serviceView,
} from "./labels";

// --- GPU -------------------------------------------------------------------------

function GpuBar({ gpu }: { gpu: NonNullable<ClusterHostInfo["gpu"]> }) {
  const total = Math.max(gpu.total_mb, 1);
  const used = Math.min(1, gpu.used_mb / total);
  const reserve = Math.min(1, gpu.reserve_mb / total);
  const label = `顯示記憶體:已用 ${fmtGb(gpu.used_mb)} / ${fmtGb(gpu.total_mb)} GB,保留 ${fmtGb(gpu.reserve_mb)} GB`;
  return (
    <div className="grid max-w-md gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-[13px]">
        <span className="font-medium">{gpu.name ?? "顯示卡"}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="text-foreground">{fmtGb(gpu.used_mb)}</span> / {fmtGb(gpu.total_mb)} GB
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={gpu.total_mb}
        aria-valuenow={gpu.used_mb}
        className="relative h-1.5 overflow-hidden rounded-[2px] bg-muted"
      >
        <div className="absolute inset-y-0 left-0 bg-secondary-line" style={{ width: `${used * 100}%` }} />
        {reserve > 0 && (
          <div
            data-testid="gpu-reserve"
            className="absolute inset-y-0 right-0 border-l border-foreground/60 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.28)_0_2px,transparent_2px_5px)]"
            style={{ width: `${reserve * 100}%` }}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">保留 {fmtGb(gpu.reserve_mb)} GB 不給服務用</p>
    </div>
  );
}

// --- services --------------------------------------------------------------------

interface Pending {
  service: ServiceStatus;
  action: ServiceAction;
}

/** A refused action, with the server's words, waiting for a second, explicit yes. */
interface Forced extends Pending {
  message: string;
}

/** Its class, readiness, its owner's limits and its load, as the host reports them. */
function RoutingLines({ lines, className }: { lines: ReturnType<typeof serviceRoutingLines>; className?: string }) {
  return (
    <span className={cn("grid gap-0.5 text-xs tabular-nums", className)}>
      {lines.map((l) => (
        <span key={l.text} className={cn("max-w-72 break-words", l.alert ? "text-primary" : "text-muted-foreground")}>
          {l.text}
        </span>
      ))}
    </span>
  );
}

function ServiceRow({ s, now, onAction }: { s: ServiceStatus; now: number; onAction: (s: ServiceStatus, a: ServiceAction) => void }) {
  const view = serviceView(s);
  const actions = serviceActions(s);
  const routing = serviceRoutingLines(s);
  return (
    <TableRow data-service={s.name}>
      <TableCell className="min-w-0 py-2.5 pr-3 align-top">
        <div className="grid gap-1">
          <span className="font-mono font-medium">{s.name}</span>
          <span className="flex flex-wrap gap-1">
            {s.provides.map((p) => (
              <Badge key={p} variant="outline" className="font-mono">
                {p}
              </Badge>
            ))}
            {s.provides.length === 0 && <span className="text-xs text-muted-foreground">{SERVICE_KIND[s.kind]}</span>}
          </span>
          <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums lg:hidden">
            {[s.port ? `埠 ${s.port}` : null, s.pid ? `pid ${s.pid}` : null, s.restarts > 0 ? `重啟 ${s.restarts}` : null]
              .filter((part): part is string => part !== null)
              .map((part) => (
                <span key={part} className="whitespace-nowrap">
                  {part}
                </span>
              ))}
          </span>
          {routing.length > 0 && <RoutingLines lines={routing} className="xl:hidden" />}
        </div>
      </TableCell>
      <TableCell className="py-2.5 pr-3 align-top">
        <div className="grid justify-items-start gap-1">
          <StatusBadge tone={view.tone} pulse={view.pulse}>
            {view.label}
          </StatusBadge>
          {view.note && (
            <span className={cn("max-w-72 break-words text-xs", view.tone === "danger" ? "text-primary" : "text-muted-foreground")}>
              {view.note}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden py-2.5 pr-3 text-right align-top text-muted-foreground lg:table-cell">{s.port ?? "—"}</TableCell>
      <TableCell className="hidden py-2.5 pr-3 text-right align-top text-muted-foreground lg:table-cell">{s.pid ?? "—"}</TableCell>
      <TableCell className="hidden py-2.5 pr-3 text-right align-top lg:table-cell">
        {s.restarts > 0 ? s.restarts : <span className="text-muted-foreground">0</span>}
      </TableCell>
      <TableCell className="hidden py-2.5 pr-3 text-right align-top whitespace-nowrap text-muted-foreground md:table-cell">
        {fmtDuration(now - s.since)}
      </TableCell>
      <TableCell className="hidden py-2.5 pr-3 align-top text-xs text-muted-foreground xl:table-cell">
        {s.gpu ? (
          <span className="tabular-nums">
            {GPU_POLICY[s.gpu.policy]}
            {s.gpu.resident_mb !== undefined && ` · ${fmtGb(s.gpu.resident_mb)} GB`}
            {s.gpu.leased && " · 已借出"}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="hidden py-2.5 pr-3 align-top xl:table-cell" data-cell="routing">
        {routing.length > 0 ? <RoutingLines lines={routing} /> : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="py-2.5 align-top">
        <div className="flex justify-end gap-1">
          {actions.map((a) => (
            <Button key={a} writes size="sm" variant="outline" aria-label={`${ACTION_LABEL[a]} ${s.name}`} onClick={() => onAction(s, a)}>
              {ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}

function ServicesTable({ host, services, now }: { host: ClusterHostView; services: ServiceStatus[]; now: number }) {
  const { service: mutation } = useClusterMutations();
  const [pending, setPending] = useState<Pending | null>(null);
  const [forced, setForced] = useState<Forced | null>(null);

  const run = (p: Pending, force: boolean) =>
    mutation.mutate(
      { host: host.name, service: p.service.name, action: p.action, force },
      {
        onSuccess: () => {
          notify.ok(`已${ACTION_LABEL[p.action]} ${p.service.name}`);
          setPending(null);
          setForced(null);
        },
        onError: (e) => {
          // A guarded or busy service answers 409 with the reason; a host that is not connected
          // answers the same, and forcing cannot help there.
          if (!force && isApiError(e) && e.status === 409 && host.connected) {
            setPending(null);
            setForced({ ...p, message: e.message });
            return;
          }
          notify.error(e, `${ACTION_LABEL[p.action]}失敗`);
          if (force) setForced(null);
        },
      },
    );

  const choose = (service: ServiceStatus, action: ServiceAction) => {
    const p = { service, action };
    if (action === "start") run(p, false);
    else setPending(p);
  };

  if (services.length === 0) return <p className="py-2 text-[13px] text-muted-foreground">這台電腦沒有設定任何服務</p>;
  return (
    <>
      <Table aria-label={`${host.name} 的服務`}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>服務</TableHead>
            <TableHead>狀態</TableHead>
            <TableHead className="hidden text-right lg:table-cell">埠</TableHead>
            <TableHead className="hidden text-right lg:table-cell">pid</TableHead>
            <TableHead className="hidden text-right lg:table-cell">重啟</TableHead>
            <TableHead className="hidden text-right md:table-cell">持續</TableHead>
            <TableHead className="hidden xl:table-cell">GPU</TableHead>
            <TableHead className="hidden xl:table-cell">分派</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">動作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((s) => (
            <ServiceRow key={s.name} s={s} now={now} onAction={choose} />
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${ACTION_LABEL[pending.action]}「${pending.service.name}」?` : ""}
        confirmLabel={pending ? ACTION_LABEL[pending.action] : ""}
        busy={mutation.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => pending && run(pending, false)}
      >
        {pending?.action === "stop" ? "依賴它的功能會跟著停止。" : "進行中的工作可能中斷。"}
      </ConfirmDialog>

      <ConfirmDialog
        open={forced !== null}
        title={forced ? `仍要${ACTION_LABEL[forced.action]}「${forced.service.name}」?` : ""}
        confirmLabel={forced ? `強制${ACTION_LABEL[forced.action]}` : ""}
        busy={mutation.isPending}
        onClose={() => setForced(null)}
        onConfirm={() => forced && run(forced, true)}
      >
        <p className="text-foreground">{forced?.message}</p>
        <p className="mt-2">強制執行會無視上面的原因,直接{forced ? ACTION_LABEL[forced.action] : ""}。</p>
      </ConfirmDialog>
    </>
  );
}

// --- one host --------------------------------------------------------------------

export function HostDetail({ host, now }: { host: ClusterHostView; now: number }) {
  const info = useClusterHostInfo(host.name, true);
  if (info.isPending) return <SkeletonRows count={2} />;
  if (info.isError) {
    const gone = isApiError(info.error) && info.error.status === 409;
    return (
      <ErrorLine
        error={gone ? new Error("這台電腦剛剛離線了") : info.error}
        onRetry={() => void info.refetch()}
      />
    );
  }
  const { gpu, services, link } = info.data;
  return (
    <div className="grid gap-5">
      {link && link !== "connected" && (
        <p role="status" className="text-[13px] text-primary">
          控制連線:{LINK_STATE[link] ?? link}
        </p>
      )}
      <section aria-label="GPU" className="grid gap-1.5">
        {gpu ? <GpuBar gpu={gpu} /> : <p className="text-[13px] text-muted-foreground">沒有 GPU</p>}
      </section>
      <section aria-label="服務">
        <ServicesTable host={host} services={services} now={now} />
      </section>
    </div>
  );
}
