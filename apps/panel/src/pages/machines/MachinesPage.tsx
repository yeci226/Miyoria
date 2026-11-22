import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { isApiError } from "@/api/http";
import { useClusterEndpoints, useClusterHosts, useClusterRouting } from "@/app/queries";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, QueryView } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { InviteDialog } from "./Dialogs";
import { EndpointList } from "./Endpoints";
import { HostList } from "./Hosts";
import { updatable } from "./labels";
import { RoutingView } from "./Routing";
import { UpgradeBar } from "./Upgrade";

/** The cluster module is off: every route answers 503. */
function ClusterOff() {
  return (
    <div role="status" className="grid max-w-xl gap-3 py-8">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">叢集模組沒有啟動</h2>
      <p className="text-[13px] text-muted-foreground">
        要管理多台電腦,先在 Core 的設定檔加上 <code className="font-mono text-foreground">[modules.cluster]</code> 並啟用,再重新啟動 Core。
      </p>
      <div>
        <Button asChild variant="outline">
          <Link to="/system" search={{ tab: "modules", q: "cluster" }}>
            到子系統頁看它的狀態
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Empty({ onInvite }: { onInvite: () => void }) {
  return (
    <div className="grid max-w-xl gap-2 py-3 text-[13px]">
      <p className="text-muted-foreground">還沒有電腦加入。</p>
      <p>
        這台電腦:執行 <code className="font-mono">miyoria host join --local</code>
      </p>
      <p className="flex flex-wrap items-center gap-2">
        另一台電腦:
        <Button size="sm" variant="outline" onClick={onInvite}>
          邀請電腦
        </Button>
      </p>
    </div>
  );
}

function Hosts({ onInvite }: { onInvite: () => void }) {
  const hosts = useClusterHosts();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const select = (name: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>電腦</CardTitle>
      </CardHeader>
      <QueryView query={hosts} isEmpty={(h) => h.length === 0} empty={<Empty onInvite={onInvite} />}>
        {(list) => {
          // A host that can no longer be updated drops out of the selection by itself.
          const live = new Set([...selected].filter((n) => list.some((h) => h.name === n && updatable(h).ok)));
          return (
            <div className="grid gap-1">
              {list.some((h) => h.remote_update !== undefined) && (
                <UpgradeBar hosts={list} selected={live} onSelectAll={(names) => setSelected(new Set(names))} onDone={() => setSelected(new Set())} />
              )}
              <HostList hosts={list} selected={live} onSelect={select} />
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}

/**
 * Job dispatch, or, from a Core without it (404 on the route, or 503 from a cluster module that
 * offers no routing), the plain list of who answers what.
 */
function Endpoints() {
  const routing = useClusterRouting();
  const older = routing.isError && isApiError(routing.error) && (routing.error.kind === "not_provided" || routing.error.kind === "unavailable");
  const endpoints = useClusterEndpoints(older);
  return (
    <Card>
      <CardHeader>
        <CardTitle>誰負責什麼</CardTitle>
      </CardHeader>
      {older ? (
        <QueryView query={endpoints} isEmpty={(d) => d.capabilities.length === 0} empty={<EmptyLine>還沒有任何能力</EmptyLine>}>
          {(data) => <EndpointList data={data} />}
        </QueryView>
      ) : (
        <QueryView query={routing} isEmpty={(d) => d.capabilities.length === 0 && d.hosts.length === 0} empty={<EmptyLine>還沒有任何能力</EmptyLine>}>
          {(data) => <RoutingView data={data} />}
        </QueryView>
      )}
    </Card>
  );
}

export function MachinesPage() {
  const hosts = useClusterHosts();
  const [inviting, setInviting] = useState(false);
  const off = hosts.isError && isApiError(hosts.error) && hosts.error.kind === "unavailable";
  return (
    <Page>
      <PageHeader
        title="電腦"
        actions={
          off ? undefined : (
            <Button writes size="sm" onClick={() => setInviting(true)}>
              <Plus />
              邀請電腦
            </Button>
          )
        }
      />
      {off ? (
        <ClusterOff />
      ) : (
        <>
          <Hosts onInvite={() => setInviting(true)} />
          <Endpoints />
        </>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </Page>
  );
}
