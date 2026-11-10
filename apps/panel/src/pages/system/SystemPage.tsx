import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight, Power, PowerOff, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { ExtensionInfo, McpServerInfo, McpState, ModuleAction, ModuleInfo } from "@/api/types";
import { SYSTEM_TABS, type SystemTab } from "@/app/nav";
import {
  useExtensionAction,
  useExtensions,
  useMcpRestart,
  useMcpServers,
  useModuleAction,
  useModules,
} from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions, SearchInput } from "@/components/controls";
import { DataTable } from "@/components/data-table";
import { Page, PageHeader, Toolbar } from "@/components/page";
import { QueryView } from "@/components/query-state";
import { StateBadge, StatusBadge, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/lib/notify";

const route = getRouteApi("/system");

/** The API module refuses to stop itself (409), so the panel doesn't offer it. */
const SELF_ID = "api";

const VERB: Record<ModuleAction, string> = { enable: "啟用", disable: "停用", restart: "重新啟動" };

const ACTION_ICON = { enable: Power, disable: PowerOff, restart: RotateCw } as const;

const includes = (needle: string, ...hay: (string | null | undefined)[]) =>
  !needle || hay.some((h) => h?.toLowerCase().includes(needle));

function NameCell({ name, id }: { name: string; id: string }) {
  return (
    <div className="grid min-w-0">
      <span className="truncate font-medium">{name}</span>
      <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
    </div>
  );
}

function Reason({ text, failed }: { text: string | null; failed: boolean }) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={failed ? "line-clamp-2 text-primary" : "line-clamp-2 text-muted-foreground"} title={text}>
      {text}
    </span>
  );
}

// --- modules -------------------------------------------------------------------

type Filter = "all" | "attention" | "disabled";
const needsAttention = (m: ModuleInfo) => m.state === "failed" || m.state === "degraded" || (m.enabled && m.state === "stopped");

