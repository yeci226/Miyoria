// A singing's result: the total and the four parts with a line of words each, the phrases, and
// her comment when she makes one. Just after singing, the browser's own number shows until Core's
// comes back (Core's is the one kept); her comment is looked for every few seconds for a while.
//
// Where the number came from is said over it: 「預估」 from the pitch the browser detected, or
// 「正式分數」 once the song worker scored the recording of the singer. When the singing was
// recorded, the recording is sent once when Core asks for it (`voice.upload`: right after the
// result for a singer alone; for a room's singer only when their live stream did not hold, which
// may be said by a later look), never again on a failure, and the result is asked for every few
// seconds until the official score is in, for a while.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Info, MicVocal, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KaraokeResult } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useConnection } from "@/app/connection";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Bar, Fact, Refusal } from "./bits";
import { COMMENT_POLL_MS, COMMENT_WAIT_MS, OVERVIEW, resultKey, VOICE_POLL_MS, VOICE_WAIT_MS } from "./queries";
import { uploadVoice } from "./recorder";
import { wantsUpload } from "./room-text";
import { clock, coreScored, partLines, pct, type Scored, score1, type VoiceView, voiceView } from "./result-text";
import type { Finished } from "./Singing";

/** Whether her comment is still worth asking about. */
export function commentPollMs(result: KaraokeResult | undefined, since: number, now = Date.now()): number | false {
  if (result?.comment.state !== "waiting") return false;
  return now - since < COMMENT_WAIT_MS ? COMMENT_POLL_MS : false;
}

/** Whether the official score is still worth asking about (not after this browser failed to send it). */
export function voicePollMs(
  result: KaraokeResult | undefined,
  since: number,
  now = Date.now(),
  uploadFailed = false,
): number | false {
  const state = result?.voice.state;
  if (uploadFailed || (state !== "waiting" && state !== "scoring")) return false;
  return now - since < VOICE_WAIT_MS ? VOICE_POLL_MS : false;
}

/** The result is asked for again at the sooner of the two. */
export function resultPollMs(
  result: KaraokeResult | undefined,
  since: number,
  now = Date.now(),
  uploadFailed = false,
): number | false {
  const each = [commentPollMs(result, since, now), voicePollMs(result, since, now, uploadFailed)].filter(
    (x): x is number => x !== false,
  );
  return each.length === 0 ? false : Math.min(...each);
}

function phraseText(r: Scored, index: number, lines: readonly string[]): string | null {
  const p = r.phrases.find((x) => x.index === index);
  return p?.text ?? lines[index] ?? null;
}

function Parts({ r }: { r: Scored }) {
  return (
    <ul className="grid gap-x-10 gap-y-5 lg:grid-cols-2">
      {partLines(r).map((p) => (
        <li key={p.key} className="grid gap-1.5" aria-label={p.name}>
          <div className="flex items-baseline gap-3">
            <span className="text-[13px] font-medium">{p.name}</span>
            <span className="ml-auto font-mono text-[13px] tabular-nums">
              {score1(p.score)}
              <span className="text-muted-foreground"> / {p.max}</span>
            </span>
          </div>
          <Bar value={p.max > 0 ? p.score / p.max : 0} label={`${p.name} ${score1(p.score)} / ${p.max}`} />
          <p className="text-[13px] text-muted-foreground">{p.line}</p>
        </li>
      ))}
    </ul>
  );
}

