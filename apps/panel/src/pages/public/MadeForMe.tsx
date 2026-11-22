// 她做給我的 on the member page (docs/design/v5-architecture.md §11.2): what she made for this person,
// newest first, with who its link opens for, a download, 留著 (it stops expiring) and 刪除. Changing
// who may open it makes a new link and stops the old ones; the new link shows once, to copy. A
// choice wider than where the thing was made is not offered (something made in a DM is never for a
// server). Song covers are listed but only heard in voice and on stream. A Core without the routes
// leaves the block out.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FileVisibility, MemberFile, MemberFiles } from "@miyoria/contracts/api";
import { describeError, isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";

export const MADE_FOR_ME = ["member", "files"] as const;

export const SOURCE_LABEL: Record<string, string> = {
  imagegen: "生圖",
  sandbox: "程式",
  cards: "卡片",
  sing: "翻唱",
  clip: "片段",
  doc: "文件",
  render: "畫面",
};

export const VISIBILITY_LABEL: Record<FileVisibility, string> = {
  none: "不分享",
  person: "只有我",
  space: "伺服器成員",
  link: "有連結的人",
};

const MADE_IN: Record<MemberFile["made_in"], string> = { dm: "私訊", server: "伺服器", elsewhere: "其他地方" };

/** `1.2 MB`, `830 KB`, `12 B`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** An older Core has no such route: asking again will not change that. */
const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && e.status === 403) && n < 2;

/** The Core's own sentence for what it would not do. */
function sentence(e: unknown): string {
  if (isApiError(e) && (e.kind === "http" || e.kind === "not_found") && e.message) return e.message;
  return describeError(e);
}

function useMadeForMe() {
  const api = useApi();
  return useQuery({
    queryKey: MADE_FOR_ME,
    queryFn: ({ signal }) => api.rpc.memberFiles.list(undefined, { signal }),
    retry,
  });
}

/** Why a visibility cannot be picked, or nothing. */
function whyNot(v: FileVisibility, item: MemberFile, links: MemberFiles["links"]): string | undefined {
  if (v === "none") return undefined;
  if (!links.available) return "還沒有設定檔案網域";
  if (!item.allowed.includes(v)) return v === "space" ? "私訊裡做的只給你" : "這個檔案不能這樣分享";
  if (v !== "link" && !links.scoped) return "這裡沒有開登入,只能做有連結就能看的連結";
  return undefined;
}

