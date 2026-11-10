import { Brain, Check, ChevronRight, X } from "lucide-react";
import { type ReactNode, useDeferredValue, useId, useState } from "react";
import type {
  IntentStatus,
  MindView,
  PendingApproval,
  Thought,
  ThoughtDigest,
  ThoughtIntent,
  ThoughtTriggerKind,
} from "@/api/types";
import { useApprovals, useDigests, useMind, useMindMutations, useThoughtHistory } from "@/app/queries";
import { BarList, ChartBlock, SegmentBar } from "@/components/charts/charts";
import { SearchInput } from "@/components/controls";
import { RangeToggle, ThoughtsBlock, useRange } from "@/components/trends";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt, fmtTime } from "@/lib/format";
import { rangeOf, type ThoughtOutcome, tally, thoughtOutcome } from "@/lib/telemetry";
import { fmtCost, fmtMs } from "@/pages/llm/labels";
import { ThoughtSheet } from "./ThoughtSheet";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { INTENT_LABEL, INTENT_TONE, STAGE_LABEL, TRIGGER_LABEL } from "./labels";

function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function stateOf(m: MindView): { tone: Tone; label: string } {
  if (m.paused) return { tone: "warning", label: "已緊急停止" };
  if (!m.running) return { tone: "neutral", label: "心智迴圈未啟動" };
  if (m.stats?.idle_reason === "budget exhausted") return { tone: "danger", label: "額度用完" };
  if (!m.accepting) return { tone: "neutral", label: "休息中" };
  return { tone: "success", label: "運作中" };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate tabular-nums">{children}</dd>
    </div>
  );
}