function Phrases({ r, lines }: { r: Scored; lines: readonly string[] }) {
  if (r.phrases.length === 0) return null;
  return (
    <Card aria-label="每一句">
      <CardHeader>
        <CardTitle>每一句</CardTitle>
      </CardHeader>
      <ol className="divide-y divide-line-soft">
        {r.phrases.map((p, at) => {
          const best = r.facts.best === at;
          const weakest = r.facts.weakest === at;
          const text = phraseText(r, p.index, lines);
          return (
            <li key={`${p.index}-${p.start}`} className="flex items-center gap-3 py-(--row-y)">
              <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {clock(p.start)}
              </span>
              <span className={cn("min-w-0 flex-1 truncate text-sm", !text && "text-muted-foreground")}>
                {text ?? `第 ${at + 1} 段`}
              </span>
              {best && <Badge variant="brand">最好</Badge>}
              {weakest && <Badge>最弱</Badge>}
              <div className="hidden w-28 shrink-0 sm:block">
                <Bar value={p.score / 100} label={`${text ?? `第 ${at + 1} 段`} ${p.score} 分`} tone={best ? "brand" : "neutral"} />
              </div>
              <span className="w-7 shrink-0 text-right font-mono text-xs tabular-nums">{p.score}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Comment({ result, polling }: { result: KaraokeResult; polling: boolean }) {
  const c = result.comment;
  if (c.state === "none") return null;
  return (
    <Card aria-label="她的講評">
      <CardHeader>
        <CardTitle>她的講評</CardTitle>
      </CardHeader>
      {c.state === "said" ? (
        c.text ? (
          <blockquote className="max-w-prose border-l-2 border-primary/60 pl-3 text-sm whitespace-pre-line">
            {c.text}
          </blockquote>
        ) : (
          <p className="text-[13px] text-muted-foreground">她在 Discord 講評了</p>
        )
      ) : (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Dot tone="brand" pulse={polling} />
          {polling ? "她正在想要說什麼" : "她還沒有講評,晚點回來看看"}
        </p>
      )}
    </Card>
  );
}

function Summary({
  r,
  core,
  view,
}: {
  r: Scored;
  /** Core's result; absent while the browser's number stands in. */
  core: KaraokeResult | undefined;
  view: VoiceView | null;
}) {
  const label = view?.label ?? "預估";
  const newBest =
    core &&
    !core.unranked &&
    core.voice.checks.length === 0 &&
    (core.best_before === null || core.total > core.best_before);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
        <div className="grid gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="font-mono text-2xl font-semibold tabular-nums" aria-label={`${label} ${score1(r.total)}`}>
            {score1(r.total)}
          </span>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {view?.estimate !== null && view?.estimate !== undefined && (
            <Fact label="預估">
              <span className="font-mono text-muted-foreground">{score1(view.estimate)}</span>
            </Fact>
          )}
          <Fact label="唱到">{pct(r.facts.coverage)}</Fact>
          {core && (
            <Fact label="延遲">
              {core.latency_ms} ms{r.rhythm.calibrated ? "" : "(沒有校正)"}
            </Fact>
          )}
          {core && core.best_before !== null && <Fact label="之前最好">{score1(core.best_before)}</Fact>}
        </dl>
        <div className="flex flex-wrap items-center gap-2 pb-0.5">
          {!core && (
            <Badge>
              <Dot pulse className="size-1.5 [&>span]:size-1.5" />
              確認中
            </Badge>
          )}
          {core?.unranked && <Badge>沒有驗證</Badge>}
          {newBest && <Badge variant="brand">新的最好成績</Badge>}
        </div>
      </div>
      {view?.note && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Dot tone={view.pending ? "brand" : "neutral"} pulse={view.pending} />
          {view.note}
        </p>
      )}
      {view?.checks.map((line) => (
        <p key={line} className="flex items-center gap-2 text-[13px] text-muted-foreground" data-check>
          <Info aria-hidden className="size-4 shrink-0" />
          {line}
        </p>
      ))}
    </div>
  );
}

export function Result({
  session,
  title,
  artist,
  pending,
  onAgain,
  onBack,
}: {
  session: string;
  title: string;
  artist: string | null;
  /** Just sung: what to send, and the browser's own number meanwhile. */
  pending?: Finished;
  onAgain: () => void;
  onBack: () => void;
}) {
  const { api, client: http } = useConnection();
  const client = useQueryClient();
  const since = useRef(Date.now());
  const sent = useRef(false);
  const voiceSent = useRef(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [, rerender] = useState(0);

  /** The recording, once, when Core wants it: a failure leaves the result 預估. */
  const sendVoice = (f: Finished, r: KaraokeResult) => {
    if (!f.voice || voiceSent.current || !wantsUpload(r.voice)) return;
    voiceSent.current = true;
    uploadVoice(http, f.session, f.voice).then(
      () => {
        since.current = Date.now();
        void client.invalidateQueries({ queryKey: resultKey(session) });
      },
      () => setUploadFailed(true),
    );
  };

  const submit = useMutation({
    mutationFn: (f: Finished) => api.rpc.karaoke.submit({ params: { id: f.session }, body: f.body }),
    onSuccess: (r, f) => {
      since.current = Date.now();
      client.setQueryData(resultKey(session), r);
      void client.invalidateQueries({ queryKey: OVERVIEW });
      sendVoice(f, r);
    },
  });
  useEffect(() => {
    if (!pending || sent.current) return;
    sent.current = true;
    submit.mutate(pending);
  }, [pending, submit]);

  const result = useQuery({
    queryKey: resultKey(session),
    queryFn: ({ signal }) => api.rpc.karaoke.result({ params: { id: session } }, { signal }),
    enabled: !pending || submit.isSuccess,
    refetchInterval: (q) => resultPollMs(q.state.data, since.current, Date.now(), uploadFailed),
    retry: false,
  });

  // A later look may ask for the recording after all.
  const later = result.data;
  useEffect(() => {
    if (pending && later) sendVoice(pending, later);
    // `sendVoice` sends at most once (`voiceSent`).
  }, [pending, later]);

  const core = result.data ?? submit.data;
  const shown: Scored | null | undefined = core ? coreScored(core) : pending?.provisional;
  const polling = commentPollMs(core, since.current) !== false;
  const voicePolling = voicePollMs(core, since.current, Date.now(), uploadFailed) !== false;
  const view = core ? voiceView(core, { uploadFailed, waitedOut: !voicePolling }) : null;
  const lines = pending?.lines ?? [];

  // Once the looking stops, say so: the last answer came before the time ran out.
  useEffect(() => {
    if (!polling && !voicePolling) return;
    const left = Math.max(
      polling ? COMMENT_WAIT_MS - (Date.now() - since.current) : 0,
      voicePolling ? VOICE_WAIT_MS - (Date.now() - since.current) : 0,
    );
    const t = setTimeout(() => rerender((n) => n + 1), Math.max(0, left) + 50);
    return () => clearTimeout(t);
  }, [polling, voicePolling]);

  return (
    <section aria-label={`${title} 的結果`} className="grid min-w-0 gap-(--stage-gap)">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon-sm" aria-label="回到歌單" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {artist && <p className="truncate text-[13px] text-muted-foreground">{artist}</p>}
        </div>
        <div className="flex gap-2">
          <Button onClick={onAgain}>
            <MicVocal aria-hidden />
            再唱一次
          </Button>
          <Button variant="outline" onClick={onBack}>
            選別首歌
          </Button>
        </div>
      </div>

      {submit.isError && (
        <div className="grid justify-items-start gap-2">
          <Refusal>{describeError(submit.error)}</Refusal>
          {pending && (
            <Button variant="outline" size="sm" busy={submit.isPending} onClick={() => submit.mutate(pending)}>
              <RotateCcw aria-hidden />
              再送一次
            </Button>
          )}
        </div>
      )}

      {shown ? (
        <>
          <Card aria-label="分數">
            <Summary r={shown} core={core} view={view} />
          </Card>
          <Card aria-label="四個項目">
            <CardHeader>
              <CardTitle>四個項目</CardTitle>
            </CardHeader>
            <Parts r={shown} />
          </Card>
          {core && <Comment result={core} polling={polling} />}
          <Phrases r={shown} lines={lines} />
        </>
      ) : result.isError && !pending ? (
        <ErrorLine error={result.error} onRetry={() => void result.refetch()} />
      ) : (
        <SkeletonRows count={4} />
      )}
    </section>
  );
}
