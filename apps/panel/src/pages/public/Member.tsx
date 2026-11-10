import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Music } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { MemberCard, MemberDay, MemberForgetResult, MemberSession, MemberSong } from "@/api/types";
import { useApi } from "@/app/connection";
import { ChartBlock, ChartEmpty, ColumnChart } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { AFFINITY, FAMILIARITY, TRUST } from "./card";
import { CardSection } from "./CardSection";
import { Transfer } from "./Extras";
import { WalletCard } from "./Wallet";

/** Her view of someone changes with a reflection, not by the second. */
const POLL_MS = 60_000;
const ME = ["member", "me"] as const;
export const DAY_MS = 86_400_000;

const SONG_STATE: Record<string, string> = {
  preparing: "準備中",
  ready: "準備好了",
  playing: "正在唱",
  done: "唱完了",
  failed: "沒有成功",
  cancelled: "取消了",
};


function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: ME,
    queryFn: ({ signal }) => api.memberMe({ signal }),
    refetchInterval: POLL_MS,
  });
}

/** `YYYY-MM-DD` as local midnight, so a column sits on its own day whatever the browser's zone. */
export function localMidnight(date: string): number {
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** A band as a word over a short step meter: where it sits, never the number behind it. */
function Band({ label, value, scale }: { label: string; value: string | null; scale: readonly string[] }) {
  const at = value === null ? -1 : scale.indexOf(value);
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="truncate text-sm font-medium">{value ?? "—"}</dd>
      </div>
      {at >= 0 && (
        <div aria-hidden className="flex gap-0.5">
          {scale.map((step, i) => (
            <span key={step} className={cn("h-1.5 flex-1 rounded-[2px]", i <= at ? "bg-primary" : "bg-muted")} />
          ))}
        </div>
      )}
    </div>
  );
}

function HerView({ card }: { card: MemberCard }) {
  if (card.relationship === null) return <EmptyLine>她還不認識你</EmptyLine>;
  return (
    <div className="grid gap-4">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        <Band label="好感" value={card.affinity} scale={AFFINITY} />
        <Band label="信任" value={card.trust} scale={TRUST} />
        <Band label="熟悉" value={card.familiarity} scale={FAMILIARITY} />
      </dl>
      {card.public_feeling && (
        <blockquote className="max-w-prose border-l-2 border-primary/60 pl-3 text-sm">
          {card.public_feeling}
        </blockquote>
      )}
    </div>
  );
}

/** Who they are here and how she sees them: the top of their page. */
export function MemberProfile({ member }: { member: MemberSession }) {
  const me = useMe();
  const card = me.data?.card;
  const initial = [...member.name.trim()][0] ?? "?";
  return (
    <Card aria-label="她眼中的你">
      <div className="flex items-center gap-3.5">
        {member.avatar_url ? (
          <img src={member.avatar_url} alt="" className="size-12 shrink-0 rounded-full" />
        ) : (
          <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-full bg-muted text-lg font-semibold">
            {initial}
          </span>
        )}
        <div className="grid min-w-0 gap-0.5">
          <h2 className="truncate text-lg font-semibold tracking-[-0.01em]">{member.name}</h2>
          {card?.relationship ? (
            <p className="flex min-w-0 flex-wrap gap-x-3 text-[13px] text-muted-foreground">
              {card.call_name && (
                <span>
                  她叫你 <span className="font-medium text-foreground">{card.call_name}</span>
                </span>
              )}
              <span>
                關係 <span className="font-medium text-foreground">{card.relationship}</span>
              </span>
            </p>
          ) : (
            <p className="text-[13px] text-muted-foreground">她眼中的你</p>
          )}
        </div>
      </div>
      <QueryView query={me} skeleton={<SkeletonRows count={2} />}>
        {(v) => <HerView card={v.card} />}
      </QueryView>
    </Card>
  );
}

const ACTIVITY_SERIES = [
  { key: "text", label: "文字", color: "var(--chart-1)" },
  { key: "voice", label: "語音", color: "var(--chart-2)" },
];

function ActivityChart({ days }: { days: MemberDay[] }) {
  const total = days.reduce((n, d) => n + d.text + d.voice, 0);
  const talked = days.filter((d) => d.text + d.voice > 0).length;
  const columns = days.map((d) => ({ t: localMidnight(d.date), values: { text: d.text, voice: d.voice } }));
  return (
    <ChartBlock title="你和她說的話" value={fmtInt(total)} unit="句" aside={`近 ${days.length} 天,有 ${talked} 天說過話`}>
      {total === 0 ? (
        <ChartEmpty height={168}>這段時間還沒和她說過話</ChartEmpty>
      ) : (
        <ColumnChart
          columns={columns}
          series={ACTIVITY_SERIES}
          label={`近 ${days.length} 天每天和她說的話`}
          bucketMs={DAY_MS}
          height={168}
          format={fmtInt}
          totalLabel="合計"
          integer
        />
      )}
    </ChartBlock>
  );
}