function ModuleFilter({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const modules = useModules();
  const list = modules.data ?? [];
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Filter)}>
      <SelectTrigger aria-label="篩選" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">全部 · {list.length}</SelectItem>
        <SelectItem value="attention">需要注意 · {list.filter(needsAttention).length}</SelectItem>
        <SelectItem value="disabled">已停用 · {list.filter((m) => !m.enabled).length}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ModulesTab({ filterText, filter }: { filterText: string; filter: Filter }) {
  const modules = useModules();
  const action = useModuleAction();
  const [pending, setPending] = useState<{ m: ModuleInfo; action: ModuleAction } | null>(null);

  const data = useMemo(
    () =>
      (modules.data ?? [])
        .filter((m) => (filter === "attention" ? needsAttention(m) : filter === "disabled" ? !m.enabled : true))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [modules.data, filter],
  );

  const columns = useMemo<ColumnDef<ModuleInfo>[]>(
    () => [
      { id: "name", header: "子系統", cell: ({ row }) => <NameCell name={row.original.name} id={row.original.id} /> },
      { id: "state", header: "狀態", meta: { className: "w-28" }, cell: ({ row }) => <StateBadge state={row.original.state} /> },
      {
        id: "reason",
        header: "訊息",
        meta: { className: "hidden max-w-80 md:table-cell" },
        cell: ({ row }) => <Reason text={row.original.reason} failed={row.original.state === "failed"} />,
      },
      {
        id: "restarts",
        header: "自動重啟",
        meta: { className: "hidden w-20 text-right lg:table-cell" },
        cell: ({ row }) => (row.original.recent_restarts > 0 ? row.original.recent_restarts : null),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row: { original: m } }) =>
          m.id === SELF_ID ? null : (
            <RowActions label={`${m.name} 的動作`}>
              {(m.enabled ? (["restart", "disable"] as const) : (["enable"] as const)).map((a) => {
                const Icon = ACTION_ICON[a];
                return (
                  <DropdownMenuItem key={a} variant={a === "disable" ? "destructive" : "default"} onSelect={() => setPending({ m, action: a })}>
                    <Icon />
                    {VERB[a]}
                  </DropdownMenuItem>
                );
              })}
            </RowActions>
          ),
      },
    ],
    [],
  );

  return (
    <>
      <Card>
        <QueryView query={modules}>
          {() => (
            <DataTable
              label="子系統"
              columns={columns}
              data={data}
              getRowId={(m) => m.id}
              filter={filterText}
              globalFilterFn={(m, n) => includes(n, m.id, m.name, m.description)}
              empty="沒有符合的子系統"
            />
          )}
        </QueryView>
      </Card>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${VERB[pending.action]}「${pending.m.name}」?` : ""}
        confirmLabel={pending ? VERB[pending.action] : ""}
        busy={action.isPending}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending &&
          action.mutate(
            { id: pending.m.id, action: pending.action },
            {
              onSuccess: (m) => {
                notify.ok(`已${VERB[pending.action]} ${m.name}`);
                setPending(null);
              },
              onError: (e) => notify.error(e, `${VERB[pending.action]}失敗`),
            },
          )
        }
      >
        {pending?.action === "disable"
          ? "依賴它的功能會跟著停止,直到再次啟用。"
          : pending?.action === "restart"
            ? "進行中的工作可能中斷。"
            : null}
      </ConfirmDialog>
    </>
  );
}

// --- extensions ----------------------------------------------------------------

function ExtensionsTab({ filterText }: { filterText: string }) {
  const extensions = useExtensions();
  const action = useExtensionAction();
  const [pending, setPending] = useState<{ x: ExtensionInfo; action: ModuleAction } | null>(null);

  const columns = useMemo<ColumnDef<ExtensionInfo>[]>(
    () => [
      {
        id: "name",
        header: "擴充套件",
        cell: ({ row: { original: x } }) => <NameCell name={x.name} id={`${x.id}@${x.version}`} />,
      },
      { id: "state", header: "狀態", meta: { className: "w-28" }, cell: ({ row }) => <StateBadge state={row.original.state} /> },
      {
        id: "permissions",
        header: "權限",
        meta: { className: "hidden md:table-cell" },
        cell: ({ row }) =>
          row.original.permissions.length ? (
            <div className="flex flex-wrap gap-1">
              {row.original.permissions.map((p) => (
                <Badge key={p} variant="outline" className="font-mono">
                  {p}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "source",
        header: "位置",
        meta: { className: "hidden max-w-56 lg:table-cell" },
        cell: ({ row }) => (
          <span className="block truncate font-mono text-xs text-muted-foreground" title={row.original.source}>
            {row.original.source}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row: { original: x } }) => (
          <RowActions label={`${x.name} 的動作`}>
            {(x.enabled ? (["restart", "disable"] as const) : (["enable"] as const)).map((a) => {
              const Icon = ACTION_ICON[a];
              return (
                <DropdownMenuItem key={a} variant={a === "disable" ? "destructive" : "default"} onSelect={() => setPending({ x, action: a })}>
                  <Icon />
                  {VERB[a]}
                </DropdownMenuItem>
              );
            })}
          </RowActions>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <QueryView query={extensions}>
        {(list) => (
          <DataTable
            label="擴充套件"
            columns={columns}
            data={list}
            getRowId={(x) => x.id}
            filter={filterText}
            globalFilterFn={(x, n) => includes(n, x.id, x.name, x.description, ...x.permissions)}
            empty={list.length === 0 ? "沒有安裝擴充套件" : "沒有符合的擴充套件"}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${VERB[pending.action]}「${pending.x.name}」?` : ""}
        confirmLabel={pending ? VERB[pending.action] : ""}
        busy={action.isPending}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending &&
          action.mutate(
            { id: pending.x.id, action: pending.action },
            {
              onSuccess: () => {
                notify.ok(`已${VERB[pending.action]} ${pending.x.name}`);
                setPending(null);
              },
              onError: (e) => notify.error(e, `${VERB[pending.action]}失敗`),
            },
          )
        }
      >
        {pending?.action === "enable" && pending.x.permissions.length > 0
          ? `它會取得:${pending.x.permissions.join("、")}`
          : pending?.action === "disable"
            ? "它提供的指令與工具會立刻消失。"
            : "進行中的工作可能中斷。"}
      </ConfirmDialog>
    </Card>
  );
}

// --- MCP -----------------------------------------------------------------------

const MCP_STATE: Record<McpState, { label: string; tone: Tone }> = {
  ready: { label: "已連線", tone: "success" },
  connecting: { label: "連線中", tone: "warning" },
  failed: { label: "失敗", tone: "danger" },
  disabled: { label: "已停用", tone: "neutral" },
};

