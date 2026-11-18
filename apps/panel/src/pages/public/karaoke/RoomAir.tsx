// What goes out on her stream from a room (docs/design/karaoke.md 「做了什麼第五步」): the audience
// hears a round on the stream's karaoke scene, a couple of seconds behind the singers, with the
// backing and, when allowed, one singer's voice. The switches live here: a lone singer's 「讓大家聽到
// 我」, the opener's 「播出第一名的歌聲」, a singer's 「不要播我的聲音」, and the opener's (or an admin's)
// cut of someone else's voice. On the stage a singer sees an on-air notice only when they sing
// alone: with two or more singers the notice would tell them they lead, so they get the one static
// line about the room's setting and nothing else.

import { useMutation } from "@tanstack/react-query";
import { Radio, VolumeX } from "lucide-react";
import type { KaraokeRoomMember, KaraokeRoomRelay, KaraokeRoomView } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Refusal } from "./bits";
import { PLATE } from "./Singing";
import { cn } from "@/lib/utils";

type Me = NonNullable<KaraokeRoomView["me"]>;

export const LEAD_ON_LINE = "這間房會播出第一名的歌聲";
export const MUTE_STREAM_NOTICE = "唱的時候請把直播靜音(或不要看直播):你會聽到晚兩秒的伴奏和歌聲";
export const NOT_ALLOWED_FALLBACK = "這間房現在不播出聲音";

/**
 * Singers Core counts for alone or not: the round's own during a round (a member who chose to sing
 * but was not ready does not sing it), else the members who would sing.
 */
export const singerCount = (room: KaraokeRoomView): number => room.air.singers;

/** Seconds the stream is behind the singers, for the one line that says it. */
const delaySeconds = (room: KaraokeRoomView): string => String(Math.max(1, Math.round(room.air.delay_ms / 1000)));

/** A room's relay call: the answer is the new view of the room. */
export function useRelay(room: KaraokeRoomView, onRoom: (room: KaraokeRoomView) => void) {
  const api = useApi();
  return useMutation({
    mutationFn: (body: KaraokeRoomRelay) => api.rpc.karaokeRooms.relay({ params: { code: room.code }, body }),
    onSuccess: onRoom,
  });
}

/** Whether this member's voice is going to be played (as far as this person may know it). */
export function voiceOn(room: KaraokeRoomView, m: KaraokeRoomMember): boolean {
  if (m.role !== "singer" || !room.air.relay.allowed) return false;
  return singerCount(room) <= 1 ? m.hear : room.air.lead && !m.skip;
}