/** Their own lines per day, text and voice apart. */
export function MemberActivity() {
  const me = useMe();
  return (
    <Card aria-label="你和她說的話">
      <QueryView query={me} skeleton={<SkeletonRows count={4} />}>
        {(v) =>
          v.activity ? (
            <ActivityChart days={v.activity} />
          ) : (
            <ChartEmpty height={168}>這個 Core 還沒有互動紀錄</ChartEmpty>
          )
        }
      </QueryView>
    </Card>
  );
}

function SongLine({ song }: { song: MemberSong }) {
  return (
    <li className="flex items-center gap-2.5 py-(--row-y)">
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{song.title}</span>
        {song.artist && <span className="ml-1.5 text-muted-foreground">{song.artist}</span>}
      </p>
      <span className="shrink-0 text-xs text-muted-foreground">
        {SONG_STATE[song.state] ?? song.state}
      </span>
    </li>
  );
}

/** The memories she shares with them and the songs they asked for. */
export function MemberLists() {
  const me = useMe();
  return (
    <QueryView query={me} skeleton={<SkeletonRows count={4} />}>
      {(v) => (
        <div className="grid gap-(--stage-gap) lg:grid-cols-2">
          <Card aria-label="一起的回憶">
            <CardHeader>
              <CardTitle>一起的回憶</CardTitle>
            </CardHeader>
            {v.memories.length === 0 ? (
              <EmptyLine>還沒有一起的回憶</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft">
                {v.memories.map((m, i) => (
                  <li key={i} className="flex items-baseline gap-3 py-(--row-y)">
                    <p className="min-w-0 flex-1 text-sm">{m.text}</p>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{m.date}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card aria-label="你點的歌">
            <CardHeader>
              <CardTitle>你點的歌</CardTitle>
            </CardHeader>
            {v.songs.length === 0 ? (
              <EmptyLine>你還沒有點歌</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft">
                {v.songs.map((s, i) => (
                  <SongLine key={i} song={s} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </QueryView>
  );
}

function RequestSong() {
  const api = useApi();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const id = useId();
  const request = useMutation({
    mutationFn: (text: string) => api.memberRequestSong(text),
    onSuccess: () => {
      setQuery("");
      notify.ok("已經交給她了,唱不唱由她決定");
      void client.invalidateQueries({ queryKey: ME });
      void client.invalidateQueries({ queryKey: ["public", "songs"] });
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = query.trim();
    if (text !== "") request.mutate(text);
  };
  return (
    <Card aria-label="點歌">
      <CardHeader>
        <CardTitle>點歌</CardTitle>
      </CardHeader>
      <form className="grid gap-2" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">
          歌名或 YouTube / bilibili 連結
        </label>
        <Input
          id={id}
          placeholder="歌名或 YouTube / bilibili 連結"
          maxLength={120}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" busy={request.isPending} disabled={query.trim() === ""}>
          <Music aria-hidden />
          點歌
        </Button>
      </form>
    </Card>
  );
}

function forgotten(r: MemberForgetResult): string {
  const said = r.deleted === 0 ? "她本來就沒有記得關於你的事" : `已讓她忘記關於你的 ${r.deleted} 件事`;
  return r.unverified > 0 ? `${said}。另有 ${r.unverified} 件來源已不可考,沒有刪除` : said;
}

function YourData() {
  const api = useApi();
  const client = useQueryClient();
  const me = useMe();
  const [asking, setAsking] = useState(false);
  const forget = useMutation({
    mutationFn: () => api.memberForget(),
    onSuccess: (r) => {
      setAsking(false);
      notify.ok(forgotten(r));
      void client.invalidateQueries({ queryKey: ME });
    },
    onError: (e) => notify.error(e),
  });
  return (
    <Card aria-label="你的資料">
      <CardHeader>
        <CardTitle>你的資料</CardTitle>
      </CardHeader>
      <div className="grid gap-2">
        <Button asChild variant="outline">
          <a href={api.memberExportUrl()} download>
            <Download aria-hidden />
            下載我的資料
          </a>
        </Button>
        <Button variant="outline" onClick={() => setAsking(true)}>
          請她忘記我
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        title="請她忘記你"
        confirmLabel="全部忘記"
        busy={forget.isPending}
        onConfirm={() => forget.mutate()}
        onClose={() => setAsking(false)}
      >
        <div className="grid gap-2">
          <p>確定要讓她忘記關於你的事嗎?這無法復原,需要的話請先下載你的資料。</p>
          {me.data && <p>{me.data.forget.removes}</p>}
          {me.data && <p>{me.data.forget.keeps}</p>}
        </div>
      </ConfirmDialog>
    </Card>
  );
}

/** What someone can do here: the rail. */
export function MemberActions() {
  const me = useMe();
  return (
    <>
      <WalletCard />
      <CardSection />
      <Transfer />
      {me.data?.can_request_song && <RequestSong />}
      <YourData />
    </>
  );
}