function Row({ item, links }: { item: MemberFile; links: MemberFiles["links"] }) {
  const api = useApi();
  const client = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const replace = (next: MemberFile) =>
    client.setQueryData<MemberFiles>(MADE_FOR_ME, (old) =>
      old ? { ...old, items: old.items.map((i) => (i.id === next.id ? next : i)) } : old,
    );
  const visibility = useMutation({
    mutationFn: (v: FileVisibility) => api.rpc.memberFiles.visibility({ params: { id: item.id }, body: { visibility: v } }),
    onSuccess: (r) => {
      replace(r.item);
      setUrl(r.url);
      void client.invalidateQueries({ queryKey: MADE_FOR_ME });
      notify.ok(r.url ? "新的連結做好了,舊的連結已經失效" : "不再分享,舊的連結已經失效");
    },
    onError: (e) => notify.error(e, sentence(e)),
  });
  const keep = useMutation({
    mutationFn: (on: boolean) => api.rpc.memberFiles.keep({ params: { id: item.id }, body: { keep: on } }),
    onSuccess: (next) => {
      replace(next);
      notify.ok(next.kept ? "會一直留著" : "7 天後會自動刪掉");
    },
    onError: (e) => notify.error(e, sentence(e)),
  });
  const download = useMutation({
    mutationFn: () => api.rpc.memberFiles.download({ params: { id: item.id } }),
    onSuccess: (r) => {
      window.location.assign(r.url);
    },
    onError: (e) => notify.error(e, sentence(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.rpc.memberFiles.remove({ params: { id: item.id } }),
    onSuccess: () => {
      setRemoving(false);
      client.setQueryData<MemberFiles>(MADE_FOR_ME, (old) =>
        old ? { ...old, items: old.items.filter((i) => i.id !== item.id) } : old,
      );
      notify.ok("刪掉了");
    },
    onError: (e) => notify.error(e, sentence(e)),
  });
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify.ok("連結複製好了");
    } catch {
      notify.error(new Error("複製不了"), "複製不了,請自己選取連結");
    }
  };
  const options = (["none", "person", "space", "link"] as const).map((v) => {
    const title = item.listen_only && v !== "none" ? "翻唱只在語音和直播裡聽" : whyNot(v, item, links);
    return { value: v, label: VISIBILITY_LABEL[v], disabled: title !== undefined, title };
  });
  return (
    <li className="grid gap-2.5 py-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate text-sm font-medium">{item.filename}</span>
        <span className="text-xs text-muted-foreground">
          {SOURCE_LABEL[item.source] ?? item.source} · {fmtBytes(item.size)} · 在{MADE_IN[item.made_in]}做的 ·{" "}
          <time dateTime={item.made_at} title={fmtDateTime(item.made_at)}>
            {fmtRelative(item.made_at)}
          </time>
        </span>
      </div>
      {item.listen_only ? (
        <p className="text-xs text-muted-foreground">翻唱的成品不開放下載,只在語音和直播裡聽。</p>
      ) : (
        <Segmented
          label={`${item.filename} 給誰看`}
          value={item.visibility}
          options={options}
          disabled={visibility.isPending}
          onChange={(v) => visibility.mutate(v)}
        />
      )}
      {url && (
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1 text-xs">{url}</code>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            <Copy aria-hidden />
            複製
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!item.listen_only && (
          <Button
            variant="outline"
            size="sm"
            busy={download.isPending}
            disabled={!links.available}
            title={links.available ? undefined : "還沒有設定檔案網域"}
            onClick={() => download.mutate()}
          >
            <Download aria-hidden />
            下載
          </Button>
        )}
        <Button variant="ghost" size="sm" busy={keep.isPending} onClick={() => keep.mutate(!item.kept)}>
          {item.kept ? "不用留了" : "留著"}
        </Button>
        <Button variant="ghost" size="sm" aria-label={`刪除 ${item.filename}`} onClick={() => setRemoving(true)}>
          <Trash2 aria-hidden />
          刪除
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {item.kept || item.expires_at === null ? "一直留著" : `${fmtRelative(item.expires_at)}自動刪掉`}
        </span>
      </div>
      <ConfirmDialog
        open={removing}
        title="刪掉這個檔案?"
        confirmLabel="刪除"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      >
        <p>{item.filename} 會馬上從這裡和所有連結消失,不能復原。</p>
      </ConfirmDialog>
    </li>
  );
}

export function MadeForMe() {
  const files = useMadeForMe();
  if (files.error && isNotProvided(files.error)) return null;
  return (
    <Card aria-label="她做給我的">
      <CardHeader>
        <CardTitle>她做給我的</CardTitle>
      </CardHeader>
      <QueryView query={files} skeleton={<SkeletonRows count={2} />}>
        {(data) => (
          <>
            {!data.links.available && (
              <p className="text-xs text-muted-foreground">還沒有設定檔案網域,所以現在不能下載或做連結。</p>
            )}
            {data.links.available && (
              <p className="text-xs text-muted-foreground tabular-nums">
                今天做了 {data.quota.used} / {data.quota.per_day} 條連結。沒有留著的檔案 7 天後會自動刪掉。
              </p>
            )}
            {data.items.length === 0 ? (
              <EmptyLine>她還沒有做東西給你</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft">
                {data.items.map((item) => (
                  <Row key={item.id} item={item} links={data.links} />
                ))}
              </ul>
            )}
          </>
        )}
      </QueryView>
    </Card>
  );
}