function AutonomyCard() {
  const mind = useMind();
  const { pause } = useMindMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const m = mind.data;
  const state = m ? stateOf(m) : null;
  // The idle run as her newest thought saw it (`null`: she just did something).
  const idle = useThoughtHistory().data?.[0]?.idle ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>自主行動</CardTitle>
        {state && <StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
        {m && (
          <CardAction>
            <Label htmlFor={`${id}-pause`} className="font-normal text-muted-foreground">
              緊急停止
            </Label>
            <Switch
              id={`${id}-pause`}
              checked={m.paused}
              disabled={!canWrite || pause.isPending}
              title={!canWrite ? READ_ONLY_HINT : undefined}
              onCheckedChange={(p) =>
                pause.mutate(p, {
                  onSuccess: () => notify.ok(p ? "已緊急停止" : "已解除緊急停止"),
                  onError: (e) => notify.error(e),
                })
              }
            />
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={mind} skeleton={<SkeletonRows count={1} />}>
        {(v) => (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-5 [&>div:last-child]:col-span-2 sm:[&>div:last-child]:col-span-1" aria-label="心智迴圈">
            <Fact label="這小時">
              {v.stats ? `${v.stats.calls_last_hour} / ${v.stats.max_calls_per_hour}` : "—"}
            </Fact>
            <Fact label="token">{v.stats ? v.stats.tokens_total.toLocaleString("zh-TW") : "—"}</Fact>
            <Fact label="上次想">
              <When at={v.stats?.last_at ?? null} />
            </Fact>
            <Fact label="下次心跳">
              <When at={v.stats?.next_heartbeat_at ?? null} />
            </Fact>
            <Fact label="沒事做">
              {idle && idle.thoughts > 0 ? (
                <span className="text-primary">連續 {idle.thoughts} 次 · {idle.minutes} 分鐘</span>
              ) : (
                <span className="text-muted-foreground">剛做過事</span>
              )}
            </Fact>
          </dl>
        )}
      </QueryView>
    </Card>
  );
}

function ApprovalRow({ a }: { a: PendingApproval }) {
  const { answer } = useMindMutations();
  const send = (approved: boolean) =>
    answer.mutate(
      { id: a.id, approved },
      {
        onSuccess: () => notify.ok(approved ? "已允許，她會去做" : "已拒絕"),
        onError: (e) => notify.error(e, approved ? "允許失敗" : "拒絕失敗"),
      },
    );
  const busy = answer.isPending && answer.variables?.id === a.id;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{a.summary}</div>
        <div className="font-mono text-xs text-muted-foreground">{a.capability}</div>
      </TableCell>
      <TableCell className="hidden align-top font-mono text-xs md:table-cell">{a.principal}</TableCell>
      <TableCell className="max-w-[40ch] align-top">{a.why ?? "—"}</TableCell>
      <TableCell className="hidden max-w-[40ch] align-top text-muted-foreground lg:table-cell">
        {a.review || "—"}
      </TableCell>
      <TableCell className="align-top text-muted-foreground">
        <When at={a.expires_at} />
      </TableCell>
      <TableCell className="align-top">
        <div className="flex justify-end gap-2">
          <Button size="sm" writes busy={busy && answer.variables?.approved === true} onClick={() => send(true)}>
            <Check />
            允許
          </Button>
          <Button size="sm" variant="outline" writes disabled={busy} onClick={() => send(false)}>
            <X />
            拒絕
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ApprovalsCard() {
  const approvals = useApprovals();
  const n = approvals.data?.length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          等待確認
          {n > 0 && <span className="font-normal text-primary tabular-nums">{n}</span>}
        </CardTitle>
      </CardHeader>
      <QueryView query={approvals} skeleton={<SkeletonRows count={1} />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyLine>沒有等待確認的動作</EmptyLine>
          ) : (
            <Table aria-label="等待確認">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>動作</TableHead>
                  <TableHead className="hidden md:table-cell">發起</TableHead>
                  <TableHead>她的理由</TableHead>
                  <TableHead className="hidden lg:table-cell">審核意見</TableHead>
                  <TableHead className="w-24">期限</TableHead>
                  <TableHead className="w-44">
                    <span className="sr-only">決定</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => (
                  <ApprovalRow key={a.id} a={a} />
                ))}
              </TableBody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}

function IntentLine({ intent }: { intent: ThoughtIntent }) {
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge tone={INTENT_TONE[intent.status]}>{INTENT_LABEL[intent.status]}</StatusBadge>
        <code className="font-mono text-xs">{intent.capability}</code>
        {intent.context && <span className="text-xs text-muted-foreground">{contextShort(intent.context)}</span>}
        {intent.why && <span className="min-w-0 text-[13px]">{intent.why}</span>}
      </div>
      {intent.detail && intent.status !== "started" && (
        <div className="font-mono text-xs text-muted-foreground">{intent.detail}</div>
      )}
      {intent.decisions.length > 0 && (
        <ul className="grid gap-0.5" aria-label="閘門決定">
          {intent.decisions.map((d) => (
            <li key={`${d.at}-${d.capability}`} className="font-mono text-xs text-muted-foreground">
              <span className={d.allowed ? "text-foreground" : "text-primary"}>{d.allowed ? "放行" : "擋下"}</span>{" "}
              {d.capability} · {STAGE_LABEL[d.stage] ?? d.stage} · {d.reason}
            </li>
          ))}
        </ul>
      )}
      {intent.said && (
        <p className="text-[13px] leading-relaxed">
          <span className="mr-1.5 font-medium text-primary">她</span>
          {intent.said}
        </p>
      )}
    </li>
  );
}

function ThoughtItem({ t, onOpen }: { t: Thought; onOpen: () => void }) {
  const kinds = [...new Set(t.triggers.map((x) => x.kind))];
  const detail = t.triggers.find((x) => x.detail.trim() !== "")?.detail;
  return (
    <li className="group grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground sm:flex-col sm:gap-1">
        <When at={t.at} />
        <span>{kinds.map((k) => TRIGGER_LABEL[k] ?? k).join("、")}</span>
        <span className="font-mono text-[11px] tabular-nums">
          {t.tokens !== null ? `${fmtInt(t.tokens)} tok` : "—"} · {fmtMs(t.ms)}
          {t.cost_usd != null && ` · ${fmtCost(t.cost_usd)}`}
        </span>
        {t.idle && t.idle.thoughts > 0 && <span className="text-xs text-primary">連續第 {t.idle.thoughts + 1} 次沒事</span>}
      </div>
      <div className="grid min-w-0 gap-2.5">
        <div className="flex items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-2.5">
            {detail && <p className="text-[13px] text-muted-foreground">{detail}</p>}
            {t.error ? (
              <p className="font-mono text-xs text-primary">{t.error}</p>
            ) : (
              <p className="max-w-[70ch] leading-relaxed">{t.thought || "—"}</p>
            )}
          </div>
          <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" onClick={onOpen} aria-label={`看 ${fmtTime(t.at)} 的想法的全部細節`}>
            {t.has_reasoning && <Brain className="text-primary" aria-label="有推理" />}
            細節
            <ChevronRight />
          </Button>
        </div>
        {t.changes.length > 0 && <p className="text-[13px] text-muted-foreground">{t.changes.join(" · ")}</p>}
        {t.intents.length > 0 && (
          <ul className="grid gap-3 border-t pt-2.5" aria-label="意圖">
            {t.intents.map((i) => (
              <IntentLine key={i.id} intent={i} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

type OutcomeFilter = "all" | ThoughtOutcome;
const OUTCOME_FILTERS: { value: OutcomeFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "acted", label: "付諸行動" },
  { value: "held", label: "想做沒做" },
  { value: "none", label: "只是想想" },
];
const PAGE = 40;

function matches(t: Thought, q: string): boolean {
  if (!q) return true;
  const hay = [
    t.thought,
    t.error ?? "",
    ...t.triggers.map((x) => x.detail),
    ...t.changes,
    ...t.intents.flatMap((i) => [i.capability, i.why, i.opening ?? "", i.detail ?? "", i.said ?? ""]),
    ...(t.suggestions ?? []).map((s) => s.hint),
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

/** Her journal with filters; a thought opens in full. */
function TimelineCard({ onOpen }: { onOpen: (id: string) => void }) {
  const thoughts = useThoughtHistory();
  const [text, setText] = useState("");
  const q = useDeferredValue(text.trim().toLowerCase());
  const [kind, setKind] = useState<string>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [errors, setErrors] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const all = thoughts.data ?? [];
  const visible = all.filter(
    (t) =>
      (kind === "all" || t.triggers.some((x) => x.kind === kind)) &&
      (outcome === "all" || thoughtOutcome(t) === outcome) &&
      (!errors || t.error !== null || t.intents.some((i) => i.status === "failed" || i.status === "denied")) &&
      matches(t, q),
  );
  const kinds = [...new Set(all.flatMap((t) => t.triggers.map((x) => x.kind)))];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          想法
          {all.length > 0 && (
            <span className="font-normal text-muted-foreground tabular-nums">
              {visible.length === all.length ? all.length : `${visible.length} / ${all.length}`}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <SearchInput value={text} onChange={setText} placeholder="搜尋想法、意圖、她說的話" label="搜尋想法" className="sm:w-64" />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger size="sm" className="w-32" aria-label="觸發原因">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">所有觸發</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {TRIGGER_LABEL[k] ?? k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Segmented label="結果" value={outcome} onChange={setOutcome} options={OUTCOME_FILTERS} />
        <div className="flex items-center gap-2">
          <Switch id="thought-errors" checked={errors} onCheckedChange={setErrors} />
          <Label htmlFor="thought-errors" className="font-normal text-muted-foreground">
            只看失敗或被擋的
          </Label>
        </div>
      </div>
      <QueryView query={thoughts} skeleton={<SkeletonRows count={4} />}>
        {() =>
          all.length === 0 ? (
            <EmptyLine>還沒有想法</EmptyLine>
          ) : visible.length === 0 ? (
            <EmptyLine>沒有符合的想法</EmptyLine>
          ) : (
            <>
              <ol className="divide-y divide-line-soft" aria-label="想法時間軸">
                {visible.slice(0, shown).map((t) => (
                  <ThoughtItem key={t.id} t={t} onOpen={() => onOpen(t.id)} />
                ))}
              </ol>
              {visible.length > shown && (
                <div className="pt-3 text-center">
                  <Button size="sm" variant="outline" onClick={() => setShown((n) => n + PAGE)}>
                    再顯示 {Math.min(PAGE, visible.length - shown)} 則
                  </Button>
                </div>
              )}
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function DigestItem({ d }: { d: ThoughtDigest }) {
  const intents = Object.entries(d.intents)
    .map(([k, n]) => `${k} ×${n}`)
    .join("、");
  return (
    <li className="grid gap-x-6 gap-y-1.5 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="text-[13px] text-muted-foreground">
        <When at={d.to} />
        <div className="tabular-nums">{d.count} 個想法</div>
      </div>
      <div className="grid min-w-0 gap-1">
        <p className="max-w-[70ch] leading-relaxed">{d.summary}</p>
        {intents && <p className="font-mono text-xs text-muted-foreground">{intents}</p>}
      </div>
    </li>
  );
}

/** Older thoughts condensed (only shown when there are some). */
function DigestsCard() {
  const digests = useDigests();
  const list = digests.data ?? [];
  if (list.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          更早的想法(整理)
          <span className="font-normal text-muted-foreground tabular-nums">{list.length}</span>
        </CardTitle>
      </CardHeader>
      <ol className="divide-y divide-line-soft" aria-label="想法整理">
        {list.map((d) => (
          <DigestItem key={d.id} d={d} />
        ))}
      </ol>
    </Card>
  );
}

const INTENT_COLOR: Record<IntentStatus, string> = {
  done: "var(--chart-2)",
  started: "var(--chart-1)",
  pending: "var(--chart-3)",
  dropped: "var(--chart-quiet)",
  denied: "var(--chart-4)",
  failed: "var(--chart-5)",
};

const INTENT_ORDER: IntentStatus[] = ["done", "started", "pending", "dropped", "denied", "failed"];

/** How often she thinks, what sets her thinking, and what came of it. */
function ThoughtStats() {
  const [range, setRange] = useRange();
  const cfg = rangeOf(range);
  const history = useThoughtHistory();
  const since = Date.now() - cfg.minutes * 60_000;
  const inRange = (history.data ?? []).filter((t) => Date.parse(t.at) >= since);
  const triggers = tally(
    inRange.flatMap((t) => [...new Set(t.triggers.map((x) => x.kind))]),
    (k) => k,
  );
  const intents = inRange.flatMap((t) => t.intents);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">她怎麼想</h2>
        <RangeToggle range={range} onChange={setRange} />
      </div>
      <div className="grid gap-(--stage-gap) lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ThoughtsBlock range={range} />
        <ChartBlock title="觸發原因與結果" value={fmtInt(intents.length)} unit="個意圖">
          {history.isPending ? (
            <SkeletonRows count={3} />
          ) : inRange.length === 0 ? (
            <EmptyLine>這段時間沒有想法</EmptyLine>
          ) : (
            <div className="grid gap-5">
              <SegmentBar
                label="意圖的結果"
                parts={INTENT_ORDER.map((s) => ({ key: s, label: INTENT_LABEL[s], value: intents.filter((i) => i.status === s).length, color: INTENT_COLOR[s] })).filter((p) => p.value > 0)}
              />
              <BarList
                label="觸發原因"
                format={fmtInt}
                items={triggers.map((t) => ({ key: t.key, label: TRIGGER_LABEL[t.key as ThoughtTriggerKind] ?? t.key, value: t.value }))}
              />
            </div>
          )}
        </ChartBlock>
      </div>
    </div>
  );
}

export function ThoughtsTab({ thought, onThought }: { thought?: string; onThought: (id: string | undefined) => void }) {
  return (
    <div className="grid gap-(--stage-gap)">
      <AutonomyCard />
      <ApprovalsCard />
      <ThoughtStats />
      <TimelineCard onOpen={onThought} />
      <DigestsCard />
      <ThoughtSheet id={thought} onClose={() => onThought(undefined)} />
    </div>
  );
}
