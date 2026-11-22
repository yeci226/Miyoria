import { Volume2, VolumeX } from "lucide-react";
import { useId } from "react";
import type { ChannelLevelInfo, ChannelLevelsView, ChannelLevelView, SpaceLevelView } from "@miyoria/contracts/api";
import { useSetSpaceChannelLevel, useSetSpaceLevel, useSpaceChannelLevels } from "@/app/queries-channels";
import { useAdminSpace } from "@/app/space";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { contextShort } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** Select value meaning "back to the configured level". */
const RESET = "__reset__";
const OFF = "off";

function LevelRow({ c, levels, spaceSet }: { c: ChannelLevelView; levels: ChannelLevelInfo[]; spaceSet: boolean }) {
  const set = useSetSpaceChannelLevel();
  const canWrite = useCanWrite();
  const id = useId();
  const name = c.label ?? contextShort(c.context);
  const info = levels.find((l) => l.mode === c.mode);
  const labelOf = (mode: string) => levels.find((l) => l.mode === mode)?.label ?? mode;
  const muted = c.mode === OFF;
  const apply = (mode: string | null) =>
    set.mutate(
      { context: c.context, mode },
      {
        onSuccess: (row) => notify.ok(row.mode === OFF ? `她在 ${name} 不會說話了` : `已將 ${name} 設為「${labelOf(row.mode)}」`),
        onError: (e) => notify.error(e, "設定聊天等級失敗"),
      },
    );
  // Unmuting goes back to the configured level, or `normal` when that is off too.
  const unmuteTo = c.default !== OFF ? null : (levels.find((l) => l.mode === "normal")?.mode ?? levels[1]?.mode ?? null);
  return (
    <li className="flex min-h-14 items-center gap-3 py-(--row-y)">
      <label htmlFor={id} className={cn("min-w-0 flex-1", muted && "text-muted-foreground")}>
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {info?.description ?? c.mode}
          {c.custom ? "" : spaceSet ? " · 照整個伺服器" : " · 預設"}
        </span>
      </label>
      <Select value={c.mode} disabled={!canWrite || set.isPending} onValueChange={(next) => apply(next === RESET ? null : next)}>
        <SelectTrigger id={id} size="sm" className="w-32" title={canWrite ? undefined : READ_ONLY_HINT} aria-label={`${name} 的聊天等級`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((l) => (
            <SelectItem key={l.mode} value={l.mode}>
              {l.label}
            </SelectItem>
          ))}
          {c.custom && (
            <>
              <SelectSeparator />
              <SelectItem value={RESET}>恢復預設({labelOf(c.default)})</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            writes
            size="icon-sm"
            variant="ghost"
            aria-label={muted ? `讓她在 ${name} 說話` : `讓她在 ${name} 閉嘴`}
            aria-pressed={muted}
            disabled={set.isPending}
            className={cn(muted && "bg-control text-primary hover:bg-control-hover hover:text-primary")}
            onClick={() => apply(muted ? unmuteTo : OFF)}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{muted ? "解除靜音" : "靜音"}</TooltipContent>
      </Tooltip>
    </li>
  );
}

/** The whole server's level: what its channels without one of their own get. */
function SpaceRow({ s, levels }: { s: SpaceLevelView; levels: ChannelLevelInfo[] }) {
  const set = useSetSpaceLevel();
  const canWrite = useCanWrite();
  const id = useId();
  const labelOf = (mode: string) => levels.find((l) => l.mode === mode)?.label ?? mode;
  const apply = (mode: string | null) =>
    set.mutate(
      { mode },
      {
        onSuccess: (row) => notify.ok(`已將整個伺服器設為「${labelOf(row.mode)}」`),
        onError: (e) => notify.error(e, "設定聊天等級失敗"),
      },
    );
  return (
    <div className="flex min-h-14 items-center gap-3 border-b border-line-soft py-(--row-y)">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">整個伺服器</span>
        <span className="block truncate text-xs text-muted-foreground">
          {s.name} · 沒有自己設定的頻道照這個{s.custom ? "" : " · 預設"}
        </span>
      </label>
      <Select value={s.mode} disabled={!canWrite || set.isPending} onValueChange={(next) => apply(next === RESET ? null : next)}>
        <SelectTrigger id={id} size="sm" className="w-32" title={canWrite ? undefined : READ_ONLY_HINT} aria-label="整個伺服器的聊天等級">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((l) => (
            <SelectItem key={l.mode} value={l.mode}>
              {l.label}
            </SelectItem>
          ))}
          {s.custom && (
            <>
              <SelectSeparator />
              <SelectItem value={RESET}>恢復預設({labelOf(s.default)})</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {/* Lines up with the channels' mute buttons. */}
      <span className="size-8 shrink-0" aria-hidden />
    </div>
  );
}

function LevelsBody({ v }: { v: ChannelLevelsView }) {
  const { multiple } = useAdminSpace();
  // One server looks as it always did; the server's own row appears once there are several (or it was set).
  const space = v.space && (multiple || v.space.custom) ? <SpaceRow s={v.space} levels={v.levels} /> : null;
  if (v.channels.length === 0) {
    return (
      <>
        {space}
        <EmptyLine>還沒有看過任何文字頻道</EmptyLine>
      </>
    );
  }
  return (
    <>
      {space}
      <ul className="divide-y divide-line-soft" aria-label="各頻道的聊天等級">
        {v.channels.map((c) => (
          <LevelRow key={`${c.context.platform}:${c.context.scope}:${c.context.channel}`} c={c} levels={v.levels} spaceSet={v.space?.custom === true} />
        ))}
      </ul>
    </>
  );
}

/**
 * The owner's ceiling on how much she talks in each text channel (docs/design/autonomy.md §21),
 * for the server the page is about (`?space=`), and that server's own level.
 */
export function ChannelLevelsCard() {
  const levels = useSpaceChannelLevels();
  return (
    <Card>
      <CardHeader>
        <CardTitle>聊天等級</CardTitle>
      </CardHeader>
      <QueryView query={levels} skeleton={<SkeletonRows count={3} />}>
        {(v) => <LevelsBody v={v} />}
      </QueryView>
    </Card>
  );
}
