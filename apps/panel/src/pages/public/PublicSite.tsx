import { ArrowLeft, CircleAlert, LogOut } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { MemberSession, PublicDay, PublicSong } from "@/api/types";
import { ChartBlock, ChartEmpty, ColumnChart } from "@/components/charts/charts";
import { Logo } from "@/components/logo";
import { Page } from "@/components/page";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Dot, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { fmtInt } from "@/lib/format";
import { LiveStage } from "./live/LiveStage";
import { DAY_MS, localMidnight, MemberActions, MemberActivity, MemberLists, MemberProfile } from "./Member";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "./status";
import { WalletMain } from "./Wallet";

export { STATE, stateLabel, usePublicSongs, usePublicStatus };

const duration = (s: number | null) =>
  s === null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Label over value, spaced, no cell walls: the panel's strip of facts. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

const title = (s: PublicSong) => s.title ?? "歌名還不知道";

/** What she is doing and what today came to. */
function Now() {
  const status = usePublicStatus();
  const songs = usePublicSongs();
  return (
    <Card aria-label="現在">
      <CardHeader>
        <CardTitle>現在</CardTitle>
      </CardHeader>
      <QueryView query={status} skeleton={<SkeletonRows count={1} />}>
        {(s) => (
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label="她">{stateLabel(s)}</Fact>
            {songs.data?.playing && <Fact label="正在唱">{title(songs.data.playing)}</Fact>}
            <Fact label="直播">{s.live ? "直播中" : "沒有"}</Fact>
            <Fact label="語音">{s.in_voice ? "在頻道裡" : "沒有"}</Fact>
            <Fact label="今天唱了">{s.today.songs_sung} 首</Fact>
            <Fact label="今天直播">{s.today.hours_live} 小時</Fact>
            <Fact label="今天在語音">{s.today.hours_in_voice} 小時</Fact>
          </dl>
        )}
      </QueryView>
    </Card>
  );
}

type Measure = "songs" | "live" | "voice";

const MEASURES: Record<Measure, { label: string; unit: string; pick: (d: PublicDay) => number; color: string }> = {
  songs: { label: "唱歌", unit: "首", pick: (d) => d.songs_sung, color: "var(--chart-1)" },
  live: { label: "直播", unit: "小時", pick: (d) => d.hours_live, color: "var(--chart-2)" },
  voice: { label: "語音", unit: "小時", pick: (d) => d.hours_in_voice, color: "var(--chart-2)" },
};

const oneDecimal = (v: number) => (Math.round(v * 10) / 10).toString();

function HerDaysChart({ days }: { days: PublicDay[] }) {
  const [measure, setMeasure] = useState<Measure>("songs");
  const m = MEASURES[measure];
  const total = days.reduce((n, d) => n + m.pick(d), 0);
  const format = measure === "songs" ? fmtInt : oneDecimal;
  const columns = days.map((d) => ({ t: localMidnight(d.date), values: { v: m.pick(d) } }));
  return (
    <ChartBlock
      title="她這兩週"
      value={format(total)}
      unit={m.unit}
      aside={`近 ${days.length} 天${m.label}`}
      action={
        <Segmented
          label="看哪一項"
          value={measure}
          onChange={setMeasure}
          options={(Object.keys(MEASURES) as Measure[]).map((k) => ({ value: k, label: MEASURES[k].label }))}
        />
      }
    >
      {total === 0 ? (
        <ChartEmpty height={168}>這兩週還沒有{m.label}的紀錄</ChartEmpty>
      ) : (
        <ColumnChart
          columns={columns}
          series={[{ key: "v", label: m.label, color: m.color }]}
          label={`近 ${days.length} 天每天${m.label}(${m.unit})`}
          bucketMs={DAY_MS}
          height={168}
          format={format}
          integer={measure === "songs"}
        />
      )}
    </ChartBlock>
  );
}

