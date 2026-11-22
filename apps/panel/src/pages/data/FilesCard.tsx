// 她做的檔案 on the 資料 page (docs/design/v5-architecture.md §11.2): every artifact, newest first, with
// how many of its links still open, and the owner's take-down; then the audit trail (made, shared,
// opened, revoked, deleted, taken down, expired). A take-down asks for a reason and stops every link
// at once; nobody but the owner sees the file again.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AdminFile, FileHistoryEntry } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { fmtBytes, SOURCE_LABEL } from "../public/MadeForMe";

const FILES = ["files", "admin"] as const;
const HISTORY = ["files", "history"] as const;

const REVIEW_LABEL: Record<string, string> = {
  pending: "未審",
  passed: "通過",
  blocked: "擋下",
  taken_down: "已下架",
};

const EVENT_LABEL: Record<string, string> = {
  "artifact.created": "做好",
  "artifact.shared": "當附件給出",
  "artifact.expired": "到期",
  "artifact.taken_down": "下架",
  "artifact.deleted": "本人刪除",
  "share.created": "做了連結",
  "share.opened": "連結第一次被打開",
  "share.revoked": "收回連結",
};

const AUDIENCE_LABEL: Record<string, string> = { person: "只給本人", space: "伺服器成員", link: "有連結的人" };

function historyLine(e: FileHistoryEntry): string {
  const d = e.data as Record<string, unknown>;
  const parts = [EVENT_LABEL[e.type] ?? e.type];
  if (typeof d.audience === "string") parts.push(AUDIENCE_LABEL[d.audience] ?? d.audience);
  if (typeof d.filename === "string") parts.push(d.filename);
  if (typeof d.reason === "string") parts.push(`「${d.reason}」`);
  if (typeof d.artifact_id === "string") parts.push(d.artifact_id.slice(-6));
  return parts.join(" · ");
}

function TakeDown({ target, onClose }: { target: AdminFile | null; onClose: () => void }) {
  const api = useApi();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const down = useMutation({
    mutationFn: (file: AdminFile) => api.rpc.filesAdmin.takedown({ params: { id: file.id }, body: { reason } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: FILES });
      void client.invalidateQueries({ queryKey: HISTORY });
      notify.ok("下架了,所有連結都失效了");
      setReason("");
      onClose();
    },
    onError: (e) => notify.error(e, "下架失敗"),
  });
  return (
    <ConfirmDialog
      open={target !== null}
      title={`下架 ${target?.filename ?? ""}?`}
      confirmLabel="下架"
      busy={down.isPending}
      confirmDisabled={reason.trim() === ""}
      onConfirm={() => target && down.mutate(target)}
      onClose={onClose}
    >
      <p className="mb-3">除了你以外,沒有人看得到它;它的連結全部失效。</p>
      <Field label="原因" htmlFor="takedown-reason">
        <Input id="takedown-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

export function FilesCard() {
  const api = useApi();
  const canWrite = useCanWrite();
  const [target, setTarget] = useState<AdminFile | null>(null);
  const files = useQuery({
    queryKey: FILES,
    queryFn: ({ signal }) => api.rpc.filesAdmin.list({ query: { limit: 50 } }, { signal }),
    retry: (n, e) => !isNotProvided(e) && n < 2,
  });
  const history = useQuery({
    queryKey: HISTORY,
    queryFn: ({ signal }) => api.rpc.filesAdmin.history({ query: { limit: 30 } }, { signal }),
    retry: (n, e) => !isNotProvided(e) && n < 2,
  });
  if (files.error && isNotProvided(files.error)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>她做的檔案</CardTitle>
      </CardHeader>
      <QueryView query={files} skeleton={<SkeletonRows count={4} />}>
        {(data) => (
          <>
            <p className="text-xs text-muted-foreground">
              {data.origin ? `連結開在 ${data.origin}` : "還沒有設定檔案網域([modules.api.files] origin),只能當附件給。"}
            </p>
            {data.items.length === 0 ? (
              <EmptyLine>她還沒有做任何檔案</EmptyLine>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>檔案</TableHead>
                    <TableHead>來源</TableHead>
                    <TableHead>範圍</TableHead>
                    <TableHead>狀態</TableHead>
                    <TableHead className="text-right">連結</TableHead>
                    <TableHead>做好</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="max-w-56 truncate" title={f.filename}>
                        {f.filename}
                        <span className="ml-1.5 text-xs text-muted-foreground">{fmtBytes(f.size)}</span>
                      </TableCell>
                      <TableCell>{SOURCE_LABEL[f.source] ?? f.source}</TableCell>
                      <TableCell className="font-mono text-xs">{f.scope}</TableCell>
                      <TableCell>
                        {f.deleted_at ? (
                          <Badge variant="outline">已刪除</Badge>
                        ) : f.review === "taken_down" ? (
                          <Badge variant="destructive">{REVIEW_LABEL[f.review]}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{REVIEW_LABEL[f.review] ?? f.review}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.live_links}</TableCell>
                      <TableCell title={fmtDateTime(f.created_at)}>{fmtRelative(f.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {f.review !== "taken_down" && !f.deleted_at && (
                          <Button variant="ghost" size="sm" writes disabled={!canWrite} onClick={() => setTarget(f)}>
                            下架
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </QueryView>
      <h3 className="mt-4 text-[13px] font-medium">紀錄</h3>
      <QueryView query={history} skeleton={<SkeletonRows count={3} />}>
        {(entries) =>
          entries.length === 0 ? (
            <EmptyLine>還沒有紀錄</EmptyLine>
          ) : (
            <ul className="divide-y divide-line-soft text-[13px]">
              {entries.map((e) => (
                <li key={e.id} className="flex min-w-0 items-baseline gap-3 py-1.5">
                  <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={e.at}>
                    {fmtDateTime(e.at)}
                  </time>
                  <span className="min-w-0 truncate">{historyLine(e)}</span>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <TakeDown target={target} onClose={() => setTarget(null)} />
    </Card>
  );
}
