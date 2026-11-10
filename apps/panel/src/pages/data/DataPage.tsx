import { Link } from "@tanstack/react-router";
import { Check, Download, Eye, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Download as DownloadFile } from "@/api/http";
import type { DataCategoryView, DataInventory, DataWipeResult } from "@/api/types";
import { useApi } from "@/app/connection";
import { useDataInventory, useDataMutations } from "@/app/queries";
import { useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { Page, PageHeader } from "@/components/page";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { breakdownText, CATEGORY_LABEL, NOTE_TEXT, VIEW_LINK, withRequired } from "./labels";

/** Hands a downloaded file to the browser. */
export function saveFile(file: DownloadFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What the Core said after a delete or reset, as one toast. */
function reportWipe(title: string, result: DataWipeResult): void {
  const lines = result.notes.map((n) => NOTE_TEXT[n]);
  if (result.failed_modules.length > 0) {
    lines.push(`下列模組沒有重新啟動：${result.failed_modules.join("、")}`);
    toast.warning(title, { description: lines.join("\n"), duration: 12_000 });
    return;
  }
  toast.success(title, lines.length > 0 ? { description: lines.join("\n") } : undefined);
}

function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

/** Typed confirmation: the profile id, compared trimmed like the Core does. */
function TypedId({ id, profile, value, onChange, disabled }: { id: string; profile: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Field
      htmlFor={id}
      label={
        <span>
          輸入 profile id <code className="font-mono text-foreground">{profile}</code> 以確認
        </span>
      }
    >
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono"
      />
    </Field>
  );
}

function DeleteDialog({
  target,
  inventory,
  onClose,
}: {
  target: DataCategoryView | null;
  inventory: DataInventory;
  onClose: () => void;
}) {
  const { wipe } = useDataMutations();
  const [typed, setTyped] = useState("");
  const along = target ? withRequired(target.id, inventory.categories) : [];
  const needsTyped = along.some((c) => c.confirm === "typed");
  const shared = along.some((c) => c.shared);
  const close = () => {
    setTyped("");
    onClose();
  };
  const confirm = () => {
    if (!target) return;
    wipe.mutate(
      { categories: [target.id], confirm: needsTyped ? typed : undefined },
      {
        onSuccess: (result) => {
          reportWipe(`已刪除「${CATEGORY_LABEL[target.id]}」`, result);
          close();
        },
        onError: (e) => notify.error(e, "刪除失敗"),
      },
    );
  };
  return (
    <ConfirmDialog
      open={target !== null}
      title={target ? `刪除「${CATEGORY_LABEL[target.id]}」` : ""}
      confirmLabel="刪除"
      busy={wipe.isPending}
      confirmDisabled={needsTyped && typed.trim() !== inventory.profile}
      onConfirm={confirm}
      onClose={close}
    >
      <div className="flex flex-col gap-4 text-sm">
        <ul className="divide-y divide-line-soft rounded-md border" aria-label="會刪除的資料">
          {along.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-foreground">{CATEGORY_LABEL[c.id]}</span>
              <span className="font-mono text-xs tabular-nums">{c.count}</span>
            </li>
          ))}
        </ul>
        {shared && <p>這份資料由所有角色共用。</p>}
        <p>刪除後無法復原。</p>
        {needsTyped && <TypedId id="data-delete-confirm" profile={inventory.profile} value={typed} onChange={setTyped} />}
      </div>
    </ConfirmDialog>
  );
}

function CategoryRow({
  category,
  canManage,
  canDelete,
  onDelete,
}: {
  category: DataCategoryView;
  canManage: boolean;
  canDelete: boolean;
  onDelete: (c: DataCategoryView) => void;
}) {
  const api = useApi();
  const [exporting, setExporting] = useState(false);
  const link = VIEW_LINK[category.id];
  const exportable = canManage && category.exportable;
  const deletable = canDelete && !category.kept;
  const detail = breakdownText(category.breakdown);
  const doExport = async () => {
    setExporting(true);
    try {
      saveFile(await api.dataExport([category.id]));
    } catch (e) {
      notify.error(e, "匯出失敗");
    } finally {
      setExporting(false);
    }
  };
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium">{CATEGORY_LABEL[category.id]}</span>
          {detail && <span className="text-[13px] text-muted-foreground">{detail}</span>}
        </div>
      </TableCell>
      <TableCell className="w-24 text-right font-mono text-xs">{category.count}</TableCell>
      <TableCell className="w-32 text-[13px] text-muted-foreground">
        <When at={category.updated_at} />
      </TableCell>
      <TableCell className="w-12 text-right">
        {(link || exportable || deletable) && (
          <RowActions label={`${CATEGORY_LABEL[category.id]} 的動作`} writes={false}>
            {link && (
              <DropdownMenuItem asChild>
                <Link to={link.to} search={link.search as never}>
                  <Eye />
                  檢視
                </Link>
              </DropdownMenuItem>
            )}
            {exportable && (
              <DropdownMenuItem disabled={exporting} onSelect={() => void doExport()}>
                <Download />
                匯出 JSON
              </DropdownMenuItem>
            )}
            {deletable && (
              <>
                {(link || exportable) && <DropdownMenuSeparator />}
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(category)}>
                  <Trash2 />
                  刪除…
                </DropdownMenuItem>
              </>
            )}
          </RowActions>
        )}
      </TableCell>
    </TableRow>
  );
}

