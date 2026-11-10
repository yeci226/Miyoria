import { useMemo, useState } from "react";
import type { ContextKey } from "@/api/types";
import type { JustNowKind } from "@/api/v4-types";
import { useChannelLevels } from "@/app/queries";
import { useRecent } from "@/app/v4-queries";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine, ErrorLine } from "@/components/query-state";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/misc";
import { contextKeyString, contextShort, fmtDateTime, fmtTime } from "@/lib/format";

export const JUST_NOW_KIND_LABEL: Record<JustNowKind, string> = {
  song: "唱歌",
  game: "遊戲",
  voice: "語音",
  stream: "直播",
  notice: "通知",
  talk: "對話",
  asked: "追問",
};

function RecentList({ context }: { context: ContextKey }) {
  const q = useRecent(context);
  return (
    <ModuleQuery query={q} module="「剛才」時間軸(memory 模組)" isEmpty={(d) => d.entries.length === 0 && d.private_hidden === 0} empty="這個頻道看出去,剛才沒有發生什麼事">
      {(d) => (
        <div className="grid gap-3">
          {d.entries.length === 0 ? (
            <EmptyLine>沒有可以顯示的紀錄</EmptyLine>
          ) : (
            <ol aria-label="剛才" className="grid">
              {[...d.entries].reverse().map((e, i) => (
                <li key={`${e.at}-${i}`} className="grid grid-cols-[3.5rem_4rem_minmax(0,1fr)] gap-x-3 border-b border-line-soft py-(--row-y) text-sm last:border-0">
                  <time dateTime={e.at} title={fmtDateTime(e.at)} className="text-muted-foreground tabular-nums">
                    {fmtTime(e.at)}
                  </time>
                  <span className="text-muted-foreground">{JUST_NOW_KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="min-w-0 break-words">
                    {e.text}
                    {e.place.label && <span className="ml-2 text-[13px] text-muted-foreground">{e.place.label}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {d.private_hidden > 0 && <p className="text-xs text-muted-foreground">另有 {d.private_hidden} 筆來自私訊,這裡不顯示</p>}
        </div>
      )}
    </ModuleQuery>
  );
}

/** The "just now" timeline as she reads it from one channel: what she did and what happened around her. */
export function RecentTab() {
  const levels = useChannelLevels();
  const channels = useMemo(() => (levels.data?.channels ?? []).filter((c) => c.context.kind !== "dm"), [levels.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const current = channels.find((c) => contextKeyString(c.context) === picked) ?? channels.find((c) => c.context.kind === "voice") ?? channels[0] ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>剛才</CardTitle>
        {channels.length > 0 && current && (
          <Select value={contextKeyString(current.context)} onValueChange={setPicked}>
            <SelectTrigger aria-label="從哪個頻道看" className="ml-auto w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map((c) => (
                <SelectItem key={contextKeyString(c.context)} value={contextKeyString(c.context)}>
                  {c.label ?? contextShort(c.context)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      {levels.isPending ? (
        <Skeleton className="h-24 w-full" aria-busy="true" aria-label="載入中" />
      ) : levels.isError ? (
        <ErrorLine error={levels.error} onRetry={() => void levels.refetch()} />
      ) : current === null ? (
        <EmptyLine>她還沒有認得的頻道</EmptyLine>
      ) : (
        <RecentList key={contextKeyString(current.context)} context={current.context} />
      )}
    </Card>
  );
}