function McpTab({ filterText }: { filterText: string }) {
  const servers = useMcpServers();
  const restart = useMcpRestart();
  const [pending, setPending] = useState<McpServerInfo | null>(null);
  const [tools, setTools] = useState<McpServerInfo | null>(null);

  const columns = useMemo<ColumnDef<McpServerInfo>[]>(
    () => [
      {
        id: "name",
        header: "伺服器",
        cell: ({ row: { original: s } }) => (
          <div className="grid min-w-0">
            <span className="flex items-center gap-2 font-medium">
              {s.name}
              <Badge variant="outline">{s.transport}</Badge>
            </span>
            {s.target && (
              <span className="truncate font-mono text-xs text-muted-foreground" title={s.target}>
                {s.target}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "state",
        header: "狀態",
        meta: { className: "w-28" },
        cell: ({ row: { original: s } }) => {
          const st = MCP_STATE[s.state] ?? { label: s.state, tone: "neutral" as Tone };
          return (
            <StatusBadge tone={st.tone} pulse={s.state === "connecting"}>
              {st.label}
            </StatusBadge>
          );
        },
      },
      {
        id: "tools",
        header: "工具",
        meta: { className: "w-24" },
        cell: ({ row: { original: s } }) => (
          <button
            type="button"
            onClick={() => setTools(s)}
            className="inline-flex items-center gap-1 rounded-sm tabular-nums outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {s.tools.length}
            {s.remote_tool_count !== s.tools.length && <span className="text-muted-foreground">/ {s.remote_tool_count}</span>}
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
        ),
      },
      {
        id: "error",
        header: "訊息",
        meta: { className: "hidden max-w-72 md:table-cell" },
        cell: ({ row }) => <Reason text={row.original.error} failed={row.original.state === "failed"} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row: { original: s } }) =>
          s.enabled ? (
            <RowActions label={`${s.name} 的動作`}>
              <DropdownMenuItem onSelect={() => setPending(s)}>
                <RotateCw />
                重新連線
              </DropdownMenuItem>
            </RowActions>
          ) : null,
      },
    ],
    [],
  );

  return (
    <Card>
      <QueryView query={servers}>
        {(list) => (
          <DataTable
            label="MCP 伺服器"
            columns={columns}
            data={list}
            getRowId={(s) => s.name}
            filter={filterText}
            globalFilterFn={(s, n) => includes(n, s.name, s.target, ...s.tools.map((t) => t.name))}
            empty={list.length === 0 ? "沒有設定 MCP 伺服器" : "沒有符合的伺服器"}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={pending !== null}
        title={`重新連線「${pending?.name}」?`}
        confirmLabel="重新連線"
        busy={restart.isPending}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending &&
          restart.mutate(pending.name, {
            onSuccess: () => {
              notify.ok(`已重新連線 ${pending.name}`);
              setPending(null);
            },
            onError: (e) => notify.error(e, "重新連線失敗"),
          })
        }
      >
        整個 MCP 模組會重新啟動,進行中的工具呼叫可能失敗。
      </ConfirmDialog>
      <Sheet open={tools !== null} onOpenChange={(o) => !o && setTools(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{tools?.name} 的工具</SheetTitle>
            {tools?.permission && <code className="text-xs text-muted-foreground">{tools.permission}</code>}
          </SheetHeader>
          <SheetBody className="p-0">
            {tools && tools.tools.length > 0 ? (
              <ul className="divide-y divide-line-soft">
                {tools.tools.map((t) => (
                  <li key={t.name} className="grid gap-1 px-6 py-3">
                    <code className="text-[13px]">{t.name}</code>
                    {t.description && <p className="text-[13px] text-muted-foreground">{t.description}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">沒有工具</p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

export function SystemPage() {
  const { tab = "modules", q } = route.useSearch();
  const navigate = useNavigate();
  const [text, setText] = useState(q ?? "");
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    // Navigating here with `?q=` (overview, palette) replaces the search box.
    setLastQ(q);
    setText(q ?? "");
  }
  const needle = text.trim().toLowerCase();
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/system", search: { tab: t as SystemTab }, replace: true })}>
      <TabsList>
        {SYSTEM_TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Page>
        <PageHeader title="系統" />
        <Toolbar className="-mb-4">
          <SearchInput value={text} onChange={setText} placeholder="搜尋名稱或 id" label="搜尋" />
          {tab === "modules" && <ModuleFilter value={filter} onChange={setFilter} />}
        </Toolbar>
        <TabsContent value="modules">
          <ModulesTab filterText={needle} filter={filter} />
        </TabsContent>
        <TabsContent value="extensions">
          <ExtensionsTab filterText={needle} />
        </TabsContent>
        <TabsContent value="mcp">
          <McpTab filterText={needle} />
        </TabsContent>
      </Page>
    </Tabs>
  );
}