function CategoryCard({
  title,
  categories,
  canManage,
  canDelete,
  onDelete,
}: {
  title: string;
  categories: DataCategoryView[];
  canManage: boolean;
  canDelete: boolean;
  onDelete: (c: DataCategoryView) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>類別</TableHead>
            <TableHead className="text-right">筆數</TableHead>
            <TableHead>最後更新</TableHead>
            <TableHead>
              <span className="sr-only">動作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {categories.map((c) => (
            <CategoryRow key={c.id} category={c} canManage={canManage} canDelete={canDelete} onDelete={onDelete} />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** Backup first (its token unlocks the reset), then the typed profile id. */
function ResetDialog({ open, profile, onClose }: { open: boolean; profile: string; onClose: () => void }) {
  const api = useApi();
  const { reset } = useDataMutations();
  const [backup, setBackup] = useState<{ token: string; name: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [typed, setTyped] = useState("");
  const close = () => {
    setBackup(null);
    setTyped("");
    onClose();
  };
  const download = async () => {
    setDownloading(true);
    try {
      const file = await api.dataBackup();
      const token = file.headers.get("x-miyoria-backup-token");
      if (!token) throw new Error("Core 沒有回傳備份憑證");
      saveFile(file);
      setBackup({ token, name: file.name });
    } catch (e) {
      notify.error(e, "備份失敗");
    } finally {
      setDownloading(false);
    }
  };
  const confirm = () => {
    if (!backup) return;
    reset.mutate(
      { confirm: typed, token: backup.token },
      {
        onSuccess: (result) => {
          reportWipe("已回到初始狀態", result);
          close();
        },
        onError: (e) => notify.error(e, "重設失敗"),
      },
    );
  };
  return (
    <ConfirmDialog
      open={open}
      title="回到初始狀態"
      confirmLabel="回到初始狀態"
      busy={reset.isPending}
      confirmDisabled={backup === null || typed.trim() !== profile}
      onConfirm={confirm}
      onClose={close}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          刪除她的所有資料，包括記憶、關係、聊天紀錄、人物、角色與權限，回到剛安裝的狀態。稽核紀錄與 LLM 用量會保留，設定檔中的擁有者仍是擁有者。
        </p>
        <ol className="flex flex-col gap-4">
          <li className="flex flex-col gap-2">
            <span className="font-medium text-foreground">1. 下載完整備份</span>
            {backup ? (
              <p className="flex min-w-0 items-center gap-2 text-foreground">
                <Check className="size-4 shrink-0 text-foreground" aria-hidden />
                <span className="sr-only">已下載</span>
                <span className="truncate font-mono text-xs">{backup.name}</span>
              </p>
            ) : (
              <Button variant="outline" size="sm" className="self-start" busy={downloading} onClick={() => void download()}>
                <Download />
                下載備份
              </Button>
            )}
          </li>
          <li className="flex flex-col gap-2">
            <span className="font-medium text-foreground">2. 確認</span>
            <TypedId id="data-reset-confirm" profile={profile} value={typed} onChange={setTyped} disabled={backup === null} />
          </li>
        </ol>
      </div>
    </ConfirmDialog>
  );
}

function DangerZone({ profile }: { profile: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>危險區</CardTitle>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 py-3">
        <p className="min-w-0 flex-1 text-sm">備份後刪除她的所有資料，回到剛安裝的狀態。</p>
        <Button writes onClick={() => setOpen(true)}>
          回到初始狀態…
        </Button>
      </div>
      <ResetDialog open={open} profile={profile} onClose={() => setOpen(false)} />
    </Card>
  );
}

function DataSections({ inventory }: { inventory: DataInventory }) {
  const canWrite = useCanWrite();
  const canManage = inventory.can_manage;
  // Read-only accounts and non-owners never see a delete.
  const canDelete = canManage && canWrite;
  const [target, setTarget] = useState<DataCategoryView | null>(null);
  const own = inventory.categories.filter((c) => !c.shared && !c.kept);
  const shared = inventory.categories.filter((c) => c.shared && !c.kept);
  const kept = inventory.categories.filter((c) => c.kept);
  const props = { canManage, canDelete, onDelete: setTarget };
  return (
    <>
      <CategoryCard title="她的資料" categories={own} {...props} />
      <CategoryCard title="共用資料" categories={shared} {...props} />
      <CategoryCard title="保留的資料" categories={kept} {...props} />
      {canDelete && <DangerZone profile={inventory.profile} />}
      <DeleteDialog target={target} inventory={inventory} onClose={() => setTarget(null)} />
    </>
  );
}

function ExportAll({ inventory }: { inventory: DataInventory | undefined }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  if (!inventory?.can_manage) return null;
  const run = async () => {
    setBusy(true);
    try {
      saveFile(await api.dataExport());
    } catch (e) {
      notify.error(e, "匯出失敗");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" busy={busy} onClick={() => void run()}>
      <Download />
      匯出全部
    </Button>
  );
}

export function DataPage() {
  const inventory = useDataInventory();
  return (
    <Page>
      <PageHeader
        title="資料"
        actions={
          <>
            {inventory.data && (
              <Badge variant="outline" className="font-mono" title="profile id">
                {inventory.data.profile}
              </Badge>
            )}
            <ExportAll inventory={inventory.data} />
          </>
        }
      />
      <QueryView
        query={inventory}
        skeleton={
          <Card>
            <SkeletonRows count={8} />
          </Card>
        }
      >
        {(inv) => <DataSections inventory={inv} />}
      </QueryView>
    </Page>
  );
}
