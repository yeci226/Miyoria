import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ClusterHostView } from "@miyoria/contracts/api";
import { useClusterMutations } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { Dot, StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { ApproveDialog } from "./Dialogs";
import { HostDetail } from "./HostDetail";
import { HOST_STATUS, updatable } from "./labels";
import { UpgradeStatus, VersionLine } from "./Upgrade";

/** Pending first (they wait for the owner), then by name. */
export const sortHosts = (hosts: ClusterHostView[]): ClusterHostView[] =>
  [...hosts].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || a.name.localeCompare(b.name));

function Connection({ host, now }: { host: ClusterHostView; now: number }) {
  if (host.connected) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Dot tone="brand" />
        <span>連線中</span>
        {host.connected_since && (
          <span className="text-muted-foreground" title={fmtDateTime(host.connected_since)}>
            自 {fmtRelative(host.connected_since, now)}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Dot tone="neutral" />
      <span>離線</span>
      <span title={host.last_seen_at ? fmtDateTime(host.last_seen_at) : undefined}>
        {host.last_seen_at ? `上次 ${fmtRelative(host.last_seen_at, now)}` : "從未連線"}
      </span>
    </span>
  );
}

function HostRow({
  host,
  now,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  host: ClusterHostView;
  now: number;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const { remove } = useClusterMutations();
  const [approving, setApproving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const panel = useId();
  const status = HOST_STATUS[host.status];
  const pending = host.status === "pending";
  const expandable = host.status === "approved" && host.connected;
  const update = updatable(host);
  // A box only where an update could ever be asked for: an approved host that reports a version.
  const selectable = host.status === "approved" && host.connected && host.remote_update !== undefined;

  return (
    <li
      data-host={host.name}
      className={cn("border-b border-line-soft py-3.5 last:border-0", pending && "-ml-3 border-l-2 border-l-primary bg-primary/[0.06] pl-[10px]")}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-1 basis-72 gap-1.5">
          {selectable ? (
            <span className="flex size-7 shrink-0 items-center justify-center" title={update.ok ? undefined : update.reason}>
              <Checkbox
                aria-label={`選取 ${host.name}`}
                checked={selected && update.ok}
                disabled={!update.ok}
                onCheckedChange={(v) => onSelect(v === true)}
              />
            </span>
          ) : null}
          {expandable ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={panel}
              aria-label={`${open ? "收起" : "展開"} ${host.name}`}
              onClick={onToggle}
              className="-ml-1.5 shrink-0"
            >
              <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
            </Button>
          ) : (
            <span aria-hidden className="size-7 shrink-0 -ml-1.5" />
          )}
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate font-mono text-[14px] font-semibold">{host.name}</h3>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <Connection host={host} now={now} />
              {(host.platform || host.version) && (
                <span className="font-mono text-xs text-muted-foreground">{[host.platform, host.version].filter(Boolean).join(" · ")}</span>
              )}
            </div>
            <VersionLine host={host} />
            <UpgradeStatus host={host} now={now} />
            {host.status === "approved" && (
              <div className="flex flex-wrap gap-1">
                {host.capabilities.map((c) => (
                  <Badge key={c} variant="secondary" className="font-mono">
                    {c}
                  </Badge>
                ))}
                {host.capabilities.length === 0 && <span className="text-xs text-muted-foreground">沒有核可任何能力</span>}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {pending && (
            <Button writes onClick={() => setApproving(true)}>
              核可
            </Button>
          )}
          <RowActions label={`${host.name} 的動作`}>
            {host.status !== "revoked" && !pending && (
              <DropdownMenuItem onSelect={() => setApproving(true)}>
                <Pencil />
                編輯核可的能力
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
              <Trash2 />
              移除
            </DropdownMenuItem>
          </RowActions>
        </div>
      </div>

      {expandable && open && (
        <div id={panel} className="mt-3 pl-[22px]">
          <HostDetail host={host} now={now} />
        </div>
      )}

      {approving && <ApproveDialog host={host} onClose={() => setApproving(false)} />}
      <ConfirmDialog
        open={removing}
        title={`移除「${host.name}」?`}
        confirmLabel="移除"
        busy={remove.isPending}
        onClose={() => setRemoving(false)}
        onConfirm={() =>
          remove.mutate(host.name, {
            onSuccess: () => {
              notify.ok(`已移除 ${host.name}`);
              setRemoving(false);
            },
            onError: (e) => notify.error(e, "移除失敗"),
          })
        }
      >
        它的金鑰會立刻失效,連線也會中斷。要再加入得重新邀請。
      </ConfirmDialog>
    </li>
  );
}

/** A clock that moves once a minute, so "3 minutes ago" and "in this state for" stay honest. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function HostList({
  hosts,
  selected,
  onSelect,
}: {
  hosts: ClusterHostView[];
  selected: ReadonlySet<string>;
  onSelect: (name: string, on: boolean) => void;
}) {
  const now = useMinuteClock();
  // Connected hosts start open: the point of the page is to see what runs.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  return (
    <ul aria-label="電腦">
      {sortHosts(hosts).map((h) => (
        <HostRow
          key={h.id}
          host={h}
          now={now}
          open={!toggled.has(h.name)}
          selected={selected.has(h.name)}
          onSelect={(on) => onSelect(h.name, on)}
          onToggle={() =>
            setToggled((t) => {
              const next = new Set(t);
              if (!next.delete(h.name)) next.add(h.name);
              return next;
            })
          }
        />
      ))}
    </ul>
  );
}
