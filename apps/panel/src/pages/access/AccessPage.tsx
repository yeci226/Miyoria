import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AuthScope, RoleAssignment, RoleDefinition, RoleMapping } from "@/api/types";
import { useAccessMutations, useAssignments, useMappings, useRoles } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { DataTable } from "@/components/data-table";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, QueryView } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accountString, contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { AssignDialog, PLATFORMS } from "./AssignDialog";
import { MappingDialog, RoleDialog } from "./RoleDialogs";

export function authScopeLabel(s: AuthScope): string {
  if (s.type === "global") return "全域";
  if (s.type === "guild") return `${s.platform} 伺服器 ${s.guild}`;
  return contextShort(s.context);
}

function Nodes({ nodes }: { nodes: string[] }) {
  if (nodes.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {nodes.map((n) => (
        <Badge key={n} variant="outline" className="font-mono">
          {n}
        </Badge>
      ))}
    </div>
  );
}

function RolesCard() {
  const roles = useRoles();
  const { deleteRole } = useAccessMutations();
  const [editing, setEditing] = useState<RoleDefinition | "new" | null>(null);
  const [deleting, setDeleting] = useState<RoleDefinition | null>(null);

  const columns = useMemo<ColumnDef<RoleDefinition>[]>(
    () => [
      {
        id: "name",
        header: "角色",
        cell: ({ row: { original: r } }) => (
          <span className="flex items-center gap-2 font-medium">
            {r.name}
            {r.builtin && <Badge variant="outline">內建</Badge>}
          </span>
        ),
      },
      { id: "rank", header: "等級", meta: { className: "w-16 text-right" }, cell: ({ row }) => row.original.rank },
      { id: "grants", header: "允許", cell: ({ row }) => <Nodes nodes={row.original.grants} /> },
      { id: "denies", header: "拒絕", meta: { className: "hidden md:table-cell" }, cell: ({ row }) => <Nodes nodes={row.original.denies} /> },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row: { original: r } }) => (
          <RowActions label={`${r.name} 的動作`}>
            <DropdownMenuItem onSelect={() => setEditing(r)}>
              <Pencil />
              編輯
            </DropdownMenuItem>
            {!r.builtin && (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(r)}>
                <Trash2 />
                刪除
              </DropdownMenuItem>
            )}
          </RowActions>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>角色</CardTitle>
        <CardAction>
          <Button writes size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus />
            新增角色
          </Button>
        </CardAction>
      </CardHeader>
      <QueryView query={roles}>
        {(list) => (
          <DataTable
            label="角色"
            columns={columns}
            data={[...list].sort((a, b) => b.rank - a.rank)}
            getRowId={(r) => r.name}
            empty="沒有任何角色"
          />
        )}
      </QueryView>
      {editing !== null && (
        <RoleDialog
          role={editing === "new" ? null : editing}
          taken={(roles.data ?? []).map((r) => r.name)}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`刪除角色「${deleting?.name}」?`}
        confirmLabel="刪除"
        busy={deleteRole.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          deleteRole.mutate(deleting.name, {
            onSuccess: () => {
              notify.ok(`已刪除 ${deleting.name}`);
              setDeleting(null);
            },
            onError: (e) => notify.error(e, "刪除失敗"),
          })
        }
      >
        指派了這個角色的人會失去它的權限。
      </ConfirmDialog>
    </Card>
  );
}