function SwitchRow({
  label,
  hint,
  checked,
  busy,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="grid gap-1">
      <label className="flex min-w-0 items-center justify-between gap-3 text-sm">
        <span className="min-w-0">{label}</span>
        <Switch checked={checked} disabled={busy} onCheckedChange={onChange} aria-label={label} />
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lobby and between rounds: who may be heard on the stream, and the switches. */
export function AirCard({ room, me, onRoom }: { room: KaraokeRoomView; me: Me; onRoom: (room: KaraokeRoomView) => void }) {
  const relay = useRelay(room, onRoom);
  const air = room.air;
  const mine = room.members.find((m) => m.id === me.id);
  const singers = singerCount(room);
  const isSinger = me.role === "singer" && mine !== undefined;
  const solo = singers <= 1;
  const busy = relay.isPending;
  return (
    <Card aria-label="直播播出">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio aria-hidden className="size-4 text-muted-foreground" />
          直播播出
        </CardTitle>
      </CardHeader>
      <div className="grid gap-3">
        {!air.relay.allowed ? (
          <p className="text-[13px] text-muted-foreground" data-air="off">
            {air.relay.reason ?? NOT_ALLOWED_FALLBACK}
          </p>
        ) : (
          <>
            {air.lead && (
              <p className="text-[13px]" data-air="lead">
                {LEAD_ON_LINE}
              </p>
            )}
            {isSinger && solo && (
              <SwitchRow
                label="讓大家聽到我"
                hint={`你的麥克風(就是已經送去算分的那個)會連同伴奏,晚約 ${delaySeconds(room)} 秒在她的直播上播出,不會錄下來。`}
                checked={mine.hear}
                busy={busy}
                onChange={(hear) => relay.mutate({ hear })}
              />
            )}
            {isSinger && !solo && (
              <SwitchRow label="不要播我的聲音" checked={mine.skip} busy={busy} onChange={(skip) => relay.mutate({ skip })} />
            )}
            {me.opener && (
              <SwitchRow
                label="播出第一名的歌聲"
                hint={solo ? "兩個人以上一起唱時才會用到。" : undefined}
                checked={air.lead}
                busy={busy}
                onChange={(lead) => relay.mutate({ lead })}
              />
            )}
            {!solo && <p className="text-xs text-muted-foreground">同一時間只會播出一個人的聲音:目前領先、而且願意被播出的那位。</p>}
            {isSinger && <p className="text-xs text-muted-foreground">{MUTE_STREAM_NOTICE}</p>}
          </>
        )}
        {relay.isError && <Refusal>{describeError(relay.error)}</Refusal>}
      </div>
    </Card>
  );
}

/** On a member's row: the opener's (or an admin's) button that turns their voice off. */
export function CutVoice({ room, member, onRoom }: { room: KaraokeRoomView; member: KaraokeRoomMember; onRoom: (room: KaraokeRoomView) => void }) {
  const relay = useRelay(room, onRoom);
  if (!voiceOn(room, member)) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      busy={relay.isPending}
      onClick={() => relay.mutate({ member: member.id })}
      aria-label={`關掉${member.name}的聲音`}
      title={relay.isError ? describeError(relay.error) : undefined}
    >
      <VolumeX aria-hidden />
      關掉聲音
    </Button>
  );
}

/**
 * The singer's plate on the stage. Alone: the on-air notice with a stop button (or the switch, when
 * it is allowed and still off). With others: only the room's static line when it leads, never who
 * is on air.
 */
export function AirPlate({ room, me, onRoom }: { room: KaraokeRoomView; me: Me; onRoom: (room: KaraokeRoomView) => void }) {
  const relay = useRelay(room, onRoom);
  const air = room.air;
  if (!air.relay.allowed) return null;
  if (singerCount(room) > 1) {
    if (!air.lead) return null;
    return (
      <p className={cn(PLATE, "rounded-full px-3 py-1 text-xs [text-shadow:none]")} data-air="lead">
        {LEAD_ON_LINE}
      </p>
    );
  }
  const mine = room.members.find((m) => m.id === me.id);
  if (!mine) return null;
  const live = air.relay.live && air.relay.member === me.id;
  const failed = relay.isError ? (
    <p role="alert" className={cn(PLATE, "rounded-full px-3 py-1 text-xs text-primary [text-shadow:none]")}>
      {describeError(relay.error)}
    </p>
  ) : null;
  if (live || mine.hear) {
    return (
      <>
        <div className={cn(PLATE, "flex items-center gap-2.5 rounded-full py-1 pr-1.5 pl-3 [text-shadow:none]")} data-air="live">
          <span role="status" className="text-[13px] font-medium">
            {live ? "你的聲音正在播出" : "已開啟播出"}
          </span>
          <Button variant="outline" size="sm" busy={relay.isPending} onClick={() => relay.mutate({ hear: false })}>
            停止播出
          </Button>
        </div>
        {failed}
      </>
    );
  }
  return (
    <>
      <div className={cn(PLATE, "flex items-center gap-2.5 rounded-full py-1 pr-1.5 pl-3 [text-shadow:none]")} data-air="off">
        <span className="text-[13px]">讓大家聽到我</span>
        <Button variant="outline" size="sm" busy={relay.isPending} onClick={() => relay.mutate({ hear: true })}>
          開啟
        </Button>
      </div>
      {failed}
    </>
  );
}
