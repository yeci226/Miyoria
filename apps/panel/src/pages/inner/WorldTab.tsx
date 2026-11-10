import { MicOff, MonitorUp, Video, VolumeX } from "lucide-react";
import type { WorldView } from "@/api/types";
import { EmptyLine } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountString, contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { activityText, PRESENCE_LABEL, PRESENCE_TONE } from "./labels";

function PeopleCard({ world }: { world: WorldView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>在線的人</CardTitle>
        {world.people.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{world.people.length}</span>}
      </CardHeader>
      {world.people.length === 0 ? (
        <EmptyLine>沒有人在線</EmptyLine>
      ) : (
        <Table aria-label="在線的人">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>名稱</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead>在做什麼</TableHead>
              <TableHead className="hidden md:table-cell">語音</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {world.people.map((p) => {
              const doing = p.activities.map(activityText).filter((t): t is string => t !== null);
              return (
                <TableRow key={accountString(p.account)}>
                  <TableCell className="font-medium">{p.display_name}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {p.status ? (
                      <span className="inline-flex items-center gap-2">
                        <Dot tone={PRESENCE_TONE[p.status]} />
                        {PRESENCE_LABEL[p.status]}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" title="不讓她看狀態，或平台沒有回報">
                        —
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{doing.length > 0 ? doing.join("、") : "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {p.voice ? (p.voice.channel_name ?? p.voice.channel) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function VoiceChannelsCard({ world }: { world: WorldView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>語音頻道</CardTitle>
      </CardHeader>
      {world.voice_channels.length === 0 ? (
        <EmptyLine>沒有人在語音頻道</EmptyLine>
      ) : (
        <div className="divide-y divide-line-soft">
          {world.voice_channels.map((c) => (
            <section key={`${c.guild}:${c.channel}`} aria-label={c.name ?? c.channel}>
              <div className="flex items-center gap-2 border-b border-line-soft py-(--row-y)">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name ?? c.channel}</span>
                <span className="text-[13px] text-muted-foreground tabular-nums">{c.members.length} 人</span>
              </div>
              <ul className="divide-y divide-line-soft">
                {c.members.map((m) => (
                  <li key={accountString(m.account)} className="flex items-center gap-2.5 py-(--row-y)">
                    <span className="min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
                    {m.is_self && <Badge variant="brand">她</Badge>}
                    {m.streaming && <MonitorUp aria-label="分享螢幕" className="size-3.5 text-muted-foreground" />}
                    {m.video && <Video aria-label="視訊" className="size-3.5 text-muted-foreground" />}
                    {m.muted && <MicOff aria-label="靜音" className="size-3.5 text-muted-foreground" />}
                    {m.deafened && <VolumeX aria-label="拒聽" className="size-3.5 text-muted-foreground" />}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function ChannelsCard({ world }: { world: WorldView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>文字頻道</CardTitle>
      </CardHeader>
      {world.channels.length === 0 ? (
        <EmptyLine>最近沒有人聊天</EmptyLine>
      ) : (
        <Table aria-label="文字頻道">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>頻道</TableHead>
              <TableHead className="w-20 text-right">最近則數</TableHead>
              <TableHead className="hidden sm:table-cell">常出現</TableHead>
              <TableHead className="hidden lg:table-cell">最近發言</TableHead>
              <TableHead className="w-24">最後</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {world.channels.map((c) => (
              <TableRow key={`${c.context.scope}:${c.context.channel}`}>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <span className="font-medium">{c.label ?? contextShort(c.context)}</span>
                    {c.lively && <Badge variant="success">熱鬧</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.recent_messages}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {c.topic.length > 0 ? c.topic.join("、") : "—"}
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {c.recent_authors.length > 0 ? c.recent_authors.slice(0, 4).join("、") : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.last_at ? (
                    <time dateTime={c.last_at} title={fmtDateTime(c.last_at)} className="whitespace-nowrap">
                      {fmtRelative(c.last_at)}
                    </time>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function WorldTab({ world }: { world: WorldView }) {
  return (
    <div className="grid gap-(--stage-gap)">
      <div className="grid items-start gap-(--stage-gap) lg:grid-cols-[minmax(0,1fr)_22rem]">
        <PeopleCard world={world} />
        <VoiceChannelsCard world={world} />
      </div>
      <ChannelsCard world={world} />
    </div>
  );
}