function AssignmentsCard() {
  const roles = useRoles();
  const assignments = useAssignments();
  const { revoke } = useAccessMutations();
  const [assigning, setAssigning] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignment | null>(null);

  const columns = useMemo<ColumnDef<RoleAssignment>[]>(
    () => [
      {
        id: "account",
        header: "帳號",
        cell: ({ row }) => <span className="font-mono text-[13px]">{accountString(row.original.account)}</span>,
      },
      { id: "role", header: "角色", cell: ({ row }) => <Badge variant="secondary">{row.original.role}</Badge> },
      { id: "scope", header: "範圍", meta: { className: "hidden sm:table-cell" }, cell: ({ row }) => authScopeLabel(row.original.scope) },
      {
        id: "by",
        header: "指派者",
        meta: { className: "hidden font-mono text-xs text-muted-foreground md:table-cell" },
        cell: ({ row }) => row.original.granted_by,
      },
      {
        id: "at",
        header: "時間",
        meta: { className: "hidden whitespace-nowrap text-muted-foreground md:table-cell" },
        cell: ({ row }) => (
          <time dateTime={row.original.at} title={fmtDateTime(row.original.at)}>
            {fmtRelative(row.original.at)}
          </time>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row }) => (
          <RowActions label={`${accountString(row.original.account)} 的動作`}>
            <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(row.original)}>
              <X />
              撤銷
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>指派</CardTitle>
        <CardAction>
          <Button writes size="sm" variant="secondary" disabled={!roles.isSuccess} onClick={() => setAssigning(true)}>
            <UserPlus />
            指派角色
          </Button>
        </CardAction>
      </CardHeader>
      <QueryView query={assignments}>
        {(list) => (
          <DataTable
            label="指派"
            columns={columns}
            data={list}
            getRowId={(a) => `${accountString(a.account)}|${a.role}|${JSON.stringify(a.scope)}`}
            empty="還沒有指派"
          />
        )}
      </QueryView>
      {assigning && roles.data && <AssignDialog roles={roles.data.map((r) => r.name)} onClose={() => setAssigning(false)} />}
      <ConfirmDialog
        open={revoking !== null}
        title="撤銷這個角色?"
        confirmLabel="撤銷"
        busy={revoke.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          revoke.mutate(
            { account: revoking.account, role: revoking.role, scope: revoking.scope },
            {
              onSuccess: () => {
                notify.ok("已撤銷");
                setRevoking(null);
              },
              onError: (e) => notify.error(e, "撤銷失敗"),
            },
          )
        }
      >
        {revoking && `${accountString(revoking.account)} 會失去「${revoking.role}」(${authScopeLabel(revoking.scope)})。`}
      </ConfirmDialog>
    </Card>
  );
}

function MappingsCard() {
  const roles = useRoles();
  const [platform, setPlatform] = useState<string>("discord");
  const [guild, setGuild] = useState("");
  const g = guild.trim();
  const mappings = useMappings(platform, g);
  const { removeMapping } = useAccessMutations();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RoleMapping | null>(null);

  const columns = useMemo<ColumnDef<RoleMapping>[]>(
    () => [
      { id: "platform_role", header: "平台身分組", cell: ({ row }) => <span className="font-mono text-[13px]">{row.original.platform_role}</span> },
      { id: "role", header: "角色", cell: ({ row }) => <Badge variant="secondary">{row.original.role}</Badge> },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row }) => (
          <RowActions label={`${row.original.platform_role} 的動作`}>
            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(row.original)}>
              <X />
              移除
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>身分組對應</CardTitle>
        <CardAction className="flex-wrap">
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger aria-label="平台" size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="伺服器 id"
            placeholder="伺服器 id"
            value={guild}
            onChange={(e) => setGuild(e.target.value)}
            className="h-8 w-48 font-mono text-[13px]"
            inputMode="numeric"
          />
          <Button writes size="sm" variant="outline" disabled={!g || !roles.isSuccess} onClick={() => setAdding(true)}>
            <Plus />
            新增對應
          </Button>
        </CardAction>
      </CardHeader>
      {!g ? (
        <EmptyLine>輸入伺服器 id 以查看對應</EmptyLine>
      ) : (
        <QueryView query={mappings}>
          {(list) => (
            <DataTable
              label="身分組對應"
              columns={columns}
              data={list}
              getRowId={(m) => m.platform_role}
              empty="這個伺服器沒有對應"
            />
          )}
        </QueryView>
      )}
      {adding && roles.data && (
        <MappingDialog platform={platform} guild={g} roles={roles.data.map((r) => r.name)} onClose={() => setAdding(false)} />
      )}
      <ConfirmDialog
        open={removing !== null}
        title="移除這個對應?"
        confirmLabel="移除"
        busy={removeMapping.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          removeMapping.mutate(
            { platform: removing.platform, guild: removing.guild, platform_role: removing.platform_role },
            {
              onSuccess: () => {
                notify.ok("已移除");
                setRemoving(null);
              },
              onError: (e) => notify.error(e, "移除失敗"),
            },
          )
        }
      >
        {removing && `身分組 ${removing.platform_role} 不再代表「${removing.role}」。`}
      </ConfirmDialog>
    </Card>
  );
}

export function AccessPage() {
  return (
    <Page>
      <PageHeader title="權限" />
      <AssignmentsCard />
      <RolesCard />
      <MappingsCard />
    </Page>
  );
}