function HerDays() {
  const status = usePublicStatus();
  return (
    <Card aria-label="她這兩週">
      <QueryView query={status} skeleton={<SkeletonRows count={4} />}>
        {(s) =>
          s.days ? <HerDaysChart days={s.days} /> : <ChartEmpty height={168}>這個 Core 還沒有每日紀錄</ChartEmpty>
        }
      </QueryView>
    </Card>
  );
}

function SongRow({ song, tone, aside }: { song: PublicSong; tone?: Tone; aside?: string }) {
  return (
    <li className="flex items-center gap-2.5 py-(--row-y)">
      {tone && <Dot tone={tone} pulse={tone === "brand"} />}
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{title(song)}</span>
        {song.artist && <span className="ml-1.5 text-muted-foreground">{song.artist}</span>}
      </p>
      {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
      {song.duration_s !== null && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {duration(song.duration_s)}
        </span>
      )}
    </li>
  );
}

function Songs() {
  const songs = usePublicSongs();
  return (
    <Card aria-label="歌單">
      <CardHeader>
        <CardTitle>歌單</CardTitle>
      </CardHeader>
      <QueryView query={songs} skeleton={<SkeletonRows count={3} />}>
        {(s) => (
          <>
            {!s.playing && s.upcoming.length === 0 ? (
              <EmptyLine>歌單是空的</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft">
                {s.playing && <SongRow song={s.playing} tone="brand" aside="正在唱" />}
                {s.upcoming.map((song, i) => (
                  <SongRow key={i} song={song} aside={song.ready ? "準備好了" : "準備中"} />
                ))}
              </ul>
            )}
            {s.recent.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[13px] font-medium">剛唱完</h3>
                <ul className="divide-y divide-line-soft">
                  {s.recent.map((song, i) => (
                    <SongRow key={i} song={song} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </QueryView>
    </Card>
  );
}

function Header({ member, onLogout, onBack }: { member: MemberSession; onLogout: () => void; onBack?: () => void }) {
  const status = usePublicStatus();
  const now = status.data;
  return (
    <header className="glass-dock sticky top-0 z-30 flex min-h-13 items-center gap-2.5 border-b px-4 py-2 sm:px-7">
      <Logo className="size-5 shrink-0 text-primary" />
      <h1 className="text-[15px] font-semibold">Miyoria</h1>
      {now && (
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <Dot tone={STATE[now.state].tone} pulse={STATE[now.state].pulse} />
          <span className="truncate">{stateLabel(now)}</span>
        </p>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden />
            回到管理面板
          </Button>
        )}
        {member.avatar_url && <img src={member.avatar_url} alt="" className="size-6 rounded-full" />}
        <span className="hidden max-w-40 truncate text-[13px] sm:inline">{member.name}</span>
        <Button variant="ghost" size="icon-sm" aria-label="登出" onClick={onLogout}>
          <LogOut />
        </Button>
      </div>
    </header>
  );
}

/**
 * The page of someone logged in without panel access: how she sees them, how much they talk, what
 * she has been doing, her songs. Nothing here talks to an admin route, and the admin shell, its
 * navigation and its event stream are not mounted.
 */
export function PublicSite({
  member,
  notice,
  onLogout,
  onBack,
}: {
  member: MemberSession;
  /** What a failed login came back with. */
  notice?: string | null;
  onLogout: () => void;
  /** An admin looking at their own page: the way back to the admin panel. */
  onBack?: () => void;
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header member={member} onLogout={onLogout} onBack={onBack} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Page rail={<MemberActions />}>
          {notice && (
            <p role="alert" className="flex items-center gap-2 text-[13px]">
              <CircleAlert aria-hidden className="size-4 shrink-0 text-primary" />
              {notice}
            </p>
          )}
          <LiveStage member={member} />
          <MemberProfile member={member} />
          <div className="grid gap-(--stage-gap) lg:grid-cols-2">
            <MemberActivity />
            <HerDays />
          </div>
          <Now />
          <MemberLists />
          <WalletMain />
          <Songs />
        </Page>
      </main>
    </div>
  );
}
