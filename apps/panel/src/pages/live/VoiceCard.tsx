import { LogIn, LogOut, MicOff, MonitorUp, VolumeX } from "lucide-react";
import { useState } from "react";
import type { VoiceChannelState, VoiceSession } from "@/api/types";
import { useLiveControls, useVoice, useWorld } from "@/app/queries";
import { useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { VoiceLatency } from "@/components/voice-latency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { accountString, contextShort } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

function Session({ s }: { s: VoiceSession }) {
  const speaking = new Set(s.speaking.map(accountString));
  const people = [...s.participants].sort((a, b) => Number(b.is_self) - Number(a.is_self));
  return (
    <ul className="divide-y divide-line-soft" aria-label="語音成員">
      {people.map((p) => {
        const talking = speaking.has(accountString(p.account));
        return (
          <li key={accountString(p.account)} className="flex items-center gap-2.5 py-(--row-y)">
            <Dot tone={talking ? "brand" : "neutral"} pulse={talking} className={cn(!talking && "opacity-40")} />
            <span className={cn("min-w-0 flex-1 truncate text-sm", talking && "font-medium")}>
              {p.display_name}
              {talking && <span className="sr-only">(正在說話)</span>}
            </span>
            {p.is_self && <Badge variant="brand">她</Badge>}
            {p.muted && <MicOff aria-label="靜音" className="size-3.5 text-muted-foreground" />}
            {p.deafened && <VolumeX aria-label="拒聽" className="size-3.5 text-muted-foreground" />}
          </li>
        );
      })}
    </ul>
  );
}

/** Voice channels she could join, busiest first. */
function JoinList({ channels }: { channels: VoiceChannelState[] }) {
  const { join } = useLiveControls();
  const sorted = [...channels].sort((a, b) => b.members.length - a.members.length);
  if (sorted.length === 0) return <p className="py-3 text-[13px] text-muted-foreground">沒有看到任何語音頻道</p>;
  return (
    <ul className="divide-y divide-line-soft" aria-label="可以加入的語音頻道">
      {sorted.map((c) => {
        const busy = join.isPending && join.variables?.channel === c.channel;
        return (
          <li key={`${c.guild}:${c.channel}`} className="flex items-center gap-3 py-(--row-y)">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{c.name ?? c.channel}</p>
              <p className="truncate text-xs text-muted-foreground">
                {c.members.length === 0 ? "沒有人" : c.members.map((m) => m.display_name).join("、")}
              </p>
            </div>
            <Button
              writes
              size="sm"
              variant="outline"
              busy={busy}
              disabled={join.isPending}
              aria-label={`加入 ${c.name ?? c.channel}`}
              onClick={() =>
                join.mutate(
                  { guild: c.guild, channel: c.channel },
                  { onSuccess: () => notify.ok(`她加入了「${c.name ?? c.channel}」`), onError: (e) => notify.error(e, "加入語音失敗") },
                )
              }
            >
              <LogIn />
              加入
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** Her voice channel: who is there, latency, Go Live, leave; or where she could join. */
export function VoiceCard() {
  const voice = useVoice();
  const world = useWorld();
  const { leave, goLive } = useLiveControls();
  const canWrite = useCanWrite();
  const [confirm, setConfirm] = useState<"leave" | "golive-start" | "golive-stop" | null>(null);
  const session = voice.data?.sessions[0];
  const live = world.data?.her.golive === "live";
  const guild = session?.context.scope ?? undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>語音</CardTitle>
        {session && (
          <CardAction>
            <Button writes size="sm" variant="secondary" onClick={() => setConfirm("leave")}>
              <LogOut />
              離開
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={voice} skeleton={<SkeletonRows count={3} />}>
        {(d) =>
          d.sessions.length === 0 ? (
            world.data ? <JoinList channels={world.data.voice_channels} /> : <SkeletonRows count={2} />
          ) : (
            <div>
              <div className="flex items-center gap-3 pb-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={session?.label ?? undefined}>
                    {world.data?.her.voice_name ?? session?.label ?? (session ? contextShort(session.context) : "")}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">{session?.participants.length ?? 0} 人</p>
                </div>
                <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <MonitorUp className={cn("size-4", live && "text-primary")} aria-hidden />
                  Go Live
                  <Switch
                    checked={live}
                    disabled={!canWrite || goLive.isPending}
                    onCheckedChange={(on) => setConfirm(on ? "golive-start" : "golive-stop")}
                    aria-label="Discord Go Live"
                  />
                </label>
              </div>
              {d.sessions.map((s) => (
                <div key={`${s.context.scope}:${s.context.channel}`}>
                  <VoiceLatency e2e={s.latency.e2e} />
                  <Session s={s} />
                </div>
              ))}
            </div>
          )
        }
      </QueryView>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "leave" ? "讓她離開語音?" : confirm === "golive-start" ? "開始 Go Live?" : "結束 Go Live?"}
        confirmLabel={confirm === "leave" ? "離開" : confirm === "golive-start" ? "開始 Go Live" : "結束 Go Live"}
        busy={leave.isPending || goLive.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const ok = confirm === "leave" ? "她離開了語音" : confirm === "golive-start" ? "已開始 Go Live" : "已結束 Go Live";
          const done = {
            onSuccess: () => {
              notify.ok(ok);
              setConfirm(null);
            },
            onError: (e: unknown) => notify.error(e),
          };
          if (confirm === "leave") leave.mutate(guild, done);
          else if (confirm) goLive.mutate({ action: confirm === "golive-start" ? "start" : "stop", guild }, done);
        }}
      >
        {confirm === "leave"
          ? live
            ? "她正在 Go Live,離開會一起結束直播。"
            : "她會離開這個語音頻道。"
          : confirm === "golive-start"
            ? "她會在這個語音頻道分享畫面,直播機的 OBS 也會跟著開播。"
            : "Discord 的直播會結束,OBS 也會停止推流。"}
      </ConfirmDialog>
    </Card>
  );
}
